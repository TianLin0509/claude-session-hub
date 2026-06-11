@echo off
rem ==========================================================
rem  AI Hub - one-double-click team installer
rem  Double-click this file. A box will ask for your team token,
rem  then everything installs automatically.
rem ==========================================================
title AI Hub Installer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-hub.ps1"
