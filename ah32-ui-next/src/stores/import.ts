/**
 * 导入状态管理
 * 管理RAG文档导入任务和文档列表
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { ragApi } from '@/services/rag-api'
import { wpsBridge } from '@/services/wps-bridge'
import { logger } from '@/utils/logger'

export interface ImportTask {
  id: string
  type: 'wps' | 'agent' | 'api' | 'reimport' | 'command' | 'atref'
  name: string
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  progress: number
  currentStep: string
  startTime: Date
  endTime?: Date
  error?: string
  result?: string
  params?: any
}

export interface RagDocument {
  name: string
  path: string
  displayPath?: string
  size: string
  importMethod: string
  importTime: string
  vectors: number
  hash?: string
  scope?: 'global' | 'project' | 'both' | 'unscoped'
  projectsCount?: number
}

export interface RagStatistics {
  totalDocuments: number
  totalVectors: number
  storageSize: string
  scopeProjectId?: string | null
  scopeProjectLabel?: string | null
  includeGlobal?: boolean
  globalDocuments?: number | null
  projectDocuments?: number | null
  importMethods: {
    wps: { count: number; name: string; icon: string }
    agent: { count: number; name: string; icon: string }
    api: { count: number; name: string; icon: string }
    command: { count: number; name: string; icon: string }
    atref: { count: number; name: string; icon: string }
  }
}

export const useImportStore = defineStore('import', () => {
  // 导入任务列表
  const tasks = ref<ImportTask[]>([])

  // Current scoped view for RAG listing/statistics (project + global by default).
  const scopeContext = ref<{ projectId?: string; contextDocumentPath?: string; includeGlobal: boolean }>({
    includeGlobal: true
  })

  // RAG文档统计
  const statistics = ref<RagStatistics>({
    totalDocuments: 0,
    totalVectors: 0,
    storageSize: '0 MB',
    importMethods: {
      wps: { count: 0, name: 'WPS同步导入', icon: '📄' },
      agent: { count: 0, name: '目录导入', icon: '🤖' },
      api: { count: 0, name: 'API集成导入', icon: '🔗' },
      command: { count: 0, name: '命令行导入', icon: '⌨️' },
      atref: { count: 0, name: '@引用导入', icon: '📎' }
    }
  })

  // RAG文档列表（按导入方式分组）
  const documents = ref<Array<{
    method: string
    name: string
    count: number
    documents: RagDocument[]
  }>>([])

  // 创建任务
  const createTask = (type: ImportTask['type'], params: any = {}): string => {
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const taskNames: Record<ImportTask['type'], string> = {
      'wps': 'WPS文档同步',
      'agent': '目录导入',
      'api': 'API集成导入',
      'reimport': '重新导入文档',
      'command': '命令行导入',
      'atref': '@引用导入'
    }

    const task: ImportTask = {
      id: taskId,
      type,
      name: taskNames[type],
      status: 'pending',
      progress: 0,
      currentStep: '等待执行',
      startTime: new Date(),
      params
    }

    tasks.value.unshift(task)
    return taskId
  }

  // 开始任务
  const startTask = (taskId: string) => {
    const task = tasks.value.find(t => t.id === taskId)
    if (task && task.status === 'pending') {
      task.status = 'running'
      task.currentStep = '开始执行'
      executeTask(task)
    }
  }

  // 暂停任务
  const pauseTask = (taskId: string) => {
    const task = tasks.value.find(t => t.id === taskId)
    if (task && task.status === 'running') {
      task.status = 'paused'
      task.currentStep = '已暂停'
    }
  }

  // 取消任务
  const cancelTask = (taskId: string) => {
    const task = tasks.value.find(t => t.id === taskId)
    if (task && task.status !== 'completed' && task.status !== 'failed') {
      task.status = 'cancelled'
      task.endTime = new Date()
      task.currentStep = '已取消'
      // 取消后端任务（best-effort）
      const backendTaskId = task.params?.backendTaskId
      if (backendTaskId) {
        ragApi.cancelImportTask(backendTaskId).catch((e) => { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/import.ts', e) })
      }
    }
  }

  // 执行任务
  const executeTask = async (task: ImportTask) => {
    try {
      if (task.type === 'wps') {
        await executeWpsTask(task)
      } else if (task.type === 'agent') {
        await executeAgentTask(task)
      } else if (task.type === 'api') {
        await executeApiTask(task)
      } else if (task.type === 'reimport') {
        await executeReimportTask(task)
      }
    } catch (error) {
      task.status = 'failed'
      task.error = error instanceof Error ? error.message : '未知错误'
      task.endTime = new Date()
    }
  }

  // SSE 在某些 WebView 环境里可能不稳定；当 SSE 断开时，退回到轮询查询任务状态，避免任务“卡住不动”。
  const startPollingFallback = (
    backendTaskId: string,
    applyState: (state: any) => Promise<void>,
    isTerminal: () => boolean,
    intervalMs: number = 1500
  ) => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let inFlight = false

    const loop = async () => {
      if (stopped || isTerminal()) return
      if (inFlight) {
        timer = setTimeout(loop, intervalMs)
        return
      }
      inFlight = true
      try {
        const resp = await ragApi.getImportTaskStatus(backendTaskId)
        if (resp?.success && resp.data) {
          await applyState(resp.data)
        }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/import.ts', e)
        // Ignore polling errors; keep retrying.
      } finally {
        inFlight = false
        if (!stopped && !isTerminal()) {
          timer = setTimeout(loop, intervalMs)
        }
      }
    }

    timer = setTimeout(loop, intervalMs)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    }
  }

  // WPS同步任务
  const executeWpsTask = async (task: ImportTask) => {
    try {
      task.currentStep = '正在同步WPS文档...'
      task.progress = 20

      // 如果任务指定了单个文档，则只导入该文档；否则导入全部已打开文档
      const wpsDocsAll = await getWpsDocuments()
      const requestedId = task.params?.documentId
      const wpsDocs = requestedId
        ? wpsDocsAll.filter(d => d.id === requestedId)
        : wpsDocsAll

      if (!wpsDocs || wpsDocs.length === 0) {
        throw new Error(requestedId ? '未找到要同步的文档' : '没有找到WPS文档')
      }

      // Remote backend may not read client-local paths. Preflight on the backend; if a path is not
      // readable, fall back to "upload-to-RAG" by extracting text via WPS JSAPI.
      const importDocs: any[] = []
      for (const d of wpsDocs) {
        const p = String(d?.path || '').trim()

        if (p) {
          try {
            const resp = await ragApi.validateDocumentPath(p)
            if (resp?.success && resp?.data?.valid) {
              importDocs.push({ path: p, name: d.name, importMethod: 'wps' })
              continue
            }
          } catch (e) {
            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/import.ts', e)
            // treat as unreadable and fall back to upload
          }
        }

        task.currentStep = `读取文档内容（上传入库）：${d.name}`
        // Upload-to-RAG should not truncate large documents. Keep chat-context bounded separately.
        const text = wpsBridge.extractDocumentTextById(String(d.id || '').trim(), { maxChars: 0 })
        if (!text || !text.trim()) {
          throw new Error(`无法读取文档内容用于上传入库：${d.name}\n提示：请先确保文档可编辑且包含文本内容。`)
        }
        importDocs.push({
          path: '',
          name: d.name,
          importMethod: 'wps',
          text,
          pathAlias: p || d.name
        })
      }

      if (importDocs.length === 0) {
        throw new Error('没有可入库的文档')
      }

      task.currentStep = `准备同步 ${importDocs.length} 个文档`
      task.progress = 40

      // 批量导入到RAG（后端异步任务 + SSE进度）
      task.currentStep = '提交入库任务...'
      task.progress = 45

      const results = await batchImportToRag(importDocs, {
        scope: 'project',
        contextDocumentPath: task.params?.documentPath || ''
      })
      const backendTaskId = results?.taskId
      if (!backendTaskId) {
        throw new Error('后端未返回taskId，无法跟踪入库进度')
      }
      task.params = { ...(task.params || {}), backendTaskId }

      // 订阅进度
      let stopStream: () => void = () => {}
      let stopPoll: () => void = () => {}
      let pollStarted = false
      const isTerminal = () => ['completed', 'failed', 'cancelled'].includes(task.status)

      const applyState = async (state: any) => {
        if (!state || task.status === 'cancelled') return
        task.currentStep = state.currentStep || task.currentStep
        task.progress = typeof state.progress === 'number' ? state.progress : task.progress

        if (state.status === 'completed') {
          task.status = 'completed'
          task.endTime = new Date()
          const summary = state.result
          task.result = summary
            ? `入库完成：成功 ${summary.successCount}，失败 ${summary.failedCount}，共 ${summary.totalCount}`
            : '入库完成'
          stopStream()
          stopPoll()
          try {
            await fetchDocumentsByMethod()
            await fetchRagStatistics()
          } catch (e) {
            logger.warn('[ImportStore] 完成后刷新RAG数据失败(忽略):', e)
          }
          return
        }

        if (state.status === 'failed') {
          task.status = 'failed'
          task.endTime = new Date()
          task.error = state.error || '入库失败'
          stopStream()
          stopPoll()
          return
        }

        if (state.status === 'cancelled') {
          task.status = 'cancelled'
          task.endTime = new Date()
          task.currentStep = '已取消'
          stopStream()
          stopPoll()
          return
        }

        task.status = 'running'
      }

      stopStream = ragApi.streamTask(
        backendTaskId,
        applyState,
        (e) => {
          logger.warn('[ImportStore] SSE连接失败，启用轮询兜底:', e)
          if (!pollStarted) {
            pollStarted = true
            stopPoll = startPollingFallback(backendTaskId, applyState, isTerminal)
          }
        }
      )

      // 返回后端taskId，供调用方使用（可选）
      return backendTaskId
    } catch (error) {
      task.status = 'failed'
      task.error = error instanceof Error ? error.message : '未知错误'
      task.endTime = new Date()
      throw error
    }
  }

  // 目录导入任务（目录扫描 -> 后端批量入库任务 -> SSE进度）
  const executeAgentTask = async (task: ImportTask) => {
    try {
      const files = task.params?.files
      const directory = task.params?.directory

      task.currentStep = '提交入库任务...'
      task.progress = 10

      let backendTaskId: string | null = null

      if (Array.isArray(files) && files.length > 0) {
        // Remote-friendly mode: upload selected folder/files to backend for ingestion.
        task.currentStep = `上传文件并入库（${files.length} 个文件）...`
        const resp = await ragApi.uploadFiles(files, { scope: 'global', importMethod: 'agent' })
        if (!resp.success) {
          throw new Error(resp.error || resp.message || '上传入库失败')
        }
        backendTaskId = resp.data?.taskId || null
      } else {
        if (!directory) throw new Error('未提供扫描目录')

        // Preflight: validate the backend can read this directory; otherwise the task will look
        // "started" but is doomed to fail in remote deployments.
        try {
          await ragApi.scanDirectory(String(directory), false, 1)
        } catch (e: any) {
          const msg = e?.response?.data?.detail || e?.message || String(e)
          throw new Error(`后端无法读取目录：${directory}\n原因：${msg}\n提示：若后端部署在远程机器，请配置共享路径或切换为“上传入库模式”。`)
        }

        // Backend will scan + ingest in a single async task and stream progress via SSE.
        const resp = await ragApi.batchImport(null, { directory, recursive: true, limit: 2000, importMethod: 'agent', scope: 'global' })
        if (!resp.success) {
          throw new Error(resp.error || resp.message || '批量导入失败')
        }
        backendTaskId = resp.data?.taskId || null
      }

      if (!backendTaskId) {
        throw new Error('后端未返回 taskId，无法跟踪入库进度')
      }

      task.params = { ...(task.params || {}), backendTaskId }

      let stopStream: () => void = () => {}
      let stopPoll: () => void = () => {}
      let pollStarted = false
      const isTerminal = () => ['completed', 'failed', 'cancelled'].includes(task.status)

      const applyState = async (state: any) => {
        if (!state || task.status === 'cancelled') return
        task.currentStep = state.currentStep || task.currentStep
        task.progress = typeof state.progress === 'number' ? state.progress : task.progress

        if (state.status === 'completed') {
          task.status = 'completed'
          task.endTime = new Date()
          const summary = state.result
          task.result = summary
            ? `入库完成：成功${summary.successCount}，失败${summary.failedCount}，共 ${summary.totalCount}`
            : '入库完成'
          stopStream()
          stopPoll()
          try {
            await fetchDocumentsByMethod()
            await fetchRagStatistics()
          } catch (e) {
            logger.warn('[ImportStore] 完成后刷新RAG数据失败(忽略):', e)
          }
          return
        }

        if (state.status === 'failed') {
          task.status = 'failed'
          task.endTime = new Date()
          task.error = state.error || '入库失败'
          stopStream()
          stopPoll()
          return
        }

        if (state.status === 'cancelled') {
          task.status = 'cancelled'
          task.endTime = new Date()
          task.currentStep = '已取消'
          stopStream()
          stopPoll()
          return
        }

        task.status = 'running'
      }

      stopStream = ragApi.streamTask(
        backendTaskId,
        applyState,
        (e) => {
          logger.warn('[ImportStore] SSE连接失败，启用轮询兜底:', e)
          if (!pollStarted) {
            pollStarted = true
            stopPoll = startPollingFallback(backendTaskId, applyState, isTerminal)
          }
        }
      )

      return backendTaskId
    } catch (error) {
      task.status = 'failed'
      task.error = error instanceof Error ? error.message : '未知错误'
      task.endTime = new Date()
      throw error
    }
  }

  const executeApiTask = async (task: ImportTask) => {
    try {
      task.currentStep = '连接API服务...'
      task.progress = 20

      // 调用API获取文档列表
      const apiDocuments = await fetchApiDocuments(task.params?.apiConfig)

      task.currentStep = `获取到 ${apiDocuments.length} 个文档`
      task.progress = 50

      // 下载并导入文档
      const importResults = await batchImportDocuments(apiDocuments)

      task.currentStep = '导入完成'
      task.progress = 100
      task.status = 'completed'
      task.result = `API导入完成，成功导入 ${importResults.successCount} 个文档`
      task.endTime = new Date()

      // 刷新文档列表
      await fetchDocumentsByMethod()
      await fetchRagStatistics()
    } catch (error) {
      task.status = 'failed'
      task.error = error instanceof Error ? error.message : '未知错误'
      task.endTime = new Date()
      throw error
    }
  }

  // 重新导入任务
  const executeReimportTask = async (task: ImportTask) => {
    try {
      const { documentPath, documentName } = task.params

      task.currentStep = '重新导入文档...'
      task.progress = 30

      // Preflight to avoid "started but doomed" in remote deployments.
      try {
        const resp = await ragApi.validateDocumentPath(String(documentPath || ''))
        if (resp?.success && resp.data && !resp.data.valid) {
          const reason = resp.data.error || '后端无法读取该路径'
          throw new Error(`后端无法读取文件路径：${documentPath}\n原因：${reason}`)
        }
      } catch (e: any) {
        const msg = e?.message || String(e)
        throw new Error(`${msg}\n提示：若后端部署在远程机器，请配置共享路径或切换为“上传入库模式”。`)
      }

      // 调用重新导入API
      const result = await ragApi.reimportDocument(documentPath, documentName)

      task.currentStep = '导入完成'
      task.progress = 100
      task.status = 'completed'
      task.result = result.message || '文档重新导入完成'
      task.endTime = new Date()

      // 刷新文档列表
      await fetchDocumentsByMethod()
      await fetchRagStatistics()
    } catch (error) {
      task.status = 'failed'
      task.error = error instanceof Error ? error.message : '未知错误'
      task.endTime = new Date()
      throw error
    }
  }

  // 辅助函数：获取WPS文档
  const getWpsDocuments = async () => {
    try {
      // 检查是否在WPS环境中
      if (!wpsBridge.isInWPSEnvironment()) {
        throw new Error('不在WPS环境中，无法获取文档')
      }

      // 获取WPS文档
      const wpsDocs = wpsBridge.getAllOpenDocuments()
      logger.info(`[ImportStore] 获取到 ${wpsDocs.length} 个WPS文档`)

      // 转换为标准格式
      return wpsDocs.map(doc => ({
        id: doc.id,
        name: doc.name,
        path: doc.fullPath || '',
        fullName: doc.fullPath || doc.name,
        isActive: doc.isActive || false,
        pageCount: doc.pageCount || 0,
        wordCount: doc.wordCount || 0
      }))
    } catch (error) {
      logger.error('[ImportStore] 获取WPS文档失败:', error)
      throw error
    }
  }

  // 辅助函数：批量导入到RAG
  const batchImportToRag = async (documents: any[], options?: { scope?: 'global' | 'project'; projectId?: string; contextDocumentPath?: string }) => {
    const payload = documents.map(doc => ({
      path: doc.path || '',
      name: doc.name,
      importMethod: doc.importMethod || 'wps',
      text: doc.text,
      pathAlias: doc.pathAlias
    }))

    logger.info(`[ImportStore] 批量导入到RAG: ${payload.length} 个文档`)
    const response = await ragApi.batchImport(payload, options)
    if (!response.success) {
      throw new Error(response.error || response.message || '批量导入失败')
    }
    return response.data || {}
  }

  // startAgentScan / batchImportDocuments 已由后端任务+SSE替代（避免前端固定超时）

  // 辅助函数：从API获取文档
  const fetchApiDocuments = async (apiConfig?: any) => {
    // TODO: 实现外部API集成
    // 调用外部API获取文档列表
    // 返回格式：[...]
    return []
  }

  // 获取RAG统计信息
  const fetchRagStatistics = async (ctx?: { projectId?: string; contextDocumentPath?: string; includeGlobal?: boolean }) => {
    try {
      if (ctx) scopeContext.value = { ...scopeContext.value, ...ctx, includeGlobal: ctx.includeGlobal ?? scopeContext.value.includeGlobal }
      const response = await ragApi.getStatistics(scopeContext.value)
      statistics.value = response.data
    } catch (error) {
      logger.error('获取RAG统计信息失败:', error)
      throw error
    }
  }

  // 按导入方式获取文档
  const fetchDocumentsByMethod = async (ctx?: { projectId?: string; contextDocumentPath?: string; includeGlobal?: boolean }) => {
    try {
      if (ctx) scopeContext.value = { ...scopeContext.value, ...ctx, includeGlobal: ctx.includeGlobal ?? scopeContext.value.includeGlobal }
      const response = await ragApi.getDocumentsByMethod(scopeContext.value)
      documents.value = response.data
    } catch (error) {
      logger.error('获取RAG文档列表失败:', error)
      throw error
    }
  }

  // 清空已完成的任务
  const clearCompletedTasks = () => {
    tasks.value = tasks.value.filter(t => t.status !== 'completed' && t.status !== 'failed' && t.status !== 'cancelled')
  }

  // 清空所有任务
  const clearAllTasks = () => {
    tasks.value = []
  }

  // 计算属性
  const runningTasks = computed(() => tasks.value.filter(t => t.status === 'running'))
  const pendingTasks = computed(() => tasks.value.filter(t => t.status === 'pending'))
  const completedTasks = computed(() => tasks.value.filter(t => t.status === 'completed'))

  return {
    // 状态
    tasks,
    statistics,
    documents,

    // 计算属性
    runningTasks,
    pendingTasks,
    completedTasks,

    // 方法
    createTask,
    startTask,
    pauseTask,
    cancelTask,
    fetchRagStatistics,
    fetchDocumentsByMethod,
    clearCompletedTasks,
    clearAllTasks
  }
})
