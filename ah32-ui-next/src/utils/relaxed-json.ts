export type RelaxedJsonParseResult<T = any> = {
  ok: boolean
  value: T | null
  repaired: boolean
  error?: string
  repairedText?: string
}

const _escapeControlChar = (ch: string): string => {
  const code = ch.charCodeAt(0)
  // JSON allows these only when escaped inside strings.
  if (code === 0x0a) return '\\n'
  if (code === 0x0d) return '\\r'
  if (code === 0x09) return '\\t'
  if (code === 0x08) return '\\b'
  if (code === 0x0c) return '\\f'
  return `\\u${code.toString(16).padStart(4, '0')}`
}

// Best-effort repair for a common LLM failure mode:
// JSON strings that contain raw control characters (e.g. newline) instead of escaped "\\n".
// This is NOT a general JSON5 parser and should stay conservative.
export const repairJsonControlCharsInStrings = (input: string): { text: string; changed: boolean } => {
  const src = String(input || '')
  if (!src) return { text: '', changed: false }

  let out = ''
  let changed = false
  let inString = false
  let escaped = false

  for (let i = 0; i < src.length; i++) {
    const ch = src[i] || ''

    if (!inString) {
      out += ch
      if (ch === '"') {
        inString = true
        escaped = false
      }
      continue
    }

    // inside a JSON string
    if (escaped) {
      out += ch
      escaped = false
      continue
    }

    if (ch === '\\') {
      out += ch
      escaped = true
      continue
    }

    if (ch === '"') {
      out += ch
      inString = false
      escaped = false
      continue
    }

    const code = ch.charCodeAt(0)
    if (code >= 0x00 && code < 0x20) {
      out += _escapeControlChar(ch)
      changed = true
      continue
    }

    out += ch
  }

  return { text: out, changed }
}

export const parseJsonRelaxed = (input: string, opts?: { maxChars?: number; allowRepair?: boolean }): RelaxedJsonParseResult => {
  const raw = String(input || '')
  const maxChars = Math.max(0, Number(opts?.maxChars || 0) || 0) || 800_000
  const allowRepair = opts?.allowRepair !== false

  if (!raw.trim()) return { ok: false, value: null, repaired: false, error: 'empty' }
  if (raw.length > maxChars) {
    return {
      ok: false,
      value: null,
      repaired: false,
      error: `too_large:${raw.length}>${maxChars}`,
    }
  }

  try {
    const v = JSON.parse(raw)
    return { ok: true, value: v, repaired: false }
  } catch (e: any) {
    const msg = String(e?.message || e || 'parse_failed')
    if (!allowRepair) return { ok: false, value: null, repaired: false, error: msg }

    const repaired = repairJsonControlCharsInStrings(raw)
    if (!repaired.changed) {
      return { ok: false, value: null, repaired: false, error: msg }
    }
    try {
      const v2 = JSON.parse(repaired.text)
      return { ok: true, value: v2, repaired: true, error: msg, repairedText: repaired.text }
    } catch (e2: any) {
      const msg2 = String(e2?.message || e2 || 'parse_failed')
      return { ok: false, value: null, repaired: true, error: `${msg} -> ${msg2}` }
    }
  }
}

