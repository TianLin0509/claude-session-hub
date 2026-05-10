<#
.SYNOPSIS
  Record a GIF of a target window via ffmpeg gdigrab + gifski.

.PARAMETER WindowTitle
  Substring used to locate the Electron Hub window. Default matches roundtable / Claude Session Hub titles.

.PARAMETER Hwnd
  Explicit window handle (decimal). Wins over WindowTitle when set.

.PARAMETER Seconds
  Recording duration. Default 15s.

.PARAMETER Output
  Output GIF path. Default C:\temp\hub-rec\rec-<ts>.gif.

.PARAMETER Fps
  Capture + GIF fps. Default 15.

.PARAMETER Width
  GIF width (height auto). Default 960.

.PARAMETER KeepMp4
  Keep the intermediate mp4 (handy for debugging).

.EXAMPLE
  .\record-gif.ps1 -Seconds 12 -Output C:\temp\sidebar-jump.gif
#>
[CmdletBinding()]
param(
  [string]$WindowTitle = '',
  [long]$Hwnd = 0,
  [int]$Seconds = 15,
  [string]$Output = '',
  [int]$Fps = 15,
  [int]$Width = 960,
  [switch]$KeepMp4
)

$ErrorActionPreference = 'Stop'

if (-not ('Win32Window' -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32Window {
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_SHOWWINDOW = 0x0040;
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll", CharSet=CharSet.Auto)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
}

function Find-HubWindow {
  param([string]$Match)
  $procs = Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
  if ($Match) {
    $procs = $procs | Where-Object { $_.MainWindowTitle -like "*$Match*" }
  } else {
    $procs = $procs | Where-Object {
      $_.MainWindowTitle -like '*圆桌*' -or
      $_.MainWindowTitle -like '*Claude Session Hub*' -or
      $_.MainWindowTitle -like '*Roundtable*'
    }
  }
  if (-not $procs) {
    throw "No matching Hub window found. Searched for: $(if($Match){$Match}else{'圆桌 / Claude Session Hub'})"
  }
  return @($procs)[0]
}

function Resolve-Tool {
  param([string]$Name, [string[]]$Fallbacks)
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in $Fallbacks) {
    $hit = Get-ChildItem -Path $p -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  throw "$Name not found on PATH or in: $($Fallbacks -join ' ; ')"
}

$ffmpeg = Resolve-Tool 'ffmpeg' @(
  "$env:LOCALAPPDATA\Microsoft\WinGet\Links\ffmpeg.exe",
  "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.FFmpeg_*\ffmpeg-*\bin\ffmpeg.exe"
)
# gifski intentionally not used: hangs on Windows console invocation in this env.
# Stick with ffmpeg palette method — quality is good enough for README GIFs.
$gifski = $null

if (-not $Output) {
  $Output = "C:\temp\hub-rec\rec-$(Get-Date -Format 'yyyyMMdd-HHmmss').gif"
}
$outDir = Split-Path -Parent $Output
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
$mp4 = [IO.Path]::ChangeExtension($Output, '.mp4')

if ($Hwnd -ne 0) {
  $targetHwnd = [IntPtr]$Hwnd
  $targetTitle = '<explicit hwnd>'
  $targetPid = '?'
} else {
  $proc = Find-HubWindow -Match $WindowTitle
  $targetHwnd = $proc.MainWindowHandle
  $targetTitle = $proc.MainWindowTitle
  $targetPid = $proc.Id
}
Write-Host "[record] target: PID=$targetPid title='$targetTitle' hwnd=$($targetHwnd.ToInt64())"

if ([Win32Window]::IsIconic($targetHwnd)) { [Win32Window]::ShowWindow($targetHwnd, 9) | Out-Null }
[Win32Window]::SetForegroundWindow($targetHwnd) | Out-Null
$swpFlags = [Win32Window]::SWP_NOMOVE -bor [Win32Window]::SWP_NOSIZE -bor [Win32Window]::SWP_SHOWWINDOW
[Win32Window]::SetWindowPos($targetHwnd, [Win32Window]::HWND_TOPMOST, 0, 0, 0, 0, $swpFlags) | Out-Null
Start-Sleep -Milliseconds 800

$fg = [Win32Window]::GetForegroundWindow()
if ($fg -ne $targetHwnd) {
  Write-Warning "Target did not come to foreground. fg=$($fg.ToInt64()) target=$($targetHwnd.ToInt64()). TOPMOST should still keep it visible."
}

# Electron GPU rendering defeats gdigrab hwnd= (BitBlt sees black for GPU-composited surfaces).
# Use gdigrab desktop with offset/size cropped to Hub window — DWM compositor delivers full GPU content.
$rect = New-Object 'Win32Window+RECT'
[Win32Window]::GetWindowRect($targetHwnd, [ref]$rect) | Out-Null
$wW = $rect.Right - $rect.Left
$wH = $rect.Bottom - $rect.Top
# gdigrab desktop video_size must be even
$capW = if ($wW % 2 -eq 0) { $wW } else { $wW - 1 }
$capH = if ($wH % 2 -eq 0) { $wH } else { $wH - 1 }
# Clamp negative offsets (maximized windows extend ~7px outside the screen)
$offX = [Math]::Max(0, $rect.Left)
$offY = [Math]::Max(0, $rect.Top)
# If we clamped, also shrink size
if ($offX -ne $rect.Left) { $capW -= ($offX - $rect.Left) }
if ($offY -ne $rect.Top) { $capH -= ($offY - $rect.Top) }
$capW = if ($capW % 2 -eq 0) { $capW } else { $capW - 1 }
$capH = if ($capH % 2 -eq 0) { $capH } else { $capH - 1 }

Write-Host "[record] capture $Seconds s @ $Fps fps, region ${capW}x${capH}+${offX}+${offY} -> $mp4"
$ffArgs = @(
  '-y',
  '-loglevel', 'warning',
  '-rtbufsize', '256M',
  '-f', 'gdigrab',
  '-framerate', "$Fps",
  '-offset_x', "$offX",
  '-offset_y', "$offY",
  '-video_size', "${capW}x${capH}",
  '-i', 'desktop',
  '-t', "$Seconds",
  '-vf', "scale=$($Width):-2:flags=lanczos",
  '-pix_fmt', 'yuv420p',
  $mp4
)
try {
  & $ffmpeg @ffArgs
  $ffExit = $LASTEXITCODE
} finally {
  [Win32Window]::SetWindowPos($targetHwnd, [Win32Window]::HWND_NOTOPMOST, 0, 0, 0, 0, $swpFlags) | Out-Null
}
if ($ffExit -ne 0) { throw "ffmpeg failed: exit=$ffExit" }
if (-not (Test-Path $mp4)) { throw "mp4 missing: $mp4" }
$mp4Size = (Get-Item $mp4).Length
if ($mp4Size -lt 2000) { throw "mp4 too small ($mp4Size bytes), likely captured nothing: $mp4" }
if ($mp4Size -lt 20000) { Write-Warning "mp4 is only $mp4Size bytes — mostly static frames? (OK for still demos)" }

if ($gifski) {
  # gifski needs PNG sequence; extract first then encode (better quality, smaller GIFs)
  $frameDir = Join-Path $outDir ("frames-" + [IO.Path]::GetFileNameWithoutExtension($Output))
  if (Test-Path $frameDir) { Remove-Item $frameDir -Recurse -Force }
  New-Item -ItemType Directory -Path $frameDir | Out-Null
  Write-Host "[record] extract PNG frames -> $frameDir"
  & $ffmpeg -y -loglevel warning -i $mp4 -vf "fps=$Fps" "$frameDir\f-%04d.png"
  if ($LASTEXITCODE -ne 0) { throw "ffmpeg frame extract failed" }
  Write-Host "[record] gifski encode -> $Output"
  $pngs = Get-ChildItem -Path $frameDir -Filter 'f-*.png' | Sort-Object Name | Select-Object -ExpandProperty FullName
  & $gifski --fps $Fps --width $Width -o $Output @pngs
  if ($LASTEXITCODE -ne 0) { throw "gifski failed: exit=$LASTEXITCODE" }
  Remove-Item $frameDir -Recurse -Force
} else {
  Write-Host "[record] convert -> $Output (ffmpeg palette method)"
  & $ffmpeg -y -loglevel warning -i $mp4 -vf "fps=$Fps,scale=$($Width):-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" $Output
  if ($LASTEXITCODE -ne 0) { throw "ffmpeg gif encode failed: exit=$LASTEXITCODE" }
}

if (-not $KeepMp4) { Remove-Item $mp4 -Force -ErrorAction SilentlyContinue }

$sizeKB = [math]::Round((Get-Item $Output).Length / 1KB, 1)
Write-Host "[record] DONE -> $Output ($sizeKB KB)"
