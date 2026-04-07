param(
    [switch]$Clean
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$buildScript = Join-Path $PSScriptRoot "build-tui.ps1"
$installerSpec = Join-Path $repoRoot "packaging\\inno\\installer.iss"
$distExe = Join-Path $repoRoot "out\\dist\\gpt-tui.exe"
$installerOut = Join-Path $repoRoot "out\\installer"

Set-Location $repoRoot

if (-not (Test-Path $distExe)) {
    Write-Host "Packaged exe not found, building it first..."
    if ($Clean) {
        powershell -ExecutionPolicy Bypass -File $buildScript -Clean
    } else {
        powershell -ExecutionPolicy Bypass -File $buildScript
    }
}

$isccCandidates = @(
    "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
    "C:\\Program Files\\Inno Setup 6\\ISCC.exe",
    "$env:LOCALAPPDATA\\Programs\\Inno Setup 6\\ISCC.exe"
)

$iscc = $isccCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) {
    $regKeys = @(
        "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
        "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
        "HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*"
    )
    $install = Get-ItemProperty $regKeys -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like "*Inno Setup*" } |
        Select-Object -First 1
    if ($install -and $install.InstallLocation) {
        $candidate = Join-Path $install.InstallLocation "ISCC.exe"
        if (Test-Path $candidate) {
            $iscc = $candidate
        }
    }
}
if (-not $iscc) {
    Write-Error @"
Inno Setup compiler not found.
Install Inno Setup 6 from: https://jrsoftware.org/isdl.php
Then run:
  powershell -ExecutionPolicy Bypass -File .\scripts\build-installer.ps1
"@
}

if ($Clean -and (Test-Path $installerOut)) {
    Remove-Item $installerOut -Recurse -Force
}

& $iscc $installerSpec

Write-Host ""
Write-Host "Installer build complete."
Write-Host "Output: $installerOut\\gpt-tui-setup.exe"
