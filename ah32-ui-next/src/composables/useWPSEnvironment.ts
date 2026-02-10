/**
 * WPS 环境检测 Composable
 * 提供轻量级的 WPS 环境检测功能，遵循最小侵入原则
 */

import { ref, computed, onMounted, onUnmounted } from 'vue'
import { WPSHelper } from '@/services/wps-bridge'

// 环境检测状态类型
export interface WPSEnvironmentStatus {
  isDetected: boolean
  confidence: number  // 0-100%
  version: string | null
  retryCount: number
  lastChecked: Date | null
  error: string | null
}

// 环境检测选项
export interface DetectionOptions {
  maxRetries?: number
  retryDelay?: number
  enableAutoRetry?: boolean
}

export function useWPSEnvironment(options: DetectionOptions = {}) {
  const {
    maxRetries = 3,
    retryDelay = 1000,
    enableAutoRetry = false
  } = options

  // 响应式状态
  const isDetected = ref(false)
  const confidence = ref(0)
  const version = ref<string | null>(null)
  const retryCount = ref(0)
  const lastChecked = ref<Date | null>(null)
  const error = ref<string | null>(null)
  const isDetecting = ref(false)

  // 计算属性
  const detectionLevel = computed(() => {
    if (confidence.value >= 80) return 'high'
    if (confidence.value >= 50) return 'medium'
    if (confidence.value >= 20) return 'low'
    return 'none'
  })

  const canRetry = computed(() => {
    return retryCount.value < maxRetries && !isDetecting.value
  })

  // 延迟执行函数
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  // 环境检测核心逻辑（不包含状态管理）
  const performDetection = async (): Promise<boolean> => {
    try {
      // 基础检测：WPS Application 对象
      const hasApplication = WPSHelper.checkEnvironment()
      
      if (hasApplication) {
        // 获取版本信息
        const appVersion = WPSHelper.getVersion()
        version.value = appVersion
        
        // 计算置信度
        let detectedConfidence = 0
        
        // 基础检测：Application 对象存在 (50%)
        detectedConfidence += 50
        
        // 版本检测：能够获取版本信息 (30%)
        if (appVersion) {
          detectedConfidence += 30
        }
        
        // 功能检测：检查关键功能可用性 (20%)
        try {
          const documents = WPSHelper.getAllDocuments()
          if (documents && Array.isArray(documents)) {
            detectedConfidence += 20
          }
        } catch (err) {
          console.warn('WPS 功能检测失败:', err)
        }
        
        confidence.value = Math.min(detectedConfidence, 100)
        isDetected.value = detectedConfidence >= 50 // 50%以上置信度认为检测到
        retryCount.value = 0
        return true
      } else {
        confidence.value = Math.max(confidence.value - 10, 0)
        version.value = null
        isDetected.value = false
        return false
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '检测过程中发生未知错误'
      confidence.value = 0
      isDetected.value = false
      console.error('WPS 环境检测失败:', err)
      return false
    }
  }

  // 环境检测（避免状态卡住）
  const detectEnvironment = async (): Promise<boolean> => {
    isDetecting.value = true
    error.value = null
    lastChecked.value = new Date()

    try {
      const success = await performDetection()
      
      // 如果检测成功，立即重置重试计数
      if (success) {
        retryCount.value = 0
        return true
      }
      
      // 只有在未达到最大重试次数时才重试
      if (enableAutoRetry && retryCount.value < maxRetries) {
        retryCount.value++
        await delay(2000) // 2秒后重试
        
        const retrySuccess = await performDetection()
        
        // 重试成功后也要重置计数
        if (retrySuccess) {
          retryCount.value = 0
        }
        
        return retrySuccess
      }

      return success
    } catch (err) {
      console.error('检测过程出错:', err)
      return false
    } finally {
      // 无论如何都要清除loading状态
      isDetecting.value = false
    }
  }

  // 手动重试
  const retry = async (): Promise<boolean> => {
    // 如果正在检测中，不允许重试
    if (isDetecting.value) {
      return false
    }
    
    // 如果已经达到最大重试次数，重置计数器
    if (retryCount.value >= maxRetries) {
      retryCount.value = 0
    }
    
    retryCount.value++
    
    // 添加超时保护，防止一直卡在loading状态
    const timeoutPromise = new Promise<boolean>((_, reject) => {
      setTimeout(() => {
        reject(new Error('重试超时'))
      }, 10000) // 10秒超时
    })
    
    try {
      const result = await Promise.race([
        detectEnvironment(),
        timeoutPromise
      ])
      return result
    } catch (err) {
      // 超时或其他错误时，确保重置状态
      isDetecting.value = false
      throw err
    }
  }

  // 重置检测状态
  const reset = () => {
    isDetected.value = false
    confidence.value = 0
    version.value = null
    retryCount.value = 0
    lastChecked.value = null
    error.value = null
    isDetecting.value = false
  }

  // 获取状态信息
  const getStatus = (): WPSEnvironmentStatus => ({
    isDetected: isDetected.value,
    confidence: confidence.value,
    version: version.value,
    retryCount: retryCount.value,
    lastChecked: lastChecked.value,
    error: error.value
  })

  // 定期检测（已删除！改为事件驱动）
  // ❌ 不再使用 setInterval 定时器

  // 初始化时不自动检测，避免循环触发
  onMounted(() => {
    // 不自动检测，由用户手动触发
  })

  // 清理定时器（已删除定时器，无需清理）

  return {
    // 状态
    isDetected: readonly(isDetected),
    confidence: readonly(confidence),
    version: readonly(version),
    retryCount: readonly(retryCount),
    lastChecked: readonly(lastChecked),
    error: readonly(error),
    isDetecting: readonly(isDetecting),
    
    // 计算属性
    detectionLevel,
    canRetry,
    
    // 方法
    detectEnvironment,
    retry,
    reset,
    getStatus
    // ❌ startPeriodicDetection, stopPeriodicDetection 已删除（改为事件驱动）
  }
}

// 用于 readonly 包装
function readonly<T>(ref: any): { value: T } {
  return {
    get value() {
      return ref.value
    }
  }
}