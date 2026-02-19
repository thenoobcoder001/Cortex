param(
    [switch]$Clean
)

$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

if ($Clean) {
    if (Test-Path ".\\build") { Remove-Item ".\\build" -Recurse -Force }
    if (Test-Path ".\\dist") { Remove-Item ".\\dist" -Recurse -Force }
    if (Test-Path ".\\gpt-tui.spec") { Remove-Item ".\\gpt-tui.spec" -Force }
}

python -m pip install --upgrade pip
python -m pip install -r requirements.txt pyinstaller

python -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --collect-submodules rich._unicode_data `
    --collect-data rich `
    --name gpt-tui `
    app.py

Write-Host ""
Write-Host "Build complete: $PSScriptRoot\\dist\\gpt-tui.exe"
