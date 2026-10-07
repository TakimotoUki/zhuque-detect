// Real native launcher lifecycle, with isolated state and no upstream calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zq-launcher-'));
const env = { ...process.env, ZHUQUE_CONFIG_FILE: path.join(tmp, 'config.json'), ZHUQUE_USAGE_FILE: path.join(tmp, 'usage.json'), ZHUQUE_HISTORY_FILE: path.join(tmp, 'history.jsonl'), ZHUQUE_KEYS_FILE: path.join(tmp, 'keys.json'), ZHUQUE_TOKEN_FILE: path.join(tmp, 'token.txt'), ZHUQUE_NODE: process.execPath };
delete env.ZHUQUE_API_KEY;
const native = process.platform === 'win32' ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/win/start.ps1')]] : ['bash', [path.join(root, 'start.sh')]];
function command(action) {
  return new Promise((resolve, reject) => {
    const child = spawn(native[0], [...native[1], action], { env, cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => out += b);
    const timer = setTimeout(() => { child.kill(); reject(Error('Launcher timeout: ' + out)); }, 25000);
    child.on('error', reject);
    // Windows descendants can keep inherited pipe handles open. The launcher's
    // exit determines completion; its background server is checked separately.
    child.on('exit', code => { clearTimeout(timer); child.stdout.destroy(); child.stderr.destroy(); resolve({ code, out }); });
  });
}
test('native launcher starts, survives port changes for identity, and stops only its process', { skip: process.platform === 'linux', timeout: 60000 }, async () => {
  const probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r));
  fs.writeFileSync(env.ZHUQUE_CONFIG_FILE, JSON.stringify({ port, auto_open: false }));
  try {
    const start = await command('start'); assert.equal(start.code, 0, start.out);
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(); assert.equal(health.service, 'zhuque-detect');
    fs.writeFileSync(env.ZHUQUE_CONFIG_FILE, JSON.stringify({ port: port === 65535 ? port - 1 : port + 1 }));
    const stop = await command('stop'); assert.equal(stop.code, 0, stop.out);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
    assert.equal(fs.existsSync(path.join(tmp, 'server.pid')), false);
  } finally { await command('stop'); }
});
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
