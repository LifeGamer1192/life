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

# ---------- Grass: yellow-green triangle pointing up ----------
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$topY = 2.0
$botY = 21.0
$halfWMax = 10.0
for ($y = 0; $y -lt $size; $y++) {
    for ($x = 0; $x -lt $size; $x++) {
        if ($y -lt $topY -or $y -gt $botY) { continue }
        $halfW = (($y - $topY) / ($botY - $topY)) * $halfWMax
        $offset = [Math]::Abs($x - $cx)
        if ($offset -gt $halfW) { continue }
        $alpha = 255
        $edge = $halfW - $offset
        if ($edge -lt 1.0) { $alpha = [int](255 * $edge) }
        $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($alpha, 200, 230, 80))
    }
}
Save-PNG $bmp 'plant_grass.png'

# ---------- Tree: dark green filled circle with subtle gradient ----------
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$treeR = 10.5
for ($y = 0; $y -lt $size; $y++) {
    for ($x = 0; $x -lt $size; $x++) {
        $dx = $x - $cx; $dy = $y - $cy
        $d = [Math]::Sqrt($dx * $dx + $dy * $dy)
        if ($d -gt $treeR) { continue }
        $t = $d / $treeR
        $r = [int](80 * (1 - $t) + 30 * $t)
        $g = [int](180 * (1 - $t) + 100 * $t)
        $b = [int](90 * (1 - $t) + 35 * $t)
        $alpha = 255
        if ($t -gt 0.85) {
            $edge = [Math]::Min(1.0, ($t - 0.85) / 0.15)
            $alpha = [int](255 * (1 - $edge))
        }
        $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($alpha, $r, $g, $b))
    }
}
Save-PNG $bmp 'plant_tree.png'

# ---------- Moss: cyan-green diamond (rotated square) ----------
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$mossR = 10.5
for ($y = 0; $y -lt $size; $y++) {
    for ($x = 0; $x -lt $size; $x++) {
        $dx = [Math]::Abs($x - $cx)
        $dy = [Math]::Abs($y - $cy)
        $manhattan = $dx + $dy
        if ($manhattan -gt $mossR) { continue }
        $t = $manhattan / $mossR
        $r = [int](170 * (1 - $t) + 100 * $t)
        $g = [int](225 * (1 - $t) + 175 * $t)
        $b = [int](225 * (1 - $t) + 200 * $t)
        $alpha = 255
        if ($t -gt 0.85) {
            $edge = [Math]::Min(1.0, ($t - 0.85) / 0.15)
            $alpha = [int](255 * (1 - $edge))
        }
        $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($alpha, $r, $g, $b))
    }
}
Save-PNG $bmp 'plant_moss.png'

# ---------- Herbivore: off-white circle with soft edge ----------
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$herbR = 10.0
for ($y = 0; $y -lt $size; $y++) {
    for ($x = 0; $x -lt $size; $x++) {
        $dx = $x - $cx; $dy = $y - $cy
        $d = [Math]::Sqrt($dx * $dx + $dy * $dy)
        if ($d -gt $herbR) { continue }
        $t = $d / $herbR
        # Bright white center, subtle warm tint toward the edge
        $r = [int](255 - $t * 12)
        $g = [int](255 - $t * 18)
        $b = [int](248 - $t * 28)
        $alpha = 255
        if ($t -gt 0.82) {
            $edge = [Math]::Min(1.0, ($t - 0.82) / 0.18)
            $alpha = [int](255 * (1 - $edge))
        }
        $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($alpha, $r, $g, $b))
    }
}
Save-PNG $bmp 'animal_herbivore.png'

# ---------- Carnivore: red circle with darker ring around the edge ----------
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$carnR = 10.0
for ($y = 0; $y -lt $size; $y++) {
    for ($x = 0; $x -lt $size; $x++) {
        $dx = $x - $cx; $dy = $y - $cy
        $d = [Math]::Sqrt($dx * $dx + $dy * $dy)
        if ($d -gt $carnR) { continue }
        $t = $d / $carnR
        # Bright red center, darker maroon edge
        $r = [int](240 - $t * 80)
        $g = [int](70 - $t * 30)
        $b = [int](70 - $t * 30)
        $alpha = 255
        if ($t -gt 0.82) {
            $edge = [Math]::Min(1.0, ($t - 0.82) / 0.18)
            $alpha = [int](255 * (1 - $edge))
        }
        $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($alpha, $r, $g, $b))
    }
}
Save-PNG $bmp 'animal_carnivore.png'
