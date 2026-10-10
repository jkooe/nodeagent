@echo off
REM ============================================================================
REM  nodeagent - one-click installer launcher (Windows)
REM
REM  Double-click this file. It will:
REM    1) self-elevate to Administrator (UAC prompt) if not already elevated
REM    2) make sure a pre-shared key exists in PSK.txt (generate one if absent)
REM    3) run install.ps1, which registers the scheduled task, opens the
REM       firewall and starts the agent
REM
REM  Usage:  install.cmd  [port]
REM          port defaults to 8765. Pass a port only when the default is taken.
REM
REM  IMPORTANT - why this file is pure ASCII:
REM    The CMD.exe code page (936/GBK on Chinese Windows) can NOT round-trip
REM    UTF-8 Chinese reliably. Any non-ASCII byte here risks mojibake or a
REM    broken command. All Chinese-facing text is delegated to install.ps1,
REM    which is saved as UTF-8 **with BOM** so Windows PowerShell 5.1 reads
REM    it correctly. Keep this launcher ASCII-only.
REM
REM  NOTE - install.ps1 MUST keep its UTF-8 BOM. PowerShell 5.1 parses
REM    BOM-less .ps1 as ANSI/GBK, and the Chinese comments then break the
REM    string boundaries -> a cascade of bogus syntax errors.
REM ============================================================================
setlocal EnableExtensions

set "HERE=%~dp0"
set "PS1=%HERE%install.ps1"
set "PSKFILE=%HERE%PSK.txt"
set "PORT=%~1"
if not defined PORT set "PORT=8765"

if not exist "%PS1%" (
  echo [x] install.ps1 not found next to this file.
  echo     Folder: "%HERE%"
  echo     Keep install.ps1, node.exe, agent.mjs and this launcher together.
  if not defined CI pause
  exit /b 1
)

REM --- 1) elevate to Administrator -------------------------------------------
REM fltmc is used instead of `net session` because the latter depends on the
REM Server service, which is disabled on some builds - that would make an
REM already-elevated shell look unelevated and trigger a pointless UAC loop.
fltmc >nul 2>&1
if errorlevel 1 (
  echo [*] Requesting Administrator rights...
  echo     A new window will open. Continue there; this one closes by itself.
  REM Start-Process re-launches this .cmd elevated. %PORT% (already resolved to
  REM its default) is forwarded so "install.cmd 18770" survives the elevation.
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "Start-Process -FilePath '%~f0' -ArgumentList '%PORT%' -Verb RunAs" >nul 2>&1
  if errorlevel 1 (
    echo [x] Elevation was declined - cannot register a scheduled task.
    if not defined CI pause
    exit /b 1
  )
  exit /b 0
)

REM --- 2) make sure the pre-shared key exists ---------------------------------
set "PSK="
if exist "%PSKFILE%" (
  REM Read + Trim in one shot: a stray CR from CRLF or an editor-added trailing
  REM space would otherwise end up inside -Key and break authentication.
  for /f "delims=" %%K in ('powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "if (Test-Path -LiteralPath '%PSKFILE%') { (Get-Content -LiteralPath '%PSKFILE%' -Raw).Trim() }"') do set "PSK=%%K"
)

if defined PSK (
  echo [+] Using key from PSK.txt
) else (
  REM No PSK.txt -> let install.ps1 handle it: it reuses the key from an existing
  REM agent.json when present, otherwise generates one (in PowerShell, where quoting
  REM is safe). Do NOT generate here in cmd: routing a PS one-liner with pipes through
  REM `for /f` requires ^| escaping that leaks into PowerShell and breaks the parse
  REM (real machine 2026-10-07: "Unexpected token '^'" - that is exactly the
  REM first-run path, since PSK.txt is no longer shipped in the zip).
  echo [*] No usable PSK.txt found - install.ps1 will reuse or generate the key
)

REM --- 3) install -------------------------------------------------------------
echo.
echo [*] Installing nodeagent ^(node: %COMPUTERNAME%, port %PORT%, input control ON^)...
echo.

REM v2.0.0: the key now travels via PIPE (stdin), not the -Key command-line arg.
REM Why: command lines are readable by other users on this machine
REM (Win32_Process.CommandLine / Task Manager show them in clear text).
REM NOTE: there must be NO space before the pipe - `echo key |` would fold the
REM space into the echoed value and corrupt the key.
if defined PSK (
  echo %PSK%| powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -NodeId "%COMPUTERNAME%" -AllowInput -Port %PORT% -KeyFromStdin
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -NodeId "%COMPUTERNAME%" -AllowInput -Port %PORT%
)
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo [+] Done. The agent now starts automatically at every logon.
  echo     To manage it later, double-click control.cmd in this folder.
) else (
  echo [x] install.ps1 exited with code %RC%.
  echo     If the error mentions a missing file, re-extract the whole package.
  echo     If Windows Firewall or a security suite blocked something, allow it and retry.
)
echo.
REM Keep the window open so the user can read the output. CI sets CI=true,
REM where `pause` would hang forever waiting for a keypress.
if not defined CI pause
exit /b %RC%
