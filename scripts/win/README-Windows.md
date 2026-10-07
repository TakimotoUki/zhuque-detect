# Windows 版

基于腾讯朱雀 AI 文本检测，通过 MCP 连接 Codex / WorkBuddy 自动检测、改写、复检。

1. 安装 Node.js 22 或更新的受支持版本，推荐 LTS：https://nodejs.org/。
2. 解压后双击 `启动服务.cmd`；管理菜单为 `启动.cmd`。也可运行 `node src\cli.mjs serve --open`。
3. 在 https://console.cloud.tencent.com/edgeone/makers?tab=models&subTab=apikey 创建 Key，在本机网页设置中保存。
4. 在解压目录运行 `node src\cli.mjs install-mcp --target codex`，复制生成的注册命令。

含空格路径应保留引号：

```powershell
codex mcp add zhuque-detect -- node "D:\My Tools\zhuque-detect\src\mcp-server.mjs"
```

WorkBuddy 用 `node src\cli.mjs install-mcp --target workbuddy --write`。服务端与网页都不必保持运行，MCP 由客户端自动启动。

默认网页 http://127.0.0.1:8787/。Key 池支持不同账号 Key，同账号填相同标识；当前每账号每月 50 万免费 token，同账号多 Key 不叠加。API 文档：https://cloud.tencent.com/document/product/1552/137539。

PowerShell 5.1 / 7 均可使用管理器。分发包的 `.ps1` 使用 UTF-8 BOM 和 CRLF，`.cmd` 为 ASCII 和 CRLF。不修改系统 ExecutionPolicy，启动器只对本次进程指定执行策略。默认文件位于 `%USERPROFILE%\.zhuque`，权限取决于 Windows 用户目录 ACL。移动目录后重新注册 MCP。
