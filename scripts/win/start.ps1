# =====================================================================
# 朱雀 AI 率检测 · Windows 服务管理器
#
#   start.ps1              打开交互菜单
#   start.ps1 start        启动服务（后台运行）
#   start.ps1 stop         停止服务
#   start.ps1 restart      重启
#   start.ps1 status       查看状态 / 用量
#   start.ps1 logs         查看实时日志
#   start.ps1 open         打开网页界面
#   start.ps1 key          交互式填写 API Key
#   start.ps1 port         修改服务端口
#   start.ps1 mcp          安装到 WorkBuddy / Codex
#
# 一般情况下不需要直接运行本脚本，双击目录里的「启动.cmd」即可。
# =====================================================================

$ErrorActionPreference = 'Continue'

# 让控制台按 UTF-8 输出，避免中文乱码
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$Root       = $PSScriptRoot
if (-not (Test-Path (Join-Path $Root 'src\cli.mjs'))) { $Root = [IO.Path]::GetFullPath((Join-Path $Root '..\..')) }
# 配置文件路径必须与 server / cli 完全一致（它们都优先读 ZHUQUE_CONFIG_FILE），
# 否则 status / stop / open 会作用在与真实服务不同的端口上。
$StateDir   = Join-Path $env:USERPROFILE '.zhuque'
if ($env:ZHUQUE_CONFIG_FILE) {
  $ConfigFile = [System.IO.Path]::GetFullPath($env:ZHUQUE_CONFIG_FILE)
  $StateDir   = Split-Path -Parent $ConfigFile
} else {
  $ConfigFile = Join-Path $StateDir 'config.json'
}
$PidFile    = Join-Path $StateDir 'server.pid'
$LogFile    = Join-Path $StateDir 'server.log'
$ErrLogFile = Join-Path $StateDir 'server.err.log'
$DefaultPort = 8787

# ---------------------------------------------------------------- 输出
function Write-Ok($msg)   { Write-Host "  [OK] " -ForegroundColor Green  -NoNewline; Write-Host $msg }
function Write-Warn2($msg){ Write-Host "  [!!] " -ForegroundColor Yellow -NoNewline; Write-Host $msg }
function Write-Err2($msg) { Write-Host "  [XX] " -ForegroundColor Red    -NoNewline; Write-Host $msg }
function Write-Info($msg) { Write-Host "  --   $msg" -ForegroundColor DarkGray }

# ---------------------------------------------------------------- node
function Resolve-Node {
  if ($env:ZHUQUE_NODE -and (Test-Path $env:ZHUQUE_NODE)) { return $env:ZHUQUE_NODE }

  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Volta\bin\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'pnpm\node.exe'),
    (Join-Path $env:APPDATA 'nvm\node.exe'),
    (Join-Path $env:APPDATA 'fnm\aliases\default\node.exe'),
    (Join-Path $env:USERPROFILE 'scoop\shims\node.exe')
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { return $c }
  }

  # nvm-windows：按版本目录倒序找第一个可用的（不写死任何版本号）
  $nvmDirs = @(
    $env:NVM_HOME,
    (Join-Path $env:APPDATA 'nvm'),
    (Join-Path $env:USERPROFILE '.nvm')
  )
  foreach ($dir in $nvmDirs) {
    if (-not $dir -or -not (Test-Path $dir)) { continue }
    $found = Get-ChildItem -Path $dir -Filter 'v*' -Directory -ErrorAction SilentlyContinue |
             Sort-Object Name -Descending |
             ForEach-Object { Join-Path $_.FullName 'node.exe' } |
             Where-Object { Test-Path $_ } |
             Select-Object -First 1
    if ($found) { return $found }
  }
  return $null
}

$Node = Resolve-Node
if (-not $Node) {
  Write-Host ''
  Write-Err2 '未找到 Node.js。'
  Write-Host ''
  Write-Host '  本工具需要 Node.js 22 或更高版本。请任选一种方式安装：' -ForegroundColor White
  Write-Host '    1) 官网下载安装包： https://nodejs.org/  （推荐选 LTS 版本）'
  Write-Host '    2) 用 winget 安装：  winget install OpenJS.NodeJS.LTS'
  Write-Host ''
  Write-Host '  装完后请关闭本窗口，重新双击「启动.cmd」。' -ForegroundColor White
  Write-Host '  如果 node 已装但仍提示找不到，可设环境变量 ZHUQUE_NODE 指向 node.exe 的完整路径。'
  Write-Host ''
  exit 127
}

$major = 0
try { $major = [int]((& $Node -v) -replace '^v(\d+)\..*$', '$1') } catch {}
if ($major -lt 22) { Write-Err2 '需要 Node.js 22 或更新的受支持版本'; exit 127 }

# ---------------------------------------------------------------- 端口
function Get-ServicePort {
  if (Test-Path $ConfigFile) {
    try {
      $j = Get-Content $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
      $n = 0
      if ($j.port -and [int]::TryParse([string]$j.port, [ref]$n) -and $n -ge 1 -and $n -le 65535) { return $n }
    } catch {}
  }
  # $env:PORT 非法时不能直接 [int] 强转（会抛错），先校验
  if ($env:PORT -match '^\d+$') {
    $n = [int]$env:PORT
    if ($n -ge 1 -and $n -le 65535) { return $n }
  }
  return $DefaultPort
}

$Script:Port    = Get-ServicePort
$Script:BaseUrl = "http://127.0.0.1:$($Script:Port)"

# ---------------------------------------------------------------- 状态
function Get-RunningPid {
  if (-not (Test-Path $PidFile)) { return $null }
  try {
    $record = Get-Content $PidFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $procId = [int]$record.id
    if ($procId -le 1) { return $null }
    $proc = Get-Process -Id $procId -ErrorAction Stop
    if ([string]$proc.StartTime.ToUniversalTime().Ticks -ne [string]$record.started) { return $null }
    $info = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction Stop
    $expected = '"' + (Join-Path $Root 'src\server.mjs') + '"'
    if ($info.ExecutablePath -ieq $Node -and $info.CommandLine.Contains($expected)) { return $procId }
  } catch { return $null }
  return $null
}

function Get-ListenerPid {
  try {
    $conn = Get-NetTCPConnection -LocalPort $Script:Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
    if ($conn) { return [int]$conn.OwningProcess }
  } catch {}
  return $null
}

function Test-Healthy {
  try {
    $r = Invoke-RestMethod -Uri "$($Script:BaseUrl)/api/health" -TimeoutSec 3 -ErrorAction Stop
    if ($r.service -eq 'zhuque-detect' -and $r.ok) { return $r }
    return $null
  } catch {
    return $null
  }
}

# ---------------------------------------------------------------- 动作
function Do-Start {
  $running = Get-RunningPid
  if ($running) {
    Write-Warn2 "服务已在运行（PID $running）"
    Write-Info "网页地址：$($Script:BaseUrl)/"
    return
  }

  $listener = Get-ListenerPid
  if ($listener) {
    Write-Err2 "端口 $($Script:Port) 已被进程 $listener 占用"
    Write-Info "可在菜单里选「修改服务端口」，或编辑 $ConfigFile"
    return
  }

  if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
  Set-Content -Path $LogFile    -Value '' -Encoding UTF8
  Set-Content -Path $ErrLogFile -Value '' -Encoding UTF8

  Write-Info "正在启动服务（端口 $($Script:Port)）…"

  $serverJs = Join-Path $Root 'src\server.mjs'
  try {
    # 显式带上端口：保证服务真的监听在 $Script:Port
    $proc = Start-Process -FilePath $Node `
                          -ArgumentList @(('"' + $serverJs + '"'), '--port', "$($Script:Port)") `
                          -WorkingDirectory $Root `
                          -WindowStyle Hidden `
                          -RedirectStandardOutput $LogFile `
                          -RedirectStandardError $ErrLogFile `
                          -PassThru -ErrorAction Stop
  } catch {
    Write-Err2 "启动失败：$($_.Exception.Message)"
    return
  }

  @{ id = $proc.Id; started = [string]$proc.StartTime.ToUniversalTime().Ticks } | ConvertTo-Json | Set-Content -Path $PidFile -Encoding UTF8

  # 等待健康检查通过（最多约 12 秒）
  $health = $null
  for ($i = 0; $i -lt 48; $i++) {
    $health = Test-Healthy
    if ($health) { break }
    if ($proc.HasExited) { break }
    Start-Sleep -Milliseconds 250
  }

  if ($health) {
    Do-Status
    Write-Ok "服务已启动（PID $($proc.Id)）"
    Write-Host ''
    Write-Host "    网页      $($Script:BaseUrl)/" -ForegroundColor White
    Write-Host "    接口      POST $($Script:BaseUrl)/api/detect" -ForegroundColor White
    Write-Host "    日志      $LogFile" -ForegroundColor White
    Write-Host ''
    return
  }

  Write-Err2 '启动失败，日志尾部：'
  if (Test-Path $LogFile)    { Get-Content $LogFile -Tail 20 | ForEach-Object { Write-Host "      $_" } }
  if (Test-Path $ErrLogFile) {
    $e = Get-Content $ErrLogFile -Tail 20
    if ($e) { $e | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkYellow } }
  }
}

function Do-Stop {
  $running = Get-RunningPid
  if (-not $running) {
    if (Test-Path $PidFile) {
      Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
      Write-Info '已清理残留的 PID 文件'
    }
    $listener = Get-ListenerPid
    if ($listener) {
      Write-Warn2 "端口 $($Script:Port) 被进程 $listener 占用，但它不是本脚本启动的"
      Write-Info "如果确认要结束它： Stop-Process -Id $listener -Force"
    } else {
      Write-Warn2 '服务未在运行'
    }
    return
  }

  Write-Info "正在停止服务（PID $running）…"
  try {
    Stop-Process -Id $running -Force -ErrorAction Stop
  } catch {
    Write-Err2 "停止失败：$($_.Exception.Message)"
    return
  }

  for ($i = 0; $i -lt 20; $i++) {
    if (-not (Get-Process -Id $running -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 250
  }

  if (Get-Process -Id $running -ErrorAction SilentlyContinue) {
    Write-Err2 '停止失败，进程仍在运行'
  } else {
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    Write-Ok '服务已停止'
  }
}

function Do-Restart {
  Do-Stop
  Start-Sleep -Milliseconds 500
  Do-Start
}

function Do-Status {
  Write-Host ''
  Write-Host '  服务状态' -ForegroundColor White
  Write-Host '  ────────────────────────────────────────'

  $h = Test-Healthy
  $running = Get-RunningPid
  if ($running) {
    Write-Host '    运行中      ' -NoNewline; Write-Host '是' -ForegroundColor Green -NoNewline; Write-Host " （PID $running）"
  } elseif ($h) {
    # 服务在响应，但 PID 文件没记录（例如直接用 node src/server.mjs 起的，或 PID 文件已过期）
    Write-Host '    运行中      ' -NoNewline; Write-Host '是' -ForegroundColor Green -NoNewline; Write-Host ' （PID 未记录，端口有服务在响应）'
  } else {
    Write-Host '    运行中      ' -NoNewline; Write-Host '否' -ForegroundColor Red
  }
  Write-Host "    端口        $($Script:Port)"
  Write-Host "    网页        $($Script:BaseUrl)/"
  Write-Host "    日志        $LogFile"
  Write-Host "    配置文件    $ConfigFile"

  if ($h) {
    Write-Host "    版本        v$($h.version)（已运行 $($h.uptime_s) 秒）"
    if ($h.server_key -and $h.server_key.configured) {
      Write-Host "    当前 Key    $($h.server_key.masked)  ($($h.server_key.source))"
    } else {
      Write-Host '    当前 Key    ' -NoNewline; Write-Host '未配置' -ForegroundColor Yellow
    }
    # /api/health 只回「能不能用」；用量属于账本，单独走 /api/usage
    try {
      $u = Invoke-RestMethod -Uri "$($Script:BaseUrl)/api/usage" -TimeoutSec 3 -ErrorAction Stop
      if ($u.ok -and $u.data -and $u.data.used) {
        $used = '{0:N0}' -f [double]$u.data.used.billed_tokens
        $quota = '{0:N0}' -f [double]$u.data.quota_per_month
        $left = '{0:N0}' -f [double]$u.data.remaining.tokens
        Write-Host "    本月用量    $used / $quota token（已用 $($u.data.used.percent)%）"
        Write-Host "    剩余额度    $left token，账期至 $($u.data.cycle.end)"
      }
    } catch {}
  } else {
    Write-Host '    健康检查    ' -NoNewline; Write-Host '无响应' -ForegroundColor Yellow
  }
  Write-Host ''
}

function Do-Logs {
  if (-not (Test-Path $LogFile)) {
    Write-Warn2 '暂无日志（服务可能从未启动）'
    return
  }
  Write-Host "  ──── $LogFile（实时输出，按 Ctrl+C 退出）────" -ForegroundColor DarkGray
  Get-Content $LogFile -Tail 40 -Wait
}

function Do-Open {
  if (-not (Test-Healthy)) {
    Write-Warn2 '服务似乎没在运行'
    $a = Read-Host '  现在启动它吗？ [y/N]'
    if ($a -match '^(y|Y|yes|YES)$') { Do-Start } else { return }
  }
  $url = "$($Script:BaseUrl)/"
  Start-Process $url
  Write-Ok "已在浏览器打开 $url"
}

function Do-SetKey {
  Write-Host ''
  Write-Info '请粘贴朱雀 API Key（输入不回显；直接回车取消）：'
  $sec = Read-Host '  Key' -AsSecureString
  $key = [System.Net.NetworkCredential]::new('', $sec).Password
  if (-not $key) { Write-Info '已取消'; return }
  $key = $key.Trim()
  if (-not $key) { Write-Info '已取消'; return }

  # Key 经环境变量传给子进程，避免出现在进程命令行里
  $storeUrl = ([System.Uri](Join-Path $Root 'src\config-store.mjs')).AbsoluteUri
  $env:ZQ_KEY = $key
  try {
    & $Node -e 'import(process.argv[1]).then(m => m.writeConfig({ api_key: process.env.ZQ_KEY }))' $storeUrl
  } finally {
    Remove-Item Env:ZQ_KEY -ErrorAction SilentlyContinue
  }
  if ($LASTEXITCODE -eq 0) {
    Write-Ok "已保存到 $ConfigFile"
    if ($env:ZHUQUE_API_KEY) {
      Write-Warn2 '注意：环境变量 ZHUQUE_API_KEY 优先级更高，会覆盖刚保存的值'
    }
    $a = Read-Host '  现在测试一下连接吗？ [y/N]'
    if ($a -match '^(y|Y|yes|YES)$') {
      & $Node (Join-Path $Root 'src\cli.mjs') config test
    }
  } else {
    Write-Err2 '保存失败'
  }
}

function Do-SetPort {
  $cur = $Script:Port
  $np = Read-Host "  当前端口 $cur，输入新端口（回车取消）"
  if (-not $np) { Write-Info '已取消'; return }
  if ($np -notmatch '^\d+$') { Write-Err2 '端口必须是数字'; return }
  $n = [int]$np
  if ($n -lt 1 -or $n -gt 65535) { Write-Err2 '端口范围 1~65535'; return }

  & $Node (Join-Path $Root 'src\cli.mjs') config set "port=$n" | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Write-Ok "端口已改为 $n（需重启服务生效）"
    $Script:Port = $n
    $Script:BaseUrl = "http://127.0.0.1:$n"
    if ((Get-RunningPid)) {
      $a = Read-Host '  现在重启服务以应用新端口吗？ [y/N]'
      if ($a -match '^(y|Y|yes|YES)$') { Do-Restart }
    }
  } else {
    Write-Err2 '保存失败'
  }
}

function Do-InstallMcp {
  Write-Host ''
  & $Node (Join-Path $Root 'src\cli.mjs') install-mcp
  Write-Host ''
}

# 一键：启动服务并直接打开网页（给「启动服务.cmd」用）
function Do-Quick {
  Do-Start
  if (Test-Healthy) {
    $url = "$($Script:BaseUrl)/"
    Start-Process $url
    Write-Ok "已在浏览器打开 $url"
  } else {
    Write-Warn2 '服务未就绪，请先看上面的日志排查'
  }
}

# ---------------------------------------------------------------- 菜单
function Show-Menu {
  while ($true) {
    Write-Host ''
    Write-Host '  朱雀 AI 率检测 · 服务管理（Windows）' -ForegroundColor White
    Write-Host '  ────────────────────────────────────────'
    $running = Get-RunningPid
    if ($running) {
      Write-Host '    状态：' -NoNewline
      Write-Host '运行中' -ForegroundColor Green -NoNewline
      Write-Host "  PID $running   $($Script:BaseUrl)/" -ForegroundColor Cyan
    } else {
      Write-Host '    状态：' -NoNewline
      Write-Host '已停止' -ForegroundColor DarkRed
    }
    Write-Host ''
    Write-Host '    1  启动服务器'
    Write-Host '    2  停止服务器'
    Write-Host '    3  重启服务器'
    Write-Host '    4  查看状态 / 用量'
    Write-Host '    5  打开网页界面'
    Write-Host '    6  查看实时日志'
    Write-Host '    7  填写 / 更换 API Key'
    Write-Host '    8  修改服务端口'
    Write-Host '    9  安装到 WorkBuddy / Codex（MCP）'
    Write-Host '    0  退出'
    Write-Host ''
    $choice = Read-Host '    请选择 [0-9]'

    switch ($choice) {
      '1' { Do-Start }
      '2' { Do-Stop }
      '3' { Do-Restart }
      '4' { Do-Status }
      '5' { Do-Open }
      '6' { Do-Logs }
      '7' { Do-SetKey }
      '8' { Do-SetPort }
      '9' { Do-InstallMcp }
      '0' { Write-Host '    再见'; return }
      default { Write-Warn2 "无效选项：$choice" }
    }
  }
}

# ---------------------------------------------------------------- 分发
$action = if ($args.Count -gt 0) { $args[0] } else { 'menu' }

switch ($action) {
  'menu'            { Show-Menu }
  'start'           { Do-Start }
  'quick'           { Do-Quick }
  'stop'            { Do-Stop }
  'restart'         { Do-Restart }
  'status'          { Do-Status }
  'logs'            { Do-Logs }
  'log'             { Do-Logs }
  'open'            { Do-Open }
  'key'             { Do-SetKey }
  'port'            { Do-SetPort }
  'mcp'             { Do-InstallMcp }
  # 打印文件头部的注释块：遇到第一行非注释即停（不写死行号）
  'help'            {
    foreach ($line in (Get-Content -LiteralPath $PSCommandPath)) {
      if ($line -match '^\s*#') { Write-Host ($line -replace '^\s*#\s?', '') }
      elseif ($line.Trim() -ne '') { break }
    }
  }
  default {
    Write-Err2 "未知命令：$action"
    Write-Host '    可用：menu | start | stop | restart | status | logs | open | key | port | mcp'
  }
}
