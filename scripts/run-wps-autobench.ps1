param(
  [ValidateSet('wps', 'et', 'wpp')]
  [string]$BenchHost = 'wps',

  [ValidateSet('macro', 'chat')]
  [string]$RunMode = 'chat',

  [string]$SuiteId = 'system-plan-repair',

  [string]$Preset = 'standard',

  [ValidateSet('start', 'resume')]
  [string]$Action = 'start',

  [string]$FixtureDocx = 'C:\Users\Public\Documents\ah32_bench_fixture.docx',

  [string]$ApiBase = ''
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$tmpDir = Join-Path $repoRoot '.codex-tmp'
$driver = Join-Path $repoRoot 'scripts\wps_taskpane_driver.py'
$resolvedApiBase = [string]$(if ($ApiBase) { $ApiBase } elseif ($env:VITE_API_BASE) { $env:VITE_API_BASE } else { 'http://127.0.0.1:5123' })

New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

function Test-PortListening([int]$Port) {
  try {
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1)
  } catch {
    return $false
  }
}

function Stop-ProcessListeningOnPort([int]$Port) {
  try {
    $pids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($pid in $pids) {
      try {
        Stop-Process -Id $pid -Force -ErrorAction Stop
        Write-Host ("[autobench] stopped process on port " + $Port + ": pid=" + $pid)
      } catch {
        Write-Host ("[autobench] stop process on port " + $Port + " failed: pid=" + $pid + " " + $_.Exception.Message)
      }
    }
  } catch {}
}

function Stop-WpsJsProcesses {
  try {
    $items = @(Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Where-Object {
      $cmd = [string]$_.CommandLine
      $cmd -like '*scripts/wpsjs-debug.mjs*' -or $cmd -like '*node_modules\wpsjs\src\index.js debug*'
    })
    foreach ($item in $items) {
      try {
        Stop-Process -Id $item.ProcessId -Force -ErrorAction Stop
        Write-Host ("[autobench] stopped wpsjs process pid=" + $item.ProcessId)
      } catch {
        Write-Host ("[autobench] stop wpsjs process failed pid=" + $item.ProcessId + ' ' + $_.Exception.Message)
      }
    }
  } catch {}
}

function Stop-WpsHostProcesses {
  $names = @('wps', 'et', 'wpp')
  foreach ($name in $names) {
    try {
      $items = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
      foreach ($item in $items) {
        try {
          Stop-Process -Id $item.Id -Force -ErrorAction Stop
          Write-Host ("[autobench] stopped host process: " + $name + " pid=" + $item.Id)
        } catch {
          Write-Host ("[autobench] stop host process failed: " + $name + " pid=" + $item.Id + " " + $_.Exception.Message)
        }
      }
    } catch {}
  }
}

function Wait-Until([scriptblock]$Condition, [int]$TimeoutSeconds, [int]$IntervalMs = 800, [string]$Label = 'condition') {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (& $Condition) { return $true }
    Start-Sleep -Milliseconds $IntervalMs
  }
  throw "timeout_waiting_for_$Label"
}

function UrlEncode([string]$Value) {
  return [uri]::EscapeDataString([string]$Value)
}

function Quote-Ps([string]$Value) {
  return "'" + [string]$Value.Replace("'", "''") + "'"
}

function Start-BackgroundPowerShell([string]$Command) {
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command', $Command
  ) -WorkingDirectory $repoRoot | Out-Null
}

function Wait-HttpReady([string]$Url, [int]$TimeoutSeconds = 30) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 8
      if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) {
        Write-Host ("[autobench] prewarm ok: " + $Url + " status=" + $r.StatusCode)
        return $true
      }
    } catch {}
    Start-Sleep -Milliseconds 800
  }
  throw "timeout_waiting_http:$Url"
}

function Start-WpsHostViaCom {
  try {
    if ($BenchHost -eq 'et') {
      $app = New-Object -ComObject ket.Application
      $app.Visible = $true
      $null = $app.Workbooks.Add()
      try { $app.Activate() } catch {}
      Write-Host '[autobench] COM fallback created ET workbook.'
      return $true
    }
    if ($BenchHost -eq 'wpp') {
      $app = New-Object -ComObject kwpp.Application
      $app.Visible = $true
      $null = $app.Presentations.Add()
      try { $app.Activate() } catch {}
      Write-Host '[autobench] COM fallback created WPP presentation.'
      return $true
    }

    $wps = New-Object -ComObject kwps.Application
    $wps.Visible = $true
    if (-not (Test-Path $FixtureDocx)) {
      throw "fixture_doc_missing: $FixtureDocx"
    }
    $doc = $wps.Documents.Open($FixtureDocx)
    try { $wps.Activate() } catch {}
    Write-Host ("[autobench] COM fallback opened fixture: " + $FixtureDocx)
    return $true
  } catch {
    Write-Host ("[autobench] COM fallback failed: " + $_.Exception.Message)
    return $false
  }
}

function Ensure-EtWorkbookSavedForBench {
  try {
    if ($BenchHost -ne 'et') { return $true }
    $targetPath = Join-Path 'C:\Users\Public\Documents' ('Bench-ETMacro-' + (Get-Date -Format 'yyyyMMdd_HHmmss_fff') + '.xlsx')
    $py = @'
import os
import pythoncom
import win32com.client

pythoncom.CoInitialize()
target_path = os.environ.get("AH32_ET_BENCH_XLSX_PATH", "").strip()
if not target_path:
    raise SystemExit("missing_target_path")

last_error = None
for progid in ("ket.Application", "et.Application", "KET.Application", "ET.Application"):
    try:
        app = win32com.client.Dispatch(progid)
        wb = None
        try:
            wb = app.ActiveWorkbook
        except Exception:
            wb = None
        if not wb:
            try:
                books = app.Workbooks
                if books and books.Count >= 1:
                    wb = books.Item(1)
                elif books and hasattr(books, "Add"):
                    wb = books.Add()
            except Exception:
                wb = None
        if not wb:
            continue
        full_name = ""
        try:
            full_name = str(getattr(wb, "FullName", "") or "").strip()
        except Exception:
            full_name = ""
        if full_name and full_name.lower().endswith(".xlsx") and os.path.exists(full_name):
            print(full_name)
            raise SystemExit(0)
        try:
            app.DisplayAlerts = False
        except Exception:
            pass
        try:
            wb.SaveAs(target_path)
        except Exception:
            wb.SaveAs(target_path, 51)
        print(target_path)
        raise SystemExit(0)
    except Exception as exc:
        last_error = exc

raise SystemExit("save_active_workbook_failed:" + str(last_error))
'@
    $env:AH32_ET_BENCH_XLSX_PATH = $targetPath
    $pyResult = $py | python -
    if ($LASTEXITCODE -ne 0) {
      throw ($pyResult -join "`n")
    }
    $savedPath = (($pyResult | Select-Object -Last 1) -join '').Trim()
    Write-Host ('[autobench] ensured ET workbook saved: ' + $savedPath)
    return $true
  } catch {
    Write-Host ('[autobench] ensure ET workbook saved failed: ' + $_.Exception.Message)
    return $false
  } finally {
    Remove-Item Env:AH32_ET_BENCH_XLSX_PATH -ErrorAction SilentlyContinue
  }
}

function Set-DevBenchRequestInHost {
  param(
    [string]$RunModeValue,
    [string]$SuiteIdValue,
    [string]$PresetValue,
    [string]$ActionValue,
    [string]$OnceKeyValue
  )

  try {
    $payload = @{
      enabled = $true
      runMode = $RunModeValue
      suiteId = $SuiteIdValue
      preset = $PresetValue
      action = $ActionValue
      onceKey = $OnceKeyValue
    } | ConvertTo-Json -Compress
    $env:AH32_DEV_BENCH_REQUEST_JSON = $payload
    if ($BenchHost -ne 'wps') {
      return $false
    }
    $py = @'
import json
import os
import pythoncom
import win32com.client

pythoncom.CoInitialize()
payload = os.environ.get('AH32_DEV_BENCH_REQUEST_JSON', '')
if not payload:
    raise SystemExit('missing_payload')

last_error = None
for progid in ('kwps.Application', 'wps.Application'):
    try:
        app = win32com.client.Dispatch(progid)
        doc = None
        try:
            doc = app.ActiveDocument
        except Exception:
            doc = None
        if not doc:
            try:
                docs = app.Documents
                if docs and docs.Count >= 1:
                    doc = docs.Item(1)
            except Exception:
                doc = None
        if not doc:
            continue
        vars = doc.Variables
        try:
            vars.Item('AH32_DEV_BENCH_REQUEST').Value = payload
        except Exception:
            vars.Add('AH32_DEV_BENCH_REQUEST', payload)
        print(progid)
        raise SystemExit(0)
    except Exception as exc:
        last_error = exc

raise SystemExit('active_document_missing:' + str(last_error))
'@
    $pyResult = $py | python -
    if ($LASTEXITCODE -ne 0) {
      throw ($pyResult -join "`n")
    }
    Write-Host ('[autobench] wrote AH32_DEV_BENCH_REQUEST via ' + (($pyResult | Select-Object -Last 1) -join '') + '=' + $payload)
    return $true
  } catch {
    Write-Host ('[autobench] write request variable failed: ' + $_.Exception.Message)
    return $false
  } finally {
    Remove-Item Env:AH32_DEV_BENCH_REQUEST_JSON -ErrorAction SilentlyContinue
  }
}

function Read-DevBenchStatusFromHost {
  try {
    if ($BenchHost -ne 'wps') { return '' }
    $py = @'
import pythoncom
import win32com.client

pythoncom.CoInitialize()

for progid in ('kwps.Application', 'wps.Application'):
    try:
        app = win32com.client.Dispatch(progid)
        doc = None
        try:
            doc = app.ActiveDocument
        except Exception:
            doc = None
        if not doc:
            continue
        try:
            print(str(doc.Variables.Item('AH32_DEV_BENCH_STATUS').Value or ''))
            raise SystemExit(0)
        except Exception:
            continue
    except Exception:
        continue

raise SystemExit(1)
'@
    $out = $py | python -
    if ($LASTEXITCODE -ne 0) { return '' }
    return (($out -join "`n").Trim())
  } catch {
    return ''
  }
}

function Read-InspectHostState {
  try {
    $raw = & python $driver --host $BenchHost inspect-host-state
    if ($LASTEXITCODE -ne 0) { return $null }
    $json = (($raw -join "`n").Trim())
    if (-not $json) { return $null }
    return ($json | ConvertFrom-Json)
  } catch {
    Write-Host ('[autobench] inspect host state failed: ' + $_.Exception.Message)
    return $null
  }
}

function Test-StringCollectionContains {
  param(
    [object[]]$Values,
    [string]$Expected
  )

  foreach ($value in @($Values)) {
    if ([string]$value -eq $Expected) { return $true }
  }
  return $false
}

function Test-BenchMutation {
  param(
    [string]$SuiteIdValue,
    $State
  )

  if (-not $State) { return $false }
  switch ($SuiteIdValue) {
    'et-analyzer' {
      return (([int]$State.sheet_count -ge 2) -and ([int]$State.chart_count -ge 1) -and (Test-StringCollectionContains -Values @($State.sheet_names) -Expected 'Summary'))
    }
    'et-visualizer' {
      return (([int]$State.chart_count -ge 2) -and (Test-StringCollectionContains -Values @($State.chart_titles) -Expected 'Expense Structure') -and (Test-StringCollectionContains -Values @($State.chart_titles) -Expected 'Sales Trend'))
    }
    'ppt-creator' {
      return (([int]$State.slide_count -eq 3) -and (Test-StringCollectionContains -Values @($State.slide_title_codes) -Expected '9879-76EE-6C47-62A5') -and (Test-StringCollectionContains -Values @($State.slide_title_codes) -Expected '76EE-5F55') -and (Test-StringCollectionContains -Values @($State.slide_title_codes) -Expected '7ED3-8BBA-4E0E-4E0B-4E00-6B65'))
    }
    'ppt-outline' {
      return (([int]$State.slide_count -eq 4) -and (Test-StringCollectionContains -Values @($State.slide_title_codes) -Expected '9879-76EE-80CC-666F') -and (Test-StringCollectionContains -Values @($State.slide_title_codes) -Expected '5F53-524D-95EE-9898') -and (Test-StringCollectionContains -Values @($State.slide_title_codes) -Expected '89E3-51B3-65B9-6848') -and (Test-StringCollectionContains -Values @($State.slide_title_codes) -Expected '4E0B-4E00-6B65'))
    }
    'wpp-outline' {
      return (([int]$State.slide_count -eq 2) -and (Test-StringCollectionContains -Values @($State.slide_title_codes) -Expected '7248-5F0F-6D4B-8BD5') -and (Test-StringCollectionContains -Values @($State.slide_title_codes) -Expected '8981-70B9'))
    }
    default {
      return $false
    }
  }
}


$benchUrl = 'http://127.0.0.1:3890/?ah32_force_dev=1'
$benchUrl += '&ah32_dev_bench=1'
$benchUrl += '&ah32_dev_kiosk=bench'
$benchUrl += '&ah32_dev_bench_mode=' + (UrlEncode $RunMode)
$benchUrl += '&ah32_dev_bench_suite=' + (UrlEncode $SuiteId)
$benchUrl += '&ah32_dev_bench_preset=' + (UrlEncode $Preset)
$benchUrl += '&ah32_dev_bench_action=' + (UrlEncode $Action)
$onceKey = [string](Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmssfff')
$benchUrl += '&ah32_dev_bench_once=' + (UrlEncode $onceKey)

$viteOut = '.codex-tmp\auto-vite.out.log'
$viteErr = '.codex-tmp\auto-vite.err.log'
$wpsjsOut = '.codex-tmp\auto-wpsjs.out.log'
$wpsjsErr = '.codex-tmp\auto-wpsjs.err.log'

Set-Content -Path (Join-Path $tmpDir 'auto-wpsjs.url.txt') -Value $benchUrl -Encoding UTF8

$viteCommand = @(
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8'
  '$ErrorActionPreference = ''Stop'''
  '$env:VITE_API_BASE = ' + (Quote-Ps $resolvedApiBase)
  'Set-Location ' + (Quote-Ps $repoRoot)
  'npm -C ah32-ui-next run dev 1> ' + (Quote-Ps $viteOut) + ' 2> ' + (Quote-Ps $viteErr)
) -join '; '

$wpsjsScript = 'wpsjs:' + $BenchHost
$wpsjsCommand = @(
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8'
  '$ErrorActionPreference = ''Stop'''
  '$env:BID_WPSJS_URL = ' + (Quote-Ps $benchUrl)
  '$env:VITE_API_BASE = ' + (Quote-Ps $resolvedApiBase)
  'Set-Location ' + (Quote-Ps $repoRoot)
  'npm -C ah32-ui-next run ' + $wpsjsScript + ' 1> ' + (Quote-Ps $wpsjsOut) + ' 2> ' + (Quote-Ps $wpsjsErr)
) -join '; '

Write-Host ("[autobench] target host=" + $BenchHost + " mode=" + $RunMode + " suite=" + $SuiteId + " preset=" + $Preset + " action=" + $Action)
Write-Host ("[autobench] apiBase=" + $resolvedApiBase)
Write-Host ("[autobench] dev taskpane url=" + $benchUrl)

Write-Host '[autobench] stopping existing WPS host processes for a clean automation session...'
Stop-WpsHostProcesses
Stop-WpsJsProcesses
Start-Sleep -Seconds 2

if (-not (Test-PortListening 3889)) {
  Write-Host '[autobench] starting vite dev server...'
  Start-BackgroundPowerShell -Command $viteCommand
} else {
  Write-Host '[autobench] port 3889 already listening, reuse current vite dev server.'
}

Wait-Until -TimeoutSeconds 45 -Label 'port_3889' -Condition { Test-PortListening 3889 } | Out-Null

foreach ($port in @(3890, 3891, 3892)) {
  if (Test-PortListening $port) {
    Stop-ProcessListeningOnPort -Port $port
  }
}
Start-Sleep -Seconds 2
Write-Host ('[autobench] starting ' + $wpsjsScript + ' chain...')
Start-BackgroundPowerShell -Command $wpsjsCommand

Wait-Until -TimeoutSeconds 45 -Label 'port_3890' -Condition { Test-PortListening 3890 } | Out-Null
Wait-HttpReady -Url $benchUrl -TimeoutSeconds 45 | Out-Null
Wait-HttpReady -Url 'http://127.0.0.1:3889/taskpane.html' -TimeoutSeconds 45 | Out-Null

Write-Host '[autobench] waiting for WPS window...'
try {
  Wait-Until -TimeoutSeconds 20 -Label 'wps_window' -Condition {
    $null = & python $driver --host $BenchHost list-windows 2>$null
    return ($LASTEXITCODE -eq 0)
  } | Out-Null
} catch {
  Write-Host '[autobench] no visible WPS window yet, try COM fallback...'
  if (-not (Start-WpsHostViaCom)) { throw }
  Wait-Until -TimeoutSeconds 25 -Label 'wps_window_after_com' -Condition {
    $null = & python $driver --host $BenchHost list-windows 2>$null
    return ($LASTEXITCODE -eq 0)
  } | Out-Null
}

Write-Host ('[autobench] ensure ' + $BenchHost + ' editor...')
& python $driver --host $BenchHost ensure-host-editor
if ($LASTEXITCODE -ne 0) { throw 'ensure_host_editor_failed' }

if (-not (Ensure-EtWorkbookSavedForBench)) {
  throw 'ensure_et_workbook_saved_failed'
}

if (-not (Set-DevBenchRequestInHost -RunModeValue $RunMode -SuiteIdValue $SuiteId -PresetValue $Preset -ActionValue $Action -OnceKeyValue $onceKey)) {
  Write-Host ('[autobench] request variable unavailable for host=' + $BenchHost + ', continue with taskpane URL/hotkey fallback.')
}

Start-Sleep -Seconds 2

Write-Host '[autobench] ensure assistant open...'
& python $driver --host $BenchHost ensure-ah32-assistant-open
if ($LASTEXITCODE -ne 0) {
  Write-Host '[autobench] ensure-ah32-assistant-open returned non-zero, verify final state...'
}

Start-Sleep -Seconds 2

$assistantState = & python $driver --host $BenchHost assistant-state
if ($LASTEXITCODE -ne 0) { throw 'assistant_state_probe_failed' }
if (-not (($assistantState | Out-String) -match 'assistant_open=True')) {
  Write-Host '[autobench] assistant not visible yet, retry state probe...'
  $assistantReady = $false
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 2
    $assistantState = & python $driver --host $BenchHost assistant-state
    if ($LASTEXITCODE -eq 0 -and (($assistantState | Out-String) -match 'assistant_open=True')) {
      $assistantReady = $true
      break
    }
  }
  if (-not $assistantReady) {
    Write-Host '[autobench] retry ensure assistant open once more...'
    & python $driver --host $BenchHost ensure-ah32-assistant-open
    for ($i = 0; $i -lt 8; $i++) {
      Start-Sleep -Seconds 2
      $assistantState = & python $driver --host $BenchHost assistant-state
      if ($LASTEXITCODE -eq 0 -and (($assistantState | Out-String) -match 'assistant_open=True')) {
        break
      }
    }
  }
}
Write-Host ($assistantState | Out-String)
if (-not (($assistantState | Out-String) -match 'assistant_open=True')) {
  throw 'ensure_assistant_open_failed'
}

Start-Sleep -Seconds 8

Write-Host '[autobench] final assistant state:'
& python $driver --host $BenchHost assistant-state
if ($LASTEXITCODE -ne 0) { throw 'assistant_state_failed' }

Write-Host '[autobench] final taskpane info:'
& python $driver --host $BenchHost taskpane-info
if ($LASTEXITCODE -ne 0) { throw 'taskpane_info_failed' }

Start-Sleep -Seconds 5
$benchStatus = Read-DevBenchStatusFromHost
Write-Host ('[autobench] bench status probe=' + $(if ($benchStatus) { $benchStatus } else { '<empty>' }))
if ((-not $benchStatus) -or (($benchStatus -notmatch '"running":true') -and ($benchStatus -notmatch '"stage":"done"'))) {
  if ($BenchHost -eq 'wps') {
    Write-Host ('[autobench] bench not running yet, send fallback hotkey action=' + $Action)
    if ($Action -eq 'resume') {
      & python $driver --host $BenchHost bench-resume --focus
    } else {
      & python $driver --host $BenchHost bench-start --focus
    }
    if ($LASTEXITCODE -ne 0) { throw 'bench_fallback_action_failed' }
    Start-Sleep -Seconds 4
    $benchStatus = Read-DevBenchStatusFromHost
    Write-Host ('[autobench] bench status after fallback=' + $(if ($benchStatus) { $benchStatus } else { '<empty>' }))
  } else {
    Write-Host ('[autobench] bench status unavailable for host=' + $BenchHost + '; skip fallback hotkey to avoid duplicate execution.')
  }
}

Start-Sleep -Seconds 3
$inspectState = Read-InspectHostState
if ($inspectState) {
  $inspectJson = $inspectState | ConvertTo-Json -Depth 8 -Compress
  Write-Host ('[autobench] inspect host state=' + $inspectJson)
  if (Test-BenchMutation -SuiteIdValue $SuiteId -State $inspectState) {
    Write-Host ('[autobench] mutation verification passed for suite=' + $SuiteId)
    exit 0
  }
  Write-Host ('[autobench] mutation verification did not match expected signature for suite=' + $SuiteId)
  exit 3
}

Write-Host ('[autobench] inspect host state unavailable for host=' + $BenchHost)
exit 4
