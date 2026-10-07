/**
 * API Key 池
 *
 * 支持配置多把 Key，调用时自动挑选可用的那把；某把 Key 额度耗尽或失效后，
 * 自动切换到下一把，不用人工干预。
 *
 * 分工：
 *   - `~/.zhuque/config.json` 的 `api_keys` 存「有哪些 Key」（含密钥，0600）
 *   - `~/.zhuque/keys-state.json` 存「每把 Key 用成什么样了」（用量、失败次数、冷却到什么时候）
 * 这样状态文件可以随便重置，不会丢密钥。
 *
 * 兼容：只配置了单个 `api_key` 时，池里就是那一把。
 */

import fs from 'node:fs';
import { atomicWrite, withFileLock } from './file-store.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG_DIR, readConfig, writeConfig, maskSecret } from './config-store.mjs';

const DEFAULT_KEY_COOLDOWN_MS = 60 * 60 * 1000; // 1 小时

export function keyStatePath() {
  return process.env.ZHUQUE_KEYS_FILE || path.join(CONFIG_DIR, 'keys-state.json');
}

function newKeyId() {
  return 'k' + crypto.randomBytes(4).toString('hex');
}

// ---------------------------------------------------------------------------
// 状态文件
// ---------------------------------------------------------------------------

function emptyState() {
  return { version: 1, cursor: 0, keys: {} };
}

function readState() {
  const file = keyStatePath();
  try {
    if (!fs.existsSync(file)) return emptyState();
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return emptyState();
    return { ...emptyState(), ...parsed, cursor: Number.isSafeInteger(parsed.cursor) && parsed.cursor >= 0 ? parsed.cursor : 0, keys: Object.assign(Object.create(null), parsed.keys || {}) };
  } catch {
    return emptyState();
  }
}

function writeState(state) {
  const file = keyStatePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, JSON.stringify(state, null, 2) + '\n');
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* 忽略 */
  }
  return file;
}

// ---------------------------------------------------------------------------
// Key 定义（来自 config.json）
// ---------------------------------------------------------------------------

/**
 * 读取 Key 池。优先用 `api_keys` 数组；没有时退化为单个 `api_key`。
 * @returns {Array<{id:string,key:string,label:string,enabled:boolean,added_at?:string}>}
 */
export function listKeys() {
  const cfg = readConfig();
  const out = [];
  if (Array.isArray(cfg.api_keys)) {
    cfg.api_keys.forEach((item, i) => {
      if (!item) return;
      const key = typeof item === 'string' ? item : String(item.key || '');
      if (!key) return;
      out.push({
        id: (typeof item === 'object' && item.id) || `idx${i}`,
        key,
        label: (typeof item === 'object' && item.label) || `Key ${i + 1}`,
        account: (typeof item === 'object' && item.account) || '',
        enabled: typeof item === 'object' ? item.enabled !== false : true,
        added_at: (typeof item === 'object' && item.added_at) || null,
      });
    });
  }
  if (!out.length && cfg.api_key) {
    out.push({ id: 'default', key: String(cfg.api_key), label: '默认 Key', enabled: true, added_at: null });
  }
  return out;
}

function cooldownMs() {
  const v = Number(readConfig().key_cooldown_ms ?? process.env.ZHUQUE_KEY_COOLDOWN_MS ?? DEFAULT_KEY_COOLDOWN_MS);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_KEY_COOLDOWN_MS;
}

const stateOf = (state, id) =>
  (state.keys[id] ||= {
    used_tokens: 0,
    calls: 0,
    ok: 0,
    fail: 0,
    last_used_at: null,
    last_error: null,
    exhausted_until: null,
    disabled_reason: null,
  });

/** 判断某把 Key 此刻是否可用 */
function availability(entry, st, now) {
  if (!entry.enabled) return { ok: false, reason: 'disabled_by_user' };
  if (st.disabled_reason) return { ok: false, reason: st.disabled_reason };
  if (st.exhausted_until && Date.parse(st.exhausted_until) > now) {
    return { ok: false, reason: 'cooling_down', until: st.exhausted_until };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 选择与记账
// ---------------------------------------------------------------------------

/**
 * 挑一把可用的 Key（轮询，跳过冷却中/被停用/已失效的）。
 * @param {{exclude?:Set<string>, advance?:boolean}} [opts]
 * @returns {{entry:object, masked:string}|null}
 */
export function pickKey(opts = {}) {
  return withFileLock(keyStatePath(), () => {
  const keys = listKeys();
  if (!keys.length) return null;

  const state = readState();
  const now = Date.now();
  const exclude = opts.exclude || new Set();
  const n = keys.length;

  for (let step = 0; step < n; step += 1) {
    const idx = (state.cursor + step) % n;
    const entry = keys[idx];
    if (exclude.has(entry.id)) continue;
    const avail = availability(entry, stateOf(state, entry.id), now);
    if (!avail.ok) continue;
    if (opts.advance !== false) {
      state.cursor = (idx + 1) % n; // 下次从下一把开始，天然轮询
      writeState(state);
    }
    return { entry, masked: maskSecret(entry.key) };
  }
  return null;
  });
}

/** 记录一次成功调用 */
export function noteSuccess(entryId, tokens = 0) {
  return withFileLock(keyStatePath(), () => {
  const state = readState();
  const st = stateOf(state, entryId);
  st.calls += 1;
  st.ok += 1;
  st.used_tokens += Math.max(0, Math.round(Number(tokens) || 0));
  st.last_used_at = new Date().toISOString();
  st.last_error = null;
  if (st.disabled_reason === 'invalid') st.disabled_reason = null; // 又能用了，说明之前是误判
  writeState(state);
  });
}

/**
 * 记录一次失败。
 * @param {string} entryId
 * @param {{code?:string,message?:string,exhaust?:boolean,invalidate?:boolean}} info
 */
export function noteFailure(entryId, info = {}) {
  return withFileLock(keyStatePath(), () => {
  const state = readState();
  const st = stateOf(state, entryId);
  st.calls += 1;
  st.fail += 1;
  st.last_used_at = new Date().toISOString();
  st.last_error = { code: info.code || 'UNKNOWN', message: String(info.message || '').slice(0, 200), at: new Date().toISOString() };

  if (info.invalidate) {
    st.disabled_reason = 'invalid';
    st.exhausted_until = null;
  } else if (info.exhaust) {
    const ms = cooldownMs();
    st.exhausted_until = new Date(Date.now() + ms).toISOString();
    const all = listKeys();
    const account = all.find(k => k.id === entryId)?.account;
    if (account) for (const k of all.filter(k => k.account === account)) stateOf(state, k.id).exhausted_until = st.exhausted_until;
  }
  const file = writeState(state);
  return { state: st, file, cooldown_until: st.exhausted_until };
  });
}

/** 手动重置某把 Key 的冷却与失效标记 */
export function resetKeyState(entryId) {
  return withFileLock(keyStatePath(), () => {
  const state = readState();
  const st = stateOf(state, entryId);
  st.exhausted_until = null;
  st.disabled_reason = null;
  st.last_error = null;
  writeState(state);
  return st;
  });
}

/** 停用 / 启用某把 Key（写回 config.json 的 api_keys；单 key 模式则写 api_key） */
export function setKeyEnabled(entryId, enabled) {
  const cfg = readConfig();
  if (Array.isArray(cfg.api_keys)) {
    let hit = false;
    const next = cfg.api_keys.map((item, i) => {
      const id = (typeof item === 'object' && item.id) || `idx${i}`;
      if (id !== entryId) return item;
      hit = true;
      return { ...(typeof item === 'object' ? item : { key: item, id, label: `Key ${i + 1}` }), enabled: Boolean(enabled) };
    });
    if (!hit) return { updated: false, reason: 'not_found' };
    // 走 writeConfig 以获得同等的校验、备份与 0600 权限（密钥不会被回显）
    const res = writeConfig({ api_keys: next });
    return { updated: true, file: res.file, backup: res.backup };
  }
  return { updated: false, reason: 'only_single_key' };
}

/** 池状态总览：每把 Key 的用量、冷却、错误，以及“当前会用哪一把” */
export function poolStatus() {
  const keys = listKeys();
  const state = readState();
  const now = Date.now();
  const items = keys.map((entry, i) => {
    const st = stateOf(state, entry.id);
    const avail = availability(entry, st, now);
    return {
      index: i,
      id: entry.id,
      label: entry.label,
      account: entry.account || '',
      masked: maskSecret(entry.key),
      enabled: entry.enabled,
      available: avail.ok,
      unavailable_reason: avail.ok ? null : avail.reason,
      cooldown_until: st.exhausted_until,
      cooling_down: Boolean(st.exhausted_until && Date.parse(st.exhausted_until) > now),
      disabled_reason: st.disabled_reason,
      used_tokens: st.used_tokens,
      calls: st.calls,
      ok: st.ok,
      fail: st.fail,
      last_used_at: st.last_used_at,
      last_error: st.last_error,
    };
  });

  const next = pickKey({ advance: false });
  const available = items.filter((k) => k.available).length;

  return {
    count: items.length,
    available_count: available,
    exhausted_count: items.filter((k) => k.unavailable_reason === 'cooling_down').length,
    invalid_count: items.filter((k) => k.unavailable_reason === 'invalid').length,
    disabled_count: items.filter((k) => k.unavailable_reason === 'disabled_by_user').length,
    next_key: next ? { id: next.entry.id, label: next.entry.label, masked: next.masked } : null,
    rotation: '轮询（每次调用自动切到下一把可用的 Key）',
    cooldown_ms: cooldownMs(),
    keys: items,
    storage: { state: keyStatePath() },
  };
}

/** 清空所有 Key 的运行状态（密钥本身不动） */
export function resetAllKeyState() {
  return withFileLock(keyStatePath(), () => {
  const file = writeState(emptyState());
  return { file, ...poolStatus() };
  });
}

/** 把 Key 池写成 config.json 可接受的格式（供 server / cli 复用） */
export function normalizeKeyList(input) {
  if (!Array.isArray(input)) throw new Error('api_keys 必须是数组');
  return input
    .map((item, i) => {
      if (typeof item === 'string') {
        const key = item.trim();
        return key ? { id: newKeyId(), key, label: `Key ${i + 1}`, enabled: true, added_at: new Date().toISOString() } : null;
      }
      if (item && typeof item === 'object') {
        const key = String(item.key || '').trim();
        if (!key) return null;
        return {
          id: item.id || newKeyId(),
          key,
          label: String(item.label || `Key ${i + 1}`),
          account: String(item.account || ''),
          enabled: item.enabled !== false,
          added_at: item.added_at || new Date().toISOString(),
        };
      }
      return null;
    })
    .filter(Boolean);
}
