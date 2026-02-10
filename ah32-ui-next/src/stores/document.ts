/**
 * 文档状态管理
 * - 管理当前打开的文档列表（后端聚合 wps/et/wpp，再按 client_id + TTL 过滤）。
 * - 写入/执行的对象始终是“当前活动文档”，不再暴露“目标/参考文档”的概念，避免用户混淆。
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { wpsBridge, type WPSDocumentInfo } from '@/services/wps-bridge'
import { logger } from '@/utils/logger'

// 延迟导入，避免循环依赖
let logToBackend: (msg: string, level?: 'info' | 'warning' | 'error') => void = () => {}

const initDocumentSync = () => {
  import('../services/document-sync').then(module => {
    logToBackend = module.logToBackend
  }).catch((e) => { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/document.ts', e) })
}

initDocumentSync()

export interface DocumentState {
  id: string
  name: string
  fullName: string
  path: string
  isActive: boolean
  hostApp?: string
  type?: 'local' | 'network'
  url?: string
  permission?: 'read' | 'write' | 'none'
}

export const useDocumentStore = defineStore('document', () => {
  // 文档列表
  const documents = ref<DocumentState[]>([])

  // 加载状态
  const isLoading = ref(false)

  // 是否在 WPS 环境中
  const isInWPS = ref(false)


  const activeDocument = computed(() => documents.value.find(d => d.isActive) || null)

  // 刷新文档列表
  const refreshDocuments = async () => {
    isLoading.value = true
    try {
      // 检查WPS环境，添加错误处理
      isInWPS.value = wpsBridge.isInWPSEnvironment()

      if (!isInWPS.value) {
        documents.value = []
        return
      }

      // 安全获取文档列表，添加错误处理
      let docs: any[] = []
      try {
        // Prefer backend-aggregated union (cross-host) but scoped to this client_id + TTL filtered.
        const sync = await import('../services/document-sync')
        await sync.syncOpenDocumentsNow()
        docs = await sync.getSyncedDocuments()
        logger.info(`刷新文档列表(聚合): 发现 ${docs.length} 个文档`)
      } catch (error) {
        logger.warn('获取聚合文档列表失败，回退到本地列表:', error)
        try {
          docs = wpsBridge.getAllOpenDocuments()
          logger.info(`刷新文档列表(本地): 发现 ${docs.length} 个文档`)
        } catch (e2) {
          logger.error('获取文档列表失败:', e2)
          documents.value = []
          return
        }
      }

      // 安全处理文档数据，添加错误处理
      try {
        documents.value = docs.map(doc => ({
          id: doc.id,
          name: doc.name,
          fullName: doc.path || doc.fullPath || doc.name,
          path: doc.path || doc.fullPath || doc.name,
          isActive: !!doc.isActive,
          hostApp: doc.hostApp
        }))
      } catch (error) {
        logger.error('处理文档数据失败:', error)
        documents.value = []
        return
      }

      // 同步到后端，添加错误处理
      if (documents.value.length > 0) {
        logger.info('开始同步文档到后端...')
        syncToBackend().catch(error => {
          logger.error('同步文档到后端失败:', error)
        })
      }
    } catch (error) {
      logger.error('刷新文档列表失败:', error)
      documents.value = []
    } finally {
      isLoading.value = false
    }
  }

  // 同步文档到后端
  const syncToBackend = async () => {
    try {
      const sync = await import('../services/document-sync')
      await sync.syncOpenDocumentsNow()
    } catch (error) {
      logger.error('同步文档到后端失败:', error)
    }
  }


  // 尝试激活某个文档（不同宿主 API 差异较大，这里尽力而为）
  const activateDocument = async (docId: string) => {
    try {
      const ok = await wpsBridge.activateDocumentById(docId)
      if (!ok) {
        logger.warn(`[document] activateDocumentById failed: ${docId}`)
      }
    } finally {
      // 给宿主切换一点时间，再刷新列表（否则 isActive 可能还是旧值）
      setTimeout(() => {
        refreshDocuments().catch((e) => { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/document.ts', e) })
      }, 150)
      syncToBackend().catch((e) => { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/document.ts', e) })
    }
  }

  // 初始化
  const init = async () => {
    await refreshDocuments()
  }

  return {
    // 状态
    documents,
    isLoading,
    isInWPS,

    // 计算属性
    activeDocument,

    // 方法
    refreshDocuments,
    activateDocument,
    syncToBackend,
    init
  }
})
