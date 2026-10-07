# macOS 版

基于腾讯朱雀 AI 文本检测，通过 MCP 连接 Codex / WorkBuddy 自动检测、改写、复检。

1. 安装 Node.js 22 或更新的受支持版本，推荐 LTS：https://nodejs.org/。
2. 解压后双击 `启动服务.command`，或运行 `node src/cli.mjs serve --open`。
3. 在 https://console.cloud.tencent.com/edgeone/makers?tab=models&subTab=apikey 创建 Key，在本机网页设置中保存。
4. 运行 `node src/cli.mjs install-mcp --target codex`，复制生成的注册命令；WorkBuddy 用 `node src/cli.mjs install-mcp --target workbuddy --write`。

源码仓库内运行 `./start.sh quick`；独立下载包内使用同名脚本。服务管理菜单为 `启动.command`。默认网页 http://127.0.0.1:8787/。

Key 池可添加不同账号的 Key，同账号填相同账号标识。当前官方每账号每月 50 万免费 token，同账号多 Key 不叠加。API 文档：https://cloud.tencent.com/document/product/1552/137539。

菜单可启动、停止、查状态、填 Key 或改端口；进程身份无法核实时不会强制停止。修改端口后先用旧配置停止服务再启动新端口。所有启动器使用相对自身位置解析程序，无个人机器路径。

移动目录或换机器后重跑 MCP 注册，不复制旧绝对路径。默认配置与历史在 `~/.zhuque/`；检测原文会发给腾讯接口。安装程序遇到系统安全限制时可在终端进入目录运行 Node 命令。
