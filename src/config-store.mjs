/**
 * 配置存储：把 API Key 与各项设置统一落到 ~/.zhuque/config.json
 *
 * 设计要点：
 *   1. 配置文件是「用户级」的，所有项目共享；也可用 ZHUQUE_CONFIG_FILE 指定别处（便于测试）。
 *   2. 文件含密钥，落盘权限强制 0600。
 *   3. 每次写入前自动备份为 config.json.bak-<时间戳>。
 *   4. 字段与同名环境变量的优先级：环境变量优先，但界面会明确标注「当前生效来源」，
 *      避免出现「我在界面里填了 Key 却不生效」的黑盒。
 */

import fs from 'node:fs';
import { atomicWrite, withFileLock } from './file-store.mjs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const CONFIG_DIR = path.join(os.homedir(), '.zhuque');

/** 配置文件路径（允许用 ZHUQUE_CONFIG_FILE 覆盖，测试与多实例场景用） */
export function configPath() {
  return process.env.ZHUQUE_CONFIG_FILE || path.join(CONFIG_DIR, 'config.json');
}

/**
 * 支持的字段。env 表示该字段对应的环境变量（用于冲突检测与注入）。
 * restart 表示改完需要重启服务才生效。
 */
export const FIELDS = {
  api_key: { env: null, label: '朱雀 API Key', type: 'secret', restart: false },
  api_keys: { env: null, label: 'API Key 池（多把自动轮换）', type: 'keylist', restart: false },
  key_cooldown_ms: { env: null, label: 'Key 耗尽后的冷却时间（毫秒）', type: 'int', restart: false },
  endpoint: { env: 'ZHUQUE_ENDPOINT', label: '上游接口地址', type: 'url', restart: false },
  timeout_ms: { env: 'ZHUQUE_TIMEOUT_MS', label: '请求超时（毫秒）', type: 'int', restart: false },
  max_chars: { env: 'ZHUQUE_MAX_CHARS', label: '单块最大字符数', type: 'int', restart: false },
  cache_ttl_ms: { env: 'ZHUQUE_CACHE_TTL_MS', label: '结果缓存有效期（毫秒）', type: 'int', restart: false },
  mcp_restrict_clients: { env: null, label: '限制 MCP 客户端（仅白名单可调用）', type: 'bool', restart: false },
  mcp_allowed_clients: { env: null, label: 'MCP 允许的客户端名单', type: 'strlist', restart: false },
  server_token: { env: 'ZHUQUE_SERVER_TOKEN', label: '服务访问令牌', type: 'secret', restart: true },
  allowed_origins: { env: 'ZHUQUE_ALLOWED_ORIGINS', label: '允许跨站访问的来源（逗号分隔，留空则只允许本机页面）', type: 'strlist', restart: false },
  port: { env: null, label: '服务端口', type: 'int', restart: true },
  host: { env: null, label: '监听地址', type: 'string', restart: true },
  auto_open: { env: null, label: '启动后自动打开浏览器', type: 'bool', restart: false },
};

/** MCP 默认只放行 WorkBuddy 与 Codex */
export const DEFAULT_ALLOWED_MCP_CLIENTS = ['workbuddy', 'codex'];

/** 密钥掩码：全项目唯一实现（core.maskKey / key-pool 都复用它） */
export function maskSecret(value) {
  if (!value) return '';
  const s = String(value);
  if (s.length <= 10) return s.slice(0, 2) + '***';
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

/** 读取配置；文件损坏或不存在都返回 {}，绝不抛错 */
export function readConfig() {
  const file = configPath();
  try {
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export class ConfigError extends Error {
  constructor(message, hint = '') {
    super(message);
    this.name = 'ConfigError';
    this.hint = hint;
  }
}

/** 校验并规范化单个字段；返回 null 表示「删除该字段」 */
export function coerceField(name, value) {
  const meta = Object.hasOwn(FIELDS, name) ? FIELDS[name] : null;
  if (!meta) throw new ConfigError(`不支持的配置字段：${name}`, `可用字段：${Object.keys(FIELDS).join(', ')}`);

  if (value === null || value === undefined || value === '') return null;

  switch (meta.type) {
    case 'int': {
      const n = Number(value);
      if (!Number.isFinite(n) || n < (name === 'cache_ttl_ms' ? 0 : 1) || !Number.isSafeInteger(n)) {
        throw new ConfigError(`${meta.label} 必须是不小于 1 的整数，收到：${value}`, '请填写纯数字。');
      }
      if (name === 'port' && (n < 1 || n > 65535)) {
        throw new ConfigError(`端口超出范围：${n}`, '端口范围是 1~65535。');
      }
      const upper = { max_chars: 20000, timeout_ms: 300000, cache_ttl_ms: 86400000, key_cooldown_ms: 86400000 }[name];
      if (upper && n > upper) throw new ConfigError(`${meta.label} 超过上限 ${upper}`);
      return n;
    }
    case 'url': {
      const s = String(value).trim();
      let u;
      try {
        u = new URL(s);
      } catch {
        throw new ConfigError(`${meta.label} 不是合法 URL：${s}`, '示例：https://ai-gateway.edgeone.link/v1/providers/zhuque-text/classify');
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new ConfigError(`${meta.label} 只支持 http / https`, '');
      }
      if (u.username || u.password || u.hash) throw new ConfigError('接口 URL 不允许内嵌凭据或片段');
      if (u.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new ConfigError('远程接口必须使用 HTTPS');
      return s;
    }
    case 'bool': {
      if (typeof value === 'boolean') return value;
      const s = String(value).toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(s)) return true;
      if (['0', 'false', 'no', 'off'].includes(s)) return false;
      throw new ConfigError(`${meta.label} 需要 true / false，收到：${value}`, '');
    }
    case 'secret': {
      const s = String(value).trim();
      if (/[^\x21-\x7E]/.test(s)) {
        throw new ConfigError(`${meta.label} 不应包含空格或换行`, '请检查是否粘贴时多带了字符。');
      }
      return s;
    }
    case 'keylist': {
      if (!Array.isArray(value)) {
        throw new ConfigError(`${meta.label} 必须是数组`, '示例：[{"key":"sk-xxx","label":"主号"}]');
      }
      // 已有池：用于「不带 key 则沿用原密钥」的增量保存（界面只回传掩码）
      const existing = Array.isArray(readConfig().api_keys) ? readConfig().api_keys : [];
      const byId = new Map(existing.map((k, i) => [k.id || `idx${i}`, k]));

      if (value.length > 100) throw new ConfigError('Key 池最多保存 100 把 Key');
      const out = [];
      const ids = new Set();
      value.forEach((item, i) => {
        let key = '';
        let label = `Key ${i + 1}`;
        let id = '';
        let account = '';
        let enabled = true;
        let addedAt = new Date().toISOString();
        if (typeof item === 'string') {
          key = item.trim();
        } else if (item && typeof item === 'object') {
          key = String(item.key || '').trim();
          if (item.label) label = String(item.label);
          if (item.id) id = String(item.id);
          account = String(item.account || '').trim().slice(0, 120);
          enabled = item.enabled !== false;
          if (item.added_at) addedAt = item.added_at;
        }
        // 未提供 key（界面只回传掩码）时，按 id 沿用原密钥
        if (!key && id && byId.has(id)) {
          const prev = byId.get(id);
          key = String(prev.key || '').trim();
          if (prev.added_at) addedAt = prev.added_at;
          account ||= String(prev.account || '');
        }
        if (!key) return;
        if (/[^\x21-\x7E]/.test(key)) throw new ConfigError(`第 ${i + 1} 把 Key 含空格或换行`, '请检查是否粘贴多了字符。');
        id = id || `k${crypto.randomBytes(8).toString('hex')}`;
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || ids.has(id)) throw new ConfigError('Key id 必须唯一，且只能含字母、数字、下划线或短横线');
        ids.add(id);
        out.push({ id, key, label: label.slice(0, 120), account, enabled, added_at: addedAt });
      });
      return out.length ? out : null;
    }
    case 'strlist': {
      const arr = Array.isArray(value) ? value : String(value).split(',');
      const out = arr.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
      return out.length ? [...new Set(out)] : null;
    }
    default: {
      const s = String(value).trim();
      if (!s) return null;
      return s;
    }
  }
}

/**
 * 写入配置（合并式）。
 * @param {object} patch 需要更新的字段；值为 null / '' 表示删除
 * @returns {{saved:object, backup:string|null, file:string}}
 */
export function writeConfig(patch = {}) {
  return withFileLock(configPath(), () => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ConfigError('配置必须是对象');
  const file = configPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  const current = readConfig();
  const next = { ...current };

  for (const [key, value] of Object.entries(patch)) {
    if (key === 'clear' || key === 'restart_required') continue;
    const normalized = coerceField(key, value);
    if (normalized === null) delete next[key];
    else next[key] = normalized;
  }

  // 支持 { clear: { api_key: true } } 形式
  if (patch.clear && typeof patch.clear === 'object') {
    for (const key of Object.keys(patch.clear)) {
      if (patch.clear[key]) delete next[key];
    }
  }

  let backup = null;
  if (fs.existsSync(file)) {
    backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, backup);
    try {
      fs.chmodSync(backup, 0o600);
    } catch {
      /* Windows 等平台不支持 POSIX 权限位，忽略 */
    }
  }

  // 含密钥，权限收紧到仅本人可读写
  atomicWrite(file, JSON.stringify(next, null, 2) + '\n');
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* 某些文件系统不支持，忽略 */
  }

  const backups = fs.readdirSync(dir).filter(n => n.startsWith(path.basename(file) + '.bak-')).sort();
  for (const old of backups.slice(0, -5)) fs.unlinkSync(path.join(dir, old));
  return { saved: next, backup, file };
  });
}

const injectedEnv = new Map();

/** 把配置注入 process.env（供 core.mjs 中读环境变量的部分使用） */
export function applyConfigToEnv({ override = false } = {}) {
  const cfg = readConfig();
  const applied = [];
  const skipped = [];
  for (const [key, meta] of Object.entries(FIELDS)) {
    if (!meta.env) continue;
    const value = cfg[key];
    const existing = process.env[meta.env];
    const injected = injectedEnv.has(meta.env) && existing === injectedEnv.get(meta.env);
    if (value === undefined || value === null || value === '') {
      if (injected) { delete process.env[meta.env]; injectedEnv.delete(meta.env); }
      continue;
    }
    if (!injected && existing !== undefined && existing !== '') {
      skipped.push({ field: key, env_var: meta.env, existing: existing === '' ? '' : maskSecret(existing) });
      continue;
    }
    process.env[meta.env] = Array.isArray(value) ? value.join(',') : String(value);
    injectedEnv.set(meta.env, process.env[meta.env]);
    applied.push({ field: key, env_var: meta.env });
  }
  return { applied, skipped };
}

/** 列出「环境变量 vs 配置文件」的冲突项（用于界面提示） */
export function envConflicts() {
  const cfg = readConfig();
  const out = [];
  for (const [key, meta] of Object.entries(FIELDS)) {
    if (!meta.env) continue;
    const envValue = process.env[meta.env];
    const cfgValue = cfg[key];
    if (!envValue || injectedEnv.get(meta.env) === envValue) continue;
    const isSecret = meta.type === 'secret';
    const same = isSecret
      ? envValue === String(cfgValue ?? '')
      : String(envValue) === String(cfgValue ?? '');
    out.push({
      field: key,
      label: meta.label,
      env_var: meta.env,
      env_value: isSecret ? maskSecret(envValue) : String(envValue),
      config_value: cfgValue === undefined ? null : isSecret ? maskSecret(cfgValue) : String(cfgValue),
      overrides_saved: cfgValue !== undefined && !same,
      note: cfgValue === undefined
        ? `来自环境变量 ${meta.env}，界面未保存该项`
        : same
          ? `环境变量 ${meta.env} 与界面保存的值一致`
          : `环境变量 ${meta.env} 优先级更高，界面保存的值当前不生效`,
    });
  }
  return out;
}

/** 汇总当前生效状态，供界面展示 */
export function describeConfig({ envSource = null } = {}) {
  const cfg = readConfig();
  const file = configPath();

  // api_key 单独处理：它的来源优先级由 core.resolveApiKey 决定
  const effectiveKey = envSource || (cfg.api_key ? `file:${file}` : 'none');

  const saved = {};
  for (const [key, meta] of Object.entries(FIELDS)) {
    if (cfg[key] === undefined) continue;
    if (meta.type === 'secret') {
      saved[key] = maskSecret(cfg[key]);
    } else if (meta.type === 'keylist') {
      // 池里的密钥一律只回传掩码
      saved[key] = (Array.isArray(cfg[key]) ? cfg[key] : []).map((item, i) => ({
        id: item.id || `idx${i}`,
        label: item.label || `Key ${i + 1}`,
        enabled: item.enabled !== false,
        masked: maskSecret(item.key),
      }));
    } else {
      saved[key] = cfg[key];
    }
  }

  return {
    config_file: file,
    config_dir: path.dirname(file),
    exists: fs.existsSync(file),
    saved,
    env_conflicts: envConflicts(),
    effective: {
      api_key: {
        configured: effectiveKey !== 'none',
        source: effectiveKey,
        note: effectiveKey === 'none'
          ? '尚未配置，请在下方填写并保存'
          : effectiveKey.startsWith('env:') || effectiveKey.startsWith('dotenv:')
            ? '当前生效的是环境变量；界面保存的值优先级更低'
            : '当前使用界面保存的值',
      },
    },
  };
}

/** MCP 允许的客户端名单（默认仅 WorkBuddy 与 Codex） */
export function allowedMcpClients() {
  const cfg = readConfig();
  const list = Array.isArray(cfg.mcp_allowed_clients) && cfg.mcp_allowed_clients.length
    ? cfg.mcp_allowed_clients
    : DEFAULT_ALLOWED_MCP_CLIENTS;
  return list.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
}

/** 是否启用 MCP 客户端白名单（默认启用） */
export function mcpRestrictClients() {
  const cfg = readConfig();
  return cfg.mcp_restrict_clients !== false;
}

/**
 * 判断某个 MCP 客户端名是否被允许。
 * 用「包含」匹配以兼容各种写法：workbuddy、WorkBuddy、codex-cli、openai-codex…
 */
export function isMcpClientAllowed(rawName) {
  const name = String(rawName || '').trim().toLowerCase();
  if (!name) return { allowed: false, reason: 'missing_client_info' };
  const allow = allowedMcpClients();
  const tokens = name.split(/[-_.\s]+/);
  const hit = allow.find(a => name === a || tokens.includes(a));
  return hit ? { allowed: true, matched: hit } : { allowed: false, reason: 'not_in_allowlist', allowlist: allow };
}
