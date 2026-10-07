// The complete public source manifest. Local files outside it never publish.
import fs from 'node:fs';
import path from 'node:path';
export const sourceFiles = root => {
  const files = ['.gitignore', '.env.example', 'package.json', 'LICENSE', 'README.md', 'AUTHORS.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'start.sh', '启动.command', '启动服务.command', 'bin/lib.sh', 'bin/zhuque'];
  const directories = {
    src: ['cli.mjs', 'core.mjs', 'config-store.mjs', 'file-store.mjs', 'history-store.mjs', 'usage-store.mjs', 'key-pool.mjs', 'server.mjs', 'mcp-server.mjs', 'install-mcp.mjs', 'is-main.mjs', 'schema.mjs', 'selftest.mjs', 'webcheck.mjs'],
    public: ['index.html'], site: ['index.html', 'style.css', 'theme.js', 'main.js', 'icon.svg', 'README.md'],
    'site/assets': ['web-detection.png', 'web-detail.png'],
    docs: ['API.md', 'MCP.md', 'AUDIT.md'], tests: ['security.test.mjs', 'site.test.mjs', 'platform.test.mjs'],
    scripts: ['pack.mjs', 'source-files.mjs', 'check-release.mjs', 'release-upload.mjs'],
    'scripts/mac': ['README-Mac.md'], 'scripts/win': ['README-Windows.md', 'start.ps1', 'menu.cmd', 'quick.cmd', 'zhuque.cmd'],
    '.github/workflows': ['ci.yml', 'pages.yml', 'release.yml'], '.github/ISSUE_TEMPLATE': ['bug_report.yml'],
  };
  for (const [dir, names] of Object.entries(directories)) files.push(...names.map(n => dir + '/' + n));
  for (const file of files) if (!fs.lstatSync(path.join(root, file)).isFile()) throw Error('Missing/non-regular source: ' + file);
  return files.sort();
};
