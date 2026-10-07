import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Serialize read/modify/write transactions across HTTP, CLI and MCP processes.
// A lock left by a killed process fails closed; the owner can remove it after
// checking that the process has stopped. Never steal another process's lock.
const held = new Set();
const sleeper = new Int32Array(new SharedArrayBuffer(4));
export function withFileLock(file, fn) {
  file = path.resolve(file);
  if (held.has(file)) return fn();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const deadline = Date.now() + 2000;
  let fd;
  for (;;) {
    try { fd = fs.openSync(lock, 'wx', 0o600); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() >= deadline) throw new Error(`存储正在被其他进程使用或存在遗留锁：${lock}`);
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  try {
    fs.writeSync(fd, String(process.pid));
    held.add(file);
    return fn();
  } finally {
    held.delete(file);
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

export function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw new Error('存储目标必须是普通文件');
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(temp, content, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
