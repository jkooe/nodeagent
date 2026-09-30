<#
.SYNOPSIS
    nodeagent 网络救援脚本 —— 被控端因网络变更失联后的本地恢复。

.DESCRIPTION
    背景：`system.net.apply` 是两阶段提交（未确认自动回滚），但**如果回滚本身也失败**
    （例如变更脚本把地址删掉了却没加上），机器可能落到 APIPA（169.254.x.x）而彻底失联。
    这个脚本就是为那一天准备的：在**被控端本机**以管理员运行，把网络恢复到可用状态。

    它做的事：
      1. 列出所有网卡与当前地址（先看清现状）
      2. 找出「有物理连接、但没有有效 IPv4」的网卡（典型的失联状态）
      3. 把指定/自动识别的网卡设回给定静态地址，或切回 DHCP
      4. 用**原生 NetTCPIP cmdlet** 按安全顺序执行：
         先加地址 → 再清其它地址与残留默认路由 → 最后补默认路由
         （顺序颠倒会踩 Windows 的「already exists」而再次失败 —— 真机事故根因）

.PARAMETER Interface
    网卡别名（如「以太网」）。省略则自动选取「已连接但无有效 IPv4」的那块。

.PARAMETER Ip / PrefixLength / Gateway / Dns
    要恢复的静态配置；省略 Ip 则切回 DHCP。

.PARAMETER ListOnly
    只看现状，不做任何变更。

.EXAMPLE
    # 先看现状
    powershell -ExecutionPolicy Bypass -File rescue-network.ps1 -ListOnly

.EXAMPLE
    # 恢复为原静态地址（最常用）
    powershell -ExecutionPolicy Bypass -File rescue-network.ps1 `
        -Interface '以太网' -Ip 192.168.0.159 -PrefixLength 24 -Gateway 192.168.0.1

.EXAMPLE
    # 切回 DHCP（家里路由器会重新分配地址）
    powershell -ExecutionPolicy Bypass -File rescue-network.ps1 -Interface '以太网'
#>
[CmdletBinding()]
param(
    [string]$Interface,
    [string]$Ip,
    [int]$PrefixLength = 24,
    [string]$Gateway,
    [string[]]$Dns,
    [switch]$ListOnly
)

$ErrorActionPreference = 'Continue'

function Write-Step($m) { Write-Host "[*] $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "[+] $m" -ForegroundColor Green }
function Write-Warn2($m) { Write-Host "[!] $m" -ForegroundColor Yellow }
function Write-Err2($m)  { Write-Host "[x] $m" -ForegroundColor Red }

Write-Host ""
Write-Host "  nodeagent 网络救援" -ForegroundColor White
Write-Host "  ------------------" -ForegroundColor DarkGray

# ---------- 1. 现状 ----------
Write-Step "当前网卡与地址："
$adapters = Get-NetAdapter | Sort-Object ifIndex
foreach ($a in $adapters) {
    $addrs = @(Get-NetIPAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.PrefixOrigin -ne 'WellKnown' } | ForEach-Object { "$($_.IPAddress)/$($_.PrefixLength)" })
    $dhcp = (Get-NetIPInterface -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue).Dhcp
    $mark = if ($a.Status -eq 'Up' -and $addrs.Count -eq 0) { ' <== 已连接但无地址（疑似失联）' } else { '' }
    Write-Host ("    {0,-22} {1,-8} dhcp={2,-8} {3}{4}" -f $a.Name, $a.Status, $dhcp, ($addrs -join ', '), $mark)
}

$gw = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
    ForEach-Object { "$($_.NextHop) (ifIndex $($_.ifIndex))" })
# 注意：PowerShell 5.1 的 if 不能当表达式内联在括号里 —— 必须先算好再拼（写错会直接语法错误）
$gwText = if ($gw.Count -gt 0) { $gw -join ', ' } else { '（无 —— 这就是回包发不出去的原因）' }
Write-Step ("默认路由: " + $gwText)

if ($ListOnly) { Write-Host ""; Write-Ok "仅查看模式，未做任何变更"; exit 0 }

# ---------- 2. 选目标网卡 ----------
if (-not $Interface) {
    $cand = $adapters | Where-Object {
        $_.Status -eq 'Up' -and
        @(Get-NetIPAddress -InterfaceIndex $_.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.PrefixOrigin -ne 'WellKnown' }).Count -eq 0
    } | Select-Object -First 1
    if (-not $cand) {
        $cand = $adapters | Where-Object { $_.Status -eq 'Up' } | Select-Object -First 1
    }
    if (-not $cand) { Write-Err2 "找不到可用的已连接网卡，请用 -Interface 指定"; exit 1 }
    $Interface = $cand.Name
    Write-Warn2 "未指定网卡，自动选用：$Interface"
}

if (-not (Get-NetAdapter -Name $Interface -ErrorAction SilentlyContinue)) {
    Write-Err2 "网卡不存在：$Interface"; exit 1
}

# ---------- 3. 执行 ----------
if (-not $Ip) {
    Write-Step "切回 DHCP：$Interface"
    Set-NetIPInterface -InterfaceAlias $Interface -Dhcp Enabled -ErrorAction SilentlyContinue
    Set-DnsClientServerAddress -InterfaceAlias $Interface -ResetServerAddresses -ErrorAction SilentlyContinue
    Write-Ok "已切回 DHCP（稍等几秒应拿到地址）"
} else {
    Write-Step "恢复静态地址 $Ip/$PrefixLength （网卡 $Interface）"
    Set-NetIPInterface -InterfaceAlias $Interface -Dhcp Disabled -ErrorAction SilentlyContinue

    # ⚠️ 顺序不可颠倒：先加新地址（过渡期链路不断），再清旧地址/残留路由，最后补路由。
    #    颠倒会触发 Windows 的「实例已存在」→ 地址加不上 → 再次失联（真机事故根因）。
    New-NetIPAddress -InterfaceAlias $Interface -IPAddress $Ip -PrefixLength $PrefixLength -ErrorAction SilentlyContinue | Out-Null

    Get-NetRoute -InterfaceAlias $Interface -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
        Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue

    Get-NetIPAddress -InterfaceAlias $Interface -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -ne $Ip -and $_.PrefixOrigin -ne 'WellKnown' } |
        ForEach-Object { Remove-NetIPAddress -IPAddress $_.IPAddress -InterfaceAlias $Interface -Confirm:$false -ErrorAction SilentlyContinue }

    if ($Gateway) {
        New-NetRoute -InterfaceAlias $Interface -DestinationPrefix '0.0.0.0/0' -NextHop $Gateway -ErrorAction SilentlyContinue | Out-Null
    }
    if ($Dns -and $Dns.Count -gt 0) {
        Set-DnsClientServerAddress -InterfaceAlias $Interface -ServerAddresses $Dns -ErrorAction SilentlyContinue
    }
}

Start-Sleep -Seconds 3

# ---------- 4. 自检 ----------
Write-Step "自检："
$now = @(Get-NetIPAddress -InterfaceAlias $Interface -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.PrefixOrigin -ne 'WellKnown' } | ForEach-Object { "$($_.IPAddress)/$($_.PrefixLength)" })
$nowGw = @(Get-NetRoute -InterfaceAlias $Interface -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
    ForEach-Object { $_.NextHop })

if ($now.Count -gt 0) {
    Write-Ok ("地址: " + ($now -join ', '))
    if ($Ip -and $nowGw.Count -eq 0) {
        Write-Warn2 "没有默认路由 —— 只能同网段互访；请补 -Gateway"
    } elseif ($nowGw.Count -gt 0) {
        Write-Ok ("默认路由: " + ($nowGw -join ', '))
    }
    Write-Host ""
    Write-Ok "网络已恢复。可在 Mac 上执行： nodeagent connect $($now[0].Split('/')[0]) --port 8765 --key <PSK> --insecure"
} else {
    Write-Err2 "仍然没有有效地址 —— 请检查网线/交换机，或尝试： rescue-network.ps1 -Interface '$Interface'（不带 -Ip，切回 DHCP）"
    exit 1
}
