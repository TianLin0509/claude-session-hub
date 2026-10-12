@echo off
rem Double-click after closing the Hub in use: runs v0.5.9 once on the real data directory (about 5 minutes).
rem The data directory is backed up to %TEMP%\hub-data-backup-* first. Do not touch the Hub window while it runs.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-startup-hang.ps1" -RealData
echo.
echo Report: %~dp0startup-hang-v059-real.md
pause
