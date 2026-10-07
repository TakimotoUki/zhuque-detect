#!/usr/bin/env node
/**
 * zhuque-detect HTTP 服务
 *
 * 同时服务两类调用方：
 *   - 人类：GET /  提供可视化检测网页
 *   - Agent：POST /api/detect、POST /api/batch、GET /api/schema、GET /llms.txt
 *
 * 设计原则：所有响应都是稳定的 JSON 信封 { ok, schema_version, data, error }，
 * 错误带可编程处理的 code 与 hint。
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { isIP } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-main.mjs';
import { detect, detectBatch, ZhuqueError, resolveApiKey, maskKey, apiKeySource, resolveEndpoint, VERSION, SCHEMA_VERSION, clearCache, applyConfigToEnv, loadLocalSettings } from './core.mjs';
import { readConfig, writeConfig, describeConfig, ConfigError, configPath, FIELDS, maskSecret, allowedMcpClients, mcpRestrictClients } from './config-store.mjs';
import { usageSummary, calibrate, clearCalibration, setQuota, resetUsage, CHARS_PER_BILLING_UNIT } from './usage-store.mjs';
import { buildSchemaDoc, buildLlmsTxt } from './schema.mjs';
import { listHistory, getHistory, deleteHistory, clearHistory, historyStats, exportHistory, historyPath } from './history-store.mjs';
import { poolStatus, resetAllKeyState, setKeyEnabled, keyStatePath } from './key-pool.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const MAX_BODY_BYTES = 4 * 1024 * 1024;

const STARTED_AT = new Date().toISOString();
/** 当前进程实际使用的监听参数，供 /api/config 回显 */
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function envelope(data, id = null) {
  return { ok: true, schema_version: SCHEMA_VERSION, id, data, error: null };
}
function errorEnvelope(err) {
  const e = err instanceof ZhuqueError
    ? err
    : new ZhuqueError('INTERNAL', String(err?.message || err), '服务端内部错误，请查看服务日志。', 500);
  return { ok: false, schema_version: SCHEMA_VERSION, id: null, data: null, error: e.toJSON() };
}

// ---------------------------------------------------------------------------
// 来源校验：本服务是「本机工具」，没有理由接受「你正在浏览的其它网页」发来的请求。
// 收敛 CORS 与拒绝跨站，正是为了掐断「任意网页借你的浏览器偷读历史、偷用 Key、
// 改 endpoint 把 Key 转发出去」这一类攻击链。
// ---------------------------------------------------------------------------

function isLoopbackHostname(name) {
  const h = String(name || '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

/** 额外放行的跨站来源（allowed_origins 配置 / ZHUQUE_ALLOWED_ORIGINS，逗号分隔） */
function allowedOrigins() {
  return String(process.env.ZHUQUE_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/\/$/, ''))
    .filter(Boolean);
}

function isAllowedOrigin(origin, req) {
  const o = String(origin || '').trim().toLowerCase().replace(/\/$/, '');
  if (!o) return false;
  try {
    const u = new URL(o);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (isLoopbackHostname(u.hostname) && Number(u.port || (u.protocol === 'https:' ? 443 : 80)) === req.socket.localPort) return true;
  } catch {
    return false;
  }
  return allowedOrigins().includes(o);
}

/** 只对「本机 / 显式放行」的来源回显 CORS 头，不再无脑 `*` */
function corsHeadersFor(req) {
  const origin = req.headers.origin;
  if (!origin || !isAllowedOrigin(origin, req)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Zhuque-Api-Key',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
  };
}

/** 命令行 / Agent / MCP 客户端不携带这些头，正常放行 */
function assertSameSite(req) {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site === 'cross-site' && !allowedOrigins().includes(String(req.headers.origin || '').toLowerCase())) {
    throw new ZhuqueError(
      'CROSS_SITE_FORBIDDEN',
      '拒绝来自其它网站的跨站请求。',
      '本服务是本机工具；确需跨站访问时，请把来源加入 allowed_origins 配置。',
      403
    );
  }
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin, req)) {
    throw new ZhuqueError(
      'ORIGIN_FORBIDDEN',
      `拒绝来源 ${origin} 的请求。`,
      '本服务是本机工具；确需跨站访问时，请把该来源加入 allowed_origins 配置。',
      403
    );
  }
}

/** Local exemptions require both a loopback listener and a loopback peer.
 * Host / Forwarded / X-Forwarded-For are user-controlled and never establish identity.
 */
function isLoopbackRequest(req) {
  const address = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return isLoopbackHostname(req.__serverOptions.host) &&
    isLoopbackHostname(address) && isLoopbackHostname(hostNameOf(req));
}

/** 取请求 Host 里的主机名（去掉端口与 IPv6 方括号） */
function hostNameOf(req) {
  try { return new URL(`http://${req.headers.host || ''}`).hostname; } catch { return ''; }
}

/**
 * Host 头校验 —— 防 DNS 重绑定（rebinding）。
 *
 * 为什么非做不可：攻击者可以让 evil.com 先解析到自己的服务器、再改成 127.0.0.1，
 * 于是受害者浏览器里的 evil.com 页面就能打到本机服务。这时浏览器发出的请求：
 *   · `Origin` 只有非简单请求才带 —— GET 请求压根没有；
 *   · `Sec-Fetch-Site` 是 same-origin（在浏览器看来确实是同源）。
 * 两道来源校验都察觉不到，只能靠 Host 头识别：此时 Host 会是 evil.com 而非回环地址。
 *
 * 只在「服务本身绑定在回环地址」时强制：用户显式绑 0.0.0.0 时本来就是给局域网用的，
 * 不能把 Host 卡成回环。需要在反向代理/自定义域名下访问时，把该来源写进
 * allowed_origins（ZHUQUE_ALLOWED_ORIGINS）即可放行。
 */
function assertHostAllowed(req, token = '') {
  if (!isLoopbackHostname(req.__serverOptions.host)) return; // 显式绑定非回环，用户自担
  const host = hostNameOf(req);
  if (isLoopbackHostname(host)) return;
  // 放行显式配置过的主机名（allowed_origins 只比主机名，忽略端口与协议）
  const ok = allowedOrigins().some((o) => {
    try {
      return new URL(o).hostname === host.toLowerCase();
    } catch {
      return false;
    }
  });
  if (ok) return;
  // 带了有效访问令牌的请求（反向代理 / 自定义域名 + 令牌场景）不受 Host 限制
  if (token && tokenMatches(req, token)) return;
  throw new ZhuqueError(
    'HOST_FORBIDDEN',
    `拒绝 Host 为「${host || '(空)'}」的请求。`,
    '本服务绑定在本机回环地址，只接受 127.0.0.1 / localhost / [::1] 访问（用于防御 DNS 重绑定攻击）。' +
      '若确实要通过域名或局域网地址访问，请把该来源加入 allowed_origins 配置。',
    403
  );
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...securityHeaders,
    ...(res.__cors || {}),
    ...headers,
  });
  res.end(payload);
}

async function readBody(req) {
  const ctype = String(req.headers['content-type'] || '').toLowerCase();
  // 明确声明了非 JSON 类型时直接拒绝（挡住 form / text-plain 这类简单请求走私）
  if (ctype && !ctype.includes('json')) {
    throw new ZhuqueError('UNSUPPORTED_MEDIA_TYPE', `请求体类型不支持：${ctype}`, '请使用 Content-Type: application/json。', 415);
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY_BYTES) throw new ZhuqueError('BODY_TOO_LARGE', '请求体过大（>4MB）。', '请拆分后分批调用。', 413);
    chunks.push(c);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('JSON 必须是对象');
    return body;
  } catch {
    throw new ZhuqueError('BAD_JSON', '请求体不是合法 JSON。', '请设置 Content-Type: application/json 并传入合法 JSON。', 400);
  }
}

/** 从 Authorization: Bearer <token> 里取出令牌；没有则返回 '' */
function bearerToken(req) {
  const auth = String(req.headers.authorization || '').trim();
  const m = auth.match(/^([A-Za-z]+)\s+(.+)$/);
  return m && m[1].toLowerCase() === 'bearer' ? m[2].trim() : '';
}

/** 请求是否携带了正确的服务访问令牌 */
function tokenMatches(req, token) {
  const provided = bearerToken(req);
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  return Boolean(token) && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function checkAuth(req, token) {
  if (isLoopbackRequest(req)) return;
  if (!token) throw new ZhuqueError('UNAUTHORIZED', '远程访问需要服务令牌', '', 401); // 本机（浏览器直接访问 127.0.0.1）等同已鉴权
  if (!tokenMatches(req, token)) {
    throw new ZhuqueError('UNAUTHORIZED', '服务鉴权失败。', '请在 Authorization 头中携带 Bearer <ZHUQUE_SERVER_TOKEN>。', 401);
  }
}

/** 配置/用量类响应统一包一层 ConfigError 转换 */
function asZhuqueError(err) {
  if (err instanceof ZhuqueError) return err;
  if (err instanceof ConfigError) return new ZhuqueError('CONFIG_INVALID', err.message, err.hint, 400);
  return new ZhuqueError('INTERNAL', String(err?.message || err), '请查看服务日志。', 500);
}

function clientApiKey(req) {
  const v = req.headers['x-zhuque-api-key'];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function sameOrigin(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === ub.protocol && ua.hostname === ub.hostname && ua.port === ub.port;
  } catch {
    return false;
  }
}

/**
 * 允许「连接测试」使用的 endpoint：与当前生效地址同源，或指向本机。
 * 既保留了「先试自定义网关再保存」的能力，又挡住了
 * 「把服务端保存的 Key 以 Bearer 转发到攻击者服务器」这条外泄路径。
 */
function assertEndpointAllowed(endpoint) {
  const current = resolveEndpoint();
  if (sameOrigin(endpoint, current)) return;
  try {
    resolveEndpoint(endpoint);
    // A candidate key explicitly supplied for testing may use local mock gateways.
    if (isLoopbackHostname(new URL(endpoint).hostname)) return;
  } catch {
    /* 非法 URL 交给下游报错 */
  }
  throw new ZhuqueError(
    'ENDPOINT_FORBIDDEN',
    '出于安全考虑，连接测试只允许使用「与当前配置同源」或「本机」的接口地址。',
    `当前生效地址：${current}。若要更换网关，请先在设置里保存，再点测试。`,
    403
  );
}

function buildDetectOptions(body, req, source = 'api') {
  return {
    apiKey: clientApiKey(req),
    isMerge: body.is_merge === undefined ? true : body.is_merge !== false,
    cache: body.cache === undefined ? true : body.cache !== false,
    autoChunk: body.auto_chunk === undefined ? true : body.auto_chunk !== false,
    maxChars: body.max_chars ? Number(body.max_chars) : undefined,
    timeoutMs: body.timeout_ms ? Number(body.timeout_ms) : undefined,
    includeRaw: body.include_raw === true,
    history: body.history === undefined ? true : body.history !== false,
    source: typeof body.source === 'string' && body.source.trim() ? body.source.trim() : source,
  };
}

/** 自检用的探针文本（约 60 字，消耗极小） */
const PROBE_TEXT = '这是一段用于连通性自检的普通文本，由人类手写而成，不含人工智能生成内容特征。';

function configState(SERVER_OPTIONS) {
  const base = describeConfig({ envSource: apiKeySource() });
  const cfg = readConfig();
  const token = resolveApiKey();
  return {
    ...base,
    version: VERSION,
    restarted_at: STARTED_AT,
    fields: Object.fromEntries(
      Object.entries(FIELDS).map(([k, m]) => [
        k,
        { label: m.label, type: m.type, env_var: m.env, restart: m.restart, saved: cfg[k] !== undefined },
      ])
    ),
    runtime: {
      // source 必须带上：前端「当前生效 Key · 来源」与 Key 芯片的 title 都读这个字段，
      // 少一个字段就会恒显示 “none”，让人误以为 Key 没生效。
      api_key: token
        ? { configured: true, masked: maskKey(token), source: apiKeySource() }
        : { configured: false, masked: '', source: 'none' },
      endpoint: resolveEndpoint(),
      server_token_required: Boolean(SERVER_OPTIONS.token),
      port: SERVER_OPTIONS.port,
      host: SERVER_OPTIONS.host,
    },
    quota: usageSummary().quota_per_month,
    chars_per_billing_unit: CHARS_PER_BILLING_UNIT,
    key_pool: (() => {
      try {
        const ps = poolStatus();
        return { count: ps.count, available_count: ps.available_count, next_key: ps.next_key, storage: ps.storage };
      } catch {
        return null;
      }
    })(),
    history: (() => {
      try {
        const st = historyStats();
        return { count: st.count, last_at: st.last_at, storage: historyPath() };
      } catch {
        return null;
      }
    })(),
    mcp_clients: { restricted: mcpRestrictClients(), allowlist: allowedMcpClients() },
  };
}

export function createServer({ token = '', host = '127.0.0.1', maxConcurrent = 4 } = {}) {
  const options = { token, host, port: 8787 };
  let active = 0;
  const server = http.createServer(async (req, res) => {
    req.__serverOptions = options;
    let busy = false;

    // CORS 按来源逐请求计算（不再是无脑 *）
    res.__cors = corsHeadersFor(req);

    try {
      if (!String(req.url).startsWith('/') || String(req.url).startsWith('//')) throw new ZhuqueError('BAD_URL', '请求路径格式不正确');
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;
      // Opening the public HTML entry from a link is safe; API requests still
      // require the usual origin checks. Host validation applies to both.
      const pageNavigation = req.method === 'GET' && ['/', '/index.html'].includes(p) &&
        req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
      if (!pageNavigation) assertSameSite(req);
      // Host 必须是回环（或显式放行）—— 掐断 DNS 重绑定这条绕过路径
      assertHostAllowed(req, token);
      if (req.method === 'OPTIONS') return send(res, 204, '');
      if (p.startsWith('/api/') && req.headers['sec-fetch-mode'] === 'no-cors') throw new ZhuqueError('CROSS_SITE_FORBIDDEN', '拒绝被动资源形式的 API 请求', '', 403);
      if (['/api/detect', '/api/batch', '/api/config/test', '/api/keys/test'].includes(p)) {
        if (active >= maxConcurrent) throw new ZhuqueError('SERVER_BUSY', '已有检测正在运行，请稍后重试', '', 429);
        active += 1; busy = true;
      }

      // ---- 静态网页 ----
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        const file = path.join(PUBLIC_DIR, 'index.html');
        if (!fs.existsSync(file)) return send(res, 404, 'index.html 缺失');
        const html = fs.readFileSync(file, 'utf8');
        const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`).join(' ');
        return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `default-src 'none'; script-src ${scripts}; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'` });
      }

      // ---- 面向 LLM 的纯文本说明 ----
      if (req.method === 'GET' && (p === '/llms.txt' || p === '/llms-full.txt')) {
        const base = `${'http'}://${req.headers.host || `127.0.0.1`}`;
        return send(res, 200, buildLlmsTxt(base));
      }

      // ---- 健康检查 ----
      // 刻意只回「能不能用」：上游地址与用量这类信息属于配置/账本，
      // 需要走鉴权的 /api/config 与 /api/usage，避免匿名接口顺手把它们播出去。
      // Key 掩码与来源（可能含用户名路径）只回给本机请求 —— 监听 0.0.0.0 时
      // 局域网里的任何人都能打这个免鉴权接口，没必要连掩码和路径一起送出去。
      if (p === '/api/health') {
        const key = resolveApiKey();
        const local = isLoopbackRequest(req) || tokenMatches(req, token);
        return send(res, 200, {
          ok: true,
          schema_version: SCHEMA_VERSION,
          service: 'zhuque-detect',
          version: VERSION,
          uptime_s: Math.round(process.uptime()),
          server_key: key
            ? local
              ? { configured: true, masked: maskKey(key), source: apiKeySource() }
              : { configured: true }
            : { configured: false },
          server_token_required: Boolean(token),
          note: key ? undefined : '服务端未配置 Key，请在网页右上角「设置」中填写，或用 X-Zhuque-Api-Key 头自带 Key。',
        });
      }

      // ---- 配置：读取 / 保存 / 测试连接 ----
      if (p === '/api/config' && req.method === 'GET') {
        checkAuth(req, token);
        applyConfigToEnv();
        return send(res, 200, envelope(configState(options)));
      }

      if (p === '/api/config' && req.method === 'POST') {
        checkAuth(req, token);
        const body = await readBody(req);
        if (body.endpoint) resolveEndpoint(body.endpoint);
        const before = readConfig();
        const { backup, file } = writeConfig(body);
        const after = readConfig();

        // 判断改动是否影响需要重启的项
        const restartFields = Object.entries(FIELDS)
          .filter(([, m]) => m.restart)
          .map(([k]) => k)
          .filter((k) => String(before[k] ?? '') !== String(after[k] ?? ''));

        // 立即把新配置注入环境，Key / endpoint / 超时等无需重启即可生效
        applyConfigToEnv({ override: true });

        return send(
          res,
          200,
          envelope({
            saved: Object.fromEntries(
              Object.entries(after).map(([k, v]) => [
                k,
                FIELDS[k]?.type === 'secret'
                  ? maskSecret(v)
                  : FIELDS[k]?.type === 'keylist'
                    ? (Array.isArray(v) ? v : []).map((item, i) => ({
                        id: item.id || `idx${i}`,
                        label: item.label || `Key ${i + 1}`,
                        enabled: item.enabled !== false,
                        masked: maskSecret(item.key),
                      }))
                    : v,
              ])
            ),
            config_file: file,
            backup,
            restart_required: restartFields,
            state: configState(options),
          })
        );
      }

      // ---- 测试连接：不落盘，直接用给定 Key 打一次最小请求 ----
      // 语义约定：请求本身被成功处理时一律返回 HTTP 200 且信封 ok=true；
      // 上游能不能用由 data.reachable 表示。这样「Key 无效」是一个正常结果，
      // 而不是把 UI 引到错误分支上去。
      if (p === '/api/config/test' && req.method === 'POST') {
        checkAuth(req, token);
        const body = await readBody(req);
        const candidateKey = typeof body.api_key === 'string' && body.api_key.trim() ? body.api_key.trim() : undefined;
        const endpoint = typeof body.endpoint === 'string' && body.endpoint.trim() ? body.endpoint.trim() : undefined;
        if (endpoint) { resolveEndpoint(endpoint); assertEndpointAllowed(endpoint); }
        if (endpoint && !candidateKey && !sameOrigin(endpoint, resolveEndpoint())) throw new ZhuqueError('ENDPOINT_FORBIDDEN', '测试新地址时请显式填写该地址的 Key，以免转发已保存的 Key', '', 403);
        const t0 = Date.now();
        try {
          const result = await detect(PROBE_TEXT, {
            apiKey: candidateKey,
            endpoint,
            cache: false,
            record: false,
            // 连接测试只是探针，绝不能落进检测历史 ——
            // 否则用户在设置里点一下「测试连接」，历史里就多一条探针文本。
            history: false,
            includeRaw: false,
          });
          return send(
            res,
            200,
            envelope({
              reachable: true,
              message: '连接正常，Key 可用。',
              latency_ms: Date.now() - t0,
              key_masked: maskKey(candidateKey || resolveApiKey()),
              key_source: candidateKey ? 'request' : apiKeySource(),
              endpoint: endpoint || resolveEndpoint(),
              probe: { verdict: result.verdict, verdict_name: result.verdict_name, ai_rate_percent: result.ai_rate_percent },
              billed_tokens: result._meta.usage.makers_billed_tokens,
              error: null,
            })
          );
        } catch (err) {
          const e = asZhuqueError(err);
          return send(
            res,
            200,
            envelope({
              reachable: false,
              message: '连接失败。',
              latency_ms: Date.now() - t0,
              key_masked: candidateKey ? maskKey(candidateKey) : maskKey(resolveApiKey()),
              key_source: candidateKey ? 'request' : apiKeySource(),
              endpoint: endpoint || resolveEndpoint(),
              probe: null,
              billed_tokens: 0,
              error: e.toJSON(),
            })
          );
        }
      }

      // ---- 用量 ----
      if (p === '/api/usage' && req.method === 'GET') {
        checkAuth(req, token);
        const rawDays = Number(url.searchParams.get('days') || 7);
        const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(90, Math.round(rawDays)) : 7;
        return send(res, 200, envelope(usageSummary({ days })));
      }

      if (p === '/api/usage/calibrate' && req.method === 'POST') {
        checkAuth(req, token);
        const body = await readBody(req);
        if (body.tokens === undefined || body.tokens === null || body.tokens === '') {
          throw new ZhuqueError('MISSING_FIELD', '缺少字段 tokens（控制台显示的周期内已用 token 数）。', '示例：{"tokens": 12345}', 400);
        }
        const summary = calibrate(body.tokens, body.note || '');
        return send(res, 200, envelope({ calibrated: true, summary }));
      }

      if (p === '/api/usage/quota' && req.method === 'POST') {
        checkAuth(req, token);
        const body = await readBody(req);
        try {
          const summary = setQuota({ quota_per_month: body.quota_per_month, cycle_start_day: body.cycle_start_day });
          return send(res, 200, envelope({ updated: true, summary }));
        } catch (err) {
          throw asZhuqueError(err);
        }
      }

      if (p === '/api/usage/reset' && req.method === 'POST') {
        checkAuth(req, token);
        const body = await readBody(req);
        if (body.calibration_only) {
          return send(res, 200, envelope({ cleared: 'calibration', summary: clearCalibration() }));
        }
        const out = resetUsage();
        return send(res, 200, envelope({ cleared: 'all', file: out.file, summary: out.summary }));
      }

      // ---- 接口说明 ----
      if (p === '/api/schema') return send(res, 200, buildSchemaDoc());

      // ---- 供网页与用户直接复制的 MCP 配置 ----
      // 会暴露本机绝对路径，因此与其他读接口一样要求鉴权（本机访问自动放行）
      if (p === '/api/mcp-config') {
        checkAuth(req, token);
        const mcpPath = path.resolve(__dirname, 'mcp-server.mjs');
        return send(res, 200, {
          ok: true,
          mcp_server_path: mcpPath,
          snippet: { mcpServers: { 'zhuque-detect': { command: 'node', args: [mcpPath] } } },
          note: '将 snippet 合并进客户端的 MCP 配置文件即可；见 GET /api/schema 的 agent_instructions。',
        });
      }

      // ---- 检测历史 ----
      if (p === '/api/history' && req.method === 'GET') {
        checkAuth(req, token);
        const g = (k) => url.searchParams.get(k) || undefined;
        return send(
          res,
          200,
          envelope(
            listHistory({
              limit: g('limit'),
              offset: g('offset'),
              q: g('q'),
              verdict: g('verdict'),
              category: g('category'),
              source: g('source'),
              from: g('from'),
              to: g('to'),
            })
          )
        );
      }

      if (p === '/api/history/stats' && req.method === 'GET') {
        checkAuth(req, token);
        return send(res, 200, envelope(historyStats()));
      }

      if (p === '/api/history/export' && req.method === 'GET') {
        checkAuth(req, token);
        const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'json';
        const limit = Number(url.searchParams.get('limit') || 500);
        const body = exportHistory({ format, limit });
        return send(res, 200, body, {
          'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="zhuque-history.${format}"`,
        });
      }

      if (p === '/api/history/clear' && req.method === 'POST') {
        checkAuth(req, token);
        return send(res, 200, envelope({ cleared: true, ...clearHistory() }));
      }

      if (p.startsWith('/api/history/') && req.method === 'GET') {
        checkAuth(req, token);
        const id = decodeURIComponent(p.slice('/api/history/'.length));
        const rec = getHistory(id);
        if (!rec) throw new ZhuqueError('HISTORY_NOT_FOUND', `未找到历史记录 ${id}`, '用 GET /api/history 查看可用 id。', 404);
        return send(res, 200, envelope(rec));
      }

      if (p.startsWith('/api/history/') && req.method === 'DELETE') {
        checkAuth(req, token);
        const id = decodeURIComponent(p.slice('/api/history/'.length));
        return send(res, 200, envelope({ id, ...deleteHistory(id) }));
      }

      // ---- API Key 池 ----
      if (p === '/api/keys' && req.method === 'GET') {
        checkAuth(req, token);
        return send(res, 200, envelope({ ...poolStatus(), state_file: keyStatePath() }));
      }

      if (p === '/api/keys' && req.method === 'POST') {
        checkAuth(req, token);
        const body = await readBody(req);
        const incoming = body.api_keys ?? body.keys;
        // 字段缺失一律 400：绝不能把「忘了带字段」当成「显式清空 Key 池」
        if (!Array.isArray(incoming)) {
          throw new ZhuqueError(
            'MISSING_FIELD',
            '缺少字段 api_keys（必须是数组）。',
            '示例：{"api_keys":[{"key":"sk-xxx","label":"主号"}]}；确实要清空请显式传 []。',
            400
          );
        }
        const before = readConfig();
        const { backup, file } = writeConfig({ api_keys: incoming });
        applyConfigToEnv({ override: true });
        const pool = poolStatus();
        return send(
          res,
          200,
          envelope({
            // 只回传掩码，绝不下发明文密钥
            saved: { api_keys: (pool.keys || []).map((k) => ({ id: k.id, label: k.label, enabled: k.enabled, masked: k.masked })) },
            config_file: file,
            backup,
            restart_required: [],
            pool: { ...pool, state_file: keyStatePath() },
            previous_key_count: (before.api_keys || []).length,
          })
        );
      }

      if (p === '/api/keys/reset' && req.method === 'POST') {
        checkAuth(req, token);
        const r = resetAllKeyState();
        return send(res, 200, envelope({ ...r, state_file: keyStatePath() }));
      }

      if (p === '/api/keys/toggle' && req.method === 'POST') {
        checkAuth(req, token);
        const body = await readBody(req);
        if (!body.id) throw new ZhuqueError('MISSING_FIELD', '缺少字段 id。', '示例：{"id":"k1","enabled":false}', 400);
        const r = setKeyEnabled(body.id, body.enabled !== false);
        if (!r.updated && r.reason === 'only_single_key') {
          throw new ZhuqueError('SINGLE_KEY_MODE', '当前只有单把 Key，无法单独停用。', '请先在设置里添加多把 Key 组成池。', 400);
        }
        return send(res, 200, envelope({ ...r, pool: poolStatus() }));
      }

      if (p === '/api/keys/test' && req.method === 'POST') {
        checkAuth(req, token);
        const body = await readBody(req);
        const key = typeof body.api_key === 'string' && body.api_key.trim() ? body.api_key.trim() : undefined;
        const t0 = Date.now();
        try {
          const result = await detect(PROBE_TEXT, { apiKey: key, cache: false, record: false, history: false });
          return send(res, 200, envelope({
            reachable: true, message: '连接正常，Key 可用。', latency_ms: Date.now() - t0,
            key_masked: maskKey(key || resolveApiKey()), endpoint: resolveEndpoint(),
            probe: { verdict: result.verdict, verdict_name: result.verdict_name, ai_rate_percent: result.ai_rate_percent },
            billed_tokens: result._meta.usage.makers_billed_tokens, error: null,
          }));
        } catch (err) {
          const e = asZhuqueError(err);
          return send(res, 200, envelope({
            reachable: false, message: '连接失败。', latency_ms: Date.now() - t0,
            key_masked: key ? maskKey(key) : maskKey(resolveApiKey()), endpoint: resolveEndpoint(),
            probe: null, billed_tokens: 0, error: e.toJSON(),
          }));
        }
      }

      if (p === '/api/cache' && req.method === 'POST') {
        checkAuth(req, token);
        clearCache();
        return send(res, 200, envelope({ cleared: true }));
      }

      // ---- 便捷 GET 检测 ----
      if (p === '/api/detect' && req.method === 'GET') {
        checkAuth(req, token);
        const text = url.searchParams.get('text') || '';
        if (!text.trim()) {
          throw new ZhuqueError('EMPTY_TEXT', '缺少 text 查询参数。', '用法：/api/detect?text=你的文本（需 URL 编码）。', 400);
        }
        // GET 语义应当幂等：默认不写历史，避免被 <img src> 之类的简单请求刷进历史库。
        // 用量仍照常记账，保证本地账本与真实消耗一致。
        const data = await detect(text, {
          apiKey: clientApiKey(req),
          isMerge: url.searchParams.get('is_merge') !== 'false',
          source: 'api',
          history: url.searchParams.get('history') === 'true',
        });
        return send(res, 200, envelope(data));
      }

      // ---- 检测 ----
      if (p === '/api/detect' && req.method === 'POST') {
        checkAuth(req, token);
        const body = await readBody(req);
        if (typeof body.text !== 'string') {
          throw new ZhuqueError('MISSING_FIELD', '缺少字段 text。', '请求体形如 {"text":"待检测文本","is_merge":true}。', 400);
        }
        const data = await detect(body.text, buildDetectOptions(body, req));
        return send(res, 200, envelope(data, body.id ?? null));
      }

      // ---- 批量 ----
      if (p === '/api/batch' && req.method === 'POST') {
        checkAuth(req, token);
        const body = await readBody(req);
        const items = body.items ?? body.texts;
        if (!Array.isArray(items)) {
          throw new ZhuqueError('MISSING_FIELD', '缺少字段 items。', '请求体形如 {"items":[{"id":"a","text":"..."}]}。', 400);
        }
        const data = await detectBatch(items, buildDetectOptions(body, req, 'batch'));
        return send(res, 200, envelope(data, body.id ?? null));
      }

      return send(res, 404, errorEnvelope(new ZhuqueError('NOT_FOUND', `未知路径 ${p}`, '可用路径见 GET /api/schema。', 404)));
    } catch (err) {
      const e = asZhuqueError(err);
      if (!res.destroyed && !res.writableEnded) return send(res, e.status || 400, errorEnvelope(e));
    } finally {
      if (busy) active -= 1;
    }
  });
  server.on('listening', () => { const a = server.address(); options.host = a.address; options.port = a.port; });
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  return server;
}

/**
 * 启动服务。
 * 端口/监听地址/令牌的取值优先级：显式参数 > 配置文件 > 环境变量 > 默认值
 */
export function startServer({ port, host, token, open } = {}) {
  loadLocalSettings();
  let finalPort;
  let finalHost;
  let finalToken;
  let autoOpen;
  try {
    const cfg = (() => {
      try {
        return readConfig();
      } catch {
        return {};
      }
    })();

    const rawPort = port ?? cfg.port ?? process.env.PORT ?? 8787;
    finalPort = Number(rawPort);
    if (!Number.isInteger(finalPort) || finalPort < 1 || finalPort > 65535) {
      throw new ZhuqueError(
        'BAD_PORT',
        `端口不是 1~65535 的整数：${rawPort}`,
        '可用 --port 8788 指定端口，或在设置面板里修改。',
        400
      );
    }
    finalHost = String(host ?? cfg.host ?? process.env.HOST ?? '127.0.0.1');
    finalToken = String(token ?? process.env.ZHUQUE_SERVER_TOKEN ?? cfg.server_token ?? '');
    // open 显式给定时以它为准；未给定时交给配置项 auto_open。
    // （调用方只在用户真的写了 --open / --no-open 时才传布尔，否则必须传 undefined）
    autoOpen = open === undefined || open === null ? Boolean(cfg.auto_open) : Boolean(open);

    if (finalHost !== 'localhost' && !isIP(finalHost)) throw new ZhuqueError('BAD_HOST', '监听地址必须是 IP 或 localhost');
    if (!isLoopbackHostname(finalHost) && !finalToken) throw new ZhuqueError('TOKEN_REQUIRED', '非回环监听必须设置服务访问令牌', '设置 ZHUQUE_SERVER_TOKEN，或使用 --host 127.0.0.1');

    // 把配置文件里的 endpoint / 超时 / 缓存等注入环境（环境变量已存在的优先，不覆盖）
    applyConfigToEnv();
  } catch (err) {
    return Promise.reject(err);
  }

  const server = createServer({ token: finalToken, host: finalHost });
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new ZhuqueError(
            'PORT_IN_USE',
            `端口 ${finalPort} 已被占用。`,
            `换一个端口（设置面板里改，或 PORT=8788 ./bin/zhuque serve），或先停掉已运行的服务。`,
            409
          )
        );
      } else {
        reject(err);
      }
    });

    server.listen(finalPort, finalHost, () => {
      const addr = server.address();
      const urlHost = ['0.0.0.0', '::'].includes(finalHost) ? '127.0.0.1' : finalHost.includes(':') ? `[${finalHost}]` : finalHost;
      const url = `http://${urlHost}:${addr.port}`;
      const key = resolveApiKey();
      const usage = usageSummary();
      const pctOf = (n) => `${(n * 100).toFixed(2)}%`;
      const lines = [
        '',
        `  zhuque-detect v${VERSION} 已启动`,
        `  ────────────────────────────────────────`,
        `  网页检测   ${url}/`,
        `  HTTP API   POST ${url}/api/detect`,
        `  接口说明   ${url}/api/schema`,
        `  LLM 说明   ${url}/llms.txt`,
        `  ────────────────────────────────────────`,
        key
          ? `  当前 Key   ${maskKey(key)}  (${apiKeySource()})`
          : `  当前 Key   未配置 —— 请打开 ${url}/ 点右上角「设置」填写`,
        `  本月用量   ${usage.used.billed_tokens.toLocaleString()} / ${usage.quota_per_month.toLocaleString()} token（已用 ${pctOf(usage.used.ratio)}，剩余 ${usage.remaining.tokens.toLocaleString()}，账期至 ${usage.cycle.end}）`,
        finalToken ? `  访问令牌   已启用` : `  访问令牌   未启用`,
        `  配置文件   ${configPath()}`,
        '',
      ];
      // 监听非回环地址又不开令牌 = 整个局域网都能读你的历史、用你的 Key
      if (!isLoopbackHostname(finalHost) && !finalToken) {
        lines.push(
          `  ⚠ 安全提醒：服务监听在 ${finalHost}（非本机回环），且未设置访问令牌。`,
          '    同一网络内的任何人都能读取检测历史、消耗你的 Key 额度。',
          '    建议二选一：改回 --host 127.0.0.1；或设置访问令牌（设置面板 / server_token 配置项 / ZHUQUE_SERVER_TOKEN）。',
          ''
        );
      }
      process.stdout.write(lines.join('\n'));
      if (autoOpen) openBrowser(url);
      resolve({ server, url });
    });
  });
}

function openBrowser(url) {
  import('node:child_process').then(({ spawn }) => {
    try {
      if (process.platform === 'win32') {
        // Windows 上 `start` 是 cmd 内建命令，必须经 cmd /c 调用；
        // 第一个空参数是给 `start` 的「窗口标题」占位，否则带引号的 URL 会被当成标题。
        const child = spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`], { stdio: 'ignore', detached: true, windowsHide: true });
        child.on('error', () => {}); child.unref();
        return;
      }
      const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
      const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
      child.on('error', () => {}); child.unref();
    } catch {
      /* 忽略 */
    }
  });
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  const argOf = (name) => {
    const i = process.argv.indexOf(name);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
  };
  applyConfigToEnv();
  startServer({
    port: argOf('--port'),
    host: argOf('--host'),
    token: argOf('--token'),
    // 没写 --open / --no-open 时必须传 undefined，否则配置项 auto_open 永远不生效
    open: process.argv.includes('--open') ? true : process.argv.includes('--no-open') ? false : undefined,
  }).catch((err) => {
    if (err instanceof ZhuqueError) {
      process.stderr.write(`\n[${err.code}] ${err.message}\n${err.hint ? `提示：${err.hint}\n` : ''}`);
    } else {
      process.stderr.write(`\n启动失败：${err?.stack || err}\n`);
    }
    process.exitCode = 1;
  });
}
