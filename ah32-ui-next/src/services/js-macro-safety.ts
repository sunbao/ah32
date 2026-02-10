export interface MacroSafetyResult {
  ok: boolean
  reasons: string[]
}

export function isUnsafeMacroOptOutEnabled(code: string): boolean {
  const s = String(code || '')
  if (/^\s*\/\/\s*@ah32:unsafe\b/m.test(s)) return true
  if (/^\s*\/\*\s*@ah32:unsafe\b/m.test(s)) return true
  return false
}

function sanitizeForScan(code: string): string {
  const src = String(code || '')
  const out: string[] = []
  let i = 0

  type Mode = 'normal' | 'single' | 'double' | 'template' | 'line_comment' | 'block_comment'
  let mode: Mode = 'normal'
  let templateExprDepth = 0

  const push = (ch: string) => out.push(ch)
  const space = () => out.push(' ')

  while (i < src.length) {
    const ch = src[i]
    const next = i + 1 < src.length ? src[i + 1] : ''

    if (mode === 'line_comment') {
      if (ch === '\n') {
        mode = 'normal'
        push(ch)
      } else {
        space()
      }
      i++
      continue
    }

    if (mode === 'block_comment') {
      if (ch === '*' && next === '/') {
        space()
        space()
        i += 2
        mode = 'normal'
      } else {
        space()
        i++
      }
      continue
    }

    if (mode === 'single') {
      if (ch === '\\\\') {
        space()
        if (i + 1 < src.length) space()
        i += 2
        continue
      }
      if (ch === '\'') {
        space()
        i++
        mode = 'normal'
        continue
      }
      space()
      i++
      continue
    }

    if (mode === 'double') {
      if (ch === '\\\\') {
        space()
        if (i + 1 < src.length) space()
        i += 2
        continue
      }
      if (ch === '"') {
        space()
        i++
        mode = 'normal'
        continue
      }
      space()
      i++
      continue
    }

    if (mode === 'template') {
      if (ch === '\\\\') {
        space()
        if (i + 1 < src.length) space()
        i += 2
        continue
      }
      if (ch === '`') {
        space()
        i++
        mode = 'normal'
        continue
      }
      if (ch === '$' && next === '{') {
        space()
        space()
        i += 2
        mode = 'normal'
        templateExprDepth = 1
        continue
      }
      space()
      i++
      continue
    }

    // normal
    if (templateExprDepth > 0) {
      if (ch === '{') templateExprDepth++
      else if (ch === '}') templateExprDepth--
      if (templateExprDepth === 0) {
        // Back to template literal text mode
        space()
        i++
        mode = 'template'
        continue
      }
    }

    if (ch === '/' && next === '/') {
      space()
      space()
      i += 2
      mode = 'line_comment'
      continue
    }
    if (ch === '/' && next === '*') {
      space()
      space()
      i += 2
      mode = 'block_comment'
      continue
    }
    if (ch === '\'') {
      space()
      i++
      mode = 'single'
      continue
    }
    if (ch === '"') {
      space()
      i++
      mode = 'double'
      continue
    }
    if (ch === '`') {
      space()
      i++
      mode = 'template'
      continue
    }

    push(ch)
    i++
  }
  return out.join('')
}

export function checkMacroSafety(code: string): MacroSafetyResult {
  if (isUnsafeMacroOptOutEnabled(code)) return { ok: true, reasons: [] }

  const sanitized = sanitizeForScan(code)
  const reasons: string[] = []

  const add = (reason: string) => {
    if (!reasons.includes(reason)) reasons.push(reason)
  }

  if (/\beval\s*\(/.test(sanitized) || /\bFunction\s*\(/.test(sanitized) || /\bnew\s+Function\s*\(/.test(sanitized)) {
    add('disallowed dynamic evaluation (eval/Function)')
  }
  if (/\bsetTimeout\s*\(\s*['"`]/.test(sanitized) || /\bsetInterval\s*\(\s*['"`]/.test(sanitized)) {
    add('disallowed string-based timers (setTimeout/setInterval with string)')
  }
  if (/\bwhile\s*\(\s*true\s*\)/.test(sanitized) || /\bfor\s*\(\s*;\s*;\s*\)/.test(sanitized)) {
    add('potential infinite loop (while(true)/for(;;))')
  }
  if (/\bfetch\s*\(/.test(sanitized) || /\bXMLHttpRequest\b/.test(sanitized) || /\bWebSocket\b/.test(sanitized)) {
    add('disallowed network APIs (fetch/XMLHttpRequest/WebSocket)')
  }
  if (/\bimport\s*\(/.test(sanitized)) {
    add('disallowed dynamic import')
  }

  return { ok: reasons.length === 0, reasons }
}

