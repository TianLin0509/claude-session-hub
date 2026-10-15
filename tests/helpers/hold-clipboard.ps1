param([Parameter(Mandatory=$true)][string]$ReadyFile, [Parameter(Mandatory=$true)][string]$ReleaseFile)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class HubClipboardLock {
 [DllImport("user32.dll")] public static extern bool OpenClipboard(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool CloseClipboard();
}
'@
if (-not [HubClipboardLock]::OpenClipboard([IntPtr]::Zero)) { throw 'Clipboard already busy' }
try {
  [IO.File]::WriteAllText($ReadyFile, 'ready')
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (-not (Test-Path -LiteralPath $ReleaseFile) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 10 }
} finally { [void][HubClipboardLock]::CloseClipboard() }
