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
  DEFAULT_TIMEOUT: 5000,        // 默认超时时间（毫秒）
} as const

// 后端 API 地址
const API_BASE_URL = getRuntimeConfig().apiBase || '/'

// 调试日志（通过 HTTP 发到后端，用于 WPS 插件调试）
let logQueue: Array<{ message: string; level: 'info' | 'warning' | 'error'; timestamp: number }> = []
let lastLogTime = 0

// 文档同步防抖
let lastSyncTimestamp = 0
let lastForceSyncTimestamp = 0

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
    
    // 批量发送日志
    const apiBase = getRuntimeConfig().apiBase || 'http://localhost:5123'
    const batchMessage = batchLogs.map(log => `[${new Date(log.timestamp).toLocaleTimeString()}] ${log.message}`).join('\n')
    
    axios.get(`${apiBase}/api/log`, {
      params: {
        message: `[BATCH:${batchLogs.length}] ${batchMessage.substring(0, 800)}`,
        level: 'info'
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
    timeout: MAGIC_NUMBERS.DEFAULT_TIMEOUT,
    headers: {
      'Content-Type': 'application/json'
    }
  })
}

/**
 * 同步所有 WPS 文档到后端（只同步元信息）
 */
export async function syncAllDocuments(documents: Array<{ doc: WPSDocumentInfo }>): Promise<boolean> {
  isSyncing.value = true
  syncError.value = null

  logToBackend('syncAllDocuments 开始同步，文档数: ' + documents.length)

  try {
    const client = getApiClient()
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

    logToBackend('syncAllDocuments 发送同步请求，文档数: ' + syncedDocs.length)

    const apiBase = getRuntimeConfig().apiBase || 'http://localhost:5123'
    await client.post(`${apiBase}/api/documents/sync`, {
      client_id: clientId,
      host_app: hostApp,
      documents: syncedDocs
    })

    lastSyncTime.value = new Date()
    lastSyncTimestamp = Date.now() // 更新防抖时间戳
    logToBackend('syncAllDocuments 同步成功: ' + syncedDocs.length + ' 个文档')
    return true
  } catch (error: any) {
    syncError.value = error.message || '同步失败'
    logToBackend('syncAllDocuments 同步失败: ' + error.message, 'error')
    return false
  } finally {
    isSyncing.value = false
  }
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
  if (now - lastForceSyncTimestamp < 1000) return false
  lastForceSyncTimestamp = now

  const inWps = wpsBridge.isInWPSEnvironment()
  if (!inWps) return false

  const wpsDocs = wpsBridge.getAllOpenDocuments()
  // Sync empty list too, so closing documents immediately clears the snapshot for this host.
  return syncAllDocuments(wpsDocs.map((doc) => ({ doc })))
}

/**
 * 检测 WPS 文档变化并同步
 */
export async function detectAndSync(): Promise<boolean> {
  const now = Date.now()

  // 防抖：10秒内不重复同步
  if (now - lastSyncTimestamp < MAGIC_NUMBERS.SYNC_INTERVAL) {
    logToBackend(`[SYNC-防抖] 跳过重复同步，距离上次同步: ${(now - lastSyncTimestamp)/1000}秒`)
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

  return syncAllDocuments(documents)
}
