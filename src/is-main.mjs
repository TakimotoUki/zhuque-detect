/**
 * 判断「当前模块是不是被当作主入口直接执行的」。
 *
 * ── 为什么不能直接写 process.argv[1] === fileURLToPath(import.meta.url) ──
 *
 * Node 加载 ES 模块时，默认会对路径做 realpath（除非开 --preserve-symlinks）。
 * 于是：
 *     import.meta.url  → 解析后的「真实路径」
 *     process.argv[1]  → 用户敲进去的「原样路径」
 * 只要这两者之间隔着任意一层符号链接，字符串比较就会失败。
 * 失败后果很隐蔽：脚本什么都不做，退出码却是 0 —— 看起来"跑成功了"，其实没跑。
 *
 * 常见触发场景（都不是稀奇事）：
 *   · macOS 的 /tmp 是指向 /private/tmp 的符号链接
 *   · 迁移过 Home 目录的 Mac（用户主目录本身可能是符号链接）
 *   · Windows 上目录是 junction / 快捷方式
 *   · 项目放在 Dropbox / iCloud / OneDrive 的同步目录里
 *   · 大小写不一致（macOS / Windows 文件系统大小写不敏感）
 *
 * 所以这里做两级比较：先比字面绝对路径，再比 realpath。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** 取规范化后的真实路径；失败返回 null */
function realpathOf(p) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** Windows / macOS 文件系统大小写通常不敏感，比较时统一小写 */
function sameFile(a, b) {
  if (a === b) return true;
  if (process.platform === 'win32' && a.toLowerCase() === b.toLowerCase()) return true;
  return false;
}

/**
 * @param {string} importMetaUrl  传当前模块的 import.meta.url
 * @param {string} [argv1]        默认取 process.argv[1]
 * @returns {boolean}
 */
export function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1 || !importMetaUrl) return false;

  let selfPath;
  try {
    selfPath = fileURLToPath(importMetaUrl);
  } catch {
    return false;
  }

  const a = path.resolve(argv1);
  const b = path.resolve(selfPath);
  if (sameFile(a, b)) return true;

  const ra = realpathOf(a);
  const rb = realpathOf(b);
  if (ra && rb && sameFile(ra, rb)) return true;

  return false;
}

