/**
 * 会话状态管理
 */
import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import type { Session } from '@/services/types'
import { logger } from '@/utils/logger'
import { getRuntimeConfig } from '@/utils/runtime-config'
import { getClientId } from '@/utils/client-id'

export const useSessionStore = defineStore('session', () => {
  // 状态
  const sessions = ref<Session[]>([])
  const activeSessionId = ref<string | null>(null)
  // 缓存文档名到sessionId的映射，避免重复生成
  const documentSessionCache = ref<Map<string, string>>(new Map())

  // 计算属性
  const activeSession = computed(() => {
    return sessions.value.find(s => s.id === activeSessionId.value) || null
  })

  const sessionCount = computed(() => sessions.value.length)

  // 从 localStorage 加载会话
  const loadSessionsFromStorage = () => {
    try {
      // 检查 localStorage 是否可用
      if (typeof localStorage === 'undefined') {
        logger.warn('localStorage not available in this environment')
        return
      }
      const stored = localStorage.getItem('ah32_sessions')
      if (stored) {
        const parsed = JSON.parse(stored)
        sessions.value = parsed.map((s: any) => ({
          ...s,
          createdAt: new Date(s.createdAt),
          lastActivity: new Date(s.lastActivity),
          persisted: true
        }))
        // 激活第一个会话
        if (sessions.value.length > 0) {
          const firstSession = sessions.value[0]
          if (firstSession) {
            activeSessionId.value = firstSession.id
          }
        }
      }
    } catch (error) {
      logger.error('Failed to load sessions from storage:', error)
    }
  }

  // 保存会话到 localStorage
  const saveSessionsToStorage = () => {
    try {
      // 检查 localStorage 是否可用
      if (typeof localStorage === 'undefined') {
        return
      }
      localStorage.setItem('ah32_sessions', JSON.stringify(sessions.value))
    } catch (error) {
      logger.error('Failed to save sessions to storage:', error)
    }
  }

  // 监听会话变化，自动保存
  watch(sessions, saveSessionsToStorage, { deep: true })

  // 切换会话
  const switchSession = (sessionId: string) => {
    activeSessionId.value = sessionId
    // 更新最后活动时间
    const session = sessions.value.find(s => s.id === sessionId)
    if (session) {
      session.lastActivity = new Date()
    }
  }

  // 删除会话
  const deleteSession = (sessionId: string) => {
    const index = sessions.value.findIndex(s => s.id === sessionId)
    if (index !== -1) {
      sessions.value.splice(index, 1)
      if (activeSessionId.value === sessionId) {
        activeSessionId.value = sessions.value[0]?.id || null
      }
    }
  }

  // 重命名会话
  const renameSession = (sessionId: string, newTitle: string) => {
    const session = sessions.value.find(s => s.id === sessionId)
    if (session) {
      session.title = newTitle
    }
  }

  // 清理过期会话
  const cleanExpiredSessions = (days: number = 30) => {
    const now = new Date()
    const threshold = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)

    sessions.value = sessions.value.filter(session => {
      return session.lastActivity > threshold
    })
  }

  // 获取会话统计
  const getSessionStats = (sessionId: string) => {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return null

    const now = new Date()
    const created = session.createdAt
    const lastActivity = session.lastActivity

    return {
      messageCount: 0, // 这里可以结合消息 store 计算
      duration: now.getTime() - created.getTime(),
      isActive: now.getTime() - lastActivity.getTime() < 5 * 60 * 1000 // 5分钟内有活动
    }
  }

  type DocumentIdentity = {
    name?: string
    path?: string
    id?: string
    hostApp?: string
  }

  // Session ID生成（稳定：优先基于文档路径；后端会进一步用文件唯一标识保证重命名/移动稳定）
  const generateSessionIdFromBackend = async (doc?: string | DocumentIdentity): Promise<string> => {
    const documentName = typeof doc === 'string' ? doc : (doc?.name || '')
    const documentPath = typeof doc === 'string' ? '' : (doc?.path || '')
    const documentId = typeof doc === 'string' ? '' : (doc?.id || '')
    const hostApp = typeof doc === 'string' ? '' : (doc?.hostApp || '')
    const cacheKey = `${String(hostApp || '').trim()}|${(documentPath || documentName || documentId).trim()}`

    if (!cacheKey) {
      const tempSessionId = `temp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
      logger.warn('无法生成 sessionId：缺少文档身份信息，使用临时ID:', tempSessionId)
      return tempSessionId
    }

    // 检查缓存
    const cachedSessionId = documentSessionCache.value.get(cacheKey)
    if (cachedSessionId) {
      return cachedSessionId
    }

    // 调用后端生成
    try {
      const cfg = getRuntimeConfig()
      const clientId = getClientId()
      const response = await fetch(`${cfg.apiBase}/agentic/session/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {})
        },
        body: JSON.stringify({
          client_id: clientId || undefined,
          document_name: documentName,
          document_path: documentPath,
          document_id: documentId,
          host_app: hostApp,
          timestamp: Date.now()
        })
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const data = await response.json()
      const sessionId = data.session_id

      // 存入缓存（同一个 sessionId 可能对应多个 cacheKey，例如重命名后的新路径）
      documentSessionCache.value.set(cacheKey, sessionId)
      return sessionId
    } catch (error) {
      // 生成失败时使用临时ID
      const tempSessionId = `temp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
      logger.warn('Session ID生成失败，使用临时ID:', tempSessionId)
      return tempSessionId
    }
  }

  // 初始化
  loadSessionsFromStorage()

  return {
    // 状态
    sessions,
    activeSessionId,
    activeSession,
    sessionCount,
    documentSessionCache,

    // 方法
    switchSession,
    deleteSession,
    renameSession,
    cleanExpiredSessions,
    getSessionStats,
    loadSessionsFromStorage,
    saveSessionsToStorage,
    generateSessionIdFromBackend
  }
})
