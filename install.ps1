#Requires -Version 5.1
<#
.SYNOPSIS
    DEPRECATED shim. Use setup.ps1 (or double-click install-hub.bat) instead.
.DESCRIPTION
    This was the 2026-04 installer. It hand-wrote Claude hook entries into
    ~/.claude/settings.json and a statusLine command - work the Hub now does
    itself at startup (core/claude-hook-integration.js), so running it again
    only risks fighting with the Hub over the same file.

    It stays as a forwarding shim because team members' agents can still find
    this filename in an old clone or an old chat log. Rather than half-install
    the Hub the old way, forward to the real installer.

    Parameters are declared explicitly and forwarded with $PSBoundParameters
    (a HASHTABLE splat, passing by name). An array splat - @args style - would
    pass them positionally, so `-Token <64-hex>` arrives as Token="-Token" and
    the real token lands in the next positional parameter. That is not
    theoretical: it shipped, and a valid token was reported as "length 6".

    Real entry points:
      setup.ps1          one command, unattended, what everyone should use
      install-hub.bat    double-click wrapper with a token input box
#>
param(
  [string]$Token,
  [switch]$UseOwnAccount,
  [string]$MeridianUrl,
  [string]$ClaudeModel,
  [string]$CodexModel,
  [string]$HubDir,
  [string]$DataDir,
  [string]$LocalSource,
  [switch]$NoLaunch,
  [switch]$SkipHealthCheck
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }
$setup = Join-Path $here 'setup.ps1'

Write-Host ''
Write-Host 'install.ps1 is deprecated - forwarding to setup.ps1' -ForegroundColor Yellow
Write-Host '  (the old hook/settings steps are now done by the Hub itself)' -ForegroundColor Gray
Write-Host ''

if (-not (Test-Path $setup)) {
  Write-Host "    FAIL: setup.ps1 not found next to install.ps1 ($here)." -ForegroundColor Red
  Write-Host '    Get the full repo, then run: powershell -ExecutionPolicy Bypass -File setup.ps1' -ForegroundColor Gray
  exit 1
}

# Only forward what the caller actually passed, by name.
& $setup @PSBoundParameters
exit $LASTEXITCODE
