/**
 * 用量账本：在本地统计每次调用消耗的 Makers 免费额度 token，并推算剩余额度。
 *
 * 为什么是本地统计？
 *   官方并未提供查询 Makers 免费额度的公开 API，控制台「模型用量数据总览」是唯一权威来源。
 *   因此这里按 `makers_models_usage.total_tokens`（官方明确说明：核算免费额度以此字段为准）
 *   逐次累加到本地账本，得到「本机累计已用」，再用「免费额度 - 已用」推算剩余。
 *   如果同一把 Key 还在别处用过，可用 calibrate() 一键对齐控制台读数。
 *
 * 存储：~/.zhuque/usage.json（0600），按「月 → 日」聚合，不会随调用量膨胀。
 */

import fs from 'node:fs';
import { atomicWrite, withFileLock } from './file-store.mjs';
import path from 'node:path';
import { CONFIG_DIR } from './config-store.mjs';

/** 免费版内置模型额度：50 万 token/月 */
const DEFAULT_QUOTA_PER_MONTH = 500000;

/** 上下文中一次计费单元的字符数（上游按每 1000 字符计 1 次调用） */
export const CHARS_PER_BILLING_UNIT = 1000;

function usagePath() {
  return process.env.ZHUQUE_USAGE_FILE || path.join(CONFIG_DIR, 'usage.json');
}

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

function emptyStore() {
  return {
    version: 1,
    quota_per_month: DEFAULT_QUOTA_PER_MONTH,
    cycle_start_day: 1,
    months: {},
    calibration: null,
    last_call_at: null,
    created_at: new Date().toISOString(),
  };
}

function readStore() {
  const file = usagePath();
  try {
    if (!fs.existsSync(file)) return emptyStore();
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return emptyStore();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyStore();
    return { ...emptyStore(), ...parsed, months: parsed.months || {} };
  } catch {
    return emptyStore();
  }
}

function writeStore(store) {
  const file = usagePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, JSON.stringify(store, null, 2) + '\n');
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* 忽略 */
  }
  return file;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * 记录一次调用（一次 detect 可能包含多个分块，用 calls 表示实际请求数）。
 * @param {{billed:number, zhuque?:number, chars?:number, calls?:number, key_mask?:string}} entry
 */
export function recordUsage(entry = {}) {
  return withFileLock(usagePath(), () => {
  const billed = Math.max(0, Math.round(num(entry.billed)));
  const calls = Math.max(1, Math.round(num(entry.calls) || 1));
  const chars = Math.max(0, Math.round(num(entry.chars)));
  const zhuqueTokens = Math.max(0, Math.round(num(entry.zhuque)));

  const store = readStore();
  const now = new Date();
  const mk = monthKey(now);
  const dk = dayKey(now);

  const month = (store.months[mk] ||= { billed: 0, zhuque: 0, calls: 0, chars: 0, days: {} });
  const day = (month.days[dk] ||= { billed: 0, zhuque: 0, calls: 0, chars: 0 });

  month.billed += billed;
  month.zhuque += zhuqueTokens;
  month.calls += calls;
  month.chars += chars;
  day.billed += billed;
  day.zhuque += zhuqueTokens;
  day.calls += calls;
  day.chars += chars;

  store.last_call_at = now.toISOString();
  if (entry.key_mask) store.last_key_mask = entry.key_mask;

  // 只保留最近 14 个月明细，避免文件无限增长
  const keys = Object.keys(store.months).sort();
  while (keys.length > 14) delete store.months[keys.shift()];

  writeStore(store);
  return store;
  });
}

/** 计算当前账期（默认自然月；cycle_start_day 可调，以匹配控制台的周期起点） */
function cycleRange(now = new Date(), startDay = 1) {
  const day = Math.min(31, Math.max(1, Math.round(startDay) || 1));
  const date = (y, m) => new Date(y, m, Math.min(day, new Date(y, m + 1, 0).getDate()));
  let start = date(now.getFullYear(), now.getMonth());
  if (now.getTime() < start.getTime()) start = date(now.getFullYear(), now.getMonth() - 1);
  const end = date(start.getFullYear(), start.getMonth() + 1);
  return { start, end };
}

function sumRange(store, from, to) {
  let billed = 0;
  let calls = 0;
  let chars = 0;
  for (const [mk, month] of Object.entries(store.months)) {
    for (const [dk, day] of Object.entries(month.days || {})) {
      const t = new Date(`${dk}T12:00:00`).getTime();
      if (t >= from.getTime() && t < to.getTime()) {
        billed += num(day.billed);
        calls += num(day.calls);
        chars += num(day.chars);
      }
    }
  }
  return { billed, calls, chars };
}

/**
 * 汇总用量。
 * @param {{now?:Date, days?:number}} [opts]
 */
export function usageSummary(opts = {}) {
  const now = opts.now || new Date();
  const days = Math.max(1, Math.min(60, Math.round(opts.days || 7)));
  const store = readStore();

  const { start, end } = cycleRange(now, store.cycle_start_day);
  const local = sumRange(store, start, end);

  // 校准：把控制台读数与本机累计的差值记为偏移，后续继续本地累加
  const cal = store.calibration && store.calibration.cycle_start === dayKey(start) ? store.calibration : null;
  const offset = cal ? num(cal.offset) : 0;
  const billed = Math.max(0, local.billed + offset);

  const quota = num(store.quota_per_month) || DEFAULT_QUOTA_PER_MONTH;
  const remaining = Math.max(0, quota - billed);
  const usedRatio = quota > 0 ? Math.min(1, billed / quota) : 0;

  const today = sumRange(store, new Date(now.getFullYear(), now.getMonth(), now.getDate()), new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));

  // 近 N 日
  const daily = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const s = sumRange(store, d, new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1));
    daily.push({ date: dayKey(d), billed: s.billed, calls: s.calls });
  }

  // 全部历史
  let totalBilled = 0;
  let totalCalls = 0;
  for (const month of Object.values(store.months)) {
    totalBilled += num(month.billed);
    totalCalls += num(month.calls);
  }

  // 按本周期已过天数估算
  const elapsedDays = Math.max(1, Math.ceil((now.getTime() - start.getTime()) / 86400000));
  const perDay = billed / elapsedDays;
  const cycleDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000));
  const daysLeftInCycle = Math.max(1, Math.round((end.getTime() - now.getTime()) / 86400000));
  // 额度每月重置，所以「可用天数」封顶到本账期剩余天数，避免出现几万天这种无意义数字
  const rawDaysLeft = perDay > 0 ? Math.floor(remaining / perDay) : null;
  const estimatedDaysLeft = rawDaysLeft === null ? null : Math.min(rawDaysLeft, daysLeftInCycle);
  const lastsWholeCycle = rawDaysLeft !== null && rawDaysLeft >= daysLeftInCycle;

  const activeDays = Object.values(store.months)
    .flatMap((m) => Object.values(m.days || {}))
    .filter((d) => num(d.calls) > 0).length;

  return {
    quota_per_month: quota,
    cycle_start_day: store.cycle_start_day,
    cycle: {
      start: dayKey(start),
      end: dayKey(new Date(end.getTime() - 86400000)),
      total_days: cycleDays,
      elapsed_days: elapsedDays,
    },
    used: {
      billed_tokens: billed,
      local_tokens: local.billed,
      calibrated_offset: offset,
      calls: local.calls,
      chars: local.chars,
      ratio: Number(usedRatio.toFixed(4)),
      percent: Number((usedRatio * 100).toFixed(2)),
    },
    remaining: {
      tokens: remaining,
      ratio: Number((quota > 0 ? remaining / quota : 0).toFixed(4)),
      percent: Number((quota > 0 ? (remaining / quota) * 100 : 0).toFixed(2)),
    },
    today: { billed_tokens: today.billed, calls: today.calls },
    average: {
      per_day_tokens: Math.round(perDay),
      per_call_tokens: local.calls ? Math.round(local.billed / local.calls) : 0,
      estimated_days_left: estimatedDaysLeft,
      lasts_whole_cycle: lastsWholeCycle,
      days_left_in_cycle: daysLeftInCycle,
    },
    daily,
    lifetime: { billed_tokens: totalBilled, calls: totalCalls, active_days: activeDays },
    last_call_at: store.last_call_at,
    last_key_mask: store.last_key_mask || null,
    calibration: cal ? { at: cal.at, console_tokens: cal.console_tokens, offset: cal.offset, note: cal.note } : null,
    storage: usagePath(),
    updated_at: new Date().toISOString(),
  };
}

const endOfToday = now => new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

/**
 * 用控制台读数校准：把「控制台已用 - 本机统计已用」记为偏移。
 * @param {number} consoleTokens 控制台显示的周期内已用 token
 */
export function calibrate(consoleTokens, note = '') {
  return withFileLock(usagePath(), () => {
  const n = Number(consoleTokens);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('控制台用量必须是不小于 0 的整数');
  const value = n;
  const store = readStore();
  const now = new Date();
  const { start } = cycleRange(now, store.cycle_start_day);
  const local = sumRange(store, start, endOfToday(now));
  store.calibration = {
    cycle_start: dayKey(start),
    console_tokens: value,
    offset: value - local.billed,
    at: now.toISOString(),
    note: String(note || ''),
  };
  writeStore(store);
  return usageSummary();
  });
}

/** 清掉校准偏移，回到纯本地统计 */
export function clearCalibration() {
  return withFileLock(usagePath(), () => {
  const store = readStore();
  store.calibration = null;
  writeStore(store);
  return usageSummary();
  });
}

/** 调整免费额度与账期起始日 */
export function setQuota({ quota_per_month, cycle_start_day } = {}) {
  return withFileLock(usagePath(), () => {
  const store = readStore();
  if (quota_per_month !== undefined && quota_per_month !== null && quota_per_month !== '') {
    const q = Math.round(num(quota_per_month));
    if (!Number.isFinite(q) || q <= 0) throw new Error('免费额度必须是大于 0 的整数');
    store.quota_per_month = q;
  }
  if (cycle_start_day !== undefined && cycle_start_day !== null && cycle_start_day !== '') {
    const d = Math.round(num(cycle_start_day));
    if (d < 1 || d > 31) throw new Error('账期起始日应在 1~31 之间');
    store.cycle_start_day = d;
    store.calibration = null; // 账期变了，旧校准失效
  }
  writeStore(store);
  return usageSummary();
  });
}

/** 清空本地账本（不影响任何云端数据） */
export function resetUsage() {
  return withFileLock(usagePath(), () => {
  const file = writeStore({ ...emptyStore(), months: {} });
  return { file, summary: usageSummary() };
  });
}
