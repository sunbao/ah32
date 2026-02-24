/**
 * 文档同步服务
 * 将前端 WPS 文档状态同步到后端（只同步元信息，不读取内容）
 */

import axios from 'axios'
import { wpsBridge, type WPSDocumentInfo } from './wps-bridge'
import { ref } from 'vue'
import { getRuntimeConfig } from '@/utils/runtime-config'
import { getClientId } from '@/utils/client-id'
import { setLogToBackend } from '@/utils/logger'

// Magic Numbers常量定义
const MAGIC_NUMBERS = {
  MAX_QUEUE_SIZE: 50,           // 最大队列长度
  LOG_INTERVAL: 1000,           // 限制日志发送间隔为1秒
  SYNC_INTERVAL: 10000,         // 10秒内不重复同步
  DEFAULT_TIMEOUT: 8000,        // 默认超时时间（毫秒）
  FORCE_TIMEOUT: 12000,         // 强制同步超时时间（毫秒）
  BACKOFF_BASE_MS: 1500,        // 同步失败退避基数（毫秒）
  BACKOFF_MAX_MS: 60000,        // 同步失败退避上限（毫秒）
  BACKOFF_LOG_INTERVAL_MS: 15000, // 退避跳过日志最小间隔（毫秒）
} as const

// 后端 API 地址
const API_BASE_URL = getRuntimeConfig().apiBase || '/'

// 调试日志（通过 HTTP 发到后端，用于 WPS 插件调试）
let logQueue: Array<{ message: string; level: 'info' | 'warning' | 'error'; timestamp: number }> = []
let lastLogTime = 0

// 文档同步防抖
let lastSyncAttemptTimestamp = 0
let lastForceSyncAttemptTimestamp = 0

// 同步单飞 + 抖动退避（避免 WPS WebView/网络波动导致刷爆请求和日志）
let syncInFlight: Promise<boolean> | null = null
let syncPendingDocs: Array<{ doc: WPSDocumentInfo }> | null = null
let syncBackoffUntil = 0
let syncFailureStreak = 0
let lastBackoffLogAt = 0
let lastSyncedSignature = ''
let lastSyncSucceededAt = 0

const getDocSyncTimeoutMs = (force: boolean): number => {
  try {
    const raw = Number((import.meta as any)?.env?.VITE_DOC_SYNC_TIMEOUT_MS)
    if (Number.isFinite(raw) && raw > 0) {
      return Math.min(60000, Math.max(1000, Math.round(raw)))
    }
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/document-sync.ts', e)
  }
  return force ? MAGIC_NUMBERS.FORCE_TIMEOUT : MAGIC_NUMBERS.DEFAULT_TIMEOUT
}

const coerceErrorMessage = (error: unknown): string => {
  try {
    if (error instanceof Error) return String(error.message || error.name || 'Error')
    const msg = (error as any)?.message
    if (typeof msg === 'string' && msg.trim()) return msg
    if (typeof error === 'string') return error
    if (error && typeof error === 'object') {
      try { return JSON.stringify(error) } catch (_e) { return '[object ErrorPayload]' }
    }
    return String(error)
  } catch (_e) {
    return 'unknown error'
  }
}

const describeAxiosError = (error: unknown): { kind: string; message: string; code?: string; status?: number } => {
  try {
    if (!axios.isAxiosError(error)) {
      return { kind: 'error', message: coerceErrorMessage(error) }
    }

    const message = coerceErrorMessage(error)
    const code = typeof error.code === 'string' ? error.code : undefined
    const status = typeof error.response?.status === 'number' ? error.response.status : undefined
    const kind = (
      code === 'ECONNABORTED' || /\btimeout\b/i.test(message)
        ? 'timeout'
        : (status ? `http_${status}` : (code || 'network'))
    )
    return { kind, message, code, status }
  } catch (e) {
    return { kind: 'error', message: coerceErrorMessage(e) }
  }
}

const computeDocsSignature = (documents: Array<{ doc: WPSDocumentInfo }>): string => {
  try {
    const stableKey = (d: WPSDocumentInfo) => {
      const h = String(d.hostApp || '')
      const p = String((d as any).fullPath || (d as any).fullName || '')
      const id = String(d.id || '')
      const n = String(d.name || '')
      const a = d.isActive ? '1' : '0'
      return `${h}|${p}|${id}|${n}|${a}`
    }
    return documents
      .map(({ doc }) => stableKey(doc))
      .sort((a, b) => a.localeCompare(b))
      .join(';;')
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/document-sync.ts', e)
    return String(Date.now())
  }
}

export function logToBackend(message: string, level: 'info' | 'warning' | 'error' = 'info') {
  // Convention: always forward logs to backend (throttled/batched below) so WPS issues remain traceable.

  const now = Date.now()
  
  // ✅ 修复：限制队列大小，防止内存泄漏
  if (logQueue.length >= MAGIC_NUMBERS.MAX_QUEUE_SIZE) {
    // 丢弃最旧的日志，而不是无限累积
    logQueue.shift()
  }
  
  // 添加到队列
  logQueue.push({ message, level, timestamp: now })
  
  // 检查是否需要发送（防抖）
  if (now - lastLogTime >= MAGIC_NUMBERS.LOG_INTERVAL && logQueue.length > 0) {
    const batchLogs = logQueue.splice(0, logQueue.length)
    lastLogTime = now
    
    const batchLevel = batchLogs.some((l) => l.level === 'error')
      ? 'error'
      : (batchLogs.some((l) => l.level === 'warning') ? 'warning' : 'info')

    // 批量发送日志
    const apiBase = getRuntimeConfig().apiBase || 'http://localhost:5123'
    const batchMessage = batchLogs
      .map(log => `[${new Date(log.timestamp).toLocaleTimeString()}] [${log.level.toUpperCase()}] ${log.message}`)
      .join('\n')
    
    axios.get(`${apiBase}/api/log`, {
      params: {
        message: `[BATCH:${batchLogs.length}] ${batchMessage.substring(0, 800)}`,
        level: batchLevel
      },
      timeout: 3000
    }).catch((error) => {
      // Best-effort: log failures should never crash the taskpane.
      console.warn('[LogToBackend] 发送日志失败:', error.message)
    })
  }
}

// 同步的文档信息（不含内容）
export interface SyncedDocument {
  id: string
  name: string
  path: string
  isActive: boolean
  hostApp?: string
  pageCount: number
  wordCount: number
}

// Register backend logger for global error reporting (best-effort).
setLogToBackend(logToBackend)

// 同步状态
export const isSyncing = ref(false)
export const lastSyncTime = ref<Date | null>(null)
export const syncError = ref<string | null>(null)

// 文档类型自动检测规则
// TODO: 根据实际需求定义文档分类规则
// const DOC_TYPE_PATTERNS = { ... }

/**
 * 自动检测文档类型
 */
// export function detectDocType(docName: string): string {
//   // TODO: 实现文档类型检测逻辑
//   return 'general'
// }

/**
 * 获取后端 API 客户端
 */
function getApiClient() {
  return axios.create({
    baseURL: API_BASE_URL,
    timeout: getDocSyncTimeoutMs(false),
    headers: {
      'Content-Type': 'application/json'
    }
  })
}

/**
 * 同步所有 WPS 文档到后端（只同步元信息）
 */
export async function syncAllDocuments(
  documents: Array<{ doc: WPSDocumentInfo }>,
  opts?: { force?: boolean; reason?: string }
): Promise<boolean> {
  const reason = String(opts?.reason || 'unknown').slice(0, 80)
  const force = !!opts?.force
  const now = Date.now()

  // Coalesce concurrent callers.
  if (syncInFlight) {
    syncPendingDocs = documents
    return syncInFlight
  }

  // Backoff on repeated failures (network jitter, backend restarts, WPS WebView stalls).
  // Forced sync (e.g. @ list / manual refresh) bypasses backoff so the UI can recover faster.
  if (!force && now < syncBackoffUntil) {
    const waitMs = syncBackoffUntil - now
    if (now - lastBackoffLogAt >= MAGIC_NUMBERS.BACKOFF_LOG_INTERVAL_MS) {
      lastBackoffLogAt = now
      logToBackend(`syncAllDocuments 跳过：backoff=${waitMs}ms streak=${syncFailureStreak} reason=${reason}`, 'warning')
    }
    // Update attempt timestamp so detectAndSync won't spin.
    lastSyncAttemptTimestamp = now
    return false
  }

  isSyncing.value = true
  syncError.value = null
  lastSyncAttemptTimestamp = now

  const signature = computeDocsSignature(documents)
  const startedAt = Date.now()

  logToBackend(`syncAllDocuments 开始同步(reason=${reason})，文档数: ${documents.length}`)

  syncInFlight = (async () => {
    try {
      const client = axios.create({
        baseURL: API_BASE_URL,
        timeout: getDocSyncTimeoutMs(force),
        headers: { 'Content-Type': 'application/json' }
      })
      const clientId = getClientId()
      const hostApp = wpsBridge.getHostApp()

      // 只同步元信息，不读取内容
      // path 使用 fullName（完整路径），便于后端直接读取
      const syncedDocs = documents.map(({ doc }) => ({
        id: doc.id,
        name: doc.name,
        path: doc.fullPath || doc.name,
        isActive: doc.isActive,
        hostApp: doc.hostApp || hostApp,
        pageCount: doc.pageCount,
        wordCount: doc.wordCount
      }))

      logToBackend(`syncAllDocuments 发送同步请求，文档数: ${syncedDocs.length}`)

      const apiBase = getRuntimeConfig().apiBase || 'http://localhost:5123'
      await client.post(`${apiBase}/api/documents/sync`, {
        client_id: clientId,
        host_app: hostApp,
        documents: syncedDocs
      })

      lastSyncTime.value = new Date()
      lastSyncedSignature = signature
      lastSyncSucceededAt = Date.now()
      syncFailureStreak = 0
      syncBackoffUntil = 0

      const elapsed = Date.now() - startedAt
      logToBackend(`syncAllDocuments 同步成功: ${syncedDocs.length} 个文档（${elapsed}ms）`)
      return true
    } catch (error: any) {
      const d = describeAxiosError(error)
      syncError.value = d.message || '同步失败'

      syncFailureStreak += 1
      const pow = Math.min(6, Math.max(0, syncFailureStreak - 1))
      const jitter = Math.floor(Math.random() * 400)
      const backoffMs = Math.min(
        MAGIC_NUMBERS.BACKOFF_MAX_MS,
        Math.max(MAGIC_NUMBERS.BACKOFF_BASE_MS, MAGIC_NUMBERS.BACKOFF_BASE_MS * Math.pow(2, pow)) + jitter
      )
      syncBackoffUntil = Date.now() + backoffMs

      const elapsed = Date.now() - startedAt
      logToBackend(
        `syncAllDocuments 同步失败(kind=${d.kind} code=${d.code || ''} status=${d.status || ''}) `
          + `streak=${syncFailureStreak} backoff_ms=${backoffMs} elapsed_ms=${elapsed} reason=${reason} msg=${d.message}`,
        'warning'
      )
      return false
    } finally {
      isSyncing.value = false

      const pending = syncPendingDocs
      syncPendingDocs = null
      syncInFlight = null

      // If new callers arrived mid-flight, try once more (coalesced) when not in backoff.
      if (pending) {
        const pendingSig = computeDocsSignature(pending)
        const shouldResync = pendingSig !== lastSyncedSignature || (Date.now() - lastSyncSucceededAt) > 2000
        if (shouldResync && Date.now() >= syncBackoffUntil) {
          setTimeout(() => {
            syncAllDocuments(pending, { force: false, reason: `coalesced:${reason}` }).catch((e) => {
              ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/document-sync.ts', e)
            })
          }, 0)
        }
      }
    }
  })()

  return syncInFlight
}

/**
 * 从后端获取同步的文档列表
 */
export async function getSyncedDocuments(): Promise<SyncedDocument[]> {
  try {
    const client = getApiClient()
    const response = await client.get('/api/documents', { params: { client_id: getClientId() } })
    return response.data.documents || []
  } catch (error) {
    console.error('[DocumentSync] 获取同步文档失败:', error)
    return []
  }
}

/**
 * 清空后端的文档列表
 */
export async function clearSyncedDocuments(): Promise<boolean> {
  try {
    const client = getApiClient()
    await client.post('/api/documents/clear', undefined, { params: { client_id: getClientId() } })
    return true
  } catch (error) {
    console.error('[DocumentSync] 清空文档失败:', error)
    return false
  }
}

/**
 * Force sync without the 10s debounce (used by doc-change watcher / @ list).
 * Includes a small 1s guard to avoid spamming the backend.
 */
export async function syncOpenDocumentsNow(): Promise<boolean> {
  const now = Date.now()
  if (now - lastForceSyncAttemptTimestamp < 1000) return false
  lastForceSyncAttemptTimestamp = now

  const inWps = wpsBridge.isInWPSEnvironment()
  if (!inWps) return false

  const wpsDocs = wpsBridge.getAllOpenDocuments()
  // Sync empty list too, so closing documents immediately clears the snapshot for this host.
  return syncAllDocuments(wpsDocs.map((doc) => ({ doc })), { force: true, reason: 'sync_open_documents_now' })
}

/**
 * 检测 WPS 文档变化并同步
 */
export async function detectAndSync(): Promise<boolean> {
  const now = Date.now()

  // 防抖：10秒内不重复同步
  if (now - lastSyncAttemptTimestamp < MAGIC_NUMBERS.SYNC_INTERVAL) {
    logToBackend(`[SYNC-防抖] 跳过重复同步，距离上次同步: ${(now - lastSyncAttemptTimestamp)/1000}秒`)
    return false
  }

  logToBackend('detectAndSync called')

  const inWps = wpsBridge.isInWPSEnvironment()
  logToBackend('isInWPSEnvironment: ' + inWps)
  logToBackend('window.Application: ' + !!(window as any).Application)

  if (!inWps) {
    logToBackend('不在 WPS 环境，跳过同步', 'warning')
    return false
  }

  const wpsDocs = wpsBridge.getAllOpenDocuments()
  logToBackend('getAllOpenDocuments count: ' + wpsDocs.length)

  if (wpsDocs.length === 0) {
    logToBackend('没有打开的文档，跳过同步', 'warning')
    return false
  }

  const documents: Array<{ doc: WPSDocumentInfo }> = []

  for (const wpsDoc of wpsDocs) {
    documents.push({ doc: wpsDoc })
  }

  return syncAllDocuments(documents, { force: false, reason: 'detect_and_sync' })
}
