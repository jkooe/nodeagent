<#
.SYNOPSIS
    nodeagent - Windows agent installer.

    ⚠️ 本文件必须以 **UTF-8 BOM** 保存（文件头那个看不见的 U+FEFF 就是 BOM）。
       Windows PowerShell 5.1 读**无 BOM** 的 .ps1 会按系统 ANSI（中文 Windows = GBK）
       解析，本文件里的中文注释会解成乱码并被误认为引号 → 整份脚本 ParseError
       （报错位置彼此无关，真正的病灶在靠前处）。真机踩过：2026-10-04。
       另：第 4 步写 agent.json 时反而必须**无 BOM**（BOM 对 .ps1 必需、对 JSON 有害）。

.DESCRIPTION
    Registers the nodeagent agent as a scheduled task (auto-start on logon),
    opens the inbound firewall port, and prints connection info for the Mac side.

    Prerequisites on the Windows machine:
      1. Node.js 22+      (https://nodejs.org)
      2. This repository  (git clone, or copy the folder over)
      3. Built artifacts  (run `pnpm install` then `pnpm build` in the repo root)

.EXAMPLE
    # Run as Administrator from the repo root
    powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1

.EXAMPLE
    .\install.ps1 -Port 8765 -NodeId my-pc

.EXAMPLE
    # 无人值守：重启/注销后仍运行（无图形界面能力）
    .\install.ps1 -Unattended -AtStartup -AllowInput:$false
#>
[CmdletBinding()]
param(
    [int]$Port = 8765,
    [string]$NodeId = $env:COMPUTERNAME,
    [string]$Key = "",
    [switch]$NoTls,
    [switch]$AllowInput,
    [string]$ProjectRoot = "",
    # 无人值守模式：用 S4U 登录类型注册任务 —— 无需保存密码、注销/重启后仍自动运行。
    # 代价：进程运行在非交互会话（Session 0），**图形能力不可用**
    # （截屏 / UIA 找元素 / 鼠标键盘注入都依赖交互桌面）。
    [switch]$Unattended,
    # 追加「开机即启动」触发器（不依赖用户登录）
    [switch]$AtStartup,
    # v23：从**标准输入**读密钥（而非命令行 -Key）。
    # 为什么：命令行参数对同机其他用户可见（任务管理器/Get-CimInstance Win32_Process
    # 的 CommandLine 字段就是明文）。install.cmd 用 `echo <key>| powershell ...` 喂进来。
    [switch]$KeyFromStdin,
    # v24 零信任优先：控制端公钥文件路径（内容是 `nodeagent keygen` 打印的那一条 JSON，
    # 即 acl.clients 的一项）。给了它 → auth_mode 直接走 ed25519（零信任），
    # 不再依赖可被自报的 client_id。留空则自动探测脚本同目录的 client-acl.json。
    [string]$ClientAclFile = ""
)

$ErrorActionPreference = "Stop"

function Write-Step($m) { Write-Host "[*] $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "[+] $m" -ForegroundColor Green }
function Write-Warn($m) { Write-Host "[!] $m" -ForegroundColor Yellow }
function Write-Err($m)  { Write-Host "[x] $m" -ForegroundColor Red }

Write-Host ""
Write-Host "  nodeagent installer" -ForegroundColor White
Write-Host "  -------------------" -ForegroundColor DarkGray

# 1. Require Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Err "Please run this script as Administrator."
    exit 1
}

# 2. Locate runtime (bundled portable package first, else system Node.js + repo build)
Write-Step "Locating runtime..."
$bundledNode  = Join-Path $PSScriptRoot "node.exe"
$bundledAgent = Join-Path $PSScriptRoot "agent.mjs"

if ((Test-Path $bundledNode) -and (Test-Path $bundledAgent)) {
    # 便携包：使用包内运行时与被打包好的被控端，无需本机安装 Node.js
    $nodeExe = $bundledNode
    $agentJs = $bundledAgent
    if (-not $ProjectRoot) { $ProjectRoot = $PSScriptRoot }
    Write-Ok "Using bundled runtime (portable package)"
} else {
    # 开发模式：系统 Node.js + 仓库代码
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        Write-Err "Node.js not found. Install Node.js 22+ from https://nodejs.org"
        exit 1
    }
    $nodeExe = $nodeCmd.Source
    if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
    $agentJs = Join-Path $ProjectRoot "apps\agent\dist\index.js"
    if (-not (Test-Path $agentJs)) {
        Write-Err "Agent build not found: $agentJs"
        Write-Warn "Run 'pnpm install' and 'pnpm build' in the repo root first."
        exit 1
    }
    Write-Ok "Using system Node.js"
}

$ver = (& $nodeExe --version).TrimStart('v')
$major = [int]($ver.Split('.')[0])
if ($major -lt 22) {
    Write-Err "Node.js 22+ required, found v$ver"
    exit 1
}
Write-Ok "Node.js v$ver"
Write-Ok "Agent entry: $agentJs"

# 4. Config + pre-shared key
# 数据目录必须与 agent 侧一致 —— apps/agent/src/config.ts 的 agentDir() 是
#   process.env.NODEAGENT_HOME ?? join(homedir(), '.nodeagent')
# 若计划任务环境里设了 NODEAGENT_HOME 而这里写死 USERPROFILE\.nodeagent，
# 就会「配置写A、读取B」，表现为装完连不上（E_AUTH_FAILED）。
$cfgDir  = if ($env:NODEAGENT_HOME) { $env:NODEAGENT_HOME } else { Join-Path $env:USERPROFILE ".nodeagent" }
$cfgPath = Join-Path $cfgDir "agent.json"
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null

# v23：stdin 读取要在「复用既有配置」之前 —— 调用方显式给了 key 就以它为准。
# 同时规避了一个易错点：[Console]::In.ReadLine() 在没有管道时会阻塞，
# 所以必须先判 [Console]::IsInputRedirected。
if ($KeyFromStdin -and -not $Key) {
    if (-not [Console]::IsInputRedirected) {
        Write-Err "-KeyFromStdin requires the key on stdin (e.g. from install.cmd's pipe)."
        exit 1
    }
    $line = [Console]::In.ReadLine()
    if (-not $line) {
        Write-Err "stdin was empty; no key to read."
        exit 1
    }
    # 管道会带入 CRLF/首尾空白；密钥是纯 hex，一律 Trim
    $Key = $line.Trim()
    if ($Key -notmatch '^[0-9a-fA-F]{16,128}$') {
        Write-Err "key from stdin is not valid hex (16-128 chars)."
        exit 1
    }
    Write-Ok "Key read from stdin (not visible in process command line)"
}

if (Test-Path $cfgPath) {
    try { $existing = Get-Content $cfgPath -Raw | ConvertFrom-Json } catch { $existing = $null }
    if ($existing -and -not $Key) {
        $Key = $existing.key
        Write-Ok "Existing config found, reusing its key"
    }
}
if (-not $Key) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $Key = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
    Write-Ok "Generated a new pre-shared key"
}

# --- v24: zero-trust-first -------------------------------------------------
# PSK 有一个固有弱点：client_id 是调用方**自报**的，所以"谁知道共享 key，谁就能
# 冒充任意未登记的 client_id"—— ACL 的身份维度在 psk 模式下形同虚设。
# ed25519 没有这个问题（身份由私钥签名决定）。故：**只要拿到控制端公钥就走 ed25519**。
$aclEntry = $null
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$aclPath = if ($ClientAclFile) { $ClientAclFile } else { Join-Path $scriptDir 'client-acl.json' }
if (Test-Path $aclPath) {
    try { $aclEntry = Get-Content $aclPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $aclEntry = $null }
    if ($aclEntry -and (-not $aclEntry.client_id -or -not $aclEntry.pubkey)) {
        Write-Warn "client-acl.json is missing client_id or pubkey - ignored"
        $aclEntry = $null
    }
}
$useZeroTrust = ($aclEntry -ne $null)

$cfgObj = [ordered]@{
    node_id     = $NodeId
    host        = "0.0.0.0"
    port        = $Port
    tls         = (-not $NoTls)
    key         = $Key
    log_level   = "info"
    allow_input = [bool]$AllowInput
    auth_mode   = if ($useZeroTrust) { "ed25519" } else { "psk" }
}
if ($useZeroTrust) {
    # default_effect=deny：未在 clients 中登记的一律拒绝（零信任兜底）
    $cfgObj.acl = @{
        default_effect = "deny"
        clients        = @($aclEntry)
    }
}
$cfgJson = $cfgObj | ConvertTo-Json -Depth 6
# 必须写「无 BOM」的 UTF-8：Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8`
# 会写入 BOM（U+FEFF），导致 Node 侧 JSON.parse 报 "Unexpected token ''"
[System.IO.File]::WriteAllText($cfgPath, $cfgJson, (New-Object System.Text.UTF8Encoding($false)))
Write-Ok "Config written: $cfgPath"

# 5. Firewall (inbound, agent listens)
Write-Step "Configuring firewall..."
$ruleName = "nodeagent (TCP $Port)"
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $Port -Profile Any | Out-Null
Write-Ok "Inbound rule allowed on TCP $Port"

# 6. Scheduled task
Write-Step "Registering scheduled task..."
$taskName = "nodeagent"
$action   = New-ScheduledTaskAction -Execute $nodeExe -Argument "`"$agentJs`"" -WorkingDirectory $ProjectRoot

# 触发器：登录时（默认）+ 可选开机时；无人值守模式下开机触发器才真正有意义
$triggers = @(New-ScheduledTaskTrigger -AtLogOn)
if ($AtStartup -or $Unattended) {
    $triggers += New-ScheduledTaskTrigger -AtStartup
}

# 自愈：异常退出后自动重启（最多 3 次，间隔 1 分钟），且不设执行时长上限
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -StartWhenAvailable

# 登录类型决定「能干什么」：
#   Interactive —— 运行在交互会话，**图形能力可用**，但注销后停
#   S4U         —— 无需密码、注销/重启后仍运行，但**图形能力不可用**（见 -Unattended 说明）
if ($Unattended) {
    if ($AllowInput) {
        Write-Warn "-Unattended 与 -AllowInput 冲突：Session 0 无法注入输入，已强制关闭输入控制"
        $AllowInput = $false
        # 回写配置，避免配置与运行模式不一致
        $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $cfg.allow_input = $false
        [System.IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
    }
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
        -RunLevel Highest -LogonType S4U
    Write-Warn "无人值守模式：agent 将在非交互会话运行"
    Write-Warn "  → 可用：exec / 文件传输 / 进程与服务 / 审计 / 重启 / 异步任务 / 剪贴板"
    Write-Warn "  → 不可用：截屏、UIA 找元素、鼠标键盘注入（需交互桌面）"
} else {
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
        -RunLevel Highest -LogonType Interactive
}

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers `
    -Settings $settings -Principal $principal `
    -Description "nodeagent - cross-machine AI takeover agent" | Out-Null
$modeLabel = if ($Unattended) { "unattended (S4U, survives logoff)" } else { "interactive (logon)" }
Write-Ok "Scheduled task '$taskName' registered — mode: $modeLabel"

# 7. Start now
Write-Step "Starting agent..."
Start-ScheduledTask -TaskName $taskName

# 等待端口真正进入监听（最多 15s）；失败则给出可执行的诊断步骤
$listening = $false
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 1
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        $listening = $true
        break
    }
}
$state = (Get-ScheduledTask -TaskName $taskName).State

if ($listening) {
    Write-Ok "Agent is listening on port $Port (task state: $state)"
} else {
    Write-Warn "Task state: $state, but port $Port is NOT listening"
    $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
    if ($info) { Write-Warn "Last run result: $($info.LastTaskResult)" }
    Write-Warn "Troubleshoot:"
    Write-Warn "  1) Start the task manually:  Start-ScheduledTask -TaskName nodeagent"
    Write-Warn "  2) Check the process:        Get-Process node"
    Write-Warn "  3) Run in foreground to see the real error:"
    Write-Warn "     & '$nodeExe' '$agentJs'"
}

# 8. Print connection info
$ips = @()
try {
    $ips = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
        Select-Object -ExpandProperty IPAddress)
} catch { }

$scheme = if ($NoTls) { "ws" } else { "wss" }

Write-Host ""
Write-Host "  Installation complete" -ForegroundColor Green
Write-Host "  ---------------------" -ForegroundColor DarkGray
Write-Host "  Node ID   : $NodeId"
Write-Host "  Listen    : 0.0.0.0:$Port ($scheme)"
Write-Host "  Local IP  : $($ips -join ', ')"
Write-Host "  Node.js   : $nodeExe"
Write-Host "  Config    : $cfgPath"
$ctlLabel = if ($AllowInput) { "ENABLED (mouse/keyboard control)" } else { "disabled (default)" }
Write-Host "  Input ctl : $ctlLabel"
Write-Host "  Auth mode : psk (pre-shared key)"
Write-Host "  Discovery : UDP 8766 heartbeat (LAN auto-discovery; outbound only)"
# v21: TLS certificate fingerprint (sha256 of DER) — the Mac side pins this (TOFU).
# This must match what nodeagent computes, so out-of-band verification is possible:
# the Mac prints the same value at first connect; compare the two.
$certFp = ""
try {
    $certPath = Join-Path (Split-Path -Parent $cfgPath) "certs\cert.pem"
    if (Test-Path -LiteralPath $certPath) {
        $x = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList $certPath
        $sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash($x.GetRawCertData())
        $certFp = ($sha | ForEach-Object { $_.ToString("x2") }) -join ""
    }
} catch { }

Write-Host ""
Write-Host "  Pre-shared key (copy this to the Mac side):" -ForegroundColor Yellow
Write-Host "  $Key" -ForegroundColor White
if ($certFp) {
    Write-Host ""
    Write-Host "  TLS cert fingerprint (verify the Mac side pinned the same one):" -ForegroundColor Yellow
    Write-Host "  $certFp" -ForegroundColor White
}
Write-Host ""
$primaryIp = if ($ips.Count -gt 0) { $ips[0] } else { '<target-ip>' }
$insecureFlag = if ($NoTls) { "" } else { " --insecure" }
if ($useZeroTrust) {
    Write-Host "  Zero-trust is ON (auth_mode=ed25519, default_effect=deny)." -ForegroundColor Green
    Write-Host "  Registered client_id: $($aclEntry.client_id)" -ForegroundColor Green
    Write-Host ""
    Write-Host "  On the Mac, connect with the private key you generated:" -ForegroundColor Cyan
    Write-Host "  nodeagent connect $primaryIp --port $Port --id $($aclEntry.client_id) --auth-mode ed25519$insecureFlag"
} else {
    Write-Host "  On the Mac, run:" -ForegroundColor Cyan
    Write-Host "  nodeagent connect $primaryIp --port $Port --key $Key$insecureFlag"
    Write-Host ""
    Write-Host "  ================  SECURITY WARNING  ================" -ForegroundColor Yellow
    Write-Host "  This agent runs in PSK mode, where the client_id is" -ForegroundColor Yellow
    Write-Host "  SELF-REPORTED: anyone holding the shared key can" -ForegroundColor Yellow
    Write-Host "  impersonate any unregistered client_id, so the ACL" -ForegroundColor Yellow
    Write-Host "  identity dimension is effectively void." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  To switch to zero-trust (recommended):" -ForegroundColor Cyan
    Write-Host "    1) On the Mac: nodeagent keygen --id <name>" -ForegroundColor Cyan
    Write-Host "    2) Save the printed JSON as client-acl.json next to this script" -ForegroundColor Cyan
    Write-Host "    3) Re-run install.cmd (it auto-detects the file)" -ForegroundColor Cyan
    Write-Host "  ====================================================" -ForegroundColor Yellow
}
Write-Host ""
