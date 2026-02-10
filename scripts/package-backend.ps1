# Package AH32 backend into a platform-specific zip (Windows).
#
# This script builds a PyInstaller distribution and zips it for download.
#
# Usage (repo root):
#   powershell -ExecutionPolicy Bypass -File .\scripts\package-backend.ps1 -Platform windows-x64 -OutDir .\dist
#
# Prereqs:
# - Python 3.11+
# - `pyinstaller` available in current environment (recommended: `pip install -e ".[packaging]"`)

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("windows-x64")]
  [string]$Platform,

  [string]$OutDir = "dist",

  # Name of the executable/folder produced by PyInstaller.
  [string]$AppName = "Ah32",

  # Optional: explicit python executable to run PyInstaller.
  # If omitted, this script prefers a local venv at <repoRoot>\.venv\Scripts\python.exe when present.
  [string]$PythonExe = ""
)

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [Console]::OutputEncoding
} catch {
  # best-effort
}

function Resolve-RepoRoot {
  $base = $PSScriptRoot
  if (-not $base) { $base = (Get-Location).Path }
  return (Resolve-Path (Join-Path $base "..")).Path
}

$repoRoot = Resolve-RepoRoot
$outDirPath = (Resolve-Path (Join-Path $repoRoot $OutDir) -ErrorAction SilentlyContinue)
if (-not $outDirPath) {
  New-Item -ItemType Directory -Force -Path (Join-Path $repoRoot $OutDir) | Out-Null
  $outDirPath = (Resolve-Path (Join-Path $repoRoot $OutDir)).Path
} else {
  $outDirPath = $outDirPath.Path
}

Write-Host "=== Package Backend (Windows) ===" -ForegroundColor Cyan
Write-Host "RepoRoot : $repoRoot"
Write-Host "Platform : $Platform"
Write-Host "OutDir   : $outDirPath"
Write-Host "AppName  : $AppName"
Write-Host ""

Set-Location $repoRoot

Write-Host "[1/3] Build with PyInstaller..." -ForegroundColor Gray

# Prefer local venv python when available (CI-safe).
$python = $PythonExe
if (-not $python) {
  $venvPython = Join-Path $repoRoot ".venv\\Scripts\\python.exe"
  if (Test-Path $venvPython) { $python = $venvPython } else { $python = "python" }
}

# Clean old outputs (best-effort)
if (Test-Path (Join-Path $repoRoot "build")) { Remove-Item -Recurse -Force (Join-Path $repoRoot "build") }
if (Test-Path (Join-Path $repoRoot "dist\\$AppName")) { Remove-Item -Recurse -Force (Join-Path $repoRoot "dist\\$AppName") }

& $python -m PyInstaller -y `
  --name $AppName `
  --noconsole `
  --paths src `
  src\\ah32\\launcher.py

$pyDist = Join-Path $repoRoot ("dist\\" + $AppName)
if (-not (Test-Path $pyDist)) { throw "PyInstaller output not found: $pyDist" }

Write-Host "[2/3] Stage files..." -ForegroundColor Gray
$stageRoot = Join-Path $repoRoot ("_release\\backend\\" + $Platform)
if (Test-Path $stageRoot) { Remove-Item -Recurse -Force $stageRoot }
New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null

Copy-Item -Recurse -Force $pyDist (Join-Path $stageRoot $AppName)

if (Test-Path (Join-Path $repoRoot ".env.example")) {
  Copy-Item -Force (Join-Path $repoRoot ".env.example") (Join-Path $stageRoot ".env.example")
}

$readme = @(
  "AH32 Backend ($Platform)",
  "",
  "1) Copy .env.example to .env and set at least:",
  "   - DEEPSEEK_API_KEY=...",
  "",
  "2) Run:",
  ("   .\\{0}\\{0}.exe" -f $AppName),
  "",
  "Notes:",
  "- Default bind: http://127.0.0.1:5123",
  "- Logs: ah32_launcher.log (in the same folder)"
) -join "`r`n"
Set-Content -Path (Join-Path $stageRoot "README.txt") -Value $readme -Encoding UTF8

Write-Host "[3/3] Zip..." -ForegroundColor Gray
$zipName = "Ah32Backend-$Platform.zip"
$zipPath = Join-Path $outDirPath $zipName
if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
Compress-Archive -Path (Join-Path $stageRoot "*") -DestinationPath $zipPath -Force

$fi = Get-Item $zipPath
Write-Host "[OK] Wrote: $($fi.FullName) ($($fi.Length) bytes)" -ForegroundColor Green
