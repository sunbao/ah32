const DIAG_KEY = 'ah32_reload_diag_v1'

const MAX_EVENT_ITEMS = 12
const MAX_EVENT_MSG_CHARS = 220
const MAX_EVENT_EXTRA_CHARS = 600
const MAX_JSON_CHARS = 24_000

type ReloadDiag = Record<string, any>

const safeString = (value: unknown, maxChars: number): string => {
  try {
    const s = String(value ?? '')
    if (!maxChars || maxChars <= 0) return s
    if (s.length <= maxChars) return s
    return s.slice(0, maxChars) + '…'
  } catch (_e) {
    return ''
  }
}

const readDiag = (): ReloadDiag => {
  try {
    const raw = localStorage.getItem(DIAG_KEY) || ''
    if (!raw.trim()) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as ReloadDiag
  } catch (_e) {
    return {}
  }
}

const normalizeDiag = (diag: ReloadDiag): ReloadDiag => {
  try {
    const d: ReloadDiag = diag && typeof diag === 'object' ? diag : {}
    if (Array.isArray(d.events)) {
      const items = d.events.slice(-MAX_EVENT_ITEMS).map((ev: any) => {
        try {
          const at = safeString(ev?.at || '', 60)
          const type = safeString(ev?.type || '', 40)
          const msg = safeString(ev?.msg || '', MAX_EVENT_MSG_CHARS)
          let extra = ''
          try {
            if (typeof ev?.extra === 'string') extra = ev.extra
            else if (ev?.extra != null) extra = JSON.stringify(ev.extra)
          } catch (_e) {
            extra = safeString(ev?.extra || '', MAX_EVENT_EXTRA_CHARS)
          }
          extra = safeString(extra, MAX_EVENT_EXTRA_CHARS)
          const out: any = { at, type, msg }
          if (extra) out.extra = extra
          return out
        } catch (_e) {
          return null
        }
      }).filter(Boolean)
      d.events = items
    }
    return d
  } catch (_e) {
    return {}
  }
}

const writeDiag = (diag: ReloadDiag) => {
  try {
    const normalized = normalizeDiag(diag)
    let raw = ''
    try {
      raw = JSON.stringify(normalized)
    } catch (_e) {
      raw = ''
    }
    if (raw && raw.length > MAX_JSON_CHARS) {
      try {
        const trimmed: ReloadDiag = { ...normalized }
        if (Array.isArray(trimmed.events)) trimmed.events = trimmed.events.slice(-6)
        raw = JSON.stringify(trimmed)
      } catch (_e) {
        raw = ''
      }
    }
    if (raw) localStorage.setItem(DIAG_KEY, raw)
  } catch (e) {
    try {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/utils/reload-diag.ts', e)
    } catch (_e2) {
      // ignore
    }
  }
}

export const patchReloadDiag = (patch: Record<string, any>) => {
  try {
    if (!patch || typeof patch !== 'object') return
    const diag = readDiag()
    // Put patch keys first so truncated boot logs still show the latest context.
    const updated: ReloadDiag = {}
    for (const [k, v] of Object.entries(patch)) {
      updated[k] = v
    }
    for (const [k, v] of Object.entries(diag)) {
      if (!(k in updated)) updated[k] = v
    }
    writeDiag(updated)
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/utils/reload-diag.ts', e)
  }
}

export const pushReloadDiagEvent = (type: string, msg: string, extra?: any) => {
  try {
    const diag = readDiag()
    const events = Array.isArray((diag as any).events) ? (diag as any).events.slice(-MAX_EVENT_ITEMS) : []
    events.push({
      at: new Date().toISOString(),
      type: safeString(type, 40),
      msg: safeString(msg, MAX_EVENT_MSG_CHARS),
      extra: extra,
    })
    patchReloadDiag({ events })
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/utils/reload-diag.ts', e)
  }
}

