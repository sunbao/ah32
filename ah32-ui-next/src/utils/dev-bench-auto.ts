import type { MacroBenchPreset, MacroBenchSuiteId } from '@/dev/macro-bench-suites'

export type DevBenchRunMode = 'macro' | 'chat'
export type DevBenchAutoAction = 'none' | 'start' | 'resume'

export type DevBenchAutoConfig = {
  enabled: boolean
  runMode: DevBenchRunMode | null
  suiteId: MacroBenchSuiteId | 'all' | null
  preset: MacroBenchPreset | null
  action: DevBenchAutoAction
  onceKey: string
}

const truthy = (v: string) => ['1', 'true', 'yes', 'on'].includes(v)

export const isTruthyDevQueryFlag = (v: string): boolean => truthy(String(v || '').trim().toLowerCase())

const readStoredTaskpaneQueryString = (): string => {
  try {
    const storage = (window as any)?.Application?.PluginStorage
    const raw = typeof storage?.getItem === 'function' ? storage.getItem('ah32_taskpane_query') : ''
    return String(raw || '').trim()
  } catch {
    return ''
  }
}

const readRuntimeTaskpaneQueryString = (): string => {
  try {
    const raw = (window as any)?.__AH32_CONFIG__?.taskpaneQuery
    return String(raw || '').trim()
  } catch {
    return ''
  }
}

const readDevBenchParams = (): URLSearchParams => {
  try {
    const href = String(globalThis.location?.href || '')
    const url = new URL(href)
    if (String(url.search || '').trim()) return url.searchParams
  } catch {
    // ignore
  }

  try {
    const runtimeQuery = readRuntimeTaskpaneQueryString()
    if (runtimeQuery) {
      const query = runtimeQuery.startsWith('?') ? runtimeQuery.slice(1) : runtimeQuery
      return new URLSearchParams(query)
    }
  } catch {
    // ignore
  }

  try {
    const stored = readStoredTaskpaneQueryString()
    if (!stored) return new URLSearchParams()
    const query = stored.startsWith('?') ? stored.slice(1) : stored
    return new URLSearchParams(query)
  } catch {
    return new URLSearchParams()
  }
}

export const readDevBenchRouteMode = (): string => {
  try {
    const params = readDevBenchParams()
    return String(params.get('ah32_dev_kiosk') || params.get('ah32_dev_view') || '').trim().toLowerCase()
  } catch {
    return ''
  }
}

export const readDevBenchAutoConfig = (): DevBenchAutoConfig => {
  try {
    const params = readDevBenchParams()
    const enabled = truthy(String(params.get('ah32_dev_bench') || '').trim().toLowerCase())
    const runModeRaw = String(params.get('ah32_dev_bench_mode') || '').trim().toLowerCase()
    const suiteIdRaw = String(params.get('ah32_dev_bench_suite') || '').trim()
    const presetRaw = String(params.get('ah32_dev_bench_preset') || '').trim().toLowerCase()
    const actionRaw = String(params.get('ah32_dev_bench_action') || '').trim().toLowerCase()

    const runMode: DevBenchRunMode | null =
      runModeRaw === 'chat' || runModeRaw === 'macro' ? (runModeRaw as DevBenchRunMode) : null
    const suiteId = suiteIdRaw ? ((suiteIdRaw === 'all' ? 'all' : suiteIdRaw) as MacroBenchSuiteId | 'all') : null
    const preset = presetRaw ? (presetRaw as MacroBenchPreset) : null
    const onceRaw = String(params.get('ah32_dev_bench_once') || '').trim()
    const action: DevBenchAutoAction =
      actionRaw === 'resume' || actionRaw === 'start'
        ? (actionRaw as DevBenchAutoAction)
        : (enabled ? 'start' : 'none')

    return {
      enabled,
      runMode,
      suiteId,
      preset,
      action,
      onceKey: onceRaw ? `ah32_dev_bench_once:${onceRaw}` : '',
    }
  } catch {
    return {
      enabled: false,
      runMode: null,
      suiteId: null,
      preset: null,
      action: 'none',
      onceKey: '',
    }
  }
}

export const shouldAutoOpenDevBenchPanel = (): boolean => {
  try {
    const params = readDevBenchParams()
    return isTruthyDevQueryFlag(String(params.get('ah32_dev_bench') || '')) || readDevBenchRouteMode() === 'bench'
  } catch {
    return false
  }
}

export const markDevBenchAutoConsumed = (onceKey: string): void => {
  try {
    sessionStorage.setItem(onceKey, '1')
  } catch {
    // ignore
  }
}

export const hasConsumedDevBenchAuto = (onceKey: string): boolean => {
  try {
    return sessionStorage.getItem(onceKey) === '1'
  } catch {
    return false
  }
}
