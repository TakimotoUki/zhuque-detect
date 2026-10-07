# 项目介绍网站

主题：通过 MCP 连接 Codex / WorkBuddy 等 Agent，自动检测、定位、改写、复检 AI 率。基于腾讯朱雀 AI 文本检测，说明当前每账号月度 50 万 token 与账号池。

纯静态 HTML/CSS/JS，无构建步骤、第三方脚本、外部字体或分析追踪。公开页面提供教程，不收集原文或 API Key。`index.html`、`style.css`、`main.js` 、`theme.js` 与 `icon.svg` 即完整网站。

从仓库运行 `python3 -m http.server 8080 --directory site --bind 127.0.0.1`，打开 http://127.0.0.1:8080/。GitHub Pages 发布 `site/` 内容。

页面流程卡片是示意，不是实测改善数据。官网未登录每日 5 次与官方 50 万月度 token 核对于 2026-10-07；登录后每日 20 次由用户于 2026-10-08 实测；用户登录状态、免费活动和控制台规则可能改变此信息。
