#!/usr/bin/env node
/**
 * zhuque —— 朱雀 AIGC 检测命令行工具
 *
 * 用法：
 *   zhuque detect "文本"                 人类可读输出
 *   zhuque detect -f article.txt --json   输出结构化 JSON（给 Agent 用）
 *   echo "文本" | zhuque detect --stdin
 *   zhuque detect --file a.txt --file b.txt
 *   zhuque serve --port 8787              启动本地 HTTP API + 网页
 *   zhuque mcp                            启动 MCP 服务（stdio）
 *   zhuque doctor                         检查 Key / 连通性
 *   zhuque schema                         打印机器可读接口说明
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-main.mjs';
import {
  detect,
  detectBatch,
  renderText,
  buildFullText,
  labelColor,
  resolveApiKey,
  maskKey,
  apiKeySource,
  ZhuqueError,
  resolveEndpoint,
  applyConfigToEnv, loadLocalSettings,
  VERSION,
} from './core.mjs';
import { readConfig, writeConfig, configPath, FIELDS, maskSecret, ConfigError } from './config-store.mjs';
import { usageSummary, calibrate, setQuota, resetUsage, clearCalibration } from './usage-store.mjs';
import { listHistory, getHistory, historyStats, deleteHistory, clearHistory, exportHistory } from './history-store.mjs';
import { poolStatus, resetKeyState, resetAllKeyState, setKeyEnabled, normalizeKeyList } from './key-pool.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** 短选项 → 长选项，保证 -t / -f / -o 与 --text / --file / --out 行为一致 */
const SHORT_ALIAS = { f: 'file', t: 'text', o: 'out' };

function parseArgs(argv) {
  const opts = { _: [], files: [], keyValues: {} };
  const takesValue = new Set([
    'file', 'f', 'text', 't', 'port', 'host', 'api-key', 'key', 'timeout',
    'max-chars', 'token', 'out', 'o', 'id', 'batch-file', 'is-merge',
    'quota', 'calibrate', 'days', 'note', 'cycle-start-day',
    'limit', 'offset', 'q', 'verdict', 'category', 'source', 'format', 'label', 'account',
  ]);
  // 需要取值的选项没给值时直接报错：绝不能悄悄退化成布尔 true，
  // 否则 `--is-merge false` 会把 "false" 当成一篇待检测文本，白跑一次真实检测。
  const missingValue = (name) => {
    throw new ZhuqueError('MISSING_VALUE', `选项 --${name} 缺少取值。`, '用 zhuque --help 查看用法。', 400);
  };
  const take = (name, next) => {
    // 下一个 token 是另一个 --选项 时，视为「本选项漏了取值」，而不是把选项名当成值
    if (next === undefined || next === '' || next.startsWith('--')) missingValue(name);
    if (name === 'file') opts.files.push(next);
    else opts.keyValues[name] = next;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') {
      opts._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > -1 ? a.slice(2, eq) : a.slice(2);
      if (eq > -1) {
        if (name === 'file') opts.files.push(a.slice(eq + 1));
        else opts.keyValues[name] = a.slice(eq + 1);
      } else if (takesValue.has(name)) {
        take(name, argv[i + 1]);
        i += 1;
      } else {
        opts.keyValues[name] = true;
      }
    } else if (a.startsWith('-') && a.length > 1) {
      const name = SHORT_ALIAS[a.slice(1)] || a.slice(1);
      if (takesValue.has(name)) {
        take(name, argv[i + 1]);
        i += 1;
      } else {
        opts.keyValues[name] = true;
      }
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

function flag(kv, name) {
  const v = kv[name];
  return v === true || v === 'true' || v === '1' || v === '';
}

/** 解析 true/false 型取值；非法值直接报错，不静默当成 true */
function boolValue(v, name) {
  if (v === undefined || v === true) return true;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  throw new ZhuqueError('BAD_VALUE', `--${name} 只接受 true / false，收到：${v}`, '', 400);
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function readInputs(opts) {
  const texts = [];
  if (opts.keyValues.text) texts.push({ source: 'text', text: String(opts.keyValues.text) });
  for (const f of opts.files) {
    const p = path.resolve(f);
    if (!fs.existsSync(p)) throw new ZhuqueError('FILE_NOT_FOUND', `文件不存在：${p}`, '检查路径。', 404);
    texts.push({ source: p, text: fs.readFileSync(p, 'utf8') });
  }
  for (const t of opts._) if (t && t.trim()) texts.push({ source: 'arg', text: t });
  return texts;
}

const HELP = `zhuque v${VERSION} —— 朱雀 AIGC 文本检测

用法
  zhuque detect [文本...] [选项]
  zhuque serve [--port 8787] [--host 127.0.0.1] [--open]
  zhuque mcp
  zhuque config <get|set|clear|test>
  zhuque usage [选项]
  zhuque history <list|show|stats|export|rm|clear>
  zhuque keys <list|add|rm|enable|disable|reset>
  zhuque doctor
  zhuque schema
  zhuque install-mcp

配置（写入 ${configPath()})
  zhuque config get                    查看当前配置与生效来源
  zhuque config set api_key=sk-xxx     设置 API Key
  zhuque config set port=8788 max_chars=20000
  zhuque config clear api_key          删除某项配置
  zhuque config test [--key sk-xxx]     用当前（或指定）Key 做一次连通性自检

用量
  zhuque usage                         本地统计的本周期用量与剩余额度
  zhuque usage --json                  输出机器可读 JSON
  zhuque usage --days 14               近 14 日趋势
  zhuque usage --calibrate 12345       用控制台读数校准
  zhuque usage --quota 500000          修改免费额度
  zhuque usage --reset                 清空本地账本

检测历史
  zhuque history list                  列出最近 20 条检测记录
  zhuque history list --limit 50 --q 关键词 --verdict ai
  zhuque history show <id>             查看某条完整明细（逐段归属 + 检测全文，默认不截断）
  zhuque history show <id> --no-full   只看指标与逐段归属，不打印全文
  zhuque history stats                 统计概览（平均 AI 率、三段均值、分布）
  zhuque history export --format csv   导出（json | csv）
  zhuque history rm <id>               删除某条
  zhuque history clear                 清空全部

API Key 池（多把 Key 自动轮换，用尽自动切换）
  zhuque keys list                     查看池状态（掩码、用量、冷却）
  zhuque keys add --key sk-xxx --label 主号
  zhuque keys add --key a,b,c          一次加多把（逗号分隔）
  zhuque keys disable <id>             停用某把
  zhuque keys enable <id>              重新启用
  zhuque keys rm <id>                  从池中移除
  zhuque keys reset [<id>]             重置冷却/失效状态（不带 id 则全部）

输入（可组合）
  <文本...>              直接作为待检测文本
  -t, --text <文本>      指定文本
  -f, --file <路径>      读文件（可重复）
      --stdin            从标准输入读取
      --each-line        把输入按行拆成独立文档，逐行检测
      --batch-file <路径> 批量：JSON 数组 [{"id":"a","text":"..."}] 或每行一条

输出
      --json             输出机器可读 JSON（Agent 首选）
      --jsonl            每条一行 JSON（批量时）
      --raw              附带朱雀原始响应
      --out <路径>       写入文件
      --quiet            只输出关键数字
      --no-color         关闭彩色
      --no-full          人类可读输出里不附「检测全文」（默认会完整打印，不截断）

检测参数
      --is-merge <bool>  是否合并段落，默认 true；false 时逐段独立判定
      --no-chunk         禁止自动分块（超长直接报错）
      --max-chars <n>    单块最大字符数
      --no-cache         跳过结果缓存
      --no-history       不写入检测历史
      --timeout <ms>     请求超时
      --api-key <key>    临时指定 Key

环境变量
  ZHUQUE_API_KEY         API Key；也可写入 token.txt 或 ${configPath()}
  ZHUQUE_TOKEN_FILE      指定 token.txt 的路径（默认找项目根/当前目录下的 token.txt）

示例
  zhuque config set api_key=sk-xxx && zhuque doctor
  zhuque detect "这是一段需要检测的文字"
  zhuque detect -f draft.md --json | jq '.ai_rate'
  cat draft.md | zhuque detect --stdin --quiet
`;

async function cmdDetect(opts) {
  const kv = opts.keyValues;
  const json = flag(kv, 'json');
  const jsonl = flag(kv, 'jsonl');
  const quiet = flag(kv, 'quiet');
  const color = !flag(kv, 'no-color') && process.stdout.isTTY && !json && !jsonl;

  const detectOpts = {
    isMerge: boolValue(kv['is-merge'], 'is-merge'),
    cache: !flag(kv, 'no-cache'),
    autoChunk: !flag(kv, 'no-chunk'),
    timeoutMs: kv.timeout ? Number(kv.timeout) : undefined,
    maxChars: kv['max-chars'] ? Number(kv['max-chars']) : undefined,
    apiKey: kv['api-key'] || kv.key,
    includeRaw: flag(kv, 'raw'),
    source: 'cli',
    history: !flag(kv, 'no-history'),
  };

  // 批量模式
  if (kv['batch-file']) {
    const p = path.resolve(String(kv['batch-file']));
    if (!fs.existsSync(p)) throw new ZhuqueError('FILE_NOT_FOUND', `文件不存在：${p}`, '检查路径。', 404);
    const content = fs.readFileSync(p, 'utf8').trim();
    let items;
    if (content.startsWith('[')) {
      try {
        items = JSON.parse(content);
      } catch (e) {
        throw new ZhuqueError('BAD_JSON', `--batch-file 不是合法 JSON：${e.message}`, '内容应为 [{"id":"a","text":"..."}] 或每行一条纯文本。', 400);
      }
      if (!Array.isArray(items)) {
        throw new ZhuqueError('BAD_JSON', '--batch-file 的 JSON 顶层必须是数组。', '示例：[{"id":"a","text":"..."}]', 400);
      }
    } else {
      items = content.split(/\r?\n/).filter((l) => l.trim()).map((line, i) => ({ id: i + 1, text: line }));
    }
    const res = await detectBatch(items, detectOpts);
    const textById = new Map(items.map((it, i) => [String(it?.id ?? i + 1), typeof it === 'string' ? it : it?.text]));
    return emitBatch(res, { json, jsonl, quiet, out: kv.out, color, full: !flag(kv, 'no-full'), textById });
  }

  const inputs = readInputs(opts);
  if (flag(kv, 'stdin') || inputs.length === 0) {
    const s = await readStdin();
    if (s.trim()) inputs.push({ source: 'stdin', text: s });
  }
  if (!inputs.length) {
    process.stderr.write('未提供待检测文本。用 zhuque --help 查看用法，或 echo "文本" | zhuque detect --stdin\n');
    process.exitCode = 2;
    return;
  }

  // --each-line：把每个输入按行拆成独立文档，逐行检测
  let list = inputs;
  if (flag(kv, 'each-line')) {
    list = [];
    let n = 0;
    for (const src of inputs) {
      for (const line of src.text.split(/\r?\n/)) {
        if (line.trim()) list.push({ source: n + 1, text: line });
        n += 1;
      }
    }
    if (!list.length) {
      process.stderr.write('--each-line 拆分后没有有效文本行。\n');
      process.exitCode = 2;
      return;
    }
  }

  if (list.length === 1) {
    const r = await detect(list[0].text, detectOpts);
    if (quiet) {
      return emit(String(r.ai_rate_percent), { out: kv.out });
    }
    if (jsonl) return emit(JSON.stringify({ id: 1, ok: true, data: r, error: null }), { jsonl: true, out: kv.out });
    if (json) return emit(r, { json: true, out: kv.out });
    // 把原文交给渲染器：上游在 is_merge 下只给粗粒度段，光靠分段拼不出全文
    return emit(renderText(r, { color, full: !flag(kv, 'no-full'), text: list[0].text }), { out: kv.out });
  }

  const items = list.map((x, i) => ({
    id: x.source === 'arg' || x.source === 'text' || x.source === 'stdin' ? i + 1 : x.source,
    text: x.text,
  }));
  const textById = new Map(items.map((it) => [String(it.id), it.text]));
  const res = await detectBatch(items, detectOpts);
  return emitBatch(res, { json, jsonl, quiet, out: kv.out, color, full: !flag(kv, 'no-full'), textById });
}

/** 批量输出：--json / --jsonl / --quiet 三种精简形态，否则逐条人类可读 */
function emitBatch(res, { json, jsonl, quiet, out, color, full = true, textById } = {}) {
  if (!res.all_succeeded) process.exitCode = 1;
  if (json) return emit(res, { json: true, out });
  if (jsonl) return emit(res.results.map((r) => JSON.stringify(r)).join('\n'), { jsonl: true, out });
  if (quiet) return emit(res.results.map((r) => (r.ok ? r.data.ai_rate_percent : 'ERROR')).join('\n'), { out });
  const body = res.results
    .map((r) =>
      r.ok
        ? `\n### ${r.id}\n${renderText(r.data, { color, full, text: textById?.get(String(r.id)) })}`
        : `\n### ${r.id}\n检测失败：${r.error.message}`
    )
    .join('\n');
  return emit(body, { out });
}

function emit(payload, { json, jsonl, out }) {
  const body =
    jsonl || typeof payload === 'string'
      ? String(payload)
      : JSON.stringify(payload, null, 2);
  if (out) {
    fs.writeFileSync(path.resolve(String(out)), body + '\n', 'utf8');
    process.stderr.write(`已写入 ${path.resolve(String(out))}\n`);
  } else {
    process.stdout.write(body + '\n');
  }
}

async function cmdServe(opts) {
  const kv = opts.keyValues;
  const mod = await import('./server.mjs');
  // 只有用户真的写了 --open / --no-open 才传布尔；否则交给配置项 auto_open 决定
  await mod.startServer({
    port: kv.port ? Number(kv.port) : undefined,
    host: kv.host ? String(kv.host) : undefined,
    token: kv.token || undefined,
    open: flag(kv, 'open') ? true : flag(kv, 'no-open') ? false : undefined,
  });
}

async function cmdConfig(opts) {
  const kv = opts.keyValues;
  const action = opts._[0] || 'get';
  const file = configPath();

  if (action === 'get') {
    const cfg = readConfig();
    const key = resolveApiKey();
    const out = {
      config_file: file,
      exists: fs.existsSync(file),
      saved: Object.fromEntries(
        Object.entries(cfg).map(([k, v]) => {
          const t = FIELDS[k]?.type;
          if (t === 'secret') return [k, maskSecret(v)];
          if (t === 'keylist') return [k, (Array.isArray(v) ? v : []).map((it) => `${it.label || ''} ${maskSecret(it.key)}`).join(', ')];
          return [k, v];
        })
      ),
      effective_api_key: key ? { masked: maskKey(key), source: apiKeySource() } : { masked: '', source: 'none' },
      endpoint: resolveEndpoint(),
    };
    if (flag(kv, 'json')) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    else {
      process.stdout.write(`配置文件      ${file}\n`);
      process.stdout.write(`生效 Key      ${key ? `${maskKey(key)}  (来源 ${apiKeySource()})` : '未配置'}\n`);
      process.stdout.write(`上游地址      ${resolveEndpoint()}\n`);
      const savedKeys = Object.keys(out.saved);
      process.stdout.write(`已保存项      ${savedKeys.length ? savedKeys.join(', ') : '（无）'}\n`);
      for (const k of savedKeys) {
        const val = out.saved[k];
        const txt = Array.isArray(val) ? val.map((x) => (x && typeof x === 'object' ? `${x.label || ''} ${x.masked || ''}` : String(x))).join(' | ') : val;
        process.stdout.write(`  ${k.padEnd(14)} ${txt}\n`);
      }
      if (!key) {
        process.stdout.write(`\n提示：用 zhuque config set api_key=你的Key 写入，或打开网页界面点右上角「设置」。\n`);
      }
    }
    return;
  }

  if (action === 'set') {
    const pairs = opts._.slice(1);
    if (!pairs.length) throw new ConfigError('未提供要设置的键值对。', '示例：zhuque config set api_key=sk-xxx port=8788');
    const patch = {};
    for (const p of pairs) {
      const idx = p.indexOf('=');
      if (idx < 1) throw new ConfigError(`参数格式应为 key=value，收到：${p}`, '示例：zhuque config set max_chars=20000');
      const key = p.slice(0, idx).trim();
      if (!FIELDS[key]) throw new ConfigError(`不支持的配置项：${key}`, `可用：${Object.keys(FIELDS).join(', ')}`);
      patch[key] = p.slice(idx + 1);
    }
    const res = writeConfig(patch);
    applyConfigToEnv({ override: true });
    process.stdout.write(`✓ 已写入 ${res.file}\n`);
    if (res.backup) process.stdout.write(`  原文件已备份为 ${res.backup}\n`);
    for (const k of Object.keys(patch)) {
      const v = res.saved[k];
      const t = FIELDS[k].type;
      process.stdout.write(`  ${k.padEnd(14)} ${t === 'secret' ? maskSecret(v) : t === 'keylist' ? `${(v || []).length} 把（密钥不显示）` : v}\n`);
    }
    const source = apiKeySource();
    if (patch.api_key && !source.startsWith('file:')) {
      process.stdout.write(`\n⚠ 当前生效的 Key 来自 ${source}，优先级高于配置文件。要让它生效请先取消该环境变量。\n`);
    }
    const needRestart = Object.keys(patch).filter((k) => FIELDS[k].restart);
    if (needRestart.length) process.stdout.write(`\n⚠ ${needRestart.join(', ')} 需要重启服务后才生效。\n`);
    return;
  }

  if (action === 'clear') {
    const names = opts._.slice(1);
    if (!names.length) throw new ConfigError('未指定要清除的项。', `示例：zhuque config clear api_key。可用：${Object.keys(FIELDS).join(', ')}`);
    const clear = {};
    for (const n of names) {
      if (!FIELDS[n]) throw new ConfigError(`不支持的配置项：${n}`, `可用：${Object.keys(FIELDS).join(', ')}`);
      clear[n] = true;
    }
    const res = writeConfig({ clear });
    process.stdout.write(`✓ 已清除 ${names.join(', ')}（${res.file}）\n`);
    if (res.backup) process.stdout.write(`  原文件已备份为 ${res.backup}\n`);
    return;
  }

  if (action === 'test') {
    const candidate = kv.key || kv['api-key'];
    const probe = '这是一段用于连通性自检的普通文本，由人类手写而成，不含人工智能生成内容特征。';
    const t0 = Date.now();
    try {
      const r = await detect(probe, { apiKey: candidate, cache: false, record: false, history: false });
      process.stdout.write(
        `✓ 连接正常（${Date.now() - t0}ms）\n` +
          `  Key        ${maskKey(candidate || resolveApiKey())}  (${candidate ? '命令行传入' : apiKeySource()})\n` +
          `  上游        ${resolveEndpoint()}\n` +
          `  探测结论    ${r.verdict_name} / AI 率 ${r.ai_rate_percent}%\n` +
          `  本次计费    ${r._meta.usage.makers_billed_tokens} token\n`
      );
    } catch (err) {
      process.stderr.write(`✗ 连接失败\n`);
      if (err instanceof ZhuqueError) {
        process.stderr.write(`  错误码 ${err.code}\n  说明   ${err.message}\n${err.hint ? `  建议   ${err.hint}\n` : ''}`);
      } else {
        process.stderr.write(`  ${err?.message || err}\n`);
      }
      process.exitCode = 1;
    }
    return;
  }

  throw new ConfigError(`未知的 config 子命令：${action}`, '可用：get / set / clear / test');
}

const fmt = (n) => Number(n || 0).toLocaleString('en-US');

async function cmdUsage(opts) {
  const kv = opts.keyValues;

  if (kv.calibrate !== undefined) {
    const s = calibrate(kv.calibrate, kv.note || '');
    process.stdout.write(`✓ 已用控制台读数 ${fmt(kv.calibrate)} token 校准\n`);
    renderUsage(s, flag(kv, 'no-color'));
    return;
  }
  if (kv.quota !== undefined || kv['cycle-start-day'] !== undefined) {
    try {
      const s = setQuota({ quota_per_month: kv.quota, cycle_start_day: kv['cycle-start-day'] });
      process.stdout.write(`✓ 已更新额度设置\n`);
      renderUsage(s, flag(kv, 'no-color'));
    } catch (e) {
      throw new ConfigError(e.message, '');
    }
    return;
  }
  if (flag(kv, 'reset')) {
    if (kv['calibration-only']) {
      const s = clearCalibration();
      process.stdout.write('✓ 已清除校准偏移\n');
      renderUsage(s, flag(kv, 'no-color'));
    } else {
      const out = resetUsage();
      process.stdout.write(`✓ 已清空本地账本（${out.file}）\n`);
      renderUsage(out.summary, flag(kv, 'no-color'));
    }
    return;
  }

  const summary = usageSummary({ days: kv.days ? Number(kv.days) : 7 });
  if (flag(kv, 'json')) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return;
  }
  renderUsage(summary, flag(kv, 'no-color'));
}

function renderUsage(s, noColor = false) {
  const color = !noColor && process.stdout.isTTY;
  const c = (code, str) => (color ? `\u001b[${code}m${str}\u001b[0m` : str);
  const ratio = s.used.ratio;
  const barColor = ratio < 0.5 ? '32' : ratio < 0.8 ? '33' : '31';
  const width = 36;
  // 超额（ratio > 1）时不能把进度条撑破
  const filled = Math.min(width, Math.max(0, Math.round((Number.isFinite(ratio) ? ratio : 0) * width)));
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);

  const lines = [];
  lines.push(c('1', '朱雀免费额度用量（本地统计）'));
  lines.push('─'.repeat(46));
  lines.push(`当前账期    ${s.cycle.start} → ${s.cycle.end}  （第 ${s.cycle.elapsed_days}/${s.cycle.total_days} 天）`);
  lines.push(`免费额度    ${fmt(s.quota_per_month)} token / 月`);
  lines.push(`本周期已用  ${c(barColor, fmt(s.used.billed_tokens))} token  (${s.used.percent}%)`);
  lines.push(`剩余可用    ${c(barColor, fmt(s.remaining.tokens))} token  (${s.remaining.percent}%)`);
  lines.push(`  ${c(barColor, bar)}`);
  lines.push('');
  lines.push(`今日用量    ${fmt(s.today.billed_tokens)} token / ${s.today.calls} 次调用`);
  lines.push(`本周期调用  ${fmt(s.used.calls)} 次，平均每次 ${fmt(s.average.per_call_tokens)} token`);
  lines.push(`日均消耗    ${fmt(s.average.per_day_tokens)} token`);
  if (s.average.estimated_days_left !== null) {
    const txt = s.average.lasts_whole_cycle
      ? `本周期内充足（账期还剩 ${s.average.days_left_in_cycle} 天）`
      : `${s.average.estimated_days_left} 天`;
    lines.push(`预计可用    ${c(barColor, txt)}（按当前日均速度推算）`);
  }
  lines.push('');
  lines.push(c('2', `近 ${s.daily.length} 日：`));
  const peak = Math.max(1, ...s.daily.map((d) => d.billed));
  for (const d of s.daily) {
    const w = Math.round((d.billed / peak) * 24);
    lines.push(`  ${d.date}  ${'▪'.repeat(w).padEnd(24)} ${fmt(d.billed)}`);
  }
  lines.push('');
  lines.push(c('2', `累计（历史全部）：${fmt(s.lifetime.billed_tokens)} token / ${fmt(s.lifetime.calls)} 次调用`));
  if (s.last_call_at) lines.push(c('2', `最近一次调用：${new Date(s.last_call_at).toLocaleString('zh-CN')}`));
  if (s.calibration) {
    lines.push(c('33', `已校准：控制台读数 ${fmt(s.calibration.console_tokens)}（偏移 ${s.calibration.offset >= 0 ? '+' : ''}${fmt(s.calibration.offset)}）`));
  }
  lines.push('');
  lines.push(c('2', '说明：官方未开放额度查询 API，此处为本地累计值。'));
  lines.push(c('2', `权威数据请看控制台：https://console.cloud.tencent.com/edgeone/makers?tab=models&subTab=overview`));
  lines.push(c('2', `读数不一致时用：zhuque usage --calibrate <控制台已用token>`));
  process.stdout.write(lines.join('\n') + '\n');
}

async function cmdMcp() {
  const mod = await import('./mcp-server.mjs');
  await mod.startMcpServer();
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

async function cmdHistory(opts) {
  const kv = opts.keyValues;
  const action = opts._[0] || 'list';
  const json = flag(kv, 'json');
  const noColor = flag(kv, 'no-color');
  const c = (code, s) => (!noColor && process.stdout.isTTY ? `\u001b[${code}m${s}\u001b[0m` : s);

  if (action === 'list') {
    const res = listHistory({
      limit: kv.limit ? Number(kv.limit) : 20,
      offset: kv.offset ? Number(kv.offset) : 0,
      q: kv.q,
      verdict: kv.verdict,
      category: kv.category,
      source: kv.source,
    });
    if (json) return emit(res, { json: true, out: kv.out });
    if (!res.items.length) {
      process.stdout.write('暂无检测历史。检测一次即自动写入（zhuque detect "文本"）。\n');
      return;
    }
    process.stdout.write(c('1', `检测历史（共 ${res.total} 条，显示第 ${res.offset + 1}~${res.offset + res.items.length} 条）`) + '\n');
    process.stdout.write('─'.repeat(70) + '\n');
    for (const r of res.items) {
      const col = r.verdict === 'human' ? '32' : r.verdict === 'mostly_human' ? '36' : r.verdict === 'mixed' ? '33' : '31';
      const cats = r.categories || {};
      process.stdout.write(
        `${c('2', r.at_local)} ${c(col, `${String(r.ai_rate_percent).padStart(6)}%`)} ${r.verdict_name} ` +
          `${c('2', `[${r.source}]`)} ${r.chars} 字 · 人工 ${cats.human?.percent ?? 0}% / 疑似 ${cats.suspected_ai?.percent ?? 0}% / AI ${cats.ai?.percent ?? 0}%\n` +
          `  ${c('2', r.id)}  ${c('2', (r.preview || '').slice(0, 60))}\n`
      );
    }
    if (res.has_more) process.stdout.write(c('2', `… 还有更多，用 --offset ${res.offset + res.items.length} 翻页\n`));
    return;
  }

  if (action === 'show') {
    const id = kv.id || opts._[1];
    if (!id) throw new ConfigError('未指定历史 id。', '用法：zhuque history show <id>');
    const r = getHistory(id);
    if (!r) throw new ConfigError(`未找到历史记录 ${id}`, '用 zhuque history list 查看可用 id。');
    if (json) return emit(r, { json: true, out: kv.out });
    const cats = r.categories || {};
    process.stdout.write(c('1', `检测记录 ${r.id}`) + '\n');
    process.stdout.write('─'.repeat(52) + '\n');
    process.stdout.write(`时间        ${r.at_local}（来源 ${r.source}）\n`);
    process.stdout.write(`总 AI 率    ${r.ai_rate_percent}%   结论 ${r.verdict_name}\n`);
    process.stdout.write(`三段占比    ${c('32', `人工特征 ${cats.human?.percent ?? 0}%`)} | ${c('33', `疑似 AI ${cats.suspected_ai?.percent ?? 0}%`)} | ${c('31', `AI 特征 ${cats.ai?.percent ?? 0}%`)}\n`);
    process.stdout.write(`分段        ${r.segment_count} 段，${r.flagged_segment_count} 段被判为 AI\n`);
    process.stdout.write(`Key         ${r.key?.label || ''} ${r.key?.masked || ''}\n`);
    process.stdout.write(`计费        ${r.usage?.billed_tokens ?? 0} token · 耗时 ${r.duration_ms}ms\n`);
    process.stdout.write(`文本        ${r.text ? `全文已完整保存（${r.chars} 字）` : '未保存原文（该记录写入时限制了长度）'}\n`);

    if (r.segments?.length) {
      process.stdout.write('\n' + c('1', `逐段归属（共 ${r.segments.length} 段）：`) + '\n');
      for (const s of r.segments) {
        const pos = s.position ? `[${s.position[0]},${s.position[1]})` : '';
        process.stdout.write(`  #${s.order} ${c(labelColor(s.label), s.label_name)} conf=${s.confidence} ${c('2', pos)}\n`);
      }
    }

    // 详情场景默认给全文：历史本来就是为了回看与对比，省略文本等于记录作废
    if (!flag(kv, 'no-full')) {
      const ft = buildFullText(r);
      process.stdout.write('\n' + c('1', '检测全文（未做任何截断）：') + '\n');
      process.stdout.write('─'.repeat(52) + '\n');
      if (ft) {
        if (!ft.complete) {
          process.stdout.write(c('33', '⚠ 该记录未保存原文，以下内容由各段文本拼接而成，段间空白可能与原文不同。\n'));
        }
        if (ft.spans.length) {
          let cursor = 0;
          for (const sp of ft.spans) {
            if (sp.start > cursor) process.stdout.write(ft.text.slice(cursor, sp.start));
            process.stdout.write(c(labelColor(sp.label), `【${sp.label_name}】`) + ft.text.slice(Math.max(cursor, sp.start), sp.end));
            cursor = Math.max(cursor, sp.end);
          }
          if (cursor < ft.text.length) process.stdout.write(ft.text.slice(cursor));
          if (!ft.text.endsWith('\n')) process.stdout.write('\n');
        } else {
          process.stdout.write(ft.text + '\n');
        }
      } else {
        process.stdout.write(c('2', '（该记录既没有原文也没有分段文本）\n'));
      }
    }
    return;
  }

  if (action === 'stats') {
    const st = historyStats();
    if (json) return emit(st, { json: true, out: kv.out });
    if (!st.count) {
      process.stdout.write('暂无检测历史。\n');
      return;
    }
    process.stdout.write(c('1', '检测历史统计') + '\n');
    process.stdout.write('─'.repeat(46) + '\n');
    process.stdout.write(`记录数      ${st.count}\n`);
    process.stdout.write(`时间范围    ${st.first_at?.slice(0, 19)} → ${st.last_at?.slice(0, 19)}\n`);
    process.stdout.write(`平均 AI 率  ${st.average.ai_rate_percent}%\n`);
    process.stdout.write(
      `平均三段    人工特征 ${st.average.human_percent}% / 疑似 AI ${st.average.suspected_ai_percent}% / AI 特征 ${st.average.ai_percent ?? 0}%\n`
    );
    process.stdout.write(`按结论      ${Object.entries(st.by_verdict).map(([k, v]) => `${k}=${v}`).join(' · ')}\n`);
    process.stdout.write(`按来源      ${Object.entries(st.by_source).map(([k, v]) => `${k}=${v}`).join(' · ')}\n`);
    process.stdout.write(c('2', `存储        ${st.file}`) + '\n');
    return;
  }

  if (action === 'export') {
    const format = kv.format === 'csv' ? 'csv' : 'json';
    const body = exportHistory({ format, limit: kv.limit ? Number(kv.limit) : 500 });
    return emit(body, { jsonl: format === 'csv', out: kv.out, json: format === 'json' && !kv.out });
  }

  if (action === 'rm' || action === 'delete') {
    const id = kv.id || opts._[1];
    if (!id) throw new ConfigError('未指定历史 id。', '用法：zhuque history rm <id>');
    const r = deleteHistory(id);
    process.stdout.write(r.deleted ? `✓ 已删除 ${id}\n` : `未找到 ${id}\n`);
    return;
  }

  if (action === 'clear') {
    if (!flag(kv, 'yes') && !flag(kv, 'y')) {
      throw new ConfigError('清空全部历史需要确认。', '加 --yes 确认执行：zhuque history clear --yes');
    }
    const r = clearHistory();
    process.stdout.write(`✓ 已清空 ${r.deleted} 条历史记录\n`);
    return;
  }

  throw new ConfigError(`未知的 history 子命令：${action}`, '可用：list / show / stats / export / rm / clear');
}

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------

function saveKeys(list, patch = {}) {
  const next = list.map((k, i) => ({
    id: k.id || `k${i + 1}`,
    key: k.key,
    label: k.label || `Key ${i + 1}`,
    account: k.account || '',
    enabled: k.enabled !== false,
    added_at: k.added_at,
  }));
  const res = writeConfig({ api_keys: next, ...patch });
  return res;
}

async function cmdKeys(opts) {
  const kv = opts.keyValues;
  const action = opts._[0] || 'list';
  const json = flag(kv, 'json');
  const noColor = flag(kv, 'no-color');
  const c = (code, s) => (!noColor && process.stdout.isTTY ? `\u001b[${code}m${s}\u001b[0m` : s);

  if (action === 'list') {
    const p = poolStatus();
    if (json) return emit({ ...p, state_file: p.storage?.state }, { json: true, out: kv.out });
    process.stdout.write(c('1', 'API Key 池') + '\n');
    process.stdout.write('─'.repeat(60) + '\n');
    if (!p.count) {
      process.stdout.write('池中还没有 Key。\n');
      process.stdout.write(c('2', '添加：zhuque keys add --key sk-xxx --label 主号\n'));
      process.stdout.write(c('2', '或只填单 Key：zhuque config set api_key=sk-xxx\n'));
      return;
    }
    process.stdout.write(`共 ${p.count} 把 · 可用 ${p.available_count} 把` + (p.next_key ? ` · 下一把 ${p.next_key.label}(${p.next_key.masked})` : '') + '\n');
    process.stdout.write(`轮换策略    ${p.rotation}\n\n`);
    for (const k of p.keys) {
      const st = k.available ? c('32', '可用') : k.unavailable_reason === 'cooling_down' ? c('33', '冷却中') : k.unavailable_reason === 'disabled_by_user' ? c('2', '已停用') : c('31', '已失效');
      process.stdout.write(`  ${k.id}  ${k.label.padEnd(12)} ${k.masked}  ${st}\n`);
      process.stdout.write(
        c('2', `        已用 ${k.used_tokens} token · 调用 ${k.calls}（成功 ${k.ok}/失败 ${k.fail}）`) +
          (k.cooldown_until ? c('2', ` · 冷却至 ${k.cooldown_until.slice(0, 19)}`) : '') + '\n'
      );
      if (k.last_error) process.stdout.write(c('31', `        最近错误 ${k.last_error.code}: ${(k.last_error.message || '').slice(0, 60)}`) + '\n');
    }
    return;
  }

  if (action === 'add') {
    const raw = kv.key || kv['api-key'];
    if (!raw) throw new ConfigError('未提供 Key。', '用法：zhuque keys add --key sk-xxx --label 主号');
    const parts = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    const existing = normalizeKeyList(readConfig().api_keys || []);
    const label = kv.label;
    parts.forEach((key, i) => {
      existing.push({
        id: `k${Date.now().toString(16).slice(-6)}${i}`,
        key,
        account: kv.account || '',
        label: parts.length > 1 ? `${label || 'Key'}-${i + 1}` : label || `Key ${existing.length + 1}`,
        enabled: true,
        added_at: new Date().toISOString(),
      });
    });
    const res = saveKeys(existing);
    process.stdout.write(`✓ 已添加 ${parts.length} 把 Key 到池中（${res.file}）\n`);
    const p = poolStatus();
    process.stdout.write(`池中现有 ${p.count} 把，可用 ${p.available_count} 把。\n`);
    return;
  }

  if (action === 'rm' || action === 'delete') {
    const id = kv.id || opts._[1];
    if (!id) throw new ConfigError('未指定 Key id。', '用法：zhuque keys rm <id>（id 见 zhuque keys list）');
    const list = normalizeKeyList(readConfig().api_keys || []).filter((k) => k.id !== id);
    saveKeys(list);
    process.stdout.write(`✓ 已从池中移除 ${id}\n`);
    return;
  }

  if (action === 'enable' || action === 'disable') {
    const id = kv.id || opts._[1];
    if (!id) throw new ConfigError('未指定 Key id。', `用法：zhuque keys ${action} <id>`);
    const r = setKeyEnabled(id, action === 'enable');
    if (!r.updated) {
      process.stdout.write(`未找到可切换的 Key ${id}（单 Key 模式无法单独停用）。\n`);
      return;
    }
    process.stdout.write(`✓ 已${action === 'enable' ? '启用' : '停用'} ${id}\n`);
    return;
  }

  if (action === 'reset') {
    const id = kv.id || opts._[1];
    if (id) {
      resetKeyState(id);
      process.stdout.write(`✓ 已重置 ${id} 的冷却与失效状态\n`);
    } else {
      resetAllKeyState();
      process.stdout.write('✓ 已重置所有 Key 的冷却与失效状态（密钥不变）\n');
    }
    return;
  }

  throw new ConfigError(`未知的 keys 子命令：${action}`, '可用：list / add / rm / enable / disable / reset');
}

async function cmdDoctor() {
  const key = resolveApiKey(process.env.ZHUQUE_API_KEY);
  const lines = [];
  lines.push(`zhuque-detect v${VERSION}`);
  lines.push(`node              ${process.version}`);
  lines.push(`endpoint          ${resolveEndpoint()}`);
  lines.push(`配置文件          ${configPath()}`);
  lines.push(`API Key           ${key ? `${maskKey(key)}  (来源 ${apiKeySource()})` : '未配置'}`);

  if (!key) {
    lines.push('');
    lines.push('✗ 未找到 API Key。请任选一种方式配置：');
    lines.push('  1) 启动服务后打开网页，点右上角「设置」填写（推荐）');
    lines.push('  2) ./bin/zhuque config set api_key=你的Key');
    lines.push('  3) export ZHUQUE_API_KEY=你的Key');
    lines.push('  Key 获取：https://console.cloud.tencent.com/edgeone/makers?tab=models&subTab=apikey');
    process.stdout.write(lines.join('\n') + '\n');
    process.exitCode = 1;
    return;
  }

  const probe = '这是一段用于连通性自检的普通文本，它由人类手写而成，不包含任何人工智能生成的内容特征，仅用于验证接口是否可用。';
  try {
    const t0 = Date.now();
    const r = await detect(probe, { cache: false, isMerge: true, record: false, history: false });
    lines.push(`连通性            ✓ 正常（${Date.now() - t0}ms）`);
    lines.push(`自检结论          ${r.verdict_name} / AI 率 ${r.ai_rate_percent}%`);
    lines.push(`计费 token        ${r._meta.usage.makers_billed_tokens}`);
  } catch (err) {
    lines.push(`连通性            ✗ 失败`);
    lines.push('');
    if (err instanceof ZhuqueError) {
      lines.push(`错误码 ${err.code}`);
      lines.push(`说明   ${err.message}`);
      if (err.hint) lines.push(`建议   ${err.hint}`);
    } else {
      lines.push(String(err?.stack || err));
    }
    process.exitCode = 1;
  }

  const usage = usageSummary();
  lines.push('');
  lines.push(`本周期用量        ${usage.used.billed_tokens.toLocaleString()} / ${usage.quota_per_month.toLocaleString()} token（已用 ${usage.used.percent}%，剩余 ${usage.remaining.tokens.toLocaleString()}）`);
  lines.push(`账期              ${usage.cycle.start} → ${usage.cycle.end}`);

  const pool = poolStatus();
  if (pool.count) {
    lines.push(`Key 池            ${pool.count} 把，可用 ${pool.available_count} 把${pool.next_key ? `，下一把 ${pool.next_key.label}（${pool.next_key.masked}）` : ''}`);
    for (const k of pool.keys) {
      lines.push(`  · ${k.label.padEnd(10)} ${k.masked}  ${k.available ? '可用' : `不可用(${k.unavailable_reason})`}`);
    }
  }

  const st = historyStats();
  lines.push(`检测历史          ${st.count} 条${st.last_at ? `（最近 ${st.last_at.slice(0, 19)}）` : ''}`);
  lines.push(`历史文件          ${st.file}`);
  process.stdout.write(lines.join('\n') + '\n');
}

async function cmdSchema() {
  const { buildSchemaDoc } = await import('./schema.mjs');
  process.stdout.write(JSON.stringify(buildSchemaDoc(), null, 2) + '\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
    process.stdout.write(HELP);
    return;
  }

  loadLocalSettings();
  applyConfigToEnv();

  const known = ['detect', 'serve', 'mcp', 'doctor', 'schema', 'install-mcp', 'config', 'usage', 'history', 'keys'];
  let cmd = 'detect';
  let rest = argv;
  if (known.includes(argv[0])) {
    cmd = argv[0];
    rest = argv.slice(1);
  }

  try {
    // parseArgs 也会抛 ZhuqueError（如选项漏了取值），所以必须放进 try 里
    const opts = parseArgs(rest);
    if (cmd === 'detect') await cmdDetect(opts);
    else if (cmd === 'serve') await cmdServe(opts);
    else if (cmd === 'mcp') await cmdMcp();
    else if (cmd === 'doctor') await cmdDoctor();
    else if (cmd === 'schema') await cmdSchema();
    else if (cmd === 'config') await cmdConfig(opts);
    else if (cmd === 'usage') await cmdUsage(opts);
    else if (cmd === 'history') await cmdHistory(opts);
    else if (cmd === 'keys') await cmdKeys(opts);
    else if (cmd === 'install-mcp') {
      const mod = await import('./install-mcp.mjs');
      await mod.installMcp();
    }
  } catch (err) {
    if (err instanceof ZhuqueError) {
      process.stderr.write(`\n[${err.code}] ${err.message}\n`);
      if (err.hint) process.stderr.write(`提示：${err.hint}\n`);
    } else if (err instanceof ConfigError) {
      process.stderr.write(`\n[配置错误] ${err.message}\n`);
      if (err.hint) process.stderr.write(`提示：${err.hint}\n`);
    } else {
      process.stderr.write(`\n未预期错误：${err?.stack || err}\n`);
    }
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
