<template>
  <div class="unified-status-indicator">
    <el-tooltip :content="tooltipContent" placement="top" trigger="hover">
      <div
        class="status-dot"
        :class="statusClass"
        ref="dotRef"
        @click="handleClick"
      >
        <el-icon :size="18" class="status-icon">
          <CircleCheck v-if="status === 'connected'" />
          <WarningFilled v-else-if="status === 'partial'" />
          <Close v-else-if="status === 'error'" />
          <Monitor v-else />
        </el-icon>
      </div>
    </el-tooltip>

    <!-- 悬停详情面板 -->
    <!-- Teleport to body to avoid being clipped by taskpane/containers with overflow hidden -->
    <teleport to="body">
      <div
        v-if="showDetails"
        ref="panelRef"
        class="status-details-panel"
        :class="{ 'panel-top': panelPlacement === 'top' }"
        :style="panelStyle"
        @click.stop
      >
      <div class="panel-header">
        <span class="panel-title">系统状态</span>
        <el-button
          type="text"
          size="small"
          @click="showDetails = false"
          class="close-btn"
        >
          <el-icon><Close /></el-icon>
        </el-button>
      </div>

      <div class="panel-content">
        <!-- WPS环境状态 -->
        <div class="detail-item">
          <span class="detail-label">
            <el-icon><Cpu /></el-icon>
            WPS环境
          </span>
          <span class="detail-value" :class="{ 'success': wpsConnected, 'error': !wpsConnected }">
            <el-icon><CircleCheck v-if="wpsConnected" /><Close v-else /></el-icon>
            {{ wpsConnected ? '已连接' : '未连接' }}
          </span>
        </div>

        <!-- 后端服务状态 -->
        <div class="detail-item">
          <span class="detail-label">
            <el-icon><Connection /></el-icon>
            后端服务
          </span>
          <span class="detail-value" :class="{ 'success': backendConnected, 'error': !backendConnected }">
            <el-icon><CircleCheck v-if="backendConnected" /><Close v-else /></el-icon>
            {{ backendConnected ? '已连接' : '未连接' }}
          </span>
        </div>

        <!-- 本轮阶段 -->
        <div v-if="phaseDisplay" class="detail-item">
          <span class="detail-label">
            <el-icon><Monitor /></el-icon>
            本轮阶段
          </span>
          <span class="detail-value">
            {{ phaseDisplay }}
          </span>
        </div>

        <!-- 已耗时 -->
        <div v-if="elapsedDisplay" class="detail-item">
          <span class="detail-label">
            <el-icon><Clock /></el-icon>
            已耗时
          </span>
          <span class="detail-value">
            {{ elapsedDisplay }}
          </span>
        </div>

        <!-- 最后检查时间 -->
        <div class="detail-item">
          <span class="detail-label">
            <el-icon><Clock /></el-icon>
            最后检查
          </span>
          <span class="detail-value">
            {{ lastCheckTimeText }}
          </span>
        </div>

        <!-- 开发选项（后端总控关闭时不显示；且需要前端 dev-ui 总开关） -->
        <div v-if="devUiEnabled" class="detail-item dev-item">
          <span class="detail-label">
            <el-icon><Tools /></el-icon>
            显示推理(开发)
          </span>
          <span class="detail-value">
            {{ showThoughtsEnabled ? '开' : (serverAllowsThoughts ? '关' : '后端未开放') }}
          </span>
        </div>

        <div v-if="devUiEnabled && devToolsEnabled" class="detail-item dev-item dev-block">
          <component :is="MacroBenchWidget" v-if="MacroBenchWidget" />
        </div>
      </div>

      <div class="panel-footer">
        <el-button
          type="primary"
          size="small"
          @click="refreshStatus"
          :loading="refreshing"
        >
          <el-icon><Refresh /></el-icon>
          刷新状态
        </el-button>
      </div>
      </div>
    </teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch, defineAsyncComponent } from 'vue'
import {
  CircleCheck,
  WarningFilled,
  Close,
  Monitor,
  Cpu,
  Connection,
  Clock,
  Tools,
  Refresh
} from '@element-plus/icons-vue'
import { getRuntimeConfig } from '@/utils/runtime-config'
import { isDevUiEnabled } from '@/utils/dev-ui'

// Dev UI master switch:
// - Dev UI is controlled only by `.env` `VITE_ENABLE_DEV_UI=true|false`.
const devUiEnabled = isDevUiEnabled()

const MacroBenchWidget = devUiEnabled
  ? defineAsyncComponent({
    loader: () => import('@/components/dev/MacroBenchWidget.vue'),
    onError: (error, _retry, fail) => {
      try {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/UnifiedStatusIndicator.vue', error)
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/UnifiedStatusIndicator.vue', e)
      }
      fail(error as any)
    }
  })
  : null

interface Props {
  backendUrl?: string
  isThinking?: boolean
  phase?: string
  elapsedMs?: number
}

const props = withDefaults(defineProps<Props>(), {
  backendUrl: () => getRuntimeConfig().apiBase || 'http://127.0.0.1:5123',
  isThinking: false,
  phase: 'idle',
  elapsedMs: 0
})

// 状态数据
const wpsConnected = ref(false)
const backendConnected = ref(false)
const lastCheckTime = ref<Date | null>(null)
const showDetails = ref(false)
const refreshing = ref(false)

// Dev tools are conventionally available only when the dev UI is enabled (build-time).
const devToolsEnabled = computed(() => !!devUiEnabled)

const dotRef = ref<HTMLElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const panelStyle = ref<Record<string, string>>({})
const panelPlacement = ref<'bottom' | 'top'>('bottom')

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

const updatePanelPosition = () => {
  const dot = dotRef.value
  const panel = panelRef.value
  if (!dot || !panel) return

  const rect = dot.getBoundingClientRect()
  const vw = Math.max(320, window.innerWidth || 0)
  const vh = Math.max(320, window.innerHeight || 0)

  const pw = Math.max(240, panel.offsetWidth || 240)
  const ph = Math.max(140, panel.offsetHeight || 140)

  const margin = 10
  const gap = 10

  const canPlaceBelow = rect.bottom + gap + ph + margin <= vh
  const top = canPlaceBelow
    ? rect.bottom + gap
    : clamp(rect.top - gap - ph, margin, vh - ph - margin)
  const left = clamp(rect.left + rect.width / 2 - pw / 2, margin, vw - pw - margin)

  panelPlacement.value = canPlaceBelow ? 'bottom' : 'top'
  panelStyle.value = {
    position: 'fixed',
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`
  }
}

// Status should be about connectivity only; "thinking" UI is shown inside the chat pane.
const status = computed(() => {
  if (!wpsConnected.value && !backendConnected.value) {
    return 'error' // 红色 - 严重错误
  }

  if (!wpsConnected.value || !backendConnected.value) {
    return 'partial' // 黄色 - 部分连接
  }

  return 'connected' // 绿色 - 全部正常
})

// 状态类名
const statusClass = computed(() => ({
  'status-connected': status.value === 'connected',
  'status-partial': status.value === 'partial',
  'status-error': status.value === 'error'
}))

// 工具提示内容
const tooltipContent = computed(() => {
  const timeText = lastCheckTime.value
    ? `最后检查: ${formatLastCheckTime(lastCheckTime.value)}`
    : '尚未检查'

  const phaseText = (props.phase && props.phase !== 'idle') ? `阶段: ${props.phase}` : ''
  const elapsedText = (props.elapsedMs && props.elapsedMs > 0) ? `耗时: ${formatElapsed(props.elapsedMs)}` : ''
  const extra = [phaseText, elapsedText].filter(Boolean).join(' · ')

  switch (status.value) {
    case 'connected':
      return `所有系统正常 (${timeText}${extra ? ` · ${extra}` : ''})`
    case 'thinking':
      return `AI正在工作... (${timeText}${extra ? ` · ${extra}` : ''})`
    case 'partial':
      return `部分连接异常 (${timeText}${extra ? ` · ${extra}` : ''})`
    case 'error':
      return `系统连接异常 (${timeText}${extra ? ` · ${extra}` : ''})`
    default:
      return `ℹ️ 状态检查中... (${timeText}${extra ? ` · ${extra}` : ''})`
  }
})

// 最后检查时间文本
const lastCheckTimeText = computed(() => {
  if (!lastCheckTime.value) return '尚未检查'
  return formatLastCheckTime(lastCheckTime.value)
})

// 格式化最后检查时间
const formatLastCheckTime = (date: Date) => {
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const seconds = Math.floor(diff / 1000)

  if (seconds < 5) return '刚刚'
  if (seconds < 60) return `${seconds}秒前`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分钟前`

  const hours = Math.floor(minutes / 60)
  return `${hours}小时前`
}

// 检测WPS连接
const checkWPSConnection = async () => {
  try {
    const hasWPS = typeof (window as any).WPS !== 'undefined' ||
                   typeof (window as any).wps !== 'undefined' ||
                   typeof (window as any).wpsApplication !== 'undefined'

    wpsConnected.value = hasWPS
  } catch (error) {
    wpsConnected.value = false
  }
}

// 检测后端连接
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
  } catch (error) {
    backendConnected.value = false
  } finally {
    lastCheckTime.value = new Date()
  }
}

// 刷新所有状态
const refreshStatus = async () => {
  refreshing.value = true
  try {
    await Promise.all([
      checkWPSConnection(),
      checkBackendConnection()
    ])
  } finally {
    refreshing.value = false
  }
}

// 处理点击事件
const handleClick = (e: MouseEvent) => {
  e.stopPropagation()
  showDetails.value = !showDetails.value
}

// 点击外部关闭面板
const handleClickOutside = (e: MouseEvent) => {
  const target = e.target
  if (!(target instanceof HTMLElement)) {
    return
  }
  if (!target.closest('.unified-status-indicator') && !target.closest('.status-details-panel')) {
    showDetails.value = false
  }
}

const formatElapsed = (ms: number) => {
  const total = Math.max(0, Math.floor(ms))
  const s = Math.floor(total / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return `${m}m${rs}s`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return `${h}h${rm}m`
}

const phaseDisplay = computed(() => {
  const p = String(props.phase || '').trim()
  if (!p || p === 'idle') return ''
  const map: Record<string, string> = {
    init: '初始化',
    start: '开始',
    thinking: '思考中',
    retrieval: '检索中',
    skills: '选择技能',
    responding: '生成中',
    done: '完成',
    error: '出错',
    agent_ready: '已连接'
  }
  return map[p] || p
})

const elapsedDisplay = computed(() => {
  const ms = Number(props.elapsedMs || 0)
  if (!Number.isFinite(ms) || ms <= 0) return ''
  return formatElapsed(ms)
})

const serverAllowsThoughts = ref(false)
let lastRuntimeConfigWarnAt = 0
// Runtime config is .env-only; backend may still hard-disable exposing thoughts.
const showThoughtsEnabled = computed(() => {
  try { return !!getRuntimeConfig().showThoughts && !!serverAllowsThoughts.value } catch (e) { return false }
})

const loadBackendFlags = async () => {
  try {
    const cfg = getRuntimeConfig()
    const resp = await fetch(`${cfg.apiBase}/api/runtime-config`, {
      method: 'GET',
      headers: { ...(cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {}) }
    })
    if (!resp.ok) throw new Error(`runtime-config status=${resp.status}`)
    const data = await resp.json()
    const allow = !!(data && data.expose_agent_thoughts)
    serverAllowsThoughts.value = allow
  } catch (e) {
    try {
      const now = Date.now()
      if (now - lastRuntimeConfigWarnAt > 15000) {
        lastRuntimeConfigWarnAt = now
        ;(globalThis as any).__ah32_logToBackend?.(
          `[UnifiedStatusIndicator] loadBackendFlags failed: ${String((e as any)?.message || e)}`,
          'warning'
        )
      }
    } catch (e2) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/UnifiedStatusIndicator.vue', e2)
    }
    // If backend is unreachable, default to hiding "show thoughts" to avoid exposing internals by accident.
    serverAllowsThoughts.value = false
  }
}

// 定时检测
onMounted(() => {
  // 初始检测
  loadBackendFlags().catch((e) => { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/UnifiedStatusIndicator.vue', e) })
  refreshStatus()

  // Dev ???????????????????
  if (devUiEnabled && devToolsEnabled.value) {
    showDetails.value = true
    nextTick(() => updatePanelPosition())
  }

  // 点击外部关闭面板
  document.addEventListener('click', handleClickOutside)
  window.addEventListener('resize', updatePanelPosition)
})

onUnmounted(() => {
  // 无需清理定时器（已删除）
  document.removeEventListener('click', handleClickOutside)
  window.removeEventListener('resize', updatePanelPosition)
})

watch(showDetails, (v) => {
  if (!v) return
  nextTick(() => updatePanelPosition())
})
</script>

<style scoped lang="scss">
.unified-status-indicator {
  position: relative;
  display: inline-block;
}

.status-dot {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: help;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  border: 1px solid rgba(0, 0, 0, 0.06);

  &:hover {
    transform: scale(1.08);
  }

  &.status-connected {
    background: #22c55e;
    box-shadow: 0 0 6px rgba(34, 197, 94, 0.4);

    .status-icon {
      color: white;
    }
  }

  &.status-thinking {
    background: #3b82f6;
    animation: thinkingPulse 1.5s infinite;

    .status-icon {
      color: white;
    }

    .thinking-icon {
      animation: spin 1s linear infinite;
    }
  }

  &.status-partial {
    background: #eab308;
    animation: warningBlink 1s infinite;

    .status-icon {
      color: white;
    }
  }

  &.status-error {
    background: #ef4444;
    animation: errorPulse 0.5s infinite;

    .status-icon {
      color: white;
    }
  }
}

// 状态详情面板
.status-details-panel {
  // Position is computed in JS (fixed) to avoid being clipped inside the WPS taskpane.
  background: white;
  border: 1px solid rgba(102, 126, 234, 0.2);
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  min-width: 240px;
  max-height: 70vh;
  overflow-y: auto;
  overscroll-behavior: contain;
  z-index: 9999;
  animation: fadeInScale 0.2s ease-out;

  &::before {
    content: '';
    position: absolute;
    top: -6px;
    left: 50%;
    transform: translateX(-50%);
    width: 12px;
    height: 12px;
    background: white;
    border-left: 1px solid rgba(102, 126, 234, 0.2);
    border-top: 1px solid rgba(102, 126, 234, 0.2);
    transform: translateX(-50%) rotate(45deg);
  }
}

.status-details-panel.panel-top {
  &::before {
    top: auto;
    bottom: -6px;
    border-left: none;
    border-top: none;
    border-right: 1px solid rgba(102, 126, 234, 0.2);
    border-bottom: 1px solid rgba(102, 126, 234, 0.2);
    transform: translateX(-50%) rotate(45deg);
  }
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(102, 126, 234, 0.1);

  .panel-title {
    font-size: 14px;
    font-weight: 600;
    color: #4a5568;
  }

  .close-btn {
    padding: 4px;
    color: #909399;

    &:hover {
      color: #667eea;
    }
  }
}

.panel-content {
  padding: 12px 16px;
}

.detail-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;

  &:last-child {
    margin-bottom: 0;
  }

  .detail-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: #4a5568;
    font-weight: 500;

    .el-icon {
      color: #667eea;
      font-size: 14px;
    }
  }

  .detail-value {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: #606266;
    font-weight: 500;

    &.success {
      color: #22c55e;
    }

    &.error {
      color: #ef4444;
    }

    &.thinking {
      color: #3b82f6;
    }

    .loading-icon {
      animation: spin 1s linear infinite;
    }
  }
}

.dev-item {
  opacity: 0.92;
}

.detail-item.dev-block {
  display: block;
}

.panel-footer {
  padding: 12px 16px;
  border-top: 1px solid rgba(102, 126, 234, 0.1);
  display: flex;
  justify-content: center;

  .el-button {
    font-size: 12px;
  }
}

// 动画定义
@keyframes thinkingPulse {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.4);
  }
  50% {
    box-shadow: 0 0 0 8px rgba(59, 130, 246, 0);
  }
}

@keyframes warningBlink {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.6;
  }
}

@keyframes errorPulse {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4);
  }
  50% {
    box-shadow: 0 0 0 6px rgba(239, 68, 68, 0);
  }
}

@keyframes fadeInScale {
  from {
    opacity: 0;
    transform: translateX(-50%) scale(0.95);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) scale(1);
  }
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
