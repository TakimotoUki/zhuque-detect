// Called only by the release workflow; token comes from its temporary environment.
import fs from 'node:fs';
import path from 'node:path';
const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
if (!token || !repository || !event.release?.id) throw Error('Release workflow context required');
const base = `https://api.github.com/repos/${repository}`;
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
const response = await fetch(`${base}/releases/${event.release.id}/assets`, { headers });
if (!response.ok) throw Error('Cannot inspect release assets: ' + response.status);
const existing = await response.json();
for (const name of fs.readdirSync('release').filter(f => /\.zip$|^SHA256SUMS$/.test(f))) {
  if (existing.some(a => a.name === name)) throw Error('Asset already exists; refusing replacement: ' + name);
  const res = await fetch(`https://uploads.github.com/repos/${repository}/releases/${event.release.id}/assets?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { ...headers, 'Content-Type': name.endsWith('.zip') ? 'application/zip' : 'text/plain' }, body: fs.readFileSync(path.join('release', name)) });
  if (!res.ok) throw Error(`Asset upload failed (${res.status}): ${name}`);
  console.log('Uploaded ' + name);
}
