import { getRuntimeConfig } from '@/utils/runtime-config'
import { wpsBridge, WPSHelper } from '@/services/wps-bridge'
import { reportAuditEvent } from '@/services/audit-client'
import {
  MACRO_BENCH_SUITES,
  buildBenchCases,
  type MacroBenchCase,
  type MacroBenchHost,
  type MacroBenchPreset,
  type MacroBenchSuiteId,
} from './macro-bench-suites'

export type MacroBenchCaseResult = {
  case: MacroBenchCase
  sessionId: string
  documentName: string
  ok: boolean
  generateMs: number
  execTotalMs: number
  attempts: number // 0..5 (0 means generate failed before execution)
  repairsUsed: number // attempts-1
  message: string
}

export type MacroBenchFailTopItem = {
  reason: string
  count: number
  example?: string
}

export type MacroBenchSummary = {
  host: MacroBenchHost
  suiteId: MacroBenchSuiteId | 'all'
  total: number
  ok: number
  fail: number
  buckets: Record<string, number> // '0'..'5' + 'fail'
  failTop: MacroBenchFailTopItem[]
  ok0Rate: number // 0..1
  avgGenerateMs: number
  avgExecTotalMs: number
  p95GenerateMs: number
  p95ExecTotalMs: number
}

export type MacroBenchRun = {
  runId: string
  host: MacroBenchHost
  suiteId: MacroBenchSuiteId | 'all'
  preset: MacroBenchPreset
  startedAt: string
  finishedAt: string
  results: MacroBenchCaseResult[]
  summary: MacroBenchSummary
  summaryBySuite: Record<string, MacroBenchSummary>
}

const STORAGE_PREFIX = 'ah32_macro_bench_results_v2'
const nowIso = () => new Date().toISOString()

const getActiveDocName = (): string => {
  try {
    const app: any = wpsBridge.getApplication()
    return String(app?.ActiveDocument?.Name || app?.ActiveWorkbook?.Name || app?.ActivePresentation?.Name || '')
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench.ts', e)
    return ''
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const checkBackendHealth = async (): Promise<boolean> => {
  const cfg = getRuntimeConfig()
  const url = `${cfg.apiBase}/health`
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 1500)
    try {
      const resp = await fetch(url, { signal: ctrl.signal })
      if (!resp.ok) return false
      const data: any = await resp.json().catch(() => null)
      return !!data?.status
    } finally {
      clearTimeout(t)
    }
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench.ts', e)
    return false
  }
}

const callGeneratePlan = async (args: { query: string; sessionId: string; documentName: string; host: MacroBenchHost }) => {
  const cfg = getRuntimeConfig()
  const caps = wpsBridge.getCapabilities(false)
  const url = `${cfg.apiBase}/agentic/plan/generate`

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {}),
    },
    body: JSON.stringify({
      user_query: args.query,
      session_id: args.sessionId,
      document_name: args.documentName,
      host_app: args.host,
      capabilities: caps,
    }),
  })
  if (!resp.ok) {
    if (resp.status === 404) {
      throw new Error('backend_missing_endpoint: /agentic/plan/generate (please restart backend to latest code)')
    }
    const txt = await resp.text().catch(() => '')
    const detail = txt ? ` ${txt.slice(0, 200)}` : ''
    throw new Error(`generate_failed_http_${resp.status}${detail}`)
  }
  const data: any = await resp.json()
  return {
    success: !!data?.success,
    plan: data?.plan,
    error: typeof data?.error === 'string' ? data.error : '',
    durationMs: Number(data?.duration_ms || 0) || 0,
  }
}

const callGeneratePlanWithRetry = async (args: {
  query: string
  sessionId: string
  documentName: string
  host: MacroBenchHost
}) => {
  const cfg = getRuntimeConfig()
  const maxAttempts = 3
  let lastErr: any = null

  for (let i = 1; i <= maxAttempts; i++) {
    try {
      return await callGeneratePlan(args)
    } catch (e: any) {
      lastErr = e
      const msg = String(e?.message || e)
      // Retry only on network-level fetch failures.
      if (!/Failed to fetch|NetworkError|ERR_CONNECTION/i.test(msg)) break
      if (i < maxAttempts) {
        await sleep(400 * i)
      }
    }
  }

  const msg = String(lastErr?.message || lastErr)
  throw new Error(`${msg} (apiBase=${cfg.apiBase})`)
}

const callRepairPlan = async (args: {
  plan: any
  sessionId: string
  documentName: string
  host: MacroBenchHost
  errorType: string
  errorMessage: string
  attempt: number
}) => {
  const cfg = getRuntimeConfig()
  const caps = wpsBridge.getCapabilities(false)
  const url = `${cfg.apiBase}/agentic/plan/repair`

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {}),
    },
    body: JSON.stringify({
      session_id: args.sessionId,
      document_name: args.documentName,
      host_app: args.host,
      capabilities: caps,
      attempt: args.attempt,
      error_type: args.errorType,
      error_message: args.errorMessage,
      plan: args.plan,
    }),
  })
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '')
    const detail = txt ? ` ${txt.slice(0, 200)}` : ''
    throw new Error(`repair_failed_http_${resp.status}${detail}`)
  }
  const data: any = await resp.json()
  return {
    success: !!data?.success,
    plan: data?.plan,
    error: typeof data?.error === 'string' ? data.error : '',
  }
}

const p95 = (arr: number[]) => {
  const xs = arr.slice().sort((a, b) => a - b)
  if (!xs.length) return 0
  const idx = Math.max(0, Math.min(xs.length - 1, Math.floor(0.95 * (xs.length - 1))))
  return xs[idx]
}

const normalizeFailureReason = (raw: any): string => {
  const s = String(raw || '').trim()
  if (!s) return 'unknown'
  const lower = s.toLowerCase()
  if (
    lower.includes('backend_not_running') ||
    lower.includes('failed to fetch') ||
    lower.includes('err_connection') ||
    lower.includes('networkerror') ||
    lower.includes('econnrefused')
  ) return 'backend_unreachable'
  if (lower.includes('invalid plan') || lower.includes('invalid_plan')) return 'invalid_plan'
  if (lower.includes('plan executor') || lower.includes('plan execution')) return 'plan_exec_failed'
  if (lower.includes('unsupported_js_syntax')) return 'unsupported_js_syntax'
  if (lower.includes('timeout')) return 'timeout'
  if (lower.includes('syntaxerror')) return 'syntax_error'
  if (lower.includes('referenceerror')) return 'reference_error'
  if (lower.includes('typeerror')) return 'type_error'
  if (lower.includes('generate_failed')) return 'generate_failed'

  const head = s.split('\n')[0] || s
  const prefix = (head.split(':')[0] || '').trim()
  const key = prefix.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\-:.]/g, '').slice(0, 64)
  return key || 'unknown'
}

const computeSummary = (host: MacroBenchHost, suiteId: MacroBenchSuiteId | 'all', results: MacroBenchCaseResult[]): MacroBenchSummary => {
  const buckets: Record<string, number> = { fail: 0 }
  for (let i = 0; i <= 5; i++) buckets[String(i)] = 0

  let ok = 0
  let ok0 = 0
  let genSum = 0
  let execSum = 0
  const genAll: number[] = []
  const execAll: number[] = []
  const failCounts: Record<string, { count: number; example?: string }> = {}

  for (const r of results) {
    const g = Math.max(0, Number(r.generateMs) || 0)
    const e = Math.max(0, Number(r.execTotalMs) || 0)
    genSum += g
    execSum += e
    genAll.push(g)
    execAll.push(e)
    if (r.ok) {
      ok += 1
      if (r.repairsUsed === 0) ok0 += 1
      buckets[String(Math.max(0, Math.min(5, r.repairsUsed)))] += 1
    } else {
      buckets.fail += 1
      const reason = normalizeFailureReason(r.message)
      if (!failCounts[reason]) failCounts[reason] = { count: 0, example: undefined }
      failCounts[reason].count += 1
      if (!failCounts[reason].example) {
        const ex = String(r.message || '').trim().replace(/\s+/g, ' ')
        failCounts[reason].example = ex.length > 160 ? ex.slice(0, 160) + '...' : ex
      }
    }
  }

  const total = results.length
  const fail = total - ok
  const failTop: MacroBenchFailTopItem[] = Object.entries(failCounts)
    .sort((a, b) => (b[1]?.count || 0) - (a[1]?.count || 0))
    .slice(0, 6)
    .map(([reason, v]) => ({ reason, count: Number(v?.count || 0) || 0, example: v?.example }))

  return {
    host,
    suiteId,
    total,
    ok,
    fail,
    buckets,
    failTop,
    ok0Rate: total ? ok0 / total : 0,
    avgGenerateMs: total ? Math.round(genSum / total) : 0,
    avgExecTotalMs: total ? Math.round(execSum / total) : 0,
    p95GenerateMs: p95(genAll),
    p95ExecTotalMs: p95(execAll),
  }
}

export const loadBenchResults = (args: {
  host: MacroBenchHost
  suiteId?: MacroBenchSuiteId | 'all'
  preset?: MacroBenchPreset
}): { updatedAt: string; run: MacroBenchRun } | null => {
  try {
    const suiteId = args.suiteId || 'all'
    const preset = args.preset || 'standard'
    const raw = localStorage.getItem(`${STORAGE_PREFIX}:${args.host}:${suiteId}:${preset}`)
    if (!raw) return null
    const parsed: any = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const run = parsed.run as MacroBenchRun
    if (!run || typeof run !== 'object') return null
    const updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : ''
    return { updatedAt, run }
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench.ts', e)
    return null
  }
}

const saveBenchResults = (run: MacroBenchRun) => {
  try {
    const key = `${STORAGE_PREFIX}:${run.host}:${run.suiteId}:${run.preset}`
    localStorage.setItem(key, JSON.stringify({ updatedAt: nowIso(), run }))
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench.ts', e)
    // ignore
  }
}

export type RunBenchOptions = {
  suiteId?: MacroBenchSuiteId | 'all'
  preset?: MacroBenchPreset
  limitPerSuitePerHost?: number
  onProgress?: (p: {
    idx: number
    total: number
    caseName: string
    host: MacroBenchHost
    suiteId: MacroBenchSuiteId
  }) => void
  onResult?: (r: MacroBenchCaseResult) => void
  shouldStop?: () => boolean
}

export const getSuiteName = (id: MacroBenchSuiteId) => {
  return MACRO_BENCH_SUITES.find(s => s.id === id)?.name || id
}

export const runMacroBenchCurrentHost = async (opts?: RunBenchOptions): Promise<MacroBenchRun> => {
  const host = (wpsBridge.getHostApp() || 'wps') as MacroBenchHost
  const suiteId = (opts?.suiteId || 'all') as MacroBenchSuiteId | 'all'
  const preset = (opts?.preset || 'standard') as MacroBenchPreset

  const cases = buildBenchCases({
    host,
    suiteId,
    preset,
    limitPerSuitePerHost: opts?.limitPerSuitePerHost,
  })
  const total = cases.length

  // Fail fast if backend is not running to avoid burning time on repeated "Failed to fetch".
  if (!(await checkBackendHealth())) {
    throw new Error('backend_not_running: /health check failed (please start/restart backend)')
  }

  const startedAt = nowIso()
  const runId = `bench_run_${host}_${Date.now()}`
  const results: MacroBenchCaseResult[] = []

  const computeSuiteSummaries = (rs: MacroBenchCaseResult[]) => {
    const bySuite: Record<string, MacroBenchCaseResult[]> = {}
    for (const r of rs) {
      const sid = r.case?.suiteId || 'unknown'
      if (!bySuite[sid]) bySuite[sid] = []
      bySuite[sid].push(r)
    }
    const summaryBySuite: Record<string, MacroBenchSummary> = {}
    for (const sid of Object.keys(bySuite)) {
      summaryBySuite[sid] = computeSummary(host, sid as any, bySuite[sid])
    }
    return summaryBySuite
  }

  const persistPartial = () => {
    const summaryBySuite = computeSuiteSummaries(results)
    const run: MacroBenchRun = {
      runId,
      host,
      suiteId,
      preset,
      startedAt,
      finishedAt: nowIso(),
      results,
      summary: computeSummary(host, suiteId, results),
      summaryBySuite,
    }
    saveBenchResults(run)
  }

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]
    if (opts?.shouldStop?.()) break

    opts?.onProgress?.({ idx: i + 1, total, caseName: c.name, host, suiteId: c.suiteId })

    const sessionId = `bench_ui_${host}_${Date.now()}_${i + 1}`
    const docName = getActiveDocName()
    // 1) generate (single call)
    const t0 = performance.now()
    let plan: any = null
    let genMs = 0
    try {
      const gen = await callGeneratePlanWithRetry({ query: c.query, sessionId, documentName: docName, host })
      genMs = gen.durationMs || Math.round(performance.now() - t0)
      if (!gen.success || !gen.plan) {
        throw new Error(gen.error || "generate_empty_or_failed")
      }
      plan = gen.plan
    } catch (e: any) {
      const msg = `generate_failed: ${String(e?.message || e)}`
      const r: MacroBenchCaseResult = {
        case: c,
        sessionId,
        documentName: docName,
        ok: false,
        generateMs: Math.round(performance.now() - t0),
        execTotalMs: 0,
        attempts: 0,
        repairsUsed: 0,
        message: msg,
      }
      results.push(r)
      persistPartial()
      opts?.onResult?.(r)

      void reportAuditEvent({
        session_id: sessionId,
        host_app: host,
        mode: "plan",
        success: false,
        error_type: "bench_generate_failed",
        error_message: msg,
        extra: { bench: true, case: c.id, suite: c.suiteId, phase: "generate" },
      })

      // If the backend is down, stop the bench early (otherwise we just spam failures).
      if (/Failed to fetch/i.test(msg)) {
        const healthy = await checkBackendHealth()
        if (!healthy) break
      }

      continue
    }

    // 2) execute (+ repair loops via /agentic/plan/repair)
    const t1 = performance.now()

    // Ensure a stable artifact id so reruns overwrite instead of duplicating content.
    const stableId = `bench_${host}_${c.id}`.replace(/[^a-zA-Z0-9_\-:.]/g, "_").slice(0, 64)
    const ensurePlanBlockId = (input: any, blockId: string) => {
      if (!input || typeof input !== "object") return input
      let cloned: any
      try { cloned = JSON.parse(JSON.stringify(input)) } catch (e) { cloned = input }
      const walk = (actions: any[]): boolean => {
        for (const a of actions || []) {
          if (!a || typeof a !== "object") continue
          if (a.op === "upsert_block") {
            a.block_id = blockId
            return true
          }
          if (Array.isArray(a.actions) && walk(a.actions)) return true
        }
        return false
      }
      try { if (Array.isArray(cloned.actions)) walk(cloned.actions) } catch (e) {}
      return cloned
    }

    let currentPlan = ensurePlanBlockId(plan, stableId)
    const maxAttempts = 3
    let attempts = 0
    let ok = false
    let message = ""

    while (attempts < maxAttempts) {
      attempts += 1
      const exec = await WPSHelper.executePlan(currentPlan)
      if (exec?.success) {
        ok = true
        message = String(exec?.message || "")
        break
      }
      message = String(exec?.message || "Plan execution failed")
      try {
        const repaired = await callRepairPlan({
          plan: currentPlan,
          sessionId,
          documentName: docName,
          host,
          errorType: "exec_failed",
          errorMessage: message,
          attempt: attempts,
        })
        if (!repaired.success || !repaired.plan) break
        currentPlan = ensurePlanBlockId(repaired.plan, stableId)
      } catch (e: any) {
        message = `plan_repair_failed: ${String(e?.message || e)}`
        break
      }
    }

    const execMs = Math.round(performance.now() - t1)
    const repairsUsed = attempts > 0 ? Math.max(0, attempts - 1) : 0

    const r: MacroBenchCaseResult = {
      case: c,
      sessionId,
      documentName: docName,
      ok,
      generateMs: genMs,
      execTotalMs: execMs,
      attempts,
      repairsUsed,
      message,
    }
    results.push(r)
    persistPartial()
    opts?.onResult?.(r)

    void reportAuditEvent({
      session_id: sessionId,
      host_app: host,
      mode: "plan",
      success: ok,
      error_type: ok ? undefined : "bench_exec_failed",
      error_message: ok ? undefined : message.slice(0, 800),
      extra: {
        bench: true,
        case: c.id,
        suite: c.suiteId,
        generate_ms: genMs,
        exec_total_ms: execMs,
        attempts,
        repairs_used: repairsUsed,
      },
    })
  }

  const summaryBySuite = (() => {
    const bySuite: Record<string, MacroBenchCaseResult[]> = {}
    for (const r of results) {
      const sid = r.case?.suiteId || 'unknown'
      if (!bySuite[sid]) bySuite[sid] = []
      bySuite[sid].push(r)
    }
    const out: Record<string, MacroBenchSummary> = {}
    for (const sid of Object.keys(bySuite)) {
      out[sid] = computeSummary(host, sid as any, bySuite[sid])
    }
    return out
  })()

  const run: MacroBenchRun = {
    runId,
    host,
    suiteId,
    preset,
    startedAt,
    finishedAt: nowIso(),
    results,
    summary: computeSummary(host, suiteId, results),
    summaryBySuite,
  }
  saveBenchResults(run)
  return run
}

