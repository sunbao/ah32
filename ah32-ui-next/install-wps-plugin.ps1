# Ah32 WPS plugin install script (Windows)

[CmdletBinding()]
param(
  [string]$AddinId = "Ah32",
  [string[]]$Hosts = @("WPS", "ET", "WPP"),
  [string]$PluginSource = "",
  [string]$AppRoot = "",
  [string]$ApiBase = "http://127.0.0.1:5123",
  [string]$ApiKey = ""
)

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [Console]::OutputEncoding
} catch {
  # best-effort
}

function Resolve-PluginSource([string]$root, [string]$explicit) {
  if ($explicit -and (Test-Path $explicit)) { return (Resolve-Path $explicit).Path }

  $candidates = @(
    (Join-Path $root "wps-plugin"),
    (Join-Path $root "..\\wps-plugin"),
    (Join-Path $root "..\\ah32-ui-next\\wps-plugin")
  )
  foreach ($p in $candidates) {
    if (Test-Path $p) { return (Resolve-Path $p).Path }
  }
  throw "Cannot find plugin source. Pass -PluginSource <path-to-wps-plugin>."
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$appRootPath = $AppRoot
if (-not $appRootPath) {
  $appRootPath = $scriptRoot
}
$appRootPath = (Resolve-Path $appRootPath).Path

$pluginSourcePath = Resolve-PluginSource $scriptRoot $PluginSource

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

Write-Host "=== Ah32 WPS Plugin Install ===" -ForegroundColor Cyan
Write-Host "AddinId: $AddinId"
Write-Host "Source : $pluginSourcePath"
Write-Host "Dest   : $pluginDest"
Write-Host "Hosts  : $($normalizedHosts -join ', ')"
Write-Host "AppRoot: $appRootPath"
Write-Host ""

Write-Host "[1/4] Copy plugin files..."
New-Item -ItemType Directory -Force -Path $pluginDest | Out-Null
Copy-Item -Path (Join-Path $pluginSourcePath "*") -Destination $pluginDest -Recurse -Force
Write-Host "   Copied to: $pluginDest" -ForegroundColor Green

Write-Host "[2/4] Write registry..."
$taskpanePath = Join-Path $pluginDest "taskpane.html"
foreach ($wpsHost in $normalizedHosts) {
  $regPath = "HKCU:\Software\Kingsoft\Office\$wpsHost\AddinEngines\$AddinId"
  New-Item -Path $regPath -Force | Out-Null
  # WPS JS 插件引擎使用 Path=taskpane.html + Type=js
  New-ItemProperty -Path $regPath -Name "Path" -Value $taskpanePath -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $regPath -Name "Type" -Value "js" -PropertyType String -Force | Out-Null
  Write-Host "   Registry written: $regPath" -ForegroundColor Green
}

Write-Host "[3/4] Write publish.xml (for ET/WPP)..."

# Newer WPS builds prefer `%APPDATA%\kingsoft\wps\jsaddons\publish.xml` for JS plugins.
# We write/merge entries for wps/et/wpp pointing to the locally installed plugin folder (file://).
try {
  $publishPath = Join-Path $env:APPDATA "Kingsoft\\WPS\\jsaddons\\publish.xml"
  $pluginUrl = ([System.Uri]::new(($pluginDest.TrimEnd('\\') + '\\'))).AbsoluteUri
  $baseXml = "<?xml version=`"1.0`" encoding=`"UTF-8`"?><jsplugins></jsplugins>"

  function Load-And-Merge-PublishXml([string]$path, [string]$fallbackXml) {
    $raw = $fallbackXml
    if (Test-Path $path) {
      $raw = Get-Content -Raw -Path $path
    }

    # Some environments may end up with a corrupted publish.xml containing multiple XML documents
    # concatenated together. We split and merge them to avoid losing other plugins.
    $chunks = @()
    try {
      $matches = [regex]::Matches($raw, '(?m)^\\s*<\\?xml')
      if ($matches.Count -le 1) {
        $chunks = @($raw)
      } else {
        for ($i = 0; $i -lt $matches.Count; $i++) {
          $start = $matches[$i].Index
          $end = if ($i + 1 -lt $matches.Count) { $matches[$i + 1].Index } else { $raw.Length }
          $chunks += $raw.Substring($start, $end - $start)
        }
      }
    } catch {
      $chunks = @($raw)
    }

    [xml]$merged = $fallbackXml
    $root = $merged.DocumentElement
    if (-not $root -or $root.LocalName -ne "jsplugins") {
      [xml]$merged = $fallbackXml
      $root = $merged.DocumentElement
    }

    $seen = @{}
    foreach ($chunk in $chunks) {
      try {
        [xml]$doc = $chunk
      } catch {
        continue
      }
      $nodes = $doc.SelectNodes('//*[local-name()="jspluginonline"]')
      foreach ($n in $nodes) {
        try {
          $name = $n.Attributes["name"].Value
          $type = $n.Attributes["type"].Value
        } catch {
          continue
        }
        if (-not $name -or -not $type) { continue }
        $key = "$name|$type"
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $import = $merged.ImportNode($n, $true)
        $null = $root.AppendChild($import)
      }
    }
    return $merged
  }

  function Upsert-PublishEntry([xml]$doc, [string]$name, [string]$type, [string]$url) {
    $root = $doc.DocumentElement
    if (-not $root -or $root.LocalName -ne "jsplugins") {
      throw "publish.xml root element is missing or invalid"
    }

    $node = $doc.SelectSingleNode("//*[local-name()='jspluginonline' and @name='$name' and @type='$type']")
    if (-not $node) {
      $node = $doc.CreateElement("jspluginonline")
      $null = $root.AppendChild($node)
    }
    $null = $node.SetAttribute("name", $name)
    $null = $node.SetAttribute("type", $type)
    $null = $node.SetAttribute("url", $url)
    $null = $node.SetAttribute("enable", "enable")
    $null = $node.SetAttribute("install", "null")
  }

  $xml = Load-And-Merge-PublishXml $publishPath $baseXml

  Upsert-PublishEntry $xml $AddinId "wps" $pluginUrl
  Upsert-PublishEntry $xml $AddinId "et" $pluginUrl
  Upsert-PublishEntry $xml $AddinId "wpp" $pluginUrl

  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $publishPath) | Out-Null
  if (Test-Path $publishPath) {
    $bak = $publishPath + ".bak." + (Get-Date).ToString("yyyyMMdd_HHmmss")
    Copy-Item -Force $publishPath $bak
  }
  $xml.Save($publishPath)
  Write-Host "   publish.xml updated: $publishPath -> $pluginUrl" -ForegroundColor Green
} catch {
  Write-Host "   publish.xml update failed (ignored): $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host "[4/4] Write runtime config (config.js)..."

# Frontend runtime config.js (inside plugin folder)
$configJs = @"
// Generated by installer. Do not commit.
window.__AH32_CONFIG__ = {
  apiBase: "$ApiBase",
  apiKey: "$ApiKey",
  showThoughts: false
};
"@

$configPath = Join-Path $pluginDest "config.js"
Set-Content -Path $configPath -Value $configJs -Encoding UTF8
Write-Host "   Wrote: $configPath" -ForegroundColor Green

Write-Host "[OK] Done"
Write-Host ""
Write-Host "Please restart WPS." -ForegroundColor Yellow
