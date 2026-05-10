<#
.SYNOPSIS
  Coordinated recording: starts ffmpeg in the background, waits a beat,
  then runs a CDP "trigger" eval on Hub so the demo action lands on tape.

.PARAMETER Hwnd
  Hub main-window HWND (decimal).
.PARAMETER Seconds
  Recording duration.
.PARAMETER Output
  Output GIF path.
.PARAMETER TriggerJs
  JavaScript to execute on the Hub page after recording starts. Use this
  to click "send", press a key, etc. — whatever the demo wants captured.
.PARAMETER DelayMs
  Time after ffmpeg start before firing the trigger (default 1500ms).
.PARAMETER Fps / Width
  Same as record-gif.ps1.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [long]$Hwnd,
  [Parameter(Mandatory)] [int]$Seconds,
  [Parameter(Mandatory)] [string]$Output,
  [Parameter(Mandatory)] [string]$TriggerJs,
  [int]$DelayMs = 1500,
  [int]$Fps = 12,
  [int]$Width = 900
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Resolve tools
$ff = (Get-ChildItem -Path "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.FFmpeg_*\ffmpeg-*\bin\ffmpeg.exe" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
if (-not $ff) { throw 'ffmpeg not found' }

# Win32 helpers (import from sibling script's Add-Type)
if (-not ('W2Rec' -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W2Rec {
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_SHOWWINDOW = 0x0040;
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
}

$target = [IntPtr]$Hwnd
if ([W2Rec]::IsIconic($target)) { [W2Rec]::ShowWindow($target, 9) | Out-Null }
[W2Rec]::SetForegroundWindow($target) | Out-Null
$swp = [W2Rec]::SWP_NOMOVE -bor [W2Rec]::SWP_NOSIZE -bor [W2Rec]::SWP_SHOWWINDOW
[W2Rec]::SetWindowPos($target, [W2Rec]::HWND_TOPMOST, 0, 0, 0, 0, $swp) | Out-Null
Start-Sleep -Milliseconds 700

$rect = New-Object 'W2Rec+RECT'
[W2Rec]::GetWindowRect($target, [ref]$rect) | Out-Null
$wW = $rect.Right - $rect.Left
$wH = $rect.Bottom - $rect.Top
$offX = [Math]::Max(0, $rect.Left)
$offY = [Math]::Max(0, $rect.Top)
$capW = $wW - ($offX - $rect.Left); if ($capW % 2) { $capW-- }
$capH = $wH - ($offY - $rect.Top); if ($capH % 2) { $capH-- }

$outDir = Split-Path -Parent $Output
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
$mp4 = [IO.Path]::ChangeExtension($Output, '.mp4')

Write-Host "[rec] starting ffmpeg: ${capW}x${capH}+${offX}+${offY}, ${Seconds}s @ ${Fps}fps"
$ffArgs = @(
  '-y', '-loglevel', 'warning', '-rtbufsize', '256M',
  '-f', 'gdigrab', '-framerate', "$Fps",
  '-offset_x', "$offX", '-offset_y', "$offY",
  '-video_size', "${capW}x${capH}",
  '-i', 'desktop',
  '-t', "$Seconds",
  '-vf', "scale=$($Width):-2:flags=lanczos",
  '-pix_fmt', 'yuv420p',
  $mp4
)
$stderrLog = "$outDir\ffmpeg-stderr.log"
if (Test-Path $stderrLog) { Remove-Item $stderrLog -Force }
$ffProc = Start-Process -FilePath $ff -ArgumentList $ffArgs -PassThru -WindowStyle Hidden -RedirectStandardError $stderrLog

# wait the chosen delay, then fire CDP trigger
Start-Sleep -Milliseconds $DelayMs
Write-Host "[rec] firing CDP trigger after ${DelayMs}ms"
$tmpJs = [IO.Path]::GetTempFileName() + '.js'
[IO.File]::WriteAllText($tmpJs, $TriggerJs, [Text.UTF8Encoding]::new($false))
try {
  Push-Location $scriptDir\..
  $cdpOut = & node "$scriptDir\hub-cdp.mjs" eval '--file' $tmpJs 2>&1
  Pop-Location
  $line = ($cdpOut -join ' ')
  $line = $line.Substring(0, [Math]::Min(200, $line.Length))
  Write-Host "[rec] CDP result: $line"
} finally {
  Remove-Item $tmpJs -ErrorAction SilentlyContinue
}

Write-Host "[rec] waiting for ffmpeg to finish..."
$ffProc.WaitForExit()
[W2Rec]::SetWindowPos($target, [W2Rec]::HWND_NOTOPMOST, 0, 0, 0, 0, $swp) | Out-Null

if (-not (Test-Path $mp4)) {
  Write-Host "[rec] ffmpeg stderr tail:"
  Get-Content $stderrLog -Tail 15 -ErrorAction SilentlyContinue
  throw "mp4 not produced"
}
$mp4Size = (Get-Item $mp4).Length
if ($mp4Size -lt 5000) {
  Write-Host "[rec] ffmpeg stderr tail:"
  Get-Content $stderrLog -Tail 15 -ErrorAction SilentlyContinue
  throw "mp4 too small ($mp4Size bytes)"
}
Write-Host "[rec] mp4 OK: $mp4Size bytes"

Write-Host "[rec] converting -> GIF"
# ffmpeg writes "Duped color" warnings to stderr which PS 5.1 turns into NativeCommandError.
# Force quiet output + run via cmd to suppress the auto-throw.
$ffOut = & cmd /c """$ff"" -y -loglevel error -i ""$mp4"" -vf ""fps=$Fps,scale=$($Width):-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5"" ""$Output"" 2>&1"
if (-not (Test-Path $Output) -or (Get-Item $Output).Length -lt 1000) {
  Write-Host $ffOut
  throw 'ffmpeg gif encode failed'
}

$kb = [math]::Round((Get-Item $Output).Length/1KB, 1)
Write-Host "[rec] DONE -> $Output ($kb KB)"
