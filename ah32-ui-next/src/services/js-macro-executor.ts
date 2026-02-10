/**

 * JS 宏执行器 - WPS 免费版专用

 * 支持Vibe Coding可视化风格

 */

import { wpsBridge } from './wps-bridge'

import { logger } from '@/utils/logger'

import { getRuntimeConfig } from '@/utils/runtime-config'

import { checkMacroSafety } from './js-macro-safety'

import { reportAuditEvent } from './audit-client'
import { macroCancel } from './macro-cancel'



// Vibe Coding可视化步骤类型

export interface VisualStep {

  type: string

  title: string

  content: string

  timestamp: number

  reasoning?: string

  code_diff?: {

    type: 'added' | 'removed' | 'modified' | 'generated' | 'error_found'

    old_code?: string

    new_code?: string

    explanation: string

    errors?: string[]

  }

  status: 'pending' | 'processing' | 'completed' | 'error'

}



// Vibe Coding事件类型

export interface VibeCodingEvent {

  type: 'node_update' | 'visual_step' | 'final_result' | 'error'

  node?: string

  state?: any

  step?: VisualStep

  result?: {

    success: boolean

    code: string

    visual_steps: VisualStep[]

    attempt_count: number

    execution_result?: any

  }

  error?: string

  timestamp: number

}



export class JSMacroExecutor {

  private sessionId: string | null = null

  private documentName: string | null = null

  private hostApp: 'wps' | 'et' | 'wpp' | 'unknown' = 'unknown'

  private readonly MAX_JSON_PARSE_CHARS = 500_000

  private readonly MAX_STREAM_EVENT_CHARS = 250_000

  private readonly MAX_STREAM_CONTENT_CHARS = 1_200_000

  private jsonBoundaryWarned: Set<string> = new Set()



  constructor() {

    // 延迟初始化

  }

  private warnJsonBoundaryOnce(key: string, message: string) {
    try {
      if (this.jsonBoundaryWarned.has(key)) return
      this.jsonBoundaryWarned.add(key)
      logger.warn(message)
      try {
        ;(globalThis as any).__ah32_logToBackend?.(`[JSMacroExecutor] ${message}`, 'warning')
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/js-macro-executor.ts', e)
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/js-macro-executor.ts', e)
    }
  }

  private safeJsonParse(raw: string, scope: string, maxChars: number = this.MAX_JSON_PARSE_CHARS): any | null {
    try {
      const text = String(raw || '')
      if (!text.trim()) return null
      if (text.length > maxChars) {
        this.warnJsonBoundaryOnce(
          `json_too_large:${scope}`,
          `[${scope}] JSON payload too large (${text.length} > ${maxChars}); skip parse`
        )
        return null
      }
      return JSON.parse(text)
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/js-macro-executor.ts', e)
      return null
    }
  }



  /**

   * 设置会话信息（用于生成 JS 宏代码）

   */

  private sanitizeMacroSource(code: string): { code: string; changed: boolean; notes: string[] } {
    const notes: string[] = []
    let out = String(code || '')
    let changed = false

    // Remove BOM characters (they can appear mid-string from copy/paste and break parsing).
    if (out.includes('\ufeff')) {
      out = out.replace(/\ufeff/g, '')
      changed = true
      notes.push('removed BOM (\\uFEFF)')
    }

    // Normalize Unicode line separators which some JS engines reject in source text.
    if (/[\u2028\u2029]/.test(out)) {
      out = out.replace(/[\u2028\u2029]/g, '\n')
      changed = true
      notes.push('replaced Unicode line separators (\\u2028/\\u2029)')
    }

    // Replace non-breaking spaces (often introduced by rich-text copy/paste).
    if (out.includes('\u00a0')) {
      out = out.replace(/\u00a0/g, ' ')
      changed = true
      notes.push('replaced NBSP (\\u00A0)')
    }

    // Remove zero-width characters that frequently cause "Invalid or unexpected token".
    if (/[\u200b-\u200d\u2060]/.test(out)) {
      out = out.replace(/[\u200b-\u200d\u2060]/g, '')
      changed = true
      notes.push('removed zero-width characters (\\u200B-\\u200D/\\u2060)')
    }

    // Replace suspicious Unicode punctuation ONLY when it appears outside of strings/comments.
    // This keeps document content inside string literals intact while fixing common copy/paste mistakes
    // that cause `new Function(...)` to throw "Invalid or unexpected token".
    const repl: Record<string, string> = {
      // smart quotes
      '“': '"',
      '”': '"',
      '‘': "'",
      '’': "'",
      '＂': '"',
      // common full-width punctuation that breaks JS when used as syntax
      '（': '(',
      '）': ')',
      '【': '[',
      '】': ']',
      '｛': '{',
      '｝': '}',
      '，': ',',
      '。': '.',
      '；': ';',
      '：': ':',
      '＝': '=',
      '＋': '+',
      '－': '-',
      '＊': '*',
      '／': '/',
      '＼': '\\',
    }

    const shouldReplace = (ch: string) => Object.prototype.hasOwnProperty.call(repl, ch)

    const src = out
    const chars = Array.from(src)
    const mark: boolean[] = new Array(chars.length).fill(false)

    // Simple scanner: mark characters in "normal code" (outside strings and comments).
    // NOTE: This is not a full JS parser (regex literals are treated as code), but it is sufficient
    // for preventing most syntax errors caused by unicode punctuation.
    try {
      let mode: 'code' | 'single' | 'double' | 'line_comment' | 'block_comment' = 'code'
      let escaped = false
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i] || ''
        const next = (i + 1 < chars.length) ? (chars[i + 1] || '') : ''

        if (mode === 'code') {
          if (ch === '/' && next === '/') {
            mode = 'line_comment'
            i += 1
            continue
          }
          if (ch === '/' && next === '*') {
            mode = 'block_comment'
            i += 1
            continue
          }
          if (ch === "'") {
            mode = 'single'
            escaped = false
            continue
          }
          if (ch === '"') {
            mode = 'double'
            escaped = false
            continue
          }
          mark[i] = true
          continue
        }

        if (mode === 'line_comment') {
          if (ch === '\n') mode = 'code'
          continue
        }

        if (mode === 'block_comment') {
          if (ch === '*' && next === '/') {
            mode = 'code'
            i += 1
          }
          continue
        }

        // string modes
        if (escaped) {
          escaped = false
          continue
        }
        if (ch === '\\') {
          escaped = true
          continue
        }
        if (mode === 'single' && ch === "'") {
          mode = 'code'
          continue
        }
        if (mode === 'double' && ch === '"') {
          mode = 'code'
          continue
        }
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/js-macro-executor.ts', e)
    }

    let replacedOutside = 0
    for (let i = 0; i < chars.length; i++) {
      if (!mark[i]) continue
      const ch = chars[i] || ''
      if (!shouldReplace(ch)) continue
      chars[i] = repl[ch] as any
      replacedOutside += 1
    }
    if (replacedOutside > 0) {
      out = chars.join('')
      changed = true
      notes.push(`normalized unicode punctuation outside strings (${replacedOutside})`)
    }

    // Remove other control characters except common whitespace (\\t,\\n,\\r).
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(out)) {
      out = out.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      changed = true
      notes.push('removed ASCII control characters')
    }

    return { code: out, changed, notes }
  }

  setContext(sessionId: string, documentName: string, hostApp?: 'wps' | 'et' | 'wpp' | 'unknown') {
    this.sessionId = sessionId

    this.documentName = documentName

    this.hostApp = hostApp || 'unknown'

    logger.info('会话上下文已设置', { sessionId, documentName, hostApp: this.hostApp })

  }



  /**

   * Vibe Coding风格生成 JS 宏代码（流式可视化）

   */

  async generateCodeWithVibeCoding(

    query: string,

    onStep: (step: VisualStep) => void,

    onProgress?: (progress: { current: number; total: number; phase: string }) => void

  ): Promise<{ code: string; success: boolean; attemptCount: number }> {

    try {

      const cfg = getRuntimeConfig()

      const capabilities = wpsBridge.getCapabilities(false)

      const response = await fetch(`${cfg.apiBase}/agentic/js-macro/vibe-coding/stream`, {

        method: 'POST',

        headers: {

          'Content-Type': 'application/json',

          ...(cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {})

        },

        body: JSON.stringify({

          user_query: query,

          session_id: this.sessionId,

          document_name: this.documentName,

          host_app: this.hostApp,

          capabilities

        })

      })



      if (!response.ok) {

        throw new Error(`HTTP error! status: ${response.status}`)

      }



      const reader = response.body?.getReader()

      if (!reader) {

        throw new Error('No response body')

      }



      const decoder = new TextDecoder()

      let buffer = ''

      let finalCode = ''

      let attemptCount = 0

      let success = false



      while (true) {

        const { done, value } = await reader.read()

        if (done) break



        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')

        buffer = lines.pop() || ''



        for (const line of lines) {

          if (line.startsWith('data: ')) {

            const dataStr = line.slice(6)

            if (dataStr === '[DONE]') {

              continue

            }



            try {

              if (dataStr.length > this.MAX_STREAM_EVENT_CHARS) {
                this.warnJsonBoundaryOnce(
                  'vibe_sse_event_too_large',
                  `[vibe_sse_event] payload too large (${dataStr.length}); event skipped`
                )
                continue
              }

              const event = this.safeJsonParse(
                dataStr,
                'vibe_sse_event',
                this.MAX_STREAM_EVENT_CHARS
              ) as VibeCodingEvent | null
              if (!event || typeof event !== 'object') {
                continue
              }



              if (event.type === 'visual_step' && event.step) {

                // 处理可视化步骤

                onStep(event.step)



                // 更新进度

                if (onProgress) {

                  onProgress({

                    current: event.step.timestamp,

                    total: 100,

                    phase: this.getPhaseDisplayName(event.step.type)

                  })

                }

              } else if (event.type === 'final_result' && event.result) {

                // 最终结果

                const rawCode = String((event as any)?.result?.code || '')
                if (rawCode.length > this.MAX_STREAM_CONTENT_CHARS) {
                  this.warnJsonBoundaryOnce(
                    'vibe_final_code_too_large',
                    `[vibe_final_code] too large (${rawCode.length}); truncated`
                  )
                }
                finalCode = rawCode.slice(0, this.MAX_STREAM_CONTENT_CHARS)

                attemptCount = Number((event as any)?.result?.attempt_count || 0)

                success = !!(event as any)?.result?.success

              } else if (event.type === 'error') {

                try {

                  onStep({

                    type: 'error',

                    title: 'VibeCoding 错误',

                    content: String((event as any)?.error || 'unknown error').slice(0, 2000),

                    timestamp: Date.now(),

                    status: 'error'

                  })

                } catch (e) {

                  ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/js-macro-executor.ts', e)

                }

              }

            } catch (parseError) {

              logger.warn('解析Vibe Coding事件失败:', parseError)

            }

          }

        }

      }



      return {

        code: finalCode,

        success,

        attemptCount

      }



    } catch (error) {

      logger.error('Vibe Coding生成失败:', error)

      return {

        code: '',

        success: false,

        attemptCount: 0

      }

    }

  }



  /**

   * 快速修复 JS 宏代码（不走完整 Vibe Coding 工作流）

   * 后端只返回一个可执行 JS 代码块，便于前端做自动修复循环。

   */

  async repairCode(

    code: string,

    errorType: string,

    errorMessage: string,

    attempt: number

  ): Promise<{ success: boolean; code: string; error?: string }> {

    try {

      const cfg = getRuntimeConfig()

      const capabilities = wpsBridge.getCapabilities(false)

      const response = await fetch(`${cfg.apiBase}/agentic/js-macro/repair`, {

        method: 'POST',

        headers: {

          'Content-Type': 'application/json',

          ...(cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {})

        },

        body: JSON.stringify({

          session_id: this.sessionId,

          document_name: this.documentName,

          host_app: this.hostApp,

          capabilities,

          attempt,

          error_type: errorType,

          error_message: errorMessage,

          code

        })

      })



      if (!response.ok) {

        throw new Error(`HTTP error! status: ${response.status}`)

      }



      const data = await response.json()

      return {

        success: !!data?.success,

        code: typeof data?.code === 'string' ? data.code : '',

        error: typeof data?.error === 'string' ? data.error : undefined

      }

    } catch (error) {

      return {

        success: false,

        code: '',

        error: error instanceof Error ? error.message : String(error)

      }

    }

  }



  /**

   * 生成 JS 宏代码（调用后端 LLM）- 传统方式

   */

  async generateCode(query: string): Promise<string> {

    try {

      const cfg = getRuntimeConfig()

      const response = await fetch(`${cfg.apiBase}/agentic/chat/stream?show_thoughts=false`, {

        method: 'POST',

        headers: {

          'Content-Type': 'application/json',

          ...(cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {})

        },

        body: JSON.stringify({

          message: query,

          session_id: this.sessionId,

          document_name: this.documentName,

          frontend_context: this.hostApp ? { host_app: this.hostApp } : null

        })

      })



      if (!response.ok) {

        throw new Error(`HTTP error! status: ${response.status}`)

      }



      const reader = response.body?.getReader()

      if (!reader) {

        throw new Error('No response body')

      }



      const decoder = new TextDecoder()

      let jsContent = ''



      while (true) {

        const { done, value } = await reader.read()

        if (done) break



        const chunk = decoder.decode(value, { stream: true })



        // 解析 SSE 格式，提取 content

        const lines = chunk.split('\n')

        for (const line of lines) {

          if (line.startsWith('data: ')) {

            try {

              const payload = line.slice(6)
              if (payload.length > this.MAX_STREAM_EVENT_CHARS) {
                this.warnJsonBoundaryOnce(
                  'chat_stream_event_too_large',
                  `[chat_stream_event] payload too large (${payload.length}); event skipped`
                )
                continue
              }

              const data = this.safeJsonParse(
                payload,
                'chat_stream_event',
                this.MAX_STREAM_EVENT_CHARS
              ) as any

              if (data?.content) {

                const contentPiece = String(data.content)
                if ((jsContent.length + contentPiece.length) > this.MAX_STREAM_CONTENT_CHARS) {
                  const remain = Math.max(0, this.MAX_STREAM_CONTENT_CHARS - jsContent.length)
                  if (remain > 0) {
                    jsContent += contentPiece.slice(0, remain)
                  }
                  this.warnJsonBoundaryOnce(
                    'chat_stream_content_truncated',
                    `[chat_stream_content] exceeded ${this.MAX_STREAM_CONTENT_CHARS}; truncated`
                  )
                } else {
                  jsContent += contentPiece
                }

              }

            } catch (e) {

              ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/js-macro-executor.ts', e)

              // 忽略解析错误

            }

          }

        }

      }



      // 提取 JS 代码块（支持 js 和 javascript）

      const jsMatch = jsContent.match(/```(?:js|javascript)([\s\S]*?)```/)

      if (jsMatch && jsMatch[1]) {

        return jsMatch[1].trim()

      }



      // 如果没有代码块，尝试直接返回

      return jsContent.trim()

    } catch (error) {

      logger.error('生成 JS 宏代码失败:', error)

      return `// 生成 JS 宏代码失败: ${error instanceof Error ? error.message : '未知错误'}`

    }

  }



  /**

   * 执行 JS 宏代码 - 简化版本

   */

  async executeJS(code: string, autoConfirm: boolean = true): Promise<{

    success: boolean

    message: string

    debugInfo?: any

  }> {

    const normalizeMeta: { changed: boolean; notes: string[] } = { changed: false, notes: [] }
    // Keep these for richer SyntaxError diagnostics (and to persist repro bundles server-side).
    let execCodeForDebug = ''
    let wrappedCodeForDebug = ''
    let hostForDebug: string = ''
    try {

      try {

        ;(window as any).__BID_AUDIT_OPS = []

        ;(window as any).__BID_AUDIT_BLOCK_ID = ''

        ;(window as any).__BID_AUDIT_DIAG = []

        macroCancel.reset()

      } catch (e) {

        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/js-macro-executor.ts', e)

      }



      // 检查环境

      const app = wpsBridge.getApplication()

      if (!app) {

        throw new Error('WPS Application 不可用')

      }



      const detectedHost = this.detectHostFromApplication(app)

      const host = ((this.hostApp && this.hostApp !== 'unknown') ? this.hostApp : (detectedHost || 'unknown')) as 'wps' | 'et' | 'wpp' | 'unknown'
      hostForDebug = host


      if (host === 'wps') {

        if (!app.ActiveDocument) throw new Error('请在 WPS Writer 中打开文档')

      } else if (host === 'et') {

        if (!app.ActiveWorkbook && !app.Workbooks) throw new Error('请在 WPS 表格(ET) 中打开工作簿')

      } else if (host === 'wpp') {

        if (!app.ActivePresentation && !app.Presentations) throw new Error('请在 WPS 演示(WPP) 中打开演示文稿')

      } else {

        // Fallback: accept any host, but still require at least one of the common objects.

        if (!app.ActiveDocument && !app.ActiveWorkbook && !app.ActivePresentation) {

          throw new Error('请先在 WPS 中打开一个文档/工作簿/演示文稿')

        }

      }



      // 验证代码格式

      let trimmedCode = (code || '').trim()

      if (!trimmedCode) {

        throw new Error('代码不能为空')

      }



      // If we somehow received a full markdown answer, extract the first code block.

      if (trimmedCode.includes('```')) {

        const jsFence = trimmedCode.match(/```(?:js|javascript|ts|typescript)\s*([\s\S]*?)```/i)

        if (jsFence && jsFence[1]) {

          trimmedCode = String(jsFence[1]).trim()

          normalizeMeta.changed = true

          normalizeMeta.notes.push('extracted fenced JS code block')

        } else {

          // Don't silently treat HTML/other formats as executable JS.

          const htmlFence = trimmedCode.match(/```html\s*([\s\S]*?)```/i)

          if (htmlFence) {

            throw new Error('InvalidMacroCodeType: expected a JS macro code block, got ```html```')

          }



          // A few models omit the language tag. Accept only when it still looks like JS.

          const anyFence = trimmedCode.match(/```[a-zA-Z0-9_\\-]*\s*([\s\S]*?)```/i)

          if (anyFence && anyFence[1]) {

            const candidate = String(anyFence[1]).trim()

            if (/^\\s*</.test(candidate)) {

              throw new Error('InvalidMacroCodeType: expected JS, got markup-like code block')

            }

            const seemsJs =

              /\\b(function|var|let|const|return|try|catch)\\b/.test(candidate) ||

              /\\b(window\\.Application|Application|app\\.|Selection\\b)/.test(candidate)

            if (!seemsJs) {

              throw new Error('InvalidMacroCodeType: expected a JS macro code block')

            }

            trimmedCode = candidate

            normalizeMeta.changed = true

            normalizeMeta.notes.push('extracted unlabeled fenced code block (looks like JS)')

          }

        }

      }



      // LLMs sometimes return JSON tool payloads. A top-level JSON object is not valid as a script

      // (`{\"a\":1}` starts with a block + label => SyntaxError: Unexpected token ':'). Detect early

      // and throw a clear syntax error so the auto-repair loop can fix it.

      const extractedFromJson = (() => {

        const t = trimmedCode.trim()

        if (!t) return null

        const starts = t[0]

        const ends = t[t.length - 1]

        if (!((starts === '{' && ends === '}') || (starts === '[' && ends === ']'))) return null

        try {

          const parsed = this.safeJsonParse(t, 'extract_js_from_json_payload') as any
          if (!parsed || typeof parsed !== 'object') return null

          if (parsed.schema_version === 'ah32.plan.v1') return null

          const candidates = [

            parsed?.input,

            parsed?.code,

            parsed?.js,

            parsed?.jsCode,

            parsed?.macro,

            parsed?.macroCode,

            parsed?.payload?.input,

            parsed?.payload?.code,

          ]

          for (const c of candidates) {

            if (typeof c === 'string' && c.trim()) return c.trim()

          }

          if (typeof parsed?.action === 'string' && typeof parsed?.input === 'string' && parsed.input.trim()) {

            return parsed.input.trim()

          }

        } catch (e) {

          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/js-macro-executor.ts', e)

          return null

        }

        return null

      })()

      if (extractedFromJson) {

        trimmedCode = extractedFromJson

        normalizeMeta.changed = true

        normalizeMeta.notes.push('extracted JS from JSON payload')

      }



      // If the "macro" payload is actually an Ah32 Plan JSON (common when the model mixes modes),
      // delegate to PlanExecutor instead of forcing a lossy JS repair loop.
      try {
        const planObj = this.tryExtractPlanJson(trimmedCode)
        if (planObj) {
          normalizeMeta.changed = true
          normalizeMeta.notes = Array.from(
            new Set([...(normalizeMeta.notes || []), 'detected ah32.plan.v1 payload in macro executor'])
          )

          const mod = await import('./plan-executor')
          const pe = new mod.PlanExecutor()
          const r = pe.executePlan(planObj)
          return {
            success: !!r?.success,
            message: r?.success
              ? 'Plan executed successfully (delegated from JS macro executor)'
              : `Plan execution failed (delegated from JS macro executor): ${String(r?.message || 'unknown error')}`,
            debugInfo: {
              delegated: 'plan',
              host,
              planResult: r,
              normalized: normalizeMeta.changed,
              normalizeNotes: normalizeMeta.notes,
              timestamp: new Date().toISOString()
            }
          }
        }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/js-macro-executor.ts', e)
      }

      // Normalize common non-JS characters from LLM outputs (curly quotes/fullwidth punctuation/zero-width chars).
      // These often manifest as: SyntaxError: Invalid or unexpected token

      const unicodeNormalized = this.sanitizeMacroUnicode(trimmedCode)

      if (unicodeNormalized.changed) {

        trimmedCode = unicodeNormalized.code

        normalizeMeta.changed = true

        normalizeMeta.notes = Array.from(new Set([...(normalizeMeta.notes || []), ...(unicodeNormalized.notes || [])]))

      }



      const looksLikeJson = (() => {

        const t = trimmedCode.trim()

        if (!t) return false

        const starts = t[0]

        const ends = t[t.length - 1]

        if (!((starts === '{' && ends === '}') || (starts === '[' && ends === ']'))) return false

        try {

          const parsed = this.safeJsonParse(t, 'looks_like_json_probe')

          return !!parsed

        } catch (e) {

          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/js-macro-executor.ts', e)

          return false

        }

      })()

      if (looksLikeJson) {

        try {

          const parsed = this.safeJsonParse(trimmedCode.trim(), 'looks_like_json_plan_probe') as any
          if (!parsed || typeof parsed !== 'object') {
            throw new Error('SyntaxError: 输出看起来是 JSON，但不是可执行 JS 宏代码。')
          }

          if (parsed && typeof parsed === 'object' && parsed.schema_version === 'ah32.plan.v1') {

            throw new Error(

              'SyntaxError: 杈撳嚭鐪嬭捣鏉ユ槸 Plan JSON（ah32.plan.v1），鑰屼笉鏄 JS 瀹忎唬鐮併€傝鎹㈢敤 Plan 鎵ц鍣紝鎴栬妯″瀷鍙繑鍥?JS 鑴氭湰鏈綋'

            )

          }

        } catch (e) {

          if (e instanceof Error && e.message.startsWith('SyntaxError:')) throw e

        }

        throw new Error('SyntaxError: 杈撳嚭鐪嬭捣鏉ユ槸 JSON锛岃€屼笉鏄彲鎵ц鐨?JS 瀹忎唬鐮侊紙璇峰彧杩斿洖 JS 鑴氭湰鏈綋锛屼笉瑕佽繑鍥?JSON/瑙ｉ噴锛夈€?')

      }



      const safety = checkMacroSafety(trimmedCode)

      if (!safety.ok) {

        const msg = safety.reasons.join('; ')

        throw new Error(`SecurityError: unsafe JS macro blocked: ${msg}`)

      }



      // WPS 任务窗格执行环境只支持纯 JS。后端/模型有时会返回 TypeScript 语法（如 `: any`）

      // 导致 `new Function(...)` 报 SyntaxError: Unexpected token ':'。

      // 这里做一层轻量清洗，尽量保持语义不变。

      const normalized = this.stripTypeScriptSyntax(trimmedCode)

      normalizeMeta.changed = normalizeMeta.changed || normalized.changed

      normalizeMeta.notes = Array.from(new Set([...(normalizeMeta.notes || []), ...(normalized.notes || [])]))



      // Some LLMs emit `\\n` tokens in "code" (outside of strings), e.g. `'',\\n 'next'`.

      // That's a SyntaxError. Convert a few safe patterns into real newlines before parsing.

      const escapedNl = this.normalizeEscapedNewlineTokens(normalized.code)

      if (escapedNl.changed) {

        normalizeMeta.changed = true

        normalizeMeta.notes = Array.from(new Set([...(normalizeMeta.notes || []), ...escapedNl.notes]))

      }



      // Comments are not needed for execution and sometimes carry problematic unicode that trips

      // certain embedded JS engines. Keep only @ah32:* directive comments.

      const commentStripped = this.stripNonDirectiveComments(escapedNl.code)

      if (commentStripped.changed) {

        normalizeMeta.changed = true

        normalizeMeta.notes = Array.from(new Set([...(normalizeMeta.notes || []), ...commentStripped.notes]))

      }



      // Many WPS builds ship an older JS engine that rejects ES6 declarations (let/const).

      // Converting to ES5 here avoids expensive repair loops for a very common class of SyntaxError.

      const es5 = this.downgradeLetConst(commentStripped.code)

      if (es5.changed) {

        normalizeMeta.changed = true

        normalizeMeta.notes = Array.from(new Set([...(normalizeMeta.notes || []), ...es5.notes]))

      }



      // Older embedded engines often don't support template literals. Convert them to ES5 concatenation

      // to avoid throwing + entering the repair loop for an easy-to-fix syntax issue.

      // Run a few passes to also catch nested templates inside `${ ... }` expressions.

      let templ: { code: string; changed: boolean; notes: string[] } = { code: es5.code, changed: false, notes: [] }

      for (let pass = 0; pass < 4 && this.hasTemplateLiteralDelimiter(templ.code); pass++) {

        const res = this.convertTemplateLiterals(templ.code)

        if (!res.changed) break

        templ = {

          code: res.code,

          changed: true,

          notes: Array.from(new Set([...(templ.notes || []), ...(res.notes || [])]))

        }

      }

      if (templ.changed) {

        normalizeMeta.changed = true

        normalizeMeta.notes = Array.from(new Set([...(normalizeMeta.notes || []), ...templ.notes]))

      }



      // Avoid `var BID = window.BID;` overriding our injected helper facade.

      const bidStrip = this.stripRedundantWindowBIDAssignment(templ.code)

      if (bidStrip.changed) {

        normalizeMeta.changed = true

        normalizeMeta.notes = Array.from(new Set([...(normalizeMeta.notes || []), ...bidStrip.notes]))

      }



      // Writer-specific deterministic fixes for common API mistakes (reduce repair loops).

      const writerCompat =

        host === 'wps'

          ? this.normalizeWriterConvenience(bidStrip.code)

          : { code: bidStrip.code, changed: false, notes: [] }

      if (writerCompat.changed) {

        normalizeMeta.changed = true

        normalizeMeta.notes = Array.from(new Set([...(normalizeMeta.notes || []), ...writerCompat.notes]))

      }



      // Deterministic host-specific rewrites that reduce frequent runtime errors

      // without involving the LLM. Must be conservative and observable.

      const hostCompat = this.normalizeHostCollections(writerCompat.code, host)

      if (hostCompat.changed) {

        normalizeMeta.changed = true

        normalizeMeta.notes = Array.from(new Set([...(normalizeMeta.notes || []), ...hostCompat.notes]))

      }



      // Some WPS builds don't expose `app.Alert` (and similar UI prompts) in TaskPane JS.

      // Downgrade these calls deterministically to avoid failing the whole macro at the end.

      const alertCompat = this.normalizeHostAlerts(hostCompat.code)

      if (alertCompat.changed) {

        normalizeMeta.changed = true

        normalizeMeta.notes = Array.from(new Set([...(normalizeMeta.notes || []), ...alertCompat.notes]))

      }



      let execCode = alertCompat.code

      // Some WPS runtimes are extremely picky about invisible/unicode separators and "smart quotes".
      // Sanitize deterministically before passing into `new Function(...)`.
      const sanitized = this.sanitizeMacroSource(execCode)
      if (sanitized.changed) {
        normalizeMeta.changed = true
        normalizeMeta.notes = Array.from(new Set([...(normalizeMeta.notes || []), ...(sanitized.notes || [])]))
        execCode = sanitized.code
      }

      execCodeForDebug = execCode


      // If the model still leaked backticks, fail fast with a clear error so the repair loop fixes it.

      // NOTE: Backticks can appear inside normal strings/comments (harmless). Only block real template literals.

      if (this.hasTemplateLiteralDelimiter(execCode)) {

        throw new Error("SyntaxError: 检测到模板字符串(反引号 `)。请改用字符串拼接。")

      }



      // If the model still used ES6+ constructs, fail fast with a clear error so the repair loop fixes it.

      if (/\basync\b|\bawait\b|\bclass\b/.test(execCode)) {

        throw new Error('SyntaxError: 检测到 ES6+ 语法(async/await/class)。请仅使用 ES5（var/function/for/try-catch）。')

      }

      if (execCode.includes('=>')) {

        throw new Error('SyntaxError: 检测到箭头函数(=>)。请改用 function() {} 语法（ES5）。')

      }



      // Guard: some model outputs are plain text (steps/analysis) without actual macro code.

      // Failing fast avoids wasting repair loops on obviously-non-code payloads.

      if (!this.isJSMacro(execCode)) {

        throw new Error(

          'SyntaxError: 输出看起来不是可执行的 WPS JS 宏代码。请只返回 ```javascript``` 代码块（不要返回解释/阶段文本）。'

        )

      }



      // 构建执行上下文

      const wpsObj = (window as any).WPS || {

        GetApplication: () => app

      }



      // 包装代码为可执行函数

      const wrappedRaw = this.wrapCode(execCode, host)
      // Sanitize the *wrapped* code too (preamble included). Some WPS runtimes are picky about
      // unicode whitespace / directional marks and will throw SyntaxError: Invalid or unexpected token.
      const wrappedSanitized = this.sanitizeMacroUnicode(wrappedRaw)
      if (wrappedSanitized.changed) {
        normalizeMeta.changed = true
        normalizeMeta.notes = Array.from(new Set([...(normalizeMeta.notes || []), ...(wrappedSanitized.notes || [])]))
      }
      const wrappedCode = wrappedSanitized.code
      wrappedCodeForDebug = wrappedCode
      const func = new Function('WPS', 'app', wrappedCode)



      // 执行代码

      const result = func(wpsObj, app)



      // Post-check: if we used BID.upsertBlock, we expect a materialized block anchor to exist.

      // Some macros "run" but do not write anything; treat that as failure so auto-repair can fix it.

      try {

        const ops = Array.isArray((window as any).__BID_AUDIT_OPS) ? (window as any).__BID_AUDIT_OPS : []

        const blockId = String((window as any).__BID_AUDIT_BLOCK_ID || '')

        const usedUpsert = ops.some((x: any) => String(x || '') === 'upsertBlock')

        if (usedUpsert && blockId && (window as any).BID && typeof (window as any).BID.blockExists === 'function') {

          const ok = !!(window as any).BID.blockExists(blockId)

          if (!ok) {

            return {

              success: false,

              message: `JS 宏执行失败：NoContentInserted: block_not_found (${blockId})`,

              debugInfo: {

                name: 'NoContentInserted',

                message: `block_not_found (${blockId})`,

                result,

                macroDiag: (() => {
                  try {
                    const d = (window as any).__BID_AUDIT_DIAG
                    if (Array.isArray(d) && d.length) return d.slice(0, 80)
                  } catch (e) {
                    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/js-macro-executor.ts', e)
                  }
                  return undefined
                })(),

                normalized: normalizeMeta.changed,

                normalizeNotes: normalizeMeta.notes,

                timestamp: new Date().toISOString()

              }

            }

          }

        }

      } catch (e) {

        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/js-macro-executor.ts', e)

      }



      try {

        const hostApp = host

        const sid = String(this.sessionId || '')

        const blockId = String((window as any).__BID_AUDIT_BLOCK_ID || '')

        const ops = Array.isArray((window as any).__BID_AUDIT_OPS) ? (window as any).__BID_AUDIT_OPS : []

        void reportAuditEvent({

          mode: 'js',

          session_id: sid,

          host_app: hostApp,

          block_id: blockId,

          ops: Array.from(new Set(ops.map((x: any) => String(x || '')).filter(Boolean))),

          success: true

        })

      } catch (e) {

        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/js-macro-executor.ts', e)

      }



      return {

        success: true,

        message: 'JS 宏代码执行成功',

        debugInfo: {

          executed: true,

          macroDiag: (() => {
            try {
              const d = (window as any).__BID_AUDIT_DIAG
              if (Array.isArray(d) && d.length) return d.slice(0, 80)
            } catch (e) {
              ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/js-macro-executor.ts', e)
            }
            return undefined
          })(),

          normalized: normalizeMeta.changed,

          normalizeNotes: normalizeMeta.notes,

          suspiciousCharsWrapped: (() => {

            try {

              if (!wrappedCodeForDebug) return undefined

              if ((name === 'SyntaxError' || msg.includes('SyntaxError')) && /Invalid or unexpected token/i.test(msg)) {

                return this.findSuspiciousChars(String(wrappedCodeForDebug || '')).slice(0, 12)

              }

            } catch (e) {

              ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/js-macro-executor.ts', e)

            }

            return undefined

          })(),

          timestamp: new Date().toISOString()
        }

      }



    } catch (error) {

      logger.error('JS 宏执行失败:', error)

      const err: any = error

      const name = typeof err?.name === 'string' ? err.name : ''

      const msg = typeof err?.message === 'string' ? err.message : String(error)



      // Heuristic hint for common LLM output corruption.

      try {

        if ((name === 'SyntaxError' || msg.includes('SyntaxError')) && /Invalid or unexpected token/i.test(msg)) {

          const suspicious = this.findSuspiciousChars(String(code || ''))
            .concat(wrappedCodeForDebug ? this.findSuspiciousChars(String(wrappedCodeForDebug || '')) : [])
            .slice(0, 50)
          if (suspicious.length > 0) {

            normalizeMeta.changed = true

            normalizeMeta.notes = Array.from(new Set([...(normalizeMeta.notes || []), 'found suspicious unicode characters']))

          }

        }

      } catch (e) {

        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/js-macro-executor.ts', e)

      }

      try {

        const hostApp = String(this.hostApp || 'unknown')

        const sid = String(this.sessionId || '')

        const blockId = String((window as any).__BID_AUDIT_BLOCK_ID || '')

        const ops = Array.isArray((window as any).__BID_AUDIT_OPS) ? (window as any).__BID_AUDIT_OPS : []

        void reportAuditEvent({

          mode: 'js',

          session_id: sid,

          host_app: hostApp,

          block_id: blockId,

          ops: Array.from(new Set(ops.map((x: any) => String(x || '')).filter(Boolean))),

          success: false,

          error_type: name || 'execution_error',

          error_message: msg

        })

      } catch (e) {

        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/js-macro-executor.ts', e)

      }

      return {

        success: false,

        message: `JS 宏执行失败：${name ? `${name}: ` : ''}${msg}`,

        debugInfo: {

          name,

          message: msg,

          stack: typeof err?.stack === 'string' ? err.stack : undefined,
          host: hostForDebug,
          execCodeLen: execCodeForDebug ? execCodeForDebug.length : undefined,
          wrappedCodeLen: wrappedCodeForDebug ? wrappedCodeForDebug.length : undefined,
          wrappedCodePreview: wrappedCodeForDebug ? wrappedCodeForDebug.slice(0, 600) : undefined,
          macroDiag: (() => {
            try {
              const d = (window as any).__BID_AUDIT_DIAG
              if (Array.isArray(d) && d.length) return d.slice(0, 80)
            } catch (e) {
              ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/js-macro-executor.ts', e)
            }
            return undefined
          })(),
          normalized: normalizeMeta.changed,

          normalizeNotes: normalizeMeta.notes,

          suspiciousChars: (() => {

            try {

              if ((name === 'SyntaxError' || msg.includes('SyntaxError')) && /Invalid or unexpected token/i.test(msg)) {

                return this.findSuspiciousChars(String(code || '')).slice(0, 12)

              }

            } catch (e) {

              ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/js-macro-executor.ts', e)

            }

            return undefined

          })(),

          timestamp: new Date().toISOString()

        }

      }

    }

  }



  private tryExtractPlanJson(raw: string): any | null {
    try {
      const s = String(raw || '')
      if (!/\"schema_version\"\\s*:\\s*\"ah32\\.plan\\.v1\"/.test(s)) return null

      // Fast path: direct JSON parse when it looks like a full JSON object/array.
      const t = s.trim()
      if (t.length > this.MAX_JSON_PARSE_CHARS) {
        this.warnJsonBoundaryOnce(
          'plan_json_too_large',
          `[extract_plan_json] payload too large (${t.length}); skip parse`
        )
        return null
      }
      if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
        const obj = this.safeJsonParse(t, 'extract_plan_json_direct') as any
        if (!obj || typeof obj !== 'object') return null
        if (obj && typeof obj === 'object' && obj.schema_version === 'ah32.plan.v1') return obj
      }

      // Recovery path: extract the outermost {...} block (handles `on\\n{...}` and other wrappers).
      const first = s.indexOf('{')
      const last = s.lastIndexOf('}')
      if (first < 0 || last <= first) return null
      const candidate = s.slice(first, last + 1).trim()
      if (candidate.length > this.MAX_JSON_PARSE_CHARS) {
        this.warnJsonBoundaryOnce(
          'plan_json_candidate_too_large',
          `[extract_plan_json_candidate] payload too large (${candidate.length}); skip parse`
        )
        return null
      }
      const obj = this.safeJsonParse(candidate, 'extract_plan_json_candidate') as any
      if (!obj || typeof obj !== 'object') return null
      if (obj && typeof obj === 'object' && obj.schema_version === 'ah32.plan.v1') return obj
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/js-macro-executor.ts', e)
      return null
    }
    return null
  }

  private sanitizeMacroUnicode(code: string): { code: string; changed: boolean; notes: string[] } {
    let out = String(code || '')

    const notes: string[] = []

    let changed = false



    // Remove BOM + common zero-width chars that can break parsing.

    const before = out

    out = out

      .replace(/\uFEFF/g, '') // BOM / zero width no-break space

      .replace(/[\u200B\u200C\u200D\u2060]/g, '') // zero-width spaces/joiners

      // Directional marks / isolates that sometimes leak from copy/paste and break older engines.

      .replace(/[\u200E\u200F]/g, '')

      .replace(/[\u202A-\u202E]/g, '')

      .replace(/[\u2066-\u2069]/g, '')

      .replace(/\u00AD/g, '') // soft hyphen

      .replace(/[\u2028\u2029]/g, '\n') // line/paragraph separators
      .replace(/\u3000/g, ' ') // ideographic space
      .replace(/\u00A0/g, ' ') // no-break space (NBSP)
      .replace(/[\u1680\u2000-\u200A\u202F\u205F]/g, ' ') // other unicode spaces
      // Remove other control characters (keep \t \n \r).
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/[\u007F-\u009F]/g, '') // DEL + C1 controls
    if (out !== before) {

      changed = true

      notes.push('removed zero-width/BOM/line-separator characters')

    }



    // Replace curly quotes / fullwidth punctuation outside strings/comments (best-effort).

    // This targets common model outputs that are not valid JS tokens, e.g. `“text”` or `（1，2）`.

    const src = out

    const buf: string[] = []

    type Mode = 'normal' | 'single' | 'double' | 'template' | 'regex' | 'line_comment' | 'block_comment'
    let mode: Mode = 'normal'

    let templateExprDepth = 0
    let regexInCharClass = false
    let regexEscaped = false

    const prevNonWs = () => {
      for (let k = buf.length - 1; k >= 0; k--) {
        const c = buf[k]
        if (c !== ' ' && c !== '\t' && c !== '\r' && c !== '\n') return c
      }
      return ''
    }

    const mayStartRegexLiteral = (prev: string) => {
      // Best-effort heuristic: treat `/.../` as a regex literal only when it appears in a position
      // where an expression can start. This avoids breaking division like `a / b`.
      if (!prev) return true
      return '([,{=:+-!&|?;*%^~<>'.includes(prev)
    }


    const mapChar = (ch: string) => {

      switch (ch) {

        case '“':

        case '”':

        case '„':

        case '‟':

        case '«':

        case '»':

        case '「':

        case '」':

        case '＂':

          return '"'

        case '‘':

        case '’':

        case '‚':

        case '‛':

        case '‹':

        case '›':

        case '＇':

          return '\''

        case '（':

          return '('

        case '）':

          return ')'

        case '【':

          return '['

        case '】':

          return ']'

        case '［':

          return '['

        case '］':

          return ']'

        case '｛':

          return '{'

        case '｝':

          return '}'

        case '，':

        case '、':

          return ','

        case '；':

          return ';'

        case '：':

          return ':'

        case '＝':

          return '='

        case '＋':

          return '+'

        case '－':

        case '–': // en dash

        case '—': // em dash

        case '−': // minus sign

          return '-'

        case '＊':
          return '*'
        case '×':
          return '*'
        case '／':
          return '/'
        case '÷':
          return '/'
        case '＼':
          return '\\'
        case '＜':
          return '<'
        case '＞':
          return '>'
        case '＆':
          return '&'
        case '｜':
          return '|'
        case '＾':
          return '^'
        case '～':
          return '~'
        case '％':
          return '%'
        case '＃':
          return '#'
        case '＠':
          return '@'
        case '＄':
          return '$'
        case '！':
          return '!'
        case '？':
          return '?'
        case '．':
        case '。':
          return '.'
        case '·':
          return '.'
        default:
          return ch
      }
    }


    let escapedStringNewlines = false



    for (let i = 0; i < src.length; i++) {

      const ch = src[i]

      const next = i + 1 < src.length ? src[i + 1] : ''



      if (mode === 'line_comment') {
        buf.push(ch)
        if (ch === '\n' || ch === '\r') mode = 'normal'
        continue
      }


      if (mode === 'block_comment') {

        buf.push(ch)

        if (ch === '*' && next === '/') {

          buf.push(next)

          i++

          mode = 'normal'

        }

        continue

      }



      if (mode === 'regex') {
        buf.push(ch)

        if (regexEscaped) {
          regexEscaped = false
          continue
        }
        if (ch === '\\') {
          regexEscaped = true
          continue
        }
        if (ch === '[') {
          regexInCharClass = true
          continue
        }
        if (ch === ']' && regexInCharClass) {
          regexInCharClass = false
          continue
        }
        if (ch === '/' && !regexInCharClass) {
          // End of regex literal. Consume trailing flags (e.g. /re/gim).
          mode = 'normal'
          regexEscaped = false
          regexInCharClass = false
          while (i + 1 < src.length && /[a-z]/i.test(src[i + 1])) {
            buf.push(src[i + 1])
            i++
          }
          continue
        }

        continue
      }

      if (mode === 'single') {
        if (ch === '\n' || ch === '\r') {

          // Unescaped newlines inside quotes are a SyntaxError; convert to `\\n` best-effort.

          changed = true

          if (!escapedStringNewlines) {

            escapedStringNewlines = true

            notes.push('escaped literal newlines inside string literals')

          }

          buf.push('\\n')

          if (ch === '\r' && next === '\n') i++

          continue

        }



        buf.push(ch)

        if (ch === '\\\\') {

          if (i + 1 < src.length) {

            buf.push(src[i + 1])

            i++

          }

          continue

        }

        if (ch === '\'') mode = 'normal'

        continue

      }



      if (mode === 'double') {

        if (ch === '\n' || ch === '\r') {

          // Unescaped newlines inside quotes are a SyntaxError; convert to `\\n` best-effort.

          changed = true

          if (!escapedStringNewlines) {

            escapedStringNewlines = true

            notes.push('escaped literal newlines inside string literals')

          }

          buf.push('\\n')

          if (ch === '\r' && next === '\n') i++

          continue

        }



        buf.push(ch)

        if (ch === '\\\\') {

          if (i + 1 < src.length) {

            buf.push(src[i + 1])

            i++

          }

          continue

        }

        if (ch === '"') mode = 'normal'

        continue

      }



      if (mode === 'template') {

        buf.push(ch)

        if (ch === '\\\\') {

          if (i + 1 < src.length) {

            buf.push(src[i + 1])

            i++

          }

          continue

        }

        if (ch === '`') mode = 'normal'

        if (ch === '$' && next === '{') {

          buf.push(next)

          i++

          mode = 'normal'

          templateExprDepth = 1

        }

        continue

      }



      // normal

      if (templateExprDepth > 0) {

        if (ch === '{') templateExprDepth++

        else if (ch === '}') templateExprDepth--

        if (templateExprDepth === 0) {

          buf.push(ch)

          mode = 'template'

          continue

        }

      }



      // Best-effort regex literal detection: prevent punctuation normalization inside `/.../`.
      // Without this, we may turn a valid pattern into an invalid one (e.g. mapping `×` -> `*`).
      if (ch === '/' && next !== '/' && next !== '*') {
        const prev = prevNonWs()
        if (mayStartRegexLiteral(prev)) {
          buf.push(ch)
          mode = 'regex'
          regexInCharClass = false
          regexEscaped = false
          continue
        }
      }

      if (ch === '/' && next === '/') {
        buf.push(ch, next)

        i++

        mode = 'line_comment'

        continue

      }

      if (ch === '/' && next === '*') {

        buf.push(ch, next)

        i++

        mode = 'block_comment'

        continue

      }

      if (ch === '\'') {

        buf.push(ch)

        mode = 'single'

        continue

      }

      if (ch === '"') {

        buf.push(ch)

        mode = 'double'

        continue

      }

      if (ch === '`') {

        buf.push(ch)

        mode = 'template'

        continue

      }


      // Regex literal detection (best-effort). This prevents unicode punctuation normalization
      // from corrupting regex patterns inside the injected preamble (e.g. `×` -> `*`).
      if (ch === '/' && next !== '/' && next !== '*') {
        const prev = prevNonWs()
        if (mayStartRegexLiteral(prev)) {
          buf.push(ch)
          mode = 'regex'
          regexInCharClass = false
          regexEscaped = false
          continue
        }
      }

      const mapped = mapChar(ch)
      if (mapped !== ch) changed = true

      buf.push(mapped)

    }



    const mappedOut = buf.join('')

    if (mappedOut !== out) {

      out = mappedOut

      notes.push('normalized curly quotes/fullwidth punctuation')

    }



    // Strip Markdown fenced code markers that often leak into "inserted content" strings and break template literals.

    // This is intentionally broad: fences are rarely needed in macros and are a common source of SyntaxError.

    const beforeFence = out

    out = out.replace(/```[a-zA-Z0-9_\-]*\s*/g, '')

    if (out !== beforeFence) {

      changed = true

      notes.push('stripped markdown code fences')

    }



    return { code: out, changed, notes: Array.from(new Set(notes)) }

  }



  private stripNonDirectiveComments(code: string): { code: string; changed: boolean; notes: string[] } {

    const src = String(code || '')

    const buf: string[] = []

    let changed = false



    type Mode = 'normal' | 'single' | 'double' | 'template'

    let mode: Mode = 'normal'

    let templateExprDepth = 0



    const keepLineComment = (line: string) => /^\s*\/\/\s*@ah32:/i.test(line)



    for (let i = 0; i < src.length; i++) {

      const ch = src[i]

      const next = i + 1 < src.length ? src[i + 1] : ''



      if (mode === 'single') {

        buf.push(ch)

        if (ch === '\\\\') {

          if (i + 1 < src.length) {

            buf.push(src[i + 1])

            i++

          }

          continue

        }

        if (ch === '\'') mode = 'normal'

        continue

      }

      if (mode === 'double') {

        buf.push(ch)

        if (ch === '\\\\') {

          if (i + 1 < src.length) {

            buf.push(src[i + 1])

            i++

          }

          continue

        }

        if (ch === '"') mode = 'normal'

        continue

      }

      if (mode === 'template') {

        buf.push(ch)

        if (ch === '\\\\') {

          if (i + 1 < src.length) {

            buf.push(src[i + 1])

            i++

          }

          continue

        }

        if (ch === '`') mode = 'normal'

        if (ch === '$' && next === '{') {

          buf.push(next)

          i++

          mode = 'normal'

          templateExprDepth = 1

        }

        continue

      }



      // normal (incl template expressions)

      if (templateExprDepth > 0) {

        buf.push(ch)

        if (ch === '{') templateExprDepth++

        else if (ch === '}') templateExprDepth--

        if (templateExprDepth === 0) mode = 'template'

        continue

      }



      if (ch === '/' && next === '/') {

        const start = i
        let j = i + 2
        while (j < src.length && src[j] !== '\n' && src[j] !== '\r') j++
        const line = src.slice(start, j)
        if (keepLineComment(line)) {
          buf.push(line)
        } else {
          changed = true

          // Keep a single space so tokens stay separated.

          buf.push(' ')

        }

        i = j - 1

        continue

      }

      if (ch === '/' && next === '*') {

        // Remove block comments entirely.

        changed = true

        let j = i + 2

        while (j + 1 < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++

        // Preserve newlines count for better stack traces.

        const chunk = src.slice(i, Math.min(src.length, j + 2))

        const newlines = chunk.match(/\n/g)?.length || 0

        if (newlines > 0) buf.push('\n'.repeat(newlines))

        else buf.push(' ')

        i = Math.min(src.length, j + 2) - 1

        continue

      }



      if (ch === '\'') {

        buf.push(ch)

        mode = 'single'

        continue

      }

      if (ch === '"') {

        buf.push(ch)

        mode = 'double'

        continue

      }

      if (ch === '`') {

        buf.push(ch)

        mode = 'template'

        continue

      }



      buf.push(ch)

    }



    const out = buf.join('')

    if (!changed) return { code: src, changed: false, notes: [] }

    return { code: out, changed: true, notes: ['stripped non-directive comments'] }

  }



  private stripRedundantWindowBIDAssignment(code: string): {

    code: string

    changed: boolean

    notes: string[]

  } {

    // Some model outputs do `var BID = window.BID;`. In our runtime `BID` is already injected as a global

    // variable; the redundant assignment can break execution when `window.BID` is missing/undefined.

    const src = String(code || '')

    const re = /^\s*(?:var|let|const)\s+BID\s*=\s*window\.BID\s*;\s*$/gm

    const out = src.replace(re, ' ')

    if (out === src) return { code: src, changed: false, notes: [] }

    return { code: out, changed: true, notes: ['stripped redundant `var BID = window.BID;`'] }

  }



  private downgradeLetConst(code: string): { code: string; changed: boolean; notes: string[] } {

    // Convert ES6 declarations to ES5 (`var`) while respecting strings/comments.

    // This targets the most frequent WPS embedded engine parse failures with minimal semantics impact.

    const src = String(code || '')

    let changed = false



    type Mode = 'normal' | 'single' | 'double' | 'template' | 'line_comment' | 'block_comment'

    let mode: Mode = 'normal'



    const out: string[] = []

    const isIdentStart = (ch: string) => /[A-Za-z_$\u4e00-\u9fa5]/.test(ch)

    const isIdent = (ch: string) => /[A-Za-z0-9_$\u4e00-\u9fa5]/.test(ch)



    for (let i = 0; i < src.length; i++) {

      const ch = src[i]

      const next = src[i + 1] || ''



      if (mode === 'line_comment') {
        out.push(ch)
        if (ch === '\n' || ch === '\r') mode = 'normal'
        continue
      }
      if (mode === 'block_comment') {

        out.push(ch)

        if (ch === '*' && next === '/') {

          out.push(next)

          i++

          mode = 'normal'

        }

        continue

      }

      if (mode === 'single') {

        out.push(ch)

        if (ch === '\\\\') {

          out.push(next)

          i++

          continue

        }

        if (ch === '\'') mode = 'normal'

        continue

      }

      if (mode === 'double') {

        out.push(ch)

        if (ch === '\\\\') {

          out.push(next)

          i++

          continue

        }

        if (ch === '"') mode = 'normal'

        continue

      }

      if (mode === 'template') {

        out.push(ch)

        if (ch === '\\\\') {

          out.push(next)

          i++

          continue

        }

        if (ch === '`') mode = 'normal'

        continue

      }



      // normal

      if (ch === '/' && next === '/') {

        out.push(ch, next)

        i++

        mode = 'line_comment'

        continue

      }

      if (ch === '/' && next === '*') {

        out.push(ch, next)

        i++

        mode = 'block_comment'

        continue

      }

      if (ch === '\'') {

        out.push(ch)

        mode = 'single'

        continue

      }

      if (ch === '"') {

        out.push(ch)

        mode = 'double'

        continue

      }

      if (ch === '`') {

        out.push(ch)

        mode = 'template'

        continue

      }



      if (isIdentStart(ch)) {

        let j = i

        while (j < src.length && isIdent(src[j])) j++

        const ident = src.slice(i, j)

        if (ident === 'let' || ident === 'const') {

          // Replace keyword token with `var`.

          out.push('var')

          changed = true

          i = j - 1

          continue

        }

        out.push(ident)

        i = j - 1

        continue

      }



      out.push(ch)

    }



    if (!changed) return { code: src, changed: false, notes: [] }

    return { code: out.join(''), changed: true, notes: ['downgraded let/const to var'] }

  }



  private hasTemplateLiteralDelimiter(code: string): boolean {

    const src = String(code || '')

    if (!src.includes('`')) return false



    type Mode = 'normal' | 'single' | 'double' | 'line_comment' | 'block_comment'

    let mode: Mode = 'normal'



    for (let i = 0; i < src.length; i++) {

      const ch = src[i]

      const next = i + 1 < src.length ? src[i + 1] : ''



      if (mode === 'line_comment') {
        if (ch === '\n' || ch === '\r') mode = 'normal'
        continue
      }
      if (mode === 'block_comment') {

        if (ch === '*' && next === '/') {

          i++

          mode = 'normal'

        }

        continue

      }

      if (mode === 'single') {

        if (ch === '\\\\') {

          i++

          continue

        }

        if (ch === '\'') mode = 'normal'

        continue

      }

      if (mode === 'double') {

        if (ch === '\\\\') {

          i++

          continue

        }

        if (ch === '"') mode = 'normal'

        continue

      }



      // mode === normal

      if (ch === '/' && next === '/') {

        i++

        mode = 'line_comment'

        continue

      }

      if (ch === '/' && next === '*') {

        i++

        mode = 'block_comment'

        continue

      }

      if (ch === '\'') {

        mode = 'single'

        continue

      }

      if (ch === '"') {

        mode = 'double'

        continue

      }

      if (ch === '`') return true

    }



    return false

  }



  private convertTemplateLiterals(code: string): { code: string; changed: boolean; notes: string[] } {

    const src = String(code || '')

    if (!src.includes('`')) return { code: src, changed: false, notes: [] }



    type Mode = 'normal' | 'single' | 'double' | 'line_comment' | 'block_comment'

    let mode: Mode = 'normal'



    const out: string[] = []

    let changed = false

    let noted = false



    const asSingleQuoted = (s: string) => {

      // Make a JS single-quoted string literal that doesn't contain literal newlines.

      return (

        '\'' +

        s

          .replace(/\\/g, '\\\\')

          .replace(/'/g, "\\'")

          .replace(/\r\n/g, '\n')

          .replace(/\r/g, '\n')

          .replace(/\n/g, '\\n') +

        '\''

      )

    }



    const buildConcat = (parts: Array<{ t: 'text' | 'expr'; v: string }>) => {

      const toks: string[] = []

      for (const p of parts) {

        if (p.t === 'text') {

          if (p.v) toks.push(asSingleQuoted(p.v))

        } else {

          const e = String(p.v || '').trim()

          if (e) toks.push(`(${e})`)

        }

      }

      if (toks.length === 0) return "''"

      return toks.join(' + ')

    }



    const readTemplateLiteral = (i: number): { end: number; replacement: string } | null => {

      // src[i] === '`'

      let j = i + 1

      let text = ''

      const parts: Array<{ t: 'text' | 'expr'; v: string }> = []



      const pushText = () => {

        if (text) {

          parts.push({ t: 'text', v: text })

          text = ''

        }

      }



      while (j < src.length) {

        const ch = src[j]

        const next = j + 1 < src.length ? src[j + 1] : ''



        if (ch === '\\\\') {

          // Keep escapes as-is in the raw text portion.

          text += ch

          if (j + 1 < src.length) {

            text += src[j + 1]

            j += 2

            continue

          }

          j++

          continue

        }



        if (ch === '`') {

          pushText()

          const replacement = buildConcat(parts)

          return { end: j, replacement }

        }



        if (ch === '$' && next === '{') {

          pushText()

          j += 2



          // Parse `${ ... }` with a small brace counter and basic string/comment skipping.

          let depth = 1

          let expr = ''

          type ExprMode = 'normal' | 'single' | 'double' | 'line_comment' | 'block_comment'

          let em: ExprMode = 'normal'



          while (j < src.length) {

            const c = src[j]

            const n2 = j + 1 < src.length ? src[j + 1] : ''



            if (em === 'line_comment') {

              expr += c

              j++

              if (c === '\n') em = 'normal'

              continue

            }

            if (em === 'block_comment') {

              expr += c

              if (c === '*' && n2 === '/') {

                expr += n2

                j += 2

                em = 'normal'

                continue

              }

              j++

              continue

            }

            if (em === 'single') {

              expr += c

              j++

              if (c === '\\\\' && j < src.length) {

                expr += src[j]

                j++

                continue

              }

              if (c === '\'') em = 'normal'

              continue

            }

            if (em === 'double') {

              expr += c

              j++

              if (c === '\\\\' && j < src.length) {

                expr += src[j]

                j++

                continue

              }

              if (c === '\"') em = 'normal'

              continue

            }



            // em === normal

            if (c === '/' && n2 === '/') {

              expr += c + n2

              j += 2

              em = 'line_comment'

              continue

            }

            if (c === '/' && n2 === '*') {

              expr += c + n2

              j += 2

              em = 'block_comment'

              continue

            }

            if (c === '\'') {

              expr += c

              j++

              em = 'single'

              continue

            }

            if (c === '\"') {

              expr += c

              j++

              em = 'double'

              continue

            }



            if (c === '{') depth++

            else if (c === '}') depth--



            if (depth === 0) {

              j++

              break

            }



            expr += c

            j++

          }



          parts.push({ t: 'expr', v: expr })

          continue

        }



        text += ch

        j++

      }



      return null

    }



    for (let i = 0; i < src.length; i++) {

      const ch = src[i]

      const next = i + 1 < src.length ? src[i + 1] : ''



      if (mode === 'line_comment') {
        out.push(ch)
        if (ch === '\n' || ch === '\r') mode = 'normal'
        continue
      }
      if (mode === 'block_comment') {

        out.push(ch)

        if (ch === '*' && next === '/') {

          out.push(next)

          i++

          mode = 'normal'

        }

        continue

      }

      if (mode === 'single') {

        out.push(ch)

        if (ch === '\\\\') {

          out.push(next)

          i++

          continue

        }

        if (ch === '\'') mode = 'normal'

        continue

      }

      if (mode === 'double') {

        out.push(ch)

        if (ch === '\\\\') {

          out.push(next)

          i++

          continue

        }

        if (ch === '\"') mode = 'normal'

        continue

      }



      // normal

      if (ch === '/' && next === '/') {

        out.push(ch, next)

        i++

        mode = 'line_comment'

        continue

      }

      if (ch === '/' && next === '*') {

        out.push(ch, next)

        i++

        mode = 'block_comment'

        continue

      }

      if (ch === '\'') {

        out.push(ch)

        mode = 'single'

        continue

      }

      if (ch === '\"') {

        out.push(ch)

        mode = 'double'

        continue

      }



      if (ch === '`') {

        const parsed = readTemplateLiteral(i)

        if (!parsed) {

          out.push(ch)

          continue

        }

        out.push(parsed.replacement)

        i = parsed.end

        changed = true

        if (!noted) {

          noted = true

        }

        continue

      }



      out.push(ch)

    }



    if (!changed) return { code: src, changed: false, notes: [] }

    return { code: out.join(''), changed: true, notes: ['converted template literals to string concatenation'] }

  }



  private normalizeEscapedNewlineTokens(code: string): { code: string; changed: boolean; notes: string[] } {

    const src = String(code || '')

    if (!src.includes('\\n') && !src.includes('\\r')) return { code: src, changed: false, notes: [] }



    const notes: string[] = []

    let changed = false



    type Mode = 'normal' | 'single' | 'double' | 'template' | 'line_comment' | 'block_comment'

    let mode: Mode = 'normal'

    let templateExprDepth = 0



    const out: string[] = []



    const peekPrevNonSpace = () => {

      for (let k = out.length - 1; k >= 0; k--) {

        const c = out[k]

        if (c !== ' ' && c !== '\t' && c !== '\r' && c !== '\n') return c

      }

      return ''

    }



    const peekNextNonSpaceInfo = (s: string, i: number): { ch: string; index: number } => {

      let j = i

      while (j < s.length) {

        const c = s[j]

        if (c !== ' ' && c !== '\t' && c !== '\r' && c !== '\n') return { ch: c, index: j }

        j++

      }

      return { ch: '', index: s.length }

    }



    for (let i = 0; i < src.length; i++) {

      const ch = src[i]

      const next = i + 1 < src.length ? src[i + 1] : ''



      if (mode === 'line_comment') {
        out.push(ch)
        if (ch === '\n' || ch === '\r') mode = 'normal'
        continue
      }
      if (mode === 'block_comment') {

        out.push(ch)

        if (ch === '*' && next === '/') {

          out.push(next)

          i++

          mode = 'normal'

        }

        continue

      }

      if (mode === 'single') {

        out.push(ch)

        if (ch === '\\\\') {

          if (i + 1 < src.length) {

            out.push(src[i + 1])

            i++

          }

          continue

        }

        if (ch === '\'') mode = 'normal'

        continue

      }

      if (mode === 'double') {

        out.push(ch)

        if (ch === '\\\\') {

          if (i + 1 < src.length) {

            out.push(src[i + 1])

            i++

          }

          continue

        }

        if (ch === '"') mode = 'normal'

        continue

      }

      if (mode === 'template') {

        out.push(ch)

        if (ch === '\\\\') {

          if (i + 1 < src.length) {

            out.push(src[i + 1])

            i++

          }

          continue

        }

        if (ch === '`') mode = 'normal'

        if (ch === '$' && next === '{') {

          out.push(next)

          i++

          mode = 'normal'

          templateExprDepth = 1

        }

        continue

      }



      // normal

      if (templateExprDepth > 0) {

        out.push(ch)

        if (ch === '{') templateExprDepth++

        else if (ch === '}') templateExprDepth--

        if (templateExprDepth === 0) mode = 'template'

        continue

      }



      if (ch === '/' && next === '/') {

        out.push(ch, next)

        i++

        mode = 'line_comment'

        continue

      }

      if (ch === '/' && next === '*') {

        out.push(ch, next)

        i++

        mode = 'block_comment'

        continue

      }

      if (ch === '\'') {

        out.push(ch)

        mode = 'single'

        continue

      }

      if (ch === '"') {

        out.push(ch)

        mode = 'double'

        continue

      }

      if (ch === '`') {

        out.push(ch)

        mode = 'template'

        continue

      }



      // Convert `\\n`/`\\r` tokens outside strings/comments into real newlines, but only when it

      // clearly acts like "layout", not an escape in e.g. regex literals.

      if (ch === '\\\\' && (next === 'n' || next === 'r')) {

        const prev = peekPrevNonSpace()

        const nn = peekNextNonSpaceInfo(src, i + 2)

        // Common LLM corruption pattern:

        //   ['a', '',\n 'b', 'c'\n].join('\n')

        // `\n` here is a *token*, not a newline. It's always invalid JS outside strings.

        // Allow a few additional "safe" prev chars to fix trailing items without commas.

        const prevOk = prev === '' || ',;]})\'"'.includes(prev)

        const nextOk =

          nn.ch === '' ||

          "'\"[]{}()".includes(nn.ch) ||

          /[A-Za-z0-9_$]/.test(nn.ch) ||

          // Also allow consecutive tokens like `\\n\\n` (very common in corrupted outputs).

          (nn.ch === '\\\\' && (src[nn.index + 1] === 'n' || src[nn.index + 1] === 'r'))

        if (prevOk && nextOk) {

          out.push('\n')

          i++

          changed = true

          if (!notes.includes('normalized stray \\\\n/\\\\r tokens outside strings')) {

            notes.push('normalized stray \\\\n/\\\\r tokens outside strings')

          }

          continue

        }

      }



      out.push(ch)

    }



    let final = out.join('')



    // Common mistake: treating Styles collection as a callable function (VBA-like), e.g. `doc.Styles('标题 1')`.

    // In WPS JS, Styles is usually a collection and should be accessed via `.Item(...)`.

    const before = final

    final = final.replace(/(\.\s*Styles)\s*\(/g, '$1.Item(')

    if (final !== before) {

      changed = true

      notes.push('normalized Styles(...) -> Styles.Item(...)')

    }



    if (!changed) return { code: src, changed: false, notes: [] }

    return { code: final, changed: true, notes: Array.from(new Set(notes)) }

  }



  private normalizeWriterConvenience(code: string): { code: string; changed: boolean; notes: string[] } {

    const src = String(code || '')

    if (!src) return { code: src, changed: false, notes: [] }



    // Best-effort variable discovery. This is intentionally simple: the patterns are very stable

    // in our LLM-generated macros.

    const docVars = new Set<string>()

    const selVars = new Set<string>()

    const rangeVars = new Set<string>()



    try {

      for (const m of src.matchAll(/\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*(?:app|window\.Application)\.ActiveDocument\b/g)) {

        if (m[1]) docVars.add(m[1])

      }

      for (const m of src.matchAll(/\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*(?:app|window\.Application)\.Selection\b/g)) {

        if (m[1]) selVars.add(m[1])

      }

      for (const m of src.matchAll(/\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*(?:app|window\.Application)\.Selection\.Range\b/g)) {

        if (m[1]) rangeVars.add(m[1])

      }

      // `var range = selection.Range;` where `selection` is known selection variable.

      for (const m of src.matchAll(/\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\.Range\b/g)) {

        const v = m[1]

        const base = m[2]

        if (v && base && selVars.has(base)) rangeVars.add(v)

      }

    } catch (e) {

      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/js-macro-executor.ts', e)

      // ignore

    }



    const notes: string[] = []

    let changed = false



    type Mode = 'normal' | 'single' | 'double' | 'template' | 'line_comment' | 'block_comment'

    let mode: Mode = 'normal'

    let templateExprDepth = 0



    const out: string[] = []

    const peekPrevNonSpaceOut = () => {

      for (let k = out.length - 1; k >= 0; k--) {

        const c = out[k]

        if (c !== ' ' && c !== '\t' && c !== '\r' && c !== '\n') return c

      }

      return ''

    }



    const isIdentStart = (ch: string) => /[A-Za-z_$\u4e00-\u9fa5]/.test(ch)

    const isIdent = (ch: string) => /[A-Za-z0-9_$\u4e00-\u9fa5]/.test(ch)



    const peekNonSpace = (s: string, i: number) => {

      let j = i

      while (j < s.length) {

        const c = s[j]

        if (c !== ' ' && c !== '\t' && c !== '\r' && c !== '\n') return { ch: c, index: j }

        j++

      }

      return { ch: '', index: s.length }

    }



    const matchWordAt = (s: string, i: number, word: string) => {

      if (s.slice(i, i + word.length) !== word) return null

      const after = s[i + word.length] || ''

      if (after && isIdent(after)) return null

      return i + word.length

    }



    const shouldRewriteInsertTable = (ident: string) => {

      if (rangeVars.has(ident) || selVars.has(ident)) return true

      // Common variable names we see from LLMs.

      if (ident === 'range' || ident === 'selection' || ident === 'sel') return true

      return false

    }



    for (let i = 0; i < src.length; i++) {

      const ch = src[i]

      const next = i + 1 < src.length ? src[i + 1] : ''



      if (mode === 'line_comment') {
        out.push(ch)
        if (ch === '\n' || ch === '\r') mode = 'normal'
        continue
      }
      if (mode === 'block_comment') {

        out.push(ch)

        if (ch === '*' && next === '/') {

          out.push(next)

          i++

          mode = 'normal'

        }

        continue

      }

      if (mode === 'single') {

        out.push(ch)

        if (ch === '\\\\') {

          if (i + 1 < src.length) {

            out.push(src[i + 1])

            i++

          }

          continue

        }

        if (ch === '\'') mode = 'normal'

        continue

      }

      if (mode === 'double') {

        out.push(ch)

        if (ch === '\\\\') {

          if (i + 1 < src.length) {

            out.push(src[i + 1])

            i++

          }

          continue

        }

        if (ch === '"') mode = 'normal'

        continue

      }

      if (mode === 'template') {

        out.push(ch)

        if (ch === '\\\\') {

          if (i + 1 < src.length) {

            out.push(src[i + 1])

            i++

          }

          continue

        }

        if (ch === '`') mode = 'normal'

        if (ch === '$' && next === '{') {

          out.push(next)

          i++

          mode = 'normal'

          templateExprDepth = 1

        }

        continue

      }



      // normal (also handles template expression blocks)

      if (templateExprDepth > 0) {

        out.push(ch)

        if (ch === '{') templateExprDepth++

        else if (ch === '}') templateExprDepth--

        if (templateExprDepth === 0) mode = 'template'

        continue

      }



      if (ch === '/' && next === '/') {

        out.push(ch, next)

        i++

        mode = 'line_comment'

        continue

      }

      if (ch === '/' && next === '*') {

        out.push(ch, next)

        i++

        mode = 'block_comment'

        continue

      }

      if (ch === '\'') {

        out.push(ch)

        mode = 'single'

        continue

      }

      if (ch === '"') {

        out.push(ch)

        mode = 'double'

        continue

      }

      if (ch === '`') {

        out.push(ch)

        mode = 'template'

        continue

      }



      // Fix: `table.Cells(r, c)` is not a function call in Word/WPS. Some models output it anyway.

      // Rewrite to `table.Rows.Item(r).Cells.Item(c)` (works across Word-like object models).

      if (ch === '.') {

        // Match: .Cells(

        let j = i + 1

        while (j < src.length && /\s/.test(src[j])) j++

        if (src.slice(j, j + 4) === 'Cells') {

          j += 4

          while (j < src.length && /\s/.test(src[j])) j++

          if (src[j] === '(') {

            // Parse args until the matching ')', capture top-level comma split.

            let k = j + 1

            let depth = 0

            let inS = false

            let inD = false

            let arg1 = ''

            let arg2 = ''

            let sawComma = false

            while (k < src.length) {

              const c = src[k]

              const n2 = k + 1 < src.length ? src[k + 1] : ''



              if (inS) {

                if (c === '\\\\') {

                  if (!sawComma) arg1 += c + n2

                  else arg2 += c + n2

                  k += 2

                  continue

                }

                if (c === '\'') inS = false

                if (!sawComma) arg1 += c

                else arg2 += c

                k++

                continue

              }

              if (inD) {

                if (c === '\\\\') {

                  if (!sawComma) arg1 += c + n2

                  else arg2 += c + n2

                  k += 2

                  continue

                }

                if (c === '"') inD = false

                if (!sawComma) arg1 += c

                else arg2 += c

                k++

                continue

              }



              if (c === '\'') {

                inS = true

                if (!sawComma) arg1 += c

                else arg2 += c

                k++

                continue

              }

              if (c === '"') {

                inD = true

                if (!sawComma) arg1 += c

                else arg2 += c

                k++

                continue

              }



              if (c === '(' || c === '[' || c === '{') depth++

              else if (c === ')' || c === ']' || c === '}') {

                if (depth > 0) depth--

              }



              if (depth === 0 && c === ',' && !sawComma) {

                sawComma = true

                k++

                continue

              }



              if (depth === 0 && c === ')') break



              if (!sawComma) arg1 += c

              else arg2 += c

              k++

            }



            if (k < src.length && src[k] === ')' && sawComma) {

              out.push('.Rows.Item(', arg1.trim(), ').Cells.Item(', arg2.trim(), ')')

              i = k // skip through ')'

              changed = true

              if (!notes.includes('rewrote table.Cells(r, c) to table.Rows.Item(r).Cells.Item(c)')) {

                notes.push('rewrote table.Cells(r, c) to table.Rows.Item(r).Cells.Item(c)')

              }

              continue

            }

          }

        }

      }



      // Fix: `table.Cells.Item(r, c)` is not supported in most Word/WPS object models.

      // Rewrite to `table.Rows.Item(r).Cells.Item(c)` (works for both Word and WPS).

      if (ch === '.') {

        // Match: .Cells.Item(

        let j = i + 1

        while (j < src.length && /\s/.test(src[j])) j++

        if (src.slice(j, j + 4) === 'Cells') {

          j += 4

          while (j < src.length && /\s/.test(src[j])) j++

          if (src[j] === '.') {

            j++

            while (j < src.length && /\s/.test(src[j])) j++

            if (src.slice(j, j + 4) === 'Item') {

              j += 4

              while (j < src.length && /\s/.test(src[j])) j++

              if (src[j] === '(') {

                // Parse args until the matching ')', capture top-level comma split.

                let k = j + 1

                let depth = 0

                let inS = false

                let inD = false

                let arg1 = ''

                let arg2 = ''

                let sawComma = false

                while (k < src.length) {

                  const c = src[k]

                  const n2 = k + 1 < src.length ? src[k + 1] : ''



                  if (inS) {

                    if (c === '\\\\') {

                      if (!sawComma) arg1 += c + n2

                      else arg2 += c + n2

                      k += 2

                      continue

                    }

                    if (c === '\'') inS = false

                    if (!sawComma) arg1 += c

                    else arg2 += c

                    k++

                    continue

                  }

                  if (inD) {

                    if (c === '\\\\') {

                      if (!sawComma) arg1 += c + n2

                      else arg2 += c + n2

                      k += 2

                      continue

                    }

                    if (c === '"') inD = false

                    if (!sawComma) arg1 += c

                    else arg2 += c

                    k++

                    continue

                  }



                  if (c === '\'') {

                    inS = true

                    if (!sawComma) arg1 += c

                    else arg2 += c

                    k++

                    continue

                  }

                  if (c === '"') {

                    inD = true

                    if (!sawComma) arg1 += c

                    else arg2 += c

                    k++

                    continue

                  }



                  if (c === '(' || c === '[' || c === '{') depth++

                  else if (c === ')' || c === ']' || c === '}') {

                    if (depth > 0) depth--

                  }



                  if (depth === 0 && c === ',' && !sawComma) {

                    sawComma = true

                    k++

                    continue

                  }



                  if (depth === 0 && c === ')') break



                  if (!sawComma) arg1 += c

                  else arg2 += c

                  k++

                }



                if (k < src.length && src[k] === ')' && sawComma) {

                  out.push('.Rows.Item(', arg1.trim(), ').Cells.Item(', arg2.trim(), ')')

                  i = k // skip through ')'

                  changed = true

                  if (!notes.includes('rewrote table.Cells.Item(r, c) to table.Rows.Item(r).Cells.Item(c)')) {

                    notes.push('rewrote table.Cells.Item(r, c) to table.Rows.Item(r).Cells.Item(c)')

                  }

                  continue

                }

              }

            }

          }

        }

      }



      if (isIdentStart(ch)) {

        let j = i

        while (j < src.length && isIdent(src[j])) j++

        const ident = src.slice(i, j)



        // ES6 object shorthand like `{ bold, italic }` is a SyntaxError in many WPS embedded engines.

        // We only rewrite the very common LLM pattern inside option objects: `..., bold, ...`.

        if (ident === 'bold' || ident === 'italic') {

          const prev = peekPrevNonSpaceOut()

          const p = peekNonSpace(src, j)

          if ((prev === '{' || prev === ',') && p.ch && p.ch !== ':' && (p.ch === ',' || p.ch === '}')) {

            out.push(`${ident}: true`)

            i = j - 1

            changed = true

            if (!notes.includes('rewrote ES6 object shorthand (bold/italic) to ES5')) {

              notes.push('rewrote ES6 object shorthand (bold/italic) to ES5')

            }

            continue

          }

        }



        // Fix: `doc.Selection` is usually wrong in WPS; Selection hangs off Application, not Document.

        if (docVars.has(ident)) {

          const p = peekNonSpace(src, j)

          if (p.ch === '.') {

            const k = peekNonSpace(src, p.index + 1)

            const end = matchWordAt(src, k.index, 'Selection')

            if (end != null) {

              out.push('window.Application.Selection')

              i = end - 1

              changed = true

              if (!notes.includes('rewrote doc.Selection to window.Application.Selection')) {

                notes.push('rewrote doc.Selection to window.Application.Selection')

              }

              continue

            }

          }

        }



        // Fix: `range.InsertTable(...)` / `selection.InsertTable(...)` / `selection.Range.InsertTable(...)`

        if (shouldRewriteInsertTable(ident)) {

          const p = peekNonSpace(src, j)

          if (p.ch === '.') {

            const k = peekNonSpace(src, p.index + 1)

            // selection.Range.InsertTable

            const endRange = matchWordAt(src, k.index, 'Range')

            if (endRange != null) {

              const p2 = peekNonSpace(src, endRange)

              if (p2.ch === '.') {

                const k2 = peekNonSpace(src, p2.index + 1)

                const endIns = matchWordAt(src, k2.index, 'InsertTable')

                if (endIns != null) {

                  out.push('BID.insertTable')

                  i = endIns - 1

                  changed = true

                  if (!notes.includes('rewrote (selection|range).InsertTable to BID.insertTable')) {

                    notes.push('rewrote (selection|range).InsertTable to BID.insertTable')

                  }

                  continue

                }

              }

            }



            // range.InsertTable / selection.InsertTable

            const endIns = matchWordAt(src, k.index, 'InsertTable')

            if (endIns != null) {

              out.push('BID.insertTable')

              i = endIns - 1

              changed = true

              if (!notes.includes('rewrote (selection|range).InsertTable to BID.insertTable')) {

                notes.push('rewrote (selection|range).InsertTable to BID.insertTable')

              }

              continue

            }

          }

        }



        out.push(ident)

        i = j - 1

        continue

      }



      out.push(ch)

    }



    if (!changed) return { code: src, changed: false, notes: [] }

    return { code: out.join(''), changed: true, notes }

  }



  private normalizeHostCollections(

    code: string,

    host: 'wps' | 'et' | 'wpp' | 'unknown'

  ): { code: string; changed: boolean; notes: string[] } {

    const src = String(code || '')

    if (!src) return { code: src, changed: false, notes: [] }



    // Rewrite helpers must not touch string literals (text content), otherwise we may corrupt inserted content.

    type Mode = 'normal' | 'single' | 'double' | 'template'

    let mode: Mode = 'normal'

    let templateExprDepth = 0



    const out: string[] = []

    let changed = false

    const notes: string[] = []



    const isIdentStart = (ch: string) => /[A-Za-z_$\u4e00-\u9fa5]/.test(ch)

    const isIdent = (ch: string) => /[A-Za-z0-9_$\u4e00-\u9fa5]/.test(ch)



    const peekNonSpace = (s: string, i: number): { ch: string; index: number } => {

      let j = i

      while (j < s.length) {

        const c = s[j]

        if (c !== ' ' && c !== '\t' && c !== '\r' && c !== '\n') return { ch: c, index: j }

        j++

      }

      return { ch: '', index: s.length }

    }



    const tryRewriteCollectionCallToItem = (

      baseIndex: number,

      prop: 'Cells' | 'Rows' | 'Columns' | 'Styles'

    ): { took: boolean; nextIndex: number } => {

      // Expect ".Prop" at baseIndex (src[baseIndex] === '.')

      const start = baseIndex

      let j = start + 1

      if (!isIdentStart(src[j] || '')) return { took: false, nextIndex: start }

      while (j < src.length && isIdent(src[j])) j++

      const name = src.slice(start + 1, j)

      if (name !== prop) return { took: false, nextIndex: start }



      // Avoid rewriting ".Cells.Item(" etc

      const afterName = src.slice(j, Math.min(src.length, j + 12))

      if (/^\s*\.\s*Item\s*\(/.test(afterName)) return { took: false, nextIndex: start }



      const next = peekNonSpace(src, j)

      if (next.ch !== '(') return { took: false, nextIndex: start }



      // If the first arg starts with a quote, this is likely a range selector (e.g. ET Columns("A:B"))

      // and should NOT be rewritten. Exception: Writer Styles("Heading 1") is a valid collection.Item call.

      const firstArg = peekNonSpace(src, next.index + 1)

      if (prop !== 'Styles' && (firstArg.ch === '\'' || firstArg.ch === '"' || firstArg.ch === '`')) {

        return { took: false, nextIndex: start }

      }



      // Emit ".Prop.Item" and keep the original "(" and following.

      out.push('.' + prop + '.Item')

      changed = true

      if (host === 'et' && prop === 'Cells') notes.push('normalized ET Cells(r,c) -> Cells.Item(r,c)')

      if (host === 'wps' && prop === 'Cells') notes.push('normalized Writer Cells(i) -> Cells.Item(i)')

      if (host === 'wps' && prop === 'Rows') notes.push('normalized Writer Rows(i) -> Rows.Item(i)')

      if (host === 'wps' && prop === 'Columns') notes.push('normalized Writer Columns(i) -> Columns.Item(i)')

      if (host === 'wps' && prop === 'Styles') notes.push('normalized Writer Styles(x) -> Styles.Item(x)')

      return { took: true, nextIndex: j }

    }



    const tryRewriteEtRangeRowColToCellsItem = (baseIndex: number): { took: boolean; nextIndex: number } => {

      const start = baseIndex

      let j = start + 1

      if (!isIdentStart(src[j] || '')) return { took: false, nextIndex: start }

      while (j < src.length && isIdent(src[j])) j++

      const name = src.slice(start + 1, j)

      if (name !== 'Range') return { took: false, nextIndex: start }



      // `.Range(` ... we only rewrite the 2-arg numeric form: Range(row, col)

      const next = peekNonSpace(src, j)

      if (next.ch !== '(') return { took: false, nextIndex: start }



      // Parse until the matching ')' of this call, and find a top-level comma.

      let depth = 0

      let commaIndex = -1

      let endIndex = -1

      for (let k = next.index; k < src.length; k++) {

        const c = src[k]

        if (c === '(') depth++

        else if (c === ')') {

          depth--

          if (depth === 0) {

            endIndex = k

            break

          }

        } else if (c === ',' && depth === 1 && commaIndex === -1) {

          commaIndex = k

        } else if (c === '"' || c === '\'' || c === '`') {

          // string-based range like Range("A1") / Range("A1:B2") - don't rewrite

          return { took: false, nextIndex: start }

        }

      }

      if (commaIndex === -1 || endIndex === -1) return { took: false, nextIndex: start }



      const a1 = src.slice(next.index + 1, commaIndex).trim()

      const a2 = src.slice(commaIndex + 1, endIndex).trim()

      if (!a1 || !a2) return { took: false, nextIndex: start }



      // If args reference objects/ranges (contain '.'), it's likely the Range(startCell, endCell) form.

      if (a1.includes('.') || a2.includes('.')) return { took: false, nextIndex: start }

      // Also avoid rewriting when args look like they already refer to Range/Cells etc.

      if (/\b(Cells|Range)\b/.test(a1) || /\b(Cells|Range)\b/.test(a2)) return { took: false, nextIndex: start }



      out.push('.Cells.Item')

      changed = true

      notes.push('normalized ET Range(row,col) -> Cells.Item(row,col)')

      return { took: true, nextIndex: j }

    }



    const tryRewriteNoArgCallToProperty = (

      baseIndex: number,

      prop: 'Shapes'

    ): { took: boolean; nextIndex: number } => {

      const start = baseIndex

      let j = start + 1

      if (!isIdentStart(src[j] || '')) return { took: false, nextIndex: start }

      while (j < src.length && isIdent(src[j])) j++

      const name = src.slice(start + 1, j)

      if (name !== prop) return { took: false, nextIndex: start }



      const next = peekNonSpace(src, j)

      if (next.ch !== '(') return { took: false, nextIndex: start }

      const afterParen = peekNonSpace(src, next.index + 1)

      if (afterParen.ch !== ')') return { took: false, nextIndex: start }



      // Rewrite ".Shapes()" -> ".Shapes"

      out.push('.' + prop)

      changed = true

      notes.push('normalized WPP Shapes() -> Shapes')

      return { took: true, nextIndex: afterParen.index + 1 }

    }



    for (let i = 0; i < src.length; i++) {

      const ch = src[i]

      const next = i + 1 < src.length ? src[i + 1] : ''



      if (mode === 'single') {

        out.push(ch)

        if (ch === '\\\\') {

          if (i + 1 < src.length) out.push(src[i + 1])

          i++

          continue

        }

        if (ch === '\'') mode = 'normal'

        continue

      }

      if (mode === 'double') {

        out.push(ch)

        if (ch === '\\\\') {

          if (i + 1 < src.length) out.push(src[i + 1])

          i++

          continue

        }

        if (ch === '"') mode = 'normal'

        continue

      }

      if (mode === 'template') {

        out.push(ch)

        if (ch === '\\\\') {

          if (i + 1 < src.length) out.push(src[i + 1])

          i++

          continue

        }

        if (ch === '`') mode = 'normal'

        if (ch === '$' && next === '{') {

          out.push(next)

          i++

          mode = 'normal'

          templateExprDepth = 1

        }

        continue

      }



      // normal (incl template expressions)

      if (templateExprDepth > 0) {

        out.push(ch)

        if (ch === '{') templateExprDepth++

        else if (ch === '}') templateExprDepth--

        if (templateExprDepth === 0) mode = 'template'

        continue

      }



      if (ch === '\'') {

        out.push(ch)

        mode = 'single'

        continue

      }

      if (ch === '"') {

        out.push(ch)

        mode = 'double'

        continue

      }

      if (ch === '`') {

        out.push(ch)

        mode = 'template'

        continue

      }



      if (ch === '.') {

        if (host === 'et') {

          const r0 = tryRewriteEtRangeRowColToCellsItem(i)

          if (r0.took) {

            i = r0.nextIndex - 1

            continue

          }

          const r = tryRewriteCollectionCallToItem(i, 'Cells')

          if (r.took) {

            i = r.nextIndex - 1

            continue

          }

        } else if (host === 'wps') {

          // Writer table object model uses collection.Item(index) heavily.

          let took = false

          for (const prop of ['Rows', 'Columns', 'Cells', 'Styles'] as const) {

            const r = tryRewriteCollectionCallToItem(i, prop)

            if (r.took) {

              i = r.nextIndex - 1

              took = true

              break

            }

          }

          if (took) continue

        } else if (host === 'wpp') {

          const r = tryRewriteNoArgCallToProperty(i, 'Shapes')

          if (r.took) {

            i = r.nextIndex - 1

            continue

          }

        }

      }



      out.push(ch)

    }



    if (!changed) return { code: src, changed: false, notes: [] }

    return { code: out.join(''), changed: true, notes: Array.from(new Set(notes)) }

  }



  private normalizeHostAlerts(code: string): { code: string; changed: boolean; notes: string[] } {

    const src = String(code || '')

    if (!src.trim()) return { code: src, changed: false, notes: [] }



    const hasAlert =

      /\bapp\.Alert\s*\(/.test(src) ||

      /\bwindow\.Application\.Alert\s*\(/.test(src) ||

      /\bApplication\.Alert\s*\(/.test(src)

    if (!hasAlert) return { code: src, changed: false, notes: [] }



    const helperName = '__ah32_safe_alert'

    const notes: string[] = []

    let out = src



    const hasHelper = new RegExp(`\\bfunction\\s+${helperName}\\b`).test(out)

    if (!hasHelper) {

      const lines = out.split(/\r?\n/)

      let i = 0

      while (i < lines.length && /^\s*\/\/\s*@ah32:/.test(lines[i] || '')) i++

      lines.splice(

        i,

        0,

        [

          `function ${helperName}(app){`,

          `  try {`,

          `    if (app && typeof app.Alert === 'function') {`,

          `      return app.Alert.apply(app, Array.prototype.slice.call(arguments, 1));`,

          `    }`,

          `  } catch (e) {`,

          `    // ignore`,

          `  }`,

          `  return null;`,

          `}`,

        ].join('\n')

      )

      out = lines.join('\n')

      notes.push('injected safe alert helper')

    }



    const before = out

    out = out

      .replace(/\bapp\.Alert\s*\(/g, `${helperName}(app,`)

      .replace(/\bwindow\.Application\.Alert\s*\(/g, `${helperName}(window.Application,`)

      .replace(/\bApplication\.Alert\s*\(/g, `${helperName}(window.Application,`)

    if (out !== before) notes.push('normalized app.Alert calls')



    return { code: out, changed: out !== src, notes }

  }



  private findSuspiciousChars(code: string): Array<{ index: number; ch: string; codePoint: string }> {

    const src = String(code || '')

    const out: Array<{ index: number; ch: string; codePoint: string }> = []

    // Include backtick: template literals are a frequent invalid token on older WPS engines.

    const suspicious =
      /[`\u007F-\u009F\u00A0\u1680\u2000-\u200A\u202F\u205F\u200B\u200C\u200D\u2060\uFEFF\u00AD\u2028\u2029\u3000\u200E\u200F\u202A-\u202E\u2066-\u2069“”‘’（），；：＝＋－＊／！？」「«»×÷…＼＜＞＆｜＾～％＃＠＄·]/
    for (let i = 0; i < src.length; i++) {

      const ch = src[i]

      if (!suspicious.test(ch)) continue

      const cp = ch.codePointAt(0)

      out.push({ index: i, ch, codePoint: cp ? `U+${cp.toString(16).toUpperCase().padStart(4, '0')}` : '' })

      if (out.length >= 50) break

    }

    return out

  }



  private detectHostFromApplication(app: any): 'wps' | 'et' | 'wpp' | 'unknown' {

    try {

      if (!app) return 'unknown'

      try {

        if (app.ActiveDocument || app.Documents) return 'wps'

      } catch (e) {

        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/js-macro-executor.ts', e)

      }

      try {

        if (app.ActiveWorkbook || app.Workbooks) return 'et'

      } catch (e) {

        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/js-macro-executor.ts', e)

      }

      try {

        if (app.ActivePresentation || app.Presentations) return 'wpp'

      } catch (e) {

        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/js-macro-executor.ts', e)

      }

      return 'unknown'

    } catch (e) {

      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/js-macro-executor.ts', e)

      return 'unknown'

    }

  }



  /**

   * 包装代码为可执行函数

   */

  private wrapCode(code: string, hostApp: 'wps' | 'et' | 'wpp' | 'unknown'): string {

    const trimmed = code.trim()

    const hasFunction = trimmed.includes('function ')

    const hasArrow = trimmed.includes('=>')

    const alreadyUpserts = /\bBID\s*\.\s*upsertBlock\s*\(/.test(trimmed)

    const isWriter = hostApp === 'wps'

    const hasBlockIdHeader =

      /^\s*\/\/\s*@ah32:blockId\s*=/m.test(trimmed) ||

      /\/\*\s*@ah32:blockId\s*=/m.test(trimmed)

    const disableAutoUpsert =

      /^\s*\/\/\s*@ah32:no_upsert\b/m.test(trimmed) ||

      /^\s*\/\/\s*@ah32:direct\b/m.test(trimmed) ||

      /^\s*\/\/\s*@ah32:answer[_-]?mode\b/m.test(trimmed) ||

      /\bBID\s*\.\s*answerModeApply\s*\(/.test(trimmed)

    const allowUnsafeHeader =

      /^\s*\/\/\s*@ah32:unsafe\b/m.test(trimmed) ||

      /^\s*\/\*\s*@ah32:unsafe\b/m.test(trimmed)

    const allowUnsafeGlobal = false


    // Heuristic:

    // - Writer: only auto-upsert when code looks like it inserts/creates content (avoid polluting docs on pure formatting macros).

    // - ET/WPP: when a blockId header is present, upsert to a dedicated artifact container (sheet/slide) to avoid duplicates.

    const looksLikeInsert =

      /(\.Range\.Text\s*=|Tables\.Add|InlineShapes\.Add|Shapes\.Add|AddTextEffect|AddChart|AddChart2|AddPicture|TypeParagraph|TypeText\s*\()/.test(trimmed)



    // NOTE: We intentionally do NOT sandbox macro execution by default.

    //

    // Reason:

    // - Our WPS macro prompting explicitly allows/encourages using `window.Application` / `app`.

    // - A strict-mode sandbox prelude that redeclares reserved identifiers (e.g. `eval`) can itself

    //   cause SyntaxError in ES5 engines, preventing *all* macros from running.

    //

    // Safety is handled via `checkMacroSafety()` before execution (blocks network/dynamic eval).

    const sandboxEnabled = false && !allowUnsafeGlobal && !allowUnsafeHeader

    const sandboxPrelude = [

      // Keep minimal. Do NOT use `'use strict'` + `var eval = ...` (strict disallows eval as binding).

      "var fetch = undefined;",

      "var XMLHttpRequest = undefined;",

      "var WebSocket = undefined;",

    ].join('\\n')

    const sandboxReturn = (body: string) => {

      if (!sandboxEnabled) return body

      return `return (function () {\\n${sandboxPrelude}\\n${body}\\n})();`

    }

    const sandboxStmt = (body: string) => {

      if (!sandboxEnabled) return body

      return `(function () {\\n${sandboxPrelude}\\n${body}\\n})();`

    }



    // Runtime shims for WPS JS API differences across versions.

    // Keep this minimal and side-effect-free: only add missing helpers.

    const writerPreamble = `

// ---- Ah32 WPS JS runtime shims (safe no-op when APIs exist) ----

if (typeof RGB !== 'function') {

  function RGB(r, g, b) {

    var rr = Number(r) & 255

    var gg = Number(g) & 255

    var bb = Number(b) & 255

    return rr + (gg << 8) + (bb << 16)

  }

}



// ---- Ah32 helper facade (best-effort across WPS versions) ----
var BID = (function () {

  function _diagPush(tag, e, extra) {
    try {
      if (typeof window === 'undefined') return
      var a = window.__BID_AUDIT_DIAG
      if (!a || typeof a.push !== 'function') {
        a = []
        window.__BID_AUDIT_DIAG = a
      }
      if (a.length >= 80) return
      var msg = ''
      try { msg = e && e.message ? String(e.message) : String(e || '') } catch (_e2) { msg = '' }
      a.push({ tag: String(tag || ''), message: msg.slice(0, 500), extra: extra || null })
    } catch (_e) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', _e, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', _e) }
  }
  // Runtime guardrails (best-effort): op budget, time budget, text size, cancellation.

  function _limits() {
    var d = { maxOps: 200, maxTextLen: 20000, maxTableCells: 500, deadlineMs: 45000 }

    try {

      var cfg = null
      if (cfg && typeof cfg === 'object') {

        if (cfg.maxOps != null) d.maxOps = Math.max(1, Math.min(2000, Number(cfg.maxOps) || d.maxOps))

        if (cfg.maxTextLen != null) d.maxTextLen = Math.max(100, Math.min(200000, Number(cfg.maxTextLen) || d.maxTextLen))

        if (cfg.maxTableCells != null) d.maxTableCells = Math.max(10, Math.min(5000, Number(cfg.maxTableCells) || d.maxTableCells))

        if (cfg.deadlineMs != null) d.deadlineMs = Math.max(1000, Math.min(300000, Number(cfg.deadlineMs) || d.deadlineMs))

      }

    } catch (e) { _diagPush('limits', e) }

    return d

  }

  var __limits = _limits()

  var __startedAt = Date.now()

  var __ops = 0

  function _isCancelled() {

    try { return !!(typeof window !== 'undefined' && window.__BID_CANCEL_MACRO) } catch (e) { return false }

  }

  function _guard(op, payload) {

    __ops = __ops + 1

    if (__ops > __limits.maxOps) throw new Error('MacroSafetyError: maxOps exceeded')

    if ((Date.now() - __startedAt) > __limits.deadlineMs) throw new Error('MacroSafetyError: deadline exceeded')

    if (_isCancelled()) throw new Error('MacroSafetyError: cancelled')

    if (payload && payload.textLen && payload.textLen > __limits.maxTextLen) throw new Error('MacroSafetyError: maxTextLen exceeded')

    if (payload && payload.tableCells && payload.tableCells > __limits.maxTableCells) throw new Error('MacroSafetyError: maxTableCells exceeded')

    try {

      if (typeof window !== 'undefined') {

        if (!window.__BID_AUDIT_OPS) window.__BID_AUDIT_OPS = []

        window.__BID_AUDIT_OPS.push(String(op || ''))

      }

    } catch (e) { _diagPush('audit_ops', e, { op: String(op || '') }) }

    return true

  }



  function _tag(id, kind) {

    return '[[AH32:' + String(id || 'ah32_auto') + ':' + kind + ']]'

  }



  function _getDocRange(doc, start, end) {

    try { return doc.Range(start, end) } catch (e) { _diagPush('doc_range', e) }

    try {

      var r = doc.Range()

      if (r && typeof r.SetRange === 'function') {

        r.SetRange(start, end)

        return r

      }

    } catch (e2) { _diagPush('doc_range_fallback', e2) }

    return null

  }



  function _findTextRange(doc, text, startAt) {

    try {

      var r = doc.Range()

      if (typeof startAt === 'number') {

        try { r.SetRange(startAt, r.End) } catch (e) { _diagPush('wps_set_range', e) }

      }

      if (r && r.Find) {

        try { if (typeof r.Find.ClearFormatting === 'function') r.Find.ClearFormatting() } catch (e) { _diagPush('wps_find_clear_formatting', e) }

        try { r.Find.Text = text } catch (e) { _diagPush('wps_find_set_text', e) }

        try { r.Find.Forward = true } catch (e) { _diagPush('wps_find_set_forward', e) }

        try { r.Find.Wrap = 0 } catch (e) { _diagPush('wps_find_set_wrap', e) }

        var ok = false

        try { ok = !!r.Find.Execute() } catch (e) { ok = false }

        if (ok) return r

      }

    } catch (e3) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e3, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e3) }



    // Fallback: string search on full document text (best-effort).

    try {

      var full = doc.Range()

      var t = String(full.Text || '')

      var from = typeof startAt === 'number' ? startAt : 0

      var idx = t.indexOf(text, from)

      if (idx >= 0) return _getDocRange(doc, idx, idx + text.length)

    } catch (e4) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e4, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e4) }



    return null

  }



  // Public wrapper: find a text anchor range in the active document.

  function findTextRange(text, opts) {

    _guard('findTextRange', { textLen: String(text || '').length })

    var doc = _getDoc()

    if (!doc) throw new Error('WPS 文档不可用，无法查找文本锚点')

    var t = String(text || '').trim()

    if (!t) throw new Error('锚点文本为空')

    opts = opts || {}

    var startAt = typeof opts.startAt === 'number' ? opts.startAt : undefined

    return _findTextRange(doc, t, startAt)

  }



  function insertAfterText(anchorText, insertText, opts) {

    _guard('insertAfterText', { textLen: String(insertText || '').length + String(anchorText || '').length })

    var doc = _getDoc()

    if (!doc) throw new Error('WPS 文档不可用，无法插入内容')

    var anchor = _findTextRange(doc, String(anchorText || '').trim())

    if (!anchor) throw new Error('找不到锚点文本: ' + String(anchorText || ''))



    var pos = anchor.End

    var r = _getDocRange(doc, pos, pos)

    if (!r) throw new Error('无法定位到锚点后的插入位置')

    opts = opts || {}



    if (opts.newParagraphBefore) _safe(function () { r.InsertParagraphBefore && r.InsertParagraphBefore() })

    // Insert text at a collapsed range.

    _safe(function () { r.Text = String(insertText || '') })

    if (opts.newParagraphAfter) _safe(function () { r.InsertParagraphAfter && r.InsertParagraphAfter() })

    return r

  }



  function insertBeforeText(anchorText, insertText, opts) {

    _guard('insertBeforeText', { textLen: String(insertText || '').length + String(anchorText || '').length })

    var doc = _getDoc()

    if (!doc) throw new Error('WPS 文档不可用，无法插入内容')

    var anchor = _findTextRange(doc, String(anchorText || '').trim())

    if (!anchor) throw new Error('找不到锚点文本: ' + String(anchorText || ''))



    var pos = anchor.Start

    var r = _getDocRange(doc, pos, pos)

    if (!r) throw new Error('无法定位到锚点前的插入位置')

    opts = opts || {}



    if (opts.newParagraphBefore) _safe(function () { r.InsertParagraphBefore && r.InsertParagraphBefore() })

    _safe(function () { r.Text = String(insertText || '') })

    if (opts.newParagraphAfter) _safe(function () { r.InsertParagraphAfter && r.InsertParagraphAfter() })

    return r

  }



  function _formatMarkerRange(rng) {

    if (!rng) return

    _safe(function () { rng.Font.Hidden = 1 })

    _safe(function () { rng.Font.Hidden = true })

    _safe(function () { rng.Font.Size = 1 })

    _safe(function () { rng.Font.Color = RGB(255, 255, 255) })

  }



  function _bookmarkName(id) {

    var raw = String(id || 'ah32_auto')

    var s = raw.replace(/[^a-zA-Z0-9_]/g, '_')

    if (!s) s = 'ah32_auto'

    if (!/^[A-Za-z]/.test(s)) s = 'B' + s

    if (s.length > 30) s = s.slice(0, 30)

    return 'AH32_' + s

  }



  function _getBookmark(doc, name) {

    if (!doc || !name) return null

    try {

      if (doc.Bookmarks) {

        try {

          if (typeof doc.Bookmarks.Item === 'function') return doc.Bookmarks.Item(name)

        } catch (e0) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e0, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e0) }

        try {

          if (typeof doc.Bookmarks === 'function') return doc.Bookmarks(name)

        } catch (e1) { _diagPush('wps_bookmark_by_name', e1) }

        try {

          // Some builds expose Bookmarks as a collection callable with indexer semantics.

          return doc.Bookmarks[name]

        } catch (e2) { _diagPush('wps_bookmark_indexer', e2) }

      }

    } catch (e3) { _diagPush('wps_bookmark_get', e3) }

    return null

  }



  function _getBookmarkRange(doc, name) {

    var bm = _getBookmark(doc, name)

    if (!bm) return null

    try { return bm.Range } catch (e) { return null }

  }



  function _deleteBookmark(doc, name) {

    var bm = _getBookmark(doc, name)

    if (!bm) return false

    try { if (typeof bm.Delete === 'function') { bm.Delete(); return true } } catch (e) { _diagPush('wps_bm_delete', e) }

    try {

      if (doc && doc.Bookmarks && typeof doc.Bookmarks.Remove === 'function') {

        doc.Bookmarks.Remove(name)

        return true

      }

    } catch (e2) { _diagPush('wps_bookmark_remove', e2) }

    return false

  }



  function _addBookmark(doc, name, rng) {

    if (!doc || !name || !rng) return false

    try {

      if (doc.Bookmarks && typeof doc.Bookmarks.Add === 'function') {

        doc.Bookmarks.Add(name, rng)

        return true

      }

    } catch (e) { _diagPush('limits', e) }

    return false

  }



  function _supportsBookmarks(doc) {

    try { return !!(doc && doc.Bookmarks && typeof doc.Bookmarks.Add === 'function') } catch (e) { return false }

  }



  function _insertMarkerAtSelection(doc, selection, tag) {

    if (!doc || !selection) return null

    var t = String(tag || '')

    if (!t) return null



    // IMPORTANT: do not let hidden marker formatting "infect" subsequent inserts.

    // Otherwise content can be written successfully but appear invisible in the document.

    var prevHidden = null

    var prevSize = null

    var prevColor = null

    try { prevHidden = selection.Range && selection.Range.Font ? selection.Range.Font.Hidden : null } catch (e0) { prevHidden = null }

    try { prevSize = selection.Range && selection.Range.Font ? selection.Range.Font.Size : null } catch (e1) { prevSize = null }

    try { prevColor = selection.Range && selection.Range.Font ? selection.Range.Font.Color : null } catch (e2) { prevColor = null }

    var startPos = null

    try { startPos = selection.Range ? selection.Range.Start : null } catch (e) { _diagPush('wps_selection_start', e) }

    if (typeof startPos !== 'number') {

      try { startPos = typeof selection.Start === 'number' ? selection.Start : null } catch (e2) { _diagPush('wps_selection_start_fallback', e2) }

    }



    _safe(function () { selection.Range.Text = t })



    var rng = null

    if (typeof startPos === 'number') {

      rng = _getDocRange(doc, startPos, startPos + t.length)

    }

    if (!rng) {

      try { rng = selection.Range } catch (e3) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e3, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e3) }

    }

    _formatMarkerRange(rng)



    // Move cursor after marker + restore formatting (best-effort).

    try {

      if (typeof startPos === 'number') {

        var endPos = startPos + t.length

        _safe(function () { if (typeof selection.SetRange === 'function') selection.SetRange(endPos, endPos) })

        _safe(function () { if (selection.Range && typeof selection.Range.SetRange === 'function') selection.Range.SetRange(endPos, endPos) })

      }

    } catch (e4) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e4, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e4) }

    _safe(function () { if (prevHidden != null && selection.Range && selection.Range.Font) selection.Range.Font.Hidden = prevHidden ? 1 : 0 })

    _safe(function () { if (prevHidden != null && selection.Range && selection.Range.Font) selection.Range.Font.Hidden = !!prevHidden })

    _safe(function () { if (prevSize != null && selection.Range && selection.Range.Font) selection.Range.Font.Size = prevSize })

    _safe(function () { if (prevColor != null && selection.Range && selection.Range.Font) selection.Range.Font.Color = prevColor })

    return rng

  }



  function _safe(fn) {

    try { return { ok: true, value: fn() } } catch (e) { return { ok: false, error: e } }

  }



  function _freezeSelection(sel) {

    var saved = {}

    if (!sel) return saved

    // Do NOT monkey-patch Selection methods (EndKey/HomeKey/GoTo):
    // some WPS builds mark them read-only/non-configurable and throw "Cannot redefine property".
    // Best-effort: snapshot selection range and restore after writeback.
    try {
      var start = null
      var end = null
      try {
        var r = sel && sel.Range
        if (r) {
          start = r.Start
          end = r.End
        }
      } catch (e0) { _diagPush('wps_freeze_selection_range', e0) }

      if (typeof start !== 'number') {
        try { start = sel.Start } catch (e1) { _diagPush('wps_freeze_selection_start', e1) }
      }
      if (typeof end !== 'number') {
        try { end = sel.End } catch (e2) { _diagPush('wps_freeze_selection_end', e2) }
      }

      if (typeof start === 'number' && typeof end === 'number') {
        saved.__range_start = start
        saved.__range_end = end
      }
    } catch (e3) {
      _diagPush('wps_freeze_selection', e3)
    }

    return saved

  }



  function _restoreSelection(sel, saved) {

    if (!sel || !saved) return

    try {
      var start = saved.__range_start
      var end = saved.__range_end
      if (typeof start === 'number' && typeof end === 'number') {
        if (typeof sel.SetRange === 'function') {
          try { sel.SetRange(start, end) } catch (e0) { _diagPush('wps_restore_selection_setrange', e0) }
        } else {
          try {
            var r = sel && sel.Range
            if (r && typeof r.SetRange === 'function') r.SetRange(start, end)
          } catch (e1) { _diagPush('wps_restore_selection_range_setrange', e1) }
        }
      }
    } catch (e2) { _diagPush('wps_restore_selection_range', e2) }

    for (var k in saved) {

      if (k === '__range_start' || k === '__range_end') continue

      try { sel[k] = saved[k] } catch (e) { _diagPush('wps_restore_selection', e) }

    }

  }



  function _getSelection() {

    try { return app && app.Selection } catch (e) { return null }

  }



  function _getDoc() {

    try { return app && app.ActiveDocument } catch (e) { return null }

  }



  function insertTable(rows, cols, opts) {

    var r = Number(rows) || 2

    var c = Number(cols) || 2

    _guard('insertTable', { tableCells: r * c })

    var selection = _getSelection()

    var doc = _getDoc()

    if (!selection || !doc || !selection.Range) throw new Error('WPS 文档/光标不可用，无法插入表格')



    // Try common Word object model APIs. WPS/Office versions differ; keep best-effort.

    var res = _safe(function () { return doc.Tables.Add(selection.Range, r, c) })

    if (!res.ok) res = _safe(function () { return selection.Range.Tables.Add(selection.Range, r, c) })

    if (!res.ok) res = _safe(function () { return doc.Tables.Add(selection.Range, r, c, 1, 1) }) // some variants accept AutoFitBehavior

    if (!res.ok) throw (res.error || new Error('插入表格失败'))



    var table = res.value

    opts = opts || {}

    _safe(function () { if (opts.borders === false) table.Borders.Enable = 0 })

    _safe(function () { if (opts.borders !== false) table.Borders.Enable = 1 })

    _safe(function () { if (opts.style) table.Style = opts.style })

    _safe(function () { if (opts.autoFit) table.AutoFitBehavior(opts.autoFit) })

    _safe(function () { if (opts.header) table.Rows(1).HeadingFormat = 1 })

    return table

  }



  function insertChartFromSelection(opts) {

    _guard('insertChartFromSelection', {})

    // NOTE: chart APIs are highly version-dependent in WPS. We try a few and fall back gracefully.

    var selection = _getSelection()

    var doc = _getDoc()

    if (!selection || !doc) throw new Error('WPS 文档/光标不可用，无法插入图表')

    opts = opts || {}

    var chartType = opts.chartType || 51 // 51 ~= xlColumnClustered in Excel; may vary



    var res = _safe(function () { return doc.InlineShapes.AddChart2(chartType) })

    if (!res.ok) res = _safe(function () { return doc.Shapes.AddChart2(chartType) })

    if (!res.ok) res = _safe(function () { return selection.Range.InlineShapes.AddChart2(chartType) })

    if (!res.ok) throw (res.error || new Error('插入图表失败（当前 WPS 版本可能不支持该 API）'))



    var shape = res.value

    _safe(function () { if (opts.width) shape.Width = opts.width })

    _safe(function () { if (opts.height) shape.Height = opts.height })

    return shape

  }



  function insertWordArt(text, opts) {

    _guard('insertWordArt', { textLen: String(text || '').length })

    // WordArt ~= Shapes.AddTextEffect in Word object model

    var selection = _getSelection()

    var doc = _getDoc()

    if (!selection || !doc) throw new Error('WPS 文档/光标不可用，无法插入艺术字')

    opts = opts || {}

    var t = String(text || '')

    if (!t) t = '艺术字'



    var preset = opts.preset || 1

    var font = opts.font || '微软雅黑'

    var size = Number(opts.size) || 36

    var bold = !!opts.bold

    var italic = !!opts.italic



    // Signature differs; use a few fallbacks.

    var res = _safe(function () { return doc.Shapes.AddTextEffect(preset, t, font, size, bold, italic, 0, 0) })

    if (!res.ok) res = _safe(function () { return doc.Shapes.AddTextEffect(preset, t, font, size, bold, italic) })

    if (!res.ok) throw (res.error || new Error('插入艺术字失败（当前 WPS 版本可能不支持该 API）'))



    var shape = res.value

    // Best effort placement: do not assign shape.Anchor (some WPS builds throw on it).

    return shape

  }



  function _docStorageId() {

    var doc = null

    try { doc = _getDoc() } catch (e0) { doc = null }

    var name = ''

    try { name = String(doc && (doc.FullName || doc.fullName) || '') } catch (e1) { name = '' }

    try { if (!name) name = String(doc && (doc.Name || doc.name) || '') } catch (e2) { name = name || '' }

    return String(name || '')

  }



  function _blockStorageKey(blockId) {

    var docId = _docStorageId()

    var id = String(blockId || '')

    return '__ah32:block_backup:' + docId + ':' + id

  }



  function _saveBlockBackup(blockId, text) {

    _saveBlockBackupPayload(blockId, { text: String(text || '') })

  }



  function _saveBlockBackupPayload(blockId, payload) {

    try {

      if (typeof localStorage === 'undefined') return

      var key = _blockStorageKey(blockId)

      var p = (payload && typeof payload === 'object') ? payload : {}

      if (!p.ts) {

        try { p.ts = (new Date()).toISOString() } catch (e0) { p.ts = String(new Date()) }

      }

      localStorage.setItem(key, JSON.stringify(p))

    } catch (e) { _diagPush('audit_ops', e, { op: String(op || '') }) }

  }



  function _loadBlockBackup(blockId) {

    try {

      if (typeof localStorage === 'undefined') return null

      var key = _blockStorageKey(blockId)

      var raw = localStorage.getItem(key)

      if (!raw) return null

      try { return JSON.parse(raw) } catch (e2) { return null }

    } catch (e) {

      return null

    }

  }



  function hasBlockBackup(blockId) {

    _guard('hasBlockBackup', {})

    var id = String(blockId || '')

    if (!id) return false

    var payload = _loadBlockBackup(id)

    if (!payload || typeof payload !== 'object') return false

    if (typeof payload.text === 'string') return true

    if (Array.isArray(payload.ops) && payload.ops.length > 0) return true

    return false

  }



  function getBlockText(blockId) {

    _guard('getBlockText', {})

    var id = String(blockId || 'ah32_auto')

    var doc = _getDoc()

    if (!doc) throw new Error('WPS 文档不可用，无法读取产物')

    var bmName = _bookmarkName(id)

    if (_supportsBookmarks(doc)) {

      var bmR = _getBookmarkRange(doc, bmName)

      if (bmR) {

        try { return String(bmR.Text || '') } catch (e0) { return '' }

      }

    }

    var startTag = _tag(id, 'START')

    var endTag = _tag(id, 'END')

    var startR = _findTextRange(doc, startTag)

    if (!startR) return ''

    var endR = _findTextRange(doc, endTag, startR.End)

    if (!endR) return ''

    var inner = null

    try { inner = _getDocRange(doc, startR.End, endR.Start) } catch (e1) { inner = null }

    if (!inner) return ''

    try { return String(inner.Text || '') } catch (e2) { return '' }

  }



  function setBlockText(blockId, text) {

    _guard('setBlockText', { textLen: String(text || '').length })

    var id = String(blockId || 'ah32_auto')

    var doc = _getDoc()

    if (!doc) throw new Error('WPS 文档不可用，无法写入产物')

    var bmName = _bookmarkName(id)

    if (_supportsBookmarks(doc)) {

      var bmR = _getBookmarkRange(doc, bmName)

      if (bmR) {

        _safe(function () { bmR.Text = String(text || '') })

        return true

      }

    }

    var startTag = _tag(id, 'START')

    var endTag = _tag(id, 'END')

    var startR = _findTextRange(doc, startTag)

    if (!startR) throw new Error('BlockNotFound: ' + id)

    var endR = _findTextRange(doc, endTag, startR.End)

    if (!endR) throw new Error('BlockNotFound: ' + id)

    var inner = _getDocRange(doc, startR.End, endR.Start)

    if (!inner) throw new Error('BlockNotFound: ' + id)

    _safe(function () { inner.Text = String(text || '') })

    return true

  }



  function _rollbackAnswerModeOps(ops) {

    _guard('rollbackAnswerMode', {})

    var doc = _getDoc()

    if (!doc) throw new Error('WPS 文档不可用，无法回退答题写回')

    var list = Array.isArray(ops) ? ops : []

    var restored = 0

    for (var i = 0; i < list.length; i++) {

      var op = list[i] || {}

      var mid = ''

      try { mid = String(op.marker || op.marker_id || op.markerId || op.id || '') } catch (e0) { mid = '' }

      if (!mid) continue

      var prev = ''

      try {

        if (typeof op.prevText === 'string') prev = op.prevText

        else if (typeof op.prev === 'string') prev = op.prev

        else if (typeof op.text === 'string') prev = op.text

        else prev = String(op.prevText || op.prev || op.text || '')

      } catch (e1) { prev = '' }



      var startTag = _tag(mid, 'START')

      var endTag = _tag(mid, 'END')

      var startR = _findTextRange(doc, startTag)

      if (!startR) throw new Error('AnswerRollbackFailed: start_marker_not_found: ' + mid)

      var endR = _findTextRange(doc, endTag, startR.End)

      if (!endR) throw new Error('AnswerRollbackFailed: end_marker_not_found: ' + mid)

      var r = _getDocRange(doc, startR.Start, endR.End)

      if (!r) throw new Error('AnswerRollbackFailed: range_not_found: ' + mid)

      _safe(function () { r.Text = String(prev || '') })

      restored++

    }

    if (restored <= 0) throw new Error('AnswerRollbackFailed: no operations restored')

    return true

  }



  function rollbackBlock(blockId) {

    _guard('rollbackBlock', {})

    var id = String(blockId || 'ah32_auto')

    var payload = _loadBlockBackup(id)

    if (payload && typeof payload === 'object') {

      try {

        if (String(payload.kind || '') === 'answer_mode' && Array.isArray(payload.ops) && payload.ops.length > 0) {

          return _rollbackAnswerModeOps(payload.ops)

        }

      } catch (e0) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e0, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e0) }

      try {

        if (typeof payload.text === 'string') return setBlockText(id, payload.text)

      } catch (e1) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e1, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e1) }

    }

    if (!payload || typeof payload.text !== 'string') {

      throw new Error('NoBackup: 未找到可回退的上一版（apply_with_backup 未启用或该产物尚无历史）')

    }

    return setBlockText(id, payload.text)

  }



  function _writebackMode() {

    try {

      }

    } catch (e) { _diagPush('limits', e) }

    return 'apply_with_backup'

  }



  function _backupEnabled(opts) {

    try { if (opts && opts.backup === false) return false } catch (e0) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e0, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e0) }

    var mode = _writebackMode()

    if (mode === 'preview_only') return false

    if (mode === 'apply') return false

    return true

  }



  function _changeLogEnabled(opts, blockId) {

    var id = String(blockId || '')

    if (id === '__ah32_change_log_v1') return false

    try { if (opts && opts.changeLog === false) return false } catch (e0) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e0, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e0) }

    // Only enable changelog in the safest mode (apply_with_backup) to avoid cluttering docs unexpectedly.

    var mode = _writebackMode()

    return mode === 'apply_with_backup'

  }



  function _ensureChangeLogBlock(doc, selection) {

    // Always use marker anchors for the changelog (bookmark range update semantics vary across WPS builds).

    var id = '__ah32_change_log_v1'

    var startTag = _tag(id, 'START')

    var endTag = _tag(id, 'END')

    var startR = _findTextRange(doc, startTag)

    var endR = null

    if (startR) endR = _findTextRange(doc, endTag, startR.End)

    if (startR) _formatMarkerRange(startR)

    if (endR) _formatMarkerRange(endR)



    if (startR && endR) return { startR: startR, endR: endR }



    // Create at document end.

    try {

      var endPos = null

      try { endPos = doc.Range().End } catch (e0) { _diagPush('wps_anchor_end_range', e0) }

      if (typeof endPos === 'number') {

        try { if (typeof selection.SetRange === 'function') selection.SetRange(endPos, endPos) } catch (e1) { _diagPush('wps_anchor_end_setrange', e1) }

        try { if (selection.Range && typeof selection.Range.SetRange === 'function') selection.Range.SetRange(endPos, endPos) } catch (e2) { _diagPush('wps_anchor_end_setrange_fallback', e2) }

      }

    } catch (e3) { _diagPush('wps_anchor_end', e3) }



    _insertMarkerAtSelection(doc, selection, startTag)

    _safe(function () { selection.TypeParagraph && selection.TypeParagraph() })

    _safe(function () { selection.TypeText && selection.TypeText('变更记录') })

    _safe(function () { selection.TypeParagraph && selection.TypeParagraph() })

    _insertMarkerAtSelection(doc, selection, endTag)

    _safe(function () { selection.TypeParagraph && selection.TypeParagraph() })



    startR = _findTextRange(doc, startTag)

    endR = null

    if (startR) endR = _findTextRange(doc, endTag, startR.End)

    if (startR) _formatMarkerRange(startR)

    if (endR) _formatMarkerRange(endR)

    if (startR && endR) return { startR: startR, endR: endR }

    return null

  }



  function _appendChangeLogEntry(blockId, prevText, nextText) {

    _guard('appendChangeLogEntry', {})

    var doc = _getDoc()

    var selection = _getSelection()

    if (!doc || !selection) return false



    var entry = ''

    try {

      var ts = ''

      try { ts = (new Date()).toISOString() } catch (e0) { ts = String(new Date()) }

      var beforeLen = 0

      var afterLen = 0

      try { beforeLen = String(prevText || '').length } catch (e1) { beforeLen = 0 }

      try { afterLen = String(nextText || '').length } catch (e2) { afterLen = 0 }

      entry = ts + ' blockId=' + String(blockId || '') + ' len ' + beforeLen + '->' + afterLen

    } catch (e3) {

      entry = String(blockId || '')

    }

    if (!entry) return false



    var saved = _freezeSelection(selection)

    try {

      var b = _ensureChangeLogBlock(doc, selection)

      if (!b || !b.startR || !b.endR) return false



      // Insert just before END marker, inside the changelog block.

      var pos = null

      try { pos = b.endR.Start } catch (e4) { pos = null }

      if (typeof pos !== 'number') return false

      var r = _getDocRange(doc, pos, pos)

      if (!r) return false

      _safe(function () { r.Text = String(entry) })

      _safe(function () { r.InsertParagraphAfter && r.InsertParagraphAfter() })

      return true

    } finally {

      if (saved) _restoreSelection(selection, saved)

    }

  }



  function _currentBlockId() {

    try {

      if (typeof window !== 'undefined' && window.__BID_AUDIT_BLOCK_ID) {

        return String(window.__BID_AUDIT_BLOCK_ID || '').trim()

      }

    } catch (e) { _diagPush('audit_ops', e, { op: String(op || '') }) }

    return ''

  }



  function _answerMarkerId(blockId, qid) {

    var ah32 = String(blockId || '').trim() || 'ah32_auto'

    var q = String(qid || '').trim()

    if (!q) q = 'q'

    // Keep it short and marker-safe.

    q = q.replace(/[^a-zA-Z0-9_\\-:.]/g, '_')

    if (q.length > 24) q = q.slice(0, 24)

    var id = ah32.replace(/[^a-zA-Z0-9_\\-:.]/g, '_')

    if (id.length > 32) id = id.slice(0, 32)

    return id + ':ans:' + q

  }



  function _stripSpaces(s) {

    try { return String(s || '').replace(/\\s+/g, '') } catch (e) { return String(s || '') }

  }



  function _isLikelyAnswerSlotInner(inner) {

    var t = _stripSpaces(inner)

    if (!t) return true

    if (t.indexOf('[[AH32:') >= 0) return true

    if (/^_+$/.test(t) || /^＿+$/.test(t)) return true

    // Single-choice/common marks.

    if (/^[A-H]$/.test(t)) return true

    if (/^(?:√|×|对|错|正确|错误)$/.test(t)) return true

    // Pure digits like （1） are usually part of the stem, not an answer slot.

    if (/^[0-9]+$/.test(t)) return false

    // Avoid overwriting real text.

    if (/[\\u4e00-\\u9fff]/.test(t)) return false

    return t.length <= 2

  }



  function _findParenSlot(text, openCh, closeCh) {

    var s = String(text || '')

    var idx = 0

    while (idx < s.length) {

      var i = s.indexOf(openCh, idx)

      if (i < 0) break

      var j = s.indexOf(closeCh, i + 1)

      if (j < 0) break

      // Too long: likely not an answer slot.

      if ((j - i) > 24) { idx = i + 1; continue }

      var inner = s.slice(i + 1, j)

      if (_isLikelyAnswerSlotInner(inner)) {

        return { kind: 'paren', start: i + 1, end: j }

      }

      idx = j + 1

    }

    return null

  }



  function _findUnderlineSlot(text) {

    var s = String(text || '')

    var m1 = s.match(/_{2,}/)

    if (m1 && typeof m1.index === 'number') {

      return { kind: 'underline', start: m1.index, end: m1.index + String(m1[0] || '').length }

    }

    var m2 = s.match(/＿{2,}/)

    if (m2 && typeof m2.index === 'number') {

      return { kind: 'underline', start: m2.index, end: m2.index + String(m2[0] || '').length }

    }

    return null

  }



  function _findAnswerSlotInWindowText(text) {

    var s = String(text || '')

    // Prefer empty-ish parentheses first, then underline blanks.

    var p1 = _findParenSlot(s, '（', '）')

    if (p1) return p1

    var p2 = _findParenSlot(s, '(', ')')

    if (p2) return p2

    var u = _findUnderlineSlot(s)

    if (u) return u

    return null

  }



  function _findQuestionAnchorRange(doc, qid, startAt) {

    var q = String(qid || '').trim()

    if (!q) return null



    var cands = []

    // Direct text (user may pass "第1题" / "(1)" / "1、").

    cands.push(q)



    // Common numeric patterns.

    if (/^[0-9]+$/.test(q)) {

      cands.push('第' + q + '题')

      cands.push('第' + q + '小题')

      cands.push(q + '、')

      cands.push(q + '.')

      cands.push(q + '．')

      cands.push(q + ')')

      cands.push(q + '）')

      cands.push('(' + q + ')')

      cands.push('（' + q + '）')

    }



    // De-dup

    var seen = {}

    var uniq = []

    for (var i = 0; i < cands.length; i++) {

      var t = String(cands[i] || '').trim()

      if (!t) continue

      if (seen[t]) continue

      seen[t] = true

      uniq.push(t)

    }



    for (var j = 0; j < uniq.length; j++) {

      var r = _findTextRange(doc, uniq[j], startAt)

      if (r) return r

    }

    return null

  }



  function answerModeApply(arg1, arg2, arg3) {

    _guard('answerModeApply', {})

    var doc = _getDoc()

    if (!doc) throw new Error('WPS 文档不可用，无法执行答题写回')



    var blockId = ''

    var answers = null

    var opts = null



    if (Array.isArray(arg1)) {

      answers = arg1

      opts = arg2 || {}

      try { blockId = String((opts && (opts.blockId || opts.block_id)) || '') } catch (e0) { blockId = '' }

    } else {

      blockId = String(arg1 || '')

      answers = Array.isArray(arg2) ? arg2 : []

      opts = arg3 || {}

    }



    blockId = String(blockId || '').trim() || _currentBlockId() || 'ah32_answer_mode'

    try { if (typeof window !== 'undefined') window.__BID_AUDIT_BLOCK_ID = String(blockId) } catch (e1) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e1, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e1) }



    var strict = true

    try { if (opts && opts.strict === false) strict = false } catch (e2) { strict = true }

    var searchWindow = 520

    try {

      if (opts && (opts.searchWindowChars || opts.search_window_chars)) {

        searchWindow = Math.max(120, Math.min(4000, Number(opts.searchWindowChars || opts.search_window_chars) || searchWindow))

      }

    } catch (e3) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e3, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e3) }



    var docEnd = 0

    try { docEnd = Number(doc.Range().End || 0) } catch (e4) { docEnd = 0 }



    var wantBackup = _backupEnabled(opts)

    var ops = []

    var applied = []

    var failures = []



    var fromPos = 0

    for (var i = 0; i < (answers ? answers.length : 0); i++) {

      var item = answers[i] || {}

      var qid = ''

      try { qid = String(item.q || item.no || item.question || item.id || '') } catch (e5) { qid = '' }

      qid = String(qid || '').trim()

      if (!qid) continue



      var ans = ''

      try { ans = (item.answer != null ? String(item.answer) : (item.a != null ? String(item.a) : (item.text != null ? String(item.text) : ''))) } catch (e6) { ans = '' }

      ans = String(ans || '').trim()



      var markerId = _answerMarkerId(blockId, qid)

      var startTag = _tag(markerId, 'START')

      var endTag = _tag(markerId, 'END')



      var anchorR = _findQuestionAnchorRange(doc, qid, fromPos)

      if (!anchorR) {

        failures.push({ q: qid, reason: 'question_not_found' })

        continue

      }



      var anchorEnd = 0

      try { anchorEnd = Number(anchorR.End || 0) } catch (e7) { anchorEnd = 0 }

      if (!anchorEnd) {

        failures.push({ q: qid, reason: 'anchor_position_unavailable' })

        continue

      }

      fromPos = anchorEnd



      // If we previously filled this question, update between markers (idempotent).

      var startR = _findTextRange(doc, startTag, anchorEnd)

      if (startR) {

        var endR = _findTextRange(doc, endTag, startR.End)

        if (!endR) {

          failures.push({ q: qid, reason: 'marker_end_not_found' })

          continue

        }

        var segR0 = _getDocRange(doc, startR.Start, endR.End)

        var prevSeg0 = ''

        try { prevSeg0 = String(segR0 && segR0.Text || '') } catch (e8) { prevSeg0 = '' }

        ops.push({ marker: markerId, prevText: prevSeg0 })

        if (wantBackup) _saveBlockBackupPayload(blockId, { kind: 'answer_mode', ops: ops })



        var innerR = _getDocRange(doc, startR.End, endR.Start)

        if (!innerR) {

          failures.push({ q: qid, reason: 'marker_inner_not_found' })

          continue

        }

        _safe(function () { innerR.Text = String(ans || '') })

        _safe(function () { _formatMarkerRange(startR) })

        _safe(function () { _formatMarkerRange(endR) })

        applied.push({ q: qid, ok: true, mode: 'update' })

        continue

      }



      // Find the nearest placeholder slot after the anchor.

      var winStart = anchorEnd

      var winEnd = winStart + searchWindow

      if (docEnd && winEnd > docEnd) winEnd = docEnd

      var winR = _getDocRange(doc, winStart, winEnd)

      var winText = ''

      try { winText = String(winR && winR.Text || '') } catch (e9) { winText = '' }



      var slot = _findAnswerSlotInWindowText(winText)

      if (!slot) {

        failures.push({ q: qid, reason: 'placeholder_not_found' })

        continue

      }



      var slotStart = winStart + Number(slot.start || 0)

      var slotEnd = winStart + Number(slot.end || 0)

      if (slotEnd < slotStart) {

        failures.push({ q: qid, reason: 'placeholder_invalid_range' })

        continue

      }

      var slotR = _getDocRange(doc, slotStart, slotEnd)

      if (!slotR) {

        failures.push({ q: qid, reason: 'placeholder_range_unavailable' })

        continue

      }



      var prev0 = ''

      try { prev0 = String(slotR.Text || '') } catch (e10) { prev0 = '' }

      ops.push({ marker: markerId, prevText: prev0 })

      if (wantBackup) _saveBlockBackupPayload(blockId, { kind: 'answer_mode', ops: ops })



      _safe(function () { slotR.Text = String(startTag + String(ans || '') + endTag) })



      // Hide markers (best-effort).

      var s2 = _findTextRange(doc, startTag, slotStart)

      var e2 = null

      if (s2) e2 = _findTextRange(doc, endTag, s2.End)

      if (s2) _safe(function () { _formatMarkerRange(s2) })

      if (e2) _safe(function () { _formatMarkerRange(e2) })



      applied.push({ q: qid, ok: true, mode: 'insert' })

      fromPos = slotEnd

    }



    // Persist a rollback point even when strict mode fails (so the user can undo).

    if (wantBackup && ops.length > 0) {

      _saveBlockBackupPayload(blockId, { kind: 'answer_mode', ops: ops })

    }



    if (failures.length > 0 && strict) {

      var msgs = []

      for (var k = 0; k < failures.length; k++) {

        var f = failures[k] || {}

        msgs.push(String(f.q || '') + ':' + String(f.reason || 'failed'))

      }

      throw new Error('AnswerModeFailed: ' + msgs.slice(0, 8).join(', ') + (msgs.length > 8 ? ' ...' : ''))

    }



    return { ok: failures.length === 0, applied: applied, failures: failures }

  }



  // ==================== 审阅交付：对照表 -> 一键生成修订稿（不改原文） ====================

  function _cleanCellText(v) {

    var s = ''

    try { s = String(v || '') } catch (e) { s = '' }

    // Word/WPS table cell text often ends with "\r\a" (\r + bell).

    try { s = s.replace(/\u0007/g, '') } catch (e0) { _diagPush('normalize_str', e0) }

    try { s = s.replace(/\r/g, '') } catch (e1) { _diagPush('normalize_str', e1) }

    try { s = s.replace(/\s+/g, ' ') } catch (e2) { _diagPush('normalize_str', e2) }

    try { s = String(s || '').trim() } catch (e3) { s = '' }

    return s

  }



  function _tableCellText(table, row, col) {

    var txt = ''

    try { txt = String(table.Rows.Item(row).Cells.Item(col).Range.Text || '') } catch (e) { txt = '' }

    return _cleanCellText(txt)

  }



  function _getTableHeaders(table) {

    var cols = 0

    try { cols = Number(table.Columns.Count || 0) } catch (e) { cols = 0 }

    if (!cols || cols <= 0) return []

    var maxCols = cols > 12 ? 12 : cols

    var out = []

    for (var c = 1; c <= maxCols; c++) out.push(_tableCellText(table, 1, c))

    return out

  }



  function _matchHeaderIndex(headers, needles) {

    for (var i = 0; i < (headers ? headers.length : 0); i++) {

      var h = String(headers[i] || '')

      for (var j = 0; j < (needles ? needles.length : 0); j++) {

        var n = String(needles[j] || '')

        if (n && h.indexOf(n) !== -1) return i + 1

      }

    }

    return 0

  }



  function _looksLikeCompareTableHeaders(headers) {

    var idxRewrite = _matchHeaderIndex(headers, ['建议改写', '建议修改', '修改建议', '建议'])

    var idxApply = _matchHeaderIndex(headers, ['是否应用', '应用'])

    // "原文要点" may vary, keep it optional but preferred.

    var idxOrig = _matchHeaderIndex(headers, ['原文要点', '原文', '要点'])

    return !!idxRewrite && !!idxApply && (!!idxOrig || headers.length >= 4)

  }



  function _findLatestCompareTable(doc) {

    if (!doc || !doc.Tables) return null

    var count = 0

    try { count = Number(doc.Tables.Count || 0) } catch (e) { count = 0 }

    if (!count || count <= 0) return null



    for (var i = count; i >= 1; i--) {

      var t = null

      try { t = doc.Tables.Item(i) } catch (e2) { t = null }

      if (!t) continue

      var headers = _getTableHeaders(t)

      if (_looksLikeCompareTableHeaders(headers)) return t

    }

    return null

  }



  function _extractCompareTableItems(table) {

    var headers = _getTableHeaders(table)

    var idxOrig = _matchHeaderIndex(headers, ['原文要点', '原文', '要点'])

    var idxRewrite = _matchHeaderIndex(headers, ['建议改写', '建议修改', '修改建议', '建议'])

    var idxReason = _matchHeaderIndex(headers, ['理由', '原因', '依据'])

    var idxRisk = _matchHeaderIndex(headers, ['风险等级', '风险', '等级'])

    var idxApply = _matchHeaderIndex(headers, ['是否应用', '应用'])

    if (!idxRewrite) idxRewrite = 2

    if (!idxApply) idxApply = 5



    var rows = 0

    try { rows = Number(table.Rows.Count || 0) } catch (e) { rows = 0 }

    var out = []

    for (var r = 2; r <= rows; r++) {

      var item = {

        original: idxOrig ? _tableCellText(table, r, idxOrig) : '',

        rewrite: idxRewrite ? _tableCellText(table, r, idxRewrite) : '',

        reason: idxReason ? _tableCellText(table, r, idxReason) : '',

        risk: idxRisk ? _tableCellText(table, r, idxRisk) : '',

        apply: idxApply ? _tableCellText(table, r, idxApply) : ''

      }

      if (!item.original && !item.rewrite && !item.reason && !item.risk && !item.apply) continue

      out.push(item)

    }

    return out

  }



  function _isApplyYes(v) {

    var t = ''

    try { t = String(v || '').trim().toLowerCase() } catch (e) { t = '' }

    if (!t) return false

    if (t === '是' || t === 'y' || t === 'yes' || t === 'true' || t === '1') return true

    if (t.indexOf('✅') !== -1 || t.indexOf('✔') !== -1) return true

    if (t.indexOf('已应用') !== -1) return true

    return false

  }



  function applyLatestCompareTableAsRevision(opts) {

    _guard('applyLatestCompareTableAsRevision', {})

    opts = opts || {}



    var doc = _getDoc()

    var selection = _getSelection()

    if (!doc || !selection) throw new Error('WPS 文档/光标不可用，无法一键应用对照表')



    var table = _findLatestCompareTable(doc)

    if (!table) {

      throw new Error('CompareTableNotFound: 未找到“对照表交付”表格（请先生成对照表，并确保表头包含“建议改写/是否应用”）')

    }



    var items = _extractCompareTableItems(table)

    if (!items || items.length === 0) throw new Error('CompareTableEmpty: 对照表为空，无法应用')



    var selected = []

    for (var i = 0; i < items.length; i++) {

      var it = items[i] || {}

      if (_isApplyYes(it.apply)) selected.push(it)

    }

    if (selected.length === 0) {

      throw new Error('NoRowsSelected: 请在“是否应用”列填“是”，再点击“一键应用”生成修订稿')

    }



    var blockId = ''

    try { blockId = String(opts.blockId || opts.block_id || '') } catch (e0) { blockId = '' }

    blockId = String(blockId || '').trim() || _currentBlockId() || 'ah32_revision'



    var anchor = ''

    try { anchor = String(opts.anchor || opts.anchorTo || opts.anchor_to || '') } catch (e1) { anchor = '' }

    anchor = String(anchor || '').trim() || 'end'



    var title = ''

    try { title = String(opts.title || '') } catch (e2) { title = '' }

    title = String(title || '').trim() || '修订稿/替换条款汇总（自动生成）'



    var ts = ''

    try { ts = (new Date()).toISOString() } catch (e3) { ts = String(new Date()) }



    var lines = []

    lines.push(String(title))

    lines.push('生成时间: ' + String(ts))

    lines.push('说明: 本段为“对照表”中勾选为“是”的条目汇总，不会直接修改原正文。')

    lines.push('')



    for (var k = 0; k < selected.length; k++) {

      var x = selected[k] || {}

      var n = k + 1

      var rw = String(x.rewrite || '').trim()

      var rs = String(x.reason || '').trim()

      var rk = String(x.risk || '').trim()

      lines.push(String(n) + '. ' + (rw || '[空]'))

      if (rk) lines.push('   风险等级: ' + rk)

      if (rs) lines.push('   理由: ' + rs)

      lines.push('')

    }



    var content = lines.join('\n')



    return upsertBlock(

      blockId,

      function () {

        var sel = _getSelection()

        if (!sel) throw new Error('WPS 光标不可用')

        try { if (sel.Range) sel.Range.Text = String(content || '') } catch (e4) {

          try { sel.Text = String(content || '') } catch (e5) { throw e4 }

        }

      },

      { anchor: anchor }

    )

  }



  function _supportsTrackRevisions(doc) {

    try { return typeof (doc && doc.TrackRevisions) !== 'undefined' } catch (e) { return false }

  }



  function enableTrackRevisions(enabled) {

    _guard('enableTrackRevisions', {})

    var doc = _getDoc()

    if (!doc) throw new Error('WPS 文档不可用，无法开启修订')

    if (!_supportsTrackRevisions(doc)) throw new Error('TrackRevisionsUnsupported: 当前版本不支持修订模式')

    var on = !!enabled

    try {

      doc.TrackRevisions = on ? 1 : 0

      return true

    } catch (e0) {

      var msg = ''

      try { msg = String(e0 && e0.message || e0 || '') } catch (e1) { msg = '' }

      throw new Error('TrackRevisionsSetFailed: ' + msg)

    }

  }



  function addCommentAtText(anchorText, commentText, opts) {

    _guard('addCommentAtText', { textLen: String(anchorText || '').length + String(commentText || '').length })

    opts = opts || {}

    var doc = _getDoc()

    var selection = _getSelection()

    if (!doc || !selection) throw new Error('WPS 文档/光标不可用，无法插入批注')



    var range = null

    try {

      var t = String(anchorText || '').trim()

      if (t) range = _findTextRange(doc, t)

    } catch (e0) { range = null }

    try {

      if (!range && selection.Range) range = selection.Range

    } catch (e1) { range = range }



    if (!range) throw new Error('CommentAnchorNotFound: 找不到批注锚点')

    try {

      if (doc.Comments && typeof doc.Comments.Add === 'function') {

        doc.Comments.Add(range, String(commentText || ''))

        return true

      }

    } catch (e2) { _diagPush('wps_comment_add', e2) }

    try {

      // Some WPS builds expose Comments as a callable collection.

      if (doc.Comments && typeof doc.Comments === 'function' && typeof doc.Comments().Add === 'function') {

        doc.Comments().Add(range, String(commentText || ''))

        return true

      }

    } catch (e3) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e3, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e3) }

    throw new Error('CommentsAddUnsupported: 当前版本不支持批注 API')

  }



  function upsertBlock(blockId, fn, opts) {

    _guard('upsertBlock', {})

    opts = opts || {}

    var id = String(blockId || 'ah32_auto')

    try { if (typeof window !== 'undefined') window.__BID_AUDIT_BLOCK_ID = id } catch (e) { _diagPush('audit_block_id', e) }

    var startTag = _tag(id, 'START')

    var endTag = _tag(id, 'END')

    var bmName = _bookmarkName(id)

    var doc = _getDoc()

    var selection = _getSelection()

    if (!doc || !selection) throw new Error('WPS 文档/光标不可用，无法执行宏任务')



    var __wantBackup = _backupEnabled(opts)

    var __wantChangeLog = __wantBackup && _changeLogEnabled(opts, id)



    // Prefer Bookmarks as invisible anchors (no marker text in正文). Fallback to hidden text markers.

    var __anchorMode = null

    try { __anchorMode = opts.anchorMode || opts.anchor_mode || opts.anchormode } catch (e0) { __anchorMode = null }

    var __mode = String(__anchorMode || 'auto').toLowerCase()

    if (__mode === 'bookmark-only') __mode = 'bookmark_only'

    if (__mode === 'marker-only' || __mode === 'text') __mode = 'marker_only'



    if (__mode === 'bookmark_only' && !_supportsBookmarks(doc)) {

      throw new Error('BookmarkAnchorUnavailable: 当前 WPS 版本/宿主不支持 Bookmarks，无法使用 bookmark_only 锚点')

    }



    if (__mode !== 'marker_only' && _supportsBookmarks(doc)) {

      var bmR = _getBookmarkRange(doc, bmName)

      // Optional anchor control:

      // - default: current cursor/selection

      // - opts.anchor === 'end': insert/update block at document end without using EndKey/GoTo

      if (opts && opts.anchor === 'end') {

        try {

          var endPos0 = null

          try { endPos0 = doc.Range().End } catch (e0) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e0, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e0) }

          if (typeof endPos0 === 'number') {

            try { if (typeof selection.SetRange === 'function') selection.SetRange(endPos0, endPos0) } catch (e1) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e1, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e1) }

            try { if (selection.Range && typeof selection.Range.SetRange === 'function') selection.Range.SetRange(endPos0, endPos0) } catch (e2) { _diagPush('wps_setrange_fallback', e2) }

            try {

              var endRng0 = _getDocRange(doc, endPos0, endPos0)

              if (endRng0 && typeof endRng0.Select === 'function') endRng0.Select()

            } catch (e3) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e3, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e3) }

          }

        } catch (e4) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e4, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e4) }

      }



      var _savedSelection0 = null

      if (!(opts && opts.freezeCursor === false)) _savedSelection0 = _freezeSelection(selection)



      // Update existing bookmark block.

      if (bmR) {

        var startPosB = null

        try { startPosB = bmR.Start } catch (e5) { startPosB = null }

        var endPosB = null

        try { endPosB = bmR.End } catch (e6) { endPosB = null }

        if (typeof startPosB === 'number' && typeof endPosB === 'number' && endPosB >= startPosB) {

          var __prevTextB = ''

          // Clear content first (bookmark may be removed by deletion; we'll re-add after).

            try {

              var oldR = _getDocRange(doc, startPosB, endPosB)

              if (oldR) {

                var prev = ''

                try { prev = String(oldR.Text || '') } catch (e0) { prev = '' }

                __prevTextB = prev

                // Default to apply_with_backup: capture the previous version (best-effort).

                try { if (__wantBackup) _saveBlockBackup(id, prev) } catch (e1) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e1, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e1) }

                _safe(function () { oldR.Text = '' })

                _safe(function () { oldR.Delete && oldR.Delete() })

              }

            } catch (e7) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e7, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e7) }

          _safe(function () { _deleteBookmark(doc, bmName) })



          // Re-enter at start pos.

          _safe(function () {

            var anchor = _getDocRange(doc, startPosB, startPosB)

            if (anchor && typeof anchor.Select === 'function') anchor.Select()

          })

          _safe(function () { if (typeof selection.SetRange === 'function') selection.SetRange(startPosB, startPosB) })

          _safe(function () { if (selection.Range && typeof selection.Range.SetRange === 'function') selection.Range.SetRange(startPosB, startPosB) })



          // Keep the same paragraph isolation behavior as marker mode.

          _safe(function () { selection.TypeParagraph && selection.TypeParagraph() })

          var contentStartB = null

          try { contentStartB = selection.Range ? selection.Range.Start : null } catch (e8) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e8, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e8) }

          if (typeof contentStartB !== 'number') contentStartB = startPosB



          var retB

          try {

            retB = fn ? fn() : undefined

          } finally {

            if (_savedSelection0) _restoreSelection(selection, _savedSelection0)

          }



          _safe(function () { selection.TypeParagraph && selection.TypeParagraph() })

          var contentEndB = null

          try { contentEndB = selection.Range ? selection.Range.End : null } catch (e9) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e9, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e9) }

          if (typeof contentEndB !== 'number') {

            try { contentEndB = doc.Range().End } catch (e10) { contentEndB = contentStartB }

          }



          var nr = null

          try { nr = _getDocRange(doc, contentStartB, contentEndB) } catch (e11) { nr = null }

          if (nr) {

            // Fallback: some macros return text but forgot to write to the document.

            // If the block is still empty, materialize the returned string into the block range.

            try {

              if (typeof retB === 'string' && String(retB).trim()) {

                var txt0 = ''

                try { txt0 = String(nr.Text || '') } catch (e0) { txt0 = '' }

                var compact0 = ''

                try { compact0 = txt0.replace(/\\s+/g, '') } catch (e1) { compact0 = txt0 }

                if (!compact0 || compact0.length < 2) {

                  _safe(function () { nr.Text = String(retB) })

                }

              }

            } catch (e2) { _diagPush('wps_upsert_block', e2) }

            _safe(function () { _addBookmark(doc, bmName, nr) })

            // If this macro was wrapped as an "insert task" but inserted nothing, treat as failure so auto-repair can kick in.

            if (retB === null || retB === undefined) {

              var txtB = ''

              try { txtB = String(nr.Text || '') } catch (e12) { txtB = '' }

              var compactB = ''

              try { compactB = txtB.replace(/\s+/g, '') } catch (e13) { compactB = txtB }

              var hasTablesB = false

              try { hasTablesB = !!(nr.Tables && nr.Tables.Count && nr.Tables.Count > 0) } catch (e14) { hasTablesB = false }

              if (!hasTablesB && (!compactB || compactB.length < 5)) {

                throw new Error('NoContentInserted: upsertBlock produced empty output')

              }

            }

          }



          // Best-effort: append a visible change log entry (only in apply_with_backup mode).

          try {

            if (__wantChangeLog) {

              var nextB = ''

              try { nextB = String(getBlockText(id) || '') } catch (e0) { nextB = '' }

              if (String(nextB || '') !== String(__prevTextB || '')) {

                _appendChangeLogEntry(id, __prevTextB, nextB)

              }

            }

          } catch (e1) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e1, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e1) }

          return retB

        }

      }



      // Create new bookmark block at cursor.

      var startPosNew = null

      try { startPosNew = selection.Range ? selection.Range.Start : null } catch (e11) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e11, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e11) }

      if (typeof startPosNew !== 'number') startPosNew = 0



      _safe(function () { selection.TypeParagraph && selection.TypeParagraph() })

      var contentStartNew = null

      try { contentStartNew = selection.Range ? selection.Range.Start : null } catch (e12) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e12, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e12) }

      if (typeof contentStartNew !== 'number') contentStartNew = startPosNew



      var __prevTextNew = ''

      // For a brand-new block, still create a rollback point to "empty" (apply_with_backup mode).

      try { if (__wantBackup) _saveBlockBackup(id, __prevTextNew) } catch (e0) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e0, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e0) }



      var retNew

      try {

        retNew = fn ? fn() : undefined

      } finally {

        if (_savedSelection0) _restoreSelection(selection, _savedSelection0)

      }



      _safe(function () { selection.TypeParagraph && selection.TypeParagraph() })

      var contentEndNew = null

      try { contentEndNew = selection.Range ? selection.Range.End : null } catch (e13) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e13, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e13) }

      if (typeof contentEndNew !== 'number') {

        try { contentEndNew = doc.Range().End } catch (e14) { contentEndNew = contentStartNew }

      }



      var nr2 = null

      try { nr2 = _getDocRange(doc, contentStartNew, contentEndNew) } catch (e15) { nr2 = null }

      if (nr2) {

        // Fallback: materialize returned string into the new block range (common for "模板" tasks).

        try {

          if (typeof retNew === 'string' && String(retNew).trim()) {

            var txt1 = ''

            try { txt1 = String(nr2.Text || '') } catch (e0) { txt1 = '' }

            var compact1 = ''

            try { compact1 = txt1.replace(/\\s+/g, '') } catch (e1) { compact1 = txt1 }

            if (!compact1 || compact1.length < 2) {

              _safe(function () { nr2.Text = String(retNew) })

            }

          }

        } catch (e2) { _diagPush('wps_upsert_block', e2) }

        _safe(function () { _addBookmark(doc, bmName, nr2) })

        if (retNew === null || retNew === undefined) {

          var txtN = ''

          try { txtN = String(nr2.Text || '') } catch (e16) { txtN = '' }

          var compactN = ''

          try { compactN = txtN.replace(/\s+/g, '') } catch (e17) { compactN = txtN }

          var hasTablesN = false

          try { hasTablesN = !!(nr2.Tables && nr2.Tables.Count && nr2.Tables.Count > 0) } catch (e18) { hasTablesN = false }

          if (!hasTablesN && (!compactN || compactN.length < 5)) {

            throw new Error('NoContentInserted: upsertBlock produced empty output')

          }

        }

      }



      try {

        if (__wantChangeLog) {

          var nextN = ''

          try { nextN = String(getBlockText(id) || '') } catch (e1) { nextN = '' }

          if (String(nextN || '') !== String(__prevTextNew || '')) {

            _appendChangeLogEntry(id, __prevTextNew, nextN)

          }

        }

      } catch (e2) { try { if (typeof window !== 'undefined') { if (!window.__BID_AUDIT_DIAG) window.__BID_AUDIT_DIAG = []; if (window.__BID_AUDIT_DIAG && window.__BID_AUDIT_DIAG.push && window.__BID_AUDIT_DIAG.length < 80) window.__BID_AUDIT_DIAG.push({ tag: 'shim', message: String((e2 && e2.message) ? e2.message : (e2 || '')).slice(0, 300), extra: null }) } } catch (_e) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', _e, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', _e) } }

      return retNew

    }



    var startR = _findTextRange(doc, startTag)

    var endR = null

    if (startR) endR = _findTextRange(doc, endTag, startR.End)

    // Ensure markers are hidden even if they were inserted by older versions.

    if (startR) _formatMarkerRange(startR)

    if (endR) _formatMarkerRange(endR)



    // Optional anchor control:

    // - default: current cursor/selection

    // - opts.anchor === 'end': insert/update block at document end without using EndKey/GoTo

    if (opts && opts.anchor === 'end') {

      try {

        var endPos = null

        try { endPos = doc.Range().End } catch (e) { _diagPush('wps_endpos', e) }

        if (typeof endPos === 'number') {

          try { if (typeof selection.SetRange === 'function') selection.SetRange(endPos, endPos) } catch (e2) { _diagPush('wps_setrange', e2) }

          try { if (selection.Range && typeof selection.Range.SetRange === 'function') selection.Range.SetRange(endPos, endPos) } catch (e3) { _diagPush('wps_setrange_fallback', e3) }

          try {

            var endRng = _getDocRange(doc, endPos, endPos)

            if (endRng && typeof endRng.Select === 'function') endRng.Select()

          } catch (e4) { _diagPush('wps_select_end_range', e4) }

        }

      } catch (e5) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e5, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e5) }

    }



    // Default: keep cursor stable inside the upsert block to avoid duplicate inserts on re-run.

    // Allow advanced macros to opt-out: BID.upsertBlock(id, fn, { freezeCursor: false })

    var _savedSelection = null

    if (!(opts && opts.freezeCursor === false)) _savedSelection = _freezeSelection(selection)



    // Create new block at cursor.

    if (!startR || !endR) {

      var __prevText1 = ''

      // For a brand-new block, still create a rollback point to "empty" (apply_with_backup mode).

      try { if (__wantBackup) _saveBlockBackup(id, __prevText1) } catch (e0) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e0, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e0) }



      _insertMarkerAtSelection(doc, selection, startTag)

      _safe(function () { selection.TypeParagraph() })



      var ret1

      try {

        ret1 = fn ? fn() : undefined

      } finally {

        if (_savedSelection) _restoreSelection(selection, _savedSelection)

      }



      _safe(function () { selection.TypeParagraph() })

      _insertMarkerAtSelection(doc, selection, endTag)

      _safe(function () { selection.TypeParagraph() })



      try {

        if (__wantChangeLog) {

          var next1 = ''

          try { next1 = String(getBlockText(id) || '') } catch (e1) { next1 = '' }

          if (String(next1 || '') !== String(__prevText1 || '')) {

            _appendChangeLogEntry(id, __prevText1, next1)

          }

        }

      } catch (e2) { try { if (typeof window !== 'undefined') { if (!window.__BID_AUDIT_DIAG) window.__BID_AUDIT_DIAG = []; if (window.__BID_AUDIT_DIAG && window.__BID_AUDIT_DIAG.push && window.__BID_AUDIT_DIAG.length < 80) window.__BID_AUDIT_DIAG.push({ tag: 'shim', message: String((e2 && e2.message) ? e2.message : (e2 || '')).slice(0, 300), extra: null }) } } catch (_e) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', _e, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', _e) } }

      return ret1

    }



    // Update existing block: clear inner content and run again at the same position.

    var __prevTextM = ''

    var contentStart = startR.End

    var contentEnd = endR.Start

    if (typeof contentStart === 'number' && typeof contentEnd === 'number' && contentEnd >= contentStart) {

      var inner = _getDocRange(doc, contentStart, contentEnd)

      if (inner) {

        try { __prevTextM = String(inner.Text || '') } catch (e0) { __prevTextM = '' }

        // Default to apply_with_backup: capture the previous version (best-effort).

        try { if (__wantBackup) _saveBlockBackup(id, __prevTextM) } catch (e1) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e1, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e1) }

        _safe(function () { inner.Text = '' })

        _safe(function () { inner.Delete && inner.Delete() })

      }

      // Move cursor to the content start (best-effort across versions).

      _safe(function () {

        var anchor = _getDocRange(doc, contentStart, contentStart)

        if (anchor && typeof anchor.Select === 'function') anchor.Select()

      })

      _safe(function () { if (typeof selection.SetRange === 'function') selection.SetRange(contentStart, contentStart) })

      _safe(function () { if (selection.Range && typeof selection.Range.SetRange === 'function') selection.Range.SetRange(contentStart, contentStart) })

    }



    var ret2

    try {

      ret2 = fn ? fn() : undefined

    } finally {

      if (_savedSelection) _restoreSelection(selection, _savedSelection)

    }

    try {

      if (__wantChangeLog) {

        var next2 = ''

        try { next2 = String(getBlockText(id) || '') } catch (e2) { next2 = '' }

        if (String(next2 || '') !== String(__prevTextM || '')) {

          _appendChangeLogEntry(id, __prevTextM, next2)

        }

      }

    } catch (e3) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e3, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e3) }

    return ret2

  }



  function deleteBlock(blockId) {

    _guard('deleteBlock', {})

    var id = String(blockId || 'ah32_auto')

    try { if (typeof window !== 'undefined') window.__BID_AUDIT_BLOCK_ID = id } catch (e) { _diagPush('audit_block_id', e) }

    var startTag = _tag(id, 'START')

    var endTag = _tag(id, 'END')

    var bmName = _bookmarkName(id)

    var doc = _getDoc()

    if (!doc) throw new Error('WPS 文档不可用，无法删除产物')



    // Prefer bookmark deletion if available.

    if (_supportsBookmarks(doc)) {

      var bmR = _getBookmarkRange(doc, bmName)

      if (bmR) {

        var bs = null

        var be = null

        try { bs = bmR.Start } catch (e0) { bs = null }

        try { be = bmR.End } catch (e1) { be = null }

        if (typeof bs === 'number' && typeof be === 'number' && be >= bs) {

          var br = _getDocRange(doc, bs, be)

          if (br) {

            _safe(function () { br.Text = '' })

            _safe(function () { br.Delete && br.Delete() })

          }

        }

        _safe(function () { _deleteBookmark(doc, bmName) })

        return true

      }

    }



    var startR = _findTextRange(doc, startTag)

    if (!startR) return false

    var endR = _findTextRange(doc, endTag, startR.End)

    if (!endR) return false



    var r = _getDocRange(doc, startR.Start, endR.End)

    if (r) {

      _safe(function () { r.Text = '' })

      _safe(function () { r.Delete && r.Delete() })

    }

    return true

  }



  function blockExists(blockId) {

    _guard('blockExists', {})

    var id = String(blockId || 'ah32_auto')

    var startTag = _tag(id, 'START')

    var endTag = _tag(id, 'END')

    var bmName = _bookmarkName(id)

    var doc = _getDoc()

    if (!doc) return false



    if (_supportsBookmarks(doc)) {

      var bmR = _getBookmarkRange(doc, bmName)

      if (bmR) return true

    }



    var startR = _findTextRange(doc, startTag)

    if (!startR) return false

    var endR = _findTextRange(doc, endTag, startR.End)

    return !!endR

  }



  function focusBlock(blockId) {

    _guard('focusBlock', {})

    var id = String(blockId || 'ah32_auto')

    var startTag = _tag(id, 'START')

    var endTag = _tag(id, 'END')

    var bmName = _bookmarkName(id)

    var doc = _getDoc()

    var selection = _getSelection()

    if (!doc || !selection) throw new Error('WPS \xe6\x96\x87\xe6\xa1\xa3/\xe5\x85\x89\xe6\xa0\x87\xe4\xb8\x8d\xe5\x8f\xaf\xe7\x94\xa8\xef\xbc\x8c\xe6\x97\xa0\xe6\xb3\x95\xe5\xae\x9a\xe4\xbd\x8d\xe4\xba\xa7\xe7\x89\xa9')



    if (_supportsBookmarks(doc)) {

      var bmR = _getBookmarkRange(doc, bmName)

      if (bmR) {

        _safe(function () { if (typeof bmR.Select === 'function') bmR.Select() })

        return true

      }

    }



    var startR = _findTextRange(doc, startTag)

    if (!startR) return false

    var endR = _findTextRange(doc, endTag, startR.End)

    if (!endR) return false



    var r = _getDocRange(doc, startR.Start, endR.End)

    if (r) _safe(function () { if (typeof r.Select === 'function') r.Select() })

    return true

  }



  return {

    safe: _safe,

    getSelection: _getSelection,

    getDocument: _getDoc,

    answerModeApply: answerModeApply,

    enableTrackRevisions: enableTrackRevisions,

    addCommentAtText: addCommentAtText,

    findTextRange: findTextRange,

    insertAfterText: insertAfterText,

    insertBeforeText: insertBeforeText,

    insertTable: insertTable,

    insertChartFromSelection: insertChartFromSelection,

    insertWordArt: insertWordArt,

    upsertBlock: upsertBlock,

    deleteBlock: deleteBlock,

    getBlockText: getBlockText,

    rollbackBlock: rollbackBlock,

    hasBlockBackup: hasBlockBackup,

    applyLatestCompareTableAsRevision: applyLatestCompareTableAsRevision,

    blockExists: blockExists,

    focusBlock: focusBlock

  }

})();



// Expose BID on window as well (some model outputs prefer window.BID checks).

try { if (typeof window !== 'undefined') window.BID = BID } catch (e) { try { if (typeof window !== 'undefined') { if (!window.__BID_AUDIT_DIAG) window.__BID_AUDIT_DIAG = []; if (window.__BID_AUDIT_DIAG && window.__BID_AUDIT_DIAG.push && window.__BID_AUDIT_DIAG.length < 80) window.__BID_AUDIT_DIAG.push({ tag: 'expose_bid', message: String((e && e.message) ? e.message : (e || '')).slice(0, 500), extra: null }) } } catch (_e) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', _e, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', _e) } }



var __ah32_app = app

var __ah32_selection = __ah32_app && __ah32_app.Selection

if (__ah32_selection) {

  if (typeof __ah32_selection.StartOf !== 'function') {

    __ah32_selection.StartOf = function () {

      try { __ah32_selection.HomeKey(6) } catch (e) { try { __ah32_selection.HomeKey() } catch (_) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', _, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', _) } }

    }

  }

  if (typeof __ah32_selection.EndOf !== 'function') {

    __ah32_selection.EndOf = function () {

      try { __ah32_selection.EndKey(6) } catch (e) { try { __ah32_selection.EndKey() } catch (_) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', _, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', _) } }

    }

  }

  if (typeof __ah32_selection.GoTo !== 'function') {

    __ah32_selection.GoTo = function (line) {

      try {

        var __line = Number(line)

        if (!__line || __line < 1) return

        try { __ah32_selection.HomeKey(6) } catch (e) { try { __ah32_selection.HomeKey() } catch (_) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', _, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', _) } }

        for (var __i = 1; __i < __line; __i++) {

          try { __ah32_selection.MoveDown() } catch (e) { break }

        }

      } catch (e) { try { if (typeof window !== 'undefined') { if (!window.__BID_AUDIT_DIAG) window.__BID_AUDIT_DIAG = []; if (window.__BID_AUDIT_DIAG && window.__BID_AUDIT_DIAG.push && window.__BID_AUDIT_DIAG.length < 80) window.__BID_AUDIT_DIAG.push({ tag: 'shim', message: String((e && e.message) ? e.message : (e || '')).slice(0, 300), extra: null }) } } catch (_e) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', _e, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', _e) } }

    }

  }

  if (typeof __ah32_selection.TypeText !== 'function') {

    __ah32_selection.TypeText = function (text) {

      try {

        if (__ah32_selection.Range) {

          __ah32_selection.Range.Text = String(text || '')

        }

      } catch (e) { try { if (typeof window !== 'undefined') { if (!window.__BID_AUDIT_DIAG) window.__BID_AUDIT_DIAG = []; if (window.__BID_AUDIT_DIAG && window.__BID_AUDIT_DIAG.push && window.__BID_AUDIT_DIAG.length < 80) window.__BID_AUDIT_DIAG.push({ tag: 'shim', message: String((e && e.message) ? e.message : (e || '')).slice(0, 300), extra: null }) } } catch (_e) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', _e, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', _e) } }

    }

  }

  if (typeof __ah32_selection.TypeParagraph !== 'function') {

    __ah32_selection.TypeParagraph = function () {

      try {

        if (__ah32_selection.Range && typeof __ah32_selection.Range.InsertParagraphAfter === 'function') {

          __ah32_selection.Range.InsertParagraphAfter()

          return

        }

      } catch (e) { try { if (typeof window !== 'undefined') { if (!window.__BID_AUDIT_DIAG) window.__BID_AUDIT_DIAG = []; if (window.__BID_AUDIT_DIAG && window.__BID_AUDIT_DIAG.push && window.__BID_AUDIT_DIAG.length < 80) window.__BID_AUDIT_DIAG.push({ tag: 'shim', message: String((e && e.message) ? e.message : (e || '')).slice(0, 300), extra: null }) } } catch (_e) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', _e, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', _e) } }

      try {

        if (__ah32_selection.Range) __ah32_selection.Range.Text = '\\n'

      } catch (e2) { try { if (typeof window !== 'undefined') { if (!window.__BID_AUDIT_DIAG) window.__BID_AUDIT_DIAG = []; if (window.__BID_AUDIT_DIAG && window.__BID_AUDIT_DIAG.push && window.__BID_AUDIT_DIAG.length < 80) window.__BID_AUDIT_DIAG.push({ tag: 'shim', message: String((e2 && e2.message) ? e2.message : (e2 || '')).slice(0, 300), extra: null }) } } catch (_e) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', _e, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', _e) } }

    }

  }

}

// ------------------------------------------------------------------

`



    // ET (spreadsheets): store each artifact in its own worksheet to guarantee idempotency.

    const etPreamble = `

// ---- Ah32 WPS JS runtime shims (safe no-op when APIs exist) ----

if (typeof RGB !== 'function') {

  function RGB(r, g, b) {

    var rr = Number(r) & 255

    var gg = Number(g) & 255

    var bb = Number(b) & 255

    return rr + (gg << 8) + (bb << 16)

  }

}



// ---- Ah32 helper facade for ET (best-effort across WPS versions) ----

var BID = (function () {

  function _diagPush(tag, e, extra) {
    try {
      if (typeof window === 'undefined') return
      var a = window.__BID_AUDIT_DIAG
      if (!a || typeof a.push !== 'function') {
        a = []
        window.__BID_AUDIT_DIAG = a
      }
      if (a.length >= 80) return
      var msg = ''
      try { msg = e && e.message ? String(e.message) : String(e || '') } catch (_e2) { msg = '' }
      a.push({ tag: String(tag || ''), message: msg.slice(0, 500), extra: extra || null })
    } catch (_e) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', _e, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', _e) }
  }

  function _limits() {

    var d = { maxOps: 200, maxTextLen: 20000, maxTableCells: 500, deadlineMs: 45000 }

    try {

      var cfg = null
      if (cfg && typeof cfg === 'object') {

        if (cfg.maxOps != null) d.maxOps = Math.max(1, Math.min(2000, Number(cfg.maxOps) || d.maxOps))

        if (cfg.maxTextLen != null) d.maxTextLen = Math.max(100, Math.min(200000, Number(cfg.maxTextLen) || d.maxTextLen))

        if (cfg.maxTableCells != null) d.maxTableCells = Math.max(10, Math.min(5000, Number(cfg.maxTableCells) || d.maxTableCells))

        if (cfg.deadlineMs != null) d.deadlineMs = Math.max(1000, Math.min(300000, Number(cfg.deadlineMs) || d.deadlineMs))

      }

    } catch (e) { _diagPush('limits', e) }

    return d

  }

  var __limits = _limits()

  var __startedAt = Date.now()

  var __ops = 0

  function _isCancelled() {

    try { return !!(typeof window !== 'undefined' && window.__BID_CANCEL_MACRO) } catch (e) { return false }

  }

  function _guard(op, payload) {

    __ops = __ops + 1

    if (__ops > __limits.maxOps) throw new Error('MacroSafetyError: maxOps exceeded')

    if ((Date.now() - __startedAt) > __limits.deadlineMs) throw new Error('MacroSafetyError: deadline exceeded')

    if (_isCancelled()) throw new Error('MacroSafetyError: cancelled')

    if (payload && payload.textLen && payload.textLen > __limits.maxTextLen) throw new Error('MacroSafetyError: maxTextLen exceeded')

    if (payload && payload.tableCells && payload.tableCells > __limits.maxTableCells) throw new Error('MacroSafetyError: maxTableCells exceeded')

    try {

      if (typeof window !== 'undefined') {

        if (!window.__BID_AUDIT_OPS) window.__BID_AUDIT_OPS = []

        window.__BID_AUDIT_OPS.push(String(op || ''))

      }

    } catch (e) { _diagPush('audit_ops', e, { op: String(op || '') }) }

    return true

  }

  function _safe(fn) { try { return { ok: true, value: fn() } } catch (e) { _diagPush('safe', e); return { ok: false, error: e } } }



  function _sanitizeSheetName(name) {

    // Excel/WPS: max 31 chars, cannot contain : \\ / ? * [ ]

    var s = String(name || 'AH32')

    s = s.replace(/[:\\\\/\\?\\*\\[\\]]/g, '_')

    if (s.length > 31) s = s.slice(0, 31)

    if (!s) s = 'AH32'

    return s

  }



  function _getWb() {

    try { if (app && app.ActiveWorkbook) return app.ActiveWorkbook } catch (e) { _diagPush('et_active_workbook', e) }

    try { if (app && app.Workbooks && app.Workbooks.Count > 0) return app.Workbooks.Item(1) } catch (e2) { _diagPush('et_workbooks_fallback', e2) }

    return null

  }



  function _getOrCreateSheet(wb, name) {

    var sheets = null

    try { sheets = wb.Worksheets } catch (e) { _diagPush('et_worksheets', e) }

    if (!sheets) throw new Error('工作簿缺少 Worksheets')

    var count = 0

    try { count = sheets.Count } catch (e2) { count = 0 }

    for (var i = 1; i <= count; i++) {

      var s = null

      try { s = sheets.Item(i) } catch (e3) { s = null }

      if (!s) continue

      var n = ''

      try { n = String(s.Name || '') } catch (e4) { n = '' }

      if (n === name) return s

    }

    var created = null

    var res = _safe(function () { return sheets.Add() })

    if (res.ok) created = res.value

    if (!created) throw new Error('创建工作表失败')

    _safe(function () { created.Name = name })

    return created

  }



  function upsertBlock(blockId, fn, opts) {

    _guard('upsertBlock', {})

    opts = opts || {}

    var id = String(blockId || 'ah32_auto')

    try { if (typeof window !== 'undefined') window.__BID_AUDIT_BLOCK_ID = id } catch (e) { _diagPush('audit_block_id', e) }

    var wb = _getWb()

    if (!wb) throw new Error('WPS 工作簿不可用，无法执行宏任务')



    var suffix = id.replace(/[^a-zA-Z0-9_\\-]/g, '_')

    if (suffix.length > 20) suffix = suffix.slice(0, 20)

    var sheetName = _sanitizeSheetName(String(opts.sheetName || ('BID_' + suffix)))

    var sheet = _getOrCreateSheet(wb, sheetName)



    _safe(function () { if (typeof sheet.Activate === 'function') sheet.Activate() })



    // Clear previous artifact content to avoid duplicates.

    var cleared = _safe(function () { if (sheet.Cells && typeof sheet.Cells.Clear === 'function') sheet.Cells.Clear() })

    if (!cleared.ok) _safe(function () { if (sheet.UsedRange && typeof sheet.UsedRange.Clear === 'function') sheet.UsedRange.Clear() })



    // Put cursor at A1 for deterministic inserts.

    _safe(function () { if (sheet.Range) sheet.Range('A1').Select() })



    // Backward compat: some model outputs call BID.upsertBlock(blockId, {type:..., ...}).

    // Convert to supported signature upsertBlock(blockId, fn, opts) and keep execution observable.

    if (fn && typeof fn !== 'function' && typeof fn === 'object') {

      var payload = fn

      fn = function () {

        var t = ''

        try { t = String(payload.type || '') } catch (e0) { t = '' }

        if (t === 'chart') {

          try {

            if (Array.isArray(payload.data) && payload.data.length > 0) {

              var headers = payload.data[0]

              var rows = payload.data.slice(1)

              writeTable(headers, rows, { startCell: 'A1' })

              try {

                var rCount = payload.data.length

                var cCount = Array.isArray(headers) ? headers.length : 0

                if (cCount > 0 && sheet && sheet.Range) {

                  var rng = sheet.Range(sheet.Cells(1, 1), sheet.Cells(rCount, cCount))

                  if (rng && typeof rng.Select === 'function') rng.Select()

                }

              } catch (e2) { _diagPush('et_chart_select_range', e2) }

            }

          } catch (e1) { _diagPush('et_insert_chart', e1) }

          return insertChartFromSelection(payload.config || {})

        }

        if (t === 'text') return insertText(payload.text || payload.content || payload.title || '', { startCell: 'A1' })

        if (t === 'table') {

          var h = payload.headers || payload.header || []

          var rr = payload.rows || payload.data || []

          return writeTable(h, rr, { startCell: 'A1' })

        }

        return true

      }

      try { console.log('[BID] upsertBlock(payload) is deprecated; use upsertBlock(blockId, fn, opts).') } catch (e3) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e3, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e3) }

    }



    var ret

    try { ret = fn ? fn() : undefined } finally {}

    return ret

  }



  function _getSheet() {

    try { if (app && app.ActiveSheet) return app.ActiveSheet } catch (e) { _diagPush('et_active_sheet', e) }

    try {

      var wb = _getWb()

      if (wb && wb.Worksheets && wb.Worksheets.Count > 0) return wb.Worksheets.Item(1)

    } catch (e2) { _diagPush('et_active_sheet_fallback', e2) }

    return null

  }



  function setCell(row, col, value, opts) {

    _guard('setCell', { textLen: String(value || '').length })

    opts = opts || {}

    var sheet = _getSheet()

    if (!sheet) throw new Error('ActiveSheet 不可用')

    var r = Number(row || 1)

    var c = Number(col || 1)

    _safe(function () { sheet.Cells(r, c).Value2 = value })

    return true

  }



  function writeTable(headers, rows, opts) {

    _guard('writeTable', {})

    opts = opts || {}

    var sheet = _getSheet()

    if (!sheet) throw new Error('ActiveSheet 不可用')

    var start = String(opts.startCell || 'A1')

    var range = sheet.Range(start)

    var startRow = range.Row

    var startCol = range.Column

    var data = []

    if (Array.isArray(headers) && headers.length > 0) data.push(headers)

    if (Array.isArray(rows)) {

      for (var i = 0; i < rows.length; i++) {

        if (Array.isArray(rows[i])) data.push(rows[i])

      }

    }

    for (var r = 0; r < data.length; r++) {

      for (var c = 0; c < data[r].length; c++) {

        _safe(function () { sheet.Cells(startRow + r, startCol + c).Value2 = data[r][c] })

      }

    }

    // Header styling (best-effort)

    if (data.length > 0 && Array.isArray(headers) && headers.length > 0) {

      _safe(function () { sheet.Range(sheet.Cells(startRow, startCol), sheet.Cells(startRow, startCol + headers.length - 1)).Font.Bold = true })

    }

    return true

  }



  function insertChartFromSelection(opts) {

    _guard('insertChartFromSelection', {})

    opts = opts || {}

    var sheet = _getSheet()

    if (!sheet) throw new Error('ActiveSheet 不可用')

    var sel = null

    try { sel = app.Selection } catch (e) { _diagPush('et_selection', e) }

    var rng = null

    try { if (sel && sel.Cells) rng = sel } catch (e1) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e1, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e1) }

    try { if (!rng && sel && typeof sel.Address === 'string' && sheet.Range) rng = sheet.Range(sel.Address) } catch (e2) { _diagPush('et_selection_range', e2) }

    try { if (!rng && sel && typeof sel.Address === 'function' && sheet.Range) rng = sheet.Range(sel.Address()) } catch (e3) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e3, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e3) }

    if (!rng) throw new Error('请选择一个数据区域后再插入图表')



    var shapes = null

    try { shapes = sheet.Shapes } catch (e3) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e3, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e3) }

    if (!shapes) throw new Error('当前版本不支持 Shapes.AddChart')



    // Best-effort chart creation; actual ChartType constants vary across WPS builds.

    var chart = null

    var res = _safe(function () { return shapes.AddChart ? shapes.AddChart() : null })

    if (res.ok) chart = res.value

    if (!chart) throw new Error('插入图表失败（AddChart 不可用）')



    _safe(function () { if (chart.Chart && chart.Chart.SetSourceData) chart.Chart.SetSourceData(rng) })

    return chart

  }



  function insertText(text, opts) {

    _guard('insertText', { textLen: String(text || '').length })

    opts = opts || {}

    var sheet = _getSheet()

    if (!sheet) throw new Error('ActiveSheet 不可用')

    var start = String(opts.startCell || 'A1')

    _safe(function () { if (sheet.Range) sheet.Range(start).Value2 = String(text || '') })

    return true

  }



  function ensureSheet(name, opts) {

    _guard('ensureSheet', { textLen: String(name || '').length })

    opts = opts || {}

    var wb = _getWb()

    if (!wb) throw new Error('WPS 工作簿不可用，无法创建/激活工作表')

    var nm = _sanitizeSheetName(String(name || '总览'))

    var sh = _getOrCreateSheet(wb, nm)

    _safe(function () { if (sh && typeof sh.Activate === 'function') sh.Activate() })

    if (opts && opts.clear) {

      var cleared = _safe(function () { if (sh.Cells && typeof sh.Cells.Clear === 'function') sh.Cells.Clear() })

      if (!cleared.ok) _safe(function () { if (sh.UsedRange && typeof sh.UsedRange.Clear === 'function') sh.UsedRange.Clear() })

    }

    return sh

  }



  function listSheets(opts) {

    _guard('listSheets', {})

    opts = opts || {}

    var wb = _getWb()

    if (!wb) throw new Error('WPS 工作簿不可用')

    var sheets = null

    try { sheets = wb.Worksheets } catch (e) { sheets = null }

    if (!sheets) return []

    var count = 0

    try { count = Number(sheets.Count || 0) } catch (e2) { count = 0 }

    var names = []

    var excl = []

    try { if (Array.isArray(opts.exclude)) excl = opts.exclude } catch (e3) { excl = [] }

    for (var i = 1; i <= count; i++) {

      var sh = null

      try { sh = sheets.Item(i) } catch (e4) { sh = null }

      if (!sh) continue

      var n = ''

      try { n = String(sh.Name || '') } catch (e5) { n = '' }

      if (!n) continue

      if (opts.excludeBID && /^BID_/i.test(n)) continue

      if (excl && excl.length > 0) {

        var skip = false

        for (var j = 0; j < excl.length; j++) {

          try { if (String(excl[j] || '') === n) { skip = true; break } } catch (e6) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e6, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e6) }

        }

        if (skip) continue

      }

      names.push(n)

    }

    return names

  }



  function _getSheetByName(wb, name) {

    try {

      var sheets = wb && wb.Worksheets

      if (!sheets) return null

      var c = 0

      try { c = Number(sheets.Count || 0) } catch (e0) { c = 0 }

      for (var i = 1; i <= c; i++) {

        var sh = null

        try { sh = sheets.Item(i) } catch (e1) { sh = null }

        if (!sh) continue

        var n = ''

        try { n = String(sh.Name || '') } catch (e2) { n = '' }

        if (n === name) return sh

      }

    } catch (e3) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e3, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e3) }

    return null

  }



  function _asMatrix(v) {

    if (v == null) return []

    if (Array.isArray(v)) {

      if (v.length === 0) return []

      if (Array.isArray(v[0])) return v

      return [v]

    }

    return [[v]]

  }



  function _readUsedRangeMatrix(sh) {

    var ur = null

    try { ur = sh.UsedRange } catch (e) { ur = null }

    if (!ur) return { values: [], rows: 0, cols: 0 }

    var v = null

    try { v = ur.Value2 } catch (e2) { try { v = ur.Value } catch (e3) { v = null } }

    var mat = _asMatrix(v)

    return { values: mat, rows: mat.length, cols: (mat[0] ? mat[0].length : 0) }

  }



  function _findHeaderIndex(headers, key) {

    var k = String(key || '').trim()

    if (!k) return -1

    for (var i = 0; i < headers.length; i++) {

      var h = ''

      try { h = String(headers[i] || '').trim() } catch (e) { h = '' }

      if (!h) continue

      if (h === k) return i

      if (h.indexOf(k) >= 0) return i

    }

    return -1

  }



  function summarizeSheetsToOverview(opts) {

    _guard('summarizeSheetsToOverview', {})

    opts = opts || {}

    var wb = _getWb()

    if (!wb) throw new Error('WPS 工作簿不可用，无法汇总')



    var overviewName = String(opts.overviewSheet || opts.overview_sheet || opts.sheetName || '总览')

    overviewName = _sanitizeSheetName(overviewName)

    var dest = ensureSheet(overviewName, { clear: true })



    var sourceNames = []

    try { if (Array.isArray(opts.sourceSheets)) sourceNames = opts.sourceSheets } catch (e0) { sourceNames = [] }

    if (!sourceNames || sourceNames.length === 0) {

      sourceNames = listSheets({ excludeBID: true, exclude: [overviewName] })

    }



    var groupBy = opts.groupBy || opts.group_by || 1

    var sumCols = opts.sumCols || opts.sum_cols || null



    var agg = {} // key -> { count, sums[] }

    var header = null

    var gIdx = -1

    var sumIdxs = []



    for (var si = 0; si < sourceNames.length; si++) {

      var nm = ''

      try { nm = String(sourceNames[si] || '').trim() } catch (e1) { nm = '' }

      if (!nm) continue

      if (nm === overviewName) continue

      var sh = _getSheetByName(wb, nm)

      if (!sh) continue



      var data = _readUsedRangeMatrix(sh)

      var mat = data.values

      if (!mat || mat.length < 2) continue

      var headers = mat[0] || []

      if (!header) header = headers



      // Resolve groupBy index (0-based).

      if (gIdx < 0) {

        if (typeof groupBy === 'number') gIdx = Math.max(0, Number(groupBy) - 1)

        else gIdx = _findHeaderIndex(headers, groupBy)

        if (gIdx < 0) gIdx = 0

      }



      // Resolve sum columns once (0-based).

      if (!sumIdxs || sumIdxs.length === 0) {

        if (Array.isArray(sumCols) && sumCols.length > 0) {

          for (var c = 0; c < sumCols.length; c++) {

            var col = sumCols[c]

            var idx = -1

            if (typeof col === 'number') idx = Math.max(0, Number(col) - 1)

            else idx = _findHeaderIndex(headers, col)

            if (idx >= 0 && idx !== gIdx) sumIdxs.push(idx)

          }

        } else {

          // Default: sum all columns except the group key.

          for (var cc = 0; cc < headers.length; cc++) {

            if (cc === gIdx) continue

            sumIdxs.push(cc)

          }

        }

      }



      for (var r = 1; r < mat.length; r++) {

        var row = mat[r] || []

        var key = ''

        try { key = String(row[gIdx] || '').trim() } catch (e2) { key = '' }

        if (!key) continue



        var entry = agg[key]

        if (!entry) {

          entry = { count: 0, sums: [] }

          for (var z = 0; z < sumIdxs.length; z++) entry.sums[z] = 0

          agg[key] = entry

        }

        entry.count = Number(entry.count || 0) + 1

        for (var s = 0; s < sumIdxs.length; s++) {

          var idx2 = sumIdxs[s]

          var v2 = 0

          try { v2 = Number(row[idx2] || 0) } catch (e3) { v2 = 0 }

          if (!isFinite(v2)) v2 = 0

          entry.sums[s] = Number(entry.sums[s] || 0) + v2

        }

      }

    }



    var keys = []

    try { keys = Object.keys(agg) } catch (e4) { keys = [] }

    keys.sort()



    var outHeaders = []

    var groupHeader = '分组'

    try {

      if (typeof groupBy === 'string' && String(groupBy).trim()) groupHeader = String(groupBy).trim()

      else if (header && header[gIdx] != null) groupHeader = String(header[gIdx] || '').trim() || groupHeader

    } catch (e5) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e5, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e5) }

    outHeaders.push(groupHeader)



    for (var h = 0; h < sumIdxs.length; h++) {

      var hi = sumIdxs[h]

      var hn = '合计' + String(h + 1)

      try { if (header && header[hi] != null) hn = String(header[hi] || '').trim() || hn } catch (e6) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e6, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e6) }

      outHeaders.push(hn)

    }

    outHeaders.push('记录数')



    var outRows = []

    for (var kk = 0; kk < keys.length; kk++) {

      var k = keys[kk]

      var e = agg[k]

      if (!e) continue

      var rowOut = [k]

      for (var ss = 0; ss < sumIdxs.length; ss++) {

        rowOut.push(Number(e.sums[ss] || 0))

      }

      rowOut.push(Number(e.count || 0))

      outRows.push(rowOut)

    }



    // Write table to overview sheet.

    _safe(function () { if (dest && typeof dest.Activate === 'function') dest.Activate() })

    writeTable(outHeaders, outRows, { startCell: 'A1' })



    // Freeze header row best-effort.

    _safe(function () {

      if (dest && dest.Range && dest.Range('A2') && typeof dest.Range('A2').Select === 'function') dest.Range('A2').Select()

    })

    _safe(function () { if (app && app.ActiveWindow) app.ActiveWindow.FreezePanes = true })



    return { overviewSheet: overviewName, rows: outRows.length, cols: outHeaders.length }

  }



  return {

    upsertBlock: upsertBlock,

    ensureSheet: ensureSheet,

    listSheets: listSheets,

    summarizeSheetsToOverview: summarizeSheetsToOverview,

    setCell: setCell,

    writeTable: writeTable,

    insertChartFromSelection: insertChartFromSelection,

    insertText: insertText,

  }

 })();



try { if (typeof window !== 'undefined') window.BID = BID } catch (e) { try { if (typeof window !== 'undefined') { if (!window.__BID_AUDIT_DIAG) window.__BID_AUDIT_DIAG = []; if (window.__BID_AUDIT_DIAG && window.__BID_AUDIT_DIAG.push && window.__BID_AUDIT_DIAG.length < 80) window.__BID_AUDIT_DIAG.push({ tag: 'expose_bid', message: String((e && e.message) ? e.message : (e || '')).slice(0, 500), extra: null }) } } catch (_e) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', _e, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', _e) } }

`



    // WPP (presentations): store each artifact in its own slide to guarantee idempotency.

    const wppPreamble = `

// ---- Ah32 WPS JS runtime shims (safe no-op when APIs exist) ----

if (typeof RGB !== 'function') {

  function RGB(r, g, b) {

    var rr = Number(r) & 255

    var gg = Number(g) & 255

    var bb = Number(b) & 255

    return rr + (gg << 8) + (bb << 16)

  }

}



// ---- Ah32 helper facade for WPP (best-effort across WPS versions) ----

var BID = (function () {

  function _diagPush(tag, e, extra) {
    try {
      if (typeof window === 'undefined') return
      var a = window.__BID_AUDIT_DIAG
      if (!a || typeof a.push !== 'function') {
        a = []
        window.__BID_AUDIT_DIAG = a
      }
      if (a.length >= 80) return
      var msg = ''
      try { msg = e && e.message ? String(e.message) : String(e || '') } catch (_e2) { msg = '' }
      a.push({ tag: String(tag || ''), message: msg.slice(0, 500), extra: extra || null })
    } catch (_e) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', _e, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', _e) }
  }

  function _limits() {

    var d = { maxOps: 200, maxTextLen: 20000, maxTableCells: 500, deadlineMs: 45000 }

    try {

      var cfg = null
      if (cfg && typeof cfg === 'object') {

        if (cfg.maxOps != null) d.maxOps = Math.max(1, Math.min(2000, Number(cfg.maxOps) || d.maxOps))

        if (cfg.maxTextLen != null) d.maxTextLen = Math.max(100, Math.min(200000, Number(cfg.maxTextLen) || d.maxTextLen))

        if (cfg.maxTableCells != null) d.maxTableCells = Math.max(10, Math.min(5000, Number(cfg.maxTableCells) || d.maxTableCells))

        if (cfg.deadlineMs != null) d.deadlineMs = Math.max(1000, Math.min(300000, Number(cfg.deadlineMs) || d.deadlineMs))

      }

    } catch (e) { _diagPush('limits', e) }

    return d

  }

  var __limits = _limits()

  var __startedAt = Date.now()

  var __ops = 0

  function _isCancelled() {

    try { return !!(typeof window !== 'undefined' && window.__BID_CANCEL_MACRO) } catch (e) { return false }

  }

  function _guard(op, payload) {

    __ops = __ops + 1

    if (__ops > __limits.maxOps) throw new Error('MacroSafetyError: maxOps exceeded')

    if ((Date.now() - __startedAt) > __limits.deadlineMs) throw new Error('MacroSafetyError: deadline exceeded')

    if (_isCancelled()) throw new Error('MacroSafetyError: cancelled')

    if (payload && payload.textLen && payload.textLen > __limits.maxTextLen) throw new Error('MacroSafetyError: maxTextLen exceeded')

    if (payload && payload.tableCells && payload.tableCells > __limits.maxTableCells) throw new Error('MacroSafetyError: maxTableCells exceeded')

    try {

      if (typeof window !== 'undefined') {

        if (!window.__BID_AUDIT_OPS) window.__BID_AUDIT_OPS = []

        window.__BID_AUDIT_OPS.push(String(op || ''))

      }

    } catch (e) { _diagPush('audit_ops', e, { op: String(op || '') }) }

    return true

  }

  function _safe(fn) { try { return { ok: true, value: fn() } } catch (e) { _diagPush('safe', e); return { ok: false, error: e } } }

  function _tag(id) { return 'AH32_BLOCKID:' + String(id || 'ah32_auto') }



  function _getPres() {

    try { if (app && app.ActivePresentation) return app.ActivePresentation } catch (e) { _diagPush('wpp_active_presentation', e) }

    try { if (app && app.Presentations && app.Presentations.Count > 0) return app.Presentations.Item(1) } catch (e2) { _diagPush('wpp_presentations_fallback', e2) }

    return null

  }



  function _findSlideByTag(pres, id) {

    var slides = null

    try { slides = pres.Slides } catch (e) { _diagPush('wpp_slides', e) }

    if (!slides) return null

    var count = 0

    try { count = slides.Count } catch (e2) { count = 0 }

    var needle = _tag(id)

    for (var i = 1; i <= count; i++) {

      var s = null

      try { s = slides.Item(i) } catch (e3) { s = null }

      if (!s) continue



      // Prefer Tags if available.

      var tagged = false

      try {

        if (s.Tags && typeof s.Tags.Item === 'function') {

          var v = s.Tags.Item('AH32_BLOCKID')

          if (String(v || '') === String(id)) tagged = true

        }

      } catch (e4) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e4, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e4) }

      if (tagged) return s



      // Fallback: scan shapes AlternativeText/Text for the marker.

      try {

        var shapes = s.Shapes

        var sc = shapes ? shapes.Count : 0

        for (var j = 1; j <= sc; j++) {

          var sh = null

          try { sh = shapes.Item(j) } catch (e5) { sh = null }

          if (!sh) continue

          try { if (String(sh.AlternativeText || '').indexOf(needle) >= 0) return s } catch (e6) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e6, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e6) }

          try {

            if (sh.TextFrame && sh.TextFrame.HasText) {

              var t = sh.TextFrame.TextRange ? sh.TextFrame.TextRange.Text : ''

              if (String(t || '').indexOf(needle) >= 0) return s

            }

          } catch (e7) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e7, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e7) }

        }

      } catch (e8) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e8, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e8) }

    }

    return null

  }



  function _ensureSlideMarked(slide, id) {

    // Try non-visual tags first.

    try {

      if (slide.Tags && typeof slide.Tags.Add === 'function') {

        slide.Tags.Add('AH32_BLOCKID', String(id))

        return

      }

    } catch (e) { _diagPush('wpp_slide_tag', e) }



    // Fallback: add a tiny textbox marker.

    try {

      if (slide.Shapes && typeof slide.Shapes.AddTextbox === 'function') {

        var marker = slide.Shapes.AddTextbox(1, 0, 0, 1, 1)

        try { marker.Visible = 0 } catch (e2) { _diagPush('wpp_marker_visible', e2) }

        try { marker.AlternativeText = _tag(id) } catch (e3) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e3, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e3) }

        try { if (marker.TextFrame && marker.TextFrame.TextRange) marker.TextFrame.TextRange.Text = '' } catch (e4) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e4, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e4) }

      }

    } catch (e5) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e5, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e5) }

  }



  function _clearSlide(slide, id) {

    try {

      var shapes = slide.Shapes

      var count = shapes ? shapes.Count : 0

      for (var i = count; i >= 1; i--) {

        var sh = null

        try { sh = shapes.Item(i) } catch (e) { sh = null }

        if (!sh) continue

        var keep = false

        try { if (String(sh.AlternativeText || '').indexOf(_tag(id)) >= 0) keep = true } catch (e2) { _diagPush('wpp_shape_keep', e2) }

        if (!keep) _safe(function () { sh.Delete() })

      }

    } catch (e3) { _diagPush('wpp_cleanup', e3) }

  }



  function _activateSlide(slide) {

    _safe(function () { if (typeof slide.Select === 'function') slide.Select() })

    _safe(function () {

      if (app && app.ActiveWindow && app.ActiveWindow.View && typeof app.ActiveWindow.View.GotoSlide === 'function') {

        app.ActiveWindow.View.GotoSlide(slide.SlideIndex)

      }

    })

  }



  function upsertBlock(blockId, fn, opts) {

    _guard('upsertBlock', {})

    opts = opts || {}

    var id = String(blockId || 'ah32_auto')

    try { if (typeof window !== 'undefined') window.__BID_AUDIT_BLOCK_ID = id } catch (e) { _diagPush('audit_block_id', e) }

    var pres = _getPres()

    if (!pres) throw new Error('WPS 演示文稿不可用，无法执行宏任务')



    var slide = _findSlideByTag(pres, id)

    if (!slide) {

      var slides = pres.Slides

      if (!slides) throw new Error('演示文稿缺少 Slides')

      var idx = 1

      try { idx = slides.Count + 1 } catch (e) { idx = 1 }

      // 12 ~= blank layout in PowerPoint object model; best-effort.

      var res = _safe(function () { return slides.Add(idx, 12) })

      if (!res.ok || !res.value) throw new Error('创建幻灯片失败')

      slide = res.value

      _ensureSlideMarked(slide, id)

    } else {

      _clearSlide(slide, id)

      _ensureSlideMarked(slide, id)

    }



    _activateSlide(slide)



    var ret

    try { ret = fn ? fn() : undefined } finally {}

    return ret

  }



  function _getActiveSlide() {

    try {

      if (app && app.ActiveWindow && app.ActiveWindow.View && app.ActiveWindow.View.Slide) return app.ActiveWindow.View.Slide

    } catch (e) { _diagPush('wpp_active_slide', e) }

    try {

      var pres = _getPres()

      if (pres && pres.Slides && pres.Slides.Count > 0) return pres.Slides.Item(1)

    } catch (e2) { _diagPush('wpp_active_slide_fallback', e2) }

    return null

  }



  function addTextbox(text, opts) {

    _guard('addTextbox', { textLen: String(text || '').length })

    opts = opts || {}

    var slide = _getActiveSlide()

    if (!slide) throw new Error('无法获取当前幻灯片')

    if (!slide.Shapes || typeof slide.Shapes.AddTextbox !== 'function') {

      throw new Error('当前版本不支持 Shapes.AddTextbox')

    }



    var left = Number(opts.left || 60)

    var top = Number(opts.top || 80)

    var width = Number(opts.width || 600)

    var height = Number(opts.height || 120)



    // 1 ~= horizontal textbox orientation in PowerPoint object model; best-effort.

    var box = slide.Shapes.AddTextbox(1, left, top, width, height)

    try { box.TextFrame.TextRange.Text = String(text || '') } catch (e) { _diagPush('wpp_textbox_text', e) }

    _safe(function () { if (opts.fontSize) box.TextFrame.TextRange.Font.Size = Number(opts.fontSize) })

    _safe(function () { if (opts.bold) box.TextFrame.TextRange.Font.Bold = opts.bold ? 1 : 0 })

    return box

  }



  function addWordArt(text, opts) {

    _guard('addWordArt', { textLen: String(text || '').length })

    opts = opts || {}

    var slide = _getActiveSlide()

    if (!slide) throw new Error('无法获取当前幻灯片')

    try {

      if (slide.Shapes && typeof slide.Shapes.AddTextEffect === 'function') {

        // Params vary across builds; this is best-effort and may be auto-repaired if it fails.

        var left = Number(opts.left || 60)

        var top = Number(opts.top || 80)

        var fontName = String(opts.fontName || 'Arial')

        var size = Number(opts.fontSize || 48)

        var wa = slide.Shapes.AddTextEffect(1, String(text || ''), fontName, size, 0, 0, left, top)

        return wa

      }

    } catch (e) { _diagPush('wpp_wordart', e) }

    // Fallback: big bold textbox.

    return addTextbox(text, { left: opts.left, top: opts.top, width: opts.width, height: opts.height, fontSize: opts.fontSize || 48, bold: true })

  }



  // Aliases: models often reuse Writer naming.

  function insertText(text, opts) { return addTextbox(text, opts) }

  function insertWordArt(text, opts) { return addWordArt(text, opts) }



  function getSlideSize() {

    _guard('getSlideSize', {})

    var pres = _getPres()

    var w = 960

    var h = 540

    try {

      if (pres && pres.PageSetup) {

        try { w = Number(pres.PageSetup.SlideWidth || w) } catch (e1) { w = w }

        try { h = Number(pres.PageSetup.SlideHeight || h) } catch (e2) { h = h }

      }

    } catch (e3) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e3, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e3) }

    return { width: w, height: h }

  }



  function _applyShapeFont(shape, fontName, fontSize, bold) {

    if (!shape || !shape.TextFrame || !shape.TextFrame.TextRange) return

    _safe(function () { if (fontName) shape.TextFrame.TextRange.Font.Name = String(fontName) })

    _safe(function () { if (fontSize) shape.TextFrame.TextRange.Font.Size = Number(fontSize) })

    _safe(function () { if (bold != null) shape.TextFrame.TextRange.Font.Bold = bold ? 1 : 0 })

  }



  function _parseColor(v) {

    if (v == null) return null

    if (typeof v === 'number') return v

    var s = ''

    try { s = String(v || '').trim() } catch (e0) { s = '' }

    if (!s) return null

    // Accept #RRGGBB

    var m = s.match(/^#?([0-9a-fA-F]{6})$/)

    if (m && m[1]) {

      var hex = m[1]

      var r = parseInt(hex.slice(0, 2), 16)

      var g = parseInt(hex.slice(2, 4), 16)

      var b = parseInt(hex.slice(4, 6), 16)

      if (isFinite(r) && isFinite(g) && isFinite(b)) {

        return RGB(r, g, b)

      }

    }

    return null

  }



  function _num(v, defVal) {

    var n = 0

    try { n = Number(v) } catch (e) { n = NaN }

    if (!isFinite(n)) return Number(defVal || 0) || 0

    return n

  }



  function _get(obj, path, defVal) {

    if (!obj || !path) return defVal

    var cur = obj

    var parts = []

    try {

      parts = Array.isArray(path) ? path : String(path).split('.')

    } catch (e) {

      parts = []

    }

    for (var i = 0; i < parts.length; i++) {

      var k = parts[i]

      if (!k) continue

      try {

        if (cur && typeof cur === 'object' && (k in cur)) cur = cur[k]

        else return defVal

      } catch (e2) {

        return defVal

      }

    }

    return (cur == null) ? defVal : cur

  }



  function _applyFill(shape, color) {

    var rgb = _parseColor(color)

    if (rgb == null) return false

    _safe(function () {

      if (shape && shape.Fill && shape.Fill.ForeColor) {

        try { if (typeof shape.Fill.Solid === 'function') shape.Fill.Solid() } catch (e0) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e0, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e0) }

        shape.Fill.ForeColor.RGB = rgb

      }

    })

    return true

  }



  function _applyLine(shape, color, visible) {

    var rgb = _parseColor(color)

    _safe(function () {

      if (shape && shape.Line) {

        try {

          if (visible != null) shape.Line.Visible = visible ? 1 : 0

        } catch (e0) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e0, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e0) }

        if (rgb != null && shape.Line.ForeColor) shape.Line.ForeColor.RGB = rgb

      }

    })

    return true

  }



  function _applyTextColor(shape, color) {

    var rgb = _parseColor(color)

    if (rgb == null) return false

    _safe(function () {

      if (shape && shape.TextFrame && shape.TextFrame.TextRange && shape.TextFrame.TextRange.Font) {

        // PowerPoint uses Font.Color.RGB; some builds expose .Color directly.

        try {

          if (shape.TextFrame.TextRange.Font.Color && shape.TextFrame.TextRange.Font.Color.RGB != null) {

            shape.TextFrame.TextRange.Font.Color.RGB = rgb

            return

          }

        } catch (e0) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e0, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e0) }

        try { if (shape.TextFrame.TextRange.Font.Color != null) shape.TextFrame.TextRange.Font.Color = rgb } catch (e1) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e1, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e1) }

      }

    })

    return true

  }



  function _setAlign(shape, align) {

    var a = 1 // left

    try {

      if (typeof align === 'number') a = Number(align) || a

      else {

        var s = String(align || '').trim().toLowerCase()

        if (s === 'center' || s === 'middle' || s === 'c') a = 2

        else if (s === 'right' || s === 'r') a = 3

        else a = 1

      }

    } catch (e) { a = 1 }

    _safe(function () {

      if (shape && shape.TextFrame && shape.TextFrame.TextRange && shape.TextFrame.TextRange.ParagraphFormat) {

        shape.TextFrame.TextRange.ParagraphFormat.Alignment = a

      }

    })

    return true

  }



  function _fitTextBox(shape, opts) {

    // Best-effort text overflow handling:

    // - Prefer shrinking font size to fit the shape height (when BoundHeight is available).

    // - Fallback to truncation when needed.

    opts = opts || {}

    var minFont = _num(opts.minFontSize, 12)

    var maxLoops = Math.max(1, Math.min(30, _num(opts.maxLoops, 12)))

    var truncate = (opts.truncate == null) ? true : !!opts.truncate



    var tr = null

    try { tr = shape && shape.TextFrame ? shape.TextFrame.TextRange : null } catch (e0) { tr = null }

    if (!tr) return false



    var h = 0

    try { h = _num(shape.Height, 0) } catch (e1) { h = 0 }

    if (!h) return false



    var fs = 0

    try { fs = _num(tr.Font.Size, 0) } catch (e2) { fs = 0 }

    if (!fs) fs = _num(opts.fontSize, 18)



    for (var i = 0; i < maxLoops; i++) {

      var bh = 0

      try { bh = _num(tr.BoundHeight, 0) } catch (e3) { bh = 0 }

      if (bh && bh <= (h - 4)) return true

      if (fs <= minFont) break

      fs = Math.max(minFont, fs - 1)

      _safe(function () { tr.Font.Size = fs })

    }



    if (!truncate) return false



    // Truncate content as a last resort (can't always measure BoundHeight).

    try {

      var t = String(tr.Text || '')

      if (t && t.length > 60) {

        var keep = Math.max(40, Math.floor(t.length * 0.75))

        tr.Text = t.slice(0, keep) + '...'

      }

    } catch (e4) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', e4, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', e4) }

    return false

  }



  function _setAlignCenter(shape) {

    try {

      if (shape && shape.TextFrame && shape.TextFrame.TextRange && shape.TextFrame.TextRange.ParagraphFormat) {

        // 2 ~= center in PowerPoint object model; best-effort.

        shape.TextFrame.TextRange.ParagraphFormat.Alignment = 2

      }

    } catch (e) { _diagPush('wpp_align_center', e) }

  }



  function applyStyleSpec(styleSpec, opts) {

    _guard('applyStyleSpec', {})

    styleSpec = styleSpec || {}

    opts = opts || {}



    var palette = {

      primary: String(_get(styleSpec, 'palette.primary', '#2563eb') || '#2563eb'),

      accent: String(_get(styleSpec, 'palette.accent', '#f59e0b') || '#f59e0b'),

      muted: String(_get(styleSpec, 'palette.muted', '#94a3b8') || '#94a3b8'),

      danger: String(_get(styleSpec, 'palette.danger', '#ef4444') || '#ef4444'),

      background: String(_get(styleSpec, 'palette.background', '') || ''),

    }



    var marginLeft = _num(_get(styleSpec, 'wpp.layout.grid.margin.left', null), 60)

    var marginRight = _num(_get(styleSpec, 'wpp.layout.grid.margin.right', null), 60)

    var marginTop = _num(_get(styleSpec, 'wpp.layout.grid.margin.top', null), 60)

    var marginBottom = _num(_get(styleSpec, 'wpp.layout.grid.margin.bottom', null), 60)

    var gutter = _num(_get(styleSpec, 'wpp.layout.grid.gutter', null), 24)



    var titleFontName = String(_get(styleSpec, 'font.title.name', 'Arial') || 'Arial')

    var bodyFontName = String(_get(styleSpec, 'font.body.name', 'Arial') || 'Arial')

    var titleFontSize = _num(_get(styleSpec, 'wpp.slide.title.size', _get(styleSpec, 'font.title.size', null)), 32)

    var bodyFontSize = _num(_get(styleSpec, 'wpp.slide.body.size', _get(styleSpec, 'font.body.size', null)), 18)

    var titleBold = _get(styleSpec, 'wpp.slide.title.bold', _get(styleSpec, 'font.title.bold', true))



    // Background: allow override, then styleSpec palette.background, then a conservative white.

    var bg = null

    try { bg = opts.background || _get(styleSpec, 'wpp.deck.background', null) || palette.background } catch (e0) { bg = null }

    if (!bg) bg = '#ffffff'

    applyTheme({ background: bg, palette: palette })



    return {

      palette: palette,

      margin: { left: marginLeft, right: marginRight, top: marginTop, bottom: marginBottom },

      gutter: gutter,

      font: {

        title: { name: titleFontName, size: titleFontSize, bold: titleBold ? true : false },

        body: { name: bodyFontName, size: bodyFontSize },

        kpi: { name: titleFontName, size: Math.max(44, titleFontSize + 16), bold: true },

        small: { name: bodyFontName, size: Math.max(12, bodyFontSize - 2) },

      },

    }

  }



  function addShape(kind, opts) {

    _guard('addShape', {})

    opts = opts || {}

    var slide = _getActiveSlide()

    if (!slide) throw new Error('无法获取当前幻灯片')



    var left = _num(opts.left, 60)

    var top = _num(opts.top, 80)

    var width = _num(opts.width, 200)

    var height = _num(opts.height, 120)



    var t = 1 // rectangle

    var k = ''

    try { k = String(kind || '').trim().toLowerCase() } catch (e0) { k = '' }

    if (k === 'oval' || k === 'circle') t = 9 // msoShapeOval



    var sh = null

    try {

      if (slide.Shapes && typeof slide.Shapes.AddShape === 'function') {

        sh = slide.Shapes.AddShape(t, left, top, width, height)

      }

    } catch (e1) { sh = null }

    if (!sh) {

      // Fallback: fillable textbox as a shape placeholder.

      sh = addTextbox('', { left: left, top: top, width: width, height: height })

    }



    if (opts.fill) _applyFill(sh, opts.fill)

    if (opts.line) _applyLine(sh, opts.line, true)

    if (opts.noLine) _applyLine(sh, null, false)

    return sh

  }



  function applyTheme(opts) {

    _guard('applyTheme', {})

    opts = opts || {}

    var slide = _getActiveSlide()

    if (!slide) throw new Error('无法获取当前幻灯片')

    var bg = null

    try { bg = opts.background || (opts.palette ? (opts.palette.background || opts.palette.muted) : null) } catch (e0) { bg = null }

    if (!bg) return true

    var rgb = _parseColor(bg)



    // Try to set a solid background fill (best-effort across builds).

    _safe(function () { slide.FollowMasterBackground = 0 })

    _safe(function () {

      if (slide.Background && slide.Background.Fill && slide.Background.Fill.ForeColor) {

        if (rgb != null) slide.Background.Fill.ForeColor.RGB = rgb

      }

    })

    return true

  }



  function addTitle(text, opts) {

    _guard('addTitle', { textLen: String(text || '').length })

    opts = opts || {}

    var size = getSlideSize()

    var margin = Number(opts.margin || 60)

    var left = Number(opts.left || margin)

    var top = Number(opts.top || margin)

    var width = Number(opts.width || (size.width - margin * 2))

    var height = Number(opts.height || 90)

    var fontSize = Number(opts.fontSize || 32)

    var fontName = String(opts.fontName || 'Arial')

    var bold = (opts.bold == null) ? true : !!opts.bold

    var box = addTextbox(String(text || ''), { left: left, top: top, width: width, height: height })

    _applyShapeFont(box, fontName, fontSize, bold)

    _setAlignCenter(box)

    return box

  }



  function addBullets(items, opts) {

    _guard('addBullets', {})

    opts = opts || {}

    var list = Array.isArray(items) ? items : []

    var s = ''

    for (var i = 0; i < list.length; i++) {

      var t = ''

      try { t = String(list[i] || '').trim() } catch (e0) { t = '' }

      if (!t) continue

      s = s ? (s + '\\n' + t) : t

    }

    var size = getSlideSize()

    var margin = Number(opts.margin || 60)

    var left = Number(opts.left || margin)

    var top = Number(opts.top || (margin + 110))

    var width = Number(opts.width || (size.width - margin * 2))

    var height = Number(opts.height || (size.height - top - margin))

    var fontSize = Number(opts.fontSize || 18)

    var fontName = String(opts.fontName || 'Arial')

    var box = addTextbox(String(s || ''), { left: left, top: top, width: width, height: height, fontSize: fontSize })

    _applyShapeFont(box, fontName, fontSize, false)

    // Bullet best-effort.

    _safe(function () {

      if (box && box.TextFrame && box.TextFrame.TextRange && box.TextFrame.TextRange.ParagraphFormat && box.TextFrame.TextRange.ParagraphFormat.Bullet) {

        box.TextFrame.TextRange.ParagraphFormat.Bullet.Visible = 1

      }

    })

    return box

  }



  function layoutTwoColumn(opts) {

    _guard('layoutTwoColumn', {})

    opts = opts || {}

    var style = null

    try {

      var ss = opts.styleSpec || opts.style_spec || null

      if (ss) style = applyStyleSpec(ss, opts)

    } catch (e0) { style = null }

    var size = getSlideSize()

    var margin = Number(opts.margin || (style && style.margin ? style.margin.left : 60))

    var gutter = Number(opts.gutter || (style ? style.gutter : 24))

    var colW = Math.max(200, (size.width - margin * 2 - gutter) / 2)

    var top = Number(opts.top || (margin + 110))



    var leftText = String(opts.leftText || '')

    if (Array.isArray(opts.leftItems)) {

      leftText = ''

      for (var i = 0; i < opts.leftItems.length; i++) {

        var t = ''

        try { t = String(opts.leftItems[i] || '').trim() } catch (e1) { t = '' }

        if (!t) continue

        leftText = leftText ? (leftText + '\\n' + t) : t

      }

    }



    var leftBox = addTextbox(leftText, { left: margin, top: top, width: colW, height: size.height - top - margin })

    _safe(function () {

      if (leftBox && leftBox.TextFrame && leftBox.TextFrame.TextRange && leftBox.TextFrame.TextRange.ParagraphFormat && leftBox.TextFrame.TextRange.ParagraphFormat.Bullet) {

        leftBox.TextFrame.TextRange.ParagraphFormat.Bullet.Visible = 1

      }

    })

    if (style) {

      _applyShapeFont(leftBox, style.font.body.name, style.font.body.size, false)

      _applyTextColor(leftBox, style.palette.primary)

      _fitTextBox(leftBox, { minFontSize: 12 })

    }



    var rightObj = null

    if (opts.rightShape) {

      var rs = opts.rightShape || {}

      rightObj = addShape(rs.kind || 'rect', {

        left: margin + colW + gutter,

        top: top + 10,

        width: colW,

        height: Math.max(160, Math.min(280, size.height - top - margin - 10)),

        fill: rs.fill || (style ? style.palette.muted : '#94a3b8'),

        noLine: true,

      })

    } else {

      var rightText = String(opts.rightText || '')

      rightObj = addTextbox(rightText, { left: margin + colW + gutter, top: top, width: colW, height: size.height - top - margin })

      if (style) {

        _applyShapeFont(rightObj, style.font.body.name, style.font.body.size, false)

        _applyTextColor(rightObj, '#111827')

        _fitTextBox(rightObj, { minFontSize: 12 })

      }

    }



    return { left: leftBox, right: rightObj }

  }



  function layoutSlide(opts) {

    _guard('layoutSlide', {})

    opts = opts || {}

    var ss = opts.styleSpec || opts.style_spec || {}

    var style = applyStyleSpec(ss, opts)



    var template = ''

    try { template = String(opts.template || opts.layout || '').trim().toLowerCase() } catch (e0) { template = '' }



    var title = String(opts.title || opts.heading || '')

    var bullets = Array.isArray(opts.bullets) ? opts.bullets : []



    var size = getSlideSize()

    var m = style.margin

    var contentTop = m.top + 110



    var created = []



    function _titleBox() {

      if (!title) return null

      var box = addTitle(title, { margin: m.left, top: m.top, width: size.width - m.left - m.right, fontName: style.font.title.name, fontSize: style.font.title.size, bold: style.font.title.bold })

      _applyTextColor(box, style.palette.primary)

      created.push(box)

      return box

    }



    if (template === 'kpi' || opts.kpiText || opts.kpi) {

      var kpi = String(opts.kpiText || opts.kpi || title || '')

      var notes = Array.isArray(opts.notes) ? opts.notes : bullets



      var kTop = _num(opts.kpiTop, m.top + 120)

      var kBox = addTextbox(kpi, { left: m.left, top: kTop, width: size.width - m.left - m.right, height: 120 })

      _applyShapeFont(kBox, style.font.kpi.name, style.font.kpi.size, true)

      _setAlign(kBox, 'center')

      _applyTextColor(kBox, style.palette.primary)

      _fitTextBox(kBox, { minFontSize: 28, truncate: true })

      created.push(kBox)



      if (notes && notes.length) {

        var b = addBullets(notes, { left: m.left, top: kTop + 140, width: size.width - m.left - m.right, height: size.height - (kTop + 140) - m.bottom, fontName: style.font.body.name, fontSize: style.font.body.size })

        _applyTextColor(b, '#111827')

        _fitTextBox(b, { minFontSize: 12, truncate: true })

        created.push(b)

      }



      return created

    }



    if (template === 'two_column' || template === 'two-column' || template === 'two_col' || opts.leftItems || opts.leftText) {

      _titleBox()

      var two = layoutTwoColumn({

        leftItems: opts.leftItems,

        leftText: opts.leftText,

        rightText: opts.rightText,

        rightShape: opts.rightShape || { kind: 'rect', fill: style.palette.muted },

        styleSpec: ss,

        margin: m.left,

        gutter: style.gutter,

        top: _num(opts.top, contentTop),

      })

      created.push(two.left)

      created.push(two.right)

      return created

    }



    if (template === 'cards' || template === 'cards3' || Array.isArray(opts.cards)) {

      _titleBox()

      var cards = Array.isArray(opts.cards) ? opts.cards : []

      var n = Math.max(1, Math.min(4, cards.length || 3))

      var gutter = style.gutter

      var w = (size.width - m.left - m.right - gutter * (n - 1)) / n

      var top = _num(opts.top, contentTop)

      var h = Math.max(180, size.height - top - m.bottom)

      for (var i = 0; i < n; i++) {

        var c = cards[i] || {}

        var t = String(c.title || c.name || ('要点' + String(i + 1)))

        var body = String(c.body || c.text || '')

        var txt = body ? (t + '\\n' + body) : t

        var box = addTextbox(txt, { left: m.left + i * (w + gutter), top: top, width: w, height: h })

        _applyFill(box, '#f1f5f9')

        _applyLine(box, style.palette.muted, true)

        _applyShapeFont(box, style.font.body.name, style.font.body.size, false)

        _applyTextColor(box, '#111827')

        _fitTextBox(box, { minFontSize: 12, truncate: true })

        created.push(box)

      }

      return created

    }



    // Default: title + bullets.

    _titleBox()

    if (bullets && bullets.length) {

      var b2 = addBullets(bullets, { left: m.left, top: _num(opts.top, contentTop), width: size.width - m.left - m.right, height: size.height - _num(opts.top, contentTop) - m.bottom, fontName: style.font.body.name, fontSize: style.font.body.size })

      _applyTextColor(b2, '#111827')

      _fitTextBox(b2, { minFontSize: 12, truncate: true })

      created.push(b2)

    }

    return created

  }



  return {

    upsertBlock: upsertBlock,

    addTextbox: addTextbox,

    addWordArt: addWordArt,

    getSlideSize: getSlideSize,

    applyTheme: applyTheme,

    applyStyleSpec: applyStyleSpec,

    addShape: addShape,

    addTitle: addTitle,

    addBullets: addBullets,

    layoutTwoColumn: layoutTwoColumn,

    layoutSlide: layoutSlide,

    insertText: insertText,

    insertWordArt: insertWordArt

  }

 })();



try { if (typeof window !== 'undefined') window.BID = BID } catch (e) { try { if (typeof window !== 'undefined') { if (!window.__BID_AUDIT_DIAG) window.__BID_AUDIT_DIAG = []; if (window.__BID_AUDIT_DIAG && window.__BID_AUDIT_DIAG.push && window.__BID_AUDIT_DIAG.length < 80) window.__BID_AUDIT_DIAG.push({ tag: 'expose_bid', message: String((e && e.message) ? e.message : (e || '')).slice(0, 500), extra: null }) } } catch (_e) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', _e, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', _e) } }

`



    const preamble =

      isWriter

        ? writerPreamble

        : (hostApp === 'et'

            ? etPreamble

            : (hostApp === 'wpp' ? wppPreamble : etPreamble))



    const extractBlockId = () => {

      const m1 = trimmed.match(/^\s*\/\/\s*@ah32:blockId\s*=\s*([^\s]+)\s*$/m)

      const m2 = trimmed.match(/\/\*\s*@ah32:blockId\s*=\s*([^\s*]+)\s*\*\//m)

      const raw = (m1 && m1[1]) || (m2 && m2[1]) || 'ah32_auto'

      // Keep ids filesystem/search friendly and safe inside marker tags.

      return String(raw).replace(/[^a-zA-Z0-9_\-:.]/g, '_').slice(0, 64)

    }



    const extractAnchor = (): 'cursor' | 'end' => {

      const m = trimmed.match(/^\s*\/\/\s*@ah32:anchor\s*=\s*([^\s]+)\s*$/m)

      const raw = m && m[1] ? String(m[1]).trim().toLowerCase() : ''

      if (raw === 'end' || raw === 'doc_end' || raw === 'document_end') return 'end'

      return 'cursor'

    }



    const extractAnchorMode = (): 'auto' | 'bookmark_only' | 'marker_only' => {

      const m1 = trimmed.match(/^\s*\/\/\s*@ah32:anchor[_-]?mode\s*=\s*([^\s]+)\s*$/m)

      // Back-compat sugar: allow `// @ah32:anchor=bookmark_only|marker_only`

      const m2 = trimmed.match(/^\s*\/\/\s*@ah32:anchor\s*=\s*([^\s]+)\s*$/m)

      const raw = ((m1 && m1[1]) || (m2 && m2[1]) || '').trim().toLowerCase()

      if (raw === 'bookmark_only' || raw === 'bookmark-only' || raw === 'bookmark') return 'bookmark_only'

      if (raw === 'marker_only' || raw === 'marker-only' || raw === 'marker' || raw === 'text') return 'marker_only'

      return 'auto'

    }



    const wrapWithUpsert = (body: string) => {

      const blockId = extractBlockId()

      const anchor = extractAnchor()

      const anchorMode = extractAnchorMode()

      const optsParts: string[] = []

      if (anchor === 'end') optsParts.push(`anchor: 'end'`)

      if (anchorMode !== 'auto') optsParts.push(`anchorMode: '${anchorMode}'`)

      const opts = optsParts.length > 0 ? `, { ${optsParts.join(', ')} }` : ''

      return `${preamble}\nreturn BID.upsertBlock(${JSON.stringify(blockId)}, function () {\n${sandboxReturn(body)}\n}${opts});`

    }

    const auditLine = hasBlockIdHeader

      ? `try { if (typeof window !== 'undefined') window.__BID_AUDIT_BLOCK_ID = ${JSON.stringify(extractBlockId())}; } catch (e) { try { if (typeof window !== 'undefined') { if (!window.__BID_AUDIT_DIAG) window.__BID_AUDIT_DIAG = []; if (window.__BID_AUDIT_DIAG && window.__BID_AUDIT_DIAG.push && window.__BID_AUDIT_DIAG.length < 80) window.__BID_AUDIT_DIAG.push({ tag: 'audit_block_id', message: String((e && e.message) ? e.message : (e || '')).slice(0, 300), extra: null }) } } catch (_e) { if (typeof window !== 'undefined' && window.__ah32_reportError) window.__ah32_reportError('ah32-ui-next/src/services/js-macro-executor.ts', _e, 'warning'); else if (typeof console !== 'undefined' && console.warn) console.warn('[js-macro-executor:caught]', _e) } }\n`

      : ''

    const allowAutoWrap = !disableAutoUpsert



    if (hasFunction) {

      // 提取函数名

      const funcMatch = trimmed.match(/function\s+([\w\u4e00-\u9fa5_$][\w\u4e00-\u9fa5_$0-9]*)/)

      if (funcMatch && funcMatch[1]) {

        const funcName = funcMatch[1]

        const body = `${auditLine}${trimmed}\nreturn ${funcName}();`

        if (allowAutoWrap && !alreadyUpserts && (isWriter ? (looksLikeInsert || hasBlockIdHeader) : hasBlockIdHeader)) return wrapWithUpsert(body)

        return `${preamble}\n${sandboxReturn(body)}`

      }

      if (allowAutoWrap && !alreadyUpserts && (isWriter ? (looksLikeInsert || hasBlockIdHeader) : hasBlockIdHeader)) return wrapWithUpsert(`${auditLine}${trimmed}`)

      return `${preamble}\n${auditLine}${sandboxStmt(trimmed)}`

    } else if (hasArrow) {

      // 箭头函数直接包装

      const body = `${auditLine}return (${trimmed})();`

      if (allowAutoWrap && !alreadyUpserts && (isWriter ? (looksLikeInsert || hasBlockIdHeader) : hasBlockIdHeader)) return wrapWithUpsert(body)

      return `${preamble}\n${sandboxReturn(body)}`

    } else {

      // 普通代码包装为立即执行函数

      const body = `${auditLine}${trimmed}`

      if (allowAutoWrap && !alreadyUpserts && (isWriter ? (looksLikeInsert || hasBlockIdHeader) : hasBlockIdHeader)) return wrapWithUpsert(body)

      return `${preamble}\n${auditLine}${sandboxStmt(trimmed)}`

    }

  }



  /**

   * 清理常见 TypeScript-only 语法，避免在浏览器/WPS JS 引擎中直接执行时报语法错。

   * 仅做保守替换：不碰对象字面量中的 `a: 1` 这种 JS 合法语法。

   */

  private stripTypeScriptSyntax(code: string): { code: string; changed: boolean; notes: string[] } {

    let out = code

    const notes: string[] = []



    // Remove `import ...` blocks (TS/ESM) - not executable in `new Function`.

    // Handles multiline imports like:

    //   import {

    //     foo,

    //   } from 'x'

    if (/^\s*import\b/m.test(out)) {

      const lines = out.split(/\r?\n/)

      const kept: string[] = []

      let skipping = false

      let removed = false

      for (const line of lines) {

        if (!skipping && /^\s*import\b/.test(line)) {

          skipping = true

          removed = true

        }

        if (skipping) {

          const endsStatement = /;\s*$/.test(line)

          const hasFrom = /\bfrom\s+['"][^'"]+['"]\s*;?\s*$/.test(line)

          const isBareImport = /^\s*import\s+['"][^'"]+['"]\s*;?\s*$/.test(line)

          const isDynamicImport = /^\s*import\s*\(.+\)\s*;?\s*$/.test(line)

          if (endsStatement || hasFrom || isBareImport || isDynamicImport) {

            skipping = false

          }

          continue

        }

        kept.push(line)

      }

      if (removed) notes.push('removed import statements')

      out = kept.join('\n')

    }



    // Remove `export` keywords/lines (TS/ESM) - not executable in `new Function`.

    if (/^\s*export\s+/m.test(out)) {

      // Remove `export { ... }` blocks entirely (best-effort, supports multiline).

      if (/^\s*export\s*\{/m.test(out)) {

        const lines = out.split(/\r?\n/)

        const kept: string[] = []

        let skipping = false

        let removed = false

        for (const line of lines) {

          if (!skipping && /^\s*export\s*\{/.test(line)) {

            skipping = true

            removed = true

          }

          if (skipping) {

            if (/\}\s*(from\s+['"][^'"]+['"])?\s*;?\s*$/.test(line)) {

              skipping = false

            }

            continue

          }

          kept.push(line)

        }

        if (removed) notes.push('removed export list statements')

        out = kept.join('\n')

      }

      // Strip `export default ` prefix (best-effort).

      out = out.replace(/^\s*export\s+default\s+/gm, () => {

        notes.push('stripped export default')

        return ''

      })

      // Strip `export ` before declarations.

      out = out.replace(/^\s*export\s+(?=(async\s+)?(function|const|let|var|class)\b)/gm, () => {

        notes.push('stripped export keywords')

        return ''

      })

    }



    // Remove `interface ... { ... }` blocks (line-based, best-effort).

    if (/^\s*interface\s+\w+/m.test(out)) {

      const lines = out.split(/\r?\n/)

      const kept: string[] = []

      let skipping = false

      let brace = 0

      for (const line of lines) {

        if (!skipping && /^\s*interface\s+\w+/.test(line)) {

          skipping = true

          brace = 0

          notes.push('removed interface declarations')

        }



        if (skipping) {

          for (const ch of line) {

            if (ch === '{') brace++

            else if (ch === '}') brace--

          }

          if (brace <= 0 && /\}/.test(line)) {

            skipping = false

          }

          continue

        }



        kept.push(line)

      }

      out = kept.join('\n')

    }



    // Remove `type X = ...` lines (best-effort).

    if (/^\s*type\s+\w+\s*=.+/m.test(out)) {

      out = out.replace(/^\s*type\s+\w+\s*=.*$/gm, () => {

        notes.push('removed type aliases')

        return ''

      })

    }



    // Remove `enum X { ... }` blocks (TS-only).

    if (/^\s*enum\s+\w+\s*\{/m.test(out)) {

      const lines = out.split(/\r?\n/)

      const kept: string[] = []

      let skipping = false

      let brace = 0

      for (const line of lines) {

        if (!skipping && /^\s*enum\s+\w+\s*\{/.test(line)) {

          skipping = true

          brace = 0

          notes.push('removed enum declarations')

        }

        if (skipping) {

          for (const ch of line) {

            if (ch === '{') brace++

            else if (ch === '}') brace--

          }

          if (brace <= 0 && /\}/.test(line)) {

            skipping = false

          }

          continue

        }

        kept.push(line)

      }

      out = kept.join('\n')

    }



    // Strip TS `satisfies` operator: `expr satisfies Type` -> `expr`

    if (/\s+satisfies\s+[A-Za-z_$][\w$<>, \t\[\]\|&]+/m.test(out)) {

      out = out.replace(/\s+satisfies\s+[A-Za-z_$][\w$<>, \t\[\]\|&]+/g, '')

      notes.push('removed satisfies operator')

    }



    // Strip non-null assertion: `foo!.bar` -> `foo.bar`

    if (/([A-Za-z_$][\w$]*)!\s*(?=[\.\[\(])/.test(out)) {

      out = out.replace(/([A-Za-z_$][\w$]*)!\s*(?=[\.\[\(])/g, '$1')

      notes.push('removed non-null assertions')

    }



    // Strip `as Type` assertions.

    if (/\s+as\s+[A-Za-z_$][\w$<>, \t\[\]\|&]+/.test(out)) {

      out = out.replace(/\s+as\s+[A-Za-z_$][\w$<>, \t\[\]\|&]+/g, '')

      notes.push('removed \"as Type\" assertions')

    }



    // Strip var/let/const type annotations: `const x: any =` -> `const x =`

    if (/\b(const|let|var)\s+[A-Za-z_$][\w$]*\s*:\s*[^=;\n]+=/.test(out)) {

      out = out.replace(/\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*[^=;\n]+=/g, '$1 $2 =')

      notes.push('stripped variable type annotations')

    }



    // Strip var/let type declarations without initializer: `let x: any;` -> `let x;`

    if (/\b(let|var)\s+[A-Za-z_$][\w$]*\s*:\s*[^;,\n]+;/.test(out)) {

      out = out.replace(/\b(let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*[^;,\n]+;/g, '$1 $2;')

      notes.push('stripped var/let declaration type annotations')

    }



    // Best-effort: `const x: any;` is invalid JS. Convert to `let x;` to keep runtime behavior.

    if (/\bconst\s+[A-Za-z_$][\w$]*\s*:\s*[^;,\n]+;/.test(out)) {

      out = out.replace(/\bconst\s+([A-Za-z_$][\w$]*)\s*:\s*[^;,\n]+;/g, 'let $1;')

      notes.push('converted const declarations without initializer')

    }



    // Strip function param annotations inside (...) : `fn(a: string, b: number)` -> `fn(a, b)`

    //

    // IMPORTANT: keep this conservative. A broad matcher like `[^,)\n]+` can corrupt legitimate JS

    // object literals inside function calls, e.g.:

    //   fn({ content: { ... } })

    // because `,\\n  content: {` starts with a comma and looks like `name: Type` to a naive regex.

    //

    // Only strip when the "type" looks like a TS type expression (identifiers/generics/[]/|/&)

    // and is immediately followed by `,` / `)` / `=` (default value).

    const tsType = '[A-Za-z_$][\\w$<>, \\t\\[\\]\\|&]*'

    const tsParam = new RegExp(`([\\(\\,])\\s*([A-Za-z_$][\\w$]*)\\s*:\\s*${tsType}\\s*(?=(\\s*(?:,|\\)|=)))`, 'g')

    if (tsParam.test(out)) {

      out = out.replace(tsParam, '$1 $2')

      notes.push('stripped parameter type annotations')

    }



    // Strip optional params: `fn(a?: string)` -> `fn(a)`

    const tsOptParam = new RegExp(`([\\(\\,])\\s*([A-Za-z_$][\\w$]*)\\s*\\?\\s*:\\s*${tsType}\\s*(?=(\\s*(?:,|\\)|=)))`, 'g')

    if (tsOptParam.test(out)) {

      out = out.replace(tsOptParam, '$1 $2')

      notes.push('stripped optional parameter annotations')

    }



    // Strip destructured param annotations: `fn(({a}: any))` / `fn(([a]: any))`

    if (/[\}\]]\s*:\s*[^,\)\n]+(?=[,\)])/.test(out)) {

      out = out.replace(/([\}\]])\s*:\s*[^,\)\n]+(?=[,\)])/g, '$1')

      notes.push('stripped destructured parameter annotations')

    }



    // Strip function return type annotations: `function f(): string {` or `(): void =>`

    // Handle object/tuple return types first: `(): { a: number } {` / `(): [number, string] =>`

    // (Common failure mode: SyntaxError: Unexpected token ':' at the first ':' after `)`).

    if (/\)\s*:\s*\{[\s\S]*?\}\s*(?=\{|=>)/.test(out)) {

      out = out.replace(/\)\s*:\s*\{[\s\S]*?\}\s*(?=\{|=>)/g, ') ')

      notes.push('stripped object return type annotations')

    }

    if (/\)\s*:\s*\[[\s\S]*?\]\s*(?=\{|=>)/.test(out)) {

      out = out.replace(/\)\s*:\s*\[[\s\S]*?\]\s*(?=\{|=>)/g, ') ')

      notes.push('stripped tuple/array return type annotations')

    }

    if (/\)\s*:\s*[^=\n{]+\s*(?=\{|=>)/.test(out)) {

      out = out.replace(/\)\s*:\s*[^=\n{]+\s*(?=\{|=>)/g, ') ')

      notes.push('stripped return type annotations')

    }



    // Cleanup empty lines introduced by removals.

    out = out.replace(/\n{3,}/g, '\n\n').trim()



    return { code: out, changed: notes.length > 0, notes: Array.from(new Set(notes)) }

  }



  /**

   * 检测是否为 JS 宏代码

   */

  isJSMacro(code: string): boolean {

    const trimmed = code.trim()

    return (

      trimmed.includes('function ') ||

      trimmed.includes('=>') ||

      trimmed.includes('WPS.GetApplication') ||

      trimmed.includes('app.Selection') ||

      trimmed.includes('window.Application') ||

      trimmed.includes('app.') ||

      trimmed.includes('BID.')

    )

  }



  /**

   * 获取步骤显示名称

   */

  private getPhaseDisplayName(type: string): string {

    const phaseMap: Record<string, string> = {

      'thinking': '思考中',

      'generating': '代码生成中',

      'checking': '基础检查中',

      'analyzing': 'LLM分析中',

      'fixing': '代码修复中',

      'validating': '验证中',

      'executing': '执行中',

      'completed': '已完成'

    }

    return phaseMap[type] || '处理中'

  }



  /**

   * 获取步骤状态颜色

   */

  getStepStatusColor(status: string): string {

    const colorMap: Record<string, string> = {

      'pending': '#999',

      'processing': '#409EFF',

      'completed': '#67C23A',

      'error': '#F56C6C'

    }

    return colorMap[status] || '#999'

  }



  /**

   * 获取步骤图标

   */

  getStepIcon(type: string): string {

    const iconMap: Record<string, string> = {

      'thinking': '🤔',

      'generating': '⚙️',

      'checking': '🔍',

      'analyzing': '🧠',

      'fixing': '🔧',

      'validating': '✅',

      'executing': '🚀',

      'completed': '🎉'

    }

    return iconMap[type] || '📝'

  }

}



// 创建全局实例

export const jsMacroExecutor = new JSMacroExecutor()



