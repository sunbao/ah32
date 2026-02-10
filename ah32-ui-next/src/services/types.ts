/**
 * 阿蛤 前端类型定义
 */

// 消息类型
export interface Message {
  id: string
  type: 'user' | 'assistant' | 'thinking'
  content: string
  timestamp: Date
  thinking?: string // 思考内容（DeepSeek 模式）
  isSystem?: boolean // 系统消息标记
  metadata?: Record<string, any> // 元数据（用于操作记录等）
}

// 会话类型
export interface Session {
  id: string
  title: string
  createdAt: Date
  lastActivity: Date
  persisted?: boolean
}

// 文档类型
export interface Document {
  name: string
  size: number
  type: string
  content: string
  status: 'analyzing' | 'completed' | 'error'
  path?: string
}

// 图片类型
export interface ImageResult {
  id: string
  url: string
  path: string
  relevance: number
  metadata?: Record<string, any>
}

// API 响应类型
export interface ApiResponse<T = any> {
  success: boolean
  data?: T
  error?: string
  message?: string
}

// SSE 事件类型
export interface SSEEvent {
  type: 'thinking' | 'reasoning' | 'rag' | 'skills' | 'start' | 'content' | 'done' | 'error'
  data: any
}

// 聊天状态类型
export interface ChatState {
  messages: Message[]
  isThinking: boolean
  isSending: boolean
  currentSessionId: string | null
}

// 写入模式类型
export type WriteMode = 'cursor' | 'replace' | 'append'

// 写入配置类型
export interface WriteConfig {
  mode: WriteMode
  autoInsertImages: boolean
  imageCount: number
}

// WPS 文档操作类型
export interface WPSOperation {
  type: 'text' | 'image' | 'page_break'
  content: string
  position?: number
  width?: number
  height?: number
}
