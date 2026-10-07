#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 共用的 Node 定位逻辑 —— 被 bin/zhuque 与 start.sh source
#
# 设计原则：不写死任何机器专属路径、不写死版本号。
# 查找顺序：$ZHUQUE_NODE > PATH 里的 node > 常见安装位置（Homebrew / nvm / volta / fnm / 官方 pkg ...）
# 这样在任何一台 macOS（Intel 或 Apple Silicon）上都能直接跑。
# ---------------------------------------------------------------------------

# 本工具需要的最低 Node 大版本
ZHUQUE_MIN_NODE_MAJOR=22

# 输出可用的 node 可执行文件绝对路径；找不到返回 1
zhuque_find_node() {
  # 1) 用户显式指定
  if [ -n "${ZHUQUE_NODE:-}" ]; then
    if [ -x "${ZHUQUE_NODE}" ]; then
      printf '%s\n' "${ZHUQUE_NODE}"
      return 0
    fi
    printf 'ZHUQUE_NODE 指向的文件不存在或不可执行：%s\n' "${ZHUQUE_NODE}" >&2
    return 1
  fi

  # 2) PATH
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi

  # 3) 常见安装位置（不含任何机器专属路径）
  #    nvm / fnm 的路径带版本号，用 glob 匹配，取字典序最后一个（通常是最高版本）
  local c
  for c in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    /opt/local/bin/node \
    "$HOME/.local/bin/node" \
    "$HOME/.volta/bin/node" \
    "$HOME/.fnm/aliases/default/bin/node" \
    "$HOME/.asdf/shims/node" \
    "$HOME/Library/pnpm/node" \
    "$HOME/.nvm/current/bin/node"; do
    if [ -x "$c" ]; then
      printf '%s\n' "$c"
      return 0
    fi
  done

  local d
  for d in "$HOME/.nvm/versions/node"/*/bin/node; do
    [ -x "$d" ] && { printf '%s\n' "$d"; return 0; }
  done

  return 1
}

# 取 node 大版本号；失败输出空
zhuque_node_major() {
  "$1" -v 2>/dev/null | sed 's/^v//' | cut -d. -f1
}

# 找不到 node 时打印统一的引导文案
zhuque_node_missing_help() {
  cat >&2 <<'EOF'

未找到 Node.js。

本工具需要 Node.js 22 或更高版本。任选一种方式安装：

  1) 官网下载安装包（推荐）
     https://nodejs.org/

  2) 用 Homebrew
     brew install node


装完后重开一个终端窗口，或直接在本窗口执行：
     export PATH="/opt/homebrew/bin:$PATH"      # Homebrew 默认位置（Apple Silicon）

如果你已经把 node 装在了别的地方，可以显式指定：
     export ZHUQUE_NODE=/你的路径/bin/node

EOF
}
