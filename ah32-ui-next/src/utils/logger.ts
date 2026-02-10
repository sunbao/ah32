/**
 * 简单的日志工具
 * 替代之前复杂的logger实现
 */
export const logger = {
  debug: (message: string, ...args: any[]) => {
    try {
      if (typeof console.debug === 'function') {
        console.debug(`[DEBUG] ${message}`, ...args)
      } else {
        console.log(`[DEBUG] ${message}`, ...args)
      }
    } catch (e) {
      // Logging must never throw, but errors should stay observable.
      try {
        console.warn('[logger] debug logging failed', e)
      } catch (e2) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/utils/logger.ts', e2)
      }
    }
  },
  info: (message: string, ...args: any[]) => {
    console.log(`[INFO] ${message}`, ...args)
  },
  warn: (message: string, ...args: any[]) => {
    console.warn(`[WARN] ${message}`, ...args)
  },
  error: (message: string, ...args: any[]) => {
    console.error(`[ERROR] ${message}`, ...args)
  }
}

type _BackendLogFn = (message: string, level?: 'info' | 'warning' | 'error') => void

const _toErrorText = (error: unknown): string => {
  try {
    if (error instanceof Error) return String(error.message || error.name || 'Error')
    const msg = (error as any)?.message
    if (typeof msg === 'string' && msg.trim()) return msg
    if (typeof error === 'string') return error
    if (error && typeof error === 'object') {
      try { return JSON.stringify(error) } catch (_e) { return '[object ErrorPayload]' }
    }
    return String(error)
  } catch (_e) {
    return 'unknown error'
  }
}

const _notifyDedup = new Map<string, number>()

export const setLogToBackend = (fn: _BackendLogFn) => {
  try {
    ;(globalThis as any).__ah32_logToBackend = fn
  } catch (e) {
    console.warn('[logger] setLogToBackend failed', e)
  }
}

export const reportError = (scope: string, error: unknown, level: 'warning' | 'error' = 'warning') => {
  const msg = `[${scope}] ${_toErrorText(error)}`
  if (level === 'error') logger.error(msg, error)
  else logger.warn(msg, error)

  try {
    const logToBackend = (globalThis as any).__ah32_logToBackend as _BackendLogFn | undefined
    if (typeof logToBackend === 'function') {
      const stack = (error instanceof Error && error.stack) ? `\n${error.stack}` : ''
      logToBackend(`${msg}${stack}`, level)
    }
  } catch (e) {
    console.warn('[logger] reportError forwarding failed', e)
  }

  try {
    const postFrontendError = (globalThis as any).__ah32_postFrontendError as
      ((kind: string, err: any, extra?: any) => void) | undefined
    if (typeof postFrontendError === 'function') {
      postFrontendError('caught', error, { scope, level })
    }
  } catch (e) {
    console.warn('[logger] reportError structured forwarding failed', e)
  }

  try {
    const notify = (globalThis as any).__ah32_notify as
      ((payload: { type?: 'success' | 'info' | 'warning' | 'error'; title?: string; message: string; durationMs?: number }) => void)
      | undefined
    if (typeof notify === 'function') {
      const key = `${level}::${scope}::${msg}`.slice(0, 500)
      const now = Date.now()
      const last = _notifyDedup.get(key) || 0
      if (now - last > 1500) {
        _notifyDedup.set(key, now)
        notify({
          type: level === 'error' ? 'error' : 'warning',
          title: '操作出现异常',
          message: `${msg}。已记录日志并上报后端，请截图反馈。`,
          durationMs: level === 'error' ? 0 : 9000,
        })
      }
    }
  } catch (e) {
    console.warn('[logger] reportError notify failed', e)
  }
}

try {
  ;(globalThis as any).__ah32_reportError = reportError
} catch (e) {
  console.warn('[logger] failed to set global reporter', e)
}
