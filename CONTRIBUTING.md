# 贡献指南

源码共用一套核心；平台启动器分别在根目录 / `bin` 和 `scripts/win`，网站在 `site`。不要手工修改 `dist` 分发副本。

提交前运行 `node src/selftest.mjs`、`node tests/security.test.mjs` 和 `node src/webcheck.mjs`。测试使用本机模拟上游和临时目录，不应访问真实 Key、不消费真实腾讯额度。修改启动器时验证含空格、中文路径和目标平台行为；在 PR 中说明运行系统和未验证的部分。

提 Bug 请给出版本、操作系统、Node 版本、复现步骤、脱敏的错误码与预期行为。涉及密钥、原文或本机路径时先脱敏，不上传 `token.txt`、`.env`、历史、配置备份、运行日志和账号登录信息。

发布包由 `node scripts/pack.mjs` 生成到新目录，禁止预置凭据。确认该提交跨平台 CI 全部通过，更新 package.json 与核心 VERSION 后，推送匹配的版本 tag（例如 `v1.3.0`）。发布工作流生成两个 ZIP 和 SHA256SUMS，先创建草稿、上传全部文件后再公开；已公开 release 不自动覆盖。维护官方额度和接入信息时附官方来源与核对日期，不把 Key 数量当账号额度。

贡献者记录见 [AUTHORS.md](AUTHORS.md)，本项目使用 MIT 许可。
