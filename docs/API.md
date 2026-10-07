# API、字段和本地存储

网页和 HTTP 服务：`node src/cli.mjs serve --open`，默认 `http://127.0.0.1:8787`。

## 检测

`POST /api/detect` 使用 JSON 对象：

| 字段 | 默认值 / 范围 |
|---|---|
| `text` | 必填非空字符串；单篇上限 100 万 UTF-16 代码单元 |
| `is_merge` | true；精细定位推荐 false |
| `cache` | true；缓存隔离调用密钥、上游、分块和原始响应选项 |
| `auto_chunk` | true |
| `max_chars` | 默认 20000；2~20000 的整数 |
| `timeout_ms` | 默认 60000；1~300000 毫秒，包含响应正文读取 |
| `include_raw` | false |
| `history` | true；不需要保存本地原文时设 false |
| `id` | 字符串或数字，HTTP 信封原样回传 |
| `source` | 本地历史来源标签 |

成功返回 `{ok:true,schema_version:"1.2",id,data,error:null}`，失败返回 `{ok:false,data:null,error:{code,message,hint,detail}}`。HTTP 状态用于协议/鉴权错误。`POST /api/batch` 的 `items` 最多 50 条，外层成功不表示所有条目成功，应看 `data.all_succeeded` 和各 `results[].ok`。CLI 部分批量失败会返回非零退出码。

`GET /api/detect?text=...` 为兼容保留，默认不写历史，会产生真实 token 用量；文本在 URL 中可能进入浏览器历史，正文提交推荐 POST。浏览器被动资源请求被拒绝。

## 字段口径

官方 [朱雀 API 文档](https://cloud.tencent.com/document/product/1552/137539)把 `labels_ratio` 定义为 0=人工、1=AI、2=疑似 AI。整体占比优先使用该字段，不以可能只覆盖部分原文的分段推翻整体比例。三项归一到总和 1，`ai_rate=AI+疑似 AI`；若没有整体比例才按段落字符数统计。

`categories.*.percent` 始终是 0~100 的百分数，`ratio` 为 0~1。`categories.basis` 指出 `labels_ratio` 或 `segment_chars`。`composition` 表示上游整体比例。分段标签统一为 0=人工、1=AI、2=疑似 AI。2026-10-08 的真实 API 验证返回整体 AI 100%、段落 label=1，确认该映射；旧版反向解释 1/2 已修正。未知标签按疑似 AI 处理。

`segments` 带段落文本、归属、置信度和 `position[start,end)`；分块时附带 `global_position`，应优先用全局下标。`risk_score=max(ai_rate,ai_probability)` 与结论分档是本项目的展示规则，不是腾讯对作者身份的判决。

`_meta` 包含版本、分块数、Key 掩码、Key 调用记录、是否切换、历史 id 与本次 token 用量。缓存命中返回 0 新增 token。Makers 扣减看 `makers_models_usage.total_tokens`，`usage.total_tokens` 是模型统计，二者不能混用。

## 其他端点

| 端点 | 用途 |
|---|---|
| `GET /api/health` | 服务和配置状态；匿名远程请求不含 Key 掩码或路径 |
| `GET /api/schema`、`GET /llms.txt` | 机器可读字段说明 |
| `GET/POST /api/config`、`POST /api/config/test` | 配置与连接测试；新上游测试须显式提供 Key |
| `GET/POST /api/keys` | 掩码 Key 池状态与保存，支持 `account` 分组 |
| `POST /api/keys/toggle`、`POST /api/keys/reset` | 启停、清除冷却 |
| `GET /api/history`、`GET/DELETE /api/history/<id>` | 历史列表、详情、删除 |
| `GET /api/history/stats`、`GET /api/history/export`、`POST /api/history/clear` | 统计、JSON/CSV 导出、清空 |
| `GET /api/usage` | 本地账本，默认每月 500000 token，仅作估算 |
| `POST /api/usage/calibrate`、`POST /api/usage/quota`、`POST /api/usage/reset` | 校准控制台读数、账期、清除账本 |
| `POST /api/cache` | 清空进程缓存 |
| `GET /api/mcp-config` | 本机程序路径生成的注册片段 |

历史列表支持 `limit/offset/q/verdict/category/source/from/to`。导出 `format=json|csv`，默认最近 500 条，`limit` 最大 2000。

## 网络与存储

默认回环服务供当前用户本机使用。指定非回环 `--host` 时必须设置 `ZHUQUE_SERVER_TOKEN`，客户端带 `Authorization: Bearer ...`。本机免令牌条件必须同时满足回环监听与回环对端；伪造 Host 不能免鉴权。跨站来源需显式配置 `allowed_origins`，CORS 不替代鉴权。网络传输本身仍需部署者配置 HTTPS 反向代理。

请求正文上限 4MB、上游响应上限 8MB、HTTP 同时检测最多 4 个。上游远程 URL 必须是 HTTPS，禁止内嵌凭据，不跟随重定向；本机模拟接口允许 HTTP。接口不能覆盖每次检测的上游地址，只允许用户在配置里设置。

`~/.zhuque/config.json` 保存 Key，`keys-state.json` 保存使用状态，`usage.json` 保存账本，`history.jsonl` 保存历史。对应 `ZHUQUE_CONFIG_FILE/ZHUQUE_KEYS_FILE/ZHUQUE_USAGE_FILE/ZHUQUE_HISTORY_FILE` 可指定独立路径。原子写入和文件锁减少多进程竞争与中断导致的损坏。进程被强杀可能遗留锁，恢复前应确认写入进程已停止。

历史默认保留 2000 条，裁剪间隔为每 10 次追加，因此可暂时超出 9 条。默认完整保存正文与分段，`ZHUQUE_HISTORY_TEXT_MAX` 为正数时删除超限正文和分段副本，只保留首尾预览与定位元数据。已有旧历史不会被此设置追溯清理。
