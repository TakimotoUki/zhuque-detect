#!/usr/bin/env node
/**
 * zhuque-detect MCP 服务（stdio）
 *
 * 让任意支持 MCP 的 AI Agent（Claude Desktop / Cursor / WorkBuddy / Cline 等）
 * 以原生工具调用的方式使用朱雀 AI 率检测。
 *
 * 协议：JSON-RPC 2.0 over stdio。同时兼容两种分帧：
 *   - 换行分隔（MCP stdio 规范）
 *   - Content-Length 头（LSP 风格，部分老客户端）
 *
 * 零第三方依赖，手写最小实现，避免安装负担。
 */

import process from 'node:process';
import { isMainModule } from './is-main.mjs';
import {
  detect,
  detectBatch,
  ZhuqueError,
  resolveApiKey,
  maskKey,
  apiKeySource,
  resolveEndpoint,
  applyConfigToEnv, loadLocalSettings,
  checkMcpClient,
  VERSION,
  SCHEMA_VERSION,
  MIN_RELIABLE_CHARS,
} from './core.mjs';
import { usageSummary } from './usage-store.mjs';
import { buildSchemaDoc, buildLlmsTxt, AGENT_INSTRUCTIONS } from './schema.mjs';
import { listHistory, getHistory, historyStats } from './history-store.mjs';
import { poolStatus } from './key-pool.mjs';
import { allowedMcpClients, mcpRestrictClients } from './config-store.mjs';

const SERVER_INFO = { name: 'zhuque-detect', version: VERSION };
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** initialize 时判定的客户端准入结果，供后续 tools/call 复用 */
let CLIENT_GATE = { allowed: false, client: '', restricted: mcpRestrictClients(), allowlist: allowedMcpClients() };

const TOOLS = [
  {
    name: 'detect_ai_text',
    title: '检测文本 AI 率（朱雀）',
    description:
      '用腾讯朱雀 AIGC 检测模型判断一段文本的 AI 生成率，并给出逐段归属。返回：' +
      'ai_rate（总 AI 率，0~1）、categories（三段占比：人工特征 human / 疑似 AI suspected_ai / AI 特征 ai，含百分比）、' +
      'segments（每一段的归属类别、置信度 conf、在原文中的 [start,end) 位置与片段原文 excerpt）。' +
      '要降 AI 率时，直接定位 segments 中 label_name 为「AI 特征」「疑似 AI」的段落改写，改完再调用本工具复检，形成闭环。' +
      `文本建议 >= ${MIN_RELIABLE_CHARS} 字，过短时 warnings 会出现 TEXT_TOO_SHORT。`,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: `待检测文本，建议 >= ${MIN_RELIABLE_CHARS} 字` },
        is_merge: {
          type: 'boolean',
          default: true,
          description: 'true（默认）返回整体结果；false 时逐段独立判定，定位更精确',
        },
        include_raw: { type: 'boolean', default: false, description: '是否附带朱雀原始响应，默认 false' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'detect_ai_text_batch',
    title: '批量检测文本 AI 率',
    description: '一次检测多段文本（最多 50 条），返回逐条结果（含三段占比与逐段归属）。适合稿件批量审核。',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          maxItems: 50,
          description: '待检测条目',
          items: {
            type: 'object',
            properties: {
              id: { type: ['string', 'number'], description: '自定义标识，原样回传' },
              text: { type: 'string' },
            },
            required: ['text'],
          },
        },
        is_merge: { type: 'boolean', default: true },
      },
      required: ['items'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_detection_history',
    title: '查询检测历史',
    description:
      '查询本机保存的历史检测记录（含总 AI 率、三段占比与逐段归属）。' +
      '用途：改写文本后对比 AI 率是否下降；找回之前检测过的文本；按类别筛选哪些稿件 AI 特征最重。' +
      '传 id 则返回单条完整明细（含全部分段）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '历史记录 id；传入则返回该条完整明细' },
        limit: { type: 'number', default: 20, description: '返回条数，1~500' },
        offset: { type: 'number', default: 0 },
        q: { type: 'string', description: '关键词过滤（匹配文本预览 / id / Key 标签）' },
        verdict: { type: 'string', description: '按结论筛选：human | mostly_human | mixed | likely_ai | ai' },
        category: { type: 'string', description: '筛选含有该类的记录：human | suspected_ai | ai' },
        source: { type: 'string', description: '按来源筛选：web | api | cli | mcp | batch' },
        stats_only: { type: 'boolean', default: false, description: '只返回统计概览' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_zhuque_usage',
    title: '查询朱雀免费额度与用量',
    description:
      '查询免费的 Makers 内置模型额度（默认 50 万 token/月）在本机累计的使用情况、剩余额度、今日用量与近期趋势，' +
      '并列出 API Key 池里每把 Key 的状态（可用/冷却中/已失效）与当前会使用哪一把。' +
      '在批量检测前用它确认额度是否充足，或检测失败且怀疑额度耗尽时使用。' +
      '注意：官方未开放额度查询 API，此处为按 token 逐次累加的本地统计值。',
    inputSchema: {
      type: 'object',
      properties: { days: { type: 'number', default: 7, description: '返回近几日的用量趋势，1~60' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_zhuque_service_info',
    title: '查询朱雀检测服务信息',
    description:
      '查询本服务的版本、上游接口、API Key 配置状态、Key 池状况与 MCP 客户端白名单，' +
      '以及 ai_rate / categories / segments / verdict 等字段的准确语义。在不确定字段含义或调用失败时使用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const RESOURCES = [
  { uri: 'zhuque://schema', name: '朱雀检测接口完整 Schema', mimeType: 'application/json' },
  { uri: 'zhuque://llms.txt', name: '面向 LLM 的接口说明', mimeType: 'text/plain' },
  { uri: 'zhuque://field-guide', name: '字段语义与判定口径说明', mimeType: 'application/json' },
];

// ---------------------------------------------------------------------------

function textContent(text) {
  return { content: [{ type: 'text', text }] };
}

function toolResult(payload, summary) {
  return {
    content: [{ type: 'text', text: `${summary}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`` }],
    structuredContent: payload,
    isError: false,
  };
}

function toolError(err) {
  const e = err instanceof ZhuqueError
    ? err
    : new ZhuqueError('INTERNAL', String(err?.message || err), '内部错误。', 500);
  return {
    content: [
      {
        type: 'text',
        text: `检测失败 [${e.code}] ${e.message}${e.hint ? `\n建议：${e.hint}` : ''}`,
      },
    ],
    structuredContent: { ok: false, error: e.toJSON() },
    isError: true,
  };
}

function summarize(data) {
  const cats = data.categories || {};
  const lines = [
    `总 AI 率：${data.ai_rate_percent}%（其中 AI 特征 ${cats.ai?.percent ?? 0}% + 疑似 AI ${cats.suspected_ai?.percent ?? 0}%）`,
    `三段占比：人工特征 ${cats.human?.percent ?? 0}% | 疑似 AI ${cats.suspected_ai?.percent ?? 0}% | AI 特征 ${cats.ai?.percent ?? 0}%`,
    `结论：${data.verdict_name}（${data.verdict}）→ ${data.advice}`,
    `模型置信度：${(data.ai_probability * 100).toFixed(2)}% ；共 ${data.segment_count} 段，其中 ${data.flagged_segment_count} 段被判为 AI/疑似 AI`,
  ];
  if (data._meta?.failover) {
    lines.push(`⚠ 本次自动切换过 Key（共尝试 ${data._meta.key_attempts.length} 把，当前用 ${data._meta.key?.masked}）`);
  }
  if (data._meta?.history_id) lines.push(`已存入历史，id=${data._meta.history_id}`);
  if (data.warnings?.length) for (const w of data.warnings) lines.push(`⚠ ${w.message}`);
  const segs = data.segments || [];
  if (segs.length) {
    const flagged = segs.filter((s) => s.label !== 0);
    lines.push('');
    lines.push(`逐段归属（共 ${segs.length} 段；可直接按 position 定位改写）：`);
    for (const s of flagged.slice(0, 12)) {
      lines.push(`  #${s.order} [${s.label_name}] conf=${s.confidence} pos=${(s.global_position || s.position) ? `[${(s.global_position || s.position).join(',')}]` : 'n/a'}  ${(s.excerpt || '').slice(0, 40)}`);
    }
    if (!flagged.length) lines.push('  全部段落均判为「人工特征」');
    else if (flagged.length > 12) lines.push(`  … 另有 ${flagged.length - 12} 段被判为 AI/疑似 AI`);
  }
  return lines.join('\n');
}

/** 历史记录的可读摘要 */
function summarizeHistory(rec) {
  const c = rec.categories || {};
  return `[${rec.at_local}] ${rec.source} · ${rec.chars} 字 · AI 率 ${rec.ai_rate_percent}% · ${rec.verdict_name}\n` +
    `  三段：人工 ${c.human?.percent ?? 0}% / 疑似 AI ${c.suspected_ai?.percent ?? 0}% / AI ${c.ai?.percent ?? 0}% · ${rec.segment_count} 段（${rec.flagged_segment_count} 段标记）\n` +
    `  ${(rec.preview || '').slice(0, 60)}`;
}

async function callTool(name, args = {}) {
  if (name === 'detect_ai_text') {
    if (typeof args.text !== 'string' || !args.text.trim()) {
      throw new ZhuqueError('EMPTY_TEXT', '参数 text 缺失或为空。', '传入待检测的文本字符串。', 400);
    }
    const data = await detect(args.text, {
      isMerge: args.is_merge !== false,
      includeRaw: args.include_raw === true,
      source: 'mcp',
    });
    return toolResult(data, summarize(data));
  }

  if (name === 'detect_ai_text_batch') {
    if (!Array.isArray(args.items) || !args.items.length) {
      throw new ZhuqueError('EMPTY_BATCH', '参数 items 缺失或为空数组。', '传入 [{ id?, text }]，最多 50 条。', 400);
    }
    const res = await detectBatch(args.items, { isMerge: args.is_merge !== false, source: 'mcp' });
    const brief = res.results
      .map((r) =>
        r.ok
          ? `  [${r.id}] AI ${r.data.ai_rate_percent}% · ${r.data.verdict_name}（人工 ${r.data.categories?.human?.percent ?? 0}% / 疑似 ${r.data.categories?.suspected_ai?.percent ?? 0}% / AI ${r.data.categories?.ai?.percent ?? 0}%）`
          : `  [${r.id}] 失败 ${r.error.code}`
      )
      .join('\n');
    return toolResult(res, `批量完成：成功 ${res.succeeded} / 失败 ${res.failed}（共 ${res.count}）\n${brief}`);
  }

  if (name === 'get_detection_history') {
    if (args.id) {
      const rec = getHistory(String(args.id));
      if (!rec) throw new ZhuqueError('HISTORY_NOT_FOUND', `未找到历史记录 ${args.id}`, '用 get_detection_history 不带 id 查看列表。', 404);
      return toolResult(rec, summarizeHistory(rec));
    }
    if (args.stats_only) {
      const st = historyStats();
      const lines = st.count
        ? [
            `共 ${st.count} 条检测记录（${st.first_at?.slice(0, 19)} → ${st.last_at?.slice(0, 19)}）`,
            `平均 AI 率：${st.average.ai_rate_percent}% · 平均人工特征占比 ${st.average.human_percent}% · 平均疑似 AI ${st.average.suspected_ai_percent}%`,
            `按结论分布：${Object.entries(st.by_verdict).map(([k, v]) => `${k}=${v}`).join(' · ')}`,
            `按来源分布：${Object.entries(st.by_source).map(([k, v]) => `${k}=${v}`).join(' · ')}`,
            `存储：${st.file}`,
          ]
        : ['暂无检测历史。先调用 detect_ai_text 检测一次即可。', `存储路径：${st.file}`];
      return toolResult(st, lines.join('\n'));
    }
    const res = listHistory({
      limit: args.limit,
      offset: args.offset,
      q: args.q,
      verdict: args.verdict,
      category: args.category,
      source: args.source,
    });
    const lines = res.items.length
      ? [
          `共 ${res.total} 条匹配（显示第 ${res.offset + 1}~${res.offset + res.items.length} 条）`,
          ...res.items.map((r) => summarizeHistory(r)),
          res.has_more ? `… 还有更多，用 offset 翻页。` : '',
        ].filter(Boolean)
      : ['没有匹配的检测历史。'];
    return toolResult(res, lines.join('\n'));
  }

  if (name === 'get_zhuque_usage') {
    const s = usageSummary({ days: Number(args.days || 7) });
    let pool = null;
    try {
      pool = poolStatus();
    } catch {
      /* 忽略 */
    }
    const lines = [
      `免费额度：${s.quota_per_month.toLocaleString()} token/月（账期 ${s.cycle.start} → ${s.cycle.end}）`,
      `已用：${s.used.billed_tokens.toLocaleString()} token（${s.used.percent}%）`,
      `剩余：${s.remaining.tokens.toLocaleString()} token（${s.remaining.percent}%）`,
      `今日：${s.today.billed_tokens.toLocaleString()} token / ${s.today.calls} 次调用`,
      s.average.estimated_days_left !== null
        ? s.average.lasts_whole_cycle
          ? `按当前日均 ${s.average.per_day_tokens.toLocaleString()} token 推算，本周期内额度充足`
          : `按当前日均 ${s.average.per_day_tokens.toLocaleString()} token 推算，还可使用约 ${s.average.estimated_days_left} 天`
        : '尚无足够数据推算可用天数',
    ];
    if (pool && pool.count) {
      lines.push('');
      lines.push(`Key 池：${pool.count} 把，可用 ${pool.available_count} 把${pool.next_key ? `，下一把将用 ${pool.next_key.label}(${pool.next_key.masked})` : ''}`);
      for (const k of pool.keys) {
        lines.push(
          `  · ${k.label} ${k.masked} — ${k.available ? '可用' : `不可用(${k.unavailable_reason})`} · 已用 ${k.used_tokens} token · 成功 ${k.ok}/失败 ${k.fail}`
        );
      }
    }
    lines.push('');
    lines.push('以上为本地累计统计值；权威数据请看 EdgeOne 控制台的模型用量总览。');
    return toolResult({ ...s, key_pool: pool }, lines.join('\n'));
  }

  if (name === 'get_zhuque_service_info') {
    const doc = buildSchemaDoc();
    const key = resolveApiKey();
    const usage = usageSummary();
    let pool = null;
    try {
      pool = poolStatus();
    } catch {
      /* 忽略 */
    }
    const payload = {
      ...doc,
      runtime: {
        version: VERSION,
        schema_version: SCHEMA_VERSION,
        endpoint: resolveEndpoint(),
        api_key: key ? { configured: true, masked: maskKey(key), source: apiKeySource() } : { configured: false },
        min_reliable_chars: MIN_RELIABLE_CHARS,
        key_pool: pool ? { count: pool.count, available_count: pool.available_count, next_key: pool.next_key } : null,
        mcp_client: { name: CLIENT_GATE.client, allowed: CLIENT_GATE.allowed, restricted: CLIENT_GATE.restricted, allowlist: CLIENT_GATE.allowlist },
        usage: {
          quota_per_month: usage.quota_per_month,
          used_tokens: usage.used.billed_tokens,
          remaining_tokens: usage.remaining.tokens,
          used_percent: usage.used.percent,
          cycle_end: usage.cycle.end,
        },
      },
    };
    const lines = [
      `服务 zhuque-detect v${VERSION}`,
      `上游 ${doc.upstream.provider} · ${doc.upstream.model}`,
      key ? `API Key 已配置（${maskKey(key)}，来源 ${apiKeySource()}）` : '⚠ API Key 未配置：请启动网页服务后在「设置」中填写，或设 ZHUQUE_API_KEY',
      pool && pool.count ? `Key 池：${pool.count} 把，可用 ${pool.available_count} 把${pool.next_key ? `，下一把 ${pool.next_key.masked}` : ''}` : 'Key 池：未启用（仅单 Key）',
      `调用方：${CLIENT_GATE.client || '未识别'}${CLIENT_GATE.restricted ? `（白名单：${(CLIENT_GATE.allowlist || []).join('/')}）` : '（未启用白名单）'}`,
      `额度：已用 ${usage.used.billed_tokens.toLocaleString()} / ${usage.quota_per_month.toLocaleString()} token，剩余 ${usage.remaining.tokens.toLocaleString()}（${usage.remaining.percent}%）`,
      '',
      '字段语义速查：',
      `  ai_rate        0~1，AI 率 = AI 特征 + 疑似 AI 占比（主指标）`,
      `  categories     三段占比：human 人工特征 / suspected_ai 疑似 AI / ai AI 特征，各含 percent`,
      `  segments       逐段归属，含 label_name、confidence、position，是降 AI 率的定位依据`,
      `  ai_probability 0~1，模型整体置信度，越大越可能命中风险`,
      `  verdict        human | mostly_human | mixed | likely_ai | ai`,
    ];
    return toolResult(payload, lines.join('\n'));
  }

  throw new ZhuqueError('UNKNOWN_TOOL', `未知工具 ${name}`, '可用工具见 tools/list。', 404);
}

function readResource(uri) {
  if (uri === 'zhuque://schema') {
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(buildSchemaDoc(), null, 2) }] };
  }
  if (uri === 'zhuque://llms.txt') {
    return { contents: [{ uri, mimeType: 'text/plain', text: buildLlmsTxt('http://127.0.0.1:8787') }] };
  }
  if (uri === 'zhuque://field-guide') {
    const doc = buildSchemaDoc(); // 只构建一次，别为三个字段各建一遍整份文档
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              field_guide: doc.endpoints['POST /api/detect'].response,
              labels: doc.labels,
              verdicts: doc.verdicts,
              agent_instructions: AGENT_INSTRUCTIONS,
            },
            null,
            2
          ),
        },
      ],
    };
  }
  throw new ZhuqueError('RESOURCE_NOT_FOUND', `未知资源 ${uri}`, '可用资源见 resources/list。', 404);
}

let initialized = false;
function handle(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });

  if (isNotification && !method.startsWith('notifications/')) return null;
  if (!['initialize', 'ping'].includes(method) && !method.startsWith('notifications/') && !initialized) return fail(-32002, 'Server not initialized');
  if (initialized && !CLIENT_GATE.allowed && !['initialize', 'ping', 'tools/call'].includes(method) && !method.startsWith('notifications/')) return fail(-32001, 'MCP_CLIENT_FORBIDDEN');
  switch (method) {
    case 'initialize': {
      if (initialized) return fail(-32600, 'Already initialized');
      initialized = true;
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
      // 客户端准入：默认只放行 WorkBuddy 与 Codex
      CLIENT_GATE = checkMcpClient(params);
      process.stderr.write(
        `[zhuque-detect] MCP 客户端 ${CLIENT_GATE.client || '(未识别)'} → ${CLIENT_GATE.allowed ? '允许' : '拒绝'}${CLIENT_GATE.restricted ? `（白名单 ${(CLIENT_GATE.allowlist || []).join('/')}）` : ''}\n`
      );
      return reply({
        protocolVersion,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: SERVER_INFO,
        instructions: CLIENT_GATE.allowed
          ? '朱雀 AIGC 文本检测。用 detect_ai_text 检测一段文本的 AI 率，返回总 AI 率、三段占比（人工特征/疑似 AI/AI 特征）' +
            '与逐段归属（label_name + position）。按 segments 定位 AI 特征段落改写后再次检测，形成「检测→改写→复检」闭环；' +
            '用 get_detection_history 回查历次结果做前后对比。'
          : `本 MCP 服务仅允许以下客户端调用：${(CLIENT_GATE.allowlist || []).join('、')}。当前客户端「${CLIENT_GATE.client || '未知'}」不在白名单内，' +
            '所有工具调用都会被拒绝。如需放行，请在 ~/.zhuque/config.json 中调整 mcp_allowed_clients。`,
      });
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/roots/list_changed':
      return null;

    case 'ping':
      return reply({});

    case 'tools/list':
      return reply({ tools: TOOLS });

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (!args || typeof args !== 'object' || Array.isArray(args)) return fail(-32602, 'arguments must be an object');
      // 白名单门禁：非授权客户端一律拒绝，且不消耗任何额度
      if (!CLIENT_GATE.allowed) {
        return reply(
          toolError(
            new ZhuqueError(
              'MCP_CLIENT_FORBIDDEN',
              `客户端「${CLIENT_GATE.client || '未知'}」不在允许名单内，已拒绝调用。`,
              `本服务仅允许 ${(CLIENT_GATE.allowlist || []).join('、')} 调用。要放行请修改 ~/.zhuque/config.json 的 mcp_allowed_clients。`,
              403
            )
          )
        );
      }
      return callTool(name, args)
        .then((r) => reply(r))
        .catch((err) => reply(toolError(err)));
    }

    case 'resources/list':
      return reply({ resources: RESOURCES });

    case 'resources/read': {
      try {
        return reply(readResource(params?.uri));
      } catch (err) {
        return fail(-32602, err.message);
      }
    }

    case 'prompts/list':
      return reply({ prompts: [] });

    default:
      if (isNotification) return null;
      return fail(-32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// stdio 分帧
// ---------------------------------------------------------------------------

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

export function startMcpServer() {
  loadLocalSettings();
  applyConfigToEnv();
  let buf = Buffer.alloc(0);
  const pending = new Set();
  let ended = false;
  const dispatch = raw => {
    const task = onMessage(raw);
    pending.add(task);
    task.finally(() => { pending.delete(task); if (ended && !pending.size) process.exitCode = 0; });
  };

  const onMessage = async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    try {
      const out = await handle(msg);
      if (out) write(out);
    } catch (err) {
      write({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: String(err?.message || err) } });
    }
  };

  process.stdin.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > 4 * 1024 * 1024) {
      write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'MCP frame exceeds 4MB' } });
      process.stdin.destroy(); buf = Buffer.alloc(0); process.exitCode = 1; return;
    }
    for (;;) {
      // Content-Length 分帧
      if (buf.subarray(0, 15).toString('ascii').toLowerCase().startsWith('content-length')) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const header = buf.subarray(0, idx).toString('ascii');
        const m = header.match(/content-length:\s*(\d+)/i);
        if (!m) {
          buf = buf.subarray(idx + 4);
          continue;
        }
        const len = Number(m[1]);
        if (!Number.isSafeInteger(len) || len > 4 * 1024 * 1024) { process.stdin.destroy(); process.exitCode = 1; return; }
        const start = idx + 4;
        if (buf.length < start + len) return;
        const body = buf.subarray(start, start + len).toString('utf8');
        buf = buf.subarray(start + len);
        dispatch(body);
        continue;
      }
      // 换行分帧
      const nl = buf.indexOf(0x0a);
      if (nl === -1) return;
      const line = buf.subarray(0, nl).toString('utf8').trim();
      buf = buf.subarray(nl + 1);
      if (line) dispatch(line);
    }
  });

  process.stdin.on('end', () => {
    ended = true;
    if (buf.length) { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Incomplete frame at EOF' } }); buf = Buffer.alloc(0); }
    if (!pending.size) process.exitCode = 0;
  });
  // 日志一律走 stderr，避免污染 stdout 的 JSON-RPC 通道
  process.stderr.write(`[zhuque-detect] MCP 服务就绪 v${VERSION}\n`);
  return Promise.resolve();
}

if (isMainModule(import.meta.url)) startMcpServer();
