@echo off
rem ==========================================================
rem  AI Hub - one-double-click team installer
rem  Double-click this file. A box will ask for your team token
rem  (leave it empty to use your own Claude / Codex account),
rem  then everything installs automatically.
rem
rem  Self-bootstrapping: if install-hub.ps1 is not next to this
rem  file it is downloaded first, because the README tells people
rem  that downloading just the .bat is enough.
rem
rem  NOTE: goto/labels below, not if(...) blocks - cmd matches a
rem  block's closing paren even inside a quoted string. And the
rem  download line must not use \" escapes: cmd does not honour
rem  them, the quoting falls apart and the rest of the file is
rem  silently skipped. Both bugs were caught by
rem  tests/unit-setup-install-entrypoints.test.js.
rem ==========================================================
title AI Hub Installer
set "HERE=%~dp0"
set "BOOT=%HERE%install-hub.ps1"
if exist "%BOOT%" goto :launch

echo install-hub.ps1 is not next to this file - downloading it...
set "BOOT=%TEMP%\install-hub.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/TianLin0509/claude-session-hub/master/install-hub.ps1' -OutFile (Join-Path $env:TEMP 'install-hub.ps1')"
if errorlevel 1 goto :downloadfailed
if not exist "%BOOT%" goto :downloadfailed
goto :launch

:downloadfailed
echo.
echo FAIL: could not download install-hub.ps1.
echo Check your network, or download the whole repository zip and run setup.ps1 from inside it.
pause
exit /b 1

:launch
powershell -NoProfile -ExecutionPolicy Bypass -File "%BOOT%" %*
exit /b %ERRORLEVEL%
