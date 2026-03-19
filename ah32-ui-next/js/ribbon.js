// AH32 WPS add-in ribbon entry.

function getQueryString() {
  try {
    if (typeof location !== 'undefined' && location.search) {
      const direct = String(location.search || '').trim()
      if (direct) return direct
    }
  } catch (_e) {
    // ignore
  }

  try {
    const cfgQuery = String((window.__AH32_CONFIG__ || {}).taskpaneQuery || '').trim()
    if (!cfgQuery) return ''
    return cfgQuery.charAt(0) === '?' ? cfgQuery : ('?' + cfgQuery)
  } catch (_e) {
    // ignore
  }

  try {
    const storage = window.Application && window.Application.PluginStorage
    const stored = storage && typeof storage.getItem === 'function'
      ? String(storage.getItem('ah32_taskpane_query') || '').trim()
      : ''
    if (!stored) return ''
    return stored.charAt(0) === '?' ? stored : ('?' + stored)
  } catch (_e) {
    return ''
  }
}

function isLocalDevAddinHost() {
  try {
    const base = String(GetUrlPath() || '').trim()
    return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(base)
  } catch (_e) {
    return false
  }
}

function shouldAutoOpenTaskpane() {
  try {
    if (isLocalDevAddinHost()) return true
    const qs = getQueryString()
    if (!qs) return false
    const params = new URLSearchParams(qs)
    const flag = String(params.get('ah32_dev_bench') || '').trim().toLowerCase()
    return flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on'
  } catch (_e) {
    return false
  }
}


function normalizeBaseUrl(raw) {
  try {
    const text = String(raw || '').trim()
    if (!text) return ''
    return text.replace(/\/+$/, '')
  } catch (_e) {
    return ''
  }
}

function resolveTaskpaneBaseUrl() {
  try {
    const configured = normalizeBaseUrl((window.__AH32_CONFIG__ || {}).taskpaneBaseUrl)
    if (/^https?:\/\//i.test(configured)) return configured
  } catch (_e) {
    // ignore
  }

  try {
    const current = normalizeBaseUrl(GetUrlPath())
    if (/^https?:\/\//i.test(current)) return current
  } catch (_e) {
    // ignore
  }

  try {
    const origin = normalizeBaseUrl(location.origin)
    if (/^https?:\/\//i.test(origin)) return origin
  } catch (_e) {
    // ignore
  }

  return 'http://127.0.0.1:3889'
}

function createTaskpaneCompat(url, title) {
  const app = (typeof window !== 'undefined' && window.Application) ? window.Application : null
  let taskpane = null

  if (app && typeof app.CreateTaskPane === 'function') {
    taskpane = app.CreateTaskPane(url)
    try {
      if (taskpane && typeof taskpane.Visible !== 'undefined') taskpane.Visible = true
    } catch (_e) {
      // ignore
    }
    return taskpane
  }

  if (typeof OpenTaskPane === 'function') {
    taskpane = OpenTaskPane(url, title)
    try {
      if (taskpane && typeof taskpane.Visible !== 'undefined') taskpane.Visible = true
    } catch (_e) {
      // ignore
    }
    return taskpane
  }

  throw new Error('taskpane_api_missing')
}

function openAh32Taskpane() {
  const qs = getQueryString()
  const url = resolveTaskpaneBaseUrl() + '/taskpane.html' + qs
  try {
    window.Application.PluginStorage.setItem('ah32_taskpane_query', qs)
  } catch (_e) {
    // ignore
  }
  const taskpane = createTaskpaneCompat(url, '阿蛤 智能助手')
  try {
    window.Application.PluginStorage.setItem('ah32_taskpane_id', taskpane && taskpane.ID ? String(taskpane.ID) : '')
  } catch (_e) {
    // ignore
  }
  console.log('[WPS addin] taskpane opened', url)
  return taskpane
}

console.log('[WPS addin] define window.ribbon')

try {
  window.ribbon = {
    OnAddinLoad: function (ribbonUI) {
      if (typeof window.Application.ribbonUI !== 'object') {
        window.Application.ribbonUI = ribbonUI
      }

      if (typeof window.Application.Enum !== 'object') {
        window.Application.Enum = WPS_Enum
      }

      window.Application.PluginStorage.setItem('ah32_taskpane_id', '')
      try {
        window.Application.PluginStorage.setItem('ah32_taskpane_query', getQueryString())
      } catch (_e) {
        // ignore
      }
      console.log('[WPS addin] loaded')

      if (shouldAutoOpenTaskpane() && !window.__ah32TaskpaneAutoOpened) {
        window.__ah32TaskpaneAutoOpened = true
        try {
          setTimeout(function () {
            openAh32Taskpane()
          }, 1200)
        } catch (e) {
          console.error('[WPS addin] auto open taskpane failed', e)
        }
      }

      return true
    },

    OnAction: function (control) {
      const eleId = control.Id
      switch (eleId) {
        case 'btnOpenPanel':
          openAh32Taskpane()
          break
        default:
          break
      }
      return true
    },

    GetImage: function (control) {
      let baseUrl = ''
      try {
        baseUrl = String(GetUrlPath() || '')
      } catch (_e) {
        baseUrl = ''
      }

      const eleId = control.Id
      let rel = 'assets/newFromTemp.svg'
      switch (eleId) {
        case 'btnOpenPanel':
          rel = 'assets/1.svg'
          break
        case 'btnReadDoc':
          rel = 'assets/2.svg'
          break
        case 'btnWriteDoc':
          rel = 'assets/3.svg'
          break
        default:
          rel = 'assets/newFromTemp.svg'
          break
      }

      if (baseUrl && /^https?:\/\//i.test(baseUrl)) {
        return baseUrl.replace(/\/+$/, '') + '/' + rel.replace(/^\/+/, '')
      }
      return rel.replace(/^\/+/, '')
    },

    OnGetEnabled: function (_control) {
      return true
    },

    OnGetVisible: function (_control) {
      return true
    },

    OnGetLabel: function (control) {
      const eleId = control.Id
      switch (eleId) {
        case 'btnOpenPanel':
          return '打开助手'
        default:
          return ''
      }
    },
  }

  console.log('[WPS addin] window.ribbon ready')
} catch (error) {
  console.error('[WPS addin] define window.ribbon failed', error)
}

window.refreshDocumentList = function () {
  console.log('[WPS addin] refreshDocumentList called from frontend')

  try {
    window.Application.PluginStorage.setItem(
      'ah32_refresh_command',
      JSON.stringify({
        timestamp: Date.now(),
        source: 'wps-plugin',
      }),
    )
  } catch (error) {
    console.warn('[WPS addin] PluginStorage refresh failed', error)
  }

  try {
    if (window.parent && typeof window.parent.postMessage === 'function') {
      window.parent.postMessage(
        {
          type: 'RefreshDocumentList',
          data: { source: 'wps-plugin', timestamp: Date.now() },
        },
        '*',
      )
    }
  } catch (error) {
    console.warn('[WPS addin] postMessage refresh failed', error)
  }
}
