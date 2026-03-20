import { getRuntimeConfig } from '@/utils/runtime-config'
import { parseJsonRelaxed } from '@/utils/relaxed-json'

import { wpsBridge, WPSHelper } from '@/services/wps-bridge'

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

const unwrapMessagesRef = (v: any): any[] => {
  try {
    if (!v) return []
    const vv = (typeof v === 'object' && 'value' in v) ? (v as any).value : v
    return Array.isArray(vv) ? vv : []
  } catch (e) {
    return []
  }
}

const applyForcedSkillSelection = (turn: any, selectedSkills: any[]): any[] => {
  try {
    const forcedId = String(turn?.forceSkillId || '').trim()
    if (!forcedId) return Array.isArray(selectedSkills) ? selectedSkills : []
    const list = Array.isArray(selectedSkills) ? selectedSkills.slice() : []
    if (list.some((skill: any) => String(skill?.id || '').trim() === forcedId)) return list
    return [{ id: forcedId, name: forcedId, score: 1 }, ...list]
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
    return Array.isArray(selectedSkills) ? selectedSkills : []
  }
}

const previewText = (raw: any): string => {

  try {

    const s = String(raw || '').trim()

    if (!s) return ''

    const withoutCode = s.replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ').trim()

    const out = withoutCode || s

    return out.length > 140 ? out.slice(0, 140) + '...' : out

  } catch (e) {

    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)

    return ''

  }

}

const normalizeBenchSessionToken = (raw: any): string => {

  try {

    return String(raw || '')

      .trim()

      .replace(/[^a-zA-Z0-9_-]+/g, '_')

      .replace(/_+/g, '_')

      .replace(/^_+|_+$/g, '')

      .slice(0, 72) || 'story'

  } catch (e) {

    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)

    return 'story'

  }

}



const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const makeAbortError = () => {
  const err: any = new Error('aborted')
  err.name = 'AbortError'
  return err
}

const sleepAbortable = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => resolve(), ms)
  if (!signal) return
  if (signal.aborted) {
    clearTimeout(t)
    reject(makeAbortError())
    return
  }
  const onAbort = () => {
    try { clearTimeout(t) } catch (_e) {}
    try { signal.removeEventListener('abort', onAbort) } catch (_e) {}
    reject(makeAbortError())
  }
  try { signal.addEventListener('abort', onAbort, { once: true }) } catch (_e) {}
})



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

const hasWriterBlockBackupFallback = (blockId: string): boolean => {
  try {
    if (typeof localStorage === 'undefined') return false
    const id = String(blockId || '').trim()
    if (!id) return false
    for (let i = 0; i < localStorage.length; i++) {
      const key = String(localStorage.key(i) || '')
      if (!key.startsWith('__ah32:block_backup:')) continue
      if (!key.endsWith(`:${id}`)) continue
      const raw = localStorage.getItem(key)
      if (!raw) continue
      try {
        const payload: any = JSON.parse(raw)
        if (typeof payload?.text === 'string') return true
        if (Array.isArray(payload?.ops) && payload.ops.length > 0) return true
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
      }
    }
    return false
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
    return false
  }
}



const extractPlanBlocks = (assistantMsg: any): string[] => {
  const out: string[] = []

  const tryParsePlanJson = (raw: string): { ok: boolean; json?: string } => {
    let text = String(raw || '').trim()
    if (!text) return { ok: false }
    const normalizeParsedPlan = (parsedValue: any, fallbackText: string): { ok: boolean; json?: string } => {
      if (!parsedValue || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) return { ok: false }
      const schemaVersion = String(
        (parsedValue as any).schema_version
        || (parsedValue as any).schemaVersion
        || (parsedValue as any).schema
        || ''
      ).trim()
      if (schemaVersion !== 'ah32.plan.v1') return { ok: false }
      try {
        if (!(parsedValue as any).schema_version) (parsedValue as any).schema_version = schemaVersion
        // Re-serialize so we always execute strict JSON (and normalize any repaired control chars).
        return { ok: true, json: JSON.stringify(parsedValue) }
      } catch (_e) {
        return { ok: true, json: fallbackText }
      }
    }
    try {
      if (text.startsWith('```')) {
        text = text.replace(/^```[a-z0-9_.-]*\s*/i, '').replace(/```$/i, '').trim()
      }
      const nl = text.indexOf('\n')
      if (nl > 0 && nl <= 20) {
        const first = text.slice(0, nl).trim().toLowerCase()
        const rest = text.slice(nl + 1).trim()
        if ((first === 'json' || first === 'plan' || first.startsWith('ah32')) && rest.startsWith('{')) {
          text = rest
        }
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
    }
    const parsed = parseJsonRelaxed(text, { maxChars: 900_000, allowRepair: true })
    if (parsed.ok) return normalizeParsedPlan(parsed.value, text)
    const firstBrace = text.indexOf('{')
    const lastBrace = text.lastIndexOf('}')
    if (firstBrace < 0 || lastBrace <= firstBrace) return { ok: false }
    const sliced = text.slice(firstBrace, lastBrace + 1)
    const extracted = parseJsonRelaxed(sliced, { maxChars: 900_000, allowRepair: true })
    if (!extracted.ok) return { ok: false }
    return normalizeParsedPlan(extracted.value, sliced)
  }

  const extractBalancedJsonObjects = (text: string): string[] => {
    const objects: string[] = []
    const source = String(text || '')
    let objectStart = -1
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = 0; index < source.length; index++) {
      const char = source[index]
      if (objectStart < 0) {
        if (char === '{') {
          objectStart = index
          depth = 1
          inString = false
          escaped = false
        }
        continue
      }
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') {
        inString = true
        continue
      }
      if (char === '{') {
        depth += 1
        continue
      }
      if (char === '}') {
        depth -= 1
        if (depth === 0) {
          objects.push(source.slice(objectStart, index + 1))
          objectStart = -1
        }
      }
    }
    return objects
  }

  // Preferred: plan is delivered out-of-band via SSE `event: plan` and attached to message metadata.
  try {
    const payloads = assistantMsg?.metadata?.macroBlockPayloads
    if (payloads && typeof payloads === 'object' && !Array.isArray(payloads)) {
      for (const v of Object.values(payloads as any)) {
        const body = (typeof v === 'string' ? v : JSON.stringify(v || '')).trim()
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
  if (out.length === 0 && src.includes('ah32.plan.v1')) {
    for (const objectText of extractBalancedJsonObjects(src)) {
      const p = tryParsePlanJson(objectText)
      if (p.ok && p.json) {
        out.push(p.json)
        break
      }
    }
  }
  return out
}

const pickBenchAssistantMessage = (newMsgs: any[], bucketMsgs: any[]): any | null => {
  const score = (msg: any): number => {
    try {
      if (!msg || msg.type !== 'assistant') return -1_000_000
      let total = 0
      if (!(msg as any).isSystem) total += 1000
      const payloads = (msg as any)?.metadata?.macroBlockPayloads
      if (payloads && typeof payloads === 'object' && !Array.isArray(payloads) && Object.keys(payloads).length > 0) total += 800
      const content = String((msg as any)?.content || '').trim()
      if (content.includes('ah32.plan.v1')) total += 600
      if (content.startsWith('{') && content.endsWith('}')) total += 300
      if (content) total += 100
      if (content.includes('【需要补充写回计划】')) total -= 1200
      if (content.includes('【写回失败】')) total -= 1200
      if (content.includes('抱歉，本轮没有返回可展示的内容')) total -= 900
      if (content.includes('[Bench]')) total -= 600
      return total
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
      return -1_000_000
    }
  }

  const pick = (list: any[]): any | null => {
    let best: any = null
    let bestScore = -1_000_000
    for (let idx = list.length - 1; idx >= 0; idx--) {
      const item = list[idx]
      const s = score(item)
      if (s > bestScore) {
        best = item
        bestScore = s
      }
    }
    return best
  }

  const first = pick(Array.isArray(newMsgs) ? newMsgs : [])
  if (first) return first
  return pick(Array.isArray(bucketMsgs) ? bucketMsgs : [])
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

let chatBenchStatusRetryTimer: number | null = null
let chatBenchStatusPending:
  | { host: MacroBenchHost; payloadObj: Record<string, any>; attempt: number }
  | null = null

const writeChatBenchStatusToHostOnce = (host: MacroBenchHost, payloadObj: Record<string, any>): boolean => {
  try {
    const payload = JSON.stringify(payloadObj)
    return !!wpsBridge.runWithWpsApi(
      `macro-bench-chat:status:${host}`,
      () => {
        const app: any = wpsBridge.getApplication()
        if (host === 'wps') {
          const doc = app?.ActiveDocument || app?.Documents?.Item?.(1) || null
          const vars = doc?.Variables
          if (!vars) return false
          try {
            vars.Item('AH32_DEV_BENCH_STATUS').Value = payload
          } catch (_e) {
            vars.Add('AH32_DEV_BENCH_STATUS', payload)
          }
          return true
        }
        if (host === 'et') {
          const wb = app?.ActiveWorkbook || app?.Workbooks?.Item?.(1) || null
          if (!wb) return false
          let sheet = null as any
          try {
            sheet = wb.Worksheets?.Item?.('_AH32_DEV_STATUS') || null
          } catch (_e) {
            sheet = null
          }
          if (!sheet) {
            try {
              sheet = wb.Worksheets?.Add?.() || null
              if (sheet) {
                try { sheet.Name = '_AH32_DEV_STATUS' } catch (_e2) {}
              }
            } catch (_e3) {
              sheet = null
            }
          }
          if (!sheet) return false
          try { sheet.Visible = 0 } catch (_e4) {}
          const cell = sheet.Range?.('A1')
          if (!cell) return false
          try {
            cell.Value = payload
          } catch (_e5) {
            try { cell.Value2 = payload } catch (_e6) { return false }
          }
          try {
            const names = wb?.Names
            if (names) {
              try { names.Item('AH32_DEV_BENCH_STATUS').Delete() } catch (_e7) {}
            }
          } catch (_e8) {}
          return true
        }
        if (host === 'wpp') {
          const pres = app?.ActivePresentation || app?.Presentations?.Item?.(1) || null
          const tags = pres?.Tags
          if (!pres || !tags) return false
          try { tags.Delete('AH32_DEV_BENCH_STATUS') } catch (_e9) {}
          try {
            tags.Add('AH32_DEV_BENCH_STATUS', payload)
            return true
          } catch (_e10) {
            return false
          }
        }
        return false
      },
      false
    )
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
    return false
  }
}

const scheduleChatBenchStatusRetry = () => {
  try {
    if (chatBenchStatusRetryTimer !== null) return
    chatBenchStatusRetryTimer = window.setTimeout(() => {
      chatBenchStatusRetryTimer = null
      const pending = chatBenchStatusPending
      if (!pending) return
      const ok = writeChatBenchStatusToHostOnce(pending.host, pending.payloadObj)
      if (ok) {
        chatBenchStatusPending = null
        return
      }
      pending.attempt += 1
      if (pending.attempt < 30) scheduleChatBenchStatusRetry()
    }, 1000)
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
  }
}

const syncChatBenchStatusToHost = (host: MacroBenchHost, payloadObj: Record<string, any>): boolean => {
  chatBenchStatusPending = { host, payloadObj, attempt: 0 }
  const ok = writeChatBenchStatusToHostOnce(host, payloadObj)
  if (ok) {
    chatBenchStatusPending = null
    try {
      if (chatBenchStatusRetryTimer !== null) {
        window.clearTimeout(chatBenchStatusRetryTimer)
        chatBenchStatusRetryTimer = null
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
    }
    return true
  }
  scheduleChatBenchStatusRetry()
  return false
}

const countLocalPlanRepairs = (input: any): number => {
  let repairs = 0
  const walk = (actions: any[]) => {
    for (const action of actions || []) {
      if (!action || typeof action !== 'object') continue
      if (String((action as any).op || '') === 'upsert_block') {
        const hasActionsArray = Array.isArray((action as any).actions) && (action as any).actions.length > 0
        const hasLegacyContent =
          typeof (action as any).content === 'string' ||
          typeof (action as any).text === 'string' ||
          Array.isArray((action as any).content)
        if (!hasActionsArray && hasLegacyContent) repairs += 1
      }
      if (Array.isArray((action as any).actions)) walk((action as any).actions)
    }
  }
  try {
    if (input && typeof input === 'object' && Array.isArray((input as any).actions)) {
      walk((input as any).actions)
    }
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
  }
  return repairs
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



const runDirectAssert = async (
  host: MacroBenchHost,
  a: ChatBenchAssert,
  blockId?: string | null
): Promise<{ ok: boolean; message: string } | null> => {

  if (host !== 'wps' && host !== 'et' && host !== 'wpp') return null

  try {

    const type = String((a as any)?.type || '').trim()

    if (!type) return null

    const result = wpsBridge.runWithWpsApi(
      `bench.assert.${type}`,
      () => {
        const app = wpsBridge.getApplication()
        const bid = (window as any).BID || null
        const getWorkbook = () => {
          try {
            return app?.ActiveWorkbook || (app?.Workbooks ? app.Workbooks.Item(1) : null) || null
          } catch (_e) {
            return null
          }
        }
        const getSheet = () => {
          try {
            return app?.ActiveSheet || null
          } catch (_e) {
            return null
          }
        }
        const getPresentation = () => {
          try {
            return app?.ActivePresentation || (app?.Presentations ? app.Presentations.Item(1) : null) || null
          } catch (_e) {
            return null
          }
        }
        const getRange = (sheet: any, addr: string) => {
          try {
            if (!sheet?.Range) return null
            return sheet.Range(String(addr))
          } catch (_e) {
            return null
          }
        }
        const getChartObjectsCount = (sheet: any) => {
          let count = 0
          try { count = Number(sheet?.ChartObjects?.().Count || 0) } catch (_e) { count = 0 }
          if (count > 0) return count
          try { count = Number(sheet?.ChartObjects?.Count || 0) } catch (_e) { count = 0 }
          return count
        }
        const getChartObjectAt = (sheet: any, index: number) => {
          try {
            const direct = sheet?.ChartObjects?.(index)
            if (direct) return direct
          } catch (_e) {}
          try {
            const collection = sheet?.ChartObjects?.()
            const item = collection?.Item?.(index)
            if (item) return item
          } catch (_e) {}
          try {
            return sheet?.ChartObjects?.Item?.(index) || null
          } catch (_e) {
            return null
          }
        }
        const getSlideCount = (pres: any) => {
          try {
            return Number(pres?.Slides?.Count || 0)
          } catch (_e) {
            return 0
          }
        }
        const getLastSlide = (pres: any) => {
          const count = getSlideCount(pres)
          if (count <= 0) return null
          try {
            return pres.Slides.Item(count)
          } catch (_e) {
            return null
          }
        }
        const getShapeCount = (slide: any) => {
          try {
            return Number(slide?.Shapes?.Count || 0)
          } catch (_e) {
            return 0
          }
        }
        const getShapeText = (shape: any) => {
          let text = ''
          try {
            if (shape?.TextFrame && shape.TextFrame.HasText && shape.TextFrame.TextRange) {
              text = String(shape.TextFrame.TextRange.Text || '')
            }
          } catch (_e) {
            text = ''
          }
          return text
        }
        const getPlaceholderType = (shape: any) => {
          try {
            return Number(shape?.PlaceholderFormat?.PlaceholderType ?? -1)
          } catch (_e) {
            return -1
          }
        }
        const isBenchBlockShape = (shape: any) => {
          let alt = ''
          try { alt = String(shape?.AlternativeText || '') } catch (_e) { alt = '' }
          return alt.indexOf('AH32_BLOCKID:') >= 0
        }

        if (host === 'wps') {
          const doc = app?.ActiveDocument || null
          if (!doc) return { ok: false, message: `ASSERT_FAIL:${type}:no_document` }

          if (type === 'writer_text_contains') {
            const needle = String((a as any)?.text || '')
            let txt = ''
            try { txt = String(doc?.Content?.Text || '') } catch (_e) { txt = '' }
            return txt.indexOf(needle) >= 0
              ? { ok: true, message: 'ok' }
              : { ok: false, message: `ASSERT_FAIL:${type}:not_found:${needle}` }
          }

          if (type === 'writer_text_not_contains') {
            const needle = String((a as any)?.text || '')
            let txt = ''
            try { txt = String(doc?.Content?.Text || '') } catch (_e) { txt = '' }
            return txt.indexOf(needle) === -1
              ? { ok: true, message: 'ok' }
              : { ok: false, message: `ASSERT_FAIL:${type}:found:${needle}` }
          }

          if (type === 'writer_table_exists') {
            const minRows = Math.max(1, Number((a as any)?.minRows || 1) || 1)
            const minCols = Math.max(1, Number((a as any)?.minCols || 1) || 1)
            let t: any = null
            try {
              if (doc?.Tables && Number(doc.Tables.Count || 0) >= 1) t = doc.Tables.Item(1)
            } catch (_e) {
              t = null
            }
            if (!t) return { ok: false, message: 'ASSERT_FAIL:writer_table_exists:no_table' }
            let rows = 0
            let cols = 0
            try {
              rows = Number(t?.Rows?.Count || 0)
              cols = Number(t?.Columns?.Count || 0)
            } catch (_e) {
              rows = 0
              cols = 0
            }
            if (rows < minRows) return { ok: false, message: `ASSERT_FAIL:writer_table_exists:rows<${minRows} got ${rows}` }
            if (cols < minCols) return { ok: false, message: `ASSERT_FAIL:writer_table_exists:cols<${minCols} got ${cols}` }
            return { ok: true, message: 'ok' }
          }

          if (type === 'writer_table_header_bold') {
            let t: any = null
            try {
              if (doc?.Tables && Number(doc.Tables.Count || 0) >= 1) t = doc.Tables.Item(1)
            } catch (_e) {
              t = null
            }
            if (!t) return { ok: false, message: 'ASSERT_FAIL:writer_table_header_bold:no_table' }
            let b = 0
            try { b = Number(t?.Rows?.Item(1)?.Range?.Font?.Bold || 0) } catch (_e) { b = 0 }
            return b === 0
              ? { ok: false, message: 'ASSERT_FAIL:writer_table_header_bold:header_not_bold' }
              : { ok: true, message: 'ok' }
          }

          if (type === 'writer_heading_at_least') {
            const level = Math.max(1, Math.min(3, Number((a as any)?.level || 1) || 1))
            const min = Math.max(1, Number((a as any)?.min || 1) || 1)
            let c = 0
            try {
              const total = Number(doc?.Paragraphs?.Count || 0)
              for (let i = 1; i <= total; i++) {
                let p: any = null
                try { p = doc.Paragraphs.Item(i) } catch (_e) { p = null }
                if (!p) continue
                let name = ''
                try { name = String(p?.Range?.Style ? (p.Range.Style.NameLocal || p.Range.Style.Name || '') : '') } catch (_e) { name = '' }
                if (name.indexOf(`\u6807\u9898 ${level}`) !== -1 || name.indexOf(`Heading ${level}`) !== -1) {
                  c += 1
                  continue
                }
                try {
                  const ol = Number(p?.OutlineLevel || 0)
                  if (ol === level) c += 1
                } catch (_e) {}
              }
            } catch (_e) {
              c = 0
            }
            return c >= min
              ? { ok: true, message: 'ok' }
              : { ok: false, message: `ASSERT_FAIL:writer_heading_at_least:count<${min} got ${c}` }
          }

          if (type === 'writer_shapes_at_least') {
            const min = Math.max(0, Number((a as any)?.min || 0) || 0)
            let c = 0
            try { c += Number(doc?.Shapes?.Count || 0) } catch (_e) {}
            try { c += Number(doc?.InlineShapes?.Count || 0) } catch (_e) {}
            return c >= min
              ? { ok: true, message: 'ok' }
              : { ok: false, message: `ASSERT_FAIL:writer_shapes_at_least:count<${min} got ${c}` }
          }

          if (type === 'writer_block_backup_exists') {
            const id = String((a as any)?.blockId || (a as any)?.block_id || blockId || '').trim()
            if (!id) return { ok: false, message: 'ASSERT_FAIL:writer_block_backup_exists:no_block_id' }
            if (!bid || typeof bid.hasBlockBackup !== 'function') {
              return hasWriterBlockBackupFallback(id)
                ? { ok: true, message: 'ok' }
                : { ok: false, message: 'ASSERT_FAIL:writer_block_backup_exists:no_BID_hasBlockBackup' }
            }
            let ok = false
            try { ok = !!bid.hasBlockBackup(id) } catch (_e) { ok = false }
            return ok
              ? { ok: true, message: 'ok' }
              : { ok: false, message: `ASSERT_FAIL:writer_block_backup_exists:not_found:${id}` }
          }
        }

        if (host === 'et') {
          const wb = getWorkbook()
          const sh = getSheet()

          if (type === 'et_sheet_exists') {
            const target = String((a as any)?.name || '')
            if (!wb?.Worksheets) return { ok: false, message: 'ASSERT_FAIL:et_sheet_exists:no_workbook' }
            let ok = false
            try {
              const total = Number(wb.Worksheets.Count || 0)
              for (let i = 1; i <= total; i++) {
                let sheet: any = null
                try { sheet = wb.Worksheets.Item(i) } catch (_e) { sheet = null }
                if (sheet && String(sheet.Name || '') === target) {
                  ok = true
                  break
                }
              }
            } catch (_e) {
              ok = false
            }
            return ok
              ? { ok: true, message: 'ok' }
              : { ok: false, message: `ASSERT_FAIL:et_sheet_exists:not_found:${target}` }
          }

          if (type === 'et_chart_exists') {
            const min = Math.max(1, Number((a as any)?.min || 1) || 1)
            const count = getChartObjectsCount(sh)
            return count >= min
              ? { ok: true, message: 'ok' }
              : { ok: false, message: `ASSERT_FAIL:et_chart_exists:count<${min} got ${count}` }
          }

          if (type === 'et_chart_has_title') {
            const count = getChartObjectsCount(sh)
            if (count <= 0) return { ok: false, message: 'ASSERT_FAIL:et_chart_has_title:no_chart' }
            const chartObj = getChartObjectAt(sh, 1)
            const chart = chartObj?.Chart || null
            if (!chart) return { ok: false, message: 'ASSERT_FAIL:et_chart_has_title:no_chart_obj' }
            let ok = false
            try { ok = !!chart.HasTitle } catch (_e) { ok = false }
            return ok
              ? { ok: true, message: 'ok' }
              : { ok: false, message: 'ASSERT_FAIL:et_chart_has_title:missing' }
          }

          if (type === 'et_freeze_panes_enabled') {
            let ok = false
            try { ok = !!(app?.ActiveWindow && app.ActiveWindow.FreezePanes) } catch (_e) { ok = false }
            return ok
              ? { ok: true, message: 'ok' }
              : { ok: false, message: 'ASSERT_FAIL:et_freeze_panes_enabled:not_enabled' }
          }

          if (type === 'et_cell_number_format_not_general') {
            const addr = String((a as any)?.a1 || 'A1')
            if (!sh?.Range) return { ok: false, message: 'ASSERT_FAIL:et_cell_number_format_not_general:no_sheet' }
            const range = getRange(sh, addr)
            if (!range) return { ok: false, message: `ASSERT_FAIL:et_cell_number_format_not_general:no_range:${addr}` }
            let nf = ''
            try { nf = String(range.NumberFormat || '') } catch (_e) { nf = '' }
            return nf && nf.toLowerCase() !== 'general'
              ? { ok: true, message: 'ok' }
              : { ok: false, message: `ASSERT_FAIL:et_cell_number_format_not_general:general:${addr}` }
          }

          if (type === 'et_range_conditional_formats_at_least') {
            const addr = String((a as any)?.a1 || 'A1')
            const min = Math.max(0, Number((a as any)?.min || 0) || 0)
            if (!sh?.Range) return { ok: false, message: 'ASSERT_FAIL:et_range_conditional_formats_at_least:no_sheet' }
            const range = getRange(sh, addr)
            if (!range) return { ok: false, message: `ASSERT_FAIL:et_range_conditional_formats_at_least:no_range:${addr}` }
            let count = 0
            try { count = Number(range?.FormatConditions?.Count || 0) } catch (_e) { count = 0 }
            return count >= min
              ? { ok: true, message: 'ok' }
              : { ok: false, message: `ASSERT_FAIL:et_range_conditional_formats_at_least:count<${min} got ${count}` }
          }
        }

        if (host === 'wpp') {
          const pres = getPresentation()

          if (type === 'wpp_slide_count_at_least') {
            if (!pres?.Slides) return { ok: false, message: 'ASSERT_FAIL:wpp_slide_count_at_least:no_presentation' }
            const min = Math.max(1, Number((a as any)?.min || 1) || 1)
            const count = getSlideCount(pres)
            return count >= min
              ? { ok: true, message: 'ok' }
              : { ok: false, message: `ASSERT_FAIL:wpp_slide_count_at_least:count<${min} got ${count}` }
          }

          if (type === 'wpp_last_slide_shapes_at_least') {
            if (!pres?.Slides) return { ok: false, message: 'ASSERT_FAIL:wpp_last_slide_shapes_at_least:no_presentation' }
            const min = Math.max(1, Number((a as any)?.min || 1) || 1)
            const slide = getLastSlide(pres)
            if (!slide) return { ok: false, message: 'ASSERT_FAIL:wpp_last_slide_shapes_at_least:no_slides' }
            const count = getShapeCount(slide)
            return count >= min
              ? { ok: true, message: 'ok' }
              : { ok: false, message: `ASSERT_FAIL:wpp_last_slide_shapes_at_least:shapes<${min} got ${count}` }
          }

          if (type === 'wpp_slide_text_contains') {
            const needle = String((a as any)?.text || '').trim()
            const anySlide = (a as any)?.anySlide === true
            if (!needle) return { ok: false, message: 'ASSERT_FAIL:wpp_slide_text_contains:empty' }
            if (!pres?.Slides) return { ok: false, message: 'ASSERT_FAIL:wpp_slide_text_contains:no_presentation' }
            const slidesToCheck: any[] = []
            if (anySlide) {
              const slideCount = getSlideCount(pres)
              for (let si = 1; si <= slideCount; si++) {
                let slide: any = null
                try { slide = pres.Slides.Item(si) } catch (_e) { slide = null }
                if (slide) slidesToCheck.push(slide)
              }
              if (!slidesToCheck.length) return { ok: false, message: 'ASSERT_FAIL:wpp_slide_text_contains:no_slides' }
            } else {
              const slide = getLastSlide(pres)
              if (!slide) return { ok: false, message: 'ASSERT_FAIL:wpp_slide_text_contains:no_last_slide' }
              slidesToCheck.push(slide)
            }
            let found = false
            for (const slide of slidesToCheck) {
              const count = getShapeCount(slide)
              for (let i = 1; i <= count; i++) {
                let shape: any = null
                try { shape = slide.Shapes.Item(i) } catch (_e) { shape = null }
                if (!shape) continue
                const text = getShapeText(shape)
                if (text && text.indexOf(needle) >= 0) {
                  found = true
                  break
                }
              }
              if (found) break
            }
            return found
              ? { ok: true, message: 'ok' }
              : { ok: false, message: `ASSERT_FAIL:wpp_slide_text_contains:missing:${needle}` }
          }

          if (type === 'wpp_placeholder_text_contains') {
            const kind = String((a as any)?.kind || 'body').trim().toLowerCase()
            const needle = String((a as any)?.text || '').trim()
            const index = Math.max(1, Number((a as any)?.index || 1) || 1)
            if (!needle) return { ok: false, message: 'ASSERT_FAIL:wpp_placeholder_text_contains:empty' }
            if (!pres?.Slides) return { ok: false, message: 'ASSERT_FAIL:wpp_placeholder_text_contains:no_presentation' }
            const slide = getLastSlide(pres)
            if (!slide) return { ok: false, message: 'ASSERT_FAIL:wpp_placeholder_text_contains:no_last_slide' }
            const typeMap: Record<string, number> = { title: 1, body: 2, subtitle: 4 }
            const placeholderType = Object.prototype.hasOwnProperty.call(typeMap, kind) ? typeMap[kind] : null
            if (placeholderType == null) {
              return { ok: false, message: `ASSERT_FAIL:wpp_placeholder_text_contains:bad_kind:${kind}` }
            }
            let target: any = null
            try {
              if (kind === 'title') target = slide?.Shapes?.Title || null
            } catch (_e) {
              target = null
            }
            if (!target) {
              const candidates: any[] = []
              const count = getShapeCount(slide)
              for (let i = 1; i <= count; i++) {
                let shape: any = null
                try { shape = slide.Shapes.Item(i) } catch (_e) { shape = null }
                if (!shape) continue
                if (getPlaceholderType(shape) === placeholderType) candidates.push(shape)
              }
              if (candidates.length >= 1) {
                target = candidates[Math.min(candidates.length - 1, index - 1)] || candidates[0] || null
              }
            }
            if (!target) {
              return { ok: false, message: `ASSERT_FAIL:wpp_placeholder_text_contains:no_placeholder:kind=${kind}:idx=${index}` }
            }
            const text = getShapeText(target)
            return text.indexOf(needle) >= 0
              ? { ok: true, message: 'ok' }
              : { ok: false, message: `ASSERT_FAIL:wpp_placeholder_text_contains:missing:${needle}` }
          }

          if (type === 'wpp_last_slide_within_bounds') {
            if (!pres?.Slides) return { ok: false, message: 'ASSERT_FAIL:wpp_last_slide_within_bounds:no_presentation' }
            const slide = getLastSlide(pres)
            if (!slide?.Shapes) return { ok: false, message: 'ASSERT_FAIL:wpp_last_slide_within_bounds:no_shapes' }
            const margin = Math.max(0, Number((a as any)?.margin || 0) || 0)
            let sw = 960
            let sh = 540
            try {
              if (pres?.PageSetup) {
                sw = Number(pres.PageSetup.SlideWidth || sw)
                sh = Number(pres.PageSetup.SlideHeight || sh)
              }
            } catch (_e) {}
            const count = getShapeCount(slide)
            for (let i = 1; i <= count; i++) {
              let shape: any = null
              try { shape = slide.Shapes.Item(i) } catch (_e) { shape = null }
              if (!shape || isBenchBlockShape(shape)) continue
              const placeholderType = getPlaceholderType(shape)
              const shapeText = getShapeText(shape).trim()
              let shapeName = ''
              try { shapeName = String(shape?.Name || '').trim().toLowerCase() } catch (_e) { shapeName = '' }
              if (!shapeText) continue
              const looksLikeEmptyPlaceholder =
                (
                  placeholderType >= 0 ||
                  shapeName.includes('placeholder') ||
                  shapeName.includes('占位符')
                )
              if (looksLikeEmptyPlaceholder) continue
              let left = 0
              let top = 0
              let width = 0
              let height = 0
              try { left = Number(shape.Left || 0) } catch (_e) { left = 0 }
              try { top = Number(shape.Top || 0) } catch (_e) { top = 0 }
              try { width = Number(shape.Width || 0) } catch (_e) { width = 0 }
              try { height = Number(shape.Height || 0) } catch (_e) { height = 0 }
              if (!isFinite(left) || !isFinite(top) || !isFinite(width) || !isFinite(height)) continue
              if (width < 2 || height < 2) continue
              const right = left + width
              const bottom = top + height
              if (left < (0 - margin) || top < (0 - margin) || right > (sw + margin) || bottom > (sh + margin)) {
                return {
                  ok: false,
                  message: `ASSERT_FAIL:wpp_last_slide_within_bounds:out_of_bounds:left=${left},top=${top},right=${right},bottom=${bottom},sw=${sw},sh=${sh}`
                }
              }
            }
            return { ok: true, message: 'ok' }
          }

          if (type === 'wpp_last_slide_no_overlap') {
            if (!pres?.Slides) return { ok: false, message: 'ASSERT_FAIL:wpp_last_slide_no_overlap:no_presentation' }
            const slide = getLastSlide(pres)
            if (!slide?.Shapes) return { ok: false, message: 'ASSERT_FAIL:wpp_last_slide_no_overlap:no_shapes' }
            const rects: Array<{ i: number; l: number; t: number; r: number; b: number }> = []
            const count = getShapeCount(slide)
            for (let i = 1; i <= count; i++) {
              let shape: any = null
              try { shape = slide.Shapes.Item(i) } catch (_e) { shape = null }
              if (!shape || isBenchBlockShape(shape)) continue
              let left = 0
              let top = 0
              let width = 0
              let height = 0
              try { left = Number(shape.Left || 0) } catch (_e) { left = 0 }
              try { top = Number(shape.Top || 0) } catch (_e) { top = 0 }
              try { width = Number(shape.Width || 0) } catch (_e) { width = 0 }
              try { height = Number(shape.Height || 0) } catch (_e) { height = 0 }
              if (!isFinite(left) || !isFinite(top) || !isFinite(width) || !isFinite(height)) continue
              if (width < 4 || height < 4) continue
              rects.push({ i, l: left, t: top, r: left + width, b: top + height })
            }
            const overlap = (lhs: { l: number; t: number; r: number; b: number }, rhs: { l: number; t: number; r: number; b: number }) => {
              const x1 = Math.max(lhs.l, rhs.l)
              const y1 = Math.max(lhs.t, rhs.t)
              const x2 = Math.min(lhs.r, rhs.r)
              const y2 = Math.min(lhs.b, rhs.b)
              return (x2 - x1) > 2 && (y2 - y1) > 2
            }
            for (let i = 0; i < rects.length; i++) {
              for (let j = i + 1; j < rects.length; j++) {
                if (overlap(rects[i], rects[j])) {
                  return {
                    ok: false,
                    message: `ASSERT_FAIL:wpp_last_slide_no_overlap:overlap:i=${rects[i].i} j=${rects[j].i}`
                  }
                }
              }
            }
            return { ok: true, message: 'ok' }
          }
        }

        return null as any
      },
      null as any
    )

    if (result && typeof result === 'object' && 'ok' in result) {
      return {
        ok: !!(result as any).ok,
        message: String((result as any).message || ((result as any).ok ? 'ok' : 'assert_failed'))
      }
    }

    return null

  } catch (e: any) {

    return { ok: false, message: String(e?.message || e || 'assert_failed') }

  }

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

  onAssertStart?: (info: { type: string }) => void

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
    try { args.onAssertStart?.({ type: String((a as any)?.type || '') }) } catch (e) { ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }

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

    const direct = await runDirectAssert(args.host, a, args.blockId)

    if (direct) {

      add(!!direct.ok, a.type, pts, direct.ok ? 'ok' : (direct.message || 'assert_failed'))

      continue

    }

    add(false, a.type, pts, 'not_evaluated:unsupported_or_wrong_host')

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

  onStage?: (p: {
    stage: string
    host: MacroBenchHost
    suiteId: MacroBenchSuiteId | 'all'
    runId: string
    chatSessionId: string
    storyId?: string
    storyName?: string
    turnId?: string
    turnName?: string
    idx?: number
    total?: number
  }) => void

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

  const pushStage = (stage: string, extra?: Record<string, any>) => {
    try {
      opts.onStage?.({
        stage,
        host,
        suiteId,
        runId,
        chatSessionId,
        ...(extra || {}),
      })
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
    }
    try {
      const info = { ...(extra || {}) }
      const progress =
        typeof info.idx === 'number' && typeof info.total === 'number'
          ? {
              idx: Number(info.idx),
              total: Number(info.total),
              storyName: String(info.storyName || ''),
              turnName: String(info.turnName || ''),
              host,
              suiteId,
            }
          : undefined
      pushHostBenchStatus('running', {
        progress,
        detailStage: {
          stage,
          host,
          suiteId,
          runId,
          chatSessionId,
          ...(info || {}),
        },
      })
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
    }
  }

  const pushHostBenchStatus = (stage: string, extra?: Record<string, any>) => {
    try {
      syncChatBenchStatusToHost(host, {
        stage,
        runMode: 'chat',
        suiteId,
        preset,
        running: stage !== 'done' && stage !== 'error' && stage !== 'stopped',
        stopped: stage === 'stopped',
        at: nowIso(),
        ...(extra || {}),
      })
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
    }
  }



  // Keep bench observable but avoid polluting user workspace: start from a clean chat view.

  // IMPORTANT: `chatStore.messages` only reflects the currently visible session bucket.

  // Ensure we are on the bench session before clearing; otherwise the first turn can fail to

  // locate the assistant message even when chat succeeded.

  pushStage('init_switch_session')
  try {
    await withTimeout(
      Promise.resolve((chatStore as any).switchToSession?.(chatSessionId, { bindToActiveDocument: true })),
      2000,
      'bench_init_switch_session'
    )
  } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }

  pushStage('init_clear_messages')
  try { chatStore.clearMessages?.() } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }



  const stories = buildChatBenchStories({ host, suiteId, preset })

  const storyInfos = stories.map(s => ({ id: s.id, suiteId: s.suiteId, host: s.host, name: s.name }))

  const storySessionIds: Record<string, string> = {}

  try {

    for (const rr of (resumed?.results || [])) {

      const storyId = String((rr as any)?.story?.id || '').trim()

      const storyChatSessionId = String((rr as any)?.chatSessionId || '').trim()

      if (storyId && storyChatSessionId) storySessionIds[storyId] = storyChatSessionId

    }

  } catch (e) {

    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)

  }

  const getStoryChatSessionId = (story: Pick<ChatBenchStory, 'id'>): string => {

    const storyId = String(story?.id || '').trim()

    if (!storyId) return chatSessionId

    if (!storySessionIds[storyId]) {

      storySessionIds[storyId] = `${chatSessionId}__${normalizeBenchSessionToken(storyId)}`

    }

    return storySessionIds[storyId]

  }

  let activeChatSessionId = chatSessionId



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
  const BENCH_PUBLIC_DOCS_DIR = 'C:\\Users\\Public\\Documents'
  const sanitizeBenchTitle = (raw?: string) =>
    String(raw || 'ah32_bench')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'ah32_bench'
  const benchFileExt = host === 'wps' ? 'docx' : host === 'et' ? 'xlsx' : host === 'wpp' ? 'pptx' : ''
  const buildBenchSavePath = (title?: string) => {
    const base = sanitizeBenchTitle(title)
    return `${BENCH_PUBLIC_DOCS_DIR}\\${base}_${Date.now()}.${benchFileExt || 'tmp'}`
  }
  const runBenchApi = <T>(label: string, fn: () => T, fallback: T): T =>
    wpsBridge.runWithWpsApi(`macro-bench-chat:${label}`, fn, fallback)
  const getActiveBenchDocumentInfo = () => {
    try {
      const docs = wpsBridge.getAllOpenDocuments()
      const active = docs.find(d => d.isActive)
      if (!active?.id) return null
      return {
        id: String(active.id),
        name: String(active.name || ''),
        fullPath: String((active as any).fullPath || ''),
        hostApp: String((active as any).hostApp || ''),
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
      return null
    }
  }

  const hasUsableBenchFilePath = (info: { fullPath?: string } | null | undefined) => {
    const fullPath = String(info?.fullPath || '').trim().toLowerCase()
    if (!fullPath) return false
    if (host === 'wps') return fullPath.endsWith('.docx')
    if (host === 'et') return fullPath.endsWith('.xlsx')
    if (host === 'wpp') return fullPath.endsWith('.pptx')
    return false
  }

  const ensureBenchDoc = async (title?: string) => {
    const active = getActiveBenchDocumentInfo()
    if (active?.id && hasUsableBenchFilePath(active)) {
      benchDocId = active.id
      return
    }
    const info = await withTimeout(createNewDocument(title), 8000, 'ensure_bench_document')
    if (info?.id) {
      benchDocId = info.id
      return
    }
    const fallback = getActiveBenchDocumentInfo()
    if (fallback?.id) {
      benchDocId = fallback.id
      return
    }
    throw new Error(`ensure_bench_document_failed:${host}`)
  }

  const createNewDocument = async (title?: string) => {
    const savePath = buildBenchSavePath(title)
    const ok = runBenchApi(
      'createNewDocument',
      () => {
        const app: any = wpsBridge.getApplication()
        if (!app) return false

        if (host === 'wps') {
          const doc = app.Documents?.Add?.()
          if (!doc) return false
          doc.Activate?.()
          if (typeof doc.SaveAs2 === 'function') doc.SaveAs2(savePath)
          else if (typeof doc.SaveAs === 'function') doc.SaveAs(savePath)
          else return false
          doc.Activate?.()
          return true
        }

        if (host === 'et') {
          const wb = app.Workbooks?.Add?.()
          if (!wb) return false
          wb.Activate?.()
          if (typeof wb.SaveAs === 'function') wb.SaveAs(savePath)
          else return false
          wb.Activate?.()
          return true
        }

        if (host === 'wpp') {
          const presentation = app.Presentations?.Add?.()
          if (!presentation) return false
          const activateWindow = () => {
            const win = presentation.Windows?.Item?.(1) || presentation.Windows?.Item?.call?.(presentation.Windows, 1)
            win?.Activate?.()
          }
          activateWindow()
          if (typeof presentation.SaveAs === 'function') presentation.SaveAs(savePath)
          else return false
          activateWindow()
          return true
        }

        return false
      },
      false,
    )
    if (!ok) return null
    return getActiveBenchDocumentInfo()
  }

  const BENCH_SEED_TEXT = [
    '季度巡检单',
    '',
    '一、巡检范围',
    '1. 网络设备',
    '2. 服务器与数据库',
    '3. 应用系统与权限',
    '',
    '二、发现问题',
    '1. 部分条目编号不连续，存在“1.、3.”跳号。',
    '2. 术语混用：巡检项/检查项/核查项未统一。',
    '3. 引用附件缺失：附件A、附件B在正文提到但未见正文引用位置说明。',
    '',
    '三、整改计划',
    '1. 本周内补齐缺失附件与责任人。',
    '2. 下周统一编号、术语与交叉引用。',
    '3. 月底前完成复核并输出总结。',
    '',
    '四、合同审阅要点',
    '1. 付款条件：验收后30日内付款。',
    '2. 违约责任：逾期交付按合同总额0.5%/日计收违约金。',
    '3. 保密条款：双方对项目资料承担保密义务。',
    '',
    '五、会议纪要',
    '1. 决议：先完成巡检问题清单，再安排整改复盘。',
    '2. 行动项：张三负责编号整改，李四负责附件补齐。',
    '',
    '六、试题',
    '1. 判断题：巡检记录应保留不少于一年。（ ）',
    '2. 填空题：巡检周期为____天。',
    '3. 简答题：请写出巡检报告至少包含的三项内容。',
    '',
    '七、风险台账',
    '| 风险 | 等级 | 措施 |',
    '| 编号不一致 | 中 | 统一编号规则 |',
    '| 附件缺失 | 高 | 补齐附件并复核引用 |',
  ].join('\n')

  const ensureSeedDocumentForBench = async () => {
    if (host !== 'wps') return
    let activeId = ''
    try {
      const docs = wpsBridge.getAllOpenDocuments()
      const active = docs.find(d => d.isActive)
      activeId = String(active?.id || '').trim()
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
    }
    if (!activeId) {
      const created = await createNewDocument('宏基准样本文档')
      activeId = String(created?.id || '').trim()
    }
    let existing = ''
    try {
      if (activeId) existing = String(wpsBridge.extractDocumentTextById(activeId, { maxChars: 4000 }) || '')
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
    }
    if (existing.replace(/\s+/g, '').length >= 20) return
    runBenchApi(
      'ensureSeedDocumentForBench',
      () => {
        const app: any = wpsBridge.getApplication()
        let doc = app?.ActiveDocument || null
        if (!doc) doc = app?.Documents?.Add?.() || null
        if (!doc) return false
        doc.Activate?.()
        const selection = app?.Selection || null
        try {
          if (doc.Content) doc.Content.Text = ''
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
        }
        try {
          if (selection?.WholeStory) selection.WholeStory()
          if (selection?.Delete) selection.Delete()
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
        }
        if (selection?.TypeText) selection.TypeText(BENCH_SEED_TEXT)
        else if (doc.Range) doc.Range().Text = BENCH_SEED_TEXT
        else if (doc.Content) doc.Content.Text = BENCH_SEED_TEXT
        doc.Save?.()
        return true
      },
      false,
    )
  }

  const selectAllCurrentDocument = async () => {
    const ok = runBenchApi(
      'selectAllCurrentDocument',
      () => {
        const app: any = wpsBridge.getApplication()
        if (!app) return false

        if (host === 'wps') {
          const selection = app.Selection || null
          const doc = app.ActiveDocument || null
          selection?.WholeStory?.()
          doc?.Content?.Select?.()
          return !!(selection || doc)
        }

        if (host === 'et') {
          const sheet = app.ActiveSheet || null
          sheet?.UsedRange?.Select?.()
          sheet?.Cells?.Select?.()
          return !!sheet
        }

        if (host === 'wpp') {
          const presentation = app.ActivePresentation || app.Presentations?.Item?.(1) || null
          const count = Number(presentation?.Slides?.Count || 0) || 0
          if (count > 0) presentation.Slides.Item(count)?.Select?.()
          return !!presentation
        }

        return false
      },
      false,
    )
    if (!ok) throw new Error(`select_all_failed:${host}`)
  }

  const clearCurrentDocument = async () => {
    const ok = runBenchApi(
      'clearCurrentDocument',
      () => {
        const app: any = wpsBridge.getApplication()
        if (!app) return false

        if (host === 'wps') {
          const doc = app.ActiveDocument || null
          const selection = app.Selection || null
          if (!doc) return false
          try { if (doc.Content) doc.Content.Text = '' } catch (e) { ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }
          const contentStart = Number(doc?.Content?.Start)
          if (Number.isFinite(contentStart)) {
            selection?.SetRange?.(contentStart, contentStart)
            selection?.Range?.SetRange?.(contentStart, contentStart)
            selection?.Collapse?.(0)
          }
          return true
        }

        if (host === 'et') {
          const sheet = app.ActiveSheet || null
          if (!sheet) return false
          sheet?.UsedRange?.Clear?.()
          sheet?.Cells?.Clear?.()
          sheet?.Range?.('A1')?.Select?.()
          return true
        }

        if (host === 'wpp') {
          const presentation = app.ActivePresentation || app.Presentations?.Item?.(1) || null
          if (!presentation?.Slides) return false
          while ((Number(presentation.Slides.Count || 0) || 0) > 0) {
            presentation.Slides.Item(1)?.Delete?.()
          }
          return true
        }

        return false
      },
      false,
    )
    if (!ok) throw new Error(`clear_document_failed:${host}`)
  }

  const insertTextIntoCurrentDocument = async (text: string, newline: boolean) => {
    const ok = runBenchApi(
      'insertTextIntoCurrentDocument',
      () => {
        const app: any = wpsBridge.getApplication()
        if (!app) return false

        if (host === 'wps') {
          const doc = app.ActiveDocument || null
          const selection = app.Selection || null
          const range = selection?.Range || doc?.Content || null
          if (!range) return false
          try {
            range.Text = String(text)
          } catch (e) {
            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
            if (selection?.TypeText) selection.TypeText(String(text))
            else return false
          }
          const endPos = Number(range?.End)
          if (Number.isFinite(endPos)) {
            selection?.SetRange?.(endPos, endPos)
            selection?.Range?.SetRange?.(endPos, endPos)
          }
          selection?.Collapse?.(0)
          if (newline) {
            if (selection?.TypeParagraph) selection.TypeParagraph()
            else range?.InsertParagraphAfter?.()
          }
          return true
        }

        if (host === 'et') {
          const cell = app.ActiveCell || null
          if (!cell) return false
          cell.Value = String(text)
          return true
        }

        return false
      },
      false,
    )
    if (!ok) throw new Error(`insert_text_failed:${host}`)
  }

  const findTextInCurrentDocument = async (needle: string) => {
    const result = runBenchApi(
      'findTextInCurrentDocument',
      () => {
        const app: any = wpsBridge.getApplication()
        const doc = app?.ActiveDocument || null
        if (!doc) return { ok: false, error: 'find_text:no_active_document' }
        try {
          const bid = (globalThis as any).BID
          const range = typeof bid?.findTextRange === 'function' ? bid.findTextRange(String(needle)) : null
          if (range) {
            range.Select?.()
            return { ok: true }
          }
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
        }
        const range = doc.Range?.() || null
        const find = range?.Find || null
        if (!range || !find) return { ok: false, error: 'find_text:no_range' }
        find.Text = String(needle)
        find.Forward = true
        const ok = !!find.Execute?.()
        if (!ok) return { ok: false, error: `find_text:not_found:${String(needle)}` }
        range.Select?.()
        return { ok: true }
      },
      { ok: false, error: 'find_text:api_failed' },
    )
    if (!result?.ok) throw new Error(String(result?.error || 'find_text_failed'))
  }

  const ensureSheetForBench = async (name: string) => {
    const ok = runBenchApi(
      'ensureSheetForBench',
      () => {
        const app: any = wpsBridge.getApplication()
        const wb = app?.ActiveWorkbook || app?.Workbooks?.Item?.(1) || null
        if (!wb?.Worksheets) return false
        let sheet = null
        try { sheet = wb.Worksheets.Item(name) } catch (_e) { sheet = null }
        if (!sheet) {
          sheet = wb.Worksheets.Add?.() || null
          if (!sheet) return false
          try { sheet.Name = name } catch (e) { ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }
        }
        sheet.Activate?.()
        sheet.Range?.('A1')?.Select?.()
        return true
      },
      false,
    )
    if (!ok) throw new Error(`ensure_sheet_failed:${name}`)
  }

  const activateSheetForBench = async (name: string) => {
    const ok = runBenchApi(
      'activateSheetForBench',
      () => {
        const app: any = wpsBridge.getApplication()
        const wb = app?.ActiveWorkbook || app?.Workbooks?.Item?.(1) || null
        let sheet = null
        try { sheet = wb?.Worksheets?.Item(name) } catch (_e) { sheet = null }
        if (!sheet) return false
        sheet.Activate?.()
        sheet.Range?.('A1')?.Select?.()
        return true
      },
      false,
    )
    if (!ok) throw new Error(`activate_sheet_failed:${name}`)
  }

  const selectBenchRange = async (a1: string) => {
    const ok = runBenchApi(
      'selectBenchRange',
      () => {
        const app: any = wpsBridge.getApplication()
        const sheet = app?.ActiveSheet || null
        if (!sheet?.Range) return false
        sheet.Range(String(a1)).Select?.()
        return true
      },
      false,
    )
    if (!ok) throw new Error(`select_range_failed:${a1}`)
  }

  const ensureBenchSlide = async (index: number) => {
    const ok = runBenchApi(
      'ensureBenchSlide',
      () => {
        const app: any = wpsBridge.getApplication()
        const presentation = app?.ActivePresentation || app?.Presentations?.Item?.(1) || null
        if (!presentation?.Slides) return false
        while ((Number(presentation.Slides.Count || 0) || 0) < index) {
          presentation.Slides.Add?.((Number(presentation.Slides.Count || 0) || 0) + 1, 1)
        }
        presentation.Slides.Item(index)?.Select?.()
        return true
      },
      false,
    )
    if (!ok) throw new Error(`ensure_slide_failed:${index}`)
  }

  const selectBenchSlide = async (index: number) => {
    const ok = runBenchApi(
      'selectBenchSlide',
      () => {
        const app: any = wpsBridge.getApplication()
        const presentation = app?.ActivePresentation || app?.Presentations?.Item?.(1) || null
        const count = Number(presentation?.Slides?.Count || 0) || 0
        if (!presentation?.Slides || count < index) return false
        presentation.Slides.Item(index)?.Select?.()
        return true
      },
      false,
    )
    if (!ok) throw new Error(`select_slide_failed:${index}`)
  }

  const setBenchCursor = async (pos: 'start' | 'end') => {
    const ok = runBenchApi(
      'setBenchCursor',
      () => {
        const app: any = wpsBridge.getApplication()
        if (!app) return false

        if (host === 'wps') {
          const selection = app.Selection || null
          if (!selection) return false
          const wdMove = 0
          const wdStory = 6
          if (pos === 'end') selection.EndOf?.(wdStory, wdMove)
          else selection.StartOf?.(wdStory, wdMove)
          return true
        }

        if (host === 'et') {
          const sheet = app.ActiveSheet || null
          if (!sheet) return false
          if (pos === 'end') {
            const used = sheet.UsedRange || null
            const row = (Number(used?.Row || 1) || 1) + (Number(used?.Rows?.Count || 1) || 1) - 1
            const col = (Number(used?.Column || 1) || 1) + (Number(used?.Columns?.Count || 1) || 1) - 1
            sheet.Cells?.(row, col)?.Select?.()
          } else {
            sheet.Range?.('A1')?.Select?.()
          }
          return true
        }

        return false
      },
      false,
    )
    if (!ok) throw new Error(`set_cursor_failed:${host}:${pos}`)
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

      if (shouldStopNow()) throw makeAbortError()
      await sleepAbortable(Math.max(0, Number(a.ms || 0) || 0), opts.signal)

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
      await findTextInCurrentDocument(needle)
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
        if (shouldStopNow()) throw makeAbortError()
        if (Date.now() > deadline) throw new Error(`macro_queue_job_timeout:${jobAlias}`)
        const r = getRun(job.messageId, job.blockId)
        const st = String(r?.status || '').trim()
        if (st === 'success') return
        if (st === 'error') {
          const err = String(r?.error || 'macro_queue_job_error')
          throw new Error(`macro_queue_job_error:${jobAlias}:${err}`)
        }
        await sleepAbortable(120, opts.signal)
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
      await selectAllCurrentDocument()
      return
    }

    if (a.type === 'clear_document') {
      await clearCurrentDocument()
      return
    }

    if (a.type === 'insert_text') {
      const text = String(a.text || '')
      const newline = a.newline !== false
      await insertTextIntoCurrentDocument(text, newline)
      return
    }

    if (a.type === 'ensure_sheet') {
      const name = String(a.name || '').trim() || 'Sheet1'
      await ensureSheetForBench(name)
      return
    }

    if (a.type === 'activate_sheet') {
      const name = String(a.name || '').trim() || 'Sheet1'
      await activateSheetForBench(name)
      return
    }

    if (a.type === 'select_range') {
      const a1 = String(a.a1 || '').trim() || 'A1'
      await selectBenchRange(a1)
      return
    }

    if (a.type === 'ensure_slide') {
      const idx = Math.max(1, Number(a.index || 1) || 1)
      await ensureBenchSlide(idx)
      return
    }

    if (a.type === 'select_slide') {
      const idx = Math.max(1, Number(a.index || 1) || 1)
      await selectBenchSlide(idx)
      return
    }

    if (a.type === 'set_cursor') {
      const pos = a.pos
      await setBenchCursor(pos)
      return
    }

  }



  const applyActions = async (actions?: ChatBenchAction[], stagePrefix: string = 'actions', stageExtra?: Record<string, any>) => {

    if (!actions || !actions.length) return

    for (let actionIdx = 0; actionIdx < actions.length; actionIdx++) {
      const a = actions[actionIdx]

      if (shouldStopNow()) break

      pushStage(`${stagePrefix}_action`, {
        actionIdx: actionIdx + 1,
        actionTotal: actions.length,
        actionType: String((a as any)?.type || ''),
        actionTitle: String((a as any)?.title || ''),
        ...(stageExtra || {}),
      })

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

  const initializedChatSessionIds = new Set<string>()

  try {

    for (const rr of results) {

      const sid = String((rr as any)?.chatSessionId || '').trim()

      if (sid) initializedChatSessionIds.add(sid)

    }

  } catch (e) {

    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)

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

    chatSessionIsolation: 'per_story',

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

    try { await switchBenchSessionBucket(false) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }

    try {

      // Pinia setup stores unwrap refs on the store instance. Avoid `.value` here,

      // otherwise MacroBench will never see assistant messages and will mis-handle busy state.

      const arr: any[] = Array.isArray((chatStore as any).messages) ? ((chatStore as any).messages as any[]) : []

      if (arr.length <= keepLast) return

      // Keep the same array reference (it is a per-session bucket); splice in place.

      arr.splice(0, Math.max(0, arr.length - keepLast))

      // Hint for humans: don't silently "lose" UI content.

      try {

        ;(chatStore as any).addSystemMessage?.("[Bench] Trimmed old messages and kept the latest " + keepLast + " items for stability.")

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



  const waitForChatIdle = async (idleOpts?: { timeoutMs?: number }) => {

    const timeoutMs = Math.max(0, Number(idleOpts?.timeoutMs || 0) || 0) || 30000

    const deadline = Date.now() + timeoutMs

    // Wait until the chat store is idle before sending the next turn.

    while (Boolean((chatStore as any)?.isSending)) {
      if (shouldStopNow()) {
        try { (chatStore as any).cancelCurrentRequest?.() } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }
        throw makeAbortError()
      }

      if (Date.now() > deadline) {
        throw new Error(`chat_busy_timeout:${timeoutMs}`)

      }

      await sleepAbortable(80, opts.signal)

      }

  }

  const switchBenchSessionBucket = async (bindToActiveDocument: boolean = false, timeoutMs: number = 1500) => {
    try {
      const work = Promise.resolve(
        (chatStore as any).switchToSession?.(
          activeChatSessionId,
          bindToActiveDocument ? { bindToActiveDocument: true } : undefined
        )
      )
      await withTimeout(work, timeoutMs, 'switch_bench_session')
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
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

      signal?: AbortSignal

    },

    retries: number = 2

  ) => {

    let lastErr: any = null

    for (let i = 0; i <= retries; i++) {
      if (shouldStopNow()) throw makeAbortError()

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

        if (shouldStopNow()) throw makeAbortError()

        await sleepAbortable(500 + i * 300, opts.signal)

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

      // Soft failure budget: keep running and only report the threshold.

      // maxFailures is warn-only, not a hard stop.

      const fails = results.filter(x => !x.ok).length

      if (fails >= maxFailures) {

        try { (chatStore as any).addSystemMessage?.("[Bench] failure budget reached: " + fails + "/" + maxFailures + " (continue)") } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }

      }

    }

    if (maxCost > 0) {

      if (totalTokens >= maxCost) break

    }

    const { story, turn } = items[i]
    activeChatSessionId = getStoryChatSessionId(story)
    const isFirstTurnOfStory = turn === story.turns[0]
    const storyAlreadyHasResults = results.some(r => r.story?.id === story.id)

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

    if (isFirstTurnOfStory && !storyAlreadyHasResults) {

      try {

        await applyActions(story.setupActions, 'story_setup', {
          idx: i + 1,
          total: items.length,
          storyId: story.id,
          storyName: story.name,
          turnId: turn.id,
          turnName: turn.name,
          suiteId: story.suiteId,
        })

      } catch (e: any) {

        const msg = "setup_actions_failed: " + String(e?.message || e)

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

          chatSessionId: activeChatSessionId,

          macroSessionId: "bench_chat_" + host + "_" + Date.now() + "_" + (i + 1),

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

    if (pinBenchDoc) await applyActions([{ type: 'activate_bench_document' }], 'story_activate_bench_doc', {
      idx: i + 1,
      total: items.length,
      storyId: story.id,
      storyName: story.name,
      turnId: turn.id,
      turnName: turn.name,
      suiteId: story.suiteId,
    })

    if (!initializedChatSessionIds.has(activeChatSessionId)) {

      pushStage('story_switch_session', {
        idx: i + 1,
        total: items.length,
        storyId: story.id,
        storyName: story.name,
        turnId: turn.id,
        turnName: turn.name,
        suiteId: story.suiteId,
        chatSessionId,
      })

      await switchBenchSessionBucket(true, 2000)

      pushStage('story_clear_messages', {
        idx: i + 1,
        total: items.length,
        storyId: story.id,
        storyName: story.name,
        turnId: turn.id,
        turnName: turn.name,
        suiteId: story.suiteId,
        chatSessionId,
      })

      try { chatStore.clearMessages?.() } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }

      initializedChatSessionIds.add(activeChatSessionId)

    }

  }



    let queryToSend = String(turn.query || '')

    let ruleFilesForTurn: string[] = []

    let uiClickSendForTurn = false

    try {

      const applied = await applyActionsToQuery(queryToSend, turn.actionsBeforeSend)

      queryToSend = applied.query

      ruleFilesForTurn = applied.ruleFiles

      uiClickSendForTurn = !!(applied as any).uiClickSend

      await applyActions(turn.actionsBeforeSend, 'turn_before_send', {
        idx: i + 1,
        total: items.length,
        storyId: story.id,
        storyName: story.name,
        turnId: turn.id,
        turnName: turn.name,
        suiteId: story.suiteId,
      })

    } catch (e: any) {

      const msg = "actions_before_send_failed: " + String(e?.message || e)

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

        macroSessionId: "bench_chat_" + host + "_" + Date.now() + "_" + (i + 1),

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

    if (pinBenchDoc) await applyActions([{ type: 'activate_bench_document' }], 'turn_activate_bench_doc', {
      idx: i + 1,
      total: items.length,
      storyId: story.id,
      storyName: story.name,
      turnId: turn.id,
      turnName: turn.name,
      suiteId: story.suiteId,
    })



    opts.onProgress?.({ idx: i + 1, total: items.length, storyName: story.name, turnName: turn.name, host, suiteId: story.suiteId })
    pushStage('turn_start', {
      idx: i + 1,
      total: items.length,
      storyId: story.id,
      storyName: story.name,
      turnId: turn.id,
      turnName: turn.name,
      suiteId: story.suiteId,
    })

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
        macroSessionId: "bench_local_" + host + "_" + Date.now() + "_" + (i + 1),
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

    pushStage('turn_switch_session_pre', {
      idx: i + 1,
      total: items.length,
      storyId: story.id,
      storyName: story.name,
      turnId: turn.id,
      turnName: turn.name,
      suiteId: story.suiteId,
    })
    await switchBenchSessionBucket(true)

    pushStage('turn_ensure_seed_document', {
      idx: i + 1,
      total: items.length,
      storyId: story.id,
      storyName: story.name,
      turnId: turn.id,
      turnName: turn.name,
      suiteId: story.suiteId,
    })
    await ensureSeedDocumentForBench()
    pushStage('turn_wait_chat_idle_pre_send', {
      idx: i + 1,
      total: items.length,
      storyId: story.id,
      storyName: story.name,
      turnId: turn.id,
      turnName: turn.name,
      suiteId: story.suiteId,
    })
    await waitForChatIdle()

    const beforeLen = Number(unwrapMessagesRef((chatStore as any).messages).length || 0) || 0

    const t0 = performance.now()

    let chatMs = 0

    let assistantMsg: any = null

    let tokenUsage: any = null

    try {

      const overridePlan = (turn as any)?.planOverride
      const hasOverridePlan =
        overridePlan && typeof overridePlan === 'object' && !Array.isArray(overridePlan)
      const assistantTextOverride = String((turn as any)?.assistantTextOverride || '')
      const hasAssistantTextOverride = !hasOverridePlan && !!assistantTextOverride.trim()

      if (hasOverridePlan) {
        // System coverage: bypass chat and execute a deterministic plan.
        assistantMsg = null
        tokenUsage = null
        chatMs = 0
      } else if (hasAssistantTextOverride) {
        assistantMsg = {
          id: `bench_text_override_${host}_${Date.now()}_${i + 1}`,
          role: 'assistant',
          content: assistantTextOverride,
          metadata: { benchTextOverride: true },
        }
        tokenUsage = null
        chatMs = 0
      } else if (uiClickSendForTurn) {

        try { (chatStore as any).addSystemMessage?.('[Bench] ui_click_send simulated: calling store.sendMessage(sessionId=...)') } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }

      }

      if (!hasOverridePlan && !hasAssistantTextOverride) {
        pushStage('turn_send', {
          idx: i + 1,
          total: items.length,
          storyId: story.id,
          storyName: story.name,
          turnId: turn.id,
          turnName: turn.name,
          suiteId: story.suiteId,
        })
        await withTimeout(

          sendWithRetry(queryToSend, activeChatSessionId, {

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

            signal: opts.signal,

          }),

          chatTimeoutMs,

          'chat'

        )

        chatMs = Math.round(performance.now() - t0)
        pushStage('turn_sent', {
          idx: i + 1,
          total: items.length,
          storyId: story.id,
          storyName: story.name,
          turnId: turn.id,
          turnName: turn.name,
          suiteId: story.suiteId,
        })

        try { tokenUsage = (chatStore as any).consumeLastTokenUsage?.() || null } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e); tokenUsage = null }

        try {

          const t = Number(tokenUsage?.total_tokens || 0) || 0

          if (t > 0) totalTokens += t

        } catch (e) {

          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)

        }



        // Re-select the bench session bucket after the send, in case the UI switched documents mid-stream.

        pushStage('turn_switch_session_post', {
          idx: i + 1,
          total: items.length,
          storyId: story.id,
          storyName: story.name,
          turnId: turn.id,
          turnName: turn.name,
          suiteId: story.suiteId,
        })
        await switchBenchSessionBucket(false)



        pushStage('turn_collect_messages', {
          idx: i + 1,
          total: items.length,
          storyId: story.id,
          storyName: story.name,
          turnId: turn.id,
          turnName: turn.name,
          suiteId: story.suiteId,
        })
        const bucketMsgs = unwrapMessagesRef((chatStore as any).messages)
        const newMsgs = beforeLen > 0 ? bucketMsgs.slice(beforeLen) : bucketMsgs.slice()

        assistantMsg = pickBenchAssistantMessage(newMsgs, bucketMsgs)
        if (!assistantMsg) {

          throw new Error('chat_no_assistant_message')

        }
      }

    } catch (e: any) {

      // Best-effort: abort a hung stream so the queue can continue.

      try { (chatStore as any).cancelCurrentRequest?.() } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e) }

      const msg = "chat_failed: " + String(e?.message || e)

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

        chatSessionId: activeChatSessionId,

        macroSessionId: "bench_chat_" + host + "_" + Date.now() + "_" + (i + 1),

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
    const assistantTextOverride = String((turn as any)?.assistantTextOverride || '')
    const hasAssistantTextOverride = !hasOverridePlan && !!assistantTextOverride.trim()

    const expectedOutput = ((turn as any)?.expectedOutput || 'plan') as 'plan' | 'text' | 'either'
    const assistantContent = hasAssistantTextOverride
      ? assistantTextOverride
      : String(assistantMsg?.content || '')

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
      selectedSkills = applyForcedSkillSelection(turn, selectedSkills)
    } else {
      selectedSkills = applyForcedSkillSelection(turn, [])
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
        chatSessionId: activeChatSessionId,
        macroSessionId: "bench_chat_" + host + "_" + Date.now() + "_" + (i + 1),
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
      const wantWriteback = (() => {
        try {
          const v = (assistantMsg as any)?.metadata?.wantWriteback
          return typeof v === 'boolean' ? v : null
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
          return null
        }
      })()
      const traceId = (() => {
        try {
          return String((assistantMsg as any)?.metadata?.traceId || '').trim()
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/dev/macro-bench-chat.ts', e)
          return ''
        }
      })()
      const msg =
        wantWriteback === false
          ? `chat_ok_but_backend_text_only${traceId ? `:trace_id=${traceId}` : ''}`
          : 'chat_ok_but_no_plan_block'

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

        chatSessionId: activeChatSessionId,

        macroSessionId: "bench_chat_" + host + "_" + Date.now() + "_" + (i + 1),

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
        macroSessionId: "bench_chat_" + host + "_" + Date.now() + "_" + (i + 1),
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
    const macroSessionId = "bench_ui_" + host + "_" + Date.now() + "_" + (i + 1)
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
      const localRepairsUsed = countLocalPlanRepairs(planObj)
      let currentPlan = useSystemOps ? ensurePlanBlockIdForSystemOps(planObj, stableId) : ensurePlanBlockId(planObj, stableId)
      const maxAttempts = 3
      const t1 = performance.now()
      pushStage('turn_exec_start', {
        idx: i + 1,
        total: items.length,
        storyId: story.id,
        storyName: story.name,
        turnId: turn.id,
        turnName: turn.name,
        suiteId: story.suiteId,
      })
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
      repairsUsed = localRepairsUsed + (attempts > 0 ? Math.max(0, attempts - 1) : 0)
      pushStage('turn_exec_done', {
        idx: i + 1,
        total: items.length,
        storyId: story.id,
        storyName: story.name,
        turnId: turn.id,
        turnName: turn.name,
        suiteId: story.suiteId,
        execOk: ok,
        execAttempts: attempts,
        repairsUsed,
      })
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
      onAssertStart: ({ type }) => {
        pushStage('turn_assert_start', {
          idx: i + 1,
          total: items.length,
          storyId: story.id,
          storyName: story.name,
          turnId: turn.id,
          turnName: turn.name,
          suiteId: story.suiteId,
          assertType: type,
        })
      },
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
      message = "exec_ok_but_assert_failed:" + head
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
    pushHostBenchStatus('running', {
      progress: {
        idx: i + 1,
        total: items.length,
        storyName: story.name,
        turnName: turn.name,
        host,
        suiteId,
      },
      completedTurns: results.length,
      okTurns: results.filter(x => !!x.ok).length,
      assertOkTurns: results.filter(x => !!x.assertOk).length,
      summary: partial.summary,
      detailStage: {
        stage: 'turn_persisted',
        host,
        suiteId,
        runId,
        chatSessionId,
        storyId: story.id,
        storyName: story.name,
        turnId: turn.id,
        turnName: turn.name,
        idx: i + 1,
        total: items.length,
        ok: okFinal,
        execOk: ok,
        assertOk: ae.ok,
      },
    })



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
  pushHostBenchStatus('done', {
    ok: run.summary.ok,
    total: run.summary.total,
    completedTurns: run.results.length,
    summary: run.summary,
    recentFailures: run.results.filter(x => !x.ok).slice(-5).map(x => ({
      storyId: x.story?.id || '',
      turnId: x.turn?.id || '',
      message: x.message,
    })),
  })

  return run

}
