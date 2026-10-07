/**
 * 机器可读的接口描述（供 AI Agent 自发现使用）
 *
 * 输出的内容同时用于：
 *   - CLI:  zhuque schema
 *   - HTTP: GET /api/schema
 *   - MCP:  resource  zhuque://schema
 */

import { resolveEndpoint, LABELS, CATEGORIES, VERDICTS, SCHEMA_VERSION, VERSION, MIN_RELIABLE_CHARS } from './core.mjs';
import { DEFAULT_ALLOWED_MCP_CLIENTS } from './config-store.mjs';
import { DEFAULT_HISTORY_MAX } from './history-store.mjs';

const DETECT_REQUEST_SCHEMA = {
  type: 'object',
  required: ['text'],
  additionalProperties: false,
  properties: {
    text: { type: 'string', minLength: 1, description: '待检测文本；建议 >= 120 字以提高准确率' },
    is_merge: {
      type: 'boolean',
      default: true,
      description: 'true（默认）= 合并段落输出整体结果；false = 每个段落独立输出置信度，便于精确定位',
    },
    cache: { type: 'boolean', default: true },
    auto_chunk: { type: 'boolean', default: true },
    max_chars: { type: 'integer', minimum: 2, maximum: 20000 },
    timeout_ms: { type: 'integer', minimum: 1, maximum: 300000 },
    include_raw: { type: 'boolean', default: false },
    history: { type: 'boolean', default: true },
    source: { type: 'string' },
    id: { type: ['string', 'number'], description: '可选，调用方自定义标识，原样回传' },
  },
};

const BATCH_REQUEST_SCHEMA = {
  type: 'object',
  required: ['items'],
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      maxItems: 50,
      description: '批量条目，最多 50 条',
      items: {
        type: 'object',
        required: ['text'],
        properties: { id: { type: ['string', 'number'] }, text: { type: 'string' } },
      },
    },
    is_merge: { type: 'boolean', default: true },
  },
};

const DETECT_RESPONSE_SCHEMA = {
  type: 'object',
  description: '检测结果（HTTP 接口外层再包一层 { ok, data, error }）',
  properties: {
    ai_rate: { type: 'number', description: 'AI 率 [0,1]：文本中被判定为 AI 或疑似 AI 的占比，即通常所说的"AI 率"' },
    ai_rate_percent: { type: 'number', description: 'AI 率的百分数形式，如 87.5' },
    human_rate: { type: 'number', description: '人工内容占比 [0,1]' },
    composition: {
      type: 'object',
      description: '标签占比拆分（朱雀 labels_ratio 原始口径：0/1/2 三档）',
      properties: {
        human: { type: 'number', description: '人工特征 (label 0)' },
        suspected_ai: { type: 'number', description: '疑似 AI (label 1)' },
        ai: { type: 'number', description: 'AI 特征 (label 2)' },
      },
    },
    ai_probability: { type: 'number', description: '模型整体置信度 [0,1]，越大越可能命中风险（对应 softmax_confidence）' },
    risk_rate: { type: 'number', description: '整体疑似风险内容占比 [0,1]（对应 ratio_confidence）' },
    risk_score: { type: 'number', description: '综合风险分 [0,1] = max(ai_rate, ai_probability)，结论由此推出' },
    categories: {
      type: 'object',
      description:
        '三段占比（与朱雀官网一致：人工特征 / 疑似 AI / AI 特征）。每项含 percent（百分数）、ratio、chars（字符数）、segments（段数）。basis=segment_chars 表示按逐段字符数统计，labels_ratio 表示上游只给了整体占比。',
      properties: {
        basis: { type: 'string', enum: ['segment_chars', 'labels_ratio'] },
        human: { type: 'object', properties: { percent: { type: 'number' }, ratio: { type: 'number' }, chars: { type: 'number' }, segments: { type: 'number' } } },
        suspected_ai: { type: 'object', properties: { percent: { type: 'number' }, ratio: { type: 'number' }, chars: { type: 'number' }, segments: { type: 'number' } } },
        ai: { type: 'object', properties: { percent: { type: 'number' }, ratio: { type: 'number' }, chars: { type: 'number' }, segments: { type: 'number' } } },
      },
    },
    verdict: {
      type: 'string',
      enum: VERDICTS.map((v) => v.key),
      description: '结论枚举：human < mostly_human < mixed < likely_ai < ai',
    },
    verdict_name: { type: 'string', description: '结论中文名' },
    advice: { type: 'string', description: '处置建议' },
    segment_count: { type: 'number', description: '分段总数' },
    flagged_segment_count: { type: 'number', description: '被判为 AI/疑似 AI 的分段数' },
    ai_char_count: { type: 'number', description: '被标记片段的字符数合计' },
    flagged_segments: {
      type: 'array',
      description: '被判为 AI / 疑似 AI 的片段（label != 0）。Agent 可直接按 position 定位原文并改写，改完后再次调用检测形成闭环。',
      items: {
        type: 'object',
        properties: {
          order: { type: 'number' },
          label: { type: 'number', enum: [0, 1, 2] },
          label_key: { type: 'string', enum: ['human', 'suspected_ai', 'ai'] },
          label_name: { type: 'string', description: '人工特征 | 疑似 AI | AI 特征' },
          category: { type: 'string', enum: ['human', 'suspected_ai', 'ai'] },
          confidence: { type: 'number' },
          position: { type: 'array', items: { type: 'number' }, description: '[起始下标, 结束下标]（左闭右开）' },
          start: { type: ['number', 'null'] },
          end: { type: ['number', 'null'] },
          chars: { type: 'number', description: '该段字符数' },
          text: { type: 'string', description: '该段完整文本（不截断）' },
          excerpt: { type: 'string', description: '该段完整文本（与 text 同值，保留旧字段名以兼容）' },
        },
      },
    },
    segments: {
      type: 'array',
      description: '全部分段及各自归属类别（含人工段）。这是「每段文本的 AI 率/归属」的真实数据来源，agent 可据此逐段改写。',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number' },
          order: { type: 'number' },
          label: { type: 'number', enum: [0, 1, 2] },
          label_key: { type: 'string' },
          label_name: { type: 'string' },
          category: { type: 'string' },
          confidence: { type: 'number' },
          position: { type: 'array', items: { type: 'number' } },
          chars: { type: 'number' },
          text: { type: 'string', description: '该段完整文本' },
          excerpt: { type: 'string', description: '该段完整文本（与 text 同值）' },
          global_position: { type: 'array', items: { type: 'number' }, description: '分块检测时，该段在原文中的绝对位置' },
        },
      },
    },
    total_segment_chars: { type: 'number', description: '所有分段字符数合计，三段占比的分母' },
    warnings: {
      type: 'array',
      description: '告警。常见 code: TEXT_TOO_SHORT / LABEL_CONFIDENCE_CONFLICT',
      items: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, hint: { type: 'string' } } },
    },
    _meta: {
      type: 'object',
      description: '调用元信息（含用量、耗时、分块、缓存命中）',
      properties: {
        schema_version: { type: 'string' },
        detector: { type: 'string', const: 'tencent-zhuque-text' },
        endpoint: { type: 'string' },
        input_chars: { type: 'number' },
        is_merge: { type: 'boolean' },
        chunked: { type: 'boolean' },
        chunk_count: { type: 'number' },
        usage: {
          type: 'object',
          properties: {
            zhuque_total_tokens: { type: 'number', description: '朱雀模型自身用量，与免费额度核算无关' },
            makers_billed_tokens: { type: 'number', description: '本次实际扣减 Makers 免费额度的 token 数' },
          },
        },
        key: {
          type: 'object',
          description: '本次实际使用的 Key（仅返回掩码，绝不回传明文）',
          properties: {
            id: { type: ['string', 'null'] },
            label: { type: ['string', 'null'] },
            masked: { type: 'string' },
            source: { type: 'string', enum: ['explicit', 'key_pool', 'config', 'env:ZHUQUE_API_KEY', 'dotenv:ZHUQUE_API_KEY', 'token:<路径>'] },
          },
        },
        key_attempts: {
          type: 'array',
          description: '各分块的 Key 调用记录；failover 表示出现了不同 Key。',
          items: { type: 'object', properties: { key_id: { type: 'string' }, masked: { type: 'string' }, ok: { type: 'boolean' }, error: { type: 'string' } } },
        },
        failover: { type: 'boolean', description: '是否发生了 Key 自动切换' },
        history_id: { type: 'string', description: '本次检测写入历史库后的记录 id，可用于回查' },
        cache_hit: { type: 'boolean' },
        duration_ms: { type: 'number' },
        detected_at: { type: 'string', format: 'date-time' },
      },
    },
  },
};

const LABEL_DOC = Object.entries(LABELS).map(([code, v]) => ({
  code: Number(code),
  key: v.key,
  name_zh: v.name_zh,
  desc: v.desc,
}));

/** 官网口径的三段分类（展示顺序） */
const CATEGORY_DOC = CATEGORIES.map((c) => ({ key: c.key, label: c.label, name_zh: c.name_zh }));

const HISTORY_DOC = {
  storage: '~/.zhuque/history.jsonl（JSONL，每行一条，append-only）',
  max_records: DEFAULT_HISTORY_MAX,
  tuning: {
    max_records: 'ZHUQUE_HISTORY_MAX（条数上限，默认 2000，超出裁剪最旧的）',
    full_text_chars: 'ZHUQUE_HISTORY_TEXT_MAX（保存全文的字符上限，默认 0 = 不限制，完整保存全文）',
  },
  what_is_stored: [
    '总 AI 率、人工率、模型置信度、综合风险分与分档结论',
    '三段占比（人工特征 / 疑似 AI / AI 特征）的百分比、字符数、段数',
    '每一段的归属类别、置信度、在原文中的位置与片段原文',
    '本次使用的 Key（掩码）、计费 token、耗时、来源（web/api/cli/mcp/batch）',
    '文本全文（默认完整保存，不截断；只有显式设置 ZHUQUE_HISTORY_TEXT_MAX 才会截断）',
  ],
  endpoints: {
    list: 'GET /api/history?limit=&offset=&q=&verdict=&category=&source=&from=&to=',
    detail: 'GET /api/history/<id>',
    stats: 'GET /api/history/stats',
    export: 'GET /api/history/export?format=json|csv',
    remove: 'DELETE /api/history/<id>',
    clear: 'POST /api/history/clear',
  },
  cli: ['zhuque history list', 'zhuque history show <id>', 'zhuque history stats', 'zhuque history export --format csv'],
  purpose: '回溯历次检测；改写后重新检测可与历史记录对比 AI 率是否下降，形成降 AI 率的量化闭环。',
};

const VERDICT_DOC = VERDICTS.map((v, i) => ({
  key: v.key,
  name_zh: v.name_zh,
  risk_score_range: [i === 0 ? 0 : VERDICTS[i - 1].max, v.max === Infinity ? 1 : v.max],
  advice: v.action_zh,
}));

const KEY_POOL_DOC = {
  storage: '~/.zhuque/config.json 的 api_keys 存密钥；~/.zhuque/keys-state.json 存每把 Key 的用量与冷却状态',
  format: '[{"id":"k1","key":"sk-xxx","label":"主号","enabled":true}]',
  rotation: '轮询：每次调用自动从下一把开始挑可用的 Key',
  failover: [
    'Key 返回 401/403 → 判定为失效，自动停用并换下一把',
    'Key 返回 429 或明显额度耗尽 → 进入冷却（默认 1 小时），自动换下一把',
    '可配置 key_cooldown_ms 调整冷却时长',
  ],
  endpoints: {
    status: 'GET /api/keys',
    save: 'POST /api/keys  body: {"api_keys":[...]}',
    reset: 'POST /api/keys/reset  清空运行状态（密钥不动）',
    toggle: 'POST /api/keys/toggle  body: {"id":"k1","enabled":false}',
  },
  cli: ['zhuque keys list', 'zhuque keys add --key sk-xxx --label 主号', 'zhuque keys reset'],
};

const MCP_CLIENT_DOC = {
  restricted_by_default: true,
  allowed_clients: DEFAULT_ALLOWED_MCP_CLIENTS,
  config_fields: {
    mcp_restrict_clients: '是否启用白名单（默认 true）',
    mcp_allowed_clients: '允许的客户端名单（小写，按名称或分隔后的标识匹配（兼容性检查，不是身份认证））',
  },
  behavior: [
    'MCP initialize 时读取 clientInfo.name 进行白名单校验',
    '不在名单内的客户端调用工具会收到 MCP_CLIENT_FORBIDDEN 错误，不消耗任何额度',
    '检测工具返回逐段归属与三段占比，便于 agent 精确改写降 AI 率',
  ],
};

export const AGENT_INSTRUCTIONS = {
  summary:
    '腾讯朱雀（Zhuque）AIGC 文本检测。输入文本，返回总 AI 率、人工特征/疑似 AI/AI 特征三段占比、逐段归属与被判定为 AI 的原文片段及位置。',
  when_to_use: [
    '需要判断一段文字是否由 AI 生成（AI 率检测、AIGC 痕迹识别）',
    '写完文案后自检并迭代改写，直到 AI 率降到目标阈值以下',
    '批量审核稿件、评论区、投稿内容的 AI 生成比例',
    '逐段定位哪些句子「像 AI」，针对性改写而不是整篇重写',
  ],
  reading_result: [
    'ai_rate 是主指标：文本中 AI 特征 + 疑似 AI 的占比，0~1。通常所说的「AI 率」即此字段。',
    'categories 给出官网口径的三段占比：human(人工特征) / suspected_ai(疑似 AI) / ai(AI 特征)，percent 为百分数。',
    'segments 是「每段的归属」：逐段给出 label_name（人工特征/疑似 AI/AI 特征）、confidence 与 position，是降 AI 率的定位依据。',
    'flagged_segments 是 segments 里 label != 0 的子集，通常直接看它即可。',
    'ai_probability 是模型整体置信度，用于交叉验证；两个都低才可判定为人工。',
    'verdict 是已分档的结论，业务侧一般直接用它做分支判断。',
    '要精确改写时用 is_merge=false，从 segments[].position 定位原文区间。',
  ],
  cautions: [
    `文本短于 ${MIN_RELIABLE_CHARS} 字时置信度不可靠，warnings 中会出现 TEXT_TOO_SHORT。`,
    '检测结果不是绝对判决，只应作为辅助信号；不要用于对个人的断定性指控。',
    '同一段文本重复调用会命中本地缓存（10 分钟），如需真实重新检测请传 cache=false / no_cache。',
    '每次检测都会写入本地历史库（~/.zhuque/history.jsonl），可用 history 工具回查对比。',
  ],
  iteration_loop: [
    '1) detect 原文，读取 categories 与 segments',
    '2) 挑出 label_name 为「AI 特征」或「疑似 AI」的段落，按 position 定位',
    '3) 改写这些段落（保留事实、论证、引用和文体，消除空泛重复；不得编造经历或证据）',
    '4) 再次 detect，比较 ai_rate 与 categories 是否下降',
    '5) 重复直到 ai_rate 低于目标阈值或达到最大轮次；用 history 记录每轮数据',
  ],
};

export function buildSchemaDoc() {
  return {
    name: 'zhuque-detect',
    version: VERSION,
    schema_version: SCHEMA_VERSION,
    upstream: { provider: 'Tencent Zhuque via EdgeOne Makers', model: '@makers/zhuque-text', endpoint: resolveEndpoint() },
    auth: {
      scheme: 'Bearer',
      header: 'Authorization',
      env: ['ZHUQUE_API_KEY', 'EDGEONE_MAKERS_API_KEY', 'EDGEONE_API_KEY'],
      token_file: '项目根目录或当前目录下的 token.txt（直接写 Key，或写一行 ZHUQUE_API_KEY=xxx；可用 ZHUQUE_TOKEN_FILE 指定别的路径）',
      config_file: '~/.zhuque/config.json -> { "api_key": "..." } 或 { "api_keys": [...] }',
      priority: ['显式参数 / X-Zhuque-Api-Key', '环境变量', 'token.txt', '.env', 'Key 池', '~/.zhuque/config.json'],
      note: '通过 HTTP 调用本服务时，可用请求头 X-Zhuque-Api-Key 覆盖服务端 Key。支持多 Key 池自动轮换。',
    },
    endpoints: {
      'POST /api/detect': { request: DETECT_REQUEST_SCHEMA, response: DETECT_RESPONSE_SCHEMA },
      'POST /api/batch': { request: BATCH_REQUEST_SCHEMA, response: { type: 'object' } },
      'GET /api/detect?text=...': { note: '便捷 GET 形式，便于简单 Agent / 浏览器直接调用' },
      'GET /api/history': { note: '检测历史列表，支持 limit/offset/q/verdict/category/source/from/to' },
      'GET /api/history/<id>': { note: '单条检测历史完整明细（含逐段归属）' },
      'GET /api/history/stats': { note: '历史统计概览（条数、均值、分档分布）' },
      'GET /api/history/export?format=json|csv': { note: '导出历史' },
      'GET /api/keys': { note: 'API Key 池状态（掩码，含冷却与用量）' },
      'POST /api/keys': { note: '保存 Key 池' },
      'GET /api/schema': { note: '本说明文档（JSON）' },
      'GET /api/health': { note: '健康检查' },
      'GET /llms.txt': { note: '面向 LLM 的纯文本接口说明' },
    },
    labels: LABEL_DOC,
    categories: CATEGORY_DOC,
    verdicts: VERDICT_DOC,
    history: HISTORY_DOC,
    key_pool: KEY_POOL_DOC,
    mcp_clients: MCP_CLIENT_DOC,
    agent_instructions: AGENT_INSTRUCTIONS,
  };
}

export function buildLlmsTxt(baseUrl = 'http://127.0.0.1:8787') {
  const v = VERDICT_DOC.map((x) => `  - ${x.key} (${x.name_zh})  risk_score ∈ [${x.risk_score_range[0]}, ${x.risk_score_range[1]})  → ${x.advice}`).join('\n');
  return `# zhuque-detect —— 朱雀 AIGC 文本检测服务

> ${AGENT_INSTRUCTIONS.summary}

## 何时使用
${AGENT_INSTRUCTIONS.when_to_use.map((s) => `- ${s}`).join('\n')}

## 接口

### POST ${baseUrl}/api/detect
Content-Type: application/json
Body:
  { "text": "待检测文本（建议 >= 120 字）", "is_merge": true }

curl:
  curl -s -X POST ${baseUrl}/api/detect \\
    -H 'Content-Type: application/json' \\
    -d '{"text":"你的文本"}'

便捷 GET（适合简单 Agent）:
  curl -s "${baseUrl}/api/detect?text=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "你的文本")"

### POST ${baseUrl}/api/batch
Body: { "items": [ { "id": "a", "text": "..." }, { "id": "b", "text": "..." } ] }   // 最多 50 条

### GET ${baseUrl}/api/history?limit=20&q=关键词   检测历史列表
### GET ${baseUrl}/api/history/<id>                 单条历史明细（含逐段归属）
### GET ${baseUrl}/api/keys                        API Key 池状态（掩码）
### GET ${baseUrl}/api/schema   完整 JSON Schema 与字段释义
### GET ${baseUrl}/api/health   健康检查
### GET ${baseUrl}/llms.txt     本文件

## 响应结构（外层统一信封）
  { "ok": true, "schema_version": "${SCHEMA_VERSION}", "id": null, "data": { ... }, "error": null }
  失败时：{ "ok": false, "data": null, "error": { "code": "...", "message": "...", "hint": "..." } }

data 关键字段：
  ai_rate            number  0~1   AI 率（= AI 特征 + 疑似 AI 占比）★ 主指标
  ai_rate_percent    number        百分数形式，如 87.5
  human_rate         number  0~1   人工占比
  categories         object        三段占比（官网口径）：
    .human           { percent, ratio, chars, segments }   人工特征
    .suspected_ai    { percent, ratio, chars, segments }   疑似 AI
    .ai              { percent, ratio, chars, segments }   AI 特征
  segments           array         每一段的归属（label_name / confidence / position / text）★ 降 AI 率的定位依据；text 为该段完整原文，原文需由调用方保留，分段可能只覆盖部分原文
  flagged_segments   array         segments 中 label != 0 的子集
  ai_probability     number  0~1   模型整体置信度
  verdict            string        human | mostly_human | mixed | likely_ai | ai
  verdict_name       string        中文结论
  warnings           array         如 TEXT_TOO_SHORT

## 三段分类（与朱雀官网一致）
${CATEGORY_DOC.map((c) => `  - ${c.key}（${c.name_zh}）  label=${c.label}`).join('\n')}
  每段的归属见 data.segments[].label_name；占比见 data.categories.*.percent

## 结论分档（按 risk_score = max(ai_rate, ai_probability)）
${v}

## 令牌与凭据
- 服务端已配置 Key 时，直接调用即可，无需带任何凭据。
- 支持多 Key 池：某把 Key 额度用尽或失效时自动切换到下一把，无需人工干预。
- 若服务端要求鉴权，请加请求头：Authorization: Bearer <ZHUQUE_SERVER_TOKEN>
- 自带 Key 调用：请求头 X-Zhuque-Api-Key: <你的 EdgeOne Makers API Key>
- Key 的查找顺序：显式参数/请求头 > 环境变量 ZHUQUE_API_KEY > token.txt > .env > Key 池 > ~/.zhuque/config.json。
  token.txt 放在项目根目录或当前目录即可，内容直接写 Key（或写一行 ZHUQUE_API_KEY=xxx），
  兼容 UTF-8 / UTF-8 BOM / UTF-16LE / CRLF（Windows 记事本另存为也能直接用）。

## MCP 客户端限制
- 默认仅放行：${DEFAULT_ALLOWED_MCP_CLIENTS.join('、')}。其他客户端调用会被拒绝且不消耗额度。
- 如需调整：配置 mcp_allowed_clients / mcp_restrict_clients。

## 检测历史
- 每次检测自动落库到 ~/.zhuque/history.jsonl，记录总 AI 率、三段占比、逐段归属与命中的 Key。
- 用 GET ${baseUrl}/api/history 或 MCP 工具 get_detection_history 回查，用于「改写前后对比」。

## 注意事项
${AGENT_INSTRUCTIONS.cautions.map((s) => `- ${s}`).join('\n')}

## 推荐的自检-改写闭环
${AGENT_INSTRUCTIONS.iteration_loop.map((s) => `- ${s}`).join('\n')}
`;
}
