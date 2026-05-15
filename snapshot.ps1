# snapshot.ps1
# Freeze the current root state into a v<VERSION>/ folder.
# Reads VERSION from script.js, creates the target directory,
# and copies the canonical set of files into it.
#
# Usage:
#   .\snapshot.ps1
#
# Run this BEFORE bumping VERSION for the next development cycle.
# After snapshotting, remember to add a card for the new version
# to index_old_version_menu.html.

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# Locate the VERSION constant in script.js
$scriptPath = Join-Path $root 'script.js'
if (-not (Test-Path $scriptPath)) {
    throw "script.js not found at $scriptPath"
}
$content = Get-Content $scriptPath -Raw
$match = [regex]::Match($content, 'const\s+VERSION\s*=\s*(\d+)')
if (-not $match.Success) {
    throw "Could not find 'const VERSION = N' in script.js"
}
$version = [int]$match.Groups[1].Value
$targetDir = Join-Path $root "v$version"

if (Test-Path $targetDir) {
    throw "Target folder already exists: $targetDir. Remove or rename it first if you really want to overwrite."
}

New-Item -ItemType Directory -Path $targetDir | Out-Null

# Files (and globs) that make up a single self-contained version snapshot.
# Files that do not currently exist are silently skipped.
$includePatterns = @(
    'index.html',
    'script.js',
    'plants.txt',
    'animals.txt',
    'sprite.png',
    'plant_*.png',
    'animal_*.png',
    'gen_sprite.ps1'
)

$copied = @()
foreach ($pattern in $includePatterns) {
    Get-ChildItem -Path $root -Filter $pattern -File -ErrorAction SilentlyContinue | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination $targetDir
        $copied += $_.Name
    }
}

Write-Output "Snapshotted v$version to: $targetDir"
Write-Output "Files copied ($($copied.Count)):"
foreach ($name in $copied) {
    Write-Output "  $name"
}
Write-Output ""
Write-Output "Next steps:"
Write-Output "  1. Verify v$version/index.html runs correctly in a browser."
Write-Output "  2. Add a card for v$version to index_old_version_menu.html."
Write-Output "  3. Bump VERSION in script.js when starting the next cycle."
