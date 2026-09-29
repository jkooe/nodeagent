<#
.SYNOPSIS
    nodeagent - Windows agent installer.

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
    [switch]$AtStartup
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
$cfgDir  = Join-Path $env:USERPROFILE ".nodeagent"
$cfgPath = Join-Path $cfgDir "agent.json"
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null

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

$cfgJson = @{
    node_id     = $NodeId
    host        = "0.0.0.0"
    port        = $Port
    tls         = (-not $NoTls)
    key         = $Key
    log_level   = "info"
    allow_input = [bool]$AllowInput
    auth_mode   = "psk"
} | ConvertTo-Json
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
Write-Host ""
Write-Host "  Pre-shared key (copy this to the Mac side):" -ForegroundColor Yellow
Write-Host "  $Key" -ForegroundColor White
Write-Host ""
Write-Host "  On the Mac, run:" -ForegroundColor Cyan
$insecureFlag = if ($NoTls) { "" } else { " --insecure" }
$primaryIp = if ($ips.Count -gt 0) { $ips[0] } else { '<被控端IP>' }
Write-Host "  nodeagent connect $primaryIp --port $Port --key $Key$insecureFlag"
Write-Host ""
Write-Host "  Zero-trust (optional): run 'nodeagent keygen' on the Mac, then add the" -ForegroundColor DarkGray
Write-Host "  printed entry into this file's acl.clients and set auth_mode to 'ed25519'." -ForegroundColor DarkGray
Write-Host ""
