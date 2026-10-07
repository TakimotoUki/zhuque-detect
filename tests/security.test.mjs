// Regression tests use isolated state and synthetic keys. No paid upstream calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zq-security-')));
for (const [env, name] of Object.entries({ ZHUQUE_CONFIG_FILE: 'config.json', ZHUQUE_HISTORY_FILE: 'history.jsonl', ZHUQUE_USAGE_FILE: 'usage.json', ZHUQUE_KEYS_FILE: 'keys.json', ZHUQUE_TOKEN_FILE: 'token.txt' })) process.env[env] = path.join(dir, name);
for (const k of ['ZHUQUE_API_KEY', 'EDGEONE_API_KEY', 'EDGEONE_MAKERS_API_KEY', 'ZHUQUE_ENDPOINT', 'ZHUQUE_ALLOWED_ORIGINS']) delete process.env[k];
const { detect, callZhuque, chunkText, normalize, clearCache, resolveKeyChoice, resolveEndpoint } = await import('../src/core.mjs');
const { writeConfig, readConfig, applyConfigToEnv, coerceField } = await import('../src/config-store.mjs');
const { appendHistory, getHistory, exportHistory, clearHistory } = await import('../src/history-store.mjs');
const { calibrate, recordUsage, resetUsage, usageSummary } = await import('../src/usage-store.mjs');
const { noteFailure, poolStatus, resetAllKeyState } = await import('../src/key-pool.mjs');
const { createServer, startServer } = await import('../src/server.mjs');
const response = text => ({ status: 'success', labels_ratio: { 0: .5, 1: .2, 2: .3 }, softmax_confidence: .4, segment_labels: [{ text, label: 1, conf: .4, order: 1, position: [0, text.length] }], makers_models_usage: { total_tokens: 7 }, usage: { total_tokens: 11 } });
const servers = [];
async function listen(s, host = '127.0.0.1') { servers.push(s); await new Promise((r, j) => { s.once('error', j); s.listen(0, host, r); }); return `http://127.0.0.1:${s.address().port}`; }
let calls = [];
const upstream = http.createServer(async (req, res) => {
  let body = ''; for await (const b of req) body += b;
  const text = JSON.parse(body || '{}').text || '';
  const key = String(req.headers.authorization || '');
  calls.push({ text, key });
  if (req.url === '/slow') { res.writeHead(200); res.write('{'); return; }
  if (req.url === '/redirect') { res.writeHead(307, { Location: '/classify' }); return res.end(); }
  if (req.url === '/invalid') return res.end('{}');
  if (key.includes('bad') || text === 'FAIL' && key.includes('first')) { res.writeHead(429); return res.end(JSON.stringify({ msg: `quota ${key}` })); }
  res.end(JSON.stringify(response(text)));
});
const endpoint = await listen(upstream) + '/classify';
process.env.ZHUQUE_ENDPOINT = endpoint;
process.env.ZHUQUE_API_KEY = 'sk-test-only-key';
const local = await listen(createServer());
const remote = await listen(createServer({ token: 'test-server-token' }), '0.0.0.0');
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const noRecord = { history: false, record: false, cache: false };

test('history percent values below 1 retain their percentage units', () => {
  const r = appendHistory({ text: 'test', categories: { ai: { percent: .5 }, human: { percent: 99.5 } } });
  assert.equal(getHistory(r.id).categories.ai.percent, .5);
});
test('text retention limits also remove segment copies of the full text', () => {
  process.env.ZHUQUE_HISTORY_TEXT_MAX = '2';
  const r = appendHistory({ text: 'abcdef', segments: [{ text: 'abcdef', excerpt: 'abcdef' }] });
  assert.equal(r.text, null); assert.equal(r.segments[0].text, ''); assert.equal(r.segments_truncated, true);
  delete process.env.ZHUQUE_HISTORY_TEXT_MAX;
});
test('malformed persisted rows cannot crash history reads', () => {
  fs.appendFileSync(process.env.ZHUQUE_HISTORY_FILE, 'null\n[]\n42\n{"broken":true}\n');
  assert.doesNotThrow(() => exportHistory());
});
test('CSV export blocks formulas even with leading spaces', () => {
  appendHistory({ text: 'normal', source: '   =1+1' });
  assert.ok(exportHistory({ format: 'csv' }).includes("'   =1+1"));
});
test('configuration keeps explicit environment precedence and removes cleared injected values', () => {
  const old = process.env.ZHUQUE_TIMEOUT_MS;
  process.env.ZHUQUE_TIMEOUT_MS = '4321'; writeConfig({ timeout_ms: 9876 }); applyConfigToEnv({ override: true });
  assert.equal(process.env.ZHUQUE_TIMEOUT_MS, '4321');
  delete process.env.ZHUQUE_TIMEOUT_MS; applyConfigToEnv(); assert.equal(process.env.ZHUQUE_TIMEOUT_MS, '9876');
  writeConfig({ clear: { timeout_ms: true } }); applyConfigToEnv(); assert.equal(process.env.ZHUQUE_TIMEOUT_MS, undefined);
  if (old !== undefined) process.env.ZHUQUE_TIMEOUT_MS = old;
});
test('configuration rejects prototype keys, duplicate IDs and unsafe endpoints', () => {
  assert.throws(() => coerceField('__proto__', 'x'));
  assert.throws(() => writeConfig({ api_keys: [{ id: 'same', key: 'test-a' }, { id: 'same', key: 'test-b' }] }));
  assert.throws(() => resolveEndpoint('http://example.com/'));
  assert.throws(() => resolveEndpoint('https://user:pass@example.com/'));
  assert.equal(coerceField('cache_ttl_ms', 0), 0);
});
test('morning calibration includes today instead of double counting noon buckets', () => {
  const RealDate = Date; const now = new RealDate(); const morning = new RealDate(now.getFullYear(), now.getMonth(), now.getDate(), 9).getTime();
  globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [morning])); } static now() { return morning; } };
  try { resetUsage(); recordUsage({ billed: 12 }); const s = calibrate(50); assert.equal(s.used.billed_tokens, 50); } finally { globalThis.Date = RealDate; }
});
test('array and null HTTP bodies return a structured 400', async () => {
  for (const body of [null, []]) { const r = await post(local + '/api/config', body); assert.equal(r.status, 400); assert.equal((await r.json()).ok, false); }
});
test('spoofed loopback Host cannot bypass auth on a wildcard listener', async () => {
  const r = await fetch(remote + '/api/config', { headers: { Host: '127.0.0.1' } }); assert.equal(r.status, 401);
  const ok = await fetch(remote + '/api/config', { headers: { Host: '127.0.0.1', Authorization: 'Bearer test-server-token' } }); assert.equal(ok.status, 200);
});
test('non-loopback startup without a token fails closed', async () => {
  await assert.rejects(startServer({ host: '0.0.0.0', token: '' }), e => e.code === 'TOKEN_REQUIRED');
});
test('loopback websites on a different port cannot read private config', async () => {
  const r = await fetch(local + '/api/config', { headers: { Origin: 'http://localhost:1234' } }); assert.equal(r.status, 403);
});
test('explicit allowed origin survives cross-site checks', async () => {
  process.env.ZHUQUE_ALLOWED_ORIGINS = 'https://example.com';
  const r = await fetch(local + '/api/health', { headers: { Origin: 'https://example.com', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(r.status, 200); assert.equal(r.headers.get('access-control-allow-origin'), 'https://example.com'); delete process.env.ZHUQUE_ALLOWED_ORIGINS;
});
test('connection tests cannot forward the saved key to another local gateway', async () => {
  const another = await listen(http.createServer((req, res) => res.end('{}')));
  const r = await post(local + '/api/config/test', { endpoint: another }); assert.equal(r.status, 403);
});
test('security headers and CSP cover the static application', async () => {
  const r = await fetch(local); assert.equal(r.headers.get('x-frame-options'), 'DENY'); assert.ok(r.headers.get('content-security-policy').includes('sha256-'));
});
test('cross-site top-level HTML navigation is allowed but private API navigation is rejected', async () => {
  const request = route => new Promise((resolve, reject) => {
    const req = http.get(local + route, { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject);
  });
  assert.equal(await request('/'), 200);
  assert.equal(await request('/api/config'), 403);
});
test('passive browser resource requests cannot trigger detections', async () => {
  const r = await fetch(local + '/api/detect?text=test', { mode: 'no-cors' }); assert.equal(r.status, 403);
});
test('cache separates caller keys, endpoints and raw response modes', async () => {
  clearCache(); calls = [];
  const text = 'cache isolation test';
  await detect(text, { ...noRecord, cache: true, apiKey: 'test-key-1' });
  await detect(text, { ...noRecord, cache: true, apiKey: 'test-key-2' });
  const raw = await detect(text, { ...noRecord, cache: true, apiKey: 'test-key-2', includeRaw: true }); assert.ok(raw._raw);
  await detect(text, { ...noRecord, cache: true, apiKey: 'test-key-2', endpoint: endpoint + '?different' }); assert.equal(calls.length, 4);
});
test('cached results are copied and cache histories record zero billed tokens', async () => {
  clearCache(); clearHistory(); const text = 'cached history test';
  const first = await detect(text); first.segments[0].text = 'corrupted';
  const next = await detect(text); assert.equal(next._meta.cache_hit, true); assert.notEqual(next.segments[0].text, 'corrupted');
  const h = getHistory(next._meta.history_id); assert.equal(h.usage.billed_tokens, 0); assert.ok(h.key.masked);
});
test('whole ratios use official 1=AI and 2=suspected without a sparse segment overriding them', () => {
  const r = normalize(response('one')); assert.equal(r.categories.ai.percent, 20); assert.equal(r.categories.suspected_ai.percent, 30); assert.equal(r.ai_rate_percent, 50);
  assert.throws(() => normalize({ labels_ratio: {} }), e => e.code === 'BAD_RESPONSE');
  assert.throws(() => normalize({ ...response('x'), segment_labels: [null] }), e => e.code === 'BAD_RESPONSE');
});
test('invalid timeout rejects even when an equivalent detection is cached', async () => {
  clearCache(); await detect('timeout validation', { ...noRecord, cache: true });
  await assert.rejects(detect('timeout validation', { ...noRecord, cache: true, timeoutMs: 0 }), e => e.code === 'BAD_TIMEOUT');
});
test('successful detection reports a failed usage write instead of showing complete local accounting', async () => {
  const saved = process.env.ZHUQUE_USAGE_FILE;
  const target = path.join(dir, 'usage-directory'); fs.mkdirSync(target);
  process.env.ZHUQUE_USAGE_FILE = target;
  try {
    const r = await detect('storage warning', { cache: false, history: false });
    assert.ok(r.warnings.some(w => w.code === 'USAGE_WRITE_FAILED'));
  } finally { process.env.ZHUQUE_USAGE_FILE = saved; }
});
test('live API label 1 consistently represents AI in ratios, segment names and counts', () => {
  const r = normalize({ status: 'success', labels_ratio: {0:0,1:1,2:0}, segment_labels: [{text:'test',label:1,position:[0,4]}] });
  assert.equal(r.segments[0].label_name, 'AI 特征'); assert.equal(r.categories.ai.chars, 4); assert.equal(r.categories.suspected_ai.chars, 0);
});
test('chunking preserves trailing whitespace and complete emoji', () => {
  const text = 'abc😀尾\n\n    '; const parts = chunkText(text, 4); assert.equal(parts.join(''), text);
  assert.ok(parts.every(p => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(p)));
  assert.throws(() => chunkText('abc', .2), e => e.code === 'BAD_MAX_CHARS');
});
test('chunk aggregation keeps separate AI and suspected ratios without segments', async () => {
  const r = await detect('abcdef', { ...noRecord, maxChars: 2 }); assert.equal(r.categories.suspected_ai.percent, 30); assert.equal(r.categories.ai.percent, 20);
});
test('retry preserves earlier successful chunks and accounts for each request', async () => {
  delete process.env.ZHUQUE_API_KEY; writeConfig({ api_keys: [{ id: 'first', key: 'sk-first', account: 'one' }, { id: 'second', key: 'sk-second', account: 'two' }] }); resetAllKeyState(); resetUsage(); calls = [];
  const r = await detect('PASSFAIL', { history: false, cache: false, maxChars: 4 });
  assert.deepEqual(calls.map(c => c.text), ['PASS', 'FAIL', 'FAIL']); assert.equal(r._meta.failover, true); assert.equal(usageSummary().used.billed_tokens, 14);
  process.env.ZHUQUE_API_KEY = 'sk-test-only-key';
});
test('quota exhaustion cools all keys grouped under the same account', () => {
  writeConfig({ api_keys: [{ id: 'a1', key: 'test-a', account: 'shared' }, { id: 'a2', key: 'test-b', account: 'shared' }, { id: 'b', key: 'test-c', account: 'other' }] }); resetAllKeyState(); noteFailure('a1', { exhaust: true });
  assert.equal(poolStatus().available_count, 1);
});
test('all disabled pool keys do not silently fall back to an unrelated single key', () => {
  delete process.env.ZHUQUE_API_KEY; writeConfig({ api_key: 'test-fallback', api_keys: [{ id: 'a', key: 'test-a', enabled: false }] }); assert.equal(resolveKeyChoice().key, null); process.env.ZHUQUE_API_KEY = 'sk-test-only-key';
});
test('upstream body stalls are covered by the timeout', async () => {
  await assert.rejects(callZhuque('test', { endpoint: endpoint.replace('/classify', '/slow'), timeoutMs: 40 }), e => e.code === 'TIMEOUT');
});
test('redirects and malformed upstream success cannot become human results', async () => {
  await assert.rejects(callZhuque('test', { endpoint: endpoint.replace('/classify', '/redirect') }), e => e.code === 'NETWORK_ERROR');
  await assert.rejects(callZhuque('test', { endpoint: endpoint.replace('/classify', '/invalid') }), e => e.code === 'BAD_RESPONSE');
});
test('upstream errors cannot echo caller API keys', async () => {
  const key = 'sk-bad-test-secret'; await assert.rejects(callZhuque('test', { apiKey: key }), e => !JSON.stringify(e.toJSON()).includes(key));
});
async function mcp(messages, name = 'Codex', entry = fileURLToPath(new URL('../src/mcp-server.mjs', import.meta.url))) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { env: { ...process.env, ZHUQUE_MCP_CLIENT: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP test timed out')); }, 10000);
    let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b); child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); try {
      if (code !== 0 || !stdout.trim()) throw Error(`MCP exited ${code}: ${stderr}`);
      resolve(stdout.trim().split('\n').filter(Boolean).map(JSON.parse));
    } catch (e) { reject(e); } });
    if (name) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name, version: 'test' } } }) + '\n');
    child.stdin.end(messages.map(JSON.stringify).join('\n') + '\n');
  });
}
test('Codex stdio handshake and paid-tool mock result survive immediate EOF', async () => {
  const replies = await mcp([{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'detect_ai_text', arguments: { text: 'MCP test', is_merge: false } } }]);
  assert.equal(replies[0].result.serverInfo.version, '1.3.0'); assert.equal(replies.find(r => r.id === 2).result.isError, false);
});
test('MCP refuses calls before initialization and blocked client resource reads', async () => {
  const msgs = [{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_detection_history', arguments: {} } }];
  assert.equal((await mcp(msgs, null))[0].error.code, -32002);
  const blocked = await mcp([{ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'zhuque://schema' } }], 'random-client'); assert.equal(blocked.find(r => r.id === 3).error.code, -32001);
});
test('MCP works from an unrelated cwd after copying to a Chinese/space path', async () => {
  const moved = path.join(dir, '我的 MCP tools'); fs.cpSync(fileURLToPath(new URL('../src', import.meta.url)), moved, { recursive: true });
  const replies = await mcp([{ jsonrpc: '2.0', id: 2, method: 'tools/list' }], 'codex_cli_rs', path.join(moved, 'mcp-server.mjs'));
  assert.equal(replies.find(r => r.id === 2).result.tools.length, 5);
});
test.after(async () => { for (const s of servers) { s.closeAllConnections(); await new Promise(r => s.close(r)); } fs.rmSync(dir, { recursive: true, force: true }); });
