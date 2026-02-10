<template>
  <!-- 紧凑版WPS状态指示器 -->
  <div class="wps-status-indicator" :class="statusClass">
    <el-tooltip :content="tooltipContent" placement="top">
      <div class="status-dot">
        <el-icon :size="14" class="status-icon">
          <CircleCheck v-if="wpsConnected && backendConnected" class="success-icon" />
          <WarningFilled v-else-if="wpsConnected || backendConnected" class="warning-icon" />
          <Close v-else class="error-icon" />
        </el-icon>
      </div>
    </el-tooltip>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import {
  CircleCheck,
  WarningFilled,
  Close
} from '@element-plus/icons-vue'
import { getRuntimeConfig } from '@/utils/runtime-config'

interface Props {
  compact?: boolean
  maxRetries?: number
  backendUrl?: string
}

const props = withDefaults(defineProps<Props>(), {
  compact: false,
  maxRetries: 3,
  backendUrl: () => getRuntimeConfig().apiBase || 'http://127.0.0.1:5123'
})

const emit = defineEmits<{
  statusChange: [status: boolean, confidence: number]
  error: [error: string]
}>()

// 状态
const wpsConnected = ref(false)
const backendConnected = ref(false)
const lastCheckTime = ref<Date | null>(null)
const wpsConfidence = ref(0)

// 真实的WPS检测
const checkWPSConnection = async () => {
  try {
    // 检测WPS Application对象
    const hasWPS = typeof (window as any).WPS !== 'undefined' || 
                   typeof (window as any).wps !== 'undefined' ||
                   typeof (window as any).wpsApplication !== 'undefined'
    
    wpsConnected.value = hasWPS
    
    if (hasWPS) {
      wpsConfidence.value = 100 // 有WPS环境就认为是高置信度
    } else {
      wpsConfidence.value = 0
    }
    
    emit('statusChange', hasWPS, wpsConfidence.value)
  } catch (error) {
    wpsConnected.value = false
    wpsConfidence.value = 0
    emit('error', 'WPS检测失败')
  }
}

// 后端状态检测
const checkBackendConnection = async () => {
  const startTime = Date.now()
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 3000)

    const response = await fetch(`${props.backendUrl}/api/documents`, {
      method: 'GET',
      signal: controller.signal
    })

    clearTimeout(timeoutId)
    backendConnected.value = response.ok
    
    if (!response.ok) {
      emit('error', `后端连接失败: HTTP ${response.status}`)
    }
  } catch (error) {
    backendConnected.value = false
    if (error instanceof Error && error.name === 'AbortError') {
      emit('error', '后端连接超时')
    } else {
      emit('error', '后端连接失败')
    }
  } finally {
    lastCheckTime.value = new Date()
  }
}

// 计算属性
const statusClass = computed(() => {
  let statusType = 'status-error' // 默认红色
  
  if (wpsConnected.value && backendConnected.value) {
    statusType = 'status-success' // 绿色
  } else if (wpsConnected.value || backendConnected.value) {
    statusType = 'status-warning' // 黄色
  }
  
  return {
    [statusType]: true,
    'compact': props.compact
  }
})

const tooltipContent = computed(() => {
  const wpsText = wpsConnected.value ? 'WPS已连接' : 'WPS未连接'
  const backendText = backendConnected.value ? '后端已连接' : '后端未连接'
  
  if (!lastCheckTime.value) {
    return `${wpsText} | ${backendText}`
  }
  
  const now = new Date()
  const diff = now.getTime() - lastCheckTime.value.getTime()
  const seconds = Math.floor(diff / 1000)
  
  if (seconds < 5) {
    return `${wpsText} | ${backendText} (刚刚检查)`
  } else if (seconds < 60) {
    return `${wpsText} | ${backendText} (${seconds}秒前检查)`
  } else {
    const minutes = Math.floor(seconds / 60)
    return `${wpsText} | ${backendText} (${minutes}分钟前检查)`
  }
})

// 启动检测
onMounted(() => {
  // 初始检测
  checkWPSConnection()
  checkBackendConnection()

  // 不使用定时器！改为事件驱动
  console.log('[WPSEnvironmentStatus] ✅ 已删除定时器，使用事件驱动')
})

// 清理
onUnmounted(() => {
  // 无需清理定时器（已删除）
})
</script>

<style scoped>
.wps-environment-status {
  background: #f5f7fa;
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  padding: 12px;
  font-size: 13px;
  transition: all 0.3s ease;
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-indicator.compact {
  gap: 6px;
  padding: 8px;
}

.status-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  flex-shrink: 0;
}

.connection-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  flex-shrink: 0;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  background: white;
}

.connection-icon .connected {
  color: #22c55e;
}

.connection-icon .disconnected {
  color: #ef4444;
}

.status-indicator.status-detected .status-icon {
  background: #f0f9ff;
  color: #409eff;
}

.status-indicator.status-high .status-icon {
  background: #f0fdf4;
  color: #22c55e;
}

.status-indicator.status-medium .status-icon {
  background: #fefce8;
  color: #eab308;
}

.status-indicator.status-low .status-icon {
  background: #fef2f2;
  color: #ef4444;
}

.status-indicator.status-none .status-icon {
  background: #f9fafb;
  color: #9ca3af;
}

.status-content {
  flex: 1;
  min-width: 0;
}

.status-text {
  font-weight: 500;
  color: #303133;
  line-height: 1.4;
}

.status-detail {
  font-size: 12px;
  color: #909399;
  margin-top: 2px;
}

.status-confidence {
  font-size: 12px;
  color: #606266;
  margin-top: 2px;
}

.status-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.status-actions .el-button {
  width: 28px;
  height: 28px;
  padding: 4px;
  min-width: 28px;
  cursor: pointer;
  transition: all 0.2s ease;
  position: relative;
  z-index: 100;
  pointer-events: auto;
  border: 2px solid transparent;
  user-select: none;
  -webkit-user-select: none;
  -moz-user-select: none;
  -ms-user-select: none;
}

.status-actions .el-button:hover {
  background-color: rgba(64, 158, 255, 0.1);
  border-radius: 4px;
  border-color: rgba(64, 158, 255, 0.3);
}

.status-actions .el-button:active {
  background-color: rgba(64, 158, 255, 0.2);
  transform: scale(0.95);
}



.status-details {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #e4e7ed;
}

.detail-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.detail-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
}

.detail-label {
  color: #909399;
  font-weight: 500;
}

.detail-value {
  color: #606266;
  font-weight: normal;
}

.detail-value.error-text {
  color: #f56c6c;
  font-weight: 500;
  max-width: 200px;
  word-break: break-word;
  text-align: right;
}

.detecting-progress {
  margin-top: 8px;
}

/* 紧凑模式样式 */
.status-indicator.compact .status-content {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-indicator.compact .status-text {
  font-size: 12px;
  margin: 0;
}

.status-indicator.compact .status-detail,
.status-indicator.compact .status-confidence {
  display: none;
}

/* 响应式设计 */
@media (max-width: 768px) {
  .wps-environment-status {
    padding: 8px;
  }
  
  .status-indicator {
    flex-wrap: wrap;
  }
  
  .status-content {
    flex-basis: 100%;
    margin-bottom: 8px;
  }
  
  .status-actions {
    width: 100%;
    justify-content: flex-end;
  }
}

/* WPS状态指示器样式 */
.wps-status-indicator {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.wps-status-indicator.status-success .status-icon {
  color: #22c55e;
}

.wps-status-indicator.status-warning .status-icon {
  color: #eab308;
}

.wps-status-indicator.status-error .status-icon {
  color: #ef4444;
}

.status-dot {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.9);
  cursor: pointer;
  transition: all 0.2s ease;
}

.status-dot:hover {
  background: rgba(255, 255, 255, 1);
  transform: scale(1.1);
}

.status-icon {
  display: flex;
  align-items: center;
  justify-content: center;
}

.status-icon.success-icon {
  color: #22c55e;
}

.status-icon.warning-icon {
  color: #eab308;
}

.status-icon.error-icon {
  color: #ef4444;
}

/* 右下角 WPS 状态指示器样式 */
.wps-status-corner {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 1000;
  background: rgba(255, 255, 255, 0.8);
  border-radius: 8px;
  padding: 8px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
  backdrop-filter: blur(5px);
}

@media (max-width: 768px) {
  .wps-status-corner {
    right: 10px;
    bottom: 10px;
    padding: 6px;
  }
}

/* 详情面板样式 */
.status-details {
  margin-top: 8px;
  padding: 8px;
  background: #fff;
  border-radius: 4px;
  border: 1px solid #e4e7ed;
}

.status-details .detail-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.status-details .detail-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
}

.status-details .detail-label {
  color: #909399;
}

.status-details .detail-value {
  color: #606266;
}

.status-details .detail-value.error-text {
  color: #f56c6c;
  max-width: 150px;
  word-break: break-word;
  text-align: right;
}
</style>
