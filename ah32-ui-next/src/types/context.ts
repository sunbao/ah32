/**
 * 简化的上下文类型定义
 * 替代复杂的context-perception.ts中的类型
 */

// 简化的文档上下文
export interface DocumentContext {
  document: {
    name: string
    path: string
    totalPages: number
    totalWords: number
  }
  cursor: {
    page: number
    line: number
    column: number
  }
  selection: {
    text: string
    hasSelection: boolean
  }
  currentSection: string
  timestamp: number
}

// 智能建议
export interface IntelligentSuggestion {
  type: 'structure' | 'style' | 'content'
  suggestion: string
  priority: 'low' | 'medium' | 'high'
}

// 质量分析
export interface QualityAnalysis {
  readabilityScore: number
  logicalFlow: number
  missingSections: string[]
  suggestedImprovements: string[]
}

// 简化的文档感知结果
export interface PerceptionResult {
  context: DocumentContext
  suggestions: IntelligentSuggestion[]
  quality: QualityAnalysis
}
