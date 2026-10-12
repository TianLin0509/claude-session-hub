# Evidence collection for "v0.5.9 freezes about 80 s after start, then the UI process crashes; v0.5.8 is fine".
# Runs tests\diagnose-startup-hang.js twice on a COPY of %USERPROFILE%\.ai-hub-community:
#   1) v0.5.9 portable (extracted from the release ZIP), 2) the installed v0.5.8 as a control.
# The Hub you are using stays open and untouched; the real ~/.cac is not modified (a copy of its top-level files is used).
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File .\run-startup-hang.ps1 [-Zip <AIHubCommunity-0.5.9-win-x64.zip>] [-ControlExe <path>] [-Seconds 150] [-SkipControl] [-RealData]
# -RealData: run v0.5.9 portable ONCE on the REAL data directory, launched like a normal start (plus a debug port).
#   The isolated copy did not reproduce (2026-10-12); isolated instances skip some production startup work.
#   Close the Hub in use first; the data directory is fully backed up to %TEMP%\hub-data-backup-* before launch.
# Keep this file ASCII: Windows PowerShell 5.1 reads BOM-less files as ANSI.
param(
  [string]$Zip = '',
  [string]$ControlExe = '',
  [int]$Seconds = 150,
  [switch]$SkipControl,
  [switch]$RealData
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Zip) {
  $cands = @((Join-Path $here 'AIHubCommunity-0.5.9-win-x64.zip'), (Join-Path $env:USERPROFILE 'Downloads\AIHubCommunity-0.5.9-win-x64.zip'))
  foreach ($p in $cands) { if (Test-Path $p) { $Zip = $p; break } }
}
$portable = Join-Path $env:TEMP 'hub-v059-portable'
$exe059 = Join-Path $portable 'AI Hub Community.exe'
if (-not (Test-Path $exe059)) {
  if (-not $Zip -or -not (Test-Path $Zip)) { Write-Host 'Cannot find AIHubCommunity-0.5.9-win-x64.zip. Download it from the v0.5.9 release and pass -Zip.'; exit 2 }
  Write-Host "Extracting $Zip -> $portable"
  Expand-Archive -Path $Zip -DestinationPath $portable -Force
}
if (-not $ControlExe) {
  $cands = @('C:\Program Files\AI Hub Community\AI Hub Community.exe')
  $progs = Join-Path $env:LOCALAPPDATA 'Programs'
  $found = Get-ChildItem -Path $progs -Filter 'AI Hub Community.exe' -Recurse -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($found) { $cands += $found.FullName }
  foreach ($p in $cands) { if (Test-Path $p) { $ControlExe = $p; break } }
}
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { $nodePath = $node.Source } elseif (Test-Path 'C:\Program Files\CodeAgentCLI\node\node.exe') { $nodePath = 'C:\Program Files\CodeAgentCLI\node\node.exe' } else { Write-Host 'Node.js 22+ is required.'; exit 2 }
$script = Join-Path $here 'tests\diagnose-startup-hang.js'

if ($RealData) {
  $running = @(Get-CimInstance Win32_Process -Filter "Name='AI Hub Community.exe'" -ErrorAction SilentlyContinue)
  if ($running.Count -gt 0) { Write-Host "AI Hub Community is still running ($($running.Count) processes). Close its window first (the taskbar icon must disappear), then run again."; exit 3 }
  Write-Host "=== v0.5.9 portable on the REAL data directory: $exe059"
  & $nodePath $script --exe $exe059 --real-data --seconds $Seconds --label 'v0.5.9 real data' --report (Join-Path $here 'startup-hang-v059-real.md')
  Write-Host "Report: $(Join-Path $here 'startup-hang-v059-real.md')"
  Write-Host 'Done. You can reopen the installed v0.5.8 now.'
  exit 0
}

Write-Host "=== 1/2 v0.5.9 portable: $exe059"
& $nodePath $script --exe $exe059 --seconds $Seconds --label 'v0.5.9' --report (Join-Path $here 'startup-hang-v059.md')
if (-not $SkipControl -and $ControlExe -and (Test-Path $ControlExe)) {
  Write-Host "=== 2/2 control (installed): $ControlExe"
  & $nodePath $script --exe $ControlExe --seconds $Seconds --label 'installed (control)' --report (Join-Path $here 'startup-hang-control.md')
}
Write-Host "Reports: $(Join-Path $here 'startup-hang-v059.md')  $(Join-Path $here 'startup-hang-control.md')"
