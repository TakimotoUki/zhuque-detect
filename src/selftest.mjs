#!/usr/bin/env node
/**
 * 自测：不消耗 API 额度。
 *   1) 用固定 fixture 校验 normalize / aggregate / verdict 分档
 *   2) 起本地 HTTP 服务，用 mock 上游校验接口信封与错误码
 *   3) 用 JSON-RPC 消息直接喂给 MCP handler，校验工具与 schema
 *
 * 运行： node src/selftest.mjs
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize, verdictOf, chunkText, detect, buildFullText, ZhuqueError, clearCache, tokenFilePaths, tokenFilePath, readTokenFile, parseTokenText, resolveKeyChoice } from './core.mjs';
import { buildSchemaDoc, buildLlmsTxt } from './schema.mjs';
import { createServer } from './server.mjs';

// ---- 测试隔离：绝不触碰用户真实的 ~/.zhuque 数据 ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhuque-selftest-'));
process.env.ZHUQUE_CONFIG_FILE = path.join(TMP, 'config.json');
process.env.ZHUQUE_USAGE_FILE = path.join(TMP, 'usage.json');
process.env.ZHUQUE_HISTORY_FILE = path.join(TMP, 'history.jsonl');
process.env.ZHUQUE_KEYS_FILE = path.join(TMP, 'keys-state.json');
// token.txt 只在临时目录里找，绝不读项目根/当前目录下的真实 token.txt
process.env.ZHUQUE_TOKEN_FILE = path.join(TMP, 'token.txt');
// 清掉可能从外部带进来的 Key / 客户端标识，避免测试结果依赖调用者的 shell 环境
delete process.env.ZHUQUE_API_KEY;
delete process.env.EDGEONE_MAKERS_API_KEY;
delete process.env.EDGEONE_API_KEY;
delete process.env.ZHUQUE_MCP_CLIENT;

const { readConfig, writeConfig, configPath } = await import('./config-store.mjs');
const { usageSummary, recordUsage, resetUsage } = await import('./usage-store.mjs');
const { appendHistory } = await import('./history-store.mjs');

// ---- 隔离护栏：任何时候都不允许写到用户真实的 ~/.zhuque ----
const REAL_DIR = path.join(os.homedir(), '.zhuque');

/** 断言所有数据文件都在临时目录内；隔离一旦被破坏就立刻中止 */
async function assertIsolated() {
  const targets = [
    process.env.ZHUQUE_CONFIG_FILE,
    process.env.ZHUQUE_USAGE_FILE,
    process.env.ZHUQUE_HISTORY_FILE,
    process.env.ZHUQUE_KEYS_FILE,
    process.env.ZHUQUE_TOKEN_FILE,
  ].filter(Boolean);
  for (const t of targets) {
    if (!t.startsWith(TMP)) throw new Error(`测试隔离被破坏：${t} 不在临时目录内，拒绝继续。`);
  }
  const { historyPath } = await import('./history-store.mjs');
  const { keyStatePath } = await import('./key-pool.mjs');
  for (const p of [configPath(), historyPath(), keyStatePath()]) {
    if (p && p.startsWith(REAL_DIR) && !p.startsWith(TMP)) {
      throw new Error(`测试隔离被破坏：${p} 指向真实目录，拒绝继续。`);
    }
  }
  // token.txt 的候选路径也只允许落在临时目录
  for (const p of tokenFilePaths()) {
    if (!p.startsWith(TMP)) throw new Error(`测试隔离被破坏：token.txt 候选路径 ${p} 不在临时目录内。`);
  }
}
await assertIsolated();

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (e) {
    failed += 1;
    process.stdout.write(`  ✗ ${name}\n    ${e.message}\n`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (e) {
    failed += 1;
    process.stdout.write(`  ✗ ${name}\n    ${e.message}\n`);
  }
}

const fixtureHuman = {
  status: 'success',
  softmax_confidence: 0.0019,
  ratio_confidence: 0,
  labels_ratio: { 0: 1, 1: 0, 2: 0 },
  segment_labels: [{ text: 'hello world', label: 0, conf: 0.0019, order: 1, position: [0, 11] }],
  usage: { total_tokens: 50 },
  msg: '',
  makers_models_usage: { total_tokens: 30 },
};

const fixtureAi = {
  status: 'success',
  softmax_confidence: 0.9823,
  ratio_confidence: 0.75,
  labels_ratio: { 0: 0.25, 1: 0.5, 2: 0.25 },
  segment_labels: [
    { text: '人工智能技术的快速发展正在深刻改变着我们的生活方式。', label: 2, conf: 0.99, order: 1, position: [0, 26] },
    { text: '今天下午我去楼下买了杯咖啡，顺手把快递取了。', label: 0, conf: 0.98, order: 2, position: [26, 49] },
    { text: '总体而言需要持续关注其影响。', label: 1, conf: 0.7, order: 3, position: [49, 62] },
  ],
  usage: { total_tokens: 300 },
  msg: '',
  makers_models_usage: { total_tokens: 210 },
};

process.stdout.write('\n[1/6] 归一化、三段占比与分档\n');

test('人类文本 → verdict=human，ai_rate=0', () => {
  const r = normalize(fixtureHuman, { text: 'hello world' });
  assert.equal(r.verdict, 'human');
  assert.equal(r.ai_rate, 0);
  assert.equal(r.human_rate, 1);
  assert.equal(r.flagged_segments.length, 0);
});

test('AI 文本 → verdict=ai，ai_rate=0.75（AI+疑似）', () => {
  const r = normalize(fixtureAi, { text: 'x'.repeat(200) });
  assert.equal(r.ai_rate, 0.75);
  assert.equal(r.human_rate, 0.25);
  assert.equal(r.verdict, 'ai');
  assert.equal(r.flagged_segment_count, 2, 'label 1 与 2 都算被标记');
  assert.deepEqual(r.flagged_segments[0].position, [0, 26]);
});

test('三段占比对齐官网语义：label 1=疑似 AI，label 2=AI 特征', () => {
  const r = normalize(fixtureAi, { text: 'x'.repeat(200) });
  assert.ok(r.categories, 'categories 应存在');
  assert.equal(r.categories.basis, 'labels_ratio', '上游整体占比优先于可能稀疏的分段');
  // 逐段字符数：AI 26 字、人工 22 字、疑似 14 字 → 合计 62
  assert.equal(r.categories.ai.chars, 26);
  assert.equal(r.categories.human.chars, 22);
  assert.equal(r.categories.suspected_ai.chars, 14);
  assert.equal(r.categories.ai.segments, 1);
  assert.equal(r.categories.human.segments, 1);
  assert.equal(r.categories.suspected_ai.segments, 1);
  const sum = r.categories.human.percent + r.categories.suspected_ai.percent + r.categories.ai.percent;
  assert.ok(Math.abs(sum - 100) < 0.05, `三段占比应合计约 100%，实际 ${sum}`);
});

test('每段都带归属类别与可定位下标', () => {
  const r = normalize(fixtureAi, { text: 'x'.repeat(200) });
  assert.equal(r.segments.length, 3);
  assert.deepEqual(r.segments.map((s) => s.label_name), ['AI 特征', '人工特征', '疑似 AI']);
  assert.deepEqual(r.segments.map((s) => s.category), ['ai', 'human', 'suspected_ai']);
  assert.deepEqual(r.segments.map((s) => s.start), [0, 26, 49]);
});

test('无分段信息时三段占比退回 labels_ratio', () => {
  const raw = { labels_ratio: { 0: 0.5, 1: 0.2, 2: 0.3 }, softmax_confidence: 0.5, segment_labels: [] };
  const r = normalize(raw, { text: 'x'.repeat(200) });
  assert.equal(r.categories.basis, 'labels_ratio');
  assert.equal(r.categories.ai.percent, 20);
  assert.equal(r.categories.suspected_ai.percent, 30);
  assert.equal(r.categories.human.percent, 50);
});

test('短文本触发 TEXT_TOO_SHORT 告警', () => {
  const r = normalize(fixtureHuman, { text: 'hi' });
  assert.equal(r.warnings[0].code, 'TEXT_TOO_SHORT');
});

test('verdict 分档边界', () => {
  assert.equal(verdictOf(0).key, 'human');
  assert.equal(verdictOf(0.2).key, 'mostly_human');
  assert.equal(verdictOf(0.5).key, 'mixed');
  assert.equal(verdictOf(0.7).key, 'likely_ai');
  assert.equal(verdictOf(0.95).key, 'ai');
});

test('超长文本按段落切块且不丢内容', () => {
  const text = Array.from({ length: 40 }, (_, i) => `第${i}段：${'内容'.repeat(80)}`).join('\n\n');
  const chunks = chunkText(text, 1000);
  assert.ok(chunks.length > 1, `应切成多块，实际 ${chunks.length}`);
  assert.ok(chunks.every((c) => c.length <= 1000), '每块不超过上限');
  assert.equal(chunks.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
});

process.stdout.write('\n[2/6] Schema 与说明文档\n');

test('schema 包含三段占比、分段与历史说明', () => {
  const s = buildSchemaDoc();
  const props = s.endpoints['POST /api/detect'].response.properties;
  for (const k of ['ai_rate', 'human_rate', 'categories', 'segments', 'verdict', 'flagged_segments', 'warnings', '_meta']) {
    assert.ok(props[k], `缺少字段 ${k}`);
  }
  assert.equal(s.labels.length, 3);
  assert.equal(s.categories.length, 3);
  assert.deepEqual(s.categories.map((c) => c.key), ['human', 'suspected_ai', 'ai']);
  assert.equal(s.verdicts.length, 5);
  assert.ok(s.history, '应包含历史说明');
  assert.ok(s.key_pool, '应包含 Key 池说明');
  assert.deepEqual(s.mcp_clients.allowed_clients, ['workbuddy', 'codex']);
});

test('llms.txt 含关键接口与字段说明', () => {
  const t = buildLlmsTxt('http://127.0.0.1:8787');
  assert.ok(t.includes('/api/detect'));
  assert.ok(t.includes('ai_rate'));
  assert.ok(t.includes('categories'));
  assert.ok(t.includes('X-Zhuque-Api-Key'));
  assert.ok(t.includes('/api/history'));
});

process.stdout.write('\n[3/6] HTTP 接口\n');

let upstream;
let server;
let baseUrl;
const upstreamCalls = [];

await testAsync('启动 mock 上游与本地服务', async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      upstreamCalls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      if (req.headers.authorization !== 'Bearer test-key') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'error', msg: 'unauthorized' }));
      }
      const isAi = JSON.parse(body).text.includes('人工智能');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(isAi ? fixtureAi : fixtureHuman));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/classify`;

  process.env.ZHUQUE_ENDPOINT = upstreamUrl;
  process.env.ZHUQUE_API_KEY = 'test-key';

  server = createServer({ token: '' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

await testAsync('GET /api/health 返回服务状态', async () => {
  const r = await fetch(`${baseUrl}/api/health`);
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.ok, true);
  assert.equal(j.server_key.configured, true);
});

await testAsync('POST /api/detect 返回统一信封 + ai_rate + 三段占比 + 分段', async () => {
  const r = await fetch(`${baseUrl}/api/detect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '人工智能技术的快速发展正在深刻改变着我们的生活方式。'.repeat(4), is_merge: true }),
  });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.ok, true);
  assert.equal(j.data.ai_rate, 0.75);
  assert.equal(j.data.verdict, 'ai');
  assert.equal(j.data._meta.detector, 'tencent-zhuque-text');
  assert.ok(Array.isArray(j.data.flagged_segments));
  // 三段占比必须齐备且合计约 100%
  const c = j.data.categories;
  assert.ok(c && c.human && c.suspected_ai && c.ai, '缺少 categories');
  const sum = c.human.percent + c.suspected_ai.percent + c.ai.percent;
  assert.ok(Math.abs(sum - 100) < 0.05, `三段占比应合计 100%，实际 ${sum}`);
  // 逐段归属
  assert.ok(Array.isArray(j.data.segments) && j.data.segments.length >= 1);
  assert.ok(j.data.segments.every((s) => s.label_name && s.category), '每段都应带 label_name 与 category');
  // 检测结果自动落历史
  assert.ok(j.data._meta.history_id, '应返回 history_id');
});

await testAsync('缺失 text → 400 且带 code/hint', async () => {
  const r = await fetch(`${baseUrl}/api/detect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nope: 1 }),
  });
  const j = await r.json();
  assert.equal(r.status, 400);
  assert.equal(j.ok, false);
  assert.equal(j.error.code, 'MISSING_FIELD');
  assert.ok(j.error.hint.length > 0);
});

await testAsync('GET /api/detect?text= 便捷形式可用', async () => {
  const r = await fetch(`${baseUrl}/api/detect?text=${encodeURIComponent('今天下午我去楼下买了杯咖啡。')}`);
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.ok, true);
  assert.equal(j.data.verdict, 'human');
});

await testAsync('缓存命中：同文本第二次调用不再打上游', async () => {
  clearCache();
  const before = upstreamCalls.length;
  const body = JSON.stringify({ text: '缓存开关校验文本。'.repeat(20) });
  await fetch(`${baseUrl}/api/detect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const mid = upstreamCalls.length;
  const r2 = await fetch(`${baseUrl}/api/detect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const j2 = await r2.json();
  assert.equal(upstreamCalls.length, mid, '第二次不应请求上游');
  assert.equal(j2.data._meta.cache_hit, true);
  assert.ok(mid > before);
});

await testAsync('no_cache 时不命中缓存', async () => {
  clearCache();
  const body = JSON.stringify({ text: '绕过缓存校验文本。'.repeat(20), cache: false });
  await fetch(`${baseUrl}/api/detect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const mid = upstreamCalls.length;
  await fetch(`${baseUrl}/api/detect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal(upstreamCalls.length, mid + 1);
});

await testAsync('POST /api/batch 逐条返回成功/失败', async () => {
  const r = await fetch(`${baseUrl}/api/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [
        { id: 'a', text: '人工智能技术'.repeat(20) },
        { id: 'b', text: '今天下午我去楼下买了杯咖啡。'.repeat(6) },
        { id: 'c', text: '' },
      ],
    }),
  });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.ok, true, 'HTTP 请求本身成功');
  assert.equal(j.data.all_succeeded, false, '存在失败条目');
  assert.equal(j.data.count, 3);
  assert.equal(j.data.succeeded, 2);
  assert.equal(j.data.failed, 1);
  assert.equal(j.data.results[2].error.code, 'EMPTY_TEXT');
});

await testAsync('未知路径 → 404 + NOT_FOUND', async () => {
  const r = await fetch(`${baseUrl}/api/nope`);
  const j = await r.json();
  assert.equal(r.status, 404);
  assert.equal(j.error.code, 'NOT_FOUND');
});

await testAsync('自带 Key 通过 X-Zhuque-Api-Key 覆盖服务端 Key', async () => {
  const r = await fetch(`${baseUrl}/api/detect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Zhuque-Api-Key': 'wrong-key' },
    body: JSON.stringify({ text: 'ai'.repeat(80), cache: false }),
  });
  const j = await r.json();
  assert.equal(r.status, 401);
  assert.equal(j.error.code, 'HTTP_401');
  assert.ok(j.error.hint.includes('API Key'));
});

await testAsync('缺 Key 时返回 NO_API_KEY', async () => {
  const saved = process.env.ZHUQUE_API_KEY;
  delete process.env.ZHUQUE_API_KEY;
  delete process.env.EDGEONE_MAKERS_API_KEY;
  delete process.env.EDGEONE_API_KEY;
  try {
    await assert.rejects(() => detect('x'.repeat(200), { cache: false }), (e) => e instanceof ZhuqueError && e.code === 'NO_API_KEY');
  } finally {
    process.env.ZHUQUE_API_KEY = saved;
  }
});

process.stdout.write('\n[4/6] 配置、用量、历史与 Key 池\n');

await testAsync('配置：写入 / 读取 / 掩码 / 权限 / 校验', async () => {
  const file = configPath();
  assert.ok(file.startsWith(TMP), `配置路径应被隔离到临时目录，实际 ${file}`);

  const res = writeConfig({ api_key: 'sk-test-abcdef123456', timeout_ms: 45000, max_chars: 3000, auto_open: true });
  assert.equal(res.file, file);
  assert.ok(fs.existsSync(file));

  const cfg = readConfig();
  assert.equal(cfg.api_key, 'sk-test-abcdef123456');
  assert.equal(cfg.timeout_ms, 45000);
  assert.equal(cfg.auto_open, true);

  // Unix mode bits do not represent Windows ACLs.
  const stat = fs.statSync(file);
  assert.ok(stat.isFile());
  if (process.platform !== 'win32') {
    const mode = stat.mode & 0o777;
    assert.equal(mode, 0o600, `配置权限应为 600，实际 ${mode.toString(8)}`);
  }

  // 非法值必须被拒绝
  assert.throws(() => writeConfig({ port: 99999 }), /端口超出范围/);
  assert.throws(() => writeConfig({ timeout_ms: -1 }), /整数/);
  assert.throws(() => writeConfig({ endpoint: 'ftp://x' }), /http/);
  assert.throws(() => writeConfig({ nope: 1 }), /不支持的配置字段/);

  // 清除
  writeConfig({ clear: { api_key: true } });
  assert.equal(readConfig().api_key, undefined);
  assert.equal(readConfig().timeout_ms, 45000, '清除单项不应影响其他项');
});

await testAsync('token.txt：裸 Key / KEY=VALUE / BOM / UTF-16 / CRLF 均能识别', async () => {
  const file = process.env.ZHUQUE_TOKEN_FILE;
  assert.ok(file.startsWith(TMP), `token.txt 路径应被隔离，实际 ${file}`);

  // 覆盖式：设了 ZHUQUE_TOKEN_FILE 就只认这一个路径
  assert.deepEqual(tokenFilePaths(), [path.resolve(file)]);

  const write = (buf) => fs.writeFileSync(file, buf);
  const clear = () => {
    if (fs.existsSync(file)) fs.rmSync(file);
  };

  // 前面的 HTTP 用例会设 ZHUQUE_API_KEY，环境变量优先级高于 token.txt，
  // 这里先摘掉，测完再还原，避免相互干扰。
  const savedEnv = process.env.ZHUQUE_API_KEY;
  delete process.env.ZHUQUE_API_KEY;

  try {
    // ① 裸 Key（UTF-8 无 BOM）
    clear();
    write('sk-bare-key-abcdefghijklmn\n');
    assert.equal(readTokenFile(), 'sk-bare-key-abcdefghijklmn', '应识别裸 Key');

    // ② KEY=VALUE 形式，带注释与空行
    clear();
    write('# 这是我的朱雀 Key\n\nZHUQUE_API_KEY = sk-eq-form-key-123456\n');
    assert.equal(readTokenFile(), 'sk-eq-form-key-123456', '应识别 KEY=VALUE');

    // ③ UTF-8 BOM（部分 Windows 记事本会写 BOM）
    clear();
    write(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('sk-bom-key-abcdefghij\n', 'utf8')]));
    assert.equal(readTokenFile(), 'sk-bom-key-abcdefghij', '应剥离 UTF-8 BOM');

    // ④ UTF-16LE（记事本「Unicode」选项）—— 必须不能读出乱码
    clear();
    write(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('sk-utf16le-key-abcdefgh\n', 'utf16le')]));
    assert.equal(readTokenFile(), 'sk-utf16le-key-abcdefgh', '应识别 UTF-16LE');

    // ⑤ CRLF 行尾 + 行尾多余空格
    clear();
    write('sk-crlf-key-abcdefghij\r\n');
    assert.equal(readTokenFile(), 'sk-crlf-key-abcdefghij', '应兼容 CRLF');

    // ⑥ Key 本身含 '=' 时不能被误切成 KEY=VALUE
    clear();
    write('sk-tail-equals-abc==\n');
    assert.equal(parseTokenText(fs.readFileSync(file)), 'sk-tail-equals-abc==', "含 '=' 的 Key 应原样读取");

    // ⑦ 显式指定优先于 token.txt
    const viaExplicit = resolveKeyChoice('sk-explicit-wins-000111');
    assert.equal(viaExplicit.key, 'sk-explicit-wins-000111');
    assert.equal(viaExplicit.source, 'explicit');

    // ⑧ token.txt 生效，且来源标注正确、返回值只给掩码
    clear();
    write('sk-from-token-file-987654321\n');
    const choice = resolveKeyChoice(null);
    assert.equal(choice.key, 'sk-from-token-file-987654321', '应取 token.txt 的 Key');
    assert.ok(choice.source.startsWith('token:'), `来源应标注 token:，实际 ${choice.source}`);
    assert.equal(choice.label, 'token.txt');
    assert.ok(!choice.masked.includes('987654321'), '掩码不应泄漏完整 Key');

    // ⑨ 环境变量优先于 token.txt
    process.env.ZHUQUE_API_KEY = 'sk-env-beats-token-000';
    try {
      const byEnv = resolveKeyChoice(null);
      assert.equal(byEnv.key, 'sk-env-beats-token-000', '环境变量应优先于 token.txt');
      assert.ok(byEnv.source.startsWith('env:'), byEnv.source);
    } finally {
      delete process.env.ZHUQUE_API_KEY;
    }
  } finally {
    // 清理：后续用例依赖 config/env 里的 Key，绝不能让 token.txt 残留干扰
    clear();
    if (savedEnv === undefined) delete process.env.ZHUQUE_API_KEY;
    else process.env.ZHUQUE_API_KEY = savedEnv;
  }

  // 文件不存在时安静返回空串，不抛错
  assert.equal(readTokenFile(), '', '文件不存在应返回空串');
  assert.equal(tokenFilePath(), null, '文件不存在时路径应为 null');
});

await testAsync('非法字符的 Key 被明确拦下（不再抛晦涩的 ByteString 错误）', async () => {
  const file = process.env.ZHUQUE_TOKEN_FILE;
  const savedEnv = process.env.ZHUQUE_API_KEY;
  delete process.env.ZHUQUE_API_KEY;
  try {
    // ① 分发出去后最常见的坑：token.txt 里的占位符没替换（含中文且以 sk- 开头）
    fs.writeFileSync(file, '# 注释行\n\nsk-在这里粘贴你的Key\n');
    await assert.rejects(
      () => detect('用于校验 Key 字符集的普通文本。', { cache: false, record: false, history: false }),
      (e) => e instanceof ZhuqueError && e.code === 'BAD_API_KEY' && /第 4 个字符/.test(e.message),
      '占位符 Key 应以 BAD_API_KEY 报错，并指出出错字符位置'
    );

    // ② 显式传入的 Key 里夹了空格
    await assert.rejects(
      () => detect('用于校验 Key 字符集的普通文本。', { apiKey: 'sk-abc def', cache: false, record: false, history: false }),
      (e) => e instanceof ZhuqueError && e.code === 'BAD_API_KEY',
      '含空格的 Key 应被拦下'
    );

    // ③ 合法字符集应放行（这里只验证「不被 BAD_API_KEY 拦下」，网络层失败无妨）
    fs.writeFileSync(file, 'sk-0123456789abcdef0123456789abcdef\n');
    let code = null;
    try {
      await detect('用于校验 Key 字符集的普通文本。', { cache: false, record: false, history: false, timeoutMs: 1500 });
    } catch (e) {
      code = e?.code;
    }
    assert.notEqual(code, 'BAD_API_KEY', '合法 ASCII Key 不应被字符集校验拦下');
  } finally {
    if (fs.existsSync(file)) fs.rmSync(file);
    if (savedEnv === undefined) delete process.env.ZHUQUE_API_KEY;
    else process.env.ZHUQUE_API_KEY = savedEnv;
  }
});

await testAsync('用量：记账 / 汇总 / 校准 / 归零', async () => {
  resetUsage();
  recordUsage({ billed: 100, zhuque: 150, chars: 500, calls: 2, key_mask: 'sk-t...3456' });
  recordUsage({ billed: 50, zhuque: 70, chars: 300, calls: 1 });

  let s = usageSummary();
  assert.equal(s.used.billed_tokens, 150);
  assert.equal(s.used.calls, 3);
  assert.equal(s.quota_per_month, 500000);
  assert.equal(s.remaining.tokens, 500000 - 150);
  assert.equal(s.today.billed_tokens, 150);
  assert.equal(s.daily.length, 7);
  assert.ok(s.average.per_call_tokens > 0);

  // 校准：把「控制台读数」对齐为 1000（偏移 +850）
  const { calibrate } = await import('./usage-store.mjs');
  s = calibrate(1000, '对控制台');
  assert.equal(s.used.billed_tokens, 1000);
  assert.equal(s.remaining.tokens, 499000);
  assert.ok(s.calibration, '校准信息应被记录');

  // 校准后继续本地累加
  recordUsage({ billed: 25, calls: 1, chars: 100 });
  s = usageSummary();
  assert.equal(s.used.billed_tokens, 1025, '校准偏移之上应继续累加');

  // 额度调整
  const { setQuota, clearCalibration } = await import('./usage-store.mjs');
  s = setQuota({ quota_per_month: 100000 });
  assert.equal(s.quota_per_month, 100000);
  assert.throws(() => setQuota({ cycle_start_day: 40 }), /1~31/);
  s = clearCalibration();
  assert.equal(s.calibration, null);
  assert.equal(s.used.billed_tokens, 175, '清除校准后回到纯本地统计');

  resetUsage();
  assert.equal(usageSummary().used.billed_tokens, 0);
});

await testAsync('HTTP /api/config：读取与保存（含 secret 掩码）', async () => {
  const g = await (await fetch(`${baseUrl}/api/config`)).json();
  assert.equal(g.ok, true);
  assert.equal(g.data.config_file, configPath());
  assert.ok(g.data.fields.api_key);
  assert.equal(g.data.fields.api_key.type, 'secret');
  assert.equal(g.data.fields.server_token.restart, true);
  // 前端「当前生效 Key · 来源」读的是 runtime.api_key.source；漏了这个字段界面会恒显示 none
  assert.ok(g.data.runtime.api_key.source, 'runtime.api_key.source 必须下发，否则界面显示来源 none');

  const p = await fetch(`${baseUrl}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: 'sk-ui-abcdef1234567890', timeout_ms: 30000 }),
  });
  const pj = await p.json();
  assert.equal(p.status, 200);
  assert.equal(pj.ok, true);
  assert.ok(pj.data.backup, '覆盖已有配置时应产生备份');
  assert.equal(pj.data.restart_required.length, 0, 'timeout 不需要重启');
  // 返回值里的密钥必须是掩码，不能回传明文
  assert.ok(!JSON.stringify(pj.data).includes('sk-ui-abcdef1234567890'), '响应中不得出现明文 Key');
  assert.ok(pj.data.saved.api_key.includes('...'));

  // 保存端口 → 应提示需要重启
  const p2 = await (await fetch(`${baseUrl}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port: 9911 }),
  })).json();
  assert.deepEqual(p2.data.restart_required, ['port']);

  // 非法值 → 400 + CONFIG_INVALID
  const bad = await fetch(`${baseUrl}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: 'not-a-url' }),
  });
  const bj = await bad.json();
  assert.equal(bad.status, 400);
  assert.ok(['CONFIG_INVALID', 'BAD_ENDPOINT'].includes(bj.error.code));
  assert.ok(bj.error.hint.length > 0);
});

await testAsync('HTTP /api/config/test：可达与不可达两条路径', async () => {
  const okRes = await fetch(`${baseUrl}/api/config/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const okj = await okRes.json();
  assert.equal(okRes.status, 200);
  assert.equal(okj.ok, true);
  assert.equal(okj.data.reachable, true, '正常 Key 应判定为可达');
  assert.ok(okj.data.latency_ms >= 0);
  assert.ok(okj.data.key_masked.length > 0, '应回显掩码后的 Key');
  assert.notEqual(okj.data.key_masked, 'test-key', '不得回显明文 Key');
  assert.ok(okj.data.probe.verdict_name);

  // 错误 Key：请求本身仍被正常处理（HTTP 200 + ok=true），可达性由 data.reachable 表达
  const badRes = await fetch(`${baseUrl}/api/config/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: 'definitely-wrong' }),
  });
  const badj = await badRes.json();
  assert.equal(badRes.status, 200);
  assert.equal(badj.ok, true, '测试请求被正确处理');
  assert.equal(badj.data.reachable, false, '错误 Key 必须判定为不可达');
  assert.equal(badj.data.error.code, 'HTTP_401');
  assert.ok(badj.data.error.hint.length > 0);
  assert.equal(badj.data.billed_tokens, 0);
  assert.ok(!JSON.stringify(badj).includes('definitely-wrong'), '响应中不得出现明文 Key');
});

await testAsync('连接测试 / Key 测试不写入检测历史（探针不得污染历史）', async () => {
  const count = async () => (await (await fetch(`${baseUrl}/api/history/stats`)).json()).data.count;
  const before = await count();
  await fetch(`${baseUrl}/api/config/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  await fetch(`${baseUrl}/api/keys/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(await count(), before, '连接测试是探针，不得写入检测历史');
});

/**
 * 用原始 socket 发请求：Node 的 fetch 会把 Host 当「禁止头」忽略掉，
 * 没法用来验证 Host 校验，只能手写 HTTP 请求行。
 */
function rawGet({ host, path: p, headers = {} }) {
  return new Promise((resolve) => {
    const port = Number(new URL(baseUrl).port);
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(
        [
          `GET ${p} HTTP/1.1`,
          `Host: ${host}`,
          'Connection: close',
          ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
          '',
          '',
        ].join('\r\n')
      );
    });
    let buf = '';
    sock.on('data', (d) => (buf += d));
    sock.on('close', () => {
      const status = Number((buf.match(/^HTTP\/1\.1 (\d+)/) || [])[1] || 0);
      resolve({ status, body: buf.slice(buf.indexOf('\r\n\r\n') + 4) });
    });
    sock.on('error', (e) => resolve({ status: 0, body: String(e) }));
  });
}

await testAsync('Host 头校验：非回环 Host 一律 403（防 DNS 重绑定）', async () => {
  // 模拟 DNS 重绑定：浏览器视角是 same-origin（所以 sec-fetch-site/Origin 两道校验都放行），
  // 但 Host 是攻击者域名 —— 只有 Host 校验能识破。
  const sfs = { 'Sec-Fetch-Site': 'same-origin' };
  for (const p of ['/api/history', '/api/config', '/api/keys', '/api/usage', '/api/health']) {
    const r = await rawGet({ host: 'evil.example:9999', path: p, headers: sfs });
    assert.equal(r.status, 403, `${p} 应拒绝非回环 Host，实际 ${r.status}`);
    assert.ok(r.body.includes('HOST_FORBIDDEN'), `${p} 应返回 HOST_FORBIDDEN`);
    assert.ok(!r.body.includes('config_file'), `${p} 不得泄漏配置内容`);
  }
  // 对照组：同样头部、只把 Host 换成回环 → 放行，证明差别确实只在 Host
  const okr = await rawGet({ host: new URL(baseUrl).host, path: '/api/history', headers: sfs });
  assert.equal(okr.status, 200, '回环 Host 应正常放行');
});

await testAsync('/api/health：Key 掩码与来源只回给本机请求', async () => {
  const local = await (await fetch(`${baseUrl}/api/health`)).json();
  assert.equal(local.server_key.configured, true);
  assert.ok(local.server_key.masked, '本机请求应能看到掩码');
  // 非回环 Host 直接被 Host 校验挡在门外，连掩码都不会下发
  const remote = await rawGet({ host: 'lan-box.example:9999', path: '/api/health' });
  assert.equal(remote.status, 403);
  assert.ok(!remote.body.includes('masked'), '远端请求不得拿到 Key 掩码');
});

await testAsync('HTTP /api/usage：汇总 / 校准 / 额度 / 归零', async () => {
  await fetch(`${baseUrl}/api/usage/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

  const u = await (await fetch(`${baseUrl}/api/usage?days=7`)).json();
  assert.equal(u.ok, true);
  assert.equal(u.data.quota_per_month, 500000);
  assert.equal(u.data.daily.length, 7);

  const cal = await (await fetch(`${baseUrl}/api/usage/calibrate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokens: 4321 }),
  })).json();
  assert.equal(cal.ok, true);
  assert.equal(cal.data.summary.used.billed_tokens, 4321);
  assert.equal(cal.data.summary.remaining.tokens, 500000 - 4321);

  const q = await (await fetch(`${baseUrl}/api/usage/quota`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quota_per_month: 200000 }),
  })).json();
  assert.equal(q.ok, true);
  assert.equal(q.data.summary.quota_per_month, 200000);

  const miss = await fetch(`${baseUrl}/api/usage/calibrate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const mj = await miss.json();
  assert.equal(miss.status, 400);
  assert.equal(mj.error.code, 'MISSING_FIELD');

  const r = await (await fetch(`${baseUrl}/api/usage/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })).json();
  assert.equal(r.data.summary.used.billed_tokens, 0);
});

await testAsync('Key 池：轮询、耗尽冷却、失效停用、重置', async () => {
  const { poolStatus, pickKey, noteFailure, noteSuccess, resetAllKeyState, listKeys } = await import('./key-pool.mjs');
  resetAllKeyState();
  writeConfig({
    api_keys: [
      { id: 'ka', key: 'sk-aaa-1111111111', label: 'A' },
      { id: 'kb', key: 'sk-bbb-2222222222', label: 'B' },
      { id: 'kc', key: 'sk-ccc-3333333333', label: 'C' },
    ],
    key_cooldown_ms: 60000,
  });

  assert.equal(listKeys().length, 3);
  // 轮询：连续 pick 应依次命中三把
  const seen = [pickKey().entry.id, pickKey().entry.id, pickKey().entry.id];
  assert.deepEqual(new Set(seen).size, 3, `轮询应覆盖三把，实际 ${seen}`);

  // 额度耗尽 → 进入冷却，被跳过
  noteFailure('ka', { code: 'HTTP_429', exhaust: true });
  let p = poolStatus();
  assert.equal(p.keys.find((k) => k.id === 'ka').available, false);
  assert.equal(p.keys.find((k) => k.id === 'ka').unavailable_reason, 'cooling_down');
  assert.equal(p.available_count, 2);

  // 失效 → 永久停用
  noteFailure('kb', { code: 'HTTP_401', invalidate: true });
  p = poolStatus();
  assert.equal(p.keys.find((k) => k.id === 'kb').unavailable_reason, 'invalid');
  assert.equal(p.available_count, 1);
  const only = pickKey();
  assert.equal(only.entry.id, 'kc', '只剩 C 可用');

  // 成功记账
  noteSuccess('kc', 123);
  p = poolStatus();
  assert.equal(p.keys.find((k) => k.id === 'kc').used_tokens, 123);

  // 重置后全部恢复
  resetAllKeyState();
  assert.equal(poolStatus().available_count, 3);

  writeConfig({ clear: { api_keys: true } });
});

await testAsync('真实检测后会自动记账', async () => {
  await fetch(`${baseUrl}/api/usage/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  clearCache();
  await fetch(`${baseUrl}/api/detect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '记账校验文本。'.repeat(30), cache: false }),
  });
  const u = await (await fetch(`${baseUrl}/api/usage`)).json();
  assert.ok(u.data.used.billed_tokens > 0, '检测后本周期用量应大于 0');
  assert.equal(u.data.used.calls, 1);
  assert.ok(u.data.last_call_at, '应记录最近调用时间');
});

await testAsync('HTTP /api/history：列表 / 明细 / 统计 / 导出 / 删除', async () => {
  // 前面已发生若干次检测，历史里应有记录
  const list = await (await fetch(`${baseUrl}/api/history?limit=5`)).json();
  assert.equal(list.ok, true);
  assert.ok(list.data.total > 0, '应有历史记录');
  assert.ok(list.data.items.length > 0);
  assert.ok(list.data.items[0].categories, '列表项应含三段占比');
  assert.ok(!list.data.items[0].segments, '列表项为控制体积不应含分段明细');

  const id = list.data.items[0].id;
  const detail = await (await fetch(`${baseUrl}/api/history/${encodeURIComponent(id)}`)).json();
  assert.equal(detail.ok, true);
  assert.equal(detail.data.id, id);
  assert.ok(Array.isArray(detail.data.segments), '明细应含逐段归属');

  const stats = await (await fetch(`${baseUrl}/api/history/stats`)).json();
  assert.equal(stats.ok, true);
  assert.ok(stats.data.count >= 1);
  assert.ok(stats.data.average);
  // 回归护栏：三段占比平均值必须是 0~100 的百分数，不能出现 10000 这类“乘了两次 100”的值
  const avg = stats.data.average;
  for (const k of ['human_percent', 'suspected_ai_percent', 'ai_percent']) {
    assert.ok(
      Number.isFinite(avg[k]) && avg[k] >= 0 && avg[k] <= 100,
      `平均三段占比 ${k} 应为 0~100，实际 ${avg[k]}`
    );
  }
  const segSum = avg.human_percent + avg.suspected_ai_percent + avg.ai_percent;
  assert.ok(Math.abs(segSum - 100) < 1, `平均三段占比应合计约 100%，实际 ${segSum}`);

  const csv = await fetch(`${baseUrl}/api/history/export?format=csv`);
  assert.equal(csv.status, 200);
  const csvText = await csv.text();
  assert.ok(csvText.startsWith('"id"'), 'CSV 应有表头');
  assert.ok(csvText.includes('ai_rate_percent'));

  const del = await (await fetch(`${baseUrl}/api/history/${encodeURIComponent(id)}`, { method: 'DELETE' })).json();
  assert.equal(del.ok, true);
  assert.equal(del.data.deleted, 1);

  const missing = await fetch(`${baseUrl}/api/history/does-not-exist`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'HISTORY_NOT_FOUND');
});

await testAsync('长文全文不截断（检测结果 / 历史明细 / buildFullText）', async () => {
  // 造一段明显超过旧上限（5000 字）的文本，尾部放唯一标记作为「必须能看到」的锚点
  const tail = '【锚点：全文最后一句话，任何截断都会丢失它】';
  const longText = ('人工智能技术正在深刻改变我们的生活方式。我昨天到菜市场买了些青菜，摊主多送了两根葱。'.repeat(140)) + tail;
  assert.ok(longText.length > 5000, `测试文本应超过 5000 字，实际 ${longText.length}`);

  clearCache();
  const res = await (
    await fetch(`${baseUrl}/api/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: longText, cache: false, source: 'web' }),
    })
  ).json();
  assert.equal(res.ok, true, '长文检测应成功');

  // ① 结果里的每一段都必须是该段的完整文本，不能带省略号
  for (const s of res.data.segments) {
    assert.equal(s.text, s.excerpt, 'segments[].text 与 excerpt 应同为完整文本');
    assert.ok(!String(s.excerpt).endsWith('…'), '分段文本不应被截断成省略号');
  }

  // ② 历史明细里必须存下完整原文
  const hid = res.data._meta.history_id;
  assert.ok(hid, '检测结果应带 history_id');
  const detail = await (await fetch(`${baseUrl}/api/history/${encodeURIComponent(hid)}`)).json();
  assert.equal(detail.ok, true);
  assert.equal(detail.data.chars, [...longText].length);
  assert.equal(detail.data.text, longText, '历史必须完整保存原文');
  assert.equal(detail.data.text_truncated, false, '默认不应标记为已截断');
  assert.ok(detail.data.text.includes('任何截断都会丢失它'), '历史原文应含尾部锚点');
  assert.ok(detail.data.segments.length > 0, '历史应保存分段明细');
  for (const s of detail.data.segments) {
    assert.ok(!String(s.excerpt).endsWith('…'), '历史里的分段文本同样不应截断');
  }

  // ③ buildFullText：拿到原文时应完整、且能给出各段区间
  const ft = buildFullText(res.data, longText);
  assert.equal(ft.complete, true);
  assert.equal(ft.text, longText);
  assert.ok(ft.spans.length > 0, '应解析出分段区间');
  assert.ok(ft.spans.every((sp) => sp.end <= longText.length), '区间不应越界');

  // ④ 只有分段、没有原文时，退化为拼接并明确标注 complete=false
  const ft2 = buildFullText({ segments: [{ text: '甲', label: 0, position: [0, 1] }, { text: '乙', label: 2, position: [1, 2] }] });
  assert.equal(ft2.complete, false);
  assert.equal(ft2.text, '甲\n乙');

  // ⑤ 显式设上限时才允许截断，并且仍保留首尾片段
  process.env.ZHUQUE_HISTORY_TEXT_MAX = '1000';
  try {
    const limited = appendHistory({
      text: 'x'.repeat(3000),
      ai_rate: 0,
      categories: {},
      segments: [],
    });
    assert.equal(limited.text, null, '设了上限后超长文本不应存全文');
    assert.equal(limited.text_truncated, true);
    assert.ok(limited.head && limited.tail, '截断时应保留首尾片段');
  } finally {
    delete process.env.ZHUQUE_HISTORY_TEXT_MAX;
  }

  // 清理这条测试记录，避免影响后续统计断言
  await fetch(`${baseUrl}/api/history/${encodeURIComponent(hid)}`, { method: 'DELETE' });
});

await testAsync('HTTP /api/keys：保存 Key 池 / 状态 / 停用 / 重置', async () => {
  const save = await (await fetch(`${baseUrl}/api/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_keys: [
      { id: 'k1', key: 'sk-pool-aaaaaaaa1111', label: '主号' },
      { id: 'k2', key: 'sk-pool-bbbbbbbb2222', label: '备用' },
    ] }),
  })).json();
  assert.equal(save.ok, true);
  assert.ok(!JSON.stringify(save.data).includes('sk-pool-aaaaaaaa1111'), '响应中不得出现明文 Key');

  const st = await (await fetch(`${baseUrl}/api/keys`)).json();
  assert.equal(st.ok, true);
  assert.equal(st.data.count, 2);
  assert.equal(st.data.available_count, 2);
  assert.ok(st.data.next_key);
  assert.ok(st.data.keys[0].masked.includes('...'));

  const off = await (await fetch(`${baseUrl}/api/keys/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'k1', enabled: false }),
  })).json();
  assert.equal(off.ok, true);
  assert.equal(off.data.pool.available_count, 1);

  const reset = await (await fetch(`${baseUrl}/api/keys/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  assert.equal(reset.ok, true);

  // 清理，避免影响后续「缺 Key」测试
  writeConfig({ clear: { api_keys: true } });
});

await testAsync('关闭服务', async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => upstream.close(r));
});

process.stdout.write('\n[5/6] MCP 协议\n');

/**
 * 起一个 MCP 子进程并打通 stdio。
 *
 * 两个必须注意的点（都踩过坑）：
 *  1) 路径必须用 fileURLToPath()，不能用 new URL(...).pathname ——
 *     后者是百分号编码的（空格 → %20、中文 → %E5%8F%A6…），
 *     文件夹名一旦含空格或中文，子进程就找不到文件。
 *     这正是"把包解压到「我的文档」里就跑不起来"的根因。
 *  2) exit 监听必须在 spawn 之后立刻挂上，不能等 stdin.end() 之后再挂，
 *     否则子进程若已退出，监听永远不会触发 → 顶层 await 悬空 → 卡死。
 */
async function spawnMcp(env = {}) {
  const { spawn } = await import('node:child_process');
  const entry = fileURLToPath(new URL('./mcp-server.mjs', import.meta.url));
  const child = spawn(process.execPath, [entry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });

  const lines = [];
  let stderr = '';
  child.stdout.on('data', (d) => lines.push(...d.toString().split('\n').filter(Boolean)));
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  // 立刻挂 exit，避免竞态
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', resolve);
  });
  // 写管道时若子进程已退出会 EPIPE，捕获掉不影响断言
  child.stdin.on('error', () => {});

  const send = (o) => {
    if (child.stdin.writable) child.stdin.write(JSON.stringify(o) + '\n');
  };
  const finish = async () => {
    await new Promise((r) => setTimeout(r, 100));
    try { child.stdin.end(); } catch { /* 已关闭 */ }
    await exited;
    return { msgs: lines.map((l) => JSON.parse(l)), stderr };
  };
  return { child, send, finish, path: entry };
}

// 直接构造 JSON-RPC 消息，走与 stdio 相同的处理逻辑
await testAsync('MCP tools/list 暴露检测工具 + WorkBuddy 客户端被放行', async () => {
  const mod = await import('./mcp-server.mjs');
  assert.ok(typeof mod.startMcpServer === 'function');
  const { send, finish, path: entry } = await spawnMcp({ ZHUQUE_MCP_CLIENT: '' });
  assert.ok(fs.existsSync(entry), `找不到 MCP 入口：${entry}`);

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'WorkBuddy', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_detection_history', arguments: { stats_only: true } } });
  await new Promise((r) => setTimeout(r, 800));
  const { msgs, stderr } = await finish();

  assert.ok(msgs.length, `MCP 子进程没有任何输出。stderr:\n${stderr}`);
  const init = msgs.find((m) => m.id === 1);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'zhuque-detect');
  assert.ok(init.result.capabilities.tools);

  const tools = msgs.find((m) => m.id === 2).result.tools;
  const names = tools.map((t) => t.name);
  assert.deepEqual(names, ['detect_ai_text', 'detect_ai_text_batch', 'get_detection_history', 'get_zhuque_usage', 'get_zhuque_service_info']);
  assert.ok(tools[0].inputSchema.properties.text);
  assert.ok(tools[0].description.includes('ai_rate'));
  assert.ok(tools[0].description.includes('categories'), '检测工具描述应提到三段占比');
  assert.ok(tools[2].description.includes('历史'), '历史工具应可用');

  const res = msgs.find((m) => m.id === 3).result.resources;
  assert.ok(res.some((r) => r.uri === 'zhuque://schema'));

  // WorkBuddy 在白名单内 → 历史工具应正常执行（不报 isError）
  const hist = msgs.find((m) => m.id === 4);
  assert.ok(hist && hist.result, '应返回结果');
});

await testAsync('MCP 白名单：非授权客户端被拒绝且不消耗额度', async () => {
  const { send, finish } = await spawnMcp();

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'SomeRandomClient', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'detect_ai_text', arguments: { text: 'x'.repeat(200) } } });
  await new Promise((r) => setTimeout(r, 700));
  const { msgs, stderr } = await finish();

  assert.ok(msgs.length, `MCP 子进程没有任何输出。stderr:\n${stderr}`);
  const call = msgs.find((m) => m.id === 2);
  assert.equal(call.result.isError, true, '非白名单客户端应被拒绝');
  assert.ok(call.result.content[0].text.includes('MCP_CLIENT_FORBIDDEN'), '应返回 MCP_CLIENT_FORBIDDEN');
});

process.stdout.write('\n[6/6] 跨平台可移植性\n');

await testAsync('isMainModule：能识别字面路径、符号链接路径与无关路径', async () => {
  const { isMainModule } = await import('./is-main.mjs');
  const selfHref = new URL('./is-main.mjs', import.meta.url).href;
  const selfPath = fileURLToPath(new URL('./is-main.mjs', import.meta.url));

  assert.equal(isMainModule(selfHref, selfPath), true, '字面绝对路径应判定为主模块');
  assert.equal(isMainModule(selfHref, '/somewhere/else/other.mjs'), false, '无关路径不应判定为主模块');
  assert.equal(isMainModule(selfHref, ''), false, '空 argv[1] 应返回 false');
  assert.equal(isMainModule(undefined, selfPath), false, '空 import.meta.url 应返回 false');
  assert.equal(isMainModule(selfHref, selfPath + '.bak'), false, '相似但不同的路径不应误判');
});

/**
 * 回归：曾经用 `path.resolve(argv[1]) === path.resolve(fileURLToPath(import.meta.url))`
 * 判定主模块，遇到符号链接会静默失败（什么都不输出、退出码 0）。
 * 这里真的建一个符号链接去跑 CLI，确保有正常输出。
 */
await testAsync('经符号链接调用 CLI 仍能正常执行（不再静默退出）', async () => {
  const { spawn } = await import('node:child_process');
  const srcDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.dirname(srcDir);

  const linkDir = path.join(TMP, 'linked');
  const link = path.join(linkDir, 'zhuque-link');
  try {
    fs.mkdirSync(linkDir, { recursive: true });
    fs.symlinkSync(root, link, 'dir');
  } catch (e) {
    // Windows 上创建符号链接需要开发者模式或管理员权限，跳过不算失败
    process.stdout.write(`  · 跳过（当前系统不允许创建符号链接：${e.code || e.message}）\n`);
    return;
  }

  const viaLink = path.join(link, 'src', 'cli.mjs');
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [viaLink, '--help'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ZHUQUE_CONFIG_FILE: path.join(TMP, 'config.json') },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.once('exit', (code) => resolve({ code, out, err }));
  });

  assert.equal(r.code, 0, `经符号链接运行应退出码 0，实际 ${r.code}；stderr:\n${r.err}`);
  assert.ok(r.out.includes('zhuque v'), `经符号链接运行应有正常输出，实际 ${r.out.length} 字节；stderr:\n${r.err}`);
  assert.ok(r.out.includes('用法'), '应打印出用法说明');
});

process.stdout.write(`\n${'─'.repeat(46)}\n通过 ${passed} · 失败 ${failed}\n\n`);
// 清理测试用临时目录
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* 忽略 */
}

process.exitCode = failed ? 1 : 0;
