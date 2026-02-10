# Ah32 WPS plugin uninstall script

[CmdletBinding()]
param(
  [string]$AddinId = "Ah32",
  [string[]]$Hosts = @("WPS", "ET", "WPP")
)

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [Console]::OutputEncoding
} catch {
  # best-effort
}

$pluginDest = Join-Path $env:APPDATA ("Kingsoft\\WPS\\Addins\\" + $AddinId)
function Normalize-Host([string]$h) {
  $v = ($h -as [string])
  if (-not $v) { return $null }
  $v = $v.Trim().ToUpperInvariant()
  if ($v -in @("WPS", "ET", "WPP")) { return $v }
  if ($v -eq "EX" -or $v -eq "EXCEL" -or $v -eq "SPREADSHEET") { return "ET" }
  if ($v -eq "PPT" -or $v -eq "PPTX" -or $v -eq "POWERPOINT" -or $v -eq "PRESENTATION") { return "WPP" }
  return $null
}
$normalizedHosts = @()
foreach ($h in $Hosts) {
  $n = Normalize-Host $h
  if ($n -and ($normalizedHosts -notcontains $n)) { $normalizedHosts += $n }
}
if ($normalizedHosts.Count -eq 0) { $normalizedHosts = @("WPS") }

Write-Host "=== Ah32 WPS Plugin Uninstall ===" -ForegroundColor Cyan
Write-Host "AddinId: $AddinId"
Write-Host "Hosts  : $($normalizedHosts -join ', ')"
Write-Host ""

# 1. Remove plugin directory
Write-Host "[1/2] Removing plugin directory..."
if (Test-Path $pluginDest) {
    Remove-Item -Recurse -Force $pluginDest
    Write-Host "   Deleted: $pluginDest" -ForegroundColor Green
} else {
    Write-Host "   Directory not found" -ForegroundColor Gray
}

# 2. Remove registry
Write-Host "[2/2] Removing registry..."
foreach ($wpsHost in $normalizedHosts) {
  $regPath = "HKCU:\Software\Kingsoft\Office\$wpsHost\AddinEngines\$AddinId"
  if (Test-Path $regPath) {
      Remove-Item -Path $regPath -Recurse -ErrorAction SilentlyContinue
      Write-Host "   Deleted registry: $regPath" -ForegroundColor Green
  } else {
      Write-Host "   Registry not found: $regPath" -ForegroundColor Gray
  }
}


# Best-effort remove entries from publish.xml (for modern WPS builds).
try {
  $publishPath = Join-Path $env:APPDATA "Kingsoft\\WPS\\jsaddons\\publish.xml"
  if (Test-Path $publishPath) {
    [xml]$xml = Get-Content -Raw -Path $publishPath
    if ($xml -and $xml.jsplugins) {
      $types = @("wps", "et", "wpp")
      foreach ($t in $types) {
        $node = $xml.SelectSingleNode("//jspluginonline[@name='$AddinId' and @type='$t']")
        if ($node -and $node.ParentNode) {
          $null = $node.ParentNode.RemoveChild($node)
        }
      }
      $xml.Save($publishPath)
      Write-Host "   publish.xml cleaned: $publishPath" -ForegroundColor Green
    }
  }
} catch {
  Write-Host "   publish.xml cleanup failed (ignored): $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== Uninstall Complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Please restart WPS." -ForegroundColor Yellow
