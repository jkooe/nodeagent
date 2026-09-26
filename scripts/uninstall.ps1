<#
.SYNOPSIS
    nodeagent - uninstall the Windows agent.

.DESCRIPTION
    Stops and removes the scheduled task and the firewall rule.
    Keeps the config (~/.nodeagent/agent.json) unless -Purge is given.
#>
[CmdletBinding()]
param(
    [int]$Port = 8765,
    [switch]$Purge
)

$ErrorActionPreference = "SilentlyContinue"

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host "[x] Please run as Administrator."; exit 1 }

Write-Host "[*] Stopping and removing scheduled task..."
Stop-ScheduledTask -TaskName "nodeagent"
Unregister-ScheduledTask -TaskName "nodeagent" -Confirm:$false

Write-Host "[*] Removing firewall rule..."
Get-NetFirewallRule -DisplayName "nodeagent (TCP $Port)" | Remove-NetFirewallRule

if ($Purge) {
    Write-Host "[*] Purging config..."
    Remove-Item -Recurse -Force (Join-Path $env:USERPROFILE ".nodeagent")
}

Write-Host "[+] Uninstalled."
