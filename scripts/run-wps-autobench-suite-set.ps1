param(
  [string]$ApiBase = '',
  [switch]$StopOnFailure
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $repoRoot 'scripts\run-wps-autobench.ps1'
if (-not (Test-Path $runner)) {
  throw "autobench_runner_not_found: $runner"
}

$resolvedApiBase = [string]$(if ($ApiBase) { $ApiBase } elseif ($env:VITE_API_BASE) { $env:VITE_API_BASE } else { 'http://127.0.0.1:5123' })

$cases = @(
  @{ Host = 'et';  SuiteId = 'et-analyzer'   },
  @{ Host = 'et';  SuiteId = 'et-visualizer' },
  @{ Host = 'wpp'; SuiteId = 'ppt-creator'   },
  @{ Host = 'wpp'; SuiteId = 'ppt-outline'   },
  @{ Host = 'wpp'; SuiteId = 'wpp-outline'   }
)

$results = @()

foreach ($case in $cases) {
  $benchHostName = [string]$case.Host
  $suiteId = [string]$case.SuiteId
  Write-Host ("[suite-set] start host=" + $benchHostName + " suite=" + $suiteId)

  $args = @(
    '-ExecutionPolicy', 'Bypass',
    '-File', $runner,
    '-BenchHost', $benchHostName,
    '-RunMode', 'macro',
    '-SuiteId', $suiteId,
    '-Preset', 'standard',
    '-Action', 'start',
    '-ApiBase', $resolvedApiBase
  )

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  & powershell @args
  $exitCode = $LASTEXITCODE
  $sw.Stop()

  $row = [PSCustomObject]@{
    host = $benchHostName
    suite = $suiteId
    exit_code = $exitCode
    ok = ($exitCode -eq 0)
    elapsed_sec = [Math]::Round($sw.Elapsed.TotalSeconds, 1)
  }
  $results += $row

  if ($exitCode -eq 0) {
    Write-Host ("[suite-set] pass host=" + $benchHostName + " suite=" + $suiteId + " elapsed=" + $row.elapsed_sec + "s")
  } else {
    Write-Host ("[suite-set] fail host=" + $benchHostName + " suite=" + $suiteId + " exit=" + $exitCode + " elapsed=" + $row.elapsed_sec + "s")
    if ($StopOnFailure) {
      break
    }
  }
}

Write-Host '[suite-set] summary:'
$results | Format-Table host, suite, exit_code, ok, elapsed_sec -Auto

$failed = @($results | Where-Object { -not $_.ok })
if ($failed.Count -gt 0) {
  exit 1
}

exit 0
