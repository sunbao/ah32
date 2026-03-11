import { getRuntimeConfig } from '@/utils/runtime-config'
import { parseJsonRelaxed } from '@/utils/relaxed-json'

import { wpsBridge, WPSHelper } from '@/services/wps-bridge'
import { jsMacroExecutor } from '@/services/js-macro-executor'

import { reportAuditEvent } from '@/services/audit-client'


import { planClient } from '@/services/plan-client'
import type { MacroBenchHost, MacroBenchPreset, MacroBenchSuiteId } from './macro-bench-suites'

import { buildChatBenchStories, type ChatBenchAction, type ChatBenchAssert, type ChatBenchStory, type ChatBenchTurn } from './macro-bench-chat-suites'



type ChatStoreLike = {

  messages: { value: Array<any> }

  isSending?: { value: boolean }

  sendMessage: (

    content: string,

    sessionId?: string,

    options?: {

      disableShortcuts?: boolean

      ensureDocSync?: boolean

      frontendContextPatch?: Record<string, any>

      ruleFiles?: string[]

    }

  ) => Promise<void>

  // Macro queue coverage (store-driven writeback path).
  enqueueWritebackForAssistantMessage?: (
    assistantMsg: any,
    updateTargetBlockId?: string | null,
    opts?: { onlyBlockIds?: string[]; onlyTypes?: Array<'plan'>; excludeConfirm?: boolean }
  ) => void

  getMacroBlockRun?: (messageId: string, blockId: string) => any

  setMacroBlockRun?: (

    blockId: string,

    run: { status: 'success' | 'error'; messageId: string; error?: string; finalCode?: string }

  ) => void

  markMacroMessageExecuted?: (messageId: string) => void

  clearMessages?: () => void

}



export type ChatBenchTurnResult = {

  story: Pick<ChatBenchStory, 'id' | 'suiteId' | 'host' | 'name'>

  turn: ChatBenchTurn

  // chat session id (to exercise memory/RAG like real users)

  chatSessionId: string

  // macro session id (used by executor + debug dumps)

  macroSessionId: string

  documentName: string

  ok: boolean

  assertOk: boolean

  score: number // 0..100

  assertTotalPoints: number

  assertPassedPoints: number

  assertFailures?: Array<{ type: string; points: number; message: string }>

  chatMs: number

  execTotalMs: number

  attempts: number // 0..5 (0 means no execution)

  repairsUsed: number

  tokenUsage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }

  message: string

  assistantMessageId?: string

  assistantPreview?: string

  codeBlocks?: number

}



export type ChatBenchSummary = {

  host: MacroBenchHost

  suiteId: MacroBenchSuiteId | 'all'

  total: number

  ok: number

  fail: number

  buckets: Record<string, number> // '0'..'5' + 'fail'

  ok0Rate: number

  avgChatMs: number

  avgExecTotalMs: number

  p95ChatMs: number

  p95ExecTotalMs: number

  assertOkRate: number

  avgScore: number

  p95Score: number

}



export type ChatBenchRun = {

  runId: string

  host: MacroBenchHost

  suiteId: MacroBenchSuiteId | 'all'

  preset: MacroBenchPreset

  chatSessionId: string

  startedAt: string

  finishedAt: string

  stories: Array<Pick<ChatBenchStory, 'id' | 'suiteId' | 'host' | 'name'>>

  results: ChatBenchTurnResult[]

  summary: ChatBenchSummary

  summaryBySuite: Record<string, ChatBenchSummary>

  // Checkpoint: next turn index to run (0..results.length)

  nextIdx?: number

  totalPlanned?: number

  // Bench metadata for long runs (filled by UI later)

  meta?: Record<string, any>

}



const STORAGE_PREFIX = 'ah32_chat_bench_results_v2'

const nowIso = () => new Date().toISOString()

const stripCodeFences = (raw: any): string => {
  try {
    const s = String(raw || '')
    return s.replace(/```[\s\S]*?```/g, '').trim()
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
    return String(raw || '').trim()
  }
}

const unwrapArrayRef = (v: any): any[] => {
  try {
    if (!v) return []
    const vv = (typeof v === 'object' && 'value' in v) ? (v as any).value : v
    return Array.isArray(vv) ? vv : []
  } catch (e) {
    return []
  }
}

const previewText = (raw: any): string => {

  try {

    const s = String(raw || '').trim()

    if (!s) return ''

    const withoutCode = s.replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ').trim()

    const out = withoutCode || s

    return out.length > 140 ? out.slice(0, 140) + '…' : out

  } catch (e) {

    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)

    return ''

  }

}



const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))



const withTimeout = async <T>(work: Promise<T>, ms: number, label: string): Promise<T> => {

  let timer: any = null

  try {

    if (!ms || ms <= 0) return await work

    return await Promise.race([

      work,

      new Promise<T>((_, reject) => {

        timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)

      }),

    ])

  } finally {

    if (timer) clearTimeout(timer)

  }

}



const percentile95 = (xs: number[]): number => {

  if (!xs.length) return 0

  const arr = xs.slice().sort((a, b) => a - b)

  const idx = Math.max(0, Math.min(arr.length - 1, Math.ceil(arr.length * 0.95) - 1))

  return arr[idx] || 0

}



const mean = (xs: number[]): number => {

  if (!xs.length) return 0

  return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length)

}



const computeSummary = (host: MacroBenchHost, suiteId: any, results: ChatBenchTurnResult[]): ChatBenchSummary => {

  const total = results.length

  let ok = 0

  let fail = 0

  let ok0 = 0

  let assertOk = 0

  const buckets: any = { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, fail: 0 }

  const chatMsArr: number[] = []

  const execMsArr: number[] = []

  const scoreArr: number[] = []



  for (const r of results) {

    if (r.ok) ok += 1

    else fail += 1

    if (r.assertOk) assertOk += 1



    if (!r.ok) buckets.fail += 1

    else {

      if (r.repairsUsed === 0) ok0 += 1

      buckets[String(Math.max(0, Math.min(5, r.repairsUsed)))] += 1

    }

    if (r.chatMs > 0) chatMsArr.push(r.chatMs)

    if (r.execTotalMs > 0) execMsArr.push(r.execTotalMs)

    if (typeof r.score === 'number') scoreArr.push(Math.max(0, Math.min(100, r.score)))

  }



  return {

    host,

    suiteId,

    total,

    ok,

    fail,

    buckets,

    ok0Rate: ok > 0 ? ok0 / ok : 0,

    avgChatMs: mean(chatMsArr),

    avgExecTotalMs: mean(execMsArr),

    p95ChatMs: percentile95(chatMsArr),

    p95ExecTotalMs: percentile95(execMsArr),

    assertOkRate: total > 0 ? assertOk / total : 0,

    avgScore: mean(scoreArr),

    p95Score: percentile95(scoreArr),

  }

}



const saveRun = (run: ChatBenchRun) => {

  try {

    const key = `${STORAGE_PREFIX}:${run.host}:${run.suiteId}:${run.preset}`

    const completedStoryIds = (() => {
      try {
        const ids = new Set<string>()
        for (const r of run.results || []) {
          const sid = String((r as any)?.story?.id || '')
          if (sid) ids.add(sid)
        }
        return Array.from(ids).sort()
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
        return []
      }
    })()

    const slimTurn = (t: any) => {
      try {
        if (!t || typeof t !== 'object') return null
        return {
          id: String((t as any).id || ''),
          name: String((t as any).name || ''),
          expectedOutput: (t as any).expectedOutput,
          queryPreview: previewText((t as any).query || ''),
          tags: Array.isArray((t as any).tags) ? (t as any).tags : undefined,
        }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
        return null
      }
    }

    const slimResults = Array.isArray(run.results)
      ? run.results.map((r: any) => ({
          ...r,
          // Strip heavy fields from turn (styleSpec/actions etc) to reduce localStorage churn.
          turn: slimTurn(r.turn),
        }))
      : []

    const slimMeta = (() => {
      try {
        return { ...(run.meta || {}), completedStoryIds }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
        return { completedStoryIds }
      }
    })()

    const slimRun: ChatBenchRun = { ...(run as any), meta: slimMeta, results: slimResults as any }

    // Guard: if payload is too large, keep only the newest results but preserve story ids for resume.
    const payload = { run: slimRun, savedAt: nowIso() }
    let raw = JSON.stringify(payload)
    if (raw.length > 3_800_000 && Array.isArray(slimRun.results) && slimRun.results.length > 200) {
      const kept = slimRun.results.slice(-200)
      raw = JSON.stringify({
        ...payload,
        run: {
          ...(slimRun as any),
          results: kept,
          meta: { ...(slimMeta as any), pruned: { kept: kept.length, dropped: slimRun.results.length - kept.length } },
        },
      })
    }

    localStorage.setItem(key, raw)

  } catch (e) {

    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)

  }

}



export const loadChatBenchResults = (args: {

  host: MacroBenchHost

  suiteId: MacroBenchSuiteId | 'all'

  preset: MacroBenchPreset

}): { run: ChatBenchRun | null; savedAt: string | null } => {

  try {

    const key = `${STORAGE_PREFIX}:${args.host}:${args.suiteId}:${args.preset}`

    const raw =
      localStorage.getItem(key) ||
      localStorage.getItem(`ah32_chat_bench_results_v1:${args.host}:${args.suiteId}:${args.preset}`)

    if (!raw) return { run: null, savedAt: null }

    const parsed: any = JSON.parse(raw)

    if (!parsed?.run) return { run: null, savedAt: null }

    return { run: parsed.run as ChatBenchRun, savedAt: String(parsed.savedAt || '') || null }

  } catch (e) {

    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)

    return { run: null, savedAt: null }

  }

}



const getActiveDocName = (): string => {

  try {

    const app: any = wpsBridge.getApplication()

    return String(app?.ActiveDocument?.Name || app?.ActiveWorkbook?.Name || app?.ActivePresentation?.Name || '')

  } catch (e) {

    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)

    return ''

  }

}



const extractPlanBlocks = (assistantMsg: any): string[] => {
  const out: string[] = []

  const tryParsePlanJson = (raw: string): { ok: boolean; json?: string } => {
    const text = String(raw || '').trim()
    if (!text) return { ok: false }
    const parsed = parseJsonRelaxed(text, { maxChars: 900_000, allowRepair: true })
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return { ok: false }
    if (String((parsed.value as any).schema_version || '').trim() !== 'ah32.plan.v1') return { ok: false }
    try {
      // Re-serialize so we always execute strict JSON (and normalize any repaired control chars).
      return { ok: true, json: JSON.stringify(parsed.value) }
    } catch (_e) {
      return { ok: true, json: text }
    }
  }

  // Preferred: plan is delivered out-of-band via SSE `event: plan` and attached to message metadata.
  try {
    const payloads = assistantMsg?.metadata?.macroBlockPayloads
    if (payloads && typeof payloads === 'object' && !Array.isArray(payloads)) {
      for (const v of Object.values(payloads as any)) {
        const body = (typeof v === 'string' ? v : '').trim()
        if (!body) continue
        const p = tryParsePlanJson(body)
        if (p.ok && p.json) out.push(p.json)
      }
    }
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.("ah32-ui-next/src/dev/macro-bench-chat.ts", e)
  }
  if (out.length > 0) return out

  // Fallback: legacy mode where plan JSON is embedded in assistant message content.
  const src = String(assistantMsg?.content || "")
  const re = /```(?:json)?\s*([\s\S]*?)```/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const body = String(m[1] || "").trim()
    if (!body) continue
    const p = tryParsePlanJson(body)
    if (p.ok && p.json) out.push(p.json)
  }

  // Some bench turns require raw JSON output (no ``` fence).
  if (out.length === 0) {
    const t = src.trim()
    const candidate = (() => {
      if (t.startsWith('{') && t.endsWith('}')) return t
      const first = t.indexOf('{')
      const last = t.lastIndexOf('}')
      if (first >= 0 && last > first) return t.slice(first, last + 1)
      return ''
    })()
    if (candidate) {
      const p = tryParsePlanJson(candidate)
      if (p.ok && p.json) out.push(p.json)
    }
  }
  return out
}

const ensurePlanBlockId = (input: any, blockId: string): any => {
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
  try { if (Array.isArray(cloned.actions)) walk(cloned.actions) } catch (e) { ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }
  return cloned
}

const normalizeBlockId = (raw: string): string => {

  return String(raw || '').replace(/[^a-zA-Z0-9_\-:.]/g, '_').slice(0, 64)

}

const ensurePlanBlockIdForSystemOps = (input: any, blockId: string): any => {
  if (!input || typeof input !== "object") return input
  let cloned: any
  try { cloned = JSON.parse(JSON.stringify(input)) } catch (e) { cloned = input }
  const ops = new Set([
    "upsert_block",
    "delete_block",
    "rollback_block",
    "set_selection_by_block",
  ])
  const walk = (actions: any[]) => {
    for (const a of actions || []) {
      if (!a || typeof a !== "object") continue
      if (typeof (a as any).op === "string" && ops.has(String((a as any).op))) {
        try { (a as any).block_id = blockId } catch (e) { /* ignore */ }
      }
      if (Array.isArray((a as any).actions)) walk((a as any).actions)
    }
  }
  try { if (Array.isArray((cloned as any).actions)) walk((cloned as any).actions) } catch (e) { ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }
  return cloned
}



type BenchAssertFailure = { type: string; points: number; message: string }

type BenchAssertEval = {

  totalPoints: number

  passedPoints: number

  ok: boolean

  score: number // 0..100

  failures: BenchAssertFailure[]

}



const assertPoints = (a: { points?: number } | undefined, fallback: number = 1): number => {

  const p = Number((a as any)?.points ?? fallback)

  if (!Number.isFinite(p) || p <= 0) return fallback

  return Math.round(p)

}



const runAssertScript = async (script: string): Promise<{ ok: boolean; message: string }> => {

  try {

    const r = await jsMacroExecutor.executeJS(String(script || ''), true)

    return { ok: !!r?.success, message: String(r?.message || '') }

  } catch (e: any) {

    return { ok: false, message: String(e?.message || e) }

  }

}



const buildAssertScript = (host: MacroBenchHost, a: ChatBenchAssert, blockId?: string | null): string | null => {

  const h = host

  if (a.type === 'writer_table_exists') {

    if (h !== 'wps') return null

    const minRows = Math.max(1, Number(a.minRows || 1) || 1)

    const minCols = Math.max(1, Number(a.minCols || 1) || 1)

    return (

      "var app = window.Application;\\n" +

      "var doc = null; try { doc = app.ActiveDocument; } catch (e) {}\\n" +

      `var minRows = ${minRows};\\n` +

      `var minCols = ${minCols};\\n` +

      "var t = null;\\n" +

      "try { if (doc && doc.Tables && doc.Tables.Count >= 1) { t = doc.Tables.Item(1); } } catch (e2) { t = null }\\n" +

      "if (!t) throw new Error('ASSERT_FAIL:writer_table_exists:no_table');\\n" +

      "var rows = 0; var cols = 0;\\n" +

      "try { rows = Number(t.Rows.Count || 0); cols = Number(t.Columns.Count || 0); } catch (e3) {}\\n" +

      "if (rows < minRows) throw new Error('ASSERT_FAIL:writer_table_exists:rows<' + minRows + ' got ' + rows);\\n" +

      "if (cols < minCols) throw new Error('ASSERT_FAIL:writer_table_exists:cols<' + minCols + ' got ' + cols);\\n" +

      "true;"

    )

  }

  if (a.type === 'writer_table_header_bold') {

    if (h !== 'wps') return null

    return (

      "var app = window.Application;\\n" +

      "var doc = null; try { doc = app.ActiveDocument; } catch (e) {}\\n" +

      "var t = null;\\n" +

      "try { if (doc && doc.Tables && doc.Tables.Count >= 1) { t = doc.Tables.Item(1); } } catch (e2) { t = null }\\n" +

      "if (!t) throw new Error('ASSERT_FAIL:writer_table_header_bold:no_table');\\n" +

      "var b = 0;\\n" +

      "try { b = Number(t.Rows.Item(1).Range.Font.Bold); } catch (e3) { b = 0 }\\n" +

      // COM: -1/1=true, 0=false, 999999=mixed -> accept non-zero.

      "if (b === 0) throw new Error('ASSERT_FAIL:writer_table_header_bold:header_not_bold');\\n" +

      "true;"

    )

  }

  if (a.type === 'writer_text_contains') {

    if (h !== 'wps') return null

    const needle = JSON.stringify(String(a.text || ''))

    return (

      "var app = window.Application;\\n" +

      "var doc = null; try { doc = app.ActiveDocument; } catch (e) {}\\n" +

      `var needle = ${needle};\\n` +

      "var txt = '';\\n" +

      "try { txt = String((doc && doc.Content && doc.Content.Text) ? doc.Content.Text : ''); } catch (e2) { txt = '' }\\n" +

      "if (txt.indexOf(String(needle)) === -1) throw new Error('ASSERT_FAIL:writer_text_contains:not_found:' + String(needle));\\n" +

      "true;"

    )

  }

  if (a.type === 'writer_text_not_contains') {

    if (h !== 'wps') return null

    const needle = JSON.stringify(String((a as any).text || ''))

    return (

      "var app = window.Application;\\n" +

      "var doc = null; try { doc = app.ActiveDocument; } catch (e) {}\\n" +

      `var needle = ${needle};\\n` +

      "var txt = '';\\n" +

      "try { txt = String((doc && doc.Content && doc.Content.Text) ? doc.Content.Text : ''); } catch (e2) { txt = '' }\\n" +

      "if (txt.indexOf(String(needle)) !== -1) throw new Error('ASSERT_FAIL:writer_text_not_contains:found:' + String(needle));\\n" +

      "true;"

    )

  }

  if (a.type === 'writer_heading_at_least') {

    if (h !== 'wps') return null

    const level = Math.max(1, Math.min(3, Number((a as any).level || 1) || 1))

    const min = Math.max(1, Number((a as any).min || 1) || 1)

    return (

      "var app = window.Application;\\n" +

      "var doc = null; try { doc = app.ActiveDocument; } catch (e) {}\\n" +

      `var level = ${level};\\n` +

      `var min = ${min};\\n` +

      "if (!doc || !doc.Paragraphs) throw new Error('ASSERT_FAIL:writer_heading_at_least:no_document');\\n" +

      "var c = 0;\\n" +

      "try {\\n" +

      "  for (var i = 1; i <= doc.Paragraphs.Count; i++) {\\n" +

      "    var p = null;\\n" +

      "    try { p = doc.Paragraphs.Item(i); } catch (e1) { p = null }\\n" +

      "    if (!p) continue;\\n" +

      "    var name = '';\\n" +

      "    try { name = String(p.Range && p.Range.Style ? (p.Range.Style.NameLocal || p.Range.Style.Name || '') : ''); } catch (e2) { name = '' }\\n" +

      "    name = String(name || '');\\n" +

      "    if (name.indexOf('标题 ' + String(level)) !== -1 || name.indexOf('Heading ' + String(level)) !== -1) { c++; continue; }\\n" +

      "    try {\\n" +

      "      var ol = Number(p.OutlineLevel || 0);\\n" +

      "      if (ol === level) { c++; continue; }\\n" +

      "    } catch (e3) {}\\n" +

      "  }\\n" +

      "} catch (e0) {}\\n" +

      "if (c < min) throw new Error('ASSERT_FAIL:writer_heading_at_least:count<' + min + ' got ' + c);\\n" +

      "true;"

    )

  }

  if (a.type === 'writer_shapes_at_least') {

    if (h !== 'wps') return null

    const min = Math.max(0, Number((a as any).min || 0) || 0)

    return (

      "var app = window.Application;\\n" +

      "var doc = null; try { doc = app.ActiveDocument; } catch (e) {}\\n" +

      `var min = ${min};\\n` +

      "if (!doc) throw new Error('ASSERT_FAIL:writer_shapes_at_least:no_document');\\n" +

      "var c = 0;\\n" +

      "try { if (doc.Shapes) c += Number(doc.Shapes.Count || 0); } catch (e1) {}\\n" +

      "try { if (doc.InlineShapes) c += Number(doc.InlineShapes.Count || 0); } catch (e2) {}\\n" +

      "if (c < min) throw new Error('ASSERT_FAIL:writer_shapes_at_least:count<' + min + ' got ' + c);\\n" +

      "true;"

    )

  }

  if (a.type === 'et_sheet_exists') {

    if (h !== 'et') return null

    const name = JSON.stringify(String(a.name || ''))

    return (

      "var app = window.Application;\\n" +

      `var target = ${name};\\n` +

      "var wb = null; try { wb = app.ActiveWorkbook || (app.Workbooks ? app.Workbooks.Item(1) : null); } catch (e) {}\\n" +

      "var ok = false;\\n" +

      "try {\\n" +

      "  if (wb && wb.Worksheets) {\\n" +

      "    for (var i = 1; i <= wb.Worksheets.Count; i++) {\\n" +

      "      var sh = null;\\n" +

      "      try { sh = wb.Worksheets.Item(i); } catch (e2) { sh = null }\\n" +

      "      if (sh && String(sh.Name) === String(target)) { ok = true; break; }\\n" +

      "    }\\n" +

      "  }\\n" +

      "} catch (e3) {}\\n" +

      "if (!ok) throw new Error('ASSERT_FAIL:et_sheet_exists:not_found:' + String(target));\\n" +

      "true;"

    )

  }

  if (a.type === 'et_chart_exists') {

    if (h !== 'et') return null

    const min = Math.max(1, Number(a.min || 1) || 1)

    return (

      "var app = window.Application;\\n" +

      `var min = ${min};\\n` +

      "var sh = null; try { sh = app.ActiveSheet; } catch (e) { sh = null }\\n" +

      "var c = 0;\\n" +

      "try {\\n" +

      "  if (sh && sh.ChartObjects) {\\n" +

      "    try { c = Number(sh.ChartObjects().Count || 0); } catch (e2) { try { c = Number(sh.ChartObjects.Count || 0); } catch (e3) {} }\\n" +

      "  }\\n" +

      "} catch (e4) {}\\n" +

      "if (c < min) throw new Error('ASSERT_FAIL:et_chart_exists:count<' + min + ' got ' + c);\\n" +

      "true;"

    )

  }

  if (a.type === 'et_chart_has_title') {

    if (h !== 'et') return null

    return (

      "var app = window.Application;\\n" +

      "var sh = null; try { sh = app.ActiveSheet; } catch (e) { sh = null }\\n" +

      "var c = 0;\\n" +

      "try { if (sh && sh.ChartObjects) { try { c = Number(sh.ChartObjects().Count || 0); } catch (e2) { try { c = Number(sh.ChartObjects.Count || 0); } catch (e3) {} } } } catch (e4) {}\\n" +

      "if (c <= 0) throw new Error('ASSERT_FAIL:et_chart_has_title:no_chart');\\n" +

      "var ch = null;\\n" +

      "try { if (sh && sh.ChartObjects) { ch = sh.ChartObjects(1).Chart; } } catch (e5) { try { ch = sh.ChartObjects().Item(1).Chart; } catch (e6) { ch = null } }\\n" +

      "if (!ch) throw new Error('ASSERT_FAIL:et_chart_has_title:no_chart_obj');\\n" +

      "var ok = false;\\n" +

      "try { ok = !!ch.HasTitle; } catch (e7) { ok = false }\\n" +

      "if (!ok) throw new Error('ASSERT_FAIL:et_chart_has_title:missing');\\n" +

      "true;"

    )

  }

  if (a.type === 'et_freeze_panes_enabled') {

    if (h !== 'et') return null

    return (

      "var app = window.Application;\\n" +

      "var w = null; try { w = app.ActiveWindow; } catch (e) { w = null }\\n" +

      "var ok = false;\\n" +

      "try { ok = !!(w && w.FreezePanes); } catch (e2) { ok = false }\\n" +

      "if (!ok) throw new Error('ASSERT_FAIL:et_freeze_panes_enabled:not_enabled');\\n" +

      "true;"

    )

  }

  if (a.type === 'et_cell_number_format_not_general') {

    if (h !== 'et') return null

    const a1 = JSON.stringify(String((a as any).a1 || 'A1'))

    return (

      "var app = window.Application;\\n" +

      `var addr = ${a1};\\n` +

      "var sh = null; try { sh = app.ActiveSheet; } catch (e) { sh = null }\\n" +

      "if (!sh || !sh.Range) throw new Error('ASSERT_FAIL:et_cell_number_format_not_general:no_sheet');\\n" +

      "var r = null; try { r = sh.Range(String(addr)); } catch (e2) { r = null }\\n" +

      "if (!r) throw new Error('ASSERT_FAIL:et_cell_number_format_not_general:no_range:' + String(addr));\\n" +

      "var nf = '';\\n" +

      "try { nf = String(r.NumberFormat || ''); } catch (e3) { nf = '' }\\n" +

      "if (!nf || String(nf).toLowerCase() === 'general') throw new Error('ASSERT_FAIL:et_cell_number_format_not_general:general:' + String(addr));\\n" +

      "true;"

    )

  }

  if (a.type === 'et_range_conditional_formats_at_least') {

    if (h !== 'et') return null

    const a1 = JSON.stringify(String((a as any).a1 || 'A1'))

    const min = Math.max(0, Number((a as any).min || 0) || 0)

    return (

      "var app = window.Application;\\n" +

      `var addr = ${a1};\\n` +

      `var min = ${min};\\n` +

      "var sh = null; try { sh = app.ActiveSheet; } catch (e) { sh = null }\\n" +

      "if (!sh || !sh.Range) throw new Error('ASSERT_FAIL:et_range_conditional_formats_at_least:no_sheet');\\n" +

      "var r = null; try { r = sh.Range(String(addr)); } catch (e2) { r = null }\\n" +

      "if (!r) throw new Error('ASSERT_FAIL:et_range_conditional_formats_at_least:no_range:' + String(addr));\\n" +

      "var c = 0;\\n" +

      "try { if (r.FormatConditions) c = Number(r.FormatConditions.Count || 0); } catch (e3) { c = 0 }\\n" +

      "if (c < min) throw new Error('ASSERT_FAIL:et_range_conditional_formats_at_least:count<' + min + ' got ' + c);\\n" +

      "true;"

    )

  }

  if (a.type === 'writer_block_backup_exists') {

    if (h !== 'wps') return null

    const ah32 = JSON.stringify(String((a as any).blockId || (a as any).block_id || blockId || ''))

    return (

      "var BID = null; try { BID = window.BID; } catch (e) { BID = null }\\n" +

      `var blockId = ${ah32};\\n` +

      "if (!blockId) throw new Error('ASSERT_FAIL:writer_block_backup_exists:no_block_id');\\n" +

      "if (!BID || typeof BID.hasBlockBackup !== 'function') throw new Error('ASSERT_FAIL:writer_block_backup_exists:no_BID_hasBlockBackup');\\n" +

      "var ok = false;\\n" +

      "try { ok = !!BID.hasBlockBackup(blockId); } catch (e2) { ok = false }\\n" +

      "if (!ok) throw new Error('ASSERT_FAIL:writer_block_backup_exists:not_found:' + String(blockId));\\n" +

      "true;"

    )

  }

  if (a.type === 'wpp_slide_count_at_least') {

    if (h !== 'wpp') return null

    const min = Math.max(1, Number(a.min || 1) || 1)

    return (

      "var app = window.Application;\\n" +

      `var min = ${min};\\n` +

      "var p = null; try { p = app.ActivePresentation || (app.Presentations ? app.Presentations.Item(1) : null); } catch (e) { p = null }\\n" +

      "if (!p || !p.Slides) throw new Error('ASSERT_FAIL:wpp_slide_count_at_least:no_presentation');\\n" +

      "var c = 0;\\n" +

      "try { c = Number(p.Slides.Count || 0); } catch (e2) { c = 0 }\\n" +

      "if (c < min) throw new Error('ASSERT_FAIL:wpp_slide_count_at_least:count<' + min + ' got ' + c);\\n" +

      "true;"

    )

  }

  if (a.type === 'wpp_last_slide_shapes_at_least') {

    if (h !== 'wpp') return null

    const min = Math.max(1, Number(a.min || 1) || 1)

    return (

      "var app = window.Application;\\n" +

      `var min = ${min};\\n` +

      "var p = null; try { p = app.ActivePresentation || (app.Presentations ? app.Presentations.Item(1) : null); } catch (e) { p = null }\\n" +

      "if (!p || !p.Slides) throw new Error('ASSERT_FAIL:wpp_last_slide_shapes_at_least:no_presentation');\\n" +

      "var sc = 0;\\n" +

      "try { sc = Number(p.Slides.Count || 0); } catch (e2) { sc = 0 }\\n" +

      "if (sc <= 0) throw new Error('ASSERT_FAIL:wpp_last_slide_shapes_at_least:no_slides');\\n" +

      "var s = null; try { s = p.Slides.Item(sc); } catch (e3) { s = null }\\n" +

      "var c = 0;\\n" +

      "try { if (s && s.Shapes) c = Number(s.Shapes.Count || 0); } catch (e4) { c = 0 }\\n" +

      "if (c < min) throw new Error('ASSERT_FAIL:wpp_last_slide_shapes_at_least:shapes<' + min + ' got ' + c);\\n" +

      "true;"

    )

  }

  if (a.type === 'wpp_slide_text_contains') {

    if (h !== 'wpp') return null

    const text = JSON.stringify(String((a as any).text || '').trim())

    return (

      "var app = window.Application;\\n" +

      `var needle = ${text};\\n` +

      "if (!needle) throw new Error('ASSERT_FAIL:wpp_slide_text_contains:empty');\\n" +

      "var p = null; try { p = app.ActivePresentation || (app.Presentations ? app.Presentations.Item(1) : null); } catch (e) { p = null }\\n" +

      "if (!p || !p.Slides) throw new Error('ASSERT_FAIL:wpp_slide_text_contains:no_presentation');\\n" +

      "var sc = 0;\\n" +

      "try { sc = Number(p.Slides.Count || 0); } catch (e2) { sc = 0 }\\n" +

      "if (sc <= 0) throw new Error('ASSERT_FAIL:wpp_slide_text_contains:no_slides');\\n" +

      "var s = null; try { s = p.Slides.Item(sc); } catch (e3) { s = null }\\n" +

      "if (!s) throw new Error('ASSERT_FAIL:wpp_slide_text_contains:no_last_slide');\\n" +

      "var found = false;\\n" +

      "try {\\n" +

      "  if (s.Shapes) {\\n" +

      "    var c = 0; try { c = Number(s.Shapes.Count || 0); } catch (e4) { c = 0 }\\n" +

      "    for (var i = 1; i <= c; i++) {\\n" +

      "      var sh = null; try { sh = s.Shapes.Item(i); } catch (e5) { sh = null }\\n" +

      "      if (!sh) continue;\\n" +

      "      var t = '';\\n" +

      "      try {\\n" +

      "        if (sh.TextFrame && sh.TextFrame.HasText && sh.TextFrame.TextRange) t = String(sh.TextFrame.TextRange.Text || '');\\n" +

      "      } catch (e6) { t = '' }\\n" +

      "      if (t && t.indexOf(needle) >= 0) { found = true; break; }\\n" +

      "    }\\n" +

      "  }\\n" +

      "} catch (e7) {}\\n" +

      "if (!found) throw new Error('ASSERT_FAIL:wpp_slide_text_contains:missing:' + String(needle));\\n" +

      "true;"

    )

  }

  if (a.type === 'wpp_placeholder_text_contains') {

    if (h !== 'wpp') return null

    const kind = JSON.stringify(String((a as any).kind || 'body').trim().toLowerCase())
    const text = JSON.stringify(String((a as any).text || '').trim())
    const index = Math.max(1, Number((a as any).index || 1) || 1)

    return (

      "var app = window.Application;\\n" +

      `var kind = ${kind};\\n` +

      `var needle = ${text};\\n` +

      `var idx = ${index};\\n` +

      "if (!needle) throw new Error('ASSERT_FAIL:wpp_placeholder_text_contains:empty');\\n" +

      "var p = null; try { p = app.ActivePresentation || (app.Presentations ? app.Presentations.Item(1) : null); } catch (e) { p = null }\\n" +

      "if (!p || !p.Slides) throw new Error('ASSERT_FAIL:wpp_placeholder_text_contains:no_presentation');\\n" +

      "var sc = 0;\\n" +

      "try { sc = Number(p.Slides.Count || 0); } catch (e2) { sc = 0 }\\n" +

      "if (sc <= 0) throw new Error('ASSERT_FAIL:wpp_placeholder_text_contains:no_slides');\\n" +

      "var s = null; try { s = p.Slides.Item(sc); } catch (e3) { s = null }\\n" +

      "if (!s) throw new Error('ASSERT_FAIL:wpp_placeholder_text_contains:no_last_slide');\\n" +

      "var typeMap = { title: 1, body: 2, subtitle: 4 };\\n" +

      "var pt = (kind && (kind in typeMap)) ? typeMap[kind] : null;\\n" +

      "if (pt == null) throw new Error('ASSERT_FAIL:wpp_placeholder_text_contains:bad_kind:' + String(kind));\\n" +

      "var shapes = null; try { shapes = s.Shapes; } catch (e4) { shapes = null }\\n" +

      "if (!shapes) throw new Error('ASSERT_FAIL:wpp_placeholder_text_contains:no_shapes');\\n" +

      "var target = null;\\n" +

      "try { if (kind === 'title') target = shapes.Title; } catch (e5) { target = null }\\n" +

      "if (!target) {\\n" +

      "  var candidates = [];\\n" +

      "  var c = 0; try { c = Number(shapes.Count || 0); } catch (e6) { c = 0 }\\n" +

      "  for (var i = 1; i <= c; i++) {\\n" +

      "    var sh = null; try { sh = shapes.Item(i); } catch (e7) { sh = null }\\n" +

      "    if (!sh) continue;\\n" +

      "    var pf = null; try { pf = sh.PlaceholderFormat; } catch (e8) { pf = null }\\n" +

      "    if (!pf) continue;\\n" +

      "    var t = -1; try { t = Number(pf.PlaceholderType); } catch (e9) { t = -1 }\\n" +

      "    if (t === pt) candidates.push(sh);\\n" +

      "  }\\n" +

      "  if (candidates.length >= 1) {\\n" +

      "    target = candidates[Math.min(candidates.length - 1, idx - 1)] || candidates[0];\\n" +

      "  }\\n" +

      "}\\n" +

      "if (!target) throw new Error('ASSERT_FAIL:wpp_placeholder_text_contains:no_placeholder:kind=' + String(kind) + ':idx=' + String(idx));\\n" +

      "var txt = '';\\n" +

      "try { if (target.TextFrame && target.TextFrame.TextRange) txt = String(target.TextFrame.TextRange.Text || ''); } catch (e10) { txt = '' }\\n" +

      "if (txt.indexOf(String(needle)) === -1) throw new Error('ASSERT_FAIL:wpp_placeholder_text_contains:missing:' + String(needle));\\n" +

      "true;"

    )

  }

  if (a.type === 'wpp_last_slide_within_bounds') {

    if (h !== 'wpp') return null

    const margin = Math.max(0, Number((a as any).margin || 0) || 0)

    return (

      "var app = window.Application;\\n" +

      `var margin = ${margin};\\n` +

      "var p = null; try { p = app.ActivePresentation || (app.Presentations ? app.Presentations.Item(1) : null); } catch (e) { p = null }\\n" +

      "if (!p || !p.Slides) throw new Error('ASSERT_FAIL:wpp_last_slide_within_bounds:no_presentation');\\n" +

      "var sw = 960, sh = 540;\\n" +

      "try { if (p.PageSetup) { sw = Number(p.PageSetup.SlideWidth || sw); sh = Number(p.PageSetup.SlideHeight || sh); } } catch (e1) {}\\n" +

      "var sc = 0;\\n" +

      "try { sc = Number(p.Slides.Count || 0); } catch (e2) { sc = 0 }\\n" +

      "if (sc <= 0) throw new Error('ASSERT_FAIL:wpp_last_slide_within_bounds:no_slides');\\n" +

      "var s = null; try { s = p.Slides.Item(sc); } catch (e3) { s = null }\\n" +

      "if (!s || !s.Shapes) throw new Error('ASSERT_FAIL:wpp_last_slide_within_bounds:no_shapes');\\n" +

      "var c = 0;\\n" +

      "try { c = Number(s.Shapes.Count || 0); } catch (e4) { c = 0 }\\n" +

      "for (var i = 1; i <= c; i++) {\\n" +

      "  var x = null; try { x = s.Shapes.Item(i); } catch (e5) { x = null }\\n" +

      "  if (!x) continue;\\n" +

      "  var alt = '';\\n" +

      "  try { alt = String(x.AlternativeText || ''); } catch (e6) { alt = '' }\\n" +

      "  if (alt && alt.indexOf('AH32_BLOCKID:') >= 0) continue;\\n" +

      "  var l = 0, t = 0, w = 0, h2 = 0;\\n" +

      "  try { l = Number(x.Left || 0); } catch (e7) { l = 0 }\\n" +

      "  try { t = Number(x.Top || 0); } catch (e8) { t = 0 }\\n" +

      "  try { w = Number(x.Width || 0); } catch (e9) { w = 0 }\\n" +

      "  try { h2 = Number(x.Height || 0); } catch (e10) { h2 = 0 }\\n" +

      "  if (!isFinite(l) || !isFinite(t) || !isFinite(w) || !isFinite(h2)) continue;\\n" +

      "  if (w < 2 || h2 < 2) continue;\\n" +

      "  var r = l + w;\\n" +

      "  var b = t + h2;\\n" +

      "  if (l < (0 - margin) || t < (0 - margin) || r > (sw + margin) || b > (sh + margin)) {\\n" +

      "    throw new Error('ASSERT_FAIL:wpp_last_slide_within_bounds:out_of_bounds:left=' + l + ',top=' + t + ',right=' + r + ',bottom=' + b + ',sw=' + sw + ',sh=' + sh);\\n" +

      "  }\\n" +

      "}\\n" +

      "true;"

    )

  }

  if (a.type === 'wpp_last_slide_no_overlap') {

    if (h !== 'wpp') return null

    return (

      "var app = window.Application;\\n" +

      "var p = null; try { p = app.ActivePresentation || (app.Presentations ? app.Presentations.Item(1) : null); } catch (e) { p = null }\\n" +

      "if (!p || !p.Slides) throw new Error('ASSERT_FAIL:wpp_last_slide_no_overlap:no_presentation');\\n" +

      "var sc = 0;\\n" +

      "try { sc = Number(p.Slides.Count || 0); } catch (e2) { sc = 0 }\\n" +

      "if (sc <= 0) throw new Error('ASSERT_FAIL:wpp_last_slide_no_overlap:no_slides');\\n" +

      "var s = null; try { s = p.Slides.Item(sc); } catch (e3) { s = null }\\n" +

      "if (!s || !s.Shapes) throw new Error('ASSERT_FAIL:wpp_last_slide_no_overlap:no_shapes');\\n" +

      "var c = 0;\\n" +

      "try { c = Number(s.Shapes.Count || 0); } catch (e4) { c = 0 }\\n" +

      "var rects = [];\\n" +

      "for (var i = 1; i <= c; i++) {\\n" +

      "  var x = null; try { x = s.Shapes.Item(i); } catch (e5) { x = null }\\n" +

      "  if (!x) continue;\\n" +

      "  var alt = '';\\n" +

      "  try { alt = String(x.AlternativeText || ''); } catch (e6) { alt = '' }\\n" +

      "  if (alt && alt.indexOf('AH32_BLOCKID:') >= 0) continue;\\n" +

      "  var l = 0, t = 0, w = 0, h2 = 0;\\n" +

      "  try { l = Number(x.Left || 0); } catch (e7) { l = 0 }\\n" +

      "  try { t = Number(x.Top || 0); } catch (e8) { t = 0 }\\n" +

      "  try { w = Number(x.Width || 0); } catch (e9) { w = 0 }\\n" +

      "  try { h2 = Number(x.Height || 0); } catch (e10) { h2 = 0 }\\n" +

      "  if (!isFinite(l) || !isFinite(t) || !isFinite(w) || !isFinite(h2)) continue;\\n" +

      "  if (w < 4 || h2 < 4) continue;\\n" +

      "  rects.push({ i: i, l: l, t: t, r: l + w, b: t + h2 });\\n" +

      "}\\n" +

      "function _over(a, b) {\\n" +

      "  var x1 = Math.max(a.l, b.l);\\n" +

      "  var y1 = Math.max(a.t, b.t);\\n" +

      "  var x2 = Math.min(a.r, b.r);\\n" +

      "  var y2 = Math.min(a.b, b.b);\\n" +

      "  return (x2 - x1) > 2 && (y2 - y1) > 2;\\n" +

      "}\\n" +

      "for (var a = 0; a < rects.length; a++) {\\n" +

      "  for (var b = a + 1; b < rects.length; b++) {\\n" +

      "    if (_over(rects[a], rects[b])) {\\n" +

      "      throw new Error('ASSERT_FAIL:wpp_last_slide_no_overlap:overlap:i=' + rects[a].i + ' j=' + rects[b].i);\\n" +

      "    }\\n" +

      "  }\\n" +

      "}\\n" +

      "true;"

    )

  }

  return null

}



const evalTurnAsserts = async (args: {

  host: MacroBenchHost

  expectedOutput?: 'plan' | 'text' | 'either'

  assistantText?: string

  hasCode: boolean

  execOk: boolean

  asserts?: ChatBenchAssert[]

  blockId?: string | null

  appliedSkills?: Array<{ id?: string; name?: string }>

  selectedSkills?: Array<{ id?: string; name?: string }>

  repairsUsed?: number

}): Promise<BenchAssertEval> => {

  const failures: BenchAssertFailure[] = []

  let totalPoints = 0

  let passedPoints = 0



  const add = (ok: boolean, type: string, points: number, message: string) => {

    totalPoints += points

    if (ok) passedPoints += points

    else failures.push({ type, points, message })

  }



  const expected = (args.expectedOutput || 'plan') as 'plan' | 'text' | 'either'
  const assistantText = stripCodeFences(args.assistantText || '')

  if (expected === 'plan') {
    add(!!args.hasCode, 'has_plan_block', 1, args.hasCode ? 'ok' : 'no_plan_block')
    add(!!args.execOk, 'plan_exec_success', 1, args.execOk ? 'ok' : 'exec_failed')
  } else if (expected === 'text') {
    add(!args.hasCode, 'no_plan_block', 1, !args.hasCode ? 'ok' : 'unexpected_plan_block')
  } else {
    // either: only require execution success when a plan exists.
    if (args.hasCode) add(!!args.execOk, 'plan_exec_success', 1, args.execOk ? 'ok' : 'exec_failed')
  }



  const extra = Array.isArray(args.asserts) ? args.asserts : []

  for (const a of extra) {

    const pts = assertPoints(a, 1)

    if (a.type === 'assistant_text_contains') {
      const needle = String((a as any).text || '')
      add(assistantText.includes(needle), a.type, pts, assistantText.includes(needle) ? 'ok' : `missing:${needle}`)
      continue
    }
    if (a.type === 'assistant_text_not_contains') {
      const needle = String((a as any).text || '')
      add(!assistantText.includes(needle), a.type, pts, !assistantText.includes(needle) ? 'ok' : `unexpected:${needle}`)
      continue
    }
    if (a.type === 'assistant_text_matches') {
      const pattern = String((a as any).pattern || '')
      const flags = String((a as any).flags || '')
      let ok = false
      let msg = ''
      try {
        ok = new RegExp(pattern, flags).test(assistantText)
        msg = ok ? 'ok' : `no_match:/${pattern}/${flags}`
      } catch (e: any) {
        ok = false
        msg = `invalid_regex:${String(e?.message || e)}`
      }
      add(ok, a.type, pts, msg)
      continue
    }
    if (a.type === 'skills_selected_includes' || a.type === 'skills_selected_excludes') {
      const want = String((a as any).skillId || '').trim()
      const ids = (() => {
        try {
          const xs = Array.isArray(args.selectedSkills) ? args.selectedSkills : []
          return xs.map(x => String((x as any)?.id || '').trim()).filter(x => !!x)
        } catch (e) {
          return []
        }
      })()
      if (a.type === 'skills_selected_includes') {
        const ok = !!want && ids.includes(want)
        add(ok, a.type, pts, ok ? 'ok' : `missing:${want || '(empty)'} got=${ids.join(',') || '(none)'}`)
      } else {
        const ok = !!want && !ids.includes(want)
        add(ok, a.type, pts, ok ? 'ok' : `unexpected:${want || '(empty)'} got=${ids.join(',') || '(none)'}`)
      }
      continue
    }
    if (a.type === 'skills_applied_includes') {
      const want = String((a as any).skillId || '').trim()
      const ids = (() => {
        try {
          const xs = Array.isArray(args.appliedSkills) ? args.appliedSkills : []
          return xs.map(x => String((x as any)?.id || '').trim()).filter(x => !!x)
        } catch (e) {
          return []
        }
      })()
      const ok = !!want && ids.includes(want)
      add(ok, a.type, pts, ok ? 'ok' : `missing:${want || '(empty)'} got=${ids.join(',') || '(none)'}`)
      continue
    }

    if (a.type === 'repairs_used_at_least') {
      const min = Math.max(0, Number((a as any).min ?? 0) || 0)
      const used = Math.max(0, Number(args.repairsUsed ?? 0) || 0)
      const ok = used >= min
      add(ok, a.type, pts, ok ? 'ok' : `repairs_used=${used} < ${min}`)
      continue
    }

    if (!args.execOk) {

      add(false, a.type, pts, 'not_evaluated:exec_failed')

      continue

    }

    const script = buildAssertScript(args.host, a, args.blockId)

    if (!script) {

      add(false, a.type, pts, 'not_evaluated:unsupported_or_wrong_host')

      continue

    }

    const r = await runAssertScript(script)

    add(!!r.ok, a.type, pts, r.ok ? 'ok' : (r.message || 'assert_failed'))

  }



  const score = totalPoints > 0 ? Math.round((passedPoints / totalPoints) * 100) : 100

  return { totalPoints, passedPoints, ok: failures.length === 0, score, failures }

}



export const runChatBenchCurrentHost = async (chatStore: ChatStoreLike, opts: {

  suiteId: MacroBenchSuiteId | 'all'

  preset: MacroBenchPreset

  shouldStop?: () => boolean
  signal?: AbortSignal

  onProgress?: (p: { idx: number; total: number; storyName: string; turnName: string; host: MacroBenchHost; suiteId: MacroBenchSuiteId }) => void

  onResult?: (r: ChatBenchTurnResult) => void

  // Optional: continue a previous run (checkpoint).

  resumeFrom?: ChatBenchRun

  // Long-run guards.

  maxHours?: number

  maxTurns?: number

  maxFailures?: number

  // Budget is enforced on best-effort token usage (SSE done.token_usage).

  maxCost?: number

  trimMessagesKeepLast?: number

  chatTimeoutMs?: number

}): Promise<ChatBenchRun> => {

  const host = (wpsBridge.getHostApp() || 'wps') as MacroBenchHost

  const suiteId = opts.suiteId || 'all'

  const preset = opts.preset || 'standard'

  const shouldStopNow = () => {
    try { if (opts.shouldStop?.()) return true } catch (_e) {}
    try { if (opts.signal?.aborted) return true } catch (_e) {}
    return false
  }

  const resumed = opts.resumeFrom || null

  const startedAt = resumed?.startedAt || nowIso()

  const runId = resumed?.runId || `bench_chat_run_${host}_${Date.now()}`



  // Chat session id stays stable across turns to exercise memory like a real user.

  const chatSessionId =

    resumed?.chatSessionId ||

    resumed?.results?.[0]?.chatSessionId ||

    `bench_chat_${host}_${suiteId}_${Date.now()}`



  // Keep bench observable but avoid polluting user workspace: start from a clean chat view.

  // IMPORTANT: `chatStore.messages` only reflects the currently visible session bucket.

  // Ensure we are on the bench session before clearing; otherwise the first turn can fail to

  // locate the assistant message even when chat succeeded.

  try { await (chatStore as any).switchToSession?.(chatSessionId, { bindToActiveDocument: true }) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }

  try { chatStore.clearMessages?.() } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }



  const stories = buildChatBenchStories({ host, suiteId, preset })

  const storyInfos = stories.map(s => ({ id: s.id, suiteId: s.suiteId, host: s.host, name: s.name }))



  // Flatten turns in deterministic order.

  const items: Array<{ story: ChatBenchStory; turn: ChatBenchTurn }> = []

  for (const s of stories) {

    for (const t of s.turns) items.push({ story: s, turn: t })

  }

  const totalPlanned = items.length



  // Best-effort: ensure a fresh bench document once per story (setupActions).

  let benchDocId: string | null = null
  const docAliases: Record<string, { id: string; name: string; fullPath?: string; hostApp?: string }> = {}
  const macroQueueJobs: Record<string, { messageId: string; blockId: string; docAlias: string }> = {}

  const ensureBenchDoc = async (title?: string) => {

    const t = String(title || '').trim()

    const script = (() => {

      if (host === 'wps') {

        return (

          "var app = window.Application;\\n" +

          "try { var d = (app.Documents && app.Documents.Add) ? app.Documents.Add() : null; } catch (e) {}\\n" +

          "try { if (d && d.Activate) d.Activate(); } catch (e2) {}\\n" +

          (t ? `try { if (d) d.Name = '${t.replace(/'/g, "\\'")}'; } catch (e3) {}` : '') +

          "\\ntrue;"

        )

      }

      if (host === 'et') {

        return (

          "var app = window.Application;\\n" +

          "try { var wb = (app.Workbooks && app.Workbooks.Add) ? app.Workbooks.Add() : null; } catch (e) {}\\n" +

          "try { if (wb && wb.Activate) wb.Activate(); } catch (e2) {}\\n" +

          "\\ntrue;"

        )

      }

      if (host === 'wpp') {

        return (

          "var app = window.Application;\\n" +

          "try { var p = (app.Presentations && app.Presentations.Add) ? app.Presentations.Add() : null; } catch (e) {}\\n" +

          "try { if (p && p.Windows && p.Windows.Item) { var w = p.Windows.Item(1); if (w && w.Activate) w.Activate(); } } catch (e2) {}\\n" +

          "\\ntrue;"

        )

      }

      return "true;"

    })()



    try {

      const r = await jsMacroExecutor.executeJS(script, true)

      if (!r?.success) return

      // Capture active doc id after creation.

      try {

        const docs = wpsBridge.getAllOpenDocuments()

        const active = docs.find(d => d.isActive)

        benchDocId = active?.id || null

      } catch (e) {

        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)

      }

    } catch (e) {

      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)

    }

  }

  const createNewDocument = async (title?: string) => {
    const t = String(title || '').trim()
    const script = (() => {
      if (host === 'wps') {
        return (
          "var app = window.Application;\\n" +
          "try { var d = (app.Documents && app.Documents.Add) ? app.Documents.Add() : null; } catch (e) {}\\n" +
          "try { if (d && d.Activate) d.Activate(); } catch (e2) {}\\n" +
          (t ? `try { if (d) d.Name = '${t.replace(/'/g, "\\'")}'; } catch (e3) {}` : '') +
          "\\ntrue;"
        )
      }
      if (host === 'et') {
        return (
          "var app = window.Application;\\n" +
          "try { var wb = (app.Workbooks && app.Workbooks.Add) ? app.Workbooks.Add() : null; } catch (e) {}\\n" +
          "try { if (wb && wb.Activate) wb.Activate(); } catch (e2) {}\\n" +
          "\\ntrue;"
        )
      }
      if (host === 'wpp') {
        return (
          "var app = window.Application;\\n" +
          "try { var p = (app.Presentations && app.Presentations.Add) ? app.Presentations.Add() : null; } catch (e) {}\\n" +
          "try { if (p && p.Windows && p.Windows.Item) { var w = p.Windows.Item(1); if (w && w.Activate) w.Activate(); } } catch (e2) {}\\n" +
          "\\ntrue;"
        )
      }
      return "true;"
    })()

    try {
      const r = await jsMacroExecutor.executeJS(script, true)
      if (!r?.success) return null
      try {
        const docs = wpsBridge.getAllOpenDocuments()
        const active = docs.find(d => d.isActive)
        if (!active?.id) return null
        return { id: String(active.id), name: String(active.name || ''), fullPath: String((active as any).fullPath || ''), hostApp: String((active as any).hostApp || '') }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
        return null
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
      return null
    }
  }

  const ensureDocumentAlias = async (alias: string, title?: string) => {
    const key = String(alias || '').trim()
    if (!key) throw new Error('document_alias_required')
    const info = await createNewDocument(title)
    if (!info?.id) throw new Error(`document_alias_create_failed:${key}`)
    docAliases[key] = info
  }

  const activateDocumentAlias = async (alias: string) => {
    const key = String(alias || '').trim()
    if (!key) throw new Error('document_alias_required')
    const info = docAliases[key]
    if (!info?.id) throw new Error(`document_alias_missing:${key}`)
    try { wpsBridge.activateDocumentById(String(info.id)) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }
  }



  const applyAction = async (a: ChatBenchAction) => {

    if (!a) return

    if (a.type === 'sleep') {

      await sleep(Math.max(0, Number(a.ms || 0) || 0))

      return

    }

    if (a.type === 'toggle_show_thoughts') {
      // Runtime config is .env-only; keep this action as a no-op for compatibility.
      return

    }

    if (a.type === 'require_host') {

      const want = String((a as any).host || '').trim()

      if (!want) return

      if (String(host) !== want) {

        throw new Error(`require_host_failed: need=${want} got=${host}`)

      }

      return

    }

    if (a.type === 'find_text') {

      if (host !== 'wps') return

      const needle = String(a.text || '').trim()

      if (!needle) return

      const lit = JSON.stringify(needle)

      const script = (

        "var app = window.Application;\\n" +

        `var needle = ${lit};\\n` +

        "try {\\n" +

        "  if (typeof BID !== 'undefined' && BID && BID.findTextRange) {\\n" +

        "    var r = null;\\n" +

        "    try { r = BID.findTextRange(String(needle)); } catch (e1) { r = null }\\n" +

        "    try { if (r && r.Select) r.Select(); } catch (e2) {}\\n" +

        "    true;\\n" +

        "  }\\n" +

        "} catch (e0) {}\\n" +

        "try {\\n" +

        "  var doc = app.ActiveDocument;\\n" +

        "  var range = doc.Range();\\n" +

        "  var f = range.Find;\\n" +

        "  f.Text = String(needle);\\n" +

        "  f.Forward = true;\\n" +

        "  var ok = false;\\n" +

        "  try { ok = !!f.Execute(); } catch (e3) { ok = false }\\n" +

        "  if (!ok) throw new Error('find_text:not_found:' + String(needle));\\n" +

        "  try { range.Select(); } catch (e4) {}\\n" +

        "} catch (e5) {}\\n" +

        "true;"

      )

      try { await jsMacroExecutor.executeJS(script, true) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }

      return

    }

    if (a.type === 'ensure_bench_document') {

      await ensureBenchDoc(a.title)

      return

    }

    if (a.type === 'activate_bench_document') {

      if (benchDocId) {

        try { wpsBridge.activateDocumentById(benchDocId) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }

        return

      }

      // If we don't have a bench doc (e.g. resume after reload), create one on-demand.

      await ensureBenchDoc()

      return

    }

    if (a.type === 'create_document_alias') {

      await ensureDocumentAlias((a as any).alias, (a as any).title)

      return

    }

    if (a.type === 'activate_document_alias') {

      await activateDocumentAlias((a as any).alias)

      return

    }

    if (a.type === 'enqueue_macro_queue_job') {

      const jobAlias = String((a as any).jobAlias || '').trim()
      const docAlias = String((a as any).docAlias || '').trim()
      const blockId = String((a as any).blockId || '').trim()
      const planObj = (a as any).plan
      if (!jobAlias) throw new Error('macro_queue_job_alias_required')
      if (!docAlias) throw new Error(`macro_queue_doc_alias_required:${jobAlias}`)
      if (!blockId) throw new Error(`macro_queue_block_id_required:${jobAlias}`)
      if (!planObj || typeof planObj !== 'object' || Array.isArray(planObj)) throw new Error(`macro_queue_plan_required:${jobAlias}`)

      const doc = docAliases[docAlias]
      if (!doc?.id) throw new Error(`macro_queue_document_alias_missing:${docAlias}`)

      let code = ''
      try { code = JSON.stringify(planObj) } catch (e: any) { code = ''; throw new Error(`macro_queue_plan_stringify_failed:${String(e?.message || e)}`) }
      if (!code) throw new Error(`macro_queue_plan_stringify_empty:${jobAlias}`)

      const messageId = `bench_macro_queue_msg_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
      const dc = {
        docId: String(doc.id),
        docKey: String(doc.id),
        name: String(doc.name || ''),
        path: String(doc.fullPath || ''),
        hostApp: String(doc.hostApp || host || '')
      }
      const assistantMsg: any = {
        id: messageId,
        type: 'assistant',
        content: '',
        metadata: {
          docContext: dc,
          macroBlockPayloads: { [blockId]: code },
        },
      }

      const enqueue = (chatStore as any).enqueueWritebackForAssistantMessage
      if (typeof enqueue !== 'function') throw new Error('macro_queue_enqueue_not_supported:missing_enqueueWritebackForAssistantMessage')
      enqueue(assistantMsg, null, { excludeConfirm: true })

      macroQueueJobs[jobAlias] = { messageId, blockId, docAlias }

      return

    }

    if (a.type === 'wait_macro_queue_job') {

      const jobAlias = String((a as any).jobAlias || '').trim()
      const timeoutMs = Math.max(0, Number((a as any).timeoutMs || 0) || 0) || 45000
      if (!jobAlias) throw new Error('macro_queue_job_alias_required')
      const job = macroQueueJobs[jobAlias]
      if (!job?.messageId || !job?.blockId) throw new Error(`macro_queue_job_missing:${jobAlias}`)
      const getRun = (chatStore as any).getMacroBlockRun
      if (typeof getRun !== 'function') throw new Error('macro_queue_wait_not_supported:missing_getMacroBlockRun')

      const deadline = Date.now() + timeoutMs
      while (true) {
        if (Date.now() > deadline) throw new Error(`macro_queue_job_timeout:${jobAlias}`)
        const r = getRun(job.messageId, job.blockId)
        const st = String(r?.status || '').trim()
        if (st === 'success') return
        if (st === 'error') {
          const err = String(r?.error || 'macro_queue_job_error')
          throw new Error(`macro_queue_job_error:${jobAlias}:${err}`)
        }
        await sleep(120)
      }

    }

    if (a.type === 'dev_skills_patch_meta') {

      const tid = String((a as any).tenantId || 'public').trim() || 'public'
      const skillId = String((a as any).skillId || '').trim()
      if (!skillId) throw new Error('dev_skills_skill_id_required')

      const payload: any = { skill_id: skillId }
      if (typeof (a as any).enabled === 'boolean') payload.enabled = (a as any).enabled
      if (Number.isFinite(Number((a as any).priority))) payload.priority = Number((a as any).priority)
      if (typeof (a as any).name === 'string') payload.name = String((a as any).name || '').trim()

      const cfg = getRuntimeConfig()
      const resp = await fetch(`${cfg.apiBase}/dev/skills/patch_meta`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AH32-Tenant-Id': tid,
        },
        body: JSON.stringify(payload),
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        if (resp.status === 404) throw new Error('dev_routes_not_enabled:AH32_ENABLE_DEV_ROUTES=true')
        throw new Error(`dev_skills_patch_meta_failed:${resp.status}:${text.slice(0, 400)}`)
      }
      return

    }

    if (a.type === 'dev_skills_assert_primary_by_priority') {

      const tid = String((a as any).tenantId || 'public').trim() || 'public'
      const allow = Array.isArray((a as any).allowSkillIds) ? (a as any).allowSkillIds : []
      const expected = String((a as any).expectedPrimarySkillId || '').trim()
      if (!expected) throw new Error('dev_skills_expected_primary_required')

      const cfg = getRuntimeConfig()
      const resp = await fetch(`${cfg.apiBase}/dev/skills/primary_by_priority`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AH32-Tenant-Id': tid,
        },
        body: JSON.stringify({ allow_skill_ids: allow }),
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        if (resp.status === 404) throw new Error('dev_routes_not_enabled:AH32_ENABLE_DEV_ROUTES=true')
        throw new Error(`dev_skills_primary_by_priority_failed:${resp.status}:${text.slice(0, 400)}`)
      }
      const data: any = await resp.json().catch(() => null)
      const got = String(data?.primary_skill_id || '').trim()
      if (got !== expected) {
        throw new Error(`dev_skills_primary_mismatch:expected=${expected} got=${got || '(empty)'}`)
      }
      return

    }

    if (a.type === 'dev_skills_assert_meta') {

      const tid = String((a as any).tenantId || 'public').trim() || 'public'
      const skillId = String((a as any).skillId || '').trim()
      if (!skillId) throw new Error('dev_skills_skill_id_required')

      const cfg = getRuntimeConfig()
      const resp = await fetch(`${cfg.apiBase}/dev/skills/list`, {
        method: 'GET',
        headers: { 'X-AH32-Tenant-Id': tid },
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        if (resp.status === 404) throw new Error('dev_routes_not_enabled:AH32_ENABLE_DEV_ROUTES=true')
        throw new Error(`dev_skills_list_failed:${resp.status}:${text.slice(0, 400)}`)
      }
      const data: any = await resp.json().catch(() => null)
      const skills: any[] = Array.isArray(data?.skills) ? data.skills : []
      const s = skills.find(x => String(x?.id || '').trim() === skillId) || null
      if (!s) throw new Error(`dev_skills_skill_missing:${skillId}`)

      if (typeof (a as any).enabled === 'boolean') {
        const want = (a as any).enabled
        const got = !!s.enabled
        if (got !== want) throw new Error(`dev_skills_enabled_mismatch:${skillId}:expected=${want} got=${got}`)
      }
      const pr = Number(s?.priority ?? 0) || 0
      if (Number.isFinite(Number((a as any).minPriority))) {
        const min = Number((a as any).minPriority)
        if (pr < min) throw new Error(`dev_skills_priority_too_low:${skillId}:${pr} < ${min}`)
      }
      if (Number.isFinite(Number((a as any).maxPriority))) {
        const max = Number((a as any).maxPriority)
        if (pr > max) throw new Error(`dev_skills_priority_too_high:${skillId}:${pr} > ${max}`)
      }
      const nc = String((a as any).nameContains || '').trim()
      if (nc) {
        const name = String(s?.name || '')
        if (!name.includes(nc)) throw new Error(`dev_skills_name_missing:${skillId}:missing=${nc}`)
      }

      return

    }

    if (a.type === 'select_all') {

      const script = (() => {

        if (host === 'wps') {

          return (

            "var app = window.Application;\\n" +

            "try { if (app.Selection && app.Selection.WholeStory) { app.Selection.WholeStory(); } } catch (e) {}\\n" +

            "try { if (app.ActiveDocument && app.ActiveDocument.Content && app.ActiveDocument.Content.Select) { app.ActiveDocument.Content.Select(); } } catch (e2) {}\\n" +

            "true;"

          )

        }

        if (host === 'et') {

          return (

            "var app = window.Application;\\n" +

            "try { var sh = app.ActiveSheet; } catch (e) { sh = null }\\n" +

            "try { if (sh && sh.UsedRange && sh.UsedRange.Select) { sh.UsedRange.Select(); } } catch (e2) {}\\n" +

            "try { if (sh && sh.Cells && sh.Cells.Select) { sh.Cells.Select(); } } catch (e3) {}\\n" +

            "true;"

          )

        }

        if (host === 'wpp') {

          return (

            "var app = window.Application;\\n" +

            "try { var p = app.ActivePresentation || (app.Presentations ? app.Presentations.Item(1) : null); } catch (e) { p = null }\\n" +

            "try { if (p && p.Slides && p.Slides.Count >= 1) { p.Slides.Item(p.Slides.Count).Select(); } } catch (e2) {}\\n" +

            "true;"

          )

        }

        return 'true;'

      })()

      try { await jsMacroExecutor.executeJS(script, true) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }

      return

    }

    if (a.type === 'clear_document') {

      const script = (() => {

        if (host === 'wps') {

          return (

            "var app = window.Application;\\n" +

            "var doc = null; try { doc = app.ActiveDocument; } catch (e) {}\\n" +

            "try { if (doc && doc.Content) { doc.Content.Text = ''; } } catch (e2) {}\\n" +

            "try { if (app.Selection && app.Selection.WholeStory) { app.Selection.WholeStory(); app.Selection.Delete(); } } catch (e3) {}\\n" +

            "true;"

          )

        }

        if (host === 'et') {

          return (

            "var app = window.Application;\\n" +

            "var sh = null; try { sh = app.ActiveSheet; } catch (e) {}\\n" +

            "try { if (sh && sh.UsedRange && sh.UsedRange.Clear) { sh.UsedRange.Clear(); } } catch (e2) {}\\n" +

            "try { if (sh && sh.Cells && sh.Cells.Clear) { sh.Cells.Clear(); } } catch (e3) {}\\n" +

            "true;"

          )

        }

        if (host === 'wpp') {

          return (

            "var app = window.Application;\\n" +

            "var p = null; try { p = app.ActivePresentation || (app.Presentations ? app.Presentations.Item(1) : null); } catch (e) {}\\n" +

            "try { if (p && p.Slides) { while (p.Slides.Count > 0) { try { p.Slides.Item(1).Delete(); } catch (e2) { break } } } } catch (e3) {}\\n" +

            "true;"

          )

        }

        return 'true;'

      })()

      try { await jsMacroExecutor.executeJS(script, true) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }

      return

    }

    if (a.type === 'insert_text') {

      const text = String(a.text || '')

      const newline = a.newline !== false

      const lit = JSON.stringify(text)

      const script = (() => {

        if (host === 'wps') {

          return (

            "var app = window.Application;\\n" +

            `var t = ${lit};\\n` +

            "try { if (app.Selection && app.Selection.Range) { app.Selection.Range.Text = String(t); } } catch (e) {}\\n" +

            (newline ? "try { if (app.Selection && app.Selection.TypeParagraph) app.Selection.TypeParagraph(); } catch (e2) {}\\n" : '') +

            "true;"

          )

        }

        if (host === 'et') {

          return (

            "var app = window.Application;\\n" +

            `var t = ${lit};\\n` +

            "try { if (app.ActiveCell) { app.ActiveCell.Value = String(t); } } catch (e) {}\\n" +

            "true;"

          )

        }

        return 'true;'

      })()

      try { await jsMacroExecutor.executeJS(script, true) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }

      return

    }

    if (a.type === 'ensure_sheet') {

      const name = String(a.name || '').trim() || 'Sheet1'

      const lit = JSON.stringify(name)

      const script = (

        "var app = window.Application;\\n" +

        `var target = ${lit};\\n` +

        "var wb = null; try { wb = app.ActiveWorkbook || (app.Workbooks ? app.Workbooks.Item(1) : null); } catch (e) {}\\n" +

        "if (!wb || !wb.Worksheets) { true; } else {\\n" +

        "  var sh = null;\\n" +

        "  try { sh = wb.Worksheets.Item(target); } catch (e2) { sh = null }\\n" +

        "  if (!sh) {\\n" +

        "    try { sh = wb.Worksheets.Add(); } catch (e3) { sh = null }\\n" +

        "    try { if (sh) sh.Name = target; } catch (e4) {}\\n" +

        "  }\\n" +

        "  try { if (sh && sh.Activate) sh.Activate(); } catch (e5) {}\\n" +

        "  try { if (sh && sh.Range) sh.Range('A1').Select(); } catch (e6) {}\\n" +

        "}\\n" +

        "true;"

      )

      try { await jsMacroExecutor.executeJS(script, true) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }

      return

    }

    if (a.type === 'activate_sheet') {

      const name = String(a.name || '').trim() || 'Sheet1'

      const lit = JSON.stringify(name)

      const script = (

        "var app = window.Application;\\n" +

        `var target = ${lit};\\n` +

        "var wb = null; try { wb = app.ActiveWorkbook || (app.Workbooks ? app.Workbooks.Item(1) : null); } catch (e) {}\\n" +

        "var sh = null;\\n" +

        "try { if (wb && wb.Worksheets) sh = wb.Worksheets.Item(target); } catch (e2) { sh = null }\\n" +

        "try { if (sh && sh.Activate) sh.Activate(); } catch (e3) {}\\n" +

        "try { if (sh && sh.Range) sh.Range('A1').Select(); } catch (e4) {}\\n" +

        "true;"

      )

      try { await jsMacroExecutor.executeJS(script, true) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }

      return

    }

    if (a.type === 'select_range') {

      const a1 = String(a.a1 || '').trim() || 'A1'

      const lit = JSON.stringify(a1)

      const script = (

        "var app = window.Application;\\n" +

        `var addr = ${lit};\\n` +

        "try { if (app.ActiveSheet && app.ActiveSheet.Range) { app.ActiveSheet.Range(String(addr)).Select(); } } catch (e) {}\\n" +

        "true;"

      )

      try { await jsMacroExecutor.executeJS(script, true) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }

      return

    }

    if (a.type === 'ensure_slide') {

      const idx = Math.max(1, Number(a.index || 1) || 1)

      const script = (

        "var app = window.Application;\\n" +

        `var idx = ${idx};\\n` +

        "var p = null; try { p = app.ActivePresentation || (app.Presentations ? app.Presentations.Item(1) : null); } catch (e) { p = null }\\n" +

        "if (!p || !p.Slides) { true; } else {\\n" +

        "  try { while (p.Slides.Count < idx) { p.Slides.Add(p.Slides.Count + 1, 1); } } catch (e2) {}\\n" +

        "  try { p.Slides.Item(idx).Select(); } catch (e3) {}\\n" +

        "}\\n" +

        "true;"

      )

      try { await jsMacroExecutor.executeJS(script, true) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }

      return

    }

    if (a.type === 'select_slide') {

      const idx = Math.max(1, Number(a.index || 1) || 1)

      const script = (

        "var app = window.Application;\\n" +

        `var idx = ${idx};\\n` +

        "var p = null; try { p = app.ActivePresentation || (app.Presentations ? app.Presentations.Item(1) : null); } catch (e) { p = null }\\n" +

        "try { if (p && p.Slides && p.Slides.Count >= idx) { p.Slides.Item(idx).Select(); } } catch (e2) {}\\n" +

        "true;"

      )

      try { await jsMacroExecutor.executeJS(script, true) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }

      return

    }

    if (a.type === 'set_cursor') {

      const pos = a.pos

      const script = (() => {

        if (host === 'wps') {

          if (pos === 'end') return "var app = window.Application; try { app.Selection.EndOf(); } catch (e) {} true;"

          return "var app = window.Application; try { app.Selection.StartOf(); } catch (e) {} true;"

        }

        if (host === 'et') {

          if (pos === 'end') {

            return (

              "var app = window.Application;\\n" +

              "try { var sh = app.ActiveSheet; } catch (e) { sh = null }\\n" +

              "try { if (sh && sh.UsedRange) { var r = sh.UsedRange; var rr = r.Row + r.Rows.Count - 1; var cc = r.Column + r.Columns.Count - 1; sh.Cells(rr, cc).Select(); } } catch (e2) {}\\n" +

              "true;"

            )

          }

          return "var app = window.Application; try { app.ActiveSheet.Range('A1').Select(); } catch (e) {} true;"

        }

        return 'true;'

      })()

      try {

        await jsMacroExecutor.executeJS(script, true)

      } catch (e) {

        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)

      }

      return

    }

  }



  const applyActions = async (actions?: ChatBenchAction[]) => {

    if (!actions || !actions.length) return

    for (const a of actions) {

      if (shouldStopNow()) break

      await applyAction(a)

    }

  }



  const applyActionsToQuery = async (query: string, actions?: ChatBenchAction[]) => {

    let q = String(query || '')

    const ruleFiles: string[] = []

    let uiClickSend = false

    if (!actions || !actions.length) return { query: q, ruleFiles, uiClickSend }

    for (const a of actions) {

      if (!a) continue

      if (a.type === 'ui_fill_input') {

        q = String((a as any).text || '')

        continue

      }

      if (a.type === 'ui_click_send') {

        uiClickSend = true

        continue

      }

      if (a.type === 'prepend_query') {

        const t = String(a.text || '')

        q = t + q

        continue

      }

      if (a.type === 'append_query') {

        const t = String(a.text || '')

        if (!t) continue

        const nl = (a as any).newline === true

        q = q + (nl ? '\n' : '') + t

        continue

      }

      if (a.type === 'insert_at_reference') {

        const t = String((a as any).text || '').trim()

        if (!t) continue

        q = q + `\n\n@${t}`

        continue

      }

      if (a.type === 'attach_rule_files') {

        const ps = Array.isArray((a as any).paths) ? (a as any).paths : []

        for (const p of ps) {

          const s = String(p || '').trim()

          if (s) ruleFiles.push(s)

        }



      }

    }

    return { query: q, ruleFiles, uiClickSend }

  }



  const results: ChatBenchTurnResult[] = []

  // Resume: keep previous results and jump to nextIdx.

  if (resumed?.results?.length) {

    try { results.push(...resumed.results) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }

  }

  const startIdx = Math.max(0, Number(resumed?.nextIdx ?? results.length ?? 0) || 0)



  const maxHours = Number(opts.maxHours || 0) || 0

  const maxTurns = Number(opts.maxTurns || 0) || 0

  const maxFailures = Number(opts.maxFailures || 0) || 0

  const maxCost = Number(opts.maxCost || 0) || 0

  let totalTokens = 0

  const keepLast = Math.max(0, Number(opts.trimMessagesKeepLast || 0) || 0) || 120

  const chatTimeoutMs = Math.max(0, Number(opts.chatTimeoutMs || 0) || 0) || 15 * 60_000



  const meta = {

    ...(resumed?.meta || {}),

    bench: true,

    mode: 'chat',

    // NOTE: maxCost is enforced on best-effort token usage (total_tokens), not money.

    budgets: { maxHours, maxTurns, maxFailures, maxCost, maxCostUnit: 'tokens' },

    keepLastMessages: keepLast,

    chatTimeoutMs,

  }



  // If resuming, pre-accumulate best-effort token usage.

  try {

    for (const r of (results || [])) {

      const t = Number((r as any)?.tokenUsage?.total_tokens || 0) || 0

      if (t > 0) totalTokens += t

    }

  } catch (e) {

    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)

  }



  const trimMessages = async () => {

    if (!keepLast) return

    try { await (chatStore as any).switchToSession?.(chatSessionId, { bindToActiveDocument: true }) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }

    try {

      // Pinia setup stores unwrap refs on the store instance. Avoid `.value` here,

      // otherwise MacroBench will never see assistant messages and will mis-handle busy state.

      const arr: any[] = Array.isArray((chatStore as any).messages) ? ((chatStore as any).messages as any[]) : []

      if (arr.length <= keepLast) return

      // Keep the same array reference (it is a per-session bucket); splice in place.

      arr.splice(0, Math.max(0, arr.length - keepLast))

      // Hint for humans: don't silently "lose" UI content.

      try {

        ;(chatStore as any).addSystemMessage?.(`[Bench] 历史对话已截断，仅保留最近 ${keepLast} 条（完整结果请复制 JSON 报告）`)

      } catch (e) {

        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)

      }

    } catch (e) {

      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)

    }

  }



  const persistPartial = (run: ChatBenchRun) => {

    try { saveRun(run) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }

  }



  const waitForChatIdle = async (opts?: { timeoutMs?: number }) => {

    const timeoutMs = Math.max(0, Number(opts?.timeoutMs || 0) || 0) || 8000

    const deadline = Date.now() + timeoutMs

    // `sendMessage()` is a no-op when the chat store is already sending; bench must not silently proceed.

    while (Boolean((chatStore as any)?.isSending)) {

      if (Date.now() > deadline) {

        try { (chatStore as any).cancelCurrentRequest?.() } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }

        break

      }

      await sleep(80)

      }

  }



  const sendWithRetry = async (

    query: string,

    sessionId: string,

    opts: {

      disableShortcuts?: boolean

      ensureDocSync?: boolean

      frontendContextPatch?: Record<string, any>

      ruleFiles?: string[]

    },

    retries: number = 2

  ) => {

    let lastErr: any = null

    for (let i = 0; i <= retries; i++) {

      try {

        await (chatStore as any).sendMessage(query, sessionId, opts)

        return

      } catch (e: any) {

        const msg = String(e?.message || e || '')

        if (!msg.includes('chat_busy:session')) {

          throw e

        }

        lastErr = e

        await waitForChatIdle({ timeoutMs: 6000 })

        await sleep(500 + i * 300)

      }

    }

    throw lastErr || new Error('chat_busy')

  }



  for (let i = startIdx; i < items.length; i++) {

    if (shouldStopNow()) break

    if (maxTurns > 0) {

      if (results.length >= maxTurns) break

    }

    if (maxHours > 0) {

      const elapsedMs = Date.now() - Date.parse(startedAt)

      if (elapsedMs > maxHours * 3600_000) break

    }

    if (maxFailures > 0) {

      // Product decision: in unattended "customer-like" runs we keep going even when some turns fail.

      // `maxFailures` is treated as a soft budget (warn only), not a hard stop.

      const fails = results.filter(x => !x.ok).length

      if (fails >= maxFailures) {

        try { (chatStore as any).addSystemMessage?.(`[Bench] failure budget reached: ${fails}/${maxFailures} (continue)`) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }

      }

    }

    if (maxCost > 0) {

      if (totalTokens >= maxCost) break

    }

    const { story, turn } = items[i]

    const storyUsesDocAliases = (() => {
      try {
        const acts: any[] = []
        if (Array.isArray((story as any)?.setupActions)) acts.push(...((story as any).setupActions || []))
        if (Array.isArray((story as any)?.turns)) {
          for (const t of ((story as any).turns || [])) {
            if (Array.isArray((t as any)?.actionsBeforeSend)) acts.push(...((t as any).actionsBeforeSend || []))
            if (Array.isArray((t as any)?.actionsAfterExec)) acts.push(...((t as any).actionsAfterExec || []))
          }
        }
        return acts.some(x => {
          const tp = String((x as any)?.type || '').trim()
          return tp === 'create_document_alias'
            || tp === 'activate_document_alias'
            || tp === 'enqueue_macro_queue_job'
            || tp === 'wait_macro_queue_job'
        })
      } catch (e) {
        return false
      }
    })()

    const pinBenchDoc = !storyUsesDocAliases



    // Setup actions run once per story (on its first turn).

    if (turn === story.turns[0] && !results.some(r => r.story?.id === story.id)) {

      try {

        await applyActions(story.setupActions)

      } catch (e: any) {

        const msg = `setup_actions_failed: ${String(e?.message || e)}`

        let appliedSkills: any[] = []
        try {
          const v = (chatStore as any).appliedSkills
          appliedSkills = unwrapArrayRef(v)
        } catch (e2) {
          appliedSkills = []
        }
        let selectedSkills: any[] = []
        try {
          const v = (chatStore as any).selectedSkills
          selectedSkills = unwrapArrayRef(v)
        } catch (e3) {
          selectedSkills = []
        }
        const ae = await evalTurnAsserts({
          host,
          expectedOutput: (turn as any)?.expectedOutput,
          assistantText: '',
          hasCode: false,
          execOk: false,
          asserts: turn.asserts,
          appliedSkills,
          selectedSkills,
          repairsUsed: 0,
        })

        const r: ChatBenchTurnResult = {

          story: { id: story.id, suiteId: story.suiteId, host: story.host, name: story.name },

          turn,

          chatSessionId,

          macroSessionId: `bench_chat_${host}_${Date.now()}_${i + 1}`,

          documentName: getActiveDocName(),

          ok: false,

          assertOk: ae.ok,

          score: ae.score,

          assertTotalPoints: ae.totalPoints,

          assertPassedPoints: ae.passedPoints,

          assertFailures: ae.failures,

          chatMs: 0,

          execTotalMs: 0,

          attempts: 0,

          repairsUsed: 0,

          tokenUsage: undefined,

          message: msg,

          assistantMessageId: undefined,

          assistantPreview: '',

          codeBlocks: 0,

        }

        results.push(r)

        opts.onResult?.(r)

        persistPartial({

          runId,

          host,

          suiteId,

          preset,

          chatSessionId,

          startedAt,

          finishedAt: nowIso(),

          meta,

          stories: storyInfos,

          results,

          summary: computeSummary(host, suiteId, results),

          summaryBySuite: {},

          nextIdx: i + 1,

          totalPlanned,

        })

        continue

      }

    // Keep the bench doc active across the whole story (unless the story manages doc aliases).

    if (pinBenchDoc) await applyActions([{ type: 'activate_bench_document' }])

  }



    let queryToSend = String(turn.query || '')

    let ruleFilesForTurn: string[] = []

    let uiClickSendForTurn = false

    try {

      const applied = await applyActionsToQuery(queryToSend, turn.actionsBeforeSend)

      queryToSend = applied.query

      ruleFilesForTurn = applied.ruleFiles

      uiClickSendForTurn = !!(applied as any).uiClickSend

      await applyActions(turn.actionsBeforeSend)

    } catch (e: any) {

      const msg = `actions_before_send_failed: ${String(e?.message || e)}`

      let appliedSkills: any[] = []
      try {
        const v = (chatStore as any).appliedSkills
        appliedSkills = unwrapArrayRef(v)
      } catch (e2) {
        appliedSkills = []
      }
      let selectedSkills: any[] = []
      try {
        const v = (chatStore as any).selectedSkills
        selectedSkills = unwrapArrayRef(v)
      } catch (e3) {
        selectedSkills = []
      }
      const ae = await evalTurnAsserts({
        host,
        expectedOutput: (turn as any)?.expectedOutput,
        assistantText: '',
        hasCode: false,
        execOk: false,
        asserts: turn.asserts,
        appliedSkills,
        selectedSkills,
        repairsUsed: 0,
      })

      const r: ChatBenchTurnResult = {

        story: { id: story.id, suiteId: story.suiteId, host: story.host, name: story.name },

        turn,

        chatSessionId,

        macroSessionId: `bench_chat_${host}_${Date.now()}_${i + 1}`,

        documentName: getActiveDocName(),

        ok: false,

        assertOk: ae.ok,

        score: ae.score,

        assertTotalPoints: ae.totalPoints,

        assertPassedPoints: ae.passedPoints,

        assertFailures: ae.failures,

        chatMs: 0,

        execTotalMs: 0,

        attempts: 0,

        repairsUsed: 0,

        tokenUsage: undefined,

        message: msg,

        assistantMessageId: undefined,

        assistantPreview: '',

        codeBlocks: 0,

      }

      results.push(r)

      opts.onResult?.(r)

      persistPartial({

        runId,

        host,

        suiteId,

        preset,

        chatSessionId,

        startedAt,

        finishedAt: nowIso(),

        meta,

        stories: storyInfos,

        results,

        summary: computeSummary(host, suiteId, results),

        summaryBySuite: {},

        nextIdx: i + 1,

        totalPlanned,

      })

      continue

    }

    if (pinBenchDoc) await applyActions([{ type: 'activate_bench_document' }])



    opts.onProgress?.({ idx: i + 1, total: items.length, storyName: story.name, turnName: turn.name, host, suiteId: story.suiteId })

    const localOnly = !!(turn as any)?.localOnly
    if (localOnly) {

      let appliedSkills: any[] = []
      try { appliedSkills = unwrapArrayRef((chatStore as any).appliedSkills) } catch (e) { appliedSkills = [] }

      let selectedSkills: any[] = []
      try { selectedSkills = unwrapArrayRef((chatStore as any).selectedSkills) } catch (e) { selectedSkills = [] }

      const ae = await evalTurnAsserts({
        host,
        expectedOutput: ((turn as any)?.expectedOutput || 'either') as any,
        assistantText: '',
        hasCode: false,
        execOk: true,
        asserts: turn.asserts,
        appliedSkills,
        selectedSkills,
        repairsUsed: 0,
      })

      await applyActions(turn.actionsAfterExec)

      const r: ChatBenchTurnResult = {
        story: { id: story.id, suiteId: story.suiteId, host: story.host, name: story.name },
        turn,
        chatSessionId,
        macroSessionId: `bench_local_${host}_${Date.now()}_${i + 1}`,
        documentName: getActiveDocName(),
        ok: ae.ok,
        assertOk: ae.ok,
        score: ae.score,
        assertTotalPoints: ae.totalPoints,
        assertPassedPoints: ae.passedPoints,
        assertFailures: ae.failures,
        chatMs: 0,
        execTotalMs: 0,
        attempts: 0,
        repairsUsed: 0,
        tokenUsage: undefined,
        message: ae.ok ? 'local_only_ok' : 'local_only_assert_failed',
        assistantMessageId: undefined,
        assistantPreview: '',
        codeBlocks: 0,
      }

      results.push(r)
      opts.onResult?.(r)

      const summaryBySuite = (() => {
        const bySuite: Record<string, ChatBenchTurnResult[]> = {}
        for (const rr of results) {
          const sid = rr.story?.suiteId || 'unknown'
          if (!bySuite[sid]) bySuite[sid] = []
          bySuite[sid].push(rr)
        }
        const out: Record<string, ChatBenchSummary> = {}
        for (const sid of Object.keys(bySuite)) {
          out[sid] = computeSummary(host, sid as any, bySuite[sid])
        }
        return out
      })()

      const partial: ChatBenchRun = {
        runId,
        host,
        suiteId,
        preset,
        chatSessionId,
        startedAt,
        finishedAt: nowIso(),
        meta,
        stories: storyInfos,
        results,
        summary: computeSummary(host, suiteId, results),
        summaryBySuite,
        nextIdx: i + 1,
        totalPlanned,
      }

      persistPartial(partial)
      await trimMessages()
      continue

    }



    // 1) chat (real user path)

    // Ensure we are observing the correct session bucket (doc watcher may switch buckets).

    try { await (chatStore as any).switchToSession?.(chatSessionId, { bindToActiveDocument: true }) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }

    await waitForChatIdle()

    const beforeLen = Number(((chatStore as any).messages || []).length || 0) || 0

    const t0 = performance.now()

    let chatMs = 0

    let assistantMsg: any = null

    let tokenUsage: any = null

    try {

      const overridePlan = (turn as any)?.planOverride
      const hasOverridePlan =
        overridePlan && typeof overridePlan === 'object' && !Array.isArray(overridePlan)

      if (hasOverridePlan) {
        // System coverage: bypass chat and execute a deterministic plan.
        assistantMsg = null
        tokenUsage = null
        chatMs = 0
      } else if (uiClickSendForTurn) {

        try { (chatStore as any).addSystemMessage?.('[Bench] ui_click_send simulated: calling store.sendMessage(sessionId=...)') } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }

      }

      if (!hasOverridePlan) {
        await withTimeout(

          sendWithRetry(queryToSend, chatSessionId, {

            disableShortcuts: true,

            ensureDocSync: true,

            frontendContextPatch: {

              bench: true,

              bench_run: {

                runId,

                host,

                suite: story.suiteId,

                story: story.id,

                turn: turn.id,

              },

              style_spec: (turn as any)?.styleSpec || null,

              // Deterministic skill coverage (optional): force backend primary skill selection.
              ...(String((turn as any)?.forceSkillId || '').trim()
                ? {
                    client_skill_selection: {
                      explicit: true,
                      primary_skill_id: String((turn as any).forceSkillId || '').trim(),
                      primary_score: 1.0,
                      accept_threshold: 0.0,
                      candidates: [
                        {
                          id: String((turn as any).forceSkillId || '').trim(),
                          score: 1.0,
                        },
                      ],
                    },
                  }
                : {}),

            },

            ruleFiles: ruleFilesForTurn.length ? ruleFilesForTurn : undefined,

          }),

          chatTimeoutMs,

          'chat'

        )

        chatMs = Math.round(performance.now() - t0)

        try { tokenUsage = (chatStore as any).consumeLastTokenUsage?.() || null } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e); tokenUsage = null }

        try {

          const t = Number(tokenUsage?.total_tokens || 0) || 0

          if (t > 0) totalTokens += t

        } catch (e) {

          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)

        }



        // Re-select the bench session bucket after the send, in case the UI switched documents mid-stream.

        try { await (chatStore as any).switchToSession?.(chatSessionId, { bindToActiveDocument: true }) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }



        const bucketMsgs = (((chatStore as any).messages || []) as any[])

        const newMsgs = bucketMsgs.slice(beforeLen)

        assistantMsg = newMsgs.slice().reverse().find((m: any) => m && m.type === 'assistant') || null

        if (!assistantMsg) {

          // Fallback: avoid false negatives if trimming/switching happened unexpectedly.

          assistantMsg = bucketMsgs.slice().reverse().find((m: any) => m && m.type === 'assistant') || null

        }
        if (!assistantMsg) {

          throw new Error('chat_no_assistant_message')

        }
      }

    } catch (e: any) {

      // Best-effort: abort a hung stream so the queue can continue.

      try { (chatStore as any).cancelCurrentRequest?.() } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }

      const msg = `chat_failed: ${String(e?.message || e)}`

      let appliedSkills: any[] = []
      try {
        const v = (chatStore as any).appliedSkills
        appliedSkills = unwrapArrayRef(v)
      } catch (e2) {
        appliedSkills = []
      }
      let selectedSkills: any[] = []
      try {
        const v = (chatStore as any).selectedSkills
        selectedSkills = unwrapArrayRef(v)
      } catch (e3) {
        selectedSkills = []
      }
      const ae = await evalTurnAsserts({
        host,
        expectedOutput: (turn as any)?.expectedOutput,
        assistantText: '',
        hasCode: false,
        execOk: false,
        asserts: turn.asserts,
        appliedSkills,
        selectedSkills,
        repairsUsed: 0,
      })

      const r: ChatBenchTurnResult = {

        story: { id: story.id, suiteId: story.suiteId, host: story.host, name: story.name },

        turn,

        chatSessionId,

        macroSessionId: `bench_chat_${host}_${Date.now()}_${i + 1}`,

        documentName: getActiveDocName(),

        ok: false,

        assertOk: ae.ok,

        score: ae.score,

        assertTotalPoints: ae.totalPoints,

        assertPassedPoints: ae.passedPoints,

        assertFailures: ae.failures,

        chatMs: Math.round(performance.now() - t0),

        execTotalMs: 0,

        attempts: 0,

        repairsUsed: 0,

        message: msg,

      }

      results.push(r)

      opts.onResult?.(r)

      void reportAuditEvent({

        session_id: r.macroSessionId,

        host_app: host,

        mode: 'chat',

        success: false,

        error_type: 'bench_chat_failed',

        error_message: msg,

        extra: { bench: true, suite: story.suiteId, story: story.id, turn: turn.id, phase: 'chat' },

      })

      const partial: ChatBenchRun = {

        runId,

        host,

        suiteId,

        preset,

        chatSessionId,

        startedAt,

        finishedAt: nowIso(),

        meta,

        stories: storyInfos,

        results,

        summary: computeSummary(host, suiteId, results),

        summaryBySuite: {},

        nextIdx: i + 1,

        totalPlanned,

      }

      persistPartial(partial)

      continue

    }



    // 2) extract plan blocks (or use deterministic override)
    const overridePlan = (turn as any)?.planOverride
    const hasOverridePlan = overridePlan && typeof overridePlan === 'object' && !Array.isArray(overridePlan)

    const expectedOutput = ((turn as any)?.expectedOutput || 'plan') as 'plan' | 'text' | 'either'
    const assistantContent = String(assistantMsg?.content || '')

    const blocks = hasOverridePlan ? [JSON.stringify(overridePlan)] : extractPlanBlocks(assistantMsg)

    let appliedSkills: any[] = []
    let selectedSkills: any[] = []
    if (!hasOverridePlan) {
      try {
        const v = (chatStore as any).appliedSkills
        appliedSkills = unwrapArrayRef(v)
      } catch (e) {
        appliedSkills = []
      }
      try {
        const v = (chatStore as any).selectedSkills
        selectedSkills = unwrapArrayRef(v)
      } catch (e) {
        selectedSkills = []
      }
    }

    if (!blocks.length && expectedOutput !== 'plan') {

      const msg = expectedOutput === 'text' ? 'text_ok' : 'chat_ok_text_fallback'

      const ae = await evalTurnAsserts({
        host,
        expectedOutput,
        assistantText: assistantContent,
        hasCode: false,
        execOk: false,
        asserts: turn.asserts,
        appliedSkills,
        selectedSkills,
        repairsUsed: 0,
      })

      await applyActions(turn.actionsAfterExec)

      const r: ChatBenchTurnResult = {
        story: { id: story.id, suiteId: story.suiteId, host: story.host, name: story.name },
        turn,
        chatSessionId,
        macroSessionId: `bench_chat_${host}_${Date.now()}_${i + 1}`,
        documentName: getActiveDocName(),
        ok: ae.ok,
        assertOk: ae.ok,
        score: ae.score,
        assertTotalPoints: ae.totalPoints,
        assertPassedPoints: ae.passedPoints,
        assertFailures: ae.failures,
        chatMs,
        execTotalMs: 0,
        attempts: 0,
        repairsUsed: 0,
        tokenUsage: tokenUsage || undefined,
        message: msg,
        assistantMessageId: assistantMsg?.id,
        assistantPreview: assistantMsg ? previewText(assistantMsg.content) : '',
        codeBlocks: 0,
      }

      results.push(r)
      opts.onResult?.(r)

      void reportAuditEvent({
        session_id: r.macroSessionId,
        host_app: host,
        mode: 'chat',
        success: r.ok,
        error_type: r.ok ? undefined : 'bench_text_assert_failed',
        error_message: r.ok ? undefined : msg,
        extra: { bench: true, suite: story.suiteId, story: story.id, turn: turn.id, phase: 'text' },
      })

      const partial: ChatBenchRun = {
        runId,
        host,
        suiteId,
        preset,
        chatSessionId,
        startedAt,
        finishedAt: nowIso(),
        meta,
        stories: storyInfos,
        results,
        summary: computeSummary(host, suiteId, results),
        summaryBySuite: {},
        nextIdx: i + 1,
        totalPlanned,
      }

      persistPartial(partial)
      await trimMessages()
      continue

    }

    if (!blocks.length && expectedOutput === 'plan') {

      const msg = 'chat_ok_but_no_plan_block'

      const ae = await evalTurnAsserts({
        host,
        expectedOutput,
        assistantText: assistantContent,
        hasCode: false,
        execOk: false,
        asserts: turn.asserts,
        appliedSkills,
        selectedSkills,
        repairsUsed: 0,
      })

      const r: ChatBenchTurnResult = {

        story: { id: story.id, suiteId: story.suiteId, host: story.host, name: story.name },

        turn,

        chatSessionId,

        macroSessionId: `bench_chat_${host}_${Date.now()}_${i + 1}`,

        documentName: getActiveDocName(),

        ok: false,

        assertOk: ae.ok,

        score: ae.score,

        assertTotalPoints: ae.totalPoints,

        assertPassedPoints: ae.passedPoints,

        assertFailures: ae.failures,

        chatMs,

        execTotalMs: 0,

        attempts: 0,

        repairsUsed: 0,

        tokenUsage: tokenUsage || undefined,

        message: msg,

        assistantMessageId: assistantMsg?.id,

        assistantPreview: assistantMsg ? previewText(assistantMsg.content) : '',

        codeBlocks: 0,

      }

      results.push(r)

      opts.onResult?.(r)

      void reportAuditEvent({

        session_id: r.macroSessionId,

        host_app: host,

        mode: 'chat',

        success: false,

        error_type: 'bench_no_plan',

        error_message: msg,

        extra: { bench: true, suite: story.suiteId, story: story.id, turn: turn.id, phase: 'extract' },

      })



      // Checkpoint even on extract failures (long runs must be resumable).

      const partial: ChatBenchRun = {

        runId,

        host,

        suiteId,

        preset,

        chatSessionId,

        startedAt,

        finishedAt: nowIso(),

        meta,

        stories: storyInfos,

        results,

        summary: computeSummary(host, suiteId, results),

        summaryBySuite: {},

        nextIdx: i + 1,

        totalPlanned,

      }

      persistPartial(partial)

      await trimMessages()

      continue

    }



    if (blocks.length && expectedOutput === 'text') {

      const msg = 'unexpected_plan_block'

      const ae = await evalTurnAsserts({
        host,
        expectedOutput,
        assistantText: assistantContent,
        hasCode: true,
        execOk: false,
        asserts: turn.asserts,
        appliedSkills,
        selectedSkills,
        repairsUsed: 0,
      })

      await applyActions(turn.actionsAfterExec)

      const r: ChatBenchTurnResult = {
        story: { id: story.id, suiteId: story.suiteId, host: story.host, name: story.name },
        turn,
        chatSessionId,
        macroSessionId: `bench_chat_${host}_${Date.now()}_${i + 1}`,
        documentName: getActiveDocName(),
        ok: false,
        assertOk: ae.ok,
        score: ae.score,
        assertTotalPoints: ae.totalPoints,
        assertPassedPoints: ae.passedPoints,
        assertFailures: ae.failures,
        chatMs,
        execTotalMs: 0,
        attempts: 0,
        repairsUsed: 0,
        tokenUsage: tokenUsage || undefined,
        message: msg,
        assistantMessageId: assistantMsg?.id,
        assistantPreview: assistantMsg ? previewText(assistantMsg.content) : '',
        codeBlocks: blocks.length,
      }

      results.push(r)
      opts.onResult?.(r)

      void reportAuditEvent({
        session_id: r.macroSessionId,
        host_app: host,
        mode: 'chat',
        success: false,
        error_type: 'bench_unexpected_plan',
        error_message: msg,
        extra: { bench: true, suite: story.suiteId, story: story.id, turn: turn.id, phase: 'extract' },
      })

      const partial: ChatBenchRun = {
        runId,
        host,
        suiteId,
        preset,
        chatSessionId,
        startedAt,
        finishedAt: nowIso(),
        meta,
        stories: storyInfos,
        results,
        summary: computeSummary(host, suiteId, results),
        summaryBySuite: {},
        nextIdx: i + 1,
        totalPlanned,
      }

      persistPartial(partial)
      await trimMessages()
      continue

    }

    // 3) execute plan (real host runtime + repair loop)
    const rawPlan = blocks[0] || ""
    const docName = getActiveDocName()
    const macroSessionId = `bench_ui_${host}_${Date.now()}_${i + 1}`
    planClient.setContext(macroSessionId, docName, host)

    const stableId = normalizeBlockId(turn.artifactId || `bench_chat_${host}_${story.suiteId}_${story.id}_${turn.id}`)

    let planObj: any = null
    try {
      const parsed = parseJsonRelaxed(rawPlan, { maxChars: 900_000, allowRepair: true })
      planObj = parsed.ok ? parsed.value : null
    } catch (_e) {
      planObj = null
    }

    let ok = false
    let message = ""
    let execMs = 0
    let attempts = 0
    let repairsUsed = 0

    if (planObj) {
      const useSystemOps = hasOverridePlan
      let currentPlan = useSystemOps ? ensurePlanBlockIdForSystemOps(planObj, stableId) : ensurePlanBlockId(planObj, stableId)
      const maxAttempts = 3
      const t1 = performance.now()
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
          const repaired = await planClient.repairPlan(currentPlan, "exec_failed", message, attempts)
          if (!repaired.success || !repaired.plan) {
            if (repaired.error) message = String(repaired.error)
            break
          }
          currentPlan = useSystemOps ? ensurePlanBlockIdForSystemOps(repaired.plan, stableId) : ensurePlanBlockId(repaired.plan, stableId)
        } catch (e: any) {
          message = `plan_repair_failed: ${String(e?.message || e)}`
          break
        }
      }
      execMs = Math.round(performance.now() - t1)
      repairsUsed = attempts > 0 ? Math.max(0, attempts - 1) : 0
    } else {
      message = "invalid_plan_json"
    }

    const ae = await evalTurnAsserts({
      host,
      expectedOutput,
      assistantText: assistantContent,
      hasCode: true,
      execOk: ok,
      asserts: turn.asserts,
      blockId: stableId,
      appliedSkills,
      selectedSkills,
      repairsUsed,
    })
    await applyActions(turn.actionsAfterExec)

    // Persist per-block execution status so the chat UI renders it consistently.
    try {
      const msgId = String(assistantMsg?.id || "")
      if (msgId && chatStore.setMacroBlockRun) {
        chatStore.setMacroBlockRun(stableId, {
          status: ok ? "success" : "error",
          messageId: msgId,
          error: ok ? undefined : message,
          finalCode: rawPlan,
        })
      }
      if (msgId && ok && chatStore.markMacroMessageExecuted) chatStore.markMacroMessageExecuted(msgId)
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.("ah32-ui-next/src/dev/macro-bench-chat.ts", e)
    }

    const okFinal = !!ok && !!ae.ok
    if (ok && !ae.ok) {
      const head = String(ae.failures?.[0]?.type || "assert_failed")
      message = `exec_ok_but_assert_failed:${head}`
    }

    const r: ChatBenchTurnResult = {

      story: { id: story.id, suiteId: story.suiteId, host: story.host, name: story.name },

      turn,

      chatSessionId,

      macroSessionId,

      documentName: docName,

      ok: okFinal,

      assertOk: ae.ok,

      score: ae.score,

      assertTotalPoints: ae.totalPoints,

      assertPassedPoints: ae.passedPoints,

      assertFailures: ae.failures,

      chatMs,

      execTotalMs: execMs,

      attempts,

      repairsUsed,

      tokenUsage: tokenUsage || undefined,

      message,

      assistantMessageId: assistantMsg?.id,

      assistantPreview: assistantMsg ? previewText(assistantMsg.content) : '',

      codeBlocks: blocks.length,

    }

    results.push(r)

    opts.onResult?.(r)



    void reportAuditEvent({

      session_id: macroSessionId,

      host_app: host,

      mode: 'chat',

      success: r.ok,

      error_type: r.ok ? undefined : 'bench_exec_failed',

      error_message: r.ok ? undefined : message.slice(0, 800),

      extra: {

        bench: true,

        suite: story.suiteId,

        story: story.id,

        turn: turn.id,

        chat_ms: chatMs,

        exec_total_ms: execMs,

        attempts,

        repairs_used: repairsUsed,

        score: ae.score,

        assert_ok: ae.ok,

        assert_passed: ae.passedPoints,

        assert_total: ae.totalPoints,

      },

    })



    // Persist checkpoint after each turn (long runs).

    const summaryBySuite = (() => {

      const bySuite: Record<string, ChatBenchTurnResult[]> = {}

      for (const rr of results) {

        const sid = rr.story?.suiteId || 'unknown'

        if (!bySuite[sid]) bySuite[sid] = []

        bySuite[sid].push(rr)

      }

      const out: Record<string, ChatBenchSummary> = {}

      for (const sid of Object.keys(bySuite)) {

        out[sid] = computeSummary(host, sid as any, bySuite[sid])

      }

      return out

    })()

    const partial: ChatBenchRun = {

      runId,

      host,

      suiteId,

      preset,

      chatSessionId,

      startedAt,

      finishedAt: nowIso(),

      meta,

      stories: storyInfos,

      results,

      summary: computeSummary(host, suiteId, results),

      summaryBySuite,

      nextIdx: i + 1,

      totalPlanned,

    }

    persistPartial(partial)



    await trimMessages()



    // Soft stop if backend is clearly down to avoid spamming fetch failures.

    if (!ok && /Failed to fetch/i.test(message)) {

      try {

        const cfg = getRuntimeConfig()

        const resp = await fetch(`${cfg.apiBase}/health`)

        if (!resp.ok) break

      } catch (e) {

        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)

        break

      }

    }

  }



  const summaryBySuite = (() => {

    const bySuite: Record<string, ChatBenchTurnResult[]> = {}

    for (const r of results) {

      const sid = r.story?.suiteId || 'unknown'

      if (!bySuite[sid]) bySuite[sid] = []

      bySuite[sid].push(r)

    }

    const out: Record<string, ChatBenchSummary> = {}

    for (const sid of Object.keys(bySuite)) {

      out[sid] = computeSummary(host, sid as any, bySuite[sid])

    }

    return out

  })()



  try { (meta as any).totalTokens = totalTokens } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }



  const run: ChatBenchRun = {

    runId,

    host,

    suiteId,

    preset,

    chatSessionId,

    startedAt,

    finishedAt: nowIso(),

    meta,

    stories: storyInfos,

    results,

    summary: computeSummary(host, suiteId, results),

    summaryBySuite,

    nextIdx: results.length,

    totalPlanned,

  }

  saveRun(run)

  return run

}
