import { createApp } from 'vue'
import ElementPlus, { ElMessage, ElNotification } from 'element-plus'
import 'element-plus/dist/index.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import App from './App.vue'
import { pinia } from './stores'
import '@/styles/common.css'
import '@/utils/logger'

type _LogLevel = 'info' | 'warning' | 'error'

const _getApiBase = (): string => {
  try {
    const cfgBase = (globalThis as any).__AH32_CONFIG__?.apiBase
    if (typeof cfgBase === 'string' && cfgBase.trim()) return cfgBase.trim().replace(/\/+$/, '')
    const base = (import.meta as any).env?.VITE_API_BASE
    const raw = String(base || 'http://127.0.0.1:5123').trim()
    return raw.replace(/\/+$/, '')
  } catch (e) {
    console.warn('[main.ts] _getApiBase fallback:', e)
    return 'http://127.0.0.1:5123'
  }
}

const _getApiKey = (): string => {
  try {
    const cfgKey = (globalThis as any).__AH32_CONFIG__?.apiKey
    if (typeof cfgKey === 'string' && cfgKey.trim()) return cfgKey.trim()
    const key = (import.meta as any).env?.VITE_API_KEY
    return String(key || '').trim()
  } catch (e) {
    console.warn('[main.ts] _getApiKey fallback:', e)
    return ''
  }
}

// Persist API hints so taskpane.html can report early-boot crashes to a remote backend
// even before the bundle is loaded (WPS webview reloads are hard to debug otherwise).
try {
  const base = _getApiBase()
  if (base) localStorage.setItem('ah32_api_base_v1', base)
} catch (e) {
  console.warn('[main.ts] persist ah32_api_base_v1 failed:', e)
}
try {
  const key = _getApiKey()
  if (key) localStorage.setItem('ah32_api_key_v1', key)
} catch (e) {
  console.warn('[main.ts] persist ah32_api_key_v1 failed:', e)
}

const _postFrontendLog = (level: _LogLevel, message: string) => {
  try {
    const apiBase = _getApiBase()
    const url = `${apiBase}/api/log?level=${encodeURIComponent(level)}&message=${encodeURIComponent(String(message || '').slice(0, 900))}`
    void fetch(url, { method: 'GET' }).catch((e) => {
      // Never recurse via __ah32_reportError here; this is the lowest-level logger.
      console.warn('[main.ts] _postFrontendLog fetch failed:', e)
    })
  } catch (e) {
    console.warn('[main.ts] _postFrontendLog failed:', e)
    // no-op: never crash the app due to logging itself
  }
}

try {
  // Global backend logger (message-first): used by __ah32_reportError and other services.
  ;(globalThis as any).__ah32_logToBackend = (message: string, level: _LogLevel = 'info') => {
    _postFrontendLog(level, message)
  }
} catch (e) {
  ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/main.ts', e)
}

type _UINotifyPayload = {
  type?: 'success' | 'info' | 'warning' | 'error'
  title?: string
  message: string
  durationMs?: number
}

const _renderOverlayNotice = (payload: _UINotifyPayload & { _dedupKey?: string }) => {
  try {
    if (typeof document === 'undefined') return

    const p: any = payload || {}
    const type = String(p.type || 'info')
    const title = String(p.title || '').trim()
    const message = String(p.message || '').trim()
    if (!message) return

    const duration = (p.durationMs === 0)
      ? 0
      : (Number.isFinite(p.durationMs) ? Math.max(1500, Number(p.durationMs)) : 10_000)

    const dedupKey = String(p._dedupKey || `${type}::${title}::${message}`).slice(0, 400)
    try {
      const w: any = window as any
      if (!w.__AH32_NOTICE_DEDUP) w.__AH32_NOTICE_DEDUP = new Map()
      const m: Map<string, number> = w.__AH32_NOTICE_DEDUP
      const now = Date.now()
      const last = m.get(dedupKey) || 0
      if (now - last < 1200) return
      m.set(dedupKey, now)
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/main.ts', e)
    }

    const rootId = 'ah32-notify-overlay-root'
    let root = document.getElementById(rootId)
    if (!root) {
      root = document.createElement('div')
      root.id = rootId
      root.style.position = 'fixed'
      root.style.left = '12px'
      root.style.right = '12px'
      root.style.top = '12px'
      root.style.zIndex = '2147483647'
      root.style.display = 'flex'
      root.style.flexDirection = 'column'
      root.style.gap = '10px'
      root.style.pointerEvents = 'none'
      document.body.appendChild(root)
    }

    const item = document.createElement('div')
    item.style.pointerEvents = 'auto'
    item.style.borderRadius = '10px'
    item.style.padding = '12px 12px 10px'
    item.style.boxShadow = '0 10px 28px rgba(0,0,0,0.28)'
    item.style.border = '1px solid rgba(0,0,0,0.12)'
    item.style.backdropFilter = 'blur(8px)'
    item.style.fontSize = '13px'
    item.style.lineHeight = '1.35'
    item.style.whiteSpace = 'pre-wrap'
    item.style.wordBreak = 'break-word'

    const bg = type === 'error'
      ? 'rgba(220, 38, 38, 0.92)'
      : type === 'warning'
        ? 'rgba(245, 158, 11, 0.92)'
        : 'rgba(15, 23, 42, 0.86)'
    item.style.background = bg
    item.style.color = 'white'

    const header = document.createElement('div')
    header.style.display = 'flex'
    header.style.alignItems = 'center'
    header.style.justifyContent = 'space-between'
    header.style.gap = '10px'
    header.style.marginBottom = '6px'

    const hLeft = document.createElement('div')
    hLeft.style.fontWeight = '700'
    hLeft.textContent = title || (type === 'error' ? '发生错误' : type === 'warning' ? '提示' : '信息')

    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.textContent = '关闭'
    closeBtn.style.border = '1px solid rgba(255,255,255,0.55)'
    closeBtn.style.background = 'transparent'
    closeBtn.style.color = 'white'
    closeBtn.style.borderRadius = '8px'
    closeBtn.style.padding = '4px 10px'
    closeBtn.style.cursor = 'pointer'
    closeBtn.onclick = () => { try { item.remove() } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/main.ts', e) } }

    header.appendChild(hLeft)
    header.appendChild(closeBtn)

    const body = document.createElement('div')
    body.textContent = message

    item.appendChild(header)
    item.appendChild(body)
    root.appendChild(item)

    if (duration > 0) {
      setTimeout(() => {
        try { item.remove() } catch (e) { ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/main.ts', e) }
      }, duration)
    }
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/main.ts', e)
  }
}

// UI notifier: store/services can call this without importing ElementPlus.
try {
  ;(globalThis as any).__ah32_notify = (payload: _UINotifyPayload) => {
    try {
      const p: any = payload || {}
      const type = String(p.type || 'info')
      const title = String(p.title || '').trim()
      const message = String(p.message || '').trim()
      const duration = (p.durationMs === 0)
        ? 0
        : (Number.isFinite(p.durationMs) ? Math.max(1500, Number(p.durationMs)) : 10_000)

      if (!message) return

      // In WPS TaskPane, ElementPlus toasts may be invisible (z-index/webview quirks).
      // For fatal/important notices (duration=0), always show a prominent overlay.
      if (duration === 0 && (type === 'error' || type === 'warning')) {
        _renderOverlayNotice({ type, title, message, durationMs: 0, _dedupKey: `sticky::${type}::${title}::${message}` })
      }

      try {
        ElNotification({
          type: type as any,
          title: title || undefined,
          message,
          duration,
          showClose: true
        })
        return
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/main.ts', e)
      }

      try {
        ElMessage({
          type: type as any,
          message,
          duration,
          showClose: true
        })
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/main.ts', e)
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/main.ts', e)
    }
  }
} catch (e) {
  ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/main.ts', e)
}

const _frontendErrorDedup = new Map<string, number>()

const _postFrontendError = (kind: string, err: any, extra?: any) => {
  try {
    const apiBase = _getApiBase()
    const apiKey = _getApiKey()
    const msg = (() => {
      if (!err) return ''
      if (typeof err === 'string') return err
      if ((err as any)?.message) return String((err as any).message)
      return String(err)
    })()
    const stack = (() => {
      try {
        return String((err as any)?.stack || '')
      } catch (e) {
        console.warn('[main.ts] read error.stack failed:', e)
        return ''
      }
    })()

    // Avoid storming backend when one frontend failure triggers repeated catch paths.
    const dedupKey = `${String(kind || '')}::${msg}`.slice(0, 320)
    const now = Date.now()
    const last = _frontendErrorDedup.get(dedupKey) || 0
    if (now - last < 1500) return
    _frontendErrorDedup.set(dedupKey, now)

    const payload = {
      error_type: `frontend_${kind}`,
      error_message: msg,
      error_code: '',
      correction_suggestion: '请截图并反馈给开发者（可在控制台/后台日志中追踪）。',
      user_context: JSON.stringify({
        href: (typeof window !== 'undefined') ? window.location.href : '',
        ua: (typeof navigator !== 'undefined') ? navigator.userAgent : '',
        extra: extra || null,
        stack
      }).slice(0, 5000),
      severity: 'high',
      extra: {
        client_context: (() => {
        try {
          if (typeof window === 'undefined') return { stack }
          const w: any = window as any
          return {
            stack,
            last_user_query: w.__BID_LAST_USER_QUERY || '',
             last_rag_summary: w.__BID_LAST_RAG_SUMMARY || '',
             last_skills: w.__BID_LAST_SKILLS || '',
             rule_files: w.__BID_LAST_RULE_FILES || null
           }
        } catch (e) {
          console.warn('[main.ts] build client_context failed:', e)
          return { stack }
        }
      })()
      }
    }

    void fetch(`${apiBase}/agentic/error/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'X-API-Key': apiKey } : {})
      },
      body: JSON.stringify(payload)
    }).catch((e) => {
      // Never recurse via __ah32_reportError here; this is the base error reporter.
      console.warn('[main.ts] _postFrontendError fetch failed:', e)
    })
  } catch (e) {
    console.warn('[main.ts] _postFrontendError failed:', e)
    // no-op: never crash the app due to reporting itself
  }
}

try {
  // Expose structured frontend-error reporter for shared callers (e.g. logger/reportError).
  ;(globalThis as any).__ah32_postFrontendError = _postFrontendError
} catch (e) {
  ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/main.ts', e)
}

console.log('[main.ts] 开始初始化...')

// 最优先设置 window.Vue - 确保即使后续出错也能使用
if (typeof window !== 'undefined') {
  console.log('[main.ts] 优先设置 window.Vue')
  window.Vue = createApp
  console.log('[main.ts] ✓ window.Vue 已设置，类型:', typeof window.Vue)
} else {
  console.error('[main.ts] window 对象不存在!')
}

try {
  const app = createApp(App)
  console.log('[main.ts] Vue 应用实例已创建')

  // 注册 Element Plus
  app.use(ElementPlus)
  console.log('[main.ts] Element Plus 已注册')

  // 注册所有图标
  for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
    app.component(key, component)
  }
  console.log('[main.ts] 所有图标已注册')

  // 注册 Pinia
  app.use(pinia)
  console.log('[main.ts] Pinia 已注册')

  app.mount('#app')
  console.log('[main.ts] Vue 应用已挂载')

  // 再次确认 window.Vue
  if (typeof window !== 'undefined' && window.Vue) {
    console.log('[main.ts] ✓ 最终确认: window.Vue 存在且可用')
  }
  if (typeof window !== 'undefined') {
    window.__AH32_APP_READY__ = true

    const boot = document.getElementById('boot-status')
    if (boot) {
      boot.style.display = 'none'
    }

    // Persist a small reload/boot diagnostic so we can debug "taskpane reloads"
    // even when devtools isn't reachable (some WPS runtimes freeze on crash).
    try {
      const DIAG_KEY = 'ah32_reload_diag_v1'
      const raw = localStorage.getItem(DIAG_KEY) || '{}'
      const diag = JSON.parse(raw)
      diag.lastVueMountAt = new Date().toISOString()
      diag.lastVueMountOk = true
      localStorage.setItem(DIAG_KEY, JSON.stringify(diag))
    } catch (e) {
      console.warn('[main.ts] persist reload diag failed:', e)
      _postFrontendLog('warning', `[main.ts] persist reload diag failed: ${String((e as any)?.message || e)}`)
    }

    // Clear last fatal overlay record so stale crashes don't block the UI.
    try {
      localStorage.removeItem('ah32_last_error')
    } catch (e) {
      console.warn('[main.ts] clear last error failed:', e)
      _postFrontendLog('warning', `[main.ts] clear last error failed: ${String((e as any)?.message || e)}`)
    }
    const overlay = document.getElementById('ah32-fatal-error-overlay')
    if (overlay) {
      overlay.remove()
    }
  }

  window.addEventListener('error', (event: any) => {
    try {
      _postFrontendLog('error', `[frontend:error] ${String(event?.message || '')}`)
      _postFrontendError('error', event?.error || event?.message || 'unknown', { filename: event?.filename, lineno: event?.lineno, colno: event?.colno })
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/main.ts', e)
    } finally {
      try {
        if (event && typeof event.preventDefault === 'function') {
          event.preventDefault()
        }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/main.ts', e)
      }
    }
  })
  window.addEventListener('unhandledrejection', (event: any) => {
    try {
      console.warn('Unhandled Promise Rejection:', event?.reason)
      _postFrontendLog('error', `[frontend:unhandledrejection] ${String(event?.reason?.message || event?.reason || '')}`)
      _postFrontendError('unhandledrejection', event?.reason || 'unknown')
      // taskpane.html also records this into ah32_last_error + overlay (for screenshot)
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/main.ts', e)
    } finally {
      try {
        if (event && typeof event.preventDefault === 'function') {
          event.preventDefault()
        }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/main.ts', e)
      }
    }
  })

  // Runtime config is .env-only; no persisted override toggles.

  console.log('[main.ts] ✓ 所有初始化完成')
} catch (error) {
  console.error('[main.ts] 初始化错误:', error)
  _postFrontendLog('error', `[main.ts] init failed: ${String((error as any)?.message || error)}`)
  _postFrontendError('init', error)
  // 确保 window.Vue 仍然可用
  if (typeof window !== 'undefined' && !window.Vue) {
    window.Vue = createApp
    console.log('[main.ts] 错误恢复: window.Vue 已重新设置')
  }
}
