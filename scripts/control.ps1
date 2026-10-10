<#
.SYNOPSIS
    nodeagent - control operations for an installed Windows agent.

.DESCRIPTION
    Backs control.cmd. Everything Chinese-facing lives here (rather than in
    the .cmd) because CMD's code page cannot round-trip UTF-8, while this
    file is saved as UTF-8 **with BOM** so Windows PowerShell 5.1 reads it
    correctly. PowerShell 5.1 parses BOM-less .ps1 as ANSI/GBK and the
    Chinese comments then break string boundaries -> bogus syntax errors.

.PARAMETER Action
    status | start | stop | restart | logs | uninstall | uninstall-purge

.EXAMPLE
    .\control.ps1 -Action status
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('status', 'start', 'stop', 'restart', 'logs', 'uninstall', 'uninstall-purge')]
    [string]$Action,
    [int]$Port = 8765
)

$ErrorActionPreference = "Stop"

function Write-Step($m) { Write-Host "[*] $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "[+] $m" -ForegroundColor Green }
function Write-Warn($m) { Write-Host "[!] $m" -ForegroundColor Yellow }
function Write-Err($m)  { Write-Host "[x] $m" -ForegroundColor Red }

$taskName = "nodeagent"

# 数据目录：必须与 agent 侧一致 —— apps/agent/src/config.ts 的 agentDir() 是
#   process.env.NODEAGENT_HOME ?? join(homedir(), '.nodeagent')
# 计划任务里若设了 NODEAGENT_HOME，只查 %USERPROFILE%\.nodeagent 会读错配置。
$cfgDir = if ($env:NODEAGENT_HOME) { $env:NODEAGENT_HOME } else { Join-Path $env:USERPROFILE ".nodeagent" }
$cfgPath  = Join-Path $cfgDir "agent.json"
$auditLog = Join-Path $cfgDir "audit.log"

function Test-Admin {
    ([Security.Principal.WindowsPrincipal] `
        [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-TaskState {
    try { (Get-ScheduledTask -TaskName $taskName -ErrorAction Stop).State.ToString() }
    catch { "NotInstalled" }
}

# ── status ────────────────────────────────────────────────────────────────────
function Show-Status {
    Write-Host ""
    Write-Host "  nodeagent 状态" -ForegroundColor White
    Write-Host "  --------------" -ForegroundColor DarkGray

    # 计划任务
    $state = Get-TaskState
    if ($state -eq "NotInstalled") {
        Write-Warn "计划任务 '$taskName' 未安装（请先双击 install.cmd）"
    } else {
        $color = if ($state -eq "Running") { "Green" } else { "Yellow" }
        Write-Host "  计划任务 : " -NoNewline; Write-Host $state -ForegroundColor $color
        $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
        if ($info) {
            Write-Host "  上次运行 : $($info.LastRunTime)  结果码 $($info.LastTaskResult)"
        }
    }

    # 进程
    $procs = @(Get-Process node -ErrorAction SilentlyContinue)
    if ($procs.Count -gt 0) {
        Write-Host "  进程     : " -NoNewline
        Write-Host "$($procs.Count) 个 node 进程 (PID $($procs.Id -join ', '))" -ForegroundColor Green
    } else {
        Write-Host "  进程     : " -NoNewline; Write-Host "无" -ForegroundColor DarkGray
    }

    # 端口
    $listen = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($listen.Count -gt 0) {
        Write-Host "  端口     : " -NoNewline
        Write-Host "$Port 正在监听 (PID $($listen[0].OwningProcess))" -ForegroundColor Green
    } else {
        Write-Host "  端口     : " -NoNewline
        Write-Host "$Port 未监听" -ForegroundColor Yellow
    }

    # 配置
    if (Test-Path $cfgPath) {
        try {
            $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
            Write-Host "  节点 ID  : $($cfg.node_id)"
            Write-Host "  鉴权模式 : $($cfg.auth_mode)"
            $inp = if ($cfg.allow_input) { "已启用" } else { "已禁用" }
            Write-Host "  输入控制 : $inp"
            $scheme = if ($cfg.tls) { "wss" } else { "ws" }
            Write-Host "  协议     : ${scheme}://0.0.0.0:$Port"
    # ⚠️ 变量名必须用 ${ } 包起来：裸写「变量名后紧跟冒号」会被 PowerShell 当成
    #    drive 引用（如 env:），属**解析期**错误 → 整个脚本都跑不起来，
    #    stop/start/status 三个子命令会全部失效（2026-10-11 真机踩到）
        } catch {
            Write-Warn "配置文件解析失败: $cfgPath"
        }
    } else {
        Write-Warn "未找到配置文件: $cfgPath"
    }

    # 本机 IP
    $ips = @()
    try {
        $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
            Select-Object -ExpandProperty IPAddress)
    } catch { }
    Write-Host "  本机 IP  : $($ips -join ', ')"
    Write-Host ""

    if ($state -eq "NotInstalled") {
        Write-Warn "尚未安装 —— 请双击 install.cmd 一键部署"
    } elseif ($listen.Count -eq 0) {
        Write-Warn "端口未监听 —— 试试菜单里的「重启」，或双击 install.cmd 重新部署"
    }
}

# ── start / stop / restart ────────────────────────────────────────────────────
function Start-Agent {
    if ((Get-TaskState) -eq "NotInstalled") {
        Write-Err "计划任务未安装，请先双击 install.cmd"
        return
    }
    Write-Step "启动计划任务..."
    Start-ScheduledTask -TaskName $taskName
    # 轮询端口真正起来（最多 15s），而不是盲等
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Seconds 1
        if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
            Write-Ok "agent 已启动并在 $Port 监听"
            return
        }
    }
    Write-Warn "任务已触发，但 $Port 仍未监听"
    $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
    if ($info) { Write-Warn "上次运行结果码: $($info.LastTaskResult)（0 = 成功，267009 = 任务已在运行）" }
}

function Stop-Agent {
    if ((Get-TaskState) -eq "NotInstalled") {
        Write-Err "计划任务未安装"
        return
    }
    Write-Step "停止计划任务..."
    Stop-ScheduledTask -TaskName $taskName
    Start-Sleep -Seconds 1
    # 兜底：计划任务偶尔留孤儿子进程
    $left = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($left.Count -gt 0) {
        Write-Warn "端口 $Port 仍被占用 (PID $($left[0].OwningProcess))，可能有残留进程"
        Write-Warn "可手动结束: Stop-Process -Id $($left[0].OwningProcess) -Force"
    } else {
        Write-Ok "agent 已停止"
    }
}

# ── logs ──────────────────────────────────────────────────────────────────────
function Show-Logs {
    if (-not (Test-Path $auditLog)) {
        Write-Warn "未找到审计日志: $auditLog"
        Write-Warn "（审计日志需在 agent 配置中开启 audit.enabled）"
        return
    }
    Write-Step "审计日志末尾 40 条: $auditLog"
    Write-Host ""
    # 只取尾部若干行，不把整个日志（默认上限 10MB x 5 份）读进内存。
    # -Encoding UTF8 在 5.1 下能正确识别 UTF-8；解析前仍剥一次 BOM。
    $lines = @(Get-Content -LiteralPath $auditLog -Tail 40 -Encoding UTF8 -ErrorAction SilentlyContinue |
        Where-Object { $_.Trim() })
    if ($lines.Count -eq 0) { Write-Warn "日志为空"; return }

    foreach ($line in $lines) {
        if ($line[0] -eq [char]0xFEFF) { $line = $line.Substring(1) }
        try {
            $e = $line | ConvertFrom-Json
            # ts 是 Unix 毫秒（见 apps/agent/src/audit.ts 的 AuditEntry）
            $ts = "?"
            if ($e.ts) {
                try { $ts = ([DateTimeOffset]::FromUnixTimeMilliseconds([int64]$e.ts)).LocalDateTime.ToString("MM-dd HH:mm:ss") }
                catch { $ts = "$($e.ts)" }
            }
            $ty = if ($e.type) { $e.type } else { "?" }
            $ci = if ($e.client_id) { $e.client_id } else { "-" }
            $extra = ""
            if ($e.capability) { $extra += " $($e.capability)" }
            if ($e.status)      { $extra += " [$($e.status)]" }
            if ($e.duration_ms) { $extra += " $($e.duration_ms)ms" }
            if ($e.error)       { $extra += " ERROR=$($e.error)" }
            if ($e.reason)      { $extra += " reason=$($e.reason)" }
            Write-Host ("  {0,-15} {1,-20} {2,-14}{3}" -f $ts, $ty, $ci, $extra) -ForegroundColor DarkGray
        } catch {
            Write-Host "  $line" -ForegroundColor DarkGray
        }
    }
    Write-Host ""
}

# ── uninstall ─────────────────────────────────────────────────────────────────
function Uninstall-Agent([bool]$Purge) {
    if (-not (Test-Admin)) {
        Write-Err "卸载需要管理员权限，请右键 control.cmd → 以管理员身份运行"
        return
    }
    Write-Step "停止并注销计划任务..."
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

    Write-Step "移除防火墙规则..."
    Get-NetFirewallRule -DisplayName "nodeagent (TCP $Port)" -ErrorAction SilentlyContinue |
        Remove-NetFirewallRule -ErrorAction SilentlyContinue

    if ($Purge) {
        Write-Step "清除配置目录..."
        Remove-Item -Recurse -Force $cfgDir -ErrorAction SilentlyContinue
        Write-Ok "已彻底卸载（含配置与审计日志）"
    } else {
        Write-Ok "已卸载（配置保留在 $cfgDir）"
    }
}

# ── dispatch ──────────────────────────────────────────────────────────────────
switch ($Action) {
    'status'          { Show-Status }
    'start'           { Start-Agent }
    'stop'            { Stop-Agent }
    'restart'         { Stop-Agent; Start-Sleep -Seconds 1; Start-Agent }
    'logs'            { Show-Logs }
    'uninstall'       { Uninstall-Agent -Purge $false }
    'uninstall-purge' { Uninstall-Agent -Purge $true }
}
