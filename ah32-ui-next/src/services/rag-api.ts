/**
 * RAG API服务
 * 管理RAG知识库的文档导入、查询、删除等操作
 */

import axios from 'axios'
import { getRuntimeConfig } from '@/utils/runtime-config'

// 后端API基础URL
const API_BASE_URL = getRuntimeConfig().apiBase || '/'
const DEBUG = import.meta.env.DEV || import.meta.env.VITE_DEBUG === 'true'

// 创建API客户端
const apiClient = axios.create({
  baseURL: API_BASE_URL,
  // RAG入库/解析可能较慢（尤其doc/docx），5s太容易超时
  timeout: 60000,
  headers: {
    'Content-Type': 'application/json'
  }
})

// 请求拦截器 - 添加调试信息
apiClient.interceptors.request.use(
  (config) => {
    if (DEBUG) console.log(`[RAG API] ${config.method?.toUpperCase()} ${config.url}`)
    return config
  },
  (error) => {
    console.error('[RAG API] Request error:', error)
    return Promise.reject(error)
  }
)

// 响应拦截器 - 处理错误并向用户显示
apiClient.interceptors.response.use(
  (response) => {
    if (DEBUG) console.log(`[RAG API] Success: ${response.status}`)
    // Backend统一返回 { success, data, error, message }；将 success=false 视为异常，
    // 避免调用方把 undefined/错误结构写入 store 导致 UI 崩溃。
    const data: any = response.data
    if (data && typeof data === 'object' && 'success' in data && data.success !== true) {
      const msg = data.error || data.message || data.detail || `请求失败 (${response.status})`
      return Promise.reject(new Error(msg))
    }
    return response
  },
  (error) => {
    // 向用户显示具体错误信息
    if (error.code === 'ECONNABORTED') {
      console.warn('[RAG API] Request timeout')
      return Promise.reject(new Error('请求超时：入库耗时较长，请稍后重试'))
    }

    const status = error.response?.status
    const detail = error.response?.data?.detail
    if (typeof detail === 'string' && detail.trim()) {
      return Promise.reject(new Error(detail))
    }

    if (status >= 500) {
      console.error('[RAG API] Server error:', status)
      return Promise.reject(new Error('服务器错误，请稍后重试'))
    }
    if (status === 404) {
      return Promise.reject(new Error('接口不存在或已变更（404）'))
    }
    if (status === 401) {
      return Promise.reject(new Error('认证失败，请检查API密钥'))
    }
    if (status === 403) {
      return Promise.reject(new Error('权限不足，请联系管理员'))
    }

    const msg =
      error.response?.data?.error ||
      error.response?.data?.message ||
      error.message ||
      '请求失败'
    return Promise.reject(new Error(msg))
  }
)

// RAG文档统计信息
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

// RAG文档信息
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

// 按导入方式分组的文档列表
export interface DocumentsByMethod {
  method: string
  name: string
  count: number
  documents: RagDocument[]
}

// API响应格式
export interface ApiResponse<T = any> {
  success: boolean
  data?: T
  error?: string
  message?: string
}

export const ragApi = {
  /**
   * 获取RAG文档统计信息
   */
  async getStatistics(params?: { projectId?: string; contextDocumentPath?: string; includeGlobal?: boolean }): Promise<ApiResponse<RagStatistics>> {
    const response = await apiClient.get('/api/rag/statistics', { params })
    return response.data
  },

  /**
   * 按导入方式获取文档列表
   */
  async getDocumentsByMethod(params?: { projectId?: string; contextDocumentPath?: string; includeGlobal?: boolean }): Promise<ApiResponse<DocumentsByMethod[]>> {
    const response = await apiClient.get('/api/rag/documents/by-method', { params })
    return response.data
  },

  /**
   * 删除RAG文档
   */
  async deleteDocument(documentPath: string): Promise<ApiResponse> {
    const response = await apiClient.delete('/api/rag/documents', {
      data: { documentPath }
    })
    return response.data
  },

  /**
   * 重新导入文档
   */
  async reimportDocument(documentPath: string, documentName: string): Promise<ApiResponse> {
    const response = await apiClient.post('/api/rag/documents/reimport', {
      documentPath,
      documentName
    })
    return response.data
  },

  /**
   * 获取所有RAG文档
   */
  async getAllDocuments(): Promise<ApiResponse<RagDocument[]>> {
    const response = await apiClient.get('/api/rag/documents')
    return response.data
  },

  /**
   * 搜索RAG文档
   */
  async searchDocuments(query: string, limit: number = 10): Promise<ApiResponse<any[]>> {
    const response = await apiClient.get('/api/rag/search', {
      params: { query, limit }
    })
    return response.data
  },

  /**
   * 获取文档详情
   */
  async getDocumentDetail(documentPath: string): Promise<ApiResponse<any>> {
    const response = await apiClient.get(`/api/rag/documents/detail`, {
      params: { documentPath }
    })
    return response.data
  },

  /**
   * 批量导入文档
   */
  async batchImport(documents: Array<{
    path: string
    name: string
    importMethod?: string
  }> | null, options?: { directory?: string; recursive?: boolean; limit?: number; importMethod?: string; scope?: 'global' | 'project'; projectId?: string; contextDocumentPath?: string }): Promise<ApiResponse<any>> {
    const payload: any = {}
    if (documents && Array.isArray(documents) && documents.length > 0) payload.documents = documents
    if (options?.directory) {
      payload.directory = options.directory
      payload.recursive = options.recursive ?? true
      payload.limit = options.limit ?? 2000
      payload.importMethod = options.importMethod ?? 'agent'
    }
    if (options?.scope) payload.scope = options.scope
    if (options?.projectId) payload.projectId = options.projectId
    if (options?.contextDocumentPath) payload.contextDocumentPath = options.contextDocumentPath
    const response = await apiClient.post('/api/rag/documents/batch-import', payload)
    return response.data
  },

  /**
   * 订阅导入任务进度（SSE，事件驱动，无需轮询）
   * 返回关闭函数
   */
  streamTask(taskId: string, onEvent: (data: any) => void | Promise<void>, onError?: (e: any) => void): () => void {
    const base = getRuntimeConfig().apiBase || 'http://127.0.0.1:5123'
    const url = `${base}/api/rag/tasks/${encodeURIComponent(taskId)}/stream`
    const es = new EventSource(url)

    es.addEventListener('task', (evt) => {
      try {
        const parsed = JSON.parse((evt as MessageEvent).data)
        Promise.resolve(onEvent(parsed)).catch((e) => onError?.(e))
      } catch (e) {
        onError?.(e)
      }
    })

    es.addEventListener('ping', () => {
      // keepalive
    })

    es.addEventListener('error', (evt) => {
      onError?.(evt)
      try { es.close() } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/rag-api.ts', e) }
    })

    return () => {
      try { es.close() } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/rag-api.ts', e) }
    }
  },

  /**
   * 获取导入任务状态
   */
  async getImportTaskStatus(taskId: string): Promise<ApiResponse<any>> {
    const response = await apiClient.get(`/api/rag/tasks/${taskId}`)
    return response.data
  },

  /**
   * 获取所有导入任务
   */
  async getAllImportTasks(): Promise<ApiResponse<any[]>> {
    const response = await apiClient.get('/api/rag/tasks')
    return response.data
  },

  /**
   * 取消导入任务
   */
  async cancelImportTask(taskId: string): Promise<ApiResponse> {
    const response = await apiClient.post(`/api/rag/tasks/${taskId}/cancel`)
    return response.data
  },

  /**
   * 清空RAG知识库
   */
  async clearKnowledgeBase(): Promise<ApiResponse> {
    const response = await apiClient.delete('/api/rag/knowledge-base')
    return response.data
  },

  /**
   * 获取知识库配置信息
   */
  async getKnowledgeBaseConfig(): Promise<ApiResponse<any>> {
    const response = await apiClient.get('/api/rag/config')
    return response.data
  },

  /**
   * 更新知识库配置
   */
  async updateKnowledgeBaseConfig(config: any): Promise<ApiResponse> {
    const response = await apiClient.put('/api/rag/config', config)
    return response.data
  },

  /**
   * 获取导入历史
   */
  async getImportHistory(limit: number = 50): Promise<ApiResponse<any[]>> {
    const response = await apiClient.get('/api/rag/history', {
      params: { limit }
    })
    return response.data
  },

  /**
   * 导出RAG文档
   */
  async exportDocuments(format: 'json' | 'csv' | 'xlsx' = 'json'): Promise<ApiResponse<any>> {
    const response = await apiClient.get('/api/rag/export', {
      params: { format },
      responseType: 'blob'
    })
    return response.data
  },

  /**
   * 验证文档路径
   */
  async validateDocumentPath(path: string): Promise<ApiResponse<{ valid: boolean; error?: string }>> {
    const response = await apiClient.post('/api/rag/validate-path', { path })
    return response.data
  },

  /**
   * 获取支持的文档格式
   */
  async getSupportedFormats(): Promise<ApiResponse<string[]>> {
    const response = await apiClient.get('/api/rag/supported-formats')
    return response.data
  },

  /**
   * 扫描目录
   */
  async scanDirectory(directory: string, recursive: boolean = true, limit: number = 200): Promise<ApiResponse<any>> {
    const response = await apiClient.post('/api/rag/scan', { directory, recursive, limit })
    return response.data
  },

  /**
   * Upload-to-RAG (text): remote-friendly import that does not require backend filesystem access.
   * Returns a taskId compatible with streamTask().
   */
  async uploadText(items: Array<{ name: string; text: string; pathAlias?: string; importMethod?: string; scope?: 'global' | 'project'; contextDocumentPath?: string | null }>): Promise<ApiResponse<any>> {
    const response = await apiClient.post('/api/rag/documents/upload-text', { items })
    return response.data
  },

  /**
   * Upload-to-RAG (files): multipart upload.
   * Returns a taskId compatible with streamTask().
   */
  async uploadFiles(files: File[], options?: { scope?: 'global' | 'project'; contextDocumentPath?: string | null; importMethod?: string }): Promise<ApiResponse<any>> {
    const form = new FormData()
    for (const f of files || []) form.append('files', f)
    form.append('scope', options?.scope || 'global')
    if (options?.contextDocumentPath) form.append('contextDocumentPath', options.contextDocumentPath)
    if (options?.importMethod) form.append('importMethod', options.importMethod)
    const response = await apiClient.post('/api/rag/documents/upload-files', form, {
      headers: { 'Content-Type': 'multipart/form-data' }
    })
    return response.data
  }
}

// 工具函数：处理API错误
export const handleRagApiError = (error: any): string => {
  if (error.response?.data?.error) {
    return error.response.data.error
  }
  if (error.response?.data?.message) {
    return error.response.data.message
  }
  if (error.message) {
    return error.message
  }
  return '未知错误'
}

// 工具函数：检查API响应是否成功
export const isRagApiSuccess = (response: ApiResponse): boolean => {
  return response.success === true
}
