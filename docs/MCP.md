# MCP 接入、迁移与自动优化

本项目基于腾讯朱雀 AI 文本检测。MCP stdio 向 Agent 暴露检测工具，Agent 使用结果改写文章并复检；服务本身不调用生成模型，不需要另填 OpenAI 或其他生成模型的 Key。

## Codex

安装 Node.js 22 或更新的受支持版本，在解压目录运行：

```sh
node src/cli.mjs install-mcp --target codex
```

输出注册命令和 TOML。Codex 的 JSON 配置与 WorkBuddy 的 JSON 配置不通用，应使用 `codex mcp add` 或 `~/.codex/config.toml`：

```toml
[mcp_servers.zhuque-detect]
command = "node"
args = ["/absolute/path/zhuque-detect/src/mcp-server.mjs"]
enabled = true
startup_timeout_sec = 15
tool_timeout_sec = 300
```

Windows 可使用 TOML 单引号字符串避免反斜杠转义：

```toml
[mcp_servers.zhuque-detect]
command = "node"
args = ['D:\My Tools\zhuque-detect\src\mcp-server.mjs']
enabled = true
tool_timeout_sec = 300
```

`command="node"` 依靠客户端继承的 PATH，不绑定作者电脑的运行时路径。GUI 客户端找不到 Node 时，填本机 Node 的完整路径即可；这属于本机注册配置，不应提交到仓库。MCP 读取程序根目录的本地 Key 文件、环境变量或用户配置，不依赖客户端的工作目录。换机器或移动目录后重新注册。注册生成器通过 realpath 输出原生绝对路径，避免注册到符号链接或临时路径别名。

使用 `codex mcp list` 验证注册，在客户端查看 MCP 连接状态；调用 `get_zhuque_service_info` 确认版本 1.3.0，再调用 `detect_ai_text`。`doctor` 和检测会产生腾讯侧 token 用量。`--target codex --write` 仍只输出注册指导，避免误写 JSON。

官方配置说明：[OpenAI MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

## WorkBuddy 与其他 Agent

```sh
node src/cli.mjs install-mcp --target workbuddy --write
```

会先备份再合并用户目录的 `.workbuddy/mcp.json`，其他服务器条目不被删除。配置片段：

```json
{
  "mcpServers": {
    "zhuque-detect": {
      "command": "node",
      "args": ["/absolute/path/zhuque-detect/src/mcp-server.mjs"]
    }
  }
}
```

默认允许的客户端名包含分隔后的 `codex` 或 `workbuddy` 标识。其他 MCP 客户端需添加名称，例如：

```sh
node src/cli.mjs config set mcp_allowed_clients=codex,workbuddy,cursor
```

这不是强身份认证；本机用户可以模拟客户端名。能启动 MCP 进程的用户可以使用该用户的 Key 和历史。默认只支持 stdio，不实现远程 Streamable HTTP MCP。网页 HTTP API 的访问令牌也不是 stdio MCP 的凭据。

## 推荐迭代约定

让 Agent 先保存原文和首轮历史 id，使用 `is_merge=false` 获取更细的段落。依据 `global_position`（分块时）或 `position` 修改，保持事实、论证、引文和文体。设定最多轮数、目标 AI 率、质量约束和停止条件；每轮取实际返回值，不编造改善幅度。

检测结果的原文下标默认按 JavaScript UTF-16 代码单元定位；上游坐标无法与返回片段匹配时应先核实位置再修改。不能把可能稀疏的 `segments` 拼接当成完整原文。MCP 返回结构化数据及文字摘要，长文需要客户端允许足够的工具超时与输出长度。

## 排查

| 现象 | 处理 |
|---|---|
| 找不到 node | 重开客户端，检查其 PATH 或在本机配置 Node 完整路径 |
| 找不到入口 | 重新运行注册生成命令，含空格路径保留引号 |
| `MCP_CLIENT_FORBIDDEN` | 查看客户端实际名称，添加名单；不要把名单当身份认证 |
| `NO_API_KEY` | 在本机网页设置保存 Key；池全冷却/停用时也可能无可用 Key |
| 想用池却一直只用一把 | 清除 `ZHUQUE_API_KEY`、本地 token / .env 等高优先级单 Key 来源 |
| 长文工具超时 | 增加 Codex `tool_timeout_sec`，限制迭代轮数；原文会自动分块 |
| 遗留 `.lock` | 先确认同目录的 HTTP、CLI、MCP 进程都停止，再清理遗留锁；不要抢占活动锁 |

验证范围见 [审查与验证记录](AUDIT.md)。
