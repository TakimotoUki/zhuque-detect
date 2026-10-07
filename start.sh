#!/usr/bin/env bash
#
# zhuque-detect 服务管理器 —— 交互式选择启动 / 停止服务器
#
#   ./start.sh            打开交互菜单
#   ./start.sh start      直接启动（后台运行）
#   ./start.sh quick      启动并打开网页
#   ./start.sh stop       停止
#   ./start.sh restart    重启
#   ./start.sh status     查看状态
#   ./start.sh logs       查看日志
#   ./start.sh open       打开网页
#   ./start.sh key        交互式填写 API Key
#   ./start.sh port       修改服务端口
#   ./start.sh mcp        安装到 WorkBuddy / Codex（MCP）
#
# 不写死任何机器专属路径：node 的定位逻辑见 bin/lib.sh。
# 兼容 macOS 自带的 bash 3.2（不使用 bash 4 特性）。

set -uo pipefail
umask 077

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=bin/lib.sh
. "$DIR/bin/lib.sh"

# 配置文件路径必须与 server / cli 完全一致（它们都优先读 ZHUQUE_CONFIG_FILE），
# 否则 status / stop / open 会作用在与真实服务不同的端口上。
CONFIG_FILE="${ZHUQUE_CONFIG_FILE:-${HOME}/.zhuque/config.json}"
case "$CONFIG_FILE" in
  /*) ;;
  *) CONFIG_FILE="${PWD}/${CONFIG_FILE}" ;;
esac
# pid / 日志与配置同目录，保证多实例（不同 ZHUQUE_CONFIG_FILE）互不干扰
STATE_DIR="$(dirname "$CONFIG_FILE")"
PID_FILE="${STATE_DIR}/server.pid"
LOG_FILE="${STATE_DIR}/server.log"
DEFAULT_PORT=8787

# ---------- 颜色（非 TTY 自动关闭） ----------
if [ -t 1 ]; then
  C_R=$'\033[0m'; C_B=$'\033[1m'; C_DIM=$'\033[2m'
  C_G=$'\033[32m'; C_Y=$'\033[33m'; C_RD=$'\033[31m'; C_BL=$'\033[36m'
else
  C_R=''; C_B=''; C_DIM=''; C_G=''; C_Y=''; C_RD=''; C_BL=''
fi

ok()   { printf '%s✓%s %s\n' "$C_G" "$C_R" "$1"; }
warn() { printf '%s!%s %s\n' "$C_Y" "$C_R" "$1"; }
err()  { printf '%s✗%s %s\n' "$C_RD" "$C_R" "$1"; }
info() { printf '%s·%s %s\n' "$C_DIM" "$C_R" "$1"; }

# ---------- 定位 node ----------
NODE_BIN="$(zhuque_find_node)" || {
  err "未找到 Node.js。"
  zhuque_node_missing_help
  exit 127
}

# 版本兜底检查：太老的 node 不支持本项目用到的语法（可选失败，不阻断）
NODE_MAJOR="$(zhuque_node_major "$NODE_BIN")"
if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -lt "$ZHUQUE_MIN_NODE_MAJOR" ] 2>/dev/null; then
  err "当前 node 版本过低（v${NODE_MAJOR}），本项目需要 v${ZHUQUE_MIN_NODE_MAJOR} 或更高。"
  info "升级方式： brew upgrade node   或   nvm install --lts"
  exit 127
fi

# ---------- 读取配置中的端口 ----------
get_port() {
  local p=""
  if [ -f "$CONFIG_FILE" ]; then
    # 路径从 argv 传入，不拼进脚本字符串（避免路径里的引号/反斜杠破坏解析）
    p="$("$NODE_BIN" -e '
      try{
        const fs=require("fs");
        const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
        process.stdout.write(String(c.port||""));
      }catch(e){}
    ' "$CONFIG_FILE" 2>/dev/null)"
  fi
  if [ -z "$p" ] && [ -n "${PORT:-}" ]; then p="$PORT"; fi
  if [ -z "$p" ]; then p="$DEFAULT_PORT"; fi
  echo "$p"
}

PORT_NOW="$(get_port)"
case "$PORT_NOW" in ''|*[!0-9]*) err "端口不是整数"; exit 1;; esac
if [ "$PORT_NOW" -lt 1 ] || [ "$PORT_NOW" -gt 65535 ]; then err "端口超出 1~65535"; exit 1; fi
BASE_URL="http://127.0.0.1:${PORT_NOW}"

# ---------- 状态判断 ----------
read_pid() {
  [ -f "$PID_FILE" ] || return 1
  local p
  p="$(sed -n '1p' "$PID_FILE" 2>/dev/null | tr -d '[:space:]')"
  case "$p" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$p" -gt 1 ] || return 1
  echo "$p"
}

is_running() {
  local p
  p="$(read_pid)" || return 1
  kill -0 "$p" 2>/dev/null || return 1
  command -v ps >/dev/null 2>&1 || return 1
  local cmd started expected
  cmd="$(ps -p "$p" -o command= 2>/dev/null)" || return 1
  started="$(ps -p "$p" -o lstart= 2>/dev/null)" || return 1
  expected="$(sed -n '2p' "$PID_FILE")"
  [ -n "$expected" ] && [ "$started" = "$expected" ] || return 1
  [ "$cmd" = "$(sed -n '3p' "$PID_FILE")" ] || return 1
  case "$cmd" in "$NODE_BIN $DIR/src/server.mjs --port "*) ;; *) return 1;; esac
  return 0
}

port_listener() {
  command -v lsof >/dev/null 2>&1 || return 1
  lsof -nP -iTCP:"$PORT_NOW" -sTCP:LISTEN -t 2>/dev/null | head -n 1
}

health_ok() {
  command -v curl >/dev/null 2>&1 || return 1
  curl -fsS -m 3 "${BASE_URL}/api/health" >/dev/null 2>&1
}

# ---------- 动作 ----------
do_start() {
  if is_running; then
    warn "服务已在运行（PID $(read_pid)）"
    info "网页地址：${BASE_URL}/"
    return 0
  fi

  local other
  other="$(port_listener || true)"
  if [ -n "$other" ]; then
    err "端口 ${PORT_NOW} 已被进程 ${other} 占用"
    info "可换端口：./start.sh，在菜单里选「修改服务端口」，或编辑 ${CONFIG_FILE}"
    return 1
  fi

  mkdir -p "$STATE_DIR"
  printf '%s' "" > "$LOG_FILE"

  info "正在启动服务（node $(basename "$NODE_BIN")，端口 ${PORT_NOW}）…"
  (
    cd "$DIR" || exit 1
    # 显式带上端口：保证服务真的监听在 PORT_NOW，不会因为配置解析差异跑到别的端口
    nohup "$NODE_BIN" "$DIR/src/server.mjs" --port "$PORT_NOW" >>"$LOG_FILE" 2>&1 &
    local launched=$!
    printf '%s\n' "$launched" > "$PID_FILE"
    ps -p "$launched" -o lstart= >> "$PID_FILE"
    printf '%s\n' "$NODE_BIN $DIR/src/server.mjs --port $PORT_NOW" >> "$PID_FILE"
  )

  # 等待健康检查通过（最多约 10 秒）
  local i=0
  while [ "$i" -lt 40 ]; do
    if health_ok; then break; fi
    if ! is_running; then break; fi
    sleep 0.25
    i=$((i + 1))
  done

  if health_ok; then
    ok "服务已启动（PID $(read_pid)）"
    echo
    printf '  %s网页%s      %s/\n' "$C_B" "$C_R" "$BASE_URL"
    printf '  %s接口%s      POST %s/api/detect\n' "$C_B" "$C_R" "$BASE_URL"
    printf '  %s日志%s      %s\n' "$C_B" "$C_R" "$LOG_FILE"
    echo
    show_key_status
    return 0
  fi

  err "启动失败，日志尾部："
  tail -n 20 "$LOG_FILE" 2>/dev/null | sed 's/^/    /'
  return 1
}

do_stop() {
  if ! is_running; then
    local p
    p="$(read_pid)"

    # 有 PID 文件但进程已死：清掉残留
    if [ -n "$p" ] && ! kill -0 "$p" 2>/dev/null; then
      warn "发现残留的 PID 文件（进程 ${p} 已不存在），已清理"
      rm -f "$PID_FILE"
      return 0
    fi

    # 没有 PID 记录，但端口被占：只提示，不擅自终止别人的进程
    local other
    other="$(port_listener || true)"
    if [ -n "$other" ]; then
      warn "端口 ${PORT_NOW} 被进程 ${other} 占用，但它不是本脚本启动的"
      info "如果是旧实例，可执行：kill ${other}"
      info "或换端口：./start.sh port"
      return 1
    fi

    warn "服务未在运行"
    rm -f "$PID_FILE"
    return 0
  fi

  local p
  p="$(read_pid)"
  info "正在停止服务（PID ${p}）…"
  kill "$p" 2>/dev/null

  local i=0
  while [ "$i" -lt 20 ]; do
    kill -0 "$p" 2>/dev/null || break
    sleep 0.25
    i=$((i + 1))
  done

  if kill -0 "$p" 2>/dev/null; then
    warn "未响应，强制终止"
    is_running || { err "无法确认进程身份，未发送强制终止信号"; return 1; }
    kill -9 "$p" 2>/dev/null
    sleep 0.5
  fi

  if kill -0 "$p" 2>/dev/null; then
    err "停止失败，进程仍在运行"
    return 1
  fi
  rm -f "$PID_FILE"
  ok "服务已停止"
  return 0
}

do_restart() {
  do_stop
  sleep 0.5
  do_start
}

# 一键：启动服务并直接打开网页（给「启动服务.command」双击用）
do_quick() {
  do_start
  if health_ok; then
    do_open
  else
    warn "服务未就绪，请先看上面的日志排查"
  fi
}

do_status() {
  echo
  printf '%s服务状态%s\n' "$C_B" "$C_R"
  echo "────────────────────────────────────────"
  if is_running; then
    printf '  运行中      %s是%s （PID %s）\n' "$C_G" "$C_R" "$(read_pid)"
  elif health_ok; then
    # 服务在响应，但 PID 文件没记录（例如直接用 zhuque serve 起的，或 PID 文件已过期）
    printf '  运行中      %s是%s （PID 未记录，端口有服务在响应）\n' "$C_G" "$C_R"
  else
    printf '  运行中      %s否%s\n' "$C_RD" "$C_R"
  fi
  printf '  端口        %s\n' "$PORT_NOW"
  printf '  网页        %s/\n' "$BASE_URL"
  printf '  日志        %s\n' "$LOG_FILE"
  printf '  配置文件    %s\n' "$CONFIG_FILE"

  if health_ok; then
    # 健康检查只报「能不能用」；用量属于账本，走 /api/usage（本机访问无需令牌）
    ZQ_H="$(curl -fsS -m 3 "${BASE_URL}/api/health" 2>/dev/null)"
    ZQ_U="$(curl -fsS -m 3 "${BASE_URL}/api/usage" 2>/dev/null)"
    if [ -n "$ZQ_H" ]; then
      ZQ_H="$ZQ_H" ZQ_U="$ZQ_U" "$NODE_BIN" -e '
        const n=(x)=>Number(x||0).toLocaleString("en-US");
        try{
          const j=JSON.parse(process.env.ZQ_H||"{}");
          process.stdout.write("  版本        v"+j.version+"（运行 "+j.uptime_s+" 秒）\n");
          process.stdout.write("  当前 Key    "+(j.server_key&&j.server_key.configured?j.server_key.masked+"  ("+j.server_key.source+")":"未配置")+"\n");
        }catch(e){}
        try{
          const d=(JSON.parse(process.env.ZQ_U||"{}")||{}).data;
          if(d&&d.used){
            process.stdout.write("  本月用量    "+n(d.used.billed_tokens)+" / "+n(d.quota_per_month)+" token（已用 "+d.used.percent+"%）\n");
            process.stdout.write("  剩余额度    "+n(d.remaining.tokens)+" token，账期至 "+d.cycle.end+"\n");
          }
        }catch(e){}
      '
    fi
  else
    printf '  健康检查    %s无响应%s\n' "$C_Y" "$C_R"
  fi
  echo
}

show_key_status() {
  local src=""
  src="$("$NODE_BIN" -e '
    const p=process.argv[1];
    try{const c=JSON.parse(require("fs").readFileSync(p,"utf8"));if(c.api_key){process.stdout.write("config")}}catch(e){}
  ' "$CONFIG_FILE" 2>/dev/null)"
  if [ -n "$src" ]; then
    info "API Key 已配置（来自 ${CONFIG_FILE}）"
  elif [ -n "${ZHUQUE_API_KEY:-}" ]; then
    info "API Key 已配置（来自环境变量 ZHUQUE_API_KEY）"
  else
    warn "尚未配置 API Key —— 打开网页后点右上角「设置」填写即可"
  fi
}

do_logs() {
  if [ ! -f "$LOG_FILE" ]; then
    warn "暂无日志（服务可能从未启动）"
    return 0
  fi
  echo "${C_DIM}──── ${LOG_FILE}（实时，Ctrl+C 退出）────${C_R}"
  tail -n 40 -f "$LOG_FILE"
}

do_open() {
  if ! health_ok; then
    warn "服务似乎没在运行"
    if confirm "现在启动它吗？"; then do_start || return 1; else return 0; fi
  fi
  local url="${BASE_URL}/"
  if command -v open >/dev/null 2>&1; then
    open "$url" && ok "已在浏览器打开 ${url}"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" && ok "已在浏览器打开 ${url}"
  else
    info "请手动打开：${url}"
  fi
}

do_set_key() {
  echo
  info "请粘贴朱雀 API Key（输入不回显），直接回车可取消："
  printf '  Key: '
  local key=""
  if [ -t 0 ]; then
    stty -echo 2>/dev/null || true
    read -r key
    stty echo 2>/dev/null || true
    echo
  else
    read -r key
  fi
  if [ -z "$key" ]; then
    info "已取消"
    return 0
  fi
  # Key 经环境变量传给子进程，避免出现在 ps 的命令行里
  if (cd "$DIR" && ZQ_KEY="$key" "$NODE_BIN" -e 'import("./src/config-store.mjs").then(m=>m.writeConfig({api_key:process.env.ZQ_KEY}))') ; then
    ok "已保存到 ${CONFIG_FILE}"
    if [ -n "${ZHUQUE_API_KEY:-}" ]; then
      warn "注意：环境变量 ZHUQUE_API_KEY 优先级更高，会覆盖刚保存的值，请先 unset"
    fi
    if confirm "现在测试一下连接吗？"; then
      (cd "$DIR" && "$NODE_BIN" src/cli.mjs config test) || true
    fi
  else
    err "保存失败"
  fi
}

do_set_port() {
  local cur
  cur="$PORT_NOW"
  printf '  当前端口 %s，输入新端口（回车取消）：' "$cur"
  local np=""
  read -r np
  [ -z "$np" ] && { info "已取消"; return 0; }
  case "$np" in
    *[!0-9]*) err "端口必须是数字"; return 1 ;;
  esac
  if [ "$np" -lt 1 ] || [ "$np" -gt 65535 ]; then
    err "端口范围 1~65535"
    return 1
  fi
  if (cd "$DIR" && "$NODE_BIN" src/cli.mjs config set "port=${np}") >/dev/null; then
    ok "端口已改为 ${np}（需重启服务生效）"
    PORT_NOW="$np"
    BASE_URL="http://127.0.0.1:${PORT_NOW}"
    if is_running && confirm "现在重启服务以应用新端口吗？"; then
      do_restart
    fi
  else
    err "保存失败"
  fi
}

confirm() {
  printf '  %s [y/N] ' "$1"
  local a=""
  read -r a
  case "$a" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------- 交互菜单 ----------
show_menu() {
  while true; do
    echo
    printf '%s朱雀 AI 率检测 · 服务管理%s\n' "$C_B" "$C_R"
    echo "────────────────────────────────────────"
    if is_running; then
      printf '  状态：%s运行中%s  PID %s   %s%s/%s\n' "$C_G" "$C_R" "$(read_pid)" "$C_BL" "$BASE_URL" "$C_R"
    else
      printf '  状态：%s已停止%s\n' "$C_DIM$C_RD" "$C_R"
    fi
    echo
    printf '  %s1%s  启动服务器\n' "$C_B" "$C_R"
    printf '  %s2%s  停止服务器\n' "$C_B" "$C_R"
    printf '  %s3%s  重启服务器\n' "$C_B" "$C_R"
    printf '  %s4%s  查看状态 / 用量\n' "$C_B" "$C_R"
    printf '  %s5%s  打开网页界面\n' "$C_B" "$C_R"
    printf '  %s6%s  查看实时日志\n' "$C_B" "$C_R"
    printf '  %s7%s  填写 / 更换 API Key\n' "$C_B" "$C_R"
    printf '  %s8%s  修改服务端口\n' "$C_B" "$C_R"
    printf '  %s9%s  安装到 WorkBuddy / Codex（MCP）\n' "$C_B" "$C_R"
    printf '  %s0%s  退出\n' "$C_B" "$C_R"
    echo
    printf '  请选择 [0-9]: '
    local choice=""
    read -r choice
    case "$choice" in
      1) do_start ;;
      2) do_stop ;;
      3) do_restart ;;
      4) do_status ;;
      5) do_open ;;
      6) do_logs ;;
      7) do_set_key ;;
      8) do_set_port ;;
      9) do_install_mcp ;;
      0|q|Q|"") echo "  再见"; return 0 ;;
      *) warn "无效选项：${choice}" ;;
    esac
  done
}

do_install_mcp() {
  echo
  (cd "$DIR" && "$NODE_BIN" src/cli.mjs install-mcp)
  echo
}

# ---------- 参数分发 ----------
case "${1:-menu}" in
  menu|"")      show_menu ;;
  start)        do_start ;;
  quick)        do_quick ;;
  stop)         do_stop ;;
  restart)      do_restart ;;
  status)       do_status ;;
  logs|log)     do_logs ;;
  open)         do_open ;;
  key)          do_set_key ;;
  port)         do_set_port ;;
  mcp)          do_install_mcp ;;
  help|-h|--help)
    # 打印文件头部的注释块：从第 3 行起，遇到第一行非注释即停
    awk 'NR < 3 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
    ;;
  *)
    err "未知命令：$1"
    echo "  可用：menu | start | quick | stop | restart | status | logs | open | key | port | mcp"
    exit 2
    ;;
esac
