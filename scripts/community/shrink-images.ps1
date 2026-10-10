# Shrink oversized PNG artwork in an exported tree (2026-10-10: 38 images at 1254x1254 made up 34 MB
# of app.asar while the UI shows them at 24-168 px). Used by export-community.js on the export output only;
# the main repository keeps its originals.
#   powershell -NoProfile -File shrink-images.ps1 -Root <export dir> -Rules "renderer/assets/ai-avatars=384;renderer/assets/navigation=256"
# Keep this file ASCII: Windows PowerShell 5.1 reads BOM-less files as ANSI.
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$Rules
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$before = 0; $after = 0; $count = 0
foreach ($rule in $Rules.Split(';')) {
  if (-not $rule.Trim()) { continue }
  $parts = $rule.Split('=')
  $dir = Join-Path $Root ($parts[0].Trim() -replace '/', '\')
  $max = [int]$parts[1]
  if (-not (Test-Path $dir)) { continue }
  foreach ($file in Get-ChildItem $dir -Recurse -File -Filter *.png) {
    $image = [System.Drawing.Image]::FromFile($file.FullName)
    try {
      if ($image.Width -le $max -and $image.Height -le $max) { continue }
      $scale = [Math]::Min($max / $image.Width, $max / $image.Height)
      $w = [int][Math]::Round($image.Width * $scale); $h = [int][Math]::Round($image.Height * $scale)
      $bitmap = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
      $g = [System.Drawing.Graphics]::FromImage($bitmap)
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $g.DrawImage($image, 0, 0, $w, $h)
      $g.Dispose()
    } finally { $image.Dispose() }
    $before += $file.Length
    $temp = "$($file.FullName).tmp"
    $bitmap.Save($temp, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
    Move-Item -LiteralPath $temp -Destination $file.FullName -Force
    $after += (Get-Item $file.FullName).Length
    $count += 1
  }
}
Write-Output ("{0}|{1}|{2}" -f $count, $before, $after)
