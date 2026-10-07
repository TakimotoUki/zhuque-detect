#!/usr/bin/env node
// Reproducible platform packages. Credentials can never be embedded.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/core.mjs';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const value = flag => { const i = argv.indexOf(flag); if (i < 0) return null; const v = argv[i + 1]; if (!v || v.startsWith('--')) throw new Error(`${flag} requires a value`); return v; };
const platform = value('--platform') || 'all';
if (!['mac', 'win', 'all'].includes(platform)) throw new Error('platform must be mac, win or all');
const allowed = new Set(['--platform', '--out-mac', '--out-win', '--dist']);
for (let i = 0; i < argv.length; i++) { if (!allowed.has(argv[i])) throw new Error(`Unsupported argument: ${argv[i]} (embedding credentials is prohibited)`); if (argv[i] !== '--dist') i++; }
const modules = ['core', 'config-store', 'key-pool', 'history-store', 'usage-store', 'file-store', 'cli', 'server', 'mcp-server', 'schema', 'install-mcp', 'is-main'];
const copy = (from, to, options = {}) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  let text = fs.readFileSync(from, 'utf8').replace(/^\uFEFF/, '');
  if (options.crlf) text = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  fs.writeFileSync(to, (options.bom ? '\uFEFF' : '') + text);
  if (options.exec) fs.chmodSync(to, 0o755);
};
const outputs = ['mac', 'win'].filter(p => platform === 'all' || p === platform);
for (const target of outputs) {
  const out = path.resolve(value(`--out-${target}`) || path.join(root, 'dist', `zhuque-detect-${target}`));
  // Never clean arbitrary directories or follow a symlink. An output must be
  // empty: rebuilds should use a fresh directory and preserve existing data.
  if (out === root || root.startsWith(out + path.sep) || fs.existsSync(out) && (!fs.lstatSync(out).isDirectory() || fs.readdirSync(out).length)) throw new Error(`Output must be a fresh empty directory: ${out}`);
  fs.mkdirSync(out, { recursive: true });
  for (const name of modules) copy(path.join(root, 'src', `${name}.mjs`), path.join(out, 'src', `${name}.mjs`));
  copy(path.join(root, 'public', 'index.html'), path.join(out, 'public', 'index.html'));
  for (const file of ['LICENSE', 'README.md', 'SECURITY.md', 'AUTHORS.md', 'CHANGELOG.md', 'CONTRIBUTING.md', '.env.example']) copy(path.join(root, file), path.join(out, file));
  for (const file of ['MCP.md', 'API.md', 'AUDIT.md']) copy(path.join(root, 'docs', file), path.join(out, 'docs', file));
  const readmeFile = path.join(out, 'README.md');
  fs.writeFileSync(readmeFile, fs.readFileSync(readmeFile, 'utf8').replace('(site/assets/web-detail.png)', '(https://raw.githubusercontent.com/TakimotoUki/zhuque-detect/main/site/assets/web-detail.png)').replace(/\(scripts\/(mac|win)\/README-(Mac|Windows)\.md\)/g, (_, p, n) => `(${target === p ? `README-${n}.md` : `https://github.com/TakimotoUki/zhuque-detect/blob/main/scripts/${p}/README-${n}.md`})`));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const scripts = { serve: 'node src/cli.mjs serve --open', mcp: 'node src/mcp-server.mjs', doctor: 'node src/cli.mjs doctor', 'install-mcp': 'node src/cli.mjs install-mcp' };
  fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ ...pkg, version: VERSION, scripts, files: ['src', 'public', 'LICENSE', 'README.md'] }, null, 2) + '\n');
  if (target === 'mac') {
    for (const file of ['start.sh', '启动.command', '启动服务.command', 'bin/lib.sh', 'bin/zhuque']) copy(path.join(root, file), path.join(out, file), { exec: true });
    copy(path.join(root, 'scripts/mac/README-Mac.md'), path.join(out, 'README-Mac.md'));
  } else {
    for (const [from, to] of [['menu.cmd', '启动.cmd'], ['quick.cmd', '启动服务.cmd'], ['zhuque.cmd', 'zhuque.cmd'], ['start.ps1', 'start.ps1']]) {
      copy(path.join(root, 'scripts/win', from), path.join(out, to), { crlf: true, bom: from.endsWith('.ps1') });
    }
    copy(path.join(root, 'scripts/win/README-Windows.md'), path.join(out, 'README-Windows.md'), { crlf: true, bom: true });
  }
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  for (const f of walk(out)) {
    if (/^(token\.txt|\.env|config\.json|history\.jsonl)$/i.test(path.basename(f))) throw new Error('Credential/state file in package');
    const text = fs.readFileSync(f, 'utf8');
    if (/\/Users\/[^/\s]+\/|[A-Z]:\\Users\\[^\\\s]+\\/.test(text)) throw new Error(`Personal absolute path: ${f}`);
    if (f.endsWith('.cmd') && /[^\x00-\x7F]/.test(text)) throw new Error(`Non-ASCII cmd: ${f}`);
  }
  console.log(`${target}: ${out} (${walk(out).length} files, v${VERSION}, no credentials)`);
}
