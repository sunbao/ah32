<template>

  <div class="unified-status-indicator">

    <!-- ElementPlus tooltip/poppers are flaky in some WPS WebViews (teleport + clipping). Use native title. -->
    <div class="status-launchers">
      <button
        ref="dotRef"
        type="button"
        class="status-launcher"
        :class="statusClass"
        data-testid="ah32-open-status-panel"
        :aria-expanded="showDetails && panelTab === 'status'"
        @pointerdown="togglePanel('status', $event)"
        @click="togglePanel('status', $event)"
        @keydown.enter="togglePanel('status', $event)"
        @keydown.space="togglePanel('status', $event)"
        :title="tooltipContent"
      >
        <span class="status-dot">
          <el-icon :size="18" class="status-icon">
            <CircleCheck v-if="status === 'connected'" />
            <WarningFilled v-else-if="status === 'partial'" />
            <Close v-else-if="status === 'error'" />
            <Monitor v-else />
          </el-icon>
        </span>
        <span class="status-launcher-copy">
          <span class="status-launcher-title">{{ statusLabel }}</span>
          <span class="status-launcher-subtitle">{{ statusSubtitle }}</span>
        </span>
      </button>

      <button
        v-if="devUiEnabled && devToolsEnabled"
        type="button"
        class="bench-launcher"
        data-testid="ah32-open-bench-panel"
        :aria-expanded="showDetails && panelTab === 'bench'"
        @click="togglePanel('bench', $event)"
      >
        <span class="bench-launcher-title">宏基准测试</span>
        <span class="bench-launcher-subtitle">{{ benchLauncherSubtitle }}</span>
      </button>
    </div>

    <!-- 状态详情面板 -->
    <!-- NOTE: Avoid <teleport> in WPS taskpane. Some WebViews crash with `Cannot read properties of null (reading 'insertBefore')` during patch. -->
      <div

        v-show="showDetails"
        ref="panelRef"

        class="status-details-panel"

        :class="{
          'panel-top': panelPlacement === 'top',
          'is-bench': panelTab === 'bench',
          'panel-docked': shouldDockPanel
        }"

        :style="panelStyle"

        @click.stop

      >

      <div class="panel-header">

        <div class="panel-header-copy">
          <span class="panel-title">{{ panelTitle }}</span>
          <span class="panel-subtitle">{{ panelSubtitle }}</span>
        </div>

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

        <div v-if="devUiEnabled && devToolsEnabled" class="panel-tabs">
          <button type="button" class="panel-tab" :class="{ active: panelTab === 'status' }" @click="panelTab = 'status'">状态</button>
          <button type="button" class="panel-tab" :class="{ active: panelTab === 'bench' }" @click="panelTab = 'bench'">跑测</button>
        </div>

        <div v-show="panelTab === 'status'">

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



        <!-- 租户/登录 -->

        <div class="detail-item">

          <span class="detail-label">

            <el-icon><Monitor /></el-icon>

            租户

          </span>

          <span class="detail-value">

            {{ tenantDisplay }}

          </span>

        </div>

        <div class="detail-item">

          <span class="detail-label">

            <el-icon><Connection /></el-icon>

            登录

          </span>

          <span class="detail-value">

            {{ loginDisplay }}

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
        <el-button type="default" size="small" @click="doLogin">登录/切换</el-button>
        <el-button type="danger" size="small" @click="doLogout">退出</el-button>
        </div>

        <div v-if="devUiEnabled && devToolsEnabled" v-show="panelTab === 'bench'" class="panel-bench">
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

  </div>

</template>



<script setup lang="ts">

import { ref, computed, onMounted, onUnmounted, nextTick, watch, defineAsyncComponent } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
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

	import { clearTenantAuth, getRuntimeConfig, setAccessToken, setTenantId } from '@/utils/runtime-config'
	import { isDevUiEnabled } from '@/utils/dev-ui'
	import { getClientId } from '@/utils/client-id'
	import { getBootId, getBootSeq } from '@/utils/boot-id'
  import { shouldAutoOpenDevBenchPanel } from '@/utils/dev-bench-auto'


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

const PANEL_TAB_KEY = 'ah32_status_panel_tab_v1'
const panelTab = ref<'status' | 'bench'>('status')

const refreshing = ref(false)

const authVersion = ref(0)

// Dev tools are conventionally available only when the dev UI is enabled (build-time).
const devToolsEnabled = computed(() => !!devUiEnabled)
const shouldDockPanel = computed(() => !!devUiEnabled && !!devToolsEnabled.value)


const dotRef = ref<HTMLElement | null>(null)

const panelRef = ref<HTMLElement | null>(null)

const panelStyle = ref<Record<string, string>>({})

const panelPlacement = ref<'bottom' | 'top'>('bottom')

let panelResizeObserver: ResizeObserver | null = null


const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))



const updatePanelPosition = () => {

  const dot = dotRef.value

  const panel = panelRef.value

  if (!dot || !panel) return

  if (shouldDockPanel.value) {
    panelPlacement.value = 'top'
    panelStyle.value = {}
    return
  }



  const rect = dot.getBoundingClientRect()

  // In some WPS WebViews, `innerHeight/innerWidth` can be inconsistent with the visible taskpane
  // area (e.g. when the pane is docked). Prefer `documentElement.client*` when available.
  const vw = Math.max(320, document.documentElement?.clientWidth || window.innerWidth || 0)

  const vh = Math.max(320, document.documentElement?.clientHeight || window.innerHeight || 0)



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

const statusLabel = computed(() => {
  switch (status.value) {
    case 'connected':
      return '系统正常'
    case 'partial':
      return '部分异常'
    case 'error':
      return '连接异常'
    default:
      return '系统检查中'
  }
})

const statusSubtitle = computed(() => {
  const parts: string[] = []
  if (phaseDisplay.value) parts.push(phaseDisplay.value)
  if (lastCheckTime.value) parts.push(`最后检查 ${lastCheckTimeText.value}`)
  else parts.push('点这里查看详细状态')
  return parts.join(' · ')
})

const benchLauncherSubtitle = computed(() => {
  if (_hasBenchState()) return '打开面板继续看结果或继续跑（Ctrl+Alt+B）'
  return '打开跑测面板（Ctrl+Alt+B）'
})

const panelTitle = computed(() => (panelTab.value === 'bench' ? '宏基准测试' : '系统状态'))

const panelSubtitle = computed(() => (
  panelTab.value === 'bench'
    ? '先看结论，再按需要展开技术细节。'
    : '查看连接、登录、当前阶段和环境信息。'
))



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



const tenantDisplay = computed(() => {
  void authVersion.value
  const cfg = getRuntimeConfig()
  return String(cfg.tenantId || '').trim() || '(默认)'
})

const loginDisplay = computed(() => {
  void authVersion.value
  const cfg = getRuntimeConfig()
  return String(cfg.accessToken || '').trim() ? '已登录' : '未登录'
})

const doLogin = async () => {
  const cfg = getRuntimeConfig()
  const uid = (() => { try { return getClientId() } catch (_e) { return '' } })()
  if (!uid) {
    ElMessage.error('缺少 user_id（client_id）')
    return
  }

  const currentTenant = String(cfg.tenantId || '').trim()
  let tenantIdRaw: any = ''
  try {
    const r = await ElMessageBox.prompt(
      '输入租户ID（留空=默认租户）',
      '切换租户',
      { inputValue: currentTenant, confirmButtonText: '下一步', cancelButtonText: '取消' }
    )
    tenantIdRaw = (r as any)?.value
  } catch (_e) {
    return
  }
  const tenantId = String(tenantIdRaw || '').trim()
  if (!tenantId) {
    clearTenantAuth()
    authVersion.value++
    ElMessage.success('已切换为默认租户')
    return
  }

  let apiKeyRaw: any = ''
  try {
    const r = await ElMessageBox.prompt(
      '输入租户 API Key（可留空；开启鉴权时必填）',
      '登录',
      { inputType: 'password', confirmButtonText: '登录', cancelButtonText: '取消' }
    )
    apiKeyRaw = (r as any)?.value
  } catch (_e) {
    return
  }
  const apiKey = String(apiKeyRaw || '').trim()

  try {
    const resp = await fetch(`${cfg.apiBase}/agentic/auth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(tenantId ? { 'X-AH32-Tenant-Id': tenantId } : {}),
        ...(uid ? { 'X-AH32-User-Id': uid } : {}),
        ...(apiKey ? { 'X-AH32-Api-Key': apiKey } : {}),
        ...(cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {}),
      },
      body: '{}',
    })
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '')
      throw new Error(txt || `HTTP ${resp.status}`)
    }
    const data = (await resp.json()) as any
    const token = String(data?.access_token || '').trim()
    const tid = String(data?.tenant_id || tenantId).trim()
    if (!token) throw new Error('missing access_token')
    setTenantId(tid || tenantId)
    setAccessToken(token)
    authVersion.value++
    ElMessage.success(`登录成功（tenant=${tid || tenantId}）`)
  } catch (e: any) {
    ElMessage.error(`登录失败：${String(e?.message || e).slice(0, 200)}`)
  }
}

const doLogout = async () => {
  clearTenantAuth()
  authVersion.value++
  ElMessage.success('已退出登录')
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

    const cfg = getRuntimeConfig()
    const uid = (() => { try { return getClientId() } catch (_e) { return '' } })()


    const response = await fetch(`${props.backendUrl}/api/documents`, {

      method: 'GET',

      headers: {
        ...(cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {}),
        ...(cfg.tenantId ? { 'X-AH32-Tenant-Id': cfg.tenantId } : {}),
        ...(cfg.accessToken ? { Authorization: `Bearer ${cfg.accessToken}` } : {}),
        ...(uid ? { 'X-AH32-User-Id': uid } : {}),
      },
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



// 处理点击事件（WPS WebView 里 click/pointer 事件偶发不稳定；这里做双通道 + 去抖，避免点了没反应或触发两次）
let _lastToggleAt = 0
const _hasBenchState = (): boolean => {
  try {
    if (typeof localStorage === 'undefined') return false
    if (localStorage.getItem('ah32_macro_bench_widget_state_v1')) return true
    // Also detect saved runs. Keep it O(n) but bounded to localStorage length (small in taskpane).
    for (let i = 0; i < localStorage.length; i++) {
      const k = String(localStorage.key(i) || '')
      if (!k) continue
      if (k.startsWith('ah32_macro_bench_results_v2')) return true
      if (k.startsWith('ah32_chat_bench_results_v2')) return true
    }
    return false
  } catch (_e) {
    return false
  }
}

const togglePanel = (targetTab: 'status' | 'bench', e?: Event) => {
  try { (e as any)?.stopPropagation?.() } catch (_e) {}
  try { (e as any)?.preventDefault?.() } catch (_e) {}

  const now = Date.now()
  if (now - _lastToggleAt < 250) return
  _lastToggleAt = now

  const desiredTab = (targetTab === 'bench' && devUiEnabled && devToolsEnabled.value) ? 'bench' : 'status'
  const shouldClose = showDetails.value && panelTab.value === desiredTab
  if (shouldClose) {
    showDetails.value = false
    return
  }
  panelTab.value = desiredTab
  showDetails.value = true
}

const openPanel = (targetTab: 'status' | 'bench') => {
  const desiredTab = (targetTab === 'bench' && devUiEnabled && devToolsEnabled.value) ? 'bench' : 'status'
  panelTab.value = desiredTab
  showDetails.value = true
}

const handleDevPanelHotkeys = (event: KeyboardEvent) => {
  if (!(event.ctrlKey && event.altKey)) return
  const key = String(event.key || '').toLowerCase()
  if (key === 'b') {
    event.preventDefault()
    event.stopPropagation()
    openPanel('bench')
    return
  }
  if (key === 's') {
    event.preventDefault()
    event.stopPropagation()
    openPanel('status')
  }
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
	    const bootId = (() => {
	      try { return getBootId() } catch (_e) { return '' }
	    })()
	    const bootSeq = (() => {
	      try { return getBootSeq() } catch (_e) { return 0 }
	    })()
	    const clientId = (() => {
	      try { return getClientId() } catch (_e) { return '' }
	    })()
	    const resp = await fetch(`${cfg.apiBase}/api/runtime-config`, {
	      method: 'GET',
	      headers: {
	        ...(cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {}),
	        ...(bootId ? { 'X-AH32-Boot-Id': bootId } : {}),
	        ...(bootSeq ? { 'X-AH32-Boot-Seq': String(bootSeq) } : {}),
	        ...(clientId ? { 'X-AH32-Client-Id': clientId } : {}),
	      }
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

  // Restore last selected tab (dev only). Default to "status" so users don't lose connectivity info.
  try {
    if (devUiEnabled && devToolsEnabled.value) {
      const t = String(localStorage.getItem(PANEL_TAB_KEY) || '').trim()
      if (t === 'status' || t === 'bench') panelTab.value = t as any
      else panelTab.value = 'status'
    } else {
      panelTab.value = 'status'
    }
  } catch (_e) {
    panelTab.value = 'status'
  }

  try {
    if (devUiEnabled && devToolsEnabled.value && shouldAutoOpenDevBenchPanel()) {
      panelTab.value = 'bench'
      showDetails.value = true
      nextTick(() => updatePanelPosition())
    }
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/UnifiedStatusIndicator.vue', e)
  }



  // 点击外部关闭面板

  document.addEventListener('click', handleClickOutside)
  document.addEventListener('keydown', handleDevPanelHotkeys, true)

  window.addEventListener('resize', updatePanelPosition)

  // Keep the panel within viewport when its size changes (user resize / dynamic content).
  try {
    const RO: any = (globalThis as any).ResizeObserver
    if (typeof RO === 'function') {
      panelResizeObserver = new RO(() => {
        try {
          if (!showDetails.value) return
          updatePanelPosition()
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/UnifiedStatusIndicator.vue', e)
        }
      })
      if (panelRef.value) panelResizeObserver.observe(panelRef.value)
    }
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/UnifiedStatusIndicator.vue', e)
  }
})



onUnmounted(() => {

  // 无需清理定时器（已删除）

  document.removeEventListener('click', handleClickOutside)
  document.removeEventListener('keydown', handleDevPanelHotkeys, true)

  window.removeEventListener('resize', updatePanelPosition)

  try { panelResizeObserver?.disconnect() } catch (_e) {}
  panelResizeObserver = null
})



watch(showDetails, (v) => {

  if (!v) return

  nextTick(() => updatePanelPosition())

})

watch(panelTab, (v) => {
  // Persist tab in Dev UI so panel re-open (or taskpane reload) restores the last view.
  try {
    if (devUiEnabled && devToolsEnabled.value) localStorage.setItem(PANEL_TAB_KEY, String(v))
  } catch (_e) {}

  if (!showDetails.value) return
  nextTick(() => updatePanelPosition())
})

</script>



<style scoped lang="scss">

.unified-status-indicator {

  position: relative;

  display: flex;

  width: 100%;

  min-width: 0;

}



.status-launchers {

  display: flex;

  align-items: stretch;

  gap: 8px;

  flex-wrap: wrap;

  width: 100%;

}



.status-launcher,
.bench-launcher {

  appearance: none;

  border: 1px solid rgba(148, 163, 184, 0.24);

  background: rgba(255, 255, 255, 0.92);

  border-radius: 14px;

  padding: 8px 12px;

  display: inline-flex;

  align-items: center;

  gap: 10px;

  cursor: pointer;

  transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease;

  text-align: left;

  min-width: 0;

}



.status-launcher {

  flex: 1 1 220px;

}



.bench-launcher {

  flex: 1 1 220px;

  justify-content: center;

  flex-direction: column;

  align-items: flex-start;

  min-height: 56px;

  background: linear-gradient(135deg, rgba(37, 99, 235, 0.14), rgba(59, 130, 246, 0.06));

  border-color: rgba(37, 99, 235, 0.28);

  box-shadow: 0 6px 16px rgba(37, 99, 235, 0.12);

}



.status-launcher:hover,
.bench-launcher:hover {

  transform: translateY(-1px);

  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.12);

}



.status-launcher:focus-visible,
.bench-launcher:focus-visible {

  outline: 2px solid rgba(37, 99, 235, 0.38);

  outline-offset: 2px;

}



.status-dot {

  width: 26px;

  height: 26px;

  border-radius: 50%;

  display: flex;

  align-items: center;

  justify-content: center;

  border: 1px solid rgba(0, 0, 0, 0.06);

  flex: 0 0 auto;

}


.status-launcher-copy {

  min-width: 0;

  display: flex;

  flex-direction: column;

  gap: 2px;

}



.status-launcher-title,
.bench-launcher-title {

  font-size: 13px;

  font-weight: 700;

  color: #0f172a;

}


.status-launcher-subtitle,
.bench-launcher-subtitle {

  font-size: 11px;

  line-height: 1.35;

  color: #475569;

}



.status-launcher.status-connected {

  border-color: rgba(34, 197, 94, 0.26);

  background: linear-gradient(135deg, rgba(34, 197, 94, 0.12), rgba(255, 255, 255, 0.96));

  .status-dot {

    background: #22c55e;

    box-shadow: 0 0 6px rgba(34, 197, 94, 0.4);

  }

  .status-icon {

    color: white;

  }

}



.status-launcher.status-thinking {

  .status-dot {

    background: #3b82f6;

    animation: thinkingPulse 1.5s infinite;

  }


  .status-icon {

    color: white;

  }


  .thinking-icon {

    animation: spin 1s linear infinite;

  }

}



.status-launcher.status-partial {

  border-color: rgba(234, 179, 8, 0.32);

  background: linear-gradient(135deg, rgba(234, 179, 8, 0.16), rgba(255, 255, 255, 0.96));

  .status-dot {

    background: #eab308;

    animation: warningBlink 1s infinite;

  }


  .status-icon {

    color: white;

  }

}



.status-launcher.status-error {

  border-color: rgba(239, 68, 68, 0.28);

  background: linear-gradient(135deg, rgba(239, 68, 68, 0.14), rgba(255, 255, 255, 0.96));

  .status-dot {

    background: #ef4444;

    animation: errorPulse 0.5s infinite;

  }


  .status-icon {

    color: white;

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

  // Default size; will clamp to viewport. (Dev tools like MacroBench need more space than a simple status list.)
  width: 560px;

  max-width: calc(100vw - 20px);
  // Allow more content without "falling off screen".
  max-height: calc(100vh - 20px);
  overflow: auto;

  // Let devs resize when MacroBench results are long.
  resize: both;
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

.status-details-panel.panel-docked {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 12px);
  width: auto;
  min-width: 0;
  max-width: none;
  max-height: min(74vh, 760px);
  min-height: 260px;
  resize: none;
  overflow: hidden;
  display: flex;
  flex-direction: column;

  &::before {
    display: none;
  }
}

.status-details-panel.is-bench {
  width: 760px;
  // Make sure "跑测" tab has enough height even before results are available.
  min-height: min(420px, calc(100vh - 180px));
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

  position: sticky;

  top: 0;

  background: white;

  z-index: 2;
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



  .panel-header-copy {

    min-width: 0;

    display: flex;

    flex-direction: column;

    gap: 3px;

  }



  .panel-subtitle {

    font-size: 12px;

    color: #64748b;

    line-height: 1.35;

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

  flex: 1 1 auto;

  min-height: 0;

  overflow: auto;

}



.panel-tabs {

  display: inline-flex;

  gap: 8px;

  padding: 6px;

  border-radius: 14px;

  background: rgba(148, 163, 184, 0.12);

  margin-bottom: 14px;

}



.panel-tab {

  appearance: none;

  border: none;

  background: transparent;

  color: #475569;

  font-size: 13px;

  font-weight: 700;

  border-radius: 10px;

  padding: 10px 16px;

  cursor: pointer;

  transition: background 0.16s ease, color 0.16s ease, box-shadow 0.16s ease;

}



.panel-tab.active {

  background: #ffffff;

  color: #1d4ed8;

  box-shadow: 0 6px 16px rgba(15, 23, 42, 0.12);

}



.panel-bench {

  min-height: 0;

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

  position: sticky;

  bottom: 0;

  background: white;

  z-index: 2;
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

