# Package Ah32 WPS plugin (frontend-only) into a single zip for distribution.
#
# Output zip contains:
# - wps-plugin/ (built assets)
# - install-wps-plugin.ps1 / uninstall-wps-plugin.ps1
# - INSTALL.txt
#
# Local usage (Windows PowerShell):
#   powershell -ExecutionPolicy Bypass -File .\scripts\package-wps-plugin.ps1
#
# CI usage:
#   pwsh ./scripts/package-wps-plugin.ps1 -SkipBuild -OutZip ./dist/Ah32WpsPlugin.zip

[CmdletBinding()]
param(
  # Path to ah32-ui-next (defaults to <repoRoot>\ah32-ui-next)
  [string]$UiRoot = "",

  # Path to built wps-plugin/ (defaults to <UiRoot>\wps-plugin)
  [string]$PluginSource = "",

  [string]$PackageName = "Ah32WpsPlugin",

  # Destination zip path (defaults to <repoRoot>\_release\<PackageName>.zip)
  [string]$OutZip = "",

  # Optional defaults written into packaged wps-plugin/config.js (NOT recommended to embed secrets)
  [string]$ApiBase = "",
  [string]$ApiKey = "",

  # Skip `npm run build` (useful for CI after build step)
  [switch]$SkipBuild,

  # Optionally run npm install/ci before build
  [switch]$InstallDeps
)

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [Console]::OutputEncoding
} catch {
  # best-effort
}

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$Utf8Bom = New-Object System.Text.UTF8Encoding($true)

function Resolve-RepoRoot {
  $base = $PSScriptRoot
  if (-not $base) { $base = (Get-Location).Path }
  return (Resolve-Path (Join-Path $base "..")).Path
}

function Resolve-PluginSource([string]$uiRoot, [string]$explicit) {
  if ($explicit -and (Test-Path $explicit)) { return (Resolve-Path $explicit).Path }
  $candidate = Join-Path $uiRoot "wps-plugin"
  if (Test-Path $candidate) { return (Resolve-Path $candidate).Path }
  throw "Cannot find plugin source. Pass -PluginSource <path-to-wps-plugin> or run build first."
}

$repoRoot = Resolve-RepoRoot

if (-not $UiRoot) {
  $UiRoot = Join-Path $repoRoot "ah32-ui-next"
}
$uiRootPath = (Resolve-Path $UiRoot).Path

if (-not $OutZip) {
  $OutZip = Join-Path (Join-Path $repoRoot "_release") ($PackageName + ".zip")
}

Write-Host "=== Package WPS Plugin ===" -ForegroundColor Cyan
Write-Host "RepoRoot    : $repoRoot"
Write-Host "UiRoot      : $uiRootPath"
Write-Host "SkipBuild   : $SkipBuild"
Write-Host "InstallDeps : $InstallDeps"
Write-Host "OutZip      : $OutZip"
Write-Host ""

if (-not $SkipBuild) {
  if ($InstallDeps) {
    if (Test-Path (Join-Path $uiRootPath "package-lock.json")) {
      Write-Host "[1/4] Install deps (npm ci)..." -ForegroundColor Gray
      npm -C $uiRootPath ci
    } else {
      Write-Host "[1/4] Install deps (npm install)..." -ForegroundColor Gray
      npm -C $uiRootPath install
    }
  }

  Write-Host "[2/4] Build (npm run build)..." -ForegroundColor Gray
  npm -C $uiRootPath run build
} else {
  Write-Host "[2/4] Skip build." -ForegroundColor Gray
}

$pluginSourcePath = Resolve-PluginSource $uiRootPath $PluginSource
$installScriptPath = Join-Path $uiRootPath "install-wps-plugin.ps1"
$uninstallScriptPath = Join-Path $uiRootPath "uninstall-wps-plugin.ps1"
if (-not (Test-Path $installScriptPath)) { throw "Missing: $installScriptPath" }
if (-not (Test-Path $uninstallScriptPath)) { throw "Missing: $uninstallScriptPath" }

$releaseRoot = Join-Path $repoRoot "_release"
$stageRoot = Join-Path $releaseRoot $PackageName
$stagePlugin = Join-Path $stageRoot "wps-plugin"

Write-Host "[3/4] Stage files..." -ForegroundColor Gray
if (Test-Path $stageRoot) { Remove-Item -Recurse -Force $stageRoot }
New-Item -ItemType Directory -Force -Path $stagePlugin | Out-Null

Copy-Item -Path (Join-Path $pluginSourcePath "*") -Destination $stagePlugin -Recurse -Force
Copy-Item -Path $installScriptPath -Destination (Join-Path $stageRoot "install-wps-plugin.ps1") -Force
Copy-Item -Path $uninstallScriptPath -Destination (Join-Path $stageRoot "uninstall-wps-plugin.ps1") -Force

# Provide a safe default config for manual installs. The installer will overwrite this into the installed addin folder.
$cfgApiBase = if ($ApiBase) { $ApiBase } else { "http://127.0.0.1:5123" }
$cfgApiKey = if ($ApiKey) { $ApiKey } else { "" }
$configJs = @"
// Runtime config for the WPS Taskpane.
// If you install via install-wps-plugin.ps1, this file will be regenerated into the installed addin folder.
// Do NOT commit secrets.
window.__AH32_CONFIG__ = {
  apiBase: "$cfgApiBase",
  apiKey: "$cfgApiKey",
  showThoughts: false
};
"@
[System.IO.File]::WriteAllText((Join-Path $stagePlugin "config.js"), $configJs, $Utf8NoBom)

# Optional: include rules docs (ASCII file names to avoid zip filename encoding issues).
try {
  $docsRoot = Join-Path (Join-Path (Join-Path $repoRoot "installer") "assets") "user-docs"
  $rulesEn = Join-Path $docsRoot "rules.docx"
  $stageDocs = Join-Path $stageRoot "user-docs"
  $rulesOther = $null
  try {
    $rulesOther = Get-ChildItem -Path $docsRoot -File -Filter "*.docx" | Where-Object { $_.Name -ne "rules.docx" } | Select-Object -First 1
  } catch {
    $rulesOther = $null
  }

  if ((Test-Path $rulesEn) -or $rulesOther) {
    New-Item -ItemType Directory -Force -Path $stageDocs | Out-Null
  }
  if (Test-Path $rulesEn) {
    Copy-Item -Force $rulesEn (Join-Path $stageDocs "rules.docx")
  }
  if ($rulesOther -and (Test-Path $rulesOther.FullName)) {
    Copy-Item -Force $rulesOther.FullName (Join-Path $stageDocs "rules.zh-CN.docx")
  }
  if (Test-Path $stageDocs) {
    Write-Host "   Included: user-docs\\rules.docx / user-docs\\rules.zh-CN.docx" -ForegroundColor Gray
  }
} catch {
  Write-Host "   [warn] include user-docs failed (ignored): $($_.Exception.Message)" -ForegroundColor Yellow
}

$installTxtLines = @(
  "Ah32 WPS Plugin (frontend package) - Install Guide (Windows)",
  "",
  "1) After unzip, you should see:",
  "   - wps-plugin\\",
  "   - install-wps-plugin.ps1",
  "   - user-docs\\ (optional)",
  "",
  "2) Install to WPS (recommended; supports remote backend):",
  "   powershell -ExecutionPolicy Bypass -File .\\install-wps-plugin.ps1 -PluginSource .\\wps-plugin -ApiBase http://<HOST>:5123 -ApiKey <KEY>",
  "",
  "3) Restart WPS to take effect.",
  "",
  "Uninstall:",
  "   powershell -ExecutionPolicy Bypass -File .\\uninstall-wps-plugin.ps1",
  "",
  "Notes:",
  "- ApiBase can point to a remote backend (no local backend needed).",
  "- Avoid baking ApiKey into the zip; prefer passing -ApiKey during install."
)
$installTxt = ($installTxtLines -join "`r`n")
[System.IO.File]::WriteAllText((Join-Path $stageRoot "INSTALL.txt"), $installTxt, $Utf8Bom)

Write-Host "[4/4] Zip..." -ForegroundColor Gray
$outDir = Split-Path -Parent $OutZip
if ($outDir) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
if (Test-Path $OutZip) { Remove-Item -Force $OutZip }
Compress-Archive -Path (Join-Path $stageRoot "*") -DestinationPath $OutZip -Force

$fi = Get-Item $OutZip
Write-Host "[OK] Wrote: $($fi.FullName) ($($fi.Length) bytes)" -ForegroundColor Green
