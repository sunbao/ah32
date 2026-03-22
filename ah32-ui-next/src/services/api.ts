/**
 * API 服务层
 */
import axios from 'axios'
import type { SSEEvent } from './types'
import { logToBackend, syncOpenDocumentsNow } from './document-sync'
import { wpsBridge } from './wps-bridge'
import { ensureDocSnapshotForChat } from './doc-snapshot'
import { getRuntimeConfig } from '@/utils/runtime-config'
import { getClientId } from '@/utils/client-id'
import { getBootId, getBootSeq } from '@/utils/boot-id'
import { patchReloadDiag } from '@/utils/reload-diag'

// Magic Numbers常量定义
const MAGIC_NUMBERS = {
  // 缓冲区大小
  MAX_BUFFER_SIZE: 1024 * 1024,  // 1MB缓冲区大小限制
  DEFAULT_TIMEOUT: 30000,         // 默认超时时间（毫秒）
} as const

const runtime = () => getRuntimeConfig()
// Streaming timeout strategy:
// - Default: no hard timeout (long LLM calls + large docs happen).
// - Optional: set VITE_STREAM_IDLE_TIMEOUT_MS to abort only when the server is silent for too long.
const STREAM_IDLE_TIMEOUT_MS = Number(import.meta.env.VITE_STREAM_IDLE_TIMEOUT_MS || '0')

const fnv1a32Hex = (input: string): string => {
  let h = 0x811c9dc5
  const s = String(input || '')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

let _lastSseJsonParseWarning = { key: '', at: 0 }
let _activeDocTextCache: { key: string; at: number; text: string | null } = { key: '', at: 0, text: null }
const ACTIVE_DOC_TEXT_CACHE_TTL_MS = 15_000

const capText = (raw: string | null, maxChars: number): string | null => {
  try {
    const s = String(raw || '')
    if (!s.trim()) return null
    if (!maxChars || maxChars <= 0) return s
    if (s.length <= maxChars) return s
    const suffix = '\n...(truncated_by_max_chars)'
    const head = s.slice(0, Math.max(0, maxChars - suffix.length))
    return head + suffix
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/api.ts', e)
    return null
  }
}

const maybeLogSseJsonParseFailure = (raw: string, error: unknown) => {
  try {
    const s = String(raw || '').trim()
    if (!s) return
    const looksJsonish =
      (s.startsWith('{') && s.endsWith('}')) ||
      (s.startsWith('[') && s.endsWith(']'))
    if (!looksJsonish) return

    const msg = String((error as any)?.message || error || '').slice(0, 400)
    const key = `${msg}::${s.slice(0, 200)}`
    const now = Date.now()
    if (_lastSseJsonParseWarning.key === key && now - _lastSseJsonParseWarning.at < 8000) return
    _lastSseJsonParseWarning = { key, at: now }

    logToBackend(
      `[SSE] JSON.parse failed: ${msg}; head=${s.slice(0, 200)}`,
      'warning',
    )
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/api.ts', e)
  }
}

const parseSsePayloadSafely = (raw: string): any | null => {
  const original = String(raw ?? '')
  const normalized = original.replace(/^\uFEFF/, '').replace(/\u0000/g, '').trim()
  const attempts = [original, normalized]
  let lastError: unknown = null

  for (const candidate of attempts) {
    if (!candidate) continue
    try {
      return JSON.parse(candidate)
    } catch (e) {
      lastError = e
      // try next strategy
    }
  }

  const firstBrace = normalized.indexOf('{')
  const lastBrace = normalized.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const body = normalized.slice(firstBrace, lastBrace + 1)
    try {
      return JSON.parse(body)
    } catch (e) {
      lastError = e
      // final fallback below
    }
  }

  if (lastError) maybeLogSseJsonParseFailure(normalized, lastError)
  return null
}

const inferSseEventType = (explicitEvent: string | null, payload: any): string => {
  const explicit = String(explicitEvent || '').trim()
  if (explicit) return explicit

  try {
    const embedded =
      payload && typeof payload === 'object' && typeof (payload as any).type === 'string'
        ? String((payload as any).type || '').trim()
        : ''
    if (embedded) return embedded
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/api.ts', e)
  }

  // Fallback inference: some endpoints emit only `data:` frames (no `event:` line).
  // The UI should not treat the final token-usage envelope as normal content.
  try {
    const hasEnvelope =
      payload &&
      typeof payload === 'object' &&
      Object.prototype.hasOwnProperty.call(payload, 'token_usage') &&
      Object.prototype.hasOwnProperty.call(payload, 'elapsed_ms') &&
      Object.prototype.hasOwnProperty.call(payload, 'session_id')
    if (hasEnvelope) return 'done'
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/api.ts', e)
  }

  return 'content'
}

const looksLikeSseMetaEnvelope = (raw: string): boolean => {
  const s = String(raw || '').trim()
  if (!s || s.length > 6000) return false
  if (!s.startsWith('{') || !s.endsWith('}')) return false
  return s.includes('"token_usage"') && s.includes('"elapsed_ms"') && s.includes('"session_id"')
}

// 收集当前文档上下文
function collectDocumentContext() {
  try {
    // Avoid expensive stats during streaming (can be called frequently in some flows).
    const docs = wpsBridge.getAllOpenDocuments({ includeStats: false } as any)
    const activeDoc = docs.find(doc => doc.isActive)
    const hostApp = wpsBridge.getHostApp()
    const capabilities = wpsBridge.getCapabilities(false)

    // Optional: attach a lightweight active doc preview for prompting.
    // NOTE (WPS Writer stability): do NOT extract/upload full document text per turn here.
    // Full-fidelity "document snapshot" should be handled by a dedicated upload workflow.
    let activeDocText: string | null = null
    let activeDocTextFull: string | null = null
    let activeEtMeta: Record<string, any> | null = null
    let activeEtHeaderMap: Record<string, any> | null = null
    try {
      const activeId = activeDoc ? String(activeDoc.id || '').trim() : ''
      const cacheKey = activeDoc && activeId ? `${hostApp}:${activeId}` : ''
      const now = Date.now()

      // Cache active doc text briefly to avoid repeated heavy extraction across consecutive chat turns.
      const allowCache = hostApp !== 'wps'
      if (allowCache && cacheKey && _activeDocTextCache.key === cacheKey && now - _activeDocTextCache.at < ACTIVE_DOC_TEXT_CACHE_TTL_MS) {
        activeDocText = _activeDocTextCache.text
      } else if (activeDoc && activeId && hostApp === 'et') {
        // ET: keep it lightweight (structured preview is often enough).
        activeDocText = wpsBridge.extractDocumentTextById(activeId, {
          maxChars: 60_000,
          maxRows: 120,
          maxCols: 40,
          maxCells: 2400,
        })

        if (activeDocText && !String(activeDocText).trim()) activeDocText = null
        if (activeDocTextFull && !String(activeDocTextFull).trim()) activeDocTextFull = null

        // Only cache the preview; full text must reflect live edits.
        if (allowCache) {
          _activeDocTextCache = { key: cacheKey, at: now, text: activeDocText }
        } else {
          _activeDocTextCache = { key: '', at: 0, text: null }
        }
      }

      if (activeDoc && hostApp === 'et' && activeId) {
        activeEtMeta = wpsBridge.extractEtMetaById(activeId)
        activeEtHeaderMap = wpsBridge.extractEtHeaderMapById(activeId, { maxCols: 50 })
      }
    } catch (e) {
      try {
        const msg = e instanceof Error ? e.message : String(e)
        logToBackend(`[API] collectDocumentContext: active doc text/meta best-effort failed: ${msg}`, 'warning')
      } catch (e2) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/api.ts', e2)
      }
      activeDocText = null
      activeEtMeta = null
      activeEtHeaderMap = null
    }
    
    const bootId = (() => {
      try { return getBootId() } catch (_e) { return '' }
    })()
    const bootSeq = (() => {
      try { return getBootSeq() } catch (_e) { return 0 }
    })()
    const clientId = (() => {
      try { return getClientId() } catch (_e) { return '' }
    })()

    return {
      boot_id: bootId,
      boot_seq: bootSeq,
      client_id: clientId,
      host_app: hostApp,
      capabilities,
      active_doc_text: activeDocText,
      active_doc_text_full: activeDocTextFull,
      active_et_meta: activeEtMeta,
      active_et_header_map: activeEtHeaderMap,
      documents: docs.map(doc => ({
        id: doc.id,
        name: doc.name,
        fullPath: doc.fullPath,
        isActive: doc.isActive,
        hostApp: doc.hostApp,
        wordCount: doc.wordCount,
        pageCount: doc.pageCount
      })),
      activeDocument: activeDoc ? {
        id: activeDoc.id,
        name: activeDoc.name,
        fullPath: activeDoc.fullPath,
        hostApp: activeDoc.hostApp,
        wordCount: activeDoc.wordCount,
        pageCount: activeDoc.pageCount
      } : null,
      timestamp: new Date().toISOString()
    }
  } catch (error) {
    console.error('[API] 收集文档上下文失败:', error)
    return null
  }
}

// NOTE: keep frontend_context structured; do not inline it into message to avoid RAG pollution.

// 创建 Axios 实例
const api = axios.create({
  baseURL: runtime().apiBase,
  headers: {
    ...(runtime().apiKey ? { 'X-API-Key': runtime().apiKey } : {}),
    'Content-Type': 'application/json',
  },
  timeout: MAGIC_NUMBERS.DEFAULT_TIMEOUT
})

// 请求拦截器
api.interceptors.request.use(
  config => {
    try {
      const cfg = getRuntimeConfig()
      const uid = getClientId()
      ;(config.headers as any) = (config.headers as any) || {}
      ;(config.headers as any)['X-AH32-User-Id'] = uid
      ;(config.headers as any)['X-AH32-Client-Id'] = uid
      if (cfg.tenantId) ;(config.headers as any)['X-AH32-Tenant-Id'] = cfg.tenantId
      if (cfg.accessToken) ;(config.headers as any)['Authorization'] = `Bearer ${cfg.accessToken}`
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/api.ts', e)
    }
    return config
  },
  error => Promise.reject(error)
)

// 响应拦截器
api.interceptors.response.use(
  response => response.data,
  error => Promise.reject(error)
)

// SSE 流式通信（保留原有机制）
export const sseService = {
  /**
   * 建立 SSE 连接
   */
  connect(
    url: string,
    onChunk: (chunk: SSEEvent) => void,
    onError?: (error: any) => void
  ): EventSource {
    const eventSource = new EventSource(url)

    // 监听 thinking 事件（思考内容）
    eventSource.addEventListener('thinking', (event) => {
      try {
        const data = parseSsePayloadSafely((event as MessageEvent).data)
        if (!data || typeof data !== 'object') {
          return
        }
        onChunk({ type: 'thinking', data })
      } catch (e) {
        console.error('[SSE] 思考事件解析失败:', e)
        // 向用户显示错误
        onError?.(new Error('解析思考内容失败，请检查网络连接'))
      }
    })

    // 监听 content 事件（内容输出）
    eventSource.addEventListener('content', (event) => {
      try {
        const data = parseSsePayloadSafely((event as MessageEvent).data)
        if (!data || typeof data !== 'object') {
          const raw = String((event as MessageEvent).data || '')
          if (looksLikeSseMetaEnvelope(raw)) return
          onChunk({ type: 'content', data: { content: raw } })
          return
        }
        onChunk({ type: 'content', data })
      } catch (e) {
        console.error('[SSE] 内容事件解析失败:', e)
        // 向用户显示错误
        onError?.(new Error('解析内容数据失败，请检查网络连接'))
      }
    })

    // 监听 done 事件（完成）
    eventSource.addEventListener('done', (event) => {
      onChunk({ type: 'done', data: {} })
      eventSource.close()
    })

    // 监听 error 事件
    eventSource.addEventListener('error', (event) => {
      onError?.(event)
      eventSource.close()
    })

    return eventSource
  },

  /**
   * 关闭 SSE 连接
   */
  disconnect(eventSource: EventSource) {
    if (eventSource) {
      eventSource.close()
    }
  }
}

// 聊天 API
export const chatApi = {
  /**
   * 发送消息（流式）- 使用 fetch + ReadableStream 实现 SSE
   * 后端 POST /agentic/chat/stream 返回 SSE 流
   */
  async streamResponse(
    message: string,
    sessionId: string,
    documentName: string | null,
    onChunk: (chunk: SSEEvent) => void | Promise<void>,
    abortController?: AbortController,
    opts?: {
      ensureDocSync?: boolean
      frontendContextPatch?: Record<string, any>
      ruleFiles?: string[]
    }
  ) {
    // Streaming uses fetch + AbortController.
    // We intentionally avoid a hard "total timeout" (long LLM calls happen).
    // If needed, set VITE_STREAM_IDLE_TIMEOUT_MS to abort only when the server is silent for too long.
	    const controller = abortController || new AbortController()
	    let idleTimer: ReturnType<typeof setTimeout> | null = null
	    const startedAt = Date.now()
	    const startedAtIso = new Date().toISOString()
	    const msgLen = (() => {
	      try { return String(message || '').length } catch (_e) { return 0 }
	    })()
	    const msgHash = (() => {
	      try { return fnv1a32Hex(String(message || '').slice(0, 2000)) } catch (_e) { return '' }
	    })()
	    let firstChunkAt = 0
	    let lastChunkDiagAt = 0

	    const resetIdleTimer = () => {
	      if (!STREAM_IDLE_TIMEOUT_MS || STREAM_IDLE_TIMEOUT_MS <= 0) return
	      if (idleTimer) clearTimeout(idleTimer)
	      idleTimer = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS)
	    }

	    try {
	      const ensureDocSync = !!opts?.ensureDocSync
	      try {
	        patchReloadDiag({
	          inflight_chat: {
	            at: startedAtIso,
	            stage: 'prepare',
	            session_id: sessionId,
	            doc_name: documentName || null,
	            msg_len: msgLen,
	            msg_hash: msgHash,
	            ensure_doc_sync: ensureDocSync,
	          },
	          lastChatStartAt: startedAtIso,
	          lastChatSessionId: sessionId,
	          lastChatMsgLen: msgLen,
	          lastChatMsgHash: msgHash,
	        })
	      } catch (e) {
	        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/api.ts', e)
	      }
	      try {
	        logToBackend(
	          `[CHAT] stream start session=${String(sessionId || '').slice(0, 64)} msg_len=${msgLen} msg_hash=${msgHash} ensure_doc_sync=${ensureDocSync ? '1' : '0'}`,
	          'info'
	        )
	      } catch (e) {
	        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/api.ts', e)
	      }

	      let docSyncOk: boolean | null = null
	      if (ensureDocSync) {
        try {
          // Best-effort: do not stall chat for too long.
          const ok = await Promise.race([
            syncOpenDocumentsNow(),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000))
          ])
          docSyncOk = !!ok
        } catch (e: any) {
          docSyncOk = false
          try { logToBackend(`[API] ensureDocSync failed: ${String(e?.message || e)}`, 'warning') } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/api.ts', e) }
        }
      }

      // Agentic感知：收集当前文档上下文
      const frontendContext = collectDocumentContext()
      if (frontendContext && ensureDocSync) {
        ;(frontendContext as any).doc_sync = { ok: docSyncOk, at: new Date().toISOString() }
      }
      // Allow callers (MacroBench etc.) to attach extra structured context.
      if (frontendContext && opts?.frontendContextPatch && typeof opts.frontendContextPatch === 'object') {
        try { Object.assign(frontendContext as any, opts.frontendContextPatch) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/api.ts', e) }
      }

      // Remote-backend mode: upload active doc context via doc snapshot (best-effort).
	      let docSnapshotId: string | null = null
	      let docSnapshotMeta: any = null
	      try {
	        if (frontendContext) {
	          const res = await ensureDocSnapshotForChat({ frontendContext, signal: controller.signal })
	          docSnapshotId = res?.snapshotId ? String(res.snapshotId) : null
	          docSnapshotMeta = (res as any)?.meta ?? null
	          try {
	            patchReloadDiag({
	              inflight_chat: {
	                at: startedAtIso,
	                stage: 'doc_snapshot_done',
	                session_id: sessionId,
	                doc_name: documentName || null,
	                msg_len: msgLen,
	                msg_hash: msgHash,
	                doc_snapshot_ok: !!docSnapshotId,
	              },
	              lastChatDocSnapshotOk: !!docSnapshotId,
	            })
	          } catch (e) {
	            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/api.ts', e)
	          }
	          // Keep meta for debugging, but do NOT use names that the backend may interpret as a snapshot id.
	          try { ;(frontendContext as any).doc_snapshot_meta = docSnapshotMeta } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/api.ts', e) }
	        }
	      } catch (e) {
	        try { logToBackend(`[API] ensureDocSnapshot failed: ${String((e as any)?.message || e)}`, 'warning') } catch (e2) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/api.ts', e2) }
	        docSnapshotId = null
	        try {
	          patchReloadDiag({
	            inflight_chat: {
	              at: startedAtIso,
	              stage: 'doc_snapshot_failed',
	              session_id: sessionId,
	              doc_name: documentName || null,
	              msg_len: msgLen,
	              msg_hash: msgHash,
	              doc_snapshot_ok: false,
	            },
	            lastChatDocSnapshotOk: false,
	          })
	        } catch (e2) {
	          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/api.ts', e2)
	        }
	      }

      // If snapshot is missing, attach a bounded text preview so the model can still help *honestly*.
      // IMPORTANT: this is a preview only (may be incomplete). Do NOT treat it as full-fidelity doc context.
      try {
        if (!docSnapshotId && frontendContext) {
          const hostApp = String((frontendContext as any).host_app || '').trim().toLowerCase()
          const active = (frontendContext as any).activeDocument || ((frontendContext as any).documents || []).find((d: any) => d && d.isActive) || null
          const docId = String(active?.id || active?.doc_id || active?.docId || '').trim()
          if (docId) {
            const maxChars = hostApp === 'wps' ? 60_000 : hostApp === 'et' ? 60_000 : hostApp === 'wpp' ? 60_000 : 60_000
            const preview = String(wpsBridge.extractDocumentTextById(docId, { maxChars }) || '')
            if (preview && preview.trim()) {
              ;(frontendContext as any).active_doc_text = preview
              ;(frontendContext as any).active_doc_max_chars = maxChars
              ;(frontendContext as any).doc_context_mode = 'preview_only'
              ;(frontendContext as any).doc_context_notice =
                'doc snapshot is missing; this is a client-provided text preview only (may be incomplete)'
            } else if (docSnapshotMeta && typeof docSnapshotMeta === 'object') {
              ;(frontendContext as any).doc_context_mode = 'no_doc'
              ;(frontendContext as any).doc_context_notice =
                'doc snapshot is missing and no text preview is available; proceed without document'
            }
          }
        }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/api.ts', e)
      }
      // 仅通过结构化字段传给后端；不要把上下文拼进 message（会污染 RAG 检索、拖慢推理）。
      console.log('[API] 动态感知上下文:', frontendContext ? '已收集' : '未收集')

      // Start idle timeout timer (optional).
      resetIdleTimer()

      const cfg = runtime()
      const bootId = (() => {
        try { return getBootId() } catch (_e) { return '' }
      })()
      const bootSeq = (() => {
        try { return getBootSeq() } catch (_e) { return 0 }
      })()
      const clientId = (() => {
        try { return getClientId() } catch (_e) { return '' }
      })()

	      const response = await fetch(
	        `${cfg.apiBase}/agentic/chat/stream?show_thoughts=${cfg.showThoughts ? 'true' : 'false'}&show_rag=${cfg.showRagHits ? 'true' : 'false'}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {}),
            ...(cfg.tenantId ? { 'X-AH32-Tenant-Id': cfg.tenantId } : {}),
            ...(cfg.accessToken ? { Authorization: `Bearer ${cfg.accessToken}` } : {}),
            ...(clientId ? { 'X-AH32-User-Id': clientId } : {}),
            ...(bootId ? { 'X-AH32-Boot-Id': bootId } : {}),
            ...(bootSeq ? { 'X-AH32-Boot-Seq': String(bootSeq) } : {}),
            ...(clientId ? { 'X-AH32-Client-Id': clientId } : {}),
          },
        body: JSON.stringify({
          message,
          session_id: sessionId,
          document_name: documentName,
          doc_snapshot_id: docSnapshotId || undefined,
          // 传递结构化上下文给后端（可选，后端可进一步处理）
          frontend_context: frontendContext,
          rule_files: Array.isArray(opts?.ruleFiles) ? opts?.ruleFiles : undefined
        }),
        signal: controller.signal
	        }
	      )

	      try {
	        patchReloadDiag({
	          inflight_chat: {
	            at: startedAtIso,
	            stage: 'stream_open',
	            session_id: sessionId,
	            doc_name: documentName || null,
	            msg_len: msgLen,
	            msg_hash: msgHash,
	            http_status: response.status,
	          },
	        })
	      } catch (e) {
	        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/api.ts', e)
	      }

	      if (!response.ok) {
	        const errorText = await response.text()
	        throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`)
	      }

      if (!response.body) {
        throw new Error('Response body is null')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      // Keep event state across chunks (SSE frames can be split across reads).
      let currentEvent: string | null = null
      let currentData: string = ''
      // Some backends close the stream without an explicit `event: done`.
      // The UI uses `done` to flush buffered content/tool output deterministically.
      let gotDoneEvent = false
      const emit = async (ev: SSEEvent) => {
        if (ev?.type === 'done') gotDoneEvent = true
        return onChunk(ev)
      }

      // ✅ 修复：限制 buffer 大小，防止内存溢出
      const MAX_BUFFER_SIZE = MAGIC_NUMBERS.MAX_BUFFER_SIZE

      try {
	        while (true) {
	          const { done, value } = await reader.read()

	          if (done) {
            console.log('[SSE] 数据流读取完成')
            // Flush the last (possibly unterminated) event.
            if (currentData) {
              const parsedData = parseSsePayloadSafely(currentData)
              if (parsedData && typeof parsedData === 'object') {
                const inferredType = inferSseEventType(currentEvent, parsedData)
                await emit({ type: inferredType as SSEEvent['type'], data: parsedData })
              } else {
                const raw = String(currentData || '')
                if (raw.trim() === '[DONE]') {
                  await emit({ type: 'done', data: {} })
                } else if (!looksLikeSseMetaEnvelope(raw)) {
                  await emit({ type: 'content', data: { content: raw } })
                }
              }
              currentEvent = null
              currentData = ''
            }
            break
          }

	          resetIdleTimer()

	          if (!firstChunkAt) {
	            firstChunkAt = Date.now()
	            const ttfbMs = firstChunkAt - startedAt
	            try {
	              patchReloadDiag({
	                lastChatFirstChunkAt: new Date(firstChunkAt).toISOString(),
	                inflight_chat: {
	                  at: startedAtIso,
	                  stage: 'streaming',
	                  session_id: sessionId,
	                  doc_name: documentName || null,
	                  msg_len: msgLen,
	                  msg_hash: msgHash,
	                  ttfb_ms: ttfbMs,
	                },
	              })
	            } catch (e) {
	              ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/api.ts', e)
	            }
	            try {
	              logToBackend(`[CHAT] stream first_chunk ttfb_ms=${ttfbMs} session=${String(sessionId || '').slice(0, 64)}`, 'info')
	            } catch (e) {
	              ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/api.ts', e)
	            }
	          } else {
	            const now = Date.now()
	            if (now - lastChunkDiagAt > 1500) {
	              lastChunkDiagAt = now
	              try {
	                patchReloadDiag({
	                  lastChatLastChunkAt: new Date(now).toISOString(),
	                  inflight_chat: {
	                    at: startedAtIso,
	                    stage: 'streaming',
	                    session_id: sessionId,
	                    doc_name: documentName || null,
	                    msg_len: msgLen,
	                    msg_hash: msgHash,
	                  },
	                })
	              } catch (e) {
	                ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/api.ts', e)
	              }
	            }
	          }

	          // 解码接收到的数据
	          const chunk = decoder.decode(value, { stream: true })

          // 检查缓冲区大小，防止内存泄漏
          if (buffer.length + chunk.length > MAX_BUFFER_SIZE) {
            buffer = buffer.slice(-MAX_BUFFER_SIZE / 2) // 保留后半部分
          }

          buffer += chunk

          // 按行分割处理SSE格式
          let lines = buffer.split(/\r?\n|\r|\n/g)
          // 保留最后一行（可能不完整）
          buffer = lines.pop() || ''

          // 处理每一行 - 改进SSE解析逻辑（支持跨 chunk 的 event/data 帧）
          for (const rawLine of lines) {
            const line = rawLine ?? ''
            if (line.startsWith('event:')) {
              currentEvent = line.slice(6).trim()
              continue
            }
            if (line.startsWith('data:')) {
              const dataPart = line.slice(5)
              // Preserve leading whitespace after ":"; drop only one optional space.
              currentData += dataPart.startsWith(' ') ? dataPart.slice(1) : dataPart
              continue
            }
            if (line.trim() === '') {
              // 空行表示一个SSE事件结束
              if (currentData) {
                const parsedData = parseSsePayloadSafely(currentData)
                if (parsedData && typeof parsedData === 'object') {
                  const inferredType = inferSseEventType(currentEvent, parsedData)
                  await emit({ type: inferredType as SSEEvent['type'], data: parsedData })
                } else {
                  // If JSON parsing fails, still surface it as content for robustness.
                  const raw = String(currentData || '')
                  if (raw.trim() === '[DONE]') {
                    await emit({ type: 'done', data: {} })
                  } else if (!looksLikeSseMetaEnvelope(raw)) {
                    await emit({ type: 'content', data: { content: raw } })
                  }
                }
              }
              currentEvent = null
              currentData = ''
              continue
            }
            if (line.startsWith(':')) {
              // 注释行，忽略

            }
          }
        }
        // Ensure the consumer sees an end-of-stream marker, even if the server didn't send one.
	        if (!gotDoneEvent) {
	          await emit({ type: 'done', data: {} })
	        }
	        try {
	          const elapsed = Date.now() - startedAt
	          patchReloadDiag({
	            inflight_chat: null,
	            lastChatOk: true,
	            lastChatElapsedMs: elapsed,
	            lastChatEndAt: new Date().toISOString(),
	          })
	        } catch (e) {
	          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/api.ts', e)
	        }
	        try {
	          const elapsed = Date.now() - startedAt
	          logToBackend(`[CHAT] stream done elapsed_ms=${elapsed} session=${String(sessionId || '').slice(0, 64)}`, 'info')
	        } catch (e) {
	          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/api.ts', e)
	        }
	      } finally {
	        // Release the reader best-effort. Some embedded webviews can hang here
	        // even after the server has already delivered the final done event.
	        try {
	          await Promise.race([
	            reader.cancel(),
	            new Promise<void>((resolve) => {
	              setTimeout(resolve, 500)
	            }),
	          ])
        } catch (e) {
          console.warn('[SSE] reader.cancel best-effort failed:', e)
        }
      }
	    } catch (error: any) {
	      console.error('[API] 流式响应失败:', error)
	      let errorKind = 'unknown'
	      let errorKindReason = ''
	      try {
	        const now = Date.now()
	        const errName = String(error?.name || '')
	        const errMsg = String(error?.message || error || '')
	        const online = (typeof navigator !== 'undefined' && typeof (navigator as any).onLine === 'boolean')
	          ? (navigator as any).onLine
	          : null
	        let diag: any = null
	        try {
	          const raw = String(localStorage.getItem('ah32_reload_diag_v1') || '')
	          diag = raw && raw.trim() ? JSON.parse(raw) : null
	        } catch (_e) {
	          diag = null
	        }

	        const recent = (t: any) => {
	          const ms = Date.parse(String(t || ''))
	          if (!Number.isFinite(ms)) return false
	          const d = now - ms
	          return d >= 0 && d <= 4000
	        }

	        const rBefore = recent((diag as any)?.lastBeforeUnloadAt)
	        const rPagehide = recent((diag as any)?.lastPagehideAt)
	        const rUnload = recent((diag as any)?.lastUnloadAt)
	        const diagOnline = (diag as any)?.lastOnline

	        // Unload/pagehide is the #1 cause of "Failed to fetch" during streaming on WPS webviews.
	        if (rBefore || rPagehide || rUnload) {
	          errorKind = 'taskpane_unloading'
	          errorKindReason = `recent_beforeunload=${rBefore ? '1' : '0'} recent_pagehide=${rPagehide ? '1' : '0'} recent_unload=${rUnload ? '1' : '0'} vis=${String((diag as any)?.lastVisibilityState || '')}`
	        } else if (online === false || diagOnline === false) {
	          errorKind = 'offline'
	          errorKindReason = `navigator_online=${online === false ? '0' : online === true ? '1' : '?'} diag_lastOnline=${diagOnline === false ? '0' : diagOnline === true ? '1' : '?'}`
	        } else if (errName === 'AbortError') {
	          errorKind = 'abort'
	        } else if (/Failed to fetch/i.test(errMsg) || /NetworkError/i.test(errMsg)) {
	          errorKind = 'fetch_failed'
	        }
	      } catch (e) {
	        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/api.ts', e)
	      }
	      try {
	        const elapsed = Date.now() - startedAt
	        patchReloadDiag({
	          inflight_chat: null,
	          lastChatOk: false,
	          lastChatElapsedMs: elapsed,
	          lastChatEndAt: new Date().toISOString(),
	          lastChatErrorName: String(error?.name || ''),
	          lastChatError: String(error?.message || error || ''),
	          lastChatErrorKind: errorKind,
	          lastChatErrorKindReason: errorKindReason,
	        })
	      } catch (e) {
	        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/api.ts', e)
	      }
	      try {
	        const elapsed = Date.now() - startedAt
	        logToBackend(`[CHAT] stream failed kind=${errorKind} elapsed_ms=${elapsed} name=${String(error?.name || '').slice(0, 40)} msg=${String(error?.message || error || '').slice(0, 200)} reason=${String(errorKindReason || '').slice(0, 180)}`, 'warning')
	      } catch (e) {
	        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/api.ts', e)
	      }

	      if (errorKind === 'taskpane_unloading') {
        const err = new Error('Taskpane 发生自动重载/卸载，导致请求中断（非人为操作）。请重试；如频繁出现请截图并反馈 boot_seq。')
        ;(err as any).cause = error
        throw err
      }

	      if (errorKind === 'offline') {
        const err = new Error('网络离线或后端不可达，导致请求失败。请检查网络/代理后重试。')
        ;(err as any).cause = error
        throw err
      }

	      // 如果是超时错误，提供更友好的错误信息
	      if (error.name === 'AbortError') {
        throw new Error(
          STREAM_IDLE_TIMEOUT_MS > 0
            ? `请求超时：长时间未收到服务端数据（idle_timeout=${STREAM_IDLE_TIMEOUT_MS}ms）`
            : '请求已取消'
        )
      }

      throw error
	    } finally {
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
    }
  },

  /**
   * 发送消息（非流式）- 简化的API调用
   */
  async sendMessage(message: string, sessionId: string, documentName: string | null = null) {
    try {
      const cfg = runtime()
      const clientId = (() => {
        try { return getClientId() } catch (_e) { return '' }
      })()
      const response = await fetch(`${cfg.apiBase}/agentic/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {}),
          ...(cfg.tenantId ? { 'X-AH32-Tenant-Id': cfg.tenantId } : {}),
          ...(cfg.accessToken ? { Authorization: `Bearer ${cfg.accessToken}` } : {}),
          ...(clientId ? { 'X-AH32-User-Id': clientId } : {}),
        },
        body: JSON.stringify({
          message,
          session_id: sessionId,
          document_name: documentName
        })
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      return await response.json()
    } catch (error) {
      console.error('[API] 发送消息失败:', error)
      throw error
    }
  }
}

// 文档 API
export const documentApi = {
  /**
   * 分析文档（文件上传）
   */
  async analyzeDocument(file: File) {
    const formData = new FormData()
    formData.append('file', file)
    return api.post('/analyze', formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      }
    })
  },

  /**
   * 分析文档（文件路径）
   */
  async analyzeDocumentPath(filePath: string) {
    return api.post('/analyze_path', { file_path: filePath })
  }
}

// 知识库 API
export const knowledgeApi = {
  /**
   * 获取知识库列表
   */
  async getKnowledgeList() {
    return api.get('/knowledge')
  },

  /**
   * 添加知识库
   */
  async ingestKnowledge(sourceDir: string) {
    return api.post('/ingest', { source_dir: sourceDir })
  },

  /**
   * 搜索知识库
   */
  async searchKnowledge(query: string, limit: number = 10) {
    return api.get('/knowledge/search', {
      params: { query, limit }
    })
  },

  /**
   * 搜索图片（新增）
   */
  async searchImages(query: string, type: string = 'image', limit: number = 5) {
    return api.get('/knowledge/search', {
      params: { query, type, limit }
    })
  },

  /**
   * 获取图片详情
   */
  async getImage(imageId: string) {
    return api.get(`/knowledge/images/${imageId}`)
  }
}

export default api
