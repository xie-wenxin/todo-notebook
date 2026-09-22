# ============================================================
#  make-icons.ps1 -- generate PWA / iPhone home-screen icons
#  Uses Windows built-in System.Drawing. No libraries needed.
#
#  Run:  powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-icons.ps1
#
#  NOTE: this file is deliberately pure ASCII. Windows PowerShell 5.1
#  reads .ps1 files as ANSI unless they carry a BOM, which mangles
#  non-ASCII characters and breaks the parser. Keep it ASCII.
# ============================================================

Add-Type -AssemblyName System.Drawing

$OutDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'icons'
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

function New-RoundedPath {
    param([single]$x, [single]$y, [single]$w, [single]$h, [single]$r)
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

function New-Icon {
    param([int]$Size, [string]$Path, [single]$Pad)

    $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    $mint  = [System.Drawing.ColorTranslator]::FromHtml('#E4F4EC')
    $green = [System.Drawing.ColorTranslator]::FromHtml('#3E8F71')
    $dark  = [System.Drawing.ColorTranslator]::FromHtml('#2F7A5E')
    $cream = [System.Drawing.ColorTranslator]::FromHtml('#F3FBF7')

    $g.Clear($mint)

    $s  = [single]$Size
    $in = $s * $Pad
    $bw = $s - 2 * $in
    $bh = $bw * 1.04
    $bx = $in
    $by = ($s - $bh) / 2

    $greenBrush = New-Object System.Drawing.SolidBrush($green)
    $darkBrush  = New-Object System.Drawing.SolidBrush($dark)
    $creamBrush = New-Object System.Drawing.SolidBrush($cream)

    # notebook body
    $g.FillPath($greenBrush, (New-RoundedPath $bx $by $bw $bh ([single]($bw * 0.11))))

    # spine
    $spineW = $bw * 0.24
    $g.FillPath($darkBrush, (New-RoundedPath $bx $by $spineW $bh ([single]($bw * 0.11))))
    $g.FillRectangle($darkBrush, $bx + $spineW * 0.5, $by, $spineW * 0.5, $bh)

    # three ruled lines
    $lx = $bx + $bw * 0.37
    $lw = $bw * 0.50
    $lh = $bh * 0.060
    foreach ($i in 0..2) {
        $ly = $by + $bh * (0.19 + $i * 0.215)
        $w  = if ($i -eq 2) { $lw * 0.62 } else { $lw }
        $g.FillPath($creamBrush, (New-RoundedPath $lx $ly $w $lh ([single]($lh / 2))))
    }

    # check mark badge
    $cr = $bw * 0.185
    $cx = $bx + $bw * 0.735
    $cy = $by + $bh * 0.785
    $g.FillEllipse($creamBrush, ($cx - $cr), ($cy - $cr), ($cr * 2), ($cr * 2))

    $pen = New-Object System.Drawing.Pen($green, [single]($bw * 0.052))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $pts = @(
        (New-Object System.Drawing.PointF(($cx - $cr * 0.44), ($cy + $cr * 0.02))),
        (New-Object System.Drawing.PointF(($cx - $cr * 0.10), ($cy + $cr * 0.36))),
        (New-Object System.Drawing.PointF(($cx + $cr * 0.50), ($cy - $cr * 0.40)))
    )
    $g.DrawLines($pen, $pts)

    $g.Dispose()
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()

    Write-Host ("  {0,-26} {1}x{1}" -f (Split-Path $Path -Leaf), $Size, $Size)
}

Write-Host ''
Write-Host "  generating icons -> $OutDir"
New-Icon -Size 180 -Path (Join-Path $OutDir 'icon-180.png') -Pad 0.06
New-Icon -Size 192 -Path (Join-Path $OutDir 'icon-192.png') -Pad 0.10
New-Icon -Size 512 -Path (Join-Path $OutDir 'icon-512.png') -Pad 0.10
New-Icon -Size 512 -Path (Join-Path $OutDir 'icon-512-maskable.png') -Pad 0.20
Write-Host '  done.'
Write-Host ''
