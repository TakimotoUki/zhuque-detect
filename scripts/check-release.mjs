import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFiles } from './source-files.mjs';
const root = path.resolve(process.argv[2] || path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const source = !process.argv[2];
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.relative(root, path.join(dir, e.name))]);
const files = source ? sourceFiles(root) : walk(root);
const problems = [];
for (const file of files) {
  const full = path.join(root, file);
  if (!fs.lstatSync(full).isFile()) { problems.push(file + ': non-regular file'); continue; }
  if (/(^|\/)(token[^/]*\.txt|\.env(?!\.example$)|config\.json|history\.jsonl|usage\.json|keys-state\.json|node_modules|\.workbuddy|\.codex)(\/|$)/i.test(file) || /\.(log|pid|bak|zip)$/.test(file)) problems.push(file + ': credential/state/build file');
  const text = fs.readFileSync(full, 'utf8');
  if (/\/Users\/[^/\s]+\/|[A-Z]:\\Users\\[^\\\s]+\\/.test(text)) problems.push(file + ': personal path');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|AKID[A-Za-z0-9]{25,}/.test(text)) problems.push(file + ': secret pattern');
  if (!/^(src\/selftest|tests\/)/.test(file) && /["']sk-[A-Za-z0-9_-]{24,}["']/.test(text)) problems.push(file + ': literal API key');
}
if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
else console.log(`Checked ${files.length} explicit ${source ? 'source' : 'package'} files: no credential files, detected secret patterns, personal paths or local state.`);
