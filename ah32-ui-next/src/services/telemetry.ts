import { getClientId } from '@/utils/client-id'
import { getRuntimeConfig } from '@/utils/runtime-config'

type TelemetryEventV1 = {
  schema_version: 'ah32.telemetry.v1'
  event_name: string
  ts: number
  // RunContext (best-effort)
  run_id?: string
  mode?: string
  host_app?: string
  doc_id?: string
  doc_key?: string
  session_id?: string
  story_id?: string
  turn_id?: string
  case_id?: string
  task_id?: string
  message_id?: string
  block_id?: string
  client_id?: string
  payload?: Record<string, any>
}

// Simple in-memory batcher; best-effort and never blocks the UI.
const q: TelemetryEventV1[] = []
let timer: any = null
let flushing = false

const flushIntervalMs = Number((import.meta as any).env?.VITE_TELEMETRY_FLUSH_MS || '1000') || 1000
const batchSize = Number((import.meta as any).env?.VITE_TELEMETRY_BATCH_SIZE || '80') || 80

function runtime() {
  return getRuntimeConfig()
}

export function emitTelemetryEvent(
  eventName: string,
  payload?: Record<string, any>,
  ctx?: Partial<Omit<TelemetryEventV1, 'schema_version' | 'event_name' | 'ts' | 'payload'>>
) {
  const name = String(eventName || '').trim()
  if (!name) return
  try {
    const ev: TelemetryEventV1 = {
      schema_version: 'ah32.telemetry.v1',
      event_name: name,
      ts: Date.now() / 1000,
      client_id: getClientId(),
      ...(ctx || {}),
      payload: payload || {}
    }
    q.push(ev)
    scheduleFlush()
  } catch (e: any) {
    // Don't throw; telemetry must never break the main flow.
    try {
      console.warn('[telemetry] emit failed:', e?.message || e)
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/telemetry.ts', e)
    }
  }
}

export async function flushTelemetryNow(): Promise<number> {
  if (flushing) return 0
  if (q.length === 0) return 0
  flushing = true
  try {
    const cfg = runtime()
    const events = q.splice(0, Math.max(1, batchSize))
    const resp = await fetch(`${cfg.apiBase}/telemetry/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {})
      },
      body: JSON.stringify({ events })
    })
    if (!resp.ok) {
      // Put them back so we can retry later.
      q.unshift(...events)
      return 0
    }
    return events.length
  } catch (e: any) {
    try {
      console.warn('[telemetry] flush failed:', e?.message || e)
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/telemetry.ts', e)
    }
    return 0
  } finally {
    flushing = false
    if (q.length > 0) scheduleFlush()
  }
}

function scheduleFlush() {
  if (timer) return
  timer = setTimeout(async () => {
    timer = null
    await flushTelemetryNow()
  }, Math.max(200, flushIntervalMs))
}

