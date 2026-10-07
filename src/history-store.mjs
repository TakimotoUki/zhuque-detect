/**
 * 检测历史存储
 *
 * 落盘为 JSONL（每行一条记录），append-only，天然抗损坏：即使某一行写坏了，
 * 也只丢那一条，不会毁掉整个库。启动时不做全量加载，查询时才按需扫描。
 *
 * 记录的真实信息包括：总 AI 率、三项分类占比（人工特征/疑似 AI/AI 特征）、
 * 每一段的归属与置信度、命中的 Key、消耗的 token、耗时等，便于后续回溯与降 AI 率对比。
 */

import fs from 'node:fs';
import { atomicWrite, withFileLock } from './file-store.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG_DIR } from './config-store.mjs';

/** 历史文件里最多保留的条数（超出后从头裁剪） */
export const DEFAULT_HISTORY_MAX = 2000;
/**
 * 单条历史里原文最多保存多少字符。**默认 0 = 不限制，完整保存全文。**
 *
 * 为什么默认不截断：历史的核心用途就是「改写前后对比」与「回看某篇的判定明细」，
 * 一旦只存首尾片段，长文就再也回不到原文，等于把记录废掉一半。
 * 需要控制体积的用户可以设 ZHUQUE_HISTORY_TEXT_MAX=<正数> 自行截断
 * （截断时仍会保留 head / tail 首尾片段与 text_truncated 标记）。
 */
const DEFAULT_STORE_TEXT_MAX = 0;

/**
 * 每追加多少次才做一次全量裁剪。
 * trim() 必须把整个历史文件读进来才能数条数，而历史默认完整保存全文，
 * 文件可能到几十 MB —— 逐条裁剪等于每次检测都多读一遍全量历史。
 * 按次数节流后，文件最多临时超出上限 TRIM_EVERY-1 条（可忽略）。
 */
const TRIM_EVERY = 10;
/** 按进程计数的追加次数；进程重启后第一次追加必定触发裁剪，兜住遗留的超标文件 */
let trimCounter = 0;

const envInt = (name, fallback) => {
  const v = Number(process.env[name] ?? fallback);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : fallback;
};

/** 生效的条数上限，可用 ZHUQUE_HISTORY_MAX 覆盖 */
export function historyMax() {
  return envInt('ZHUQUE_HISTORY_MAX', DEFAULT_HISTORY_MAX);
}

/** 生效的「保存全文」字符数上限；返回 0 表示不限制（存全文） */
function storeTextMax() {
  const raw = process.env.ZHUQUE_HISTORY_TEXT_MAX;
  if (raw === undefined || raw === '') return DEFAULT_STORE_TEXT_MAX;
  const v = Number(raw);
  // 显式写 0 / 负数 / 非数字 → 一律理解为「不限制」，避免用户误以为设了上限却还是被截断
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

export function historyPath() {
  return process.env.ZHUQUE_HISTORY_FILE || path.join(CONFIG_DIR, 'history.jsonl');
}

const pad = (n) => String(n).padStart(2, '0');

/** 生成本地时区的可读时间戳，便于排序与展示 */
function localStamp(d = new Date()) {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function newId(d = new Date()) {
  const rand = crypto.randomBytes(4).toString('hex');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${rand}`;
}

function readLines() {
  const file = historyPath();
  if (!fs.existsSync(file)) return [];
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t);
      if (r && typeof r === 'object' && !Array.isArray(r) && typeof r.id === 'string') out.push(r);
    } catch {
      /* 跳过坏行 */
    }
  }
  return out;
}

function writeAll(records) {
  const file = historyPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = records.map((r) => JSON.stringify(r)).join('\n');
  atomicWrite(file, body ? body + '\n' : '');
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* 忽略 */
  }
  return file;
}

function preview(text, max = 160) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

/**
 * 归一化单个三段分类项，确保 percent 始终是 0~100 的百分数。
 * - core.buildCategories 输出 0~100；若调用方使用 ratio 字段，显式换算；percent 始终是百分数。
 */
function normCat(c) {
  if (!c || typeof c !== 'object') return { percent: 0, chars: 0, segments: 0 };
  const raw = Number(c.percent ?? Number(c.ratio ?? 0) * 100);
  const percent = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
  return {
    percent: Number(percent.toFixed(2)),
    chars: Number(c.chars ?? 0),
    segments: Number(c.segments ?? 0),
  };
}

/**
 * 追加一条历史。
 * @param {object} entry detect() 的结果 + 上下文
 * @returns {object|null} 落库后的精简记录
 */
export function appendHistory(entry = {}) {
  return withFileLock(historyPath(), () => {
  const now = new Date();
  const text = typeof entry.text === 'string' ? entry.text : '';
  const limit = storeTextMax();
  const keepText = text.length > 0 && (limit === 0 || text.length <= limit);
  const allSegments = Array.isArray(entry.segments) ? entry.segments : [];

  const cats = entry.categories || {};

  const record = {
    id: entry.id || newId(now),
    at: now.toISOString(),
    at_local: localStamp(now),
    source: entry.source || 'unknown', // web | api | cli | mcp | batch

    chars: text.length,
    is_merge: entry.is_merge !== false,
    chunked: Boolean(entry.chunked),
    chunk_count: entry.chunk_count || 1,

    // —— 核心真实指标 ——
    ai_rate: entry.ai_rate ?? 0,
    ai_rate_percent: Number((((entry.ai_rate ?? 0) * 100)).toFixed(2)),
    human_rate: entry.human_rate ?? 0,
    ai_probability: entry.ai_probability ?? 0,
    risk_score: entry.risk_score ?? 0,
    verdict: entry.verdict || 'unknown',
    verdict_name: entry.verdict_name || '',

    // 三项分类占比（对齐朱雀官网口径）
    // 注意：core.buildCategories 输出的 percent 已经是 0~100 的百分数，此处不要再乘 100。
    // ratio 仅在 percent 缺失时显式换算；0.5% 不能误改成 50%。
    categories: {
      human: normCat(cats.human),
      suspected_ai: normCat(cats.suspected_ai),
      ai: normCat(cats.ai),
      basis: cats.basis || null,
    },

    segment_count: entry.segment_count ?? 0,
    flagged_segment_count: entry.flagged_segment_count ?? 0,

    usage: {
      billed_tokens: entry.usage?.makers_billed_tokens ?? 0,
      zhuque_tokens: entry.usage?.zhuque_total_tokens ?? 0,
    },
    key: { id: entry.key_id || null, label: entry.key_label || null, masked: entry.key_masked || null },
    duration_ms: entry.duration_ms ?? 0,

    preview: preview(text),
    // 默认完整保存原文；只有用户显式设了 ZHUQUE_HISTORY_TEXT_MAX 才可能为 null
    text: keepText ? text : null,
    text_truncated: !keepText && text.length > 0,
    text_limit: limit || null,
    // 未存全文时，保留首尾片段，便于人工辨认是哪一篇
    head: keepText ? null : preview(text.slice(0, 300), 300),
    tail: keepText || text.length <= 600 ? null : preview(text.slice(-300), 300),
    // 分段完整保存（含每段全文），否则历史里无法还原高亮与逐段定位
    segments: keepText ? allSegments : allSegments.map(s => ({ ...s, text: '', excerpt: '' })),
    segments_truncated: !keepText && allSegments.length > 0,
  };

  const file = historyPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
  } catch {
    return null;
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* 忽略 */
  }

  // 每 TRIM_EVERY 次追加才做一次全量裁剪。
  // 为什么不能每次都裁：trim() 必须把整个历史文件读进来才能数条数，而历史现在
  // 默认完整保存全文 —— 文件可能到几十 MB，逐条裁剪等于每次检测都多读一遍全量历史。
  // 代价是文件最多临时超出上限 TRIM_EVERY-1 条，可忽略。
  if (trimCounter++ % TRIM_EVERY === 0) trim(historyMax());
  return record;
  });
}

/** 裁剪到最多 max 条（保留最新的） */
export function trim(max = historyMax()) {
  return withFileLock(historyPath(), () => {
  const all = readLines();
  if (all.length <= max) return { trimmed: 0, total: all.length };
  const kept = all.slice(all.length - max);
  writeAll(kept);
  return { trimmed: all.length - kept.length, total: kept.length };
  });
}

/**
 * 查询历史（返回列表，不含分段明细以控制体积）
 * @param {{limit?:number, offset?:number, q?:string, verdict?:string, category?:string, source?:string, from?:string, to?:string}} [opts]
 */
export function listHistory(opts = {}) {
  const limit = Math.min(500, Math.max(1, Math.round(Number(opts.limit) || 20)));
  const offset = Math.max(0, Math.round(Number(opts.offset) || 0));
  let all = readLines();

  if (opts.verdict) all = all.filter((r) => r.verdict === opts.verdict);
  if (opts.source) all = all.filter((r) => r.source === opts.source);
  if (opts.category) {
    const key = opts.category; // human | suspected_ai | ai
    all = all.filter((r) => (r.categories?.[key]?.percent ?? 0) > 0);
  }
  if (opts.from) {
    const t = Date.parse(opts.from);
    if (Number.isFinite(t)) all = all.filter((r) => Date.parse(r.at) >= t);
  }
  if (opts.to) {
    const t = Date.parse(opts.to);
    if (Number.isFinite(t)) all = all.filter((r) => Date.parse(r.at) <= t);
  }
  if (opts.q) {
    const needle = String(opts.q).toLowerCase();
    all = all.filter((r) => {
      const hay = [r.preview, r.head, r.tail, r.text, r.id, r.key?.label, r.key?.masked].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(needle);
    });
  }

  const total = all.length;
  const desc = all.reverse(); // 最新的在前
  const items = desc.slice(offset, offset + limit).map((r) => {
    const { segments, text, head, tail, ...rest } = r;
    return rest;
  });

  return {
    total,
    limit,
    offset,
    has_more: offset + items.length < total,
    items,
    storage: historyPath(),
    max: historyMax(),
  };
}

export function getHistory(id) {
  if (!id) return null;
  const all = readLines();
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (all[i].id === id) return all[i];
  }
  return null;
}

export function deleteHistory(id) {
  return withFileLock(historyPath(), () => {
  const all = readLines();
  const idx = all.findIndex((r) => r.id === id);
  if (idx === -1) return { deleted: 0 };
  all.splice(idx, 1);
  writeAll(all);
  return { deleted: 1, total: all.length };
  });
}

export function clearHistory() {
  return withFileLock(historyPath(), () => {
  const all = readLines();
  writeAll([]);
  return { deleted: all.length, total: 0 };
  });
}

/** 统计概览：条数、时间范围、平均 AI 率、三段平均占比 */
export function historyStats() {
  const all = readLines();
  if (!all.length) {
    return {
      count: 0,
      file: historyPath(),
      first_at: null,
      last_at: null,
      average: null,
      by_verdict: {},
      by_source: {},
      by_category: null,
    };
  }
  const sum = { ai: 0, human: 0, suspected: 0, aiPercent: 0, humanPercent: 0, suspectedPercent: 0, prob: 0 };
  const byVerdict = Object.create(null);
  const bySource = Object.create(null);
  for (const r of all) {
    sum.ai += r.ai_rate ?? 0;
    sum.prob += r.ai_probability ?? 0;
    // categories.*.percent 已经是 0~100 的百分数，直接累加后取平均，不要再乘 100
    sum.humanPercent += r.categories?.human?.percent ?? 0;
    sum.suspectedPercent += r.categories?.suspected_ai?.percent ?? 0;
    sum.aiPercent += r.categories?.ai?.percent ?? 0;
    byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1;
    bySource[r.source] = (bySource[r.source] || 0) + 1;
  }
  const n = all.length;
  const avg = (v) => Number((v / n).toFixed(2));
  return {
    count: n,
    file: historyPath(),
    first_at: all[0].at,
    last_at: all[n - 1].at,
    average: {
      ai_rate_percent: Number(((sum.ai / n) * 100).toFixed(2)),
      ai_probability_percent: Number(((sum.prob / n) * 100).toFixed(2)),
      human_percent: avg(sum.humanPercent),
      suspected_ai_percent: avg(sum.suspectedPercent),
      ai_percent: avg(sum.aiPercent),
    },
    by_verdict: byVerdict,
    by_source: bySource,
  };
}

/**
 * CSV 单元格转义。
 * 除了双引号翻倍，还要防「公式注入」：以 = + - @ 或制表符开头的单元格
 * 会被 Excel / Numbers 当成公式执行（`=HYPERLINK(...)`、`=cmd|...` 之类），
 * 而 preview 内容来自被检测的文本 —— 可能是从别处粘进来的不可信内容。
 * 做法是前置一个单引号，让它老老实实当文本显示。
 */
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[\s]*[=+\-@]|^[\t\r\n]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** 导出为 JSON（完整明细）或 CSV（列表视图） */
export function exportHistory({ format = 'json', limit = 500 } = {}) {
  const n = Number(limit);
  if (!Number.isSafeInteger(n) || n < 1 || n > 2000) throw new Error('导出数量必须是 1~2000 的整数');
  const all = readLines().slice(-n);
  if (format === 'csv') {
    const header = ['id', 'at', 'source', 'chars', 'ai_rate_percent', 'human_percent', 'suspected_ai_percent', 'ai_percent', 'verdict', 'key_label', 'billed_tokens', 'preview'];
    const rows = all.map((r) => [
      r.id,
      r.at_local,
      r.source,
      r.chars,
      r.ai_rate_percent,
      r.categories?.human?.percent ?? 0,
      r.categories?.suspected_ai?.percent ?? 0,
      r.categories?.ai?.percent ?? 0,
      r.verdict,
      r.key?.label || r.key?.masked || '',
      r.usage?.billed_tokens ?? 0,
      r.preview || '',
    ]);
    return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
  }
  return JSON.stringify(all, null, 2);
}
