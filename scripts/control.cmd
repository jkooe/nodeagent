@echo off
REM ============================================================================
REM  nodeagent - control menu (Windows)
REM
REM  Double-click this file to manage an already-installed agent:
REM    1) status    - task / process / port / config at a glance
REM    2) start     - start the scheduled task
REM    3) stop      - stop the scheduled task
REM    4) restart   - stop then start
REM    5) logs      - tail the agent's audit log
REM    6) uninstall - remove task + firewall rule (7) purge config and exit
REM
REM  Usage:  control.cmd  [port]
REM          port defaults to 8765; pass it only if the agent uses another.
REM
REM  Pure ASCII on purpose - see the note in install.cmd. The heavy lifting
REM  (and all Chinese output) lives in control.ps1, which carries a UTF-8 BOM
REM  so Windows PowerShell 5.1 parses it correctly.
REM ============================================================================
setlocal EnableExtensions

set "HERE=%~dp0"
set "HELPER=%HERE%control.ps1"
set "PORT=%~1"
if not defined PORT set "PORT=8765"

if not exist "%HELPER%" (
  echo [x] control.ps1 not found next to this file.
  echo     Folder: "%HERE%"
  if not defined CI pause
  exit /b 1
)

:MENU
cls
echo ==========================================================
echo   nodeagent control console
echo ==========================================================
echo   1) Status
echo   2) Start agent
echo   3) Stop agent
echo   4) Restart agent
echo   5) Show recent audit log
echo   6) Uninstall ^(keep config^)
echo   7) Uninstall and purge config
echo   Q) Quit
echo ==========================================================
echo.

set "CHOICE="
REM <nul makes `set /p` fail immediately -> CHOICE stays empty. Combined with
REM CI (see below) that exits instead of looping forever on piped/empty stdin.
set /p "CHOICE=Select: "

if not defined CHOICE (
  if defined CI goto :QUIT
  echo.
  echo (no input - exiting)
  goto :QUIT
)

if /i "%CHOICE%"=="Q" goto :QUIT
if "%CHOICE%"=="1" call :RUN status
if "%CHOICE%"=="2" call :RUN start
if "%CHOICE%"=="3" call :RUN stop
if "%CHOICE%"=="4" call :RUN restart
if "%CHOICE%"=="5" call :RUN logs
if "%CHOICE%"=="6" call :RUN uninstall
if "%CHOICE%"=="7" call :RUN uninstall-purge
goto :MENU

:QUIT
endlocal
exit /b 0

:RUN
REM %1 = subcommand forwarded to control.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%HELPER%" -Action %1 -Port %PORT%
echo.
if not defined CI pause
goto :MENU
REM unreachable; keeps `call :RUN` from falling through if the goto is removed
exit /b 0
