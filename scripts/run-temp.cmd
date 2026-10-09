@echo off
REM ============================================================================
REM  nodeagent - TEMPORARY launcher (no install, no admin, no scheduled task)
REM
REM  Purpose: bring the agent up for a quick test WITHOUT running install.cmd.
REM  The agent is zero-config: on first run it creates %USERPROFILE%\.nodeagent\
REM  (agent.json with a random PSK + self-signed cert) and starts listening.
REM
REM  Usage:
REM     run-temp.cmd            start in foreground (Ctrl+C to stop)
REM     run-temp.cmd start      same as above
REM     run-temp.cmd background start hidden, then print status
REM     run-temp.cmd stop       stop the background instance
REM     run-temp.cmd status     show whether it is running
REM
REM  IMPORTANT: the agent takes NO command-line arguments (it does not parse
REM  argv at all). The listen port comes from %USERPROFILE%\.nodeagent\
REM  agent.json -- the "<port>" below is used ONLY by this script's own status
REM  check. To change the port, edit agent.json, not the command line.
REM
REM  Notes:
REM    * Pure ASCII on purpose (see install.cmd) so it survives the CMD code page.
REM    * No admin needed. Nothing is written outside this folder and %USERPROFILE%.
REM    * "background" still dies with the parent CMD window; use it for a test
REM      session, not as a permanent daemon. For that, run install.cmd once.
REM ============================================================================
setlocal EnableExtensions

set "HERE=%~dp0"
set "NODE=%HERE%node.exe"
set "AGENT=%HERE%agent.mjs"
set "PORT=%~2"
if not defined PORT set "PORT=8765"

if not exist "%NODE%" (
  echo [x] node.exe not found in "%HERE%"
  exit /b 1
)
if not exist "%AGENT%" (
  echo [x] agent.mjs not found in "%HERE%"
  exit /b 1
)

if /i "%~1"=="stop" goto :STOP
if /i "%~1"=="status" goto :STATUS
if /i "%~1"=="background" goto :BACKGROUND
goto :FOREGROUND

REM ---------------------------------------------------------------------------
:FOREGROUND
echo ==========================================================
echo   nodeagent (temporary, foreground)
echo ==========================================================
echo   folder : "%HERE%"
echo   port   : %PORT%   (for this status check only; agent reads agent.json)
echo   stop   : Ctrl+C
echo.
"%NODE%" "%AGENT%"
echo.
echo [i] agent exited (code %errorlevel%)
pause
exit /b 0

REM ---------------------------------------------------------------------------
:BACKGROUND
echo [*] starting agent in background...
start "nodeagent-temp" /min cmd /c ""%NODE%" "%AGENT%""
rem give it a moment to bind the port and generate cert/config
timeout /t 3 /nobreak >nul
goto :STATUS

REM ---------------------------------------------------------------------------
:STATUS
echo [*] checking status...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='SilentlyContinue';" ^
  "$p = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*agent.mjs*' };" ^
  "if ($p) { Write-Host ('  running : PID ' + (($p | ForEach-Object { $_.ProcessId }) -join ', ')) } else { Write-Host '  running : no' };" ^
  "$l = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue;" ^
  "if ($l) { Write-Host ('  listening: port %PORT%') } else { Write-Host '  listening: no' };" ^
  "$cfg = Join-Path $env:USERPROFILE '.nodeagent\agent.json';" ^
  "if (Test-Path $cfg) { Write-Host ('  config  : ' + $cfg); try { (Get-Content $cfg -Raw | ConvertFrom-Json) | ForEach-Object { Write-Host ('  node_id : ' + $_.node_id); Write-Host ('  key     : ' + $_.key) } } catch {} } else { Write-Host '  config  : (not yet created)' };"
echo.
echo If the connect line above is empty, run:  run-temp.cmd status
pause
exit /b 0

REM ---------------------------------------------------------------------------
:STOP
echo [*] stopping temporary agent...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='SilentlyContinue';" ^
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*agent.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('  killed PID ' + $_.ProcessId) };"
echo [i] done
exit /b 0