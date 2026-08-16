# -IconOnly: 只重新生成 claude-wx.ico，不动桌面快捷方式。
# Hub 现在会把快捷方式指向品牌化后的 AIGroupChatHub.exe（见 core/hub-exe-branding.js），
# 这里再无条件改回 electron.exe 会把它打回原形。
param([switch]$IconOnly)

Add-Type -AssemblyName System.Drawing

# Render the logo natively at every target size using vector graphics —
# each resolution is drawn directly from the 256-unit coordinate space, not
# scaled up from a low-res pixel grid. Anti-aliasing + HighQuality hints.
#
# Design (coordinates in a 256x256 canvas):
#   Body:        rounded rect, x=18 y=32 w=220 h=168, rx=18
#   Legs (x3):   38,200 / 110,200 / 182,200 — each 36x32
#   Left eye >:  path M 66,86 L 94,116 L 66,146 (stroke 14, square caps)
#   Right eye <: path M 190,86 L 162,116 L 190,146 (stroke 14, square caps)

function New-LogoBitmap {
    param([int]$Size)
    $bmp = New-Object System.Drawing.Bitmap $Size, $Size
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    # Scale factor: 256-unit design → target pixel size
    $s = $Size / 256.0

    # --- Body: rounded rect ---
    $orange   = [System.Drawing.Color]::FromArgb(217, 119, 87)
    $orangeBr = New-Object System.Drawing.SolidBrush $orange

    function New-RoundedRect {
        param([single]$X, [single]$Y, [single]$W, [single]$H, [single]$R)
        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $d = $R * 2
        $path.AddArc($X,            $Y,            $d, $d, 180, 90)
        $path.AddArc($X + $W - $d,  $Y,            $d, $d, 270, 90)
        $path.AddArc($X + $W - $d,  $Y + $H - $d,  $d, $d, 0,   90)
        $path.AddArc($X,            $Y + $H - $d,  $d, $d, 90,  90)
        $path.CloseFigure()
        return $path
    }

    $body = New-RoundedRect ([single](18 * $s)) ([single](32 * $s)) ([single](220 * $s)) ([single](168 * $s)) ([single](18 * $s))
    $g.FillPath($orangeBr, $body)
    $body.Dispose()

    # --- 3 legs ---
    $legY    = [single](200 * $s)
    $legH    = [single](32  * $s)
    $legW    = [single](36  * $s)
    $cornerR = [single]([Math]::Max(1.0, 4 * $s))
    $leg1X   = [single](38  * $s)
    $leg2X   = [single](110 * $s)
    $leg3X   = [single](182 * $s)
    foreach ($legX in @($leg1X, $leg2X, $leg3X)) {
        $leg = New-RoundedRect $legX $legY $legW $legH $cornerR
        $g.FillPath($orangeBr, $leg)
        $leg.Dispose()
    }

    # --- Eyes: > and < as thick stroked paths ---
    $eye     = [System.Drawing.Color]::FromArgb(26, 26, 26)
    $penW    = [single](14 * $s)
    $eyePen  = New-Object System.Drawing.Pen($eye, $penW)
    $eyePen.StartCap   = [System.Drawing.Drawing2D.LineCap]::Flat
    $eyePen.EndCap     = [System.Drawing.Drawing2D.LineCap]::Flat
    $eyePen.LineJoin   = [System.Drawing.Drawing2D.LineJoin]::Miter
    $eyePen.MiterLimit = 4.0

    # Left eye: > (opening faces left, so chevron points right)
    $leftEye = New-Object System.Drawing.Drawing2D.GraphicsPath
    $leftEye.AddLines(@(
        (New-Object System.Drawing.PointF([single](66 * $s),  [single](86 * $s))),
        (New-Object System.Drawing.PointF([single](94 * $s),  [single](116 * $s))),
        (New-Object System.Drawing.PointF([single](66 * $s),  [single](146 * $s)))
    ))
    $g.DrawPath($eyePen, $leftEye)
    $leftEye.Dispose()

    # Right eye: < (opening faces right, so chevron points left)
    $rightEye = New-Object System.Drawing.Drawing2D.GraphicsPath
    $rightEye.AddLines(@(
        (New-Object System.Drawing.PointF([single](190 * $s), [single](86 * $s))),
        (New-Object System.Drawing.PointF([single](162 * $s), [single](116 * $s))),
        (New-Object System.Drawing.PointF([single](190 * $s), [single](146 * $s)))
    ))
    $g.DrawPath($eyePen, $rightEye)
    $rightEye.Dispose()

    $eyePen.Dispose()
    $orangeBr.Dispose()
    $g.Dispose()
    return $bmp
}

# Full multi-size ICO: 16/24/32/48/64/96/128/256.
#
# 256 是 ICO 格式的硬上限：目录项的 width/height 各只有 1 字节，0 按规范表示 256,
# 没有任何编码能表达 512。以前这里多写了一个 512 的 PNG，它和真正的 256 项一样被
# 写成 declared=0x0 —— 同一个 .ico 里出现两个都自称 256x256 的条目，其中一个还在
# 撒谎。Windows 的 LookupIconIdFromDirectoryEx 只能二选一，图标缓存重建时按哪一条
# 解码是不确定的。别再加回 512。
$sizes = @(16, 24, 32, 48, 64, 96, 128, 256)
$entries = @()
foreach ($sz in $sizes) {
    $bmp = New-LogoBitmap -Size $sz
    $ms  = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $entries += [PSCustomObject]@{ Size = $sz; Data = $ms.ToArray() }
    $bmp.Dispose()
    $ms.Dispose()
}

$icoPath = Join-Path $PSScriptRoot "claude-wx.ico"
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter $fs

$bw.Write([UInt16]0)                    # Reserved
$bw.Write([UInt16]1)                    # Type = ICO
$bw.Write([UInt16]$entries.Count)       # Count

$currentOffset = 6 + 16 * $entries.Count
foreach ($e in $entries) {
    # Width/height byte = 0 means 256+ (spec)
    $w = if ($e.Size -ge 256) { [byte]0 } else { [byte]$e.Size }
    $h = $w
    $bw.Write($w)
    $bw.Write($h)
    $bw.Write([byte]0)                  # ColorCount (0 = truecolor PNG)
    $bw.Write([byte]0)                  # Reserved
    $bw.Write([UInt16]1)                # Planes
    $bw.Write([UInt16]32)               # BitCount
    $bw.Write([UInt32]$e.Data.Length)   # BytesInRes
    $bw.Write([UInt32]$currentOffset)   # ImageOffset
    $currentOffset += $e.Data.Length
}
foreach ($e in $entries) { $bw.Write($e.Data) }

$bw.Flush()
$fs.Close()

Write-Host "Icon written: $icoPath ($($entries.Count) sizes: $($sizes -join '/'))"

if ($IconOnly) {
    Write-Host "IconOnly: skipped desktop shortcut refresh"
    return
}

# Refresh the desktop shortcut (target/arguments unchanged; icon resource in
# the .ico is keyed by path, so replacing the file is enough for new apps —
# but the existing .lnk already points here, so this is mostly for first run).
$lnkPath = "$env:USERPROFILE\Desktop\claudeWX.lnk"
$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($lnkPath)
$s.TargetPath        = Join-Path $PSScriptRoot "node_modules\electron\dist\electron.exe"
$s.Arguments         = "`"$PSScriptRoot`""
$s.WorkingDirectory  = $PSScriptRoot
$s.IconLocation      = "$icoPath,0"
$s.WindowStyle       = 7
$s.Description       = "Claude Session Hub"
$s.Save()

Write-Host "Shortcut refreshed: $lnkPath"
