#!/usr/bin/env node
/**
 * 把 zhuque-detect 注册为 MCP 服务
 *
 * 默认只“打印”配置片段，不做任何修改。
 * 加 --write 才会写入目标配置文件，且写入前自动备份为 <file>.bak-<时间戳>。
 *
 * ⚠️ 客户端白名单：本 MCP 服务默认**仅接受 WorkBuddy 与 Codex** 调用
 *    （见配置项 mcp_allowed_clients，默认 ['workbuddy','codex']）。
 *    其他客户端即使写入配置，握手时也会被拒绝（错误码 MCP_CLIENT_FORBIDDEN）。
 *    如需放行更多客户端：zhuque config set mcp_allowed_clients "workbuddy,codex,xxx"
 *    如需彻底关闭白名单（不推荐）：zhuque config set mcp_restrict_clients false
 *
 * 用法：
 *   zhuque install-mcp                          # 打印所有客户端的配置片段
 *   zhuque install-mcp --target codex --write
 *   zhuque install-mcp --target workbuddy --write
 *   zhuque install-mcp --file /path/to/mcp.json --write
 */

import fs from 'node:fs';
import { atomicWrite, withFileLock } from './file-store.mjs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-main.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = fs.realpathSync.native(path.resolve(__dirname, 'mcp-server.mjs'));
const NODE_BIN = 'node';

const HOME = os.homedir();

/** Claude Desktop 的配置文件在不同系统上位置不同 */
function claudeDesktopConfigPath() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    return path.join(appData, 'Claude', 'claude_desktop_config.json');
  }
  if (process.platform === 'darwin') {
    return path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
  return path.join(xdg, 'Claude', 'claude_desktop_config.json');
}

/**
 * 可「写 JSON 配置文件」的客户端。
 * Codex 不在这里：它用的是 ~/.codex/config.toml，写 JSON 文件它根本不会读，
 * 只会悄悄留下一个没用的文件 —— 所以 Codex 走官方注册命令（见 codexGuidance）。
 */
const TARGETS = {
  // ── 白名单内，官方支持 ─────────────────────────────────────────────
  workbuddy: path.join(HOME, '.workbuddy', 'mcp.json'),
  // ── 白名单外：可写入，但握手会被拒绝（除非调整 mcp_allowed_clients）──
  'claude-desktop': claudeDesktopConfigPath(),
  cursor: path.join(HOME, '.cursor', 'mcp.json'),
};

// 默认白名单（与服务端 DEFAULT_ALLOWED_MCP_CLIENTS 保持一致）
const ALLOWED_CLIENTS = ['workbuddy', 'codex'];

function buildEntry() {
  return { command: NODE_BIN, args: [MCP_SERVER], env: {} };
}

function buildSnippet() {
  return { mcpServers: { 'zhuque-detect': buildEntry() } };
}

/** TOML 基本字符串：直接用 JSON 字符串字面量即可（双反斜杠、引号转义规则一致） */
const tomlStr = (s) => JSON.stringify(String(s));
const shellStr = s => process.platform === 'win32'
  ? "'" + String(s).replace(/'/g, "''") + "'"
  : "'" + String(s).replace(/'/g, "'\"'\"'") + "'";

/** Codex 的注册方式：官方命令 + config.toml 片段，绝不写错位置的 JSON */
function codexGuidance() {
  const { command, args } = buildEntry();
  return [
    'Codex 使用 TOML 配置（~/.codex/config.toml），请用它自带的命令注册：',
    '',
    `  codex mcp add zhuque-detect -- ${shellStr(command)} ${shellStr(args[0])}`,
    '',
    '等价的 config.toml 片段（手工编辑时用）：',
    '',
    '  [mcp_servers.zhuque-detect]',
    `  command = ${tomlStr(command)}`,
    `  args = [${tomlStr(args[0])}]`,
    '  enabled = true',
    '  tool_timeout_sec = 300',
    '',
  ].join('\n');
}

function parseArgs(argv) {
  const o = { target: '', file: '', write: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--write') o.write = true;
    else if (a === '--target') o.target = argv[++i] || '';
    else if (a === '--file') o.file = argv[++i] || '';
    else if (a === '--print') o.write = false;
  }
  return o;
}

function mergeInto(file, write) {
  return withFileLock(file, () => {
  let existing = {};
  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch (e) {
      throw new Error(`目标文件不是合法 JSON，已中止：${file}\n${e.message}`);
    }
  }
  const merged = {
    ...existing,
    mcpServers: { ...(existing.mcpServers || {}), ...buildSnippet().mcpServers },
  };

  if (!write) return { merged, backup: null };

  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  let backup = null;
  if (fs.existsSync(file)) {
    backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, backup);
    fs.chmodSync(backup, 0o600);
  }
  atomicWrite(file, JSON.stringify(merged, null, 2) + '\n');
  return { merged, backup };
  });
}

export async function installMcp() {
  // 直接从 `node src/install-mcp.mjs ...` 调用时前两个 argv 是 node 与脚本本身；
  // 经 `zhuque install-mcp ...` 调用时前面会多一个子命令名，所以要少吃一个参数。
  const direct = isMainModule(import.meta.url);
  const args = parseArgs(process.argv.slice(direct ? 2 : 3));
  const snippet = buildSnippet();

  // Codex 单独处理：打印官方注册命令，不落任何 JSON 文件
  if (args.target === 'codex' && !args.file) {
    process.stdout.write(codexGuidance());
    if (args.write) {
      process.stdout.write('（未写入任何文件：Codex 只读 config.toml，请执行上面的 codex mcp add 命令）\n');
    }
    return;
  }

  if (!args.target && !args.file) {
    process.stdout.write(
      [
        'MCP 服务入口：',
        `  命令    ${NODE_BIN}`,
        `  参数    ${MCP_SERVER}`,
        '',
        `⚠ 客户端白名单：仅 ${ALLOWED_CLIENTS.join(' / ')} 可调用（配置项 mcp_allowed_clients）。`,
        '  其他客户端会收到 MCP_CLIENT_FORBIDDEN，且不消耗额度。',
        '  调整：zhuque config set mcp_allowed_clients "workbuddy,codex,其他"',
        '',
        '可写入的客户端配置文件：',
        ...Object.entries(TARGETS).map(([k, v]) => {
          const tag = ALLOWED_CLIENTS.includes(k) ? '✓ 白名单内' : '✗ 白名单外（握手会被拒）';
          return `  --target ${k.padEnd(15)} ${tag}  ${v}`;
        }),
        '',
        codexGuidance(),
        '配置片段（合并进客户端的 mcpServers 即可）：',
        JSON.stringify(snippet, null, 2),
        '',
        '写入示例：',
        '  zhuque install-mcp --target workbuddy --write',
        '  zhuque install-mcp --target codex          # 只打印 codex 注册命令',
        '',
      ].join('\n')
    );
    return;
  }

  const file = args.file || TARGETS[args.target];
  if (!file) {
    throw new Error(`未知 target：${args.target}。可选：${Object.keys(TARGETS).join(', ')}（codex 请直接看上面的注册命令）`);
  }

  // Preview only our entry: other MCP servers may contain private credentials.
  const { backup } = args.write ? mergeInto(file, true) : { backup: null };
  const outOfWhitelist = args.target && !ALLOWED_CLIENTS.includes(args.target);
  if (args.write) {
    process.stdout.write(`✓ 已写入 ${file}\n`);
    if (backup) process.stdout.write(`  原文件已备份为 ${backup}\n`);
    process.stdout.write('\n注意：MCP 配置不会自动生效。请在客户端的「连接器 / MCP」管理页中信任或重启客户端。\n');
    if (outOfWhitelist) {
      process.stdout.write(
        `\n⚠ ${args.target} 不在白名单（${ALLOWED_CLIENTS.join(', ')}）内，握手阶段会被拒绝。\n` +
          `  如需放行：zhuque config set mcp_allowed_clients "${[...ALLOWED_CLIENTS, args.target].join(',')}"\n`
      );
    }
  } else {
    process.stdout.write(`目标文件：${file}（未写入，加 --write 生效）\n\n合并后的内容：\n`);
    process.stdout.write(JSON.stringify(snippet, null, 2) + '\n');
  }
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  installMcp().catch((e) => {
    process.stderr.write(String(e?.message || e) + '\n');
    process.exitCode = 1;
  });
}
