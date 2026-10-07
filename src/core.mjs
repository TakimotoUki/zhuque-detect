/**
 * 朱雀 AIGC 文本检测 —— 核心库
 *
 * 通过腾讯云 EdgeOne Makers 内置模型 @makers/zhuque-text 调用朱雀检测能力。
 * 零第三方依赖，仅使用 Node 内置模块（支持 Node >= 22）。
 *
 * 设计目标：
 *   1. 面向人：结果可读，有明确结论与建议。
 *   2. 面向 AI Agent：输出结构稳定、字段语义自解释、错误码可编程处理、
 *      并附带"被判定为 AI 的原文片段 + 位置"，方便 agent 直接定位改写后复检。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_DIR,
  FIELDS,
  configPath,
  readConfig,
  applyConfigToEnv,
  isMcpClientAllowed,
  mcpRestrictClients,
  allowedMcpClients,
  // 密钥掩码全项目共用一套规则（免得三处实现各露不同位数）
  maskSecret as maskKey,
} from './config-store.mjs';
import { recordUsage, CHARS_PER_BILLING_UNIT } from './usage-store.mjs';
import { pickKey, noteSuccess, noteFailure, listKeys } from './key-pool.mjs';
import { appendHistory } from './history-store.mjs';

export const VERSION = '1.3.0';
export const SCHEMA_VERSION = '1.2';

const DEFAULT_ENDPOINT = 'https://ai-gateway.edgeone.link/v1/providers/zhuque-text/classify';

/** 上游地址（每次调用时解析，便于测试与自建网关场景覆盖） */
export function resolveEndpoint(explicit) {
  const value = explicit || process.env.ZHUQUE_ENDPOINT || readConfig().endpoint || DEFAULT_ENDPOINT;
  let u;
  try { u = new URL(value); } catch { throw new ZhuqueError('BAD_ENDPOINT', '接口地址不是合法 URL', '填写完整的 HTTPS 接口地址；仅本机测试可使用回环 HTTP。', 400); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.username || u.password || u.hash || (u.protocol !== 'https:' && !(local && u.protocol === 'http:'))) {
    throw new ZhuqueError('BAD_ENDPOINT', '远程接口必须使用 HTTPS，且 URL 不允许内嵌凭据或片段');
  }
  return u.href;
}

/** 单次请求最大字符数；超长文本会被自动分块（可用 max_chars 调整） */
const FALLBACK_MAX_CHARS = 20000;

function maxCharsOf(explicit) {
  const v = Number(explicit ?? process.env.ZHUQUE_MAX_CHARS ?? FALLBACK_MAX_CHARS);
  if (!Number.isSafeInteger(v) || v < 2 || v > FALLBACK_MAX_CHARS) throw new ZhuqueError('BAD_MAX_CHARS', '分块大小必须是 2~20000 的整数');
  return v;
}

/** 结果缓存有效期（毫秒）。每次读取，便于运行时改配置后立即生效。 */
function cacheTtlMs() {
  const v = Number(process.env.ZHUQUE_CACHE_TTL_MS ?? 10 * 60 * 1000);
  return Number.isFinite(v) && v >= 0 ? v : 10 * 60 * 1000;
}

/** 低于该长度时，模型置信度不可靠 */
export const MIN_RELIABLE_CHARS = 120;

export { CONFIG_DIR, configPath, applyConfigToEnv };

/** 朱雀三种标签的语义 */
export const LABELS = {
  0: { key: 'human', name_zh: '人工特征', name_en: 'human', desc: '人工写作特征明显' },
  1: { key: 'ai', name_zh: 'AI 特征', name_en: 'ai', desc: 'AI 生成特征明显' },
  2: { key: 'suspected_ai', name_zh: '疑似 AI', name_en: 'suspected_ai', desc: '介于人工与 AI 之间' },
};

/**
 * 朱雀官网的三项分类展示口径。
 * 段落与整体比例统一：0=人工、1=AI、2=疑似，
 * 展示顺序按官网：人工特征 → 疑似 AI → AI 特征。
 */
export const CATEGORIES = [
  { key: 'human', label: 0, name_zh: '人工特征', name_en: 'human' },
  { key: 'suspected_ai', label: 2, name_zh: '疑似 AI', name_en: 'suspected_ai' },
  { key: 'ai', label: 1, name_zh: 'AI 特征', name_en: 'ai' },
];

/** 结论分档：risk_score ∈ [0,1]，越大越像 AI */
export const VERDICTS = [
  { max: 0.15, key: 'human', name_zh: '人工', action_zh: '无需处理' },
  { max: 0.4, key: 'mostly_human', name_zh: '偏人工', action_zh: '少量 AI 痕迹，可局部润色' },
  { max: 0.65, key: 'mixed', name_zh: '人机混合', action_zh: '建议对被标记段落做人工改写' },
  { max: 0.85, key: 'likely_ai', name_zh: '疑似 AI 生成', action_zh: '建议整体改写后再复检' },
  { max: Infinity, key: 'ai', name_zh: 'AI 生成', action_zh: '建议整体重写后再复检' },
];

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

export class ZhuqueError extends Error {
  constructor(code, message, hint = '', status = 400, detail = null) {
    super(message);
    this.name = 'ZhuqueError';
    this.code = code;
    this.hint = hint;
    this.status = status;
    this.detail = detail;
  }
  toJSON() {
    return { code: this.code, message: this.message, hint: this.hint, detail: this.detail };
  }
}

// ---------------------------------------------------------------------------
// 密钥解析：调用参数 > 环境变量 > token.txt > ./.env > Key 池 > ~/.zhuque/config.json
// ---------------------------------------------------------------------------

const API_KEY_VARS = ['ZHUQUE_API_KEY', 'EDGEONE_MAKERS_API_KEY', 'EDGEONE_API_KEY'];

/** 项目根目录（src/ 的上一级） */
const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** token.txt 中允许的「KEY=VALUE」左侧变量名（大小写不敏感） */
const TOKEN_FILE_KEYS = [
  'ZHUQUE_API_KEY',
  'ZHUQUE_TOKEN',
  'EDGEONE_MAKERS_API_KEY',
  'EDGEONE_API_KEY',
  'API_KEY',
  'APIKEY',
  'TOKEN',
  'KEY',
];

/**
 * token.txt 的查找顺序：
 *   1. 环境变量 ZHUQUE_TOKEN_FILE 指定的路径（**只认这一个**，便于测试与多实例隔离）
 *   2. 项目根目录下的 token.txt
 *   3. 当前工作目录下的 token.txt
 */
export function tokenFilePaths() {
  const override = (process.env.ZHUQUE_TOKEN_FILE || '').trim();
  if (override) return [path.resolve(override)];
  return [
    path.join(PROJECT_ROOT, 'token.txt'),
    path.join(path.resolve(process.cwd()), 'token.txt'),
  ];
}

/** 实际生效的 token.txt 路径（不存在则返回 null） */
export function tokenFilePath() {
  for (const p of tokenFilePaths()) {
    try {
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {
      /* 忽略权限等问题，继续找下一个 */
    }
  }
  return null;
}

/**
 * 把 Buffer 解码成字符串。兼容 Windows 记事本可能写出的各种编码：
 * UTF-8（含/不含 BOM）、UTF-16LE、UTF-16BE。
 */
function decodeTextFile(buf) {
  if (!Buffer.isBuffer(buf)) return String(buf ?? '');
  // UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  // UTF-16LE BOM
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buf.subarray(2));
  }
  // UTF-16BE BOM：逐字节交换后按 utf-16le 解码，避免依赖完整 ICU
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = Buffer.from(buf.subarray(2));
    if (body.length % 2 !== 0) return body.toString('utf8');
    body.swap16();
    return new TextDecoder('utf-16le').decode(body);
  }
  return buf.toString('utf8');
}

/** 去掉首尾空白与成对引号，并剔除不可见字符（避免记事本混入的零宽字符） */
function cleanKeyValue(v) {
  let s = String(v ?? '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  // 去掉零宽字符与 BOM 残渣，保留常规可打印字符
  return s.replace(/[\u200b-\u200d\ufeff]/g, '').trim();
}

/**
 * 解析 token.txt 内容，取出 API Key。
 * 支持两种写法（每行一条，`#` / `//` 开头为注释）：
 *   ① 裸 Key：           sk-xxxxxxxx
 *   ② KEY=VALUE：        ZHUQUE_API_KEY=sk-xxxxxxxx
 * 只把左侧是已知变量名（TOKEN_FILE_KEYS）的行当作 ②，避免误切含 `=` 的 Key。
 */
export function parseTokenText(raw) {
  const text = decodeTextFile(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''), 'utf8'));
  for (const line0 of text.split(/\r?\n/)) {
    const line = line0.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && TOKEN_FILE_KEYS.includes(m[1].toUpperCase())) {
      const v = cleanKeyValue(m[2]);
      if (v) return v;
      continue;
    }
    const bare = cleanKeyValue(line);
    if (bare) return bare;
  }
  return '';
}

/** 读取 token.txt 里的 Key；没有文件或内容为空返回 '' */
export function readTokenFile() {
  const file = tokenFilePath();
  if (!file) return '';
  try {
    return parseTokenText(fs.readFileSync(file));
  } catch {
    return '';
  }
}

function parseDotEnv(dir) {
  const out = {};
  for (const name of ['.env', '.env.local']) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let value = m[2];
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[m[1]] = value;
    }
  }
  return out;
}

/** Non-key .env settings use the same explicit environment precedence. */
export function loadLocalSettings() {
  const local = { ...parseDotEnv(PROJECT_ROOT), ...parseDotEnv(process.cwd()) };
  for (const meta of Object.values(FIELDS)) {
    if (meta.env && !process.env[meta.env] && local[meta.env]) process.env[meta.env] = local[meta.env];
  }
}

// 对外沿用 maskKey 这个名字（cli / server / mcp 都在用）
export { maskKey };

/**
 * 解析本次调用应该用哪一把 Key —— **全项目唯一的密钥解析入口**。
 * `resolveApiKey` / `apiKeySource` 都基于它，保证「界面显示的那把 Key」与「真正拿去调用的那把」永远一致。
 *
 * 优先级：
 *   1. 显式传入（命令行 / 请求头 X-Zhuque-Api-Key）
 *   2. 环境变量（用户明确指定，不参与池轮换）
 *   3. token.txt（项目根 / 当前目录，可用 ZHUQUE_TOKEN_FILE 指定）
 *   4. .env / .env.local
 *   5. Key 池（轮询 + 自动跳过已耗尽/失效的）
 *   6. 配置文件里的单个 api_key
 *
 * @param {string} [explicit]
 * @param {{advance?:boolean}} [opts] advance=false 时不推进池的轮询游标（供纯展示场景使用）
 * @returns {{key:string|null, id:string|null, label:string|null, masked:string, source:string}}
 */
export function resolveKeyChoice(explicit, opts = {}) {
  if (explicit && String(explicit).trim()) {
    const k = String(explicit).trim();
    return { key: k, id: 'explicit', label: '调用方传入', masked: maskKey(k), source: 'explicit' };
  }
  for (const name of API_KEY_VARS) {
    const v = process.env[name];
    if (v && v.trim()) return { key: v.trim(), id: `env:${name}`, label: name, masked: maskKey(v.trim()), source: `env:${name}` };
  }
  const fromToken = readTokenFile();
  if (fromToken) {
    const file = tokenFilePath() || 'token.txt';
    return { key: fromToken, id: 'token.txt', label: 'token.txt', masked: maskKey(fromToken), source: `token:${file}` };
  }
  const dotenv = { ...parseDotEnv(PROJECT_ROOT), ...parseDotEnv(process.cwd()) };
  for (const name of API_KEY_VARS) {
    if (dotenv[name] && dotenv[name].trim()) {
      return { key: dotenv[name].trim(), id: `dotenv:${name}`, label: name, masked: maskKey(dotenv[name]), source: `dotenv:${name}` };
    }
  }

  const cfg = readConfig();
  // 只有在确实配置了 api_keys 数组时才走池轮询；
  // 否则「单个 api_key」应明确显示为配置文件来源，而不是被 key-pool 的降级逻辑包成 key_pool。
  const hasPool = Array.isArray(cfg.api_keys) && cfg.api_keys.length > 0;
  if (hasPool) {
    const picked = pickKey({ advance: opts.advance !== false });
    if (picked) {
      return { key: picked.entry.key, id: picked.entry.id, label: picked.entry.label, masked: picked.masked, source: 'key_pool' };
    }
    return { key: null, id: null, label: null, masked: '', source: 'key_pool_unavailable' };
  }
  const fromCfg = cfg.api_key || cfg.apiKey;
  if (fromCfg && String(fromCfg).trim()) {
    const k = String(fromCfg).trim();
    return { key: k, id: 'default', label: '默认 Key', masked: maskKey(k), source: 'config' };
  }
  return { key: null, id: null, label: null, masked: '', source: 'none' };
}

/**
 * 只取 Key 本身（展示与兜底调用用）。
 * 固定不推进池的轮询游标，避免「看一眼状态就把 Key 换到下一把」。
 */
export function resolveApiKey(explicit) {
  return resolveKeyChoice(explicit, { advance: false }).key;
}

/** 说明当前生效的 Key 来自哪里，供界面展示（同样不推进轮询游标） */
export function apiKeySource() {
  const { source } = resolveKeyChoice(null, { advance: false });
  // 配置文件里的单个 api_key 保留 file:<路径> 形式，界面可直接展示是哪个文件
  return source === 'config' ? `file:${configPath()}` : source;
}

// ---------------------------------------------------------------------------
// MCP 客户端白名单（仅允许白名单内的 AI Agent 调用本 MCP 服务）
// ---------------------------------------------------------------------------

/** 从 MCP initialize 的 clientInfo / 环境变量中提取调用方名称 */
function detectMcpClientName(params) {
  const info = params?.clientInfo || {};
  const candidates = [
    info.name,
    info.title,
    params?.client_name,
    process.env.ZHUQUE_MCP_CLIENT,
    process.env.MCP_CLIENT_NAME,
    process.env.CLAUDE_CLIENT_NAME,
  ];
  for (const c of candidates) {
    if (c && String(c).trim()) return String(c).trim();
  }
  return '';
}

/** 尽力从启动参数里推断客户端（workbuddy / codex 等自带标识的 CLI） */
function inferClientFromArgv() {
  const argv = process.argv.join(' ').toLowerCase();
  if (argv.includes('workbuddy')) return 'workbuddy';
  if (argv.includes('codex')) return 'codex';
  return '';
}

/**
 * 校验 MCP 调用方是否在白名单内。
 * @param {object} params MCP initialize 的 params（可省略）
 * @returns {{allowed:boolean, client:string, matched?:string, allowlist?:string[], reason?:string}}
 */
export function checkMcpClient(params) {
  if (!mcpRestrictClients()) {
    return { allowed: true, client: detectMcpClientName(params) || inferClientFromArgv() || 'unknown', restricted: false };
  }
  const client = detectMcpClientName(params) || inferClientFromArgv();
  const verdict = isMcpClientAllowed(client);
  return {
    allowed: verdict.allowed,
    client: client || '',
    matched: verdict.matched,
    allowlist: allowedMcpClients(),
    restricted: true,
    reason: verdict.allowed ? undefined : verdict.reason,
  };
}

const MISSING_KEY = () =>
  new ZhuqueError(
    'NO_API_KEY',
    '未配置朱雀 API Key，无法调用检测接口。',
    '五选一：① 打开网页界面点右上角「设置」填写并保存（可一次填多把 Key 组成 Key 池）；' +
      '② 设环境变量 ZHUQUE_API_KEY=xxx；' +
      `③ 在项目根目录建一个 token.txt，里面直接写 Key（或写 ZHUQUE_API_KEY=xxx 一行）；` +
      `④ 写入 ${configPath()} 的 {"api_key":"xxx"}；` +
      '⑤ 写入 {"api_keys":[{"key":"xxx","label":"主号"}]} 组成 Key 池。' +
      'Key 在 EdgeOne 控制台 Makers → Models → API Key 创建。',
    401
  );

/** 把 resolveKeyChoice 的 source 翻译成人话，用于报错时指明「该去看哪个文件」 */
const KEY_SOURCE_HINT = (source) => {
  const s = String(source || '');
  if (s === 'explicit') return '调用参数传入的 Key';
  if (s.startsWith('env:')) return `环境变量 ${s.slice(4)}`;
  if (s.startsWith('token:')) return `token.txt（${s.slice(6)}）`;
  if (s.startsWith('dotenv:')) return `.env 里的 ${s.slice(7)}`;
  if (s === 'key_pool') return 'Key 池';
  if (s === 'config') return `配置文件 ${configPath()}`;
  return '当前生效的 Key';
};

/**
 * 校验 Key 的字符集。
 *
 * 为什么必须提前拦：Node 的 fetch 在把 Header 值转成 ByteString 时，遇到非 ASCII
 * 或空白字符会抛出「Cannot convert argument to a ByteString ...」——这个报错和真实
 * 原因（Key 写错了）毫无关系，用户根本定位不到。
 * 最典型的触发场景：整包分发出去后，用户忘了把 token.txt 里的
 * 「sk-在这里粘贴你的Key」占位符换掉。
 *
 * @param {string} key
 * @param {string} source resolveKeyChoice 返回的 source
 */
function assertKeyUsable(key, source) {
  const bad = String(key).match(/[^\x21-\x7E]/);
  if (!bad) return;
  throw new ZhuqueError(
    'BAD_API_KEY',
    `API Key 含非法字符（${JSON.stringify(bad[0])}，第 ${bad.index + 1} 个字符），来自${KEY_SOURCE_HINT(source)}，` +
      '多半是占位符还没替换成真正的 Key。',
    'Key 必须是不含空格与中文的 ASCII 字符串（形如 sk-xxxxxxxx）。' +
      '请检查 token.txt / 环境变量 / 配置文件里的取值，删掉示例文字只留 Key 本身。',
    400
  );
}

/** 判断某个错误是否表示「这把 Key 该换了」 */
function keyFailureKind(err) {
  if (!(err instanceof ZhuqueError)) return null;
  if (err.status === 401 || err.status === 403) return { invalidate: true, code: err.code };
  if (err.status === 429) return { exhaust: true, code: err.code };
  // 上游把额度耗尽/限流包在 200 里时，用错误码兜底
  const msg = String(err.message || '');
  if (/quota|exhaust|limit|额度|用尽|限流/i.test(msg)) return { exhaust: true, code: err.code };
  return null;
}

// ---------------------------------------------------------------------------
// 原始调用
// ---------------------------------------------------------------------------

/**
 * 调用朱雀检测接口，返回原始响应 JSON。
 * @param {string} text 待检测文本
 * @param {{apiKey?:string,keySource?:string,isMerge?:boolean,timeoutMs?:number,endpoint?:string,signal?:AbortSignal}} [opts]
 */
export async function callZhuque(text, opts = {}) {
  // 未显式给 Key 时走唯一解析入口：池里的 Key 会被正常轮询推进
  let apiKey = opts.apiKey;
  let keySource = opts.keySource || 'explicit';
  if (!apiKey) {
    const choice = resolveKeyChoice(null);
    apiKey = choice.key;
    keySource = choice.source;
  }
  if (!apiKey) throw MISSING_KEY();
  assertKeyUsable(apiKey, keySource);

  const endpoint = resolveEndpoint(opts.endpoint);
  const timeoutMs = Number(opts.timeoutMs ?? process.env.ZHUQUE_TIMEOUT_MS ?? 60000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new ZhuqueError('BAD_TIMEOUT', '超时必须是 1~300000 毫秒的整数');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', abort, { once: true });
  }

  let res;
  let rawText;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': `zhuque-detect/${VERSION}`,
      },
      body: JSON.stringify({ text, is_merge: opts.isMerge !== false }),
      signal: controller.signal,
      redirect: 'error',
    });
    const reader = res.body?.getReader();
    const parts = [];
    let size = 0;
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new ZhuqueError('BAD_RESPONSE', '上游响应超过 8MB', '', 502); }
      parts.push(Buffer.from(value));
    }
    rawText = Buffer.concat(parts).toString('utf8');
  } catch (err) {
    if (err instanceof ZhuqueError) throw err;
    if (opts.signal?.aborted) throw new ZhuqueError('CANCELLED', '检测请求已取消', '', 499);
    if (err?.name === 'AbortError') {
      throw new ZhuqueError('TIMEOUT', `请求超时（${timeoutMs}ms）。`, '可调大 timeout_ms，或缩短文本分块检测。', 504);
    }
    throw new ZhuqueError(
      'NETWORK_ERROR',
      `无法连接朱雀接口：${err?.message || err}`,
      '检查网络/代理是否可达 ai-gateway.edgeone.link。',
      502
    );
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', abort);
  }

  // Error pages sometimes echo Authorization: never relay the actual key.
  rawText = rawText.split(apiKey).join('[REDACTED]');
  let json = null;
  try {
    json = rawText ? JSON.parse(rawText) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const msg = json?.msg || json?.error?.message || rawText.slice(0, 300) || res.statusText;
    const hint =
      res.status === 401
        ? 'API Key 无效或已过期，请到 EdgeOne 控制台重新创建。'
        : res.status === 429
          ? '触发限流或免费额度用尽，请稍后重试或申请提额。'
          : res.status === 403
            ? '该 Key 无权限调用 @makers/zhuque-text。'
            : '可稍后重试；若持续失败请核对 endpoint 与请求体。';
    throw new ZhuqueError(`HTTP_${res.status}`, `朱雀接口返回 ${res.status}：${msg}`, hint, res.status);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new ZhuqueError('BAD_RESPONSE', '朱雀接口返回了非 JSON 内容。', '请稍后重试。', 502, {
      preview: rawText.slice(0, 300),
    });
  }
  if (json.status && json.status !== 'success') {
    throw new ZhuqueError('API_ERROR', `朱雀返回 status=${json.status}：${json.msg || '未知错误'}`, '请稍后重试。', 502);
  }
  if (json.status !== 'success' || (!json.labels_ratio && !Array.isArray(json.segment_labels))) throw new ZhuqueError('BAD_RESPONSE', '上游响应缺少检测字段', '', 502);
  return json;
}

// ---------------------------------------------------------------------------
// 结果归一化
// ---------------------------------------------------------------------------

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round = (v, d = 4) => Number(Number(v).toFixed(d));
const clamp01 = (v) => Math.min(1, Math.max(0, v));

export function verdictOf(riskScore) {
  return VERDICTS.find((v) => riskScore < v.max) || VERDICTS[VERDICTS.length - 1];
}

/**
 * 把朱雀原始响应归一化为稳定结构。
 * @param {object} raw 朱雀响应
 * @param {{text?:string,isMerge?:boolean}} [ctx]
 */
export function normalize(raw, ctx = {}) {
  const text = typeof ctx.text === 'string' ? ctx.text : '';
  if (!raw || typeof raw !== 'object') throw new ZhuqueError('BAD_RESPONSE', '检测响应必须是对象', '', 502);
  const lr = raw.labels_ratio || {};
  if (raw.labels_ratio && (![0,1,2].every(k => typeof lr[k] === 'number' && Number.isFinite(lr[k]) && lr[k] >= 0 && lr[k] <= 1) || Math.abs(lr[0] + lr[1] + lr[2] - 1) > 0.02)) throw new ZhuqueError('BAD_RESPONSE', '上游分类占比无效', '', 502);
  if (!raw.labels_ratio && !raw.segment_labels?.length) throw new ZhuqueError('BAD_RESPONSE', '响应没有可用分类数据', '', 502);
  const humanRate = clamp01(num(lr['0']));
  // Tencent labels_ratio and live segment_labels use 1=AI, 2=suspected AI.
  const suspectedRate = clamp01(num(lr['2']));
  const aiRate = clamp01(num(lr['1']));

  // AI 率（主指标）：AI 特征 + 疑似 AI，两者都算「不是人写的」

  const aiProbability = clamp01(num(raw.softmax_confidence));
  const riskRate = clamp01(num(raw.ratio_confidence));

  // 结论：取「标签占比」与「模型置信度」中更警戒的一方，避免漏报


  const segments = Array.isArray(raw.segment_labels)
    ? raw.segment_labels.map((s, i) => {
      if (!s || typeof s !== 'object' || Array.isArray(s)) throw new ZhuqueError('BAD_RESPONSE', '上游段落数据格式无效', '', 502);
      const label = [0, 1, 2].includes(s.label) ? s.label : 2;
        const meta = LABELS[label] || LABELS[2];
        const p = s.position;
        const position = Array.isArray(p) && p.length === 2 && p.every(Number.isSafeInteger) && p[0] >= 0 && p[1] > p[0] ? [...p] : null;
        const full = typeof s.text === 'string' ? s.text : '';
        const start = position ? position[0] : null;
        const end = position ? position[1] : null;
        return {
          index: i + 1,
          order: Number.isSafeInteger(s.order) && s.order > 0 ? s.order : i + 1,
          label,
          label_key: meta.key,
          label_name: meta.name_zh,
          confidence: round(clamp01(num(s.conf)), 4),
          position,
          start,
          end,
          length: full.length,
          chars: full.length,
          // 该段的**完整**文本。这里刻意不做任何截断：
          // 网页的「检测全文」、历史详情、CLI 与 Agent 都靠它还原原文。
          text: full,
          excerpt: full,
          // 归属类别（用于前端按类着色 / agent 按类定位）
          category: meta.key,
        };
      })
    : [];

  const flaggedSegments = segments.filter((s) => s.label !== 0);

  const aiCharCount = flaggedSegments.reduce((n, s) => n + (s.length || 0), 0);

  // —— 三段占比（对齐朱雀官网：人工特征 / 疑似 AI / AI 特征）——
  // 优先使用官方整体 labels_ratio；仅无整体占比时按分段字符加权。
  const totalSegChars = segments.reduce((n, s) => n + (s.length || 0), 0);
  const categoryStats = buildCategories(segments, totalSegChars, { humanRate, suspectedRate, aiRate, hasRatios: Boolean(raw.labels_ratio) });
  const effectiveAi = clamp01(categoryStats.ai.ratio + categoryStats.suspected_ai.ratio);
  const effectiveRisk = clamp01(Math.max(effectiveAi, aiProbability));
  const effectiveVerdict = verdictOf(effectiveRisk);

  const warnings = [];
  if (text && text.length < MIN_RELIABLE_CHARS) {
    warnings.push({
      code: 'TEXT_TOO_SHORT',
      message: `文本仅 ${text.length} 字，低于 ${MIN_RELIABLE_CHARS} 字的建议下限，置信度不可靠。`,
      hint: '补足到 120 字以上再检测，结论更稳定。',
    });
  }
  if (segments.length > 0 && flaggedSegments.length === 0 && aiProbability > 0.5) {
    warnings.push({
      code: 'LABEL_CONFIDENCE_CONFLICT',
      message: '逐段标签全部为人工，但整体置信度偏高，存在分歧。',
      hint: '建议加长文本或改用 is_merge=false 复检。',
    });
  }

  return {
    ai_rate: round(effectiveAi),
    ai_rate_percent: round(effectiveAi * 100, 2),
    human_rate: categoryStats.human.ratio,
    human_rate_percent: categoryStats.human.percent,
    // 三段占比（官网口径），percent 为百分数
    categories: categoryStats,
    composition: {
      human: round(humanRate),
      ai: round(aiRate),
      suspected_ai: round(suspectedRate),
    },
    ai_probability: round(aiProbability),
    risk_rate: round(riskRate),
    risk_score: round(effectiveRisk),
    verdict: effectiveVerdict.key,
    verdict_name: effectiveVerdict.name_zh,
    advice: effectiveVerdict.action_zh,
    segment_count: segments.length,
    flagged_segment_count: flaggedSegments.length,
    ai_char_count: aiCharCount,
    total_segment_chars: totalSegChars,
    flagged_segments: flaggedSegments,
    segments,
    warnings,
  };
}

/**
 * 按逐段字符数统计三段占比；没有分段信息时退回 labels_ratio。
 * @returns {{human:object, suspected_ai:object, ai:object, basis:string}}
 */
function buildCategories(segments, totalChars, fallback) {
  const out = {
    human: { percent: 0, ratio: 0, chars: 0, segments: 0 },
    suspected_ai: { percent: 0, ratio: 0, chars: 0, segments: 0 },
    ai: { percent: 0, ratio: 0, chars: 0, segments: 0 },
  };
  const useSegments = !fallback.hasRatios && totalChars > 0 && segments.length > 0;

  if (useSegments) {
    for (const s of segments) {
      const key = s.category in out ? s.category : 'suspected_ai';
      out[key].chars += s.length || 0;
      out[key].segments += 1;
    }
    for (const k of Object.keys(out)) {
      const ratio = clamp01(out[k].chars / totalChars);
      out[k].ratio = round(ratio);
      out[k].percent = round(ratio * 100, 2);
    }
  } else {
    const map = { human: fallback.humanRate, suspected_ai: fallback.suspectedRate, ai: fallback.aiRate };
    const total = Object.values(map).reduce((n, v) => n + v, 0) || 1;
    for (const k of Object.keys(out)) {
      out[k].chars = segments.filter(s => s.category === k).reduce((n, s) => n + s.length, 0);
      out[k].segments = segments.filter(s => s.category === k).length;
      const ratio = clamp01((map[k] || 0) / total);
      out[k].ratio = round(ratio);
      out[k].percent = round(ratio * 100, 2);
    }
  }
  out.basis = useSegments ? 'segment_chars' : 'labels_ratio';
  return out;
}

// ---------------------------------------------------------------------------
// 结果缓存（省额度）
// ---------------------------------------------------------------------------

const CACHE_MAX = 200;
const cache = new Map(); // hash -> { at, payload }

function cacheKey(text, isMerge, scope) {
  return crypto.createHash('sha256').update(JSON.stringify([isMerge, text, scope])).digest('hex');
}

export function clearCache() {
  cache.clear();
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > cacheTtlMs()) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, hit); // LRU 触达
  return hit.payload;
}

function cacheSet(key, payload) {
  cache.set(key, { at: Date.now(), payload });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// ---------------------------------------------------------------------------
// 分块
// ---------------------------------------------------------------------------

/** 按空行切段，再聚合为 <= maxChars 的块，尽量不破坏段落 */
export function chunkText(text, maxChars = maxCharsOf()) {
  maxChars = maxCharsOf(maxChars);
  if (text.length <= maxChars) return [text];
  const paras = text.split(/(\n\s*\n)/); // 保留分隔符
  const chunks = [];
  let cur = '';
  for (const p of paras) {
    if (cur.length + p.length > maxChars && cur.length > 0) {
      chunks.push(cur);
      cur = '';
    }
    if (p.length > maxChars) {
      // 单段就超长，硬切
      for (let i = 0; i < p.length;) {
        let end = Math.min(p.length, i + maxChars);
        // Never cut between UTF-16 surrogate halves (emoji / rare Han).
        if (end < p.length && /[\uD800-\uDBFF]/.test(p[end - 1]) && /[\uDC00-\uDFFF]/.test(p[end])) end -= 1;
        chunks.push(p.slice(i, end));
        i = end;
      }
      continue;
    }
    cur += p;
  }
  if (cur.length) chunks.push(cur);
  return chunks.length ? chunks : [text];
}

/** 字符数加权聚合多个分块结果 */
function aggregate(results) {
  const usable = results.filter((r) => r && r.analysis);
  if (!usable.length) return null;
  if (usable.length === 1) return usable[0].analysis;

  let totalChars = 0;

  let probWeighted = 0;
  let riskWeighted = 0;

  const flagged = [];
  const allSegments = [];
  const warnings = [];
  const catChars = { human: 0, suspected_ai: 0, ai: 0 };
  const catSegs = { human: 0, suspected_ai: 0, ai: 0 };
  const catWeighted = { human: 0, suspected_ai: 0, ai: 0 };
  let allHaveSegments = true;
  let offset = 0;

  for (const r of usable) {
    const chars = Math.max(1, (r.text || '').length);
    totalChars += chars;

    probWeighted += r.analysis.ai_probability * chars;
    riskWeighted += r.analysis.risk_rate * chars;


    allHaveSegments &&= r.analysis.categories?.basis === 'segment_chars';
    for (const k of Object.keys(catChars)) {
      catWeighted[k] += (r.analysis.categories?.[k]?.ratio ?? 0) * chars;
      catChars[k] += r.analysis.categories?.[k]?.chars ?? 0;
      catSegs[k] += r.analysis.categories?.[k]?.segments ?? 0;
    }

    for (const s of r.analysis.flagged_segments) {
      flagged.push({
        ...s,
        chunk_index: r.index,
        global_position: s.position ? [s.position[0] + offset, s.position[1] + offset] : null,
      });
    }
    for (const s of r.analysis.segments) {
      allSegments.push({
        ...s,
        chunk_index: r.index,
        global_position: s.position ? [s.position[0] + offset, s.position[1] + offset] : null,
      });
    }
    warnings.push(...r.analysis.warnings);
    offset += chars;
  }

  let aiRate;
  const aiProbability = clamp01(probWeighted / totalChars);
  // 三段占比：分块时按各块字符数累加
  const segCharTotal = catChars.human + catChars.suspected_ai + catChars.ai;
  let categories;
  categories = { basis: allHaveSegments && segCharTotal > 0 ? 'segment_chars' : 'labels_ratio' };
  for (const k of Object.keys(catChars)) {
    const ratio = clamp01(categories.basis === 'segment_chars' ? catChars[k] / segCharTotal : catWeighted[k] / totalChars);
    categories[k] = { percent: round(ratio * 100, 2), ratio: round(ratio), chars: catChars[k], segments: catSegs[k] };
  }

  const humanRate = categories.human.ratio;
  aiRate = clamp01(categories.ai.ratio + categories.suspected_ai.ratio);
  const riskScore = clamp01(Math.max(aiRate, aiProbability));
  const verdict = verdictOf(riskScore);

  return {
    ...usable[0].analysis,
    ai_rate: round(aiRate),
    ai_rate_percent: round(aiRate * 100, 2),
    human_rate: round(humanRate),
    human_rate_percent: round(humanRate * 100, 2),
    categories,
    composition: {
      human: round(humanRate),
      ai: categories.ai.ratio,
      suspected_ai: categories.suspected_ai.ratio,
    },
    ai_probability: round(aiProbability),
    risk_rate: round(clamp01(riskWeighted / totalChars)),
    risk_score: round(riskScore),
    verdict: verdict.key,
    verdict_name: verdict.name_zh,
    advice: verdict.action_zh,
    segment_count: allSegments.length,
    flagged_segment_count: flagged.length,
    ai_char_count: flagged.reduce((n, s) => n + (s.length || 0), 0),
    total_segment_chars: allSegments.reduce((n, s) => n + (s.length || 0), 0),
    flagged_segments: flagged,
    segments: allSegments,
    warnings: dedupeWarnings(warnings),
  };
}

function dedupeWarnings(list) {
  const seen = new Set();
  return list.filter((w) => (seen.has(w.code) ? false : (seen.add(w.code), true)));
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 检测文本 AI 率。
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string}  [opts.apiKey]      覆盖 API Key（不参与池轮换）
 * @param {boolean} [opts.isMerge=true] 是否合并段落
 * @param {boolean} [opts.cache=true]   是否使用结果缓存
 * @param {boolean} [opts.autoChunk=true] 超长文本是否自动分块
 * @param {number}  [opts.maxChars]    单块最大字符数
 * @param {number}  [opts.timeoutMs]
 * @param {string}  [opts.endpoint]
 * @param {string}  [opts.source]      结果来源标记：web | api | cli | mcp | batch
 * @param {boolean} [opts.history=true] 是否写入检测历史
 * @returns {Promise<object>} 归一化结果（含 _meta）
 */
export async function detect(text, opts = {}) {
  loadLocalSettings();
  const t0 = Date.now();
  if (typeof text !== 'string' || !text.trim()) {
    throw new ZhuqueError('EMPTY_TEXT', '待检测文本为空。', '请传入非空字符串，建议 120 字以上。', 400);
  }

  const isMerge = opts.isMerge !== false;
  const useCache = opts.cache !== false;
  const autoChunk = opts.autoChunk !== false;
  const maxChars = maxCharsOf(opts.maxChars);
  const timeout = Number(opts.timeoutMs ?? process.env.ZHUQUE_TIMEOUT_MS ?? 60000);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300000) throw new ZhuqueError('BAD_TIMEOUT', '超时必须是 1~300000 毫秒的整数');
  if (text.length > 1000000) throw new ZhuqueError('TEXT_TOO_LONG', '单篇文本最多 100 万个 UTF-16 代码单元', '', 413);
  if (!autoChunk && text.length > maxChars) throw new ZhuqueError('TEXT_TOO_LONG', '文本超过单块上限', '', 413);
  const previewChoice = resolveKeyChoice(opts.apiKey, { advance: false });
  if (!previewChoice.key) throw MISSING_KEY();
  const endpoint = resolveEndpoint(opts.endpoint);
  const scope = previewChoice.source === 'key_pool' ? listKeys().map(k => [k.id, k.key, k.enabled]) : previewChoice.key;
  const key = cacheKey(text, isMerge, [endpoint, scope, maxChars, autoChunk, opts.includeRaw === true]);

  if (useCache) {
    const hit = cacheGet(key);
    if (hit) {
      const out = structuredClone(hit);
      delete out._meta.history_id;
      Object.assign(out._meta, { cache_hit: true, duration_ms: Date.now() - t0, detected_at: new Date().toISOString(), usage: { zhuque_total_tokens: 0, makers_billed_tokens: 0 } });
      if (opts.history !== false) {
        try {
          const rec = appendHistory({ ...out, ...out._meta, text, source: opts.source || 'unknown', key_id: out._meta.key?.id, key_label: out._meta.key?.label, key_masked: out._meta.key?.masked });
          if (rec) out._meta.history_id = rec.id;
        } catch {
          out.warnings.push({ code: 'HISTORY_WRITE_FAILED', message: '检测成功，但本地历史未能保存；检查磁盘权限或遗留存储锁。' });
        }
      }
      return out;
    }
  }

  const chunks = autoChunk ? chunkText(text, maxChars) : [text];
  // —— 选 Key：显式 / 环境变量 优先，否则走 Key 池轮换 ——
  const firstChoice = resolveKeyChoice(opts.apiKey);
  if (!firstChoice.key) throw MISSING_KEY();

  const rotatable = firstChoice.source === 'key_pool';
  const results = [];
  let usageTotal = 0;
  let usageMakers = 0;
  let usedChoice = firstChoice;
  const keyAttempts = [];
  const storageWarnings = [];
  const storageWarning = code => { if (!storageWarnings.some(w => w.code === code)) storageWarnings.push({ code, message: '检测调用已完成，但本地历史、用量或 Key 状态未能保存；本地统计可能不完整，请检查磁盘权限或遗留锁并核对控制台。' }); };
  for (let i = 0; i < chunks.length; i += 1) {
    const tried = new Set();
    for (;;) {
      tried.add(usedChoice.id);
      try {
        const raw = await callZhuque(chunks[i], { ...opts, endpoint, apiKey: usedChoice.key, keySource: usedChoice.source, isMerge });
        const tokens = num(raw.makers_models_usage?.total_tokens);
        usageTotal += num(raw.usage?.total_tokens);
        usageMakers += tokens;
        results.push({ index: i + 1, text: chunks[i], raw, analysis: normalize(raw, { text: chunks[i], isMerge }) });
        keyAttempts.push({ key_id: usedChoice.id, label: usedChoice.label, masked: usedChoice.masked, ok: true, billed_tokens: tokens, chunk_index: i + 1 });
        // Account immediately: earlier successful chunks still cost tokens if a
        // later chunk fails. Successful chunks are never sent a second time.
        if (opts.record !== false) try { recordUsage({ billed: tokens, zhuque: num(raw.usage?.total_tokens), chars: chunks[i].length, calls: 1, key_mask: usedChoice.masked }); } catch { storageWarning('USAGE_WRITE_FAILED'); }
        if (rotatable) try { noteSuccess(usedChoice.id, tokens); } catch { storageWarning('KEY_STATE_WRITE_FAILED'); }
        break;
      } catch (err) {
        const kind = keyFailureKind(err);
        keyAttempts.push({ key_id: usedChoice.id, masked: usedChoice.masked, ok: false, error: err.code, chunk_index: i + 1 });
        if (!rotatable || !kind) throw err;
        try { noteFailure(usedChoice.id, { code: err.code, message: err.message, ...kind }); } catch { storageWarning('KEY_STATE_WRITE_FAILED'); }
        const picked = pickKey({ exclude: tried });
        if (!picked) throw err;
        usedChoice = { ...picked.entry, masked: picked.masked, source: 'key_pool' };
      }
    }
  }

  const analysis = aggregate(results) || normalize(results[0].raw, { text: results[0].text, isMerge });

  const billingUnits = chunks.reduce((n, c) => n + Math.max(1, Math.ceil(c.length / CHARS_PER_BILLING_UNIT)), 0);
  const payload = {
    ...analysis,
    _meta: {
      schema_version: SCHEMA_VERSION,
      detector: 'tencent-zhuque-text',
      endpoint: resolveEndpoint(opts.endpoint),
      input_chars: text.length,
      is_merge: isMerge,
      chunked: chunks.length > 1,
      chunk_count: chunks.length,
      billing_units: billingUnits,
      usage: { zhuque_total_tokens: usageTotal, makers_billed_tokens: usageMakers },
      key: {
        id: usedChoice.id,
        label: usedChoice.label,
        masked: usedChoice.masked,
        source: usedChoice.source,
      },
      key_attempts: keyAttempts,
      failover: new Set(keyAttempts.map(a => a.key_id)).size > 1,
      cache_hit: false,
      duration_ms: Date.now() - t0,
      detected_at: new Date().toISOString(),
      version: VERSION,
    },
    _raw: opts.includeRaw
      ? chunks.length === 1
        ? results[0].raw
        : results.map((r) => ({ chunk_index: r.index, raw: r.raw }))
      : undefined,
  };
  if (payload._raw === undefined) delete payload._raw;
  payload.warnings.push(...storageWarnings);

  if (useCache) cacheSet(key, structuredClone(payload));

  // 写检测历史（含逐段归属与三段占比），供回溯与「改完再测」对比
  if (opts.history !== false) {
    try {
      const rec = appendHistory({
        text,
        source: opts.source || 'unknown',
        is_merge: isMerge,
        chunked: chunks.length > 1,
        chunk_count: chunks.length,
        ai_rate: payload.ai_rate,
        human_rate: payload.human_rate,
        ai_probability: payload.ai_probability,
        risk_score: payload.risk_score,
        verdict: payload.verdict,
        verdict_name: payload.verdict_name,
        categories: payload.categories,
        segment_count: payload.segment_count,
        flagged_segment_count: payload.flagged_segment_count,
        segments: payload.segments,
        usage: payload._meta.usage,
        key_id: payload._meta.key.id,
        key_label: payload._meta.key.label,
        key_masked: payload._meta.key.masked,
        duration_ms: payload._meta.duration_ms,
      });
      if (rec) payload._meta.history_id = rec.id;
    } catch {
      payload.warnings.push({ code: 'HISTORY_WRITE_FAILED', message: '检测成功，但本地历史未能保存；检查磁盘权限或遗留存储锁。' });
    }
  }

  return payload;
}

/** 批量检测 */
export async function detectBatch(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) throw new ZhuqueError('EMPTY_BATCH', '批量列表为空。', '传入 items: [{ id?, text }]。', 400);
  if (list.length > 50) throw new ZhuqueError('BATCH_TOO_LARGE', '单次批量最多 50 条。', '请分批调用。', 413);

  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    const id = item?.id ?? i + 1;
    try {
      const data = await detect(typeof item === 'string' ? item : String(item?.text ?? ''), {
        ...opts,
        source: opts.source || 'batch',
      });
      out.push({ id, ok: true, data, error: null });
    } catch (err) {
      out.push({
        id,
        ok: false,
        data: null,
        error: err instanceof ZhuqueError ? err.toJSON() : { code: 'UNKNOWN', message: String(err?.message || err), hint: '' },
      });
    }
  }
  return {
    // 注意：这里不用 ok 字段，避免与外层响应信封的 ok 语义混淆
    all_succeeded: out.every((o) => o.ok),
    count: out.length,
    succeeded: out.filter((o) => o.ok).length,
    failed: out.filter((o) => !o.ok).length,
    results: out,
    _meta: { schema_version: SCHEMA_VERSION, detected_at: new Date().toISOString(), version: VERSION },
  };
}

// ---------------------------------------------------------------------------
// 面向人的可读渲染
// ---------------------------------------------------------------------------

const pct = (v) => `${(v * 100).toFixed(2)}%`;

/**
 * 由检测结果还原「检测全文」+ 每段在全文中的区间。
 *
 * 关键点：**原文必须由调用方传入**。上游在 `is_merge: true`（默认）时只会返回
 * 一个覆盖整体的粗粒度段，各段文本拼起来并不等于原文（会丢掉段间未被标注的部分）。
 * 所以这里优先用 `explicitText`，其次用结果里自带的 `result.text`（历史记录会有），
 * 只有在两者都没有时才退化为「把各段文本按顺序拼起来」，并把 `complete` 标为 false。
 *
 * @param {{text?:string, segments?:Array, flagged_segments?:Array}} result
 * @param {string} [explicitText] 调用方手里的原文（最权威）
 * @returns {{text:string, complete:boolean, spans:Array<{start:number,end:number,label:number,label_name:string,label_key:string,confidence:number}>}|null}
 */
export function buildFullText(result = {}, explicitText) {
  const raw =
    (typeof explicitText === 'string' && explicitText) ||
    (typeof result.text === 'string' && result.text) ||
    '';
  const segs = Array.isArray(result.segments) && result.segments.length
    ? result.segments
    : Array.isArray(result.flagged_segments)
      ? result.flagged_segments
      : [];

  const spans = [];
  for (const s of segs) {
    const p = s.global_position || s.position;
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    if (p[1] <= p[0]) continue;
    spans.push({
      start: Math.max(0, p[0]),
      end: Math.max(0, p[1]),
      label: s.label ?? 1,
      label_name: s.label_name || '',
      label_key: s.category || s.label_key || '',
      confidence: s.confidence ?? 0,
    });
  }
  spans.sort((a, b) => a.start - b.start);

  if (raw) return { text: raw, complete: true, spans };

  const joined = segs.map((s) => s.text || s.excerpt || '').filter(Boolean).join('\n');
  return joined ? { text: joined, complete: false, spans: [] } : null;
}

/** 三档标签对应的终端颜色码（0=人工 绿 / 1=疑似 AI 黄 / 2=AI 特征 红） */
export const labelColor = (label) => (label === 0 ? '32' : label === 2 ? '33' : '31');

export function renderText(result, { color = true, full = true, text, segmentLimit = 40 } = {}) {
  const c = (code, s) => (color ? `\u001b[${code}m${s}\u001b[0m` : s);
  const verdictColor =
    result.verdict === 'human'
      ? '32'
      : result.verdict === 'mostly_human'
        ? '36'
        : result.verdict === 'mixed'
          ? '33'
          : '31';

  const lines = [];
  lines.push(c('1', '朱雀 AIGC 文本检测结果'));
  lines.push('─'.repeat(44));
  lines.push(`结论        ${c('1;' + verdictColor, result.verdict_name)}   (${result.verdict})`);
  lines.push(`AI 率       ${c(verdictColor, pct(result.ai_rate))}   ${c('2', '← 被判定为 AI/疑似 AI 的占比')}`);
  lines.push(`人工率      ${pct(result.human_rate)}`);
  lines.push(`AI 置信度   ${pct(result.ai_probability)}   ${c('2', '← 模型给出 AI 风险的整体置信度')}`);
  lines.push(`风险占比    ${pct(result.risk_rate)}`);
  lines.push(`综合风险分  ${pct(result.risk_score)}`);
  if (result.categories) {
    lines.push(
      `三段占比    ${c('32', `人工特征 ${result.categories.human.percent}%`)} | ` +
        `${c('33', `疑似 AI ${result.categories.suspected_ai.percent}%`)} | ` +
        `${c('31', `AI 特征 ${result.categories.ai.percent}%`)}`
    );
  }
  lines.push(`分段        ${result.segment_count} 段，其中 ${result.flagged_segment_count} 段被判为 AI`);
  lines.push(`建议        ${result.advice}`);
  if (result.warnings?.length) {
    lines.push('');
    for (const w of result.warnings) lines.push(c('33', `⚠ ${w.message}`) + (w.hint ? `  ${c('2', w.hint)}` : ''));
  }
  if (result.segments?.length || result.flagged_segments?.length) {
    const segs = result.segments?.length ? result.segments : result.flagged_segments;
    const isIndex = Boolean(result.segments?.length);
    lines.push('');
    lines.push(c('1', isIndex ? '逐段归属（可直接定位改写）：' : '被标记的片段（可直接定位改写）：'));
    const limit = full ? segmentLimit : Math.min(segmentLimit, 10);
    const shown = segs.slice(0, limit);
    for (const s of shown) {
      const pos = s.position ? `[${s.position[0]},${s.position[1]}]` : '';
      lines.push(`  #${s.order} ${c(labelColor(s.label), s.label_name)} conf=${s.confidence} ${c('2', pos)}`);
      // full 模式下正文统一在下面「检测全文」里完整给出，这里不再重复贴一遍
      if (!full) lines.push(`     ${c('2', (s.text || s.excerpt || '').replace(/\n/g, ' '))}`);
    }
    if (segs.length > shown.length) {
      lines.push(c('2', `  … 另有 ${segs.length - shown.length} 段，详见 --json 输出`));
    }
  }

  if (full) {
    const ft = buildFullText(result, text);
    if (ft) {
      lines.push('');
      lines.push(c('1', '检测全文（按段标注，未做任何截断）：'));
      lines.push('─'.repeat(44));
      if (!ft.complete) {
        lines.push(c('33', '⚠ 拿不到原文，以下内容由各段文本拼接而成，段间空白可能与原文不同。'));
      }
      if (ft.spans.length) {
        let cursor = 0;
        for (const sp of ft.spans) {
          if (sp.start > cursor) lines.push(ft.text.slice(cursor, sp.start));
          const body = ft.text.slice(Math.max(cursor, sp.start), sp.end);
          if (!body) continue;
          lines.push(c(labelColor(sp.label), `【${sp.label_name}】`) + body);
          cursor = Math.max(cursor, sp.end);
        }
        // 段区间没覆盖到的尾部同样要完整给出，绝不省略
        if (cursor < ft.text.length) lines.push(ft.text.slice(cursor));
      } else {
        lines.push(ft.text);
      }
    }
  }

  lines.push('');
  const keyInfo = result._meta.key ? ` · Key ${result._meta.key.masked}${result._meta.failover ? `（已自动切换 ${result._meta.key_attempts.length - 1} 次）` : ''}` : '';
  lines.push(
    c(
      '2',
      `耗时 ${result._meta.duration_ms}ms · 计费 token ${result._meta.usage.makers_billed_tokens} · 计费单元 ${result._meta.billing_units ?? '-'} · ${result._meta.chunked ? `${result._meta.chunk_count} 块` : '单次请求'}${keyInfo}`
    )
  );
  return lines.join('\n');
}
