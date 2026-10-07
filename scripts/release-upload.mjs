// Called only by the release workflow; token comes from its temporary environment.
import fs from 'node:fs';
import path from 'node:path';
const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const tag = process.env.GITHUB_REF_NAME;
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
if (!token || !repository || tag !== `v${version}`) throw Error('Matching version tag and workflow context required');
const base = `https://api.github.com/repos/${repository}`;
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
const found = await fetch(`${base}/releases/tags/${encodeURIComponent(tag)}`, { headers });
let release;
if (found.status === 404) {
  const body = `基于腾讯朱雀 AI 文本检测。提供本机网页检测、全文高亮、历史导出与账号池；通过 MCP 连接 Codex、WorkBuddy 等 Agent，实现检测 → 定位 → 改写 → 复检。\n\n下载对应平台 ZIP，安装 Node.js 22+；在本机网页填写自行创建的 API Key。两个包不含 Key、个人配置或检测历史。\n\n- macOS：解压后双击启动服务.command\n- Windows：解压后双击启动服务.cmd\n- [网站与教程](https://takimotouki.github.io/zhuque-detect/)\n- [创建 API Key](https://console.cloud.tencent.com/edgeone/makers?tab=models&subTab=apikey)\n- [更新记录](https://github.com/${repository}/blob/${tag}/CHANGELOG.md)\n\nSHA256SUMS 用于校验下载。贡献者：TakimotoUki 与 Codex（AI assistant）。`;
  const created = await fetch(`${base}/releases`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ tag_name: tag, name: `${tag} · 网页检测与 MCP 自动优化`, draft: true, body }) });
  if (!created.ok) throw Error('Cannot create release: ' + created.status);
  release = await created.json();
} else {
  if (!found.ok) throw Error('Cannot inspect release: ' + found.status);
  release = await found.json();
  if (!release.draft) throw Error('Release is already published; refusing modification');
}
const response = await fetch(`${base}/releases/${release.id}/assets`, { headers });
if (!response.ok) throw Error('Cannot inspect release assets: ' + response.status);
const existing = await response.json();
for (const name of fs.readdirSync('release').filter(f => /\.zip$|^SHA256SUMS$/.test(f))) {
  if (existing.some(a => a.name === name)) throw Error('Asset already exists; refusing replacement: ' + name);
  const res = await fetch(`https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { ...headers, 'Content-Type': name.endsWith('.zip') ? 'application/zip' : 'text/plain' }, body: fs.readFileSync(path.join('release', name)) });
  if (!res.ok) throw Error(`Asset upload failed (${res.status}): ${name}`);
  console.log('Uploaded ' + name);
}
const published = await fetch(`${base}/releases/${release.id}`, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: false }) });
if (!published.ok) throw Error('Cannot publish completed release: ' + published.status);
console.log('Published ' + tag);
