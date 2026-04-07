param(
    [switch]$Clean
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$specPath = Join-Path $repoRoot "packaging\\pyinstaller\\gpt-tui.spec"
$outRoot = Join-Path $repoRoot "out"
$distRoot = Join-Path $outRoot "dist"
$buildRoot = Join-Path $outRoot "build"

Set-Location $repoRoot

if ($Clean) {
    if (Test-Path $buildRoot) { Remove-Item $buildRoot -Recurse -Force }
    if (Test-Path $distRoot) { Remove-Item $distRoot -Recurse -Force }
}

python -m pip install --upgrade pip
python -m pip install -r "$repoRoot\\requirements.txt" pyinstaller

python -m PyInstaller `
    --noconfirm `
    --clean `
    --distpath $distRoot `
    --workpath $buildRoot `
    $specPath

Write-Host ""
Write-Host "Build complete: $distRoot\\gpt-tui.exe"
