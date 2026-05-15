# Sprite generator for the Ecosystem Simulator.
# Generates 24x24 RGBA placeholder PNGs into the script's folder:
#   - sprite.png            : legacy animal placeholder (cyan gradient circle)
#   - plant_grass.png       : grass (yellow-green triangle, point up)
#   - plant_tree.png        : tree (dark green circle)
#   - plant_moss.png        : moss (cyan-green diamond)
#   - animal_herbivore.png  : herbivore (off-white circle)
#   - animal_carnivore.png  : carnivore (red circle with darker ring)
# These are placeholders intended to be swapped for nicer art later.

Add-Type -AssemblyName System.Drawing

$size  = 24
$outDir = $PSScriptRoot
$cx = ($size - 1) / 2.0
$cy = ($size - 1) / 2.0

function Save-PNG {
    param($Bitmap, $Name)
    $path = Join-Path $outDir $Name
    $Bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $Bitmap.Dispose()
    Write-Output "Saved: $path"
}

# ---------- Animal placeholder: cyan gradient circle ----------
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$maxR = $size / 2.0
for ($y = 0; $y -lt $size; $y++) {
    for ($x = 0; $x -lt $size; $x++) {
        $dx = $x - $cx; $dy = $y - $cy
        $d = [Math]::Sqrt($dx * $dx + $dy * $dy)
        if ($d -gt $maxR) { continue }
        $t = $d / $maxR
        $r = [int](220 * (1 - $t) + 30 * $t)
        $g = [int](245 * (1 - $t) + 100 * $t)
        $b = [int](255 * (1 - $t) + 200 * $t)
        $alpha = 255
        if ($t -gt 0.88) {
            $edge = [Math]::Min(1.0, ($t - 0.88) / 0.12)
            $alpha = [int](255 * (1 - $edge))
        }
        $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($alpha, $r, $g, $b))
    }
}
Save-PNG $bmp 'sprite.png'

# ---------- Grass: three angled blades emerging from a base ----------
# Blades use a yellow-green tip fading toward a darker green base.
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$baseY = 21.0
# Each blade: { tipX, tipY, baseX, half-width-at-base }
$blades = @(
    @{ tipX = 4.5;  tipY = 6.0;  baseX = 9.5;  width = 1.6 },
    @{ tipX = 11.5; tipY = 2.0;  baseX = 12.0; width = 1.8 },
    @{ tipX = 18.5; tipY = 5.5;  baseX = 14.5; width = 1.5 }
)
foreach ($blade in $blades) {
    $bladeLen = $baseY - $blade.tipY
    if ($bladeLen -le 0) { continue }
    for ($y = [int]$blade.tipY; $y -le [int]$baseY; $y++) {
        $t = ($y - $blade.tipY) / $bladeLen # 0 at tip, 1 at base
        $centerX = $blade.tipX * (1 - $t) + $blade.baseX * $t
        $w = $blade.width * (0.3 + 0.7 * $t)
        # Tip = brighter yellow-green, base = darker olive-green
        $r = [int](220 - 80 * $t)
        $g = [int](240 - 60 * $t)
        $b = [int]( 90 - 35 * $t)
        for ($dx = -2; $dx -le 2; $dx++) {
            $x = [int][Math]::Round($centerX + $dx)
            if ($x -lt 0 -or $x -ge $size) { continue }
            $dist = [Math]::Abs(($centerX + $dx) - $centerX)
            if ($dist -gt $w) { continue }
            $alpha = 255
            if ($dist -gt $w * 0.7) { $alpha = [int](255 * (1 - ($dist - $w * 0.7) / ($w * 0.3))) }
            # Stack only if more opaque than what's already there
            $existing = $bmp.GetPixel($x, $y)
            if ($existing.A -lt $alpha) {
                $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($alpha, $r, $g, $b))
            }
        }
    }
}
Save-PNG $bmp 'plant_grass.png'

# ---------- Tree: round canopy with light highlight + brown trunk ----------
$bmp = New-Object System.Drawing.Bitmap($size, $size)
# Trunk: small brown rectangle at the bottom centre
for ($y = 18; $y -le 22; $y++) {
    for ($x = [int]$cx - 1; $x -le [int]$cx + 1; $x++) {
        if ($x -lt 0 -or $x -ge $size) { continue }
        $brownR = 95; $brownG = 60; $brownB = 30
        $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, $brownR, $brownG, $brownB))
    }
}
# Canopy: filled circle, dark green with a small lighter highlight up-left
$canopyR = 9.5
$canopyCx = $cx
$canopyCy = 9.5
$highlightCx = $canopyCx - 3
$highlightCy = $canopyCy - 3
for ($y = 0; $y -lt $size; $y++) {
    for ($x = 0; $x -lt $size; $x++) {
        $dx = $x - $canopyCx; $dy = $y - $canopyCy
        $d = [Math]::Sqrt($dx * $dx + $dy * $dy)
        if ($d -gt $canopyR) { continue }
        $t = $d / $canopyR
        # Base color
        $r = [int](70 * (1 - $t) + 25 * $t)
        $g = [int](165 * (1 - $t) + 90 * $t)
        $b = [int](80 * (1 - $t) + 30 * $t)
        # Apply highlight blending
        $hd = [Math]::Sqrt(($x - $highlightCx) * ($x - $highlightCx) + ($y - $highlightCy) * ($y - $highlightCy))
        if ($hd -lt 4.0) {
            $hi = (1 - $hd / 4.0) * 0.4
            $r = [int]($r * (1 - $hi) + 180 * $hi)
            $g = [int]($g * (1 - $hi) + 235 * $hi)
            $b = [int]($b * (1 - $hi) + 130 * $hi)
        }
        $alpha = 255
        if ($t -gt 0.88) {
            $edge = [Math]::Min(1.0, ($t - 0.88) / 0.12)
            $alpha = [int](255 * (1 - $edge))
        }
        $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($alpha, $r, $g, $b))
    }
}
Save-PNG $bmp 'plant_tree.png'

# ---------- Moss: clustered organic blobs in cyan-green ----------
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$blobs = @(
    @{ x = 7.0;  y = 9.0;  r = 4.5 },
    @{ x = 16.5; y = 8.0;  r = 4.0 },
    @{ x = 11.5; y = 16.0; r = 5.0 },
    @{ x = 5.5;  y = 17.0; r = 3.5 },
    @{ x = 18.5; y = 16.5; r = 3.5 }
)
foreach ($blob in $blobs) {
    for ($y = 0; $y -lt $size; $y++) {
        for ($x = 0; $x -lt $size; $x++) {
            $dx = $x - $blob.x; $dy = $y - $blob.y
            $d = [Math]::Sqrt($dx * $dx + $dy * $dy)
            if ($d -gt $blob.r) { continue }
            $t = $d / $blob.r
            $r = [int](170 - 70 * $t)
            $g = [int](220 - 40 * $t)
            $b = [int](205 - 30 * $t)
            $alpha = 255
            if ($t -gt 0.80) { $alpha = [int](255 * (1 - ($t - 0.80) / 0.20)) }
            # Layer blobs: keep the more opaque pixel
            $existing = $bmp.GetPixel($x, $y)
            if ($existing.A -lt $alpha) {
                $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($alpha, $r, $g, $b))
            }
        }
    }
}
Save-PNG $bmp 'plant_moss.png'

# Helper: fill an antialiased ellipse, layering on top of existing pixels
# but only if the new pixel is more opaque than what is already there.
function Fill-Ellipse {
    param($Bmp, [double]$Cx, [double]$Cy, [double]$Rx, [double]$Ry, $Color, [int]$Opacity = 255)
    for ($y = 0; $y -lt 24; $y++) {
        for ($x = 0; $x -lt 24; $x++) {
            $dx = ($x - $Cx) / $Rx
            $dy = ($y - $Cy) / $Ry
            $d = $dx * $dx + $dy * $dy
            if ($d -gt 1.0) { continue }
            $alpha = $Opacity
            if ($d -gt 0.80) { $alpha = [int]($Opacity * (1 - ($d - 0.80) / 0.20)) }
            $existing = $Bmp.GetPixel($x, $y)
            if ($existing.A -lt $alpha) {
                $Bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($alpha, $Color[0], $Color[1], $Color[2]))
            }
        }
    }
}

# ---------- Herbivore: rabbit silhouette (side view, facing right) ----------
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$h_body = @(245, 245, 240)  # cream white
$h_ear  = @(215, 200, 195)  # slightly darker
$h_tail = @(255, 250, 248)  # pom-pom (slightly brighter)
$h_eye  = @(30, 30, 30)

# Body (large oval, lower-center)
Fill-Ellipse -Bmp $bmp -Cx 11 -Cy 15 -Rx 7.5 -Ry 4.7 -Color $h_body
# Head (smaller circle, above-right of body)
Fill-Ellipse -Bmp $bmp -Cx 16.5 -Cy 9.5 -Rx 3.6 -Ry 3.4 -Color $h_body
# Long ears (two vertical ellipses on top of head)
Fill-Ellipse -Bmp $bmp -Cx 15 -Cy 4.5 -Rx 1.2 -Ry 3.4 -Color $h_ear
Fill-Ellipse -Bmp $bmp -Cx 18.5 -Cy 4.5 -Rx 1.2 -Ry 3.4 -Color $h_ear
# Tail (pom-pom on the back/left)
Fill-Ellipse -Bmp $bmp -Cx 4 -Cy 14 -Rx 2.2 -Ry 1.9 -Color $h_tail
# Eye dot on head
$bmp.SetPixel(18, 9, [System.Drawing.Color]::FromArgb(255, $h_eye[0], $h_eye[1], $h_eye[2]))
$bmp.SetPixel(18, 10, [System.Drawing.Color]::FromArgb(180, $h_eye[0], $h_eye[1], $h_eye[2]))

Save-PNG $bmp 'animal_herbivore.png'

# ---------- Carnivore: wolf/fox silhouette (side view, facing right) ----------
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$c_body = @(170, 55, 55)    # dark red
$c_dark = @(115, 30, 30)    # deeper red for accents
$c_eye  = @(255, 220, 50)   # yellow eye

# Body (elongated horizontal oval)
Fill-Ellipse -Bmp $bmp -Cx 11 -Cy 15 -Rx 7.5 -Ry 4.0 -Color $c_body
# Head (smaller, ahead of body)
Fill-Ellipse -Bmp $bmp -Cx 17 -Cy 12 -Rx 3.0 -Ry 2.7 -Color $c_body
# Snout (small forward extension)
Fill-Ellipse -Bmp $bmp -Cx 20 -Cy 13 -Rx 2.0 -Ry 1.4 -Color $c_dark
# Two pointed ears (tilted ellipses)
Fill-Ellipse -Bmp $bmp -Cx 15 -Cy 8 -Rx 1.2 -Ry 2.6 -Color $c_dark
Fill-Ellipse -Bmp $bmp -Cx 18.5 -Cy 8 -Rx 1.2 -Ry 2.6 -Color $c_dark
# Tail (long curved extension back-up)
Fill-Ellipse -Bmp $bmp -Cx 4.5 -Cy 13 -Rx 3.0 -Ry 1.4 -Color $c_body
Fill-Ellipse -Bmp $bmp -Cx 2.5 -Cy 11 -Rx 1.8 -Ry 1.1 -Color $c_dark
# Eye
$bmp.SetPixel(18, 12, [System.Drawing.Color]::FromArgb(255, $c_eye[0], $c_eye[1], $c_eye[2]))

Save-PNG $bmp 'animal_carnivore.png'
