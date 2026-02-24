import { logger } from '@/utils/logger'

let _cancelled = false

const _setWindowFlagBestEffort = (value: boolean) => {
  try {
    // Used by injected JS macro guards (runs inside the taskpane JS engine).
    ;(window as any).__BID_CANCEL_MACRO = value
  } catch (e) {
    try {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/macro-cancel.ts', e)
    } catch (e2) {
      try {
        console.warn('[MacroCancel] reportError failed', e2)
      } catch (e3) {
        // Final best-effort fallback: diagnostics must never crash macro cancellation.
        try {
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(
              'ah32_last_error_internal',
              JSON.stringify({ scope: 'macro-cancel:reportError', error: String(e3) }),
            )
          }
        } catch (e4) {
          void e4
        }
      }
    }
  }
}

export const macroCancel = {
  reset() {
    _cancelled = false
    _setWindowFlagBestEffort(false)
  },
  cancel() {
    _cancelled = true
    _setWindowFlagBestEffort(true)
    try {
      ;(globalThis as any).__ah32_logToBackend?.('[MacroCancel] cancel requested', 'info')
    } catch (e) {
      try {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/macro-cancel.ts', e)
      } catch (e2) {
        try {
          console.warn('[MacroCancel] cancel diagnostics failed', e2)
        } catch (e3) {
          // Final best-effort fallback.
          try {
            if (typeof localStorage !== 'undefined') {
              localStorage.setItem(
                'ah32_last_error_internal',
                JSON.stringify({ scope: 'macro-cancel:cancel', error: String(e3) }),
              )
            }
          } catch (e4) {
            void e4
          }
        }
      }
    }
  },
  isCancelled(): boolean {
    return _cancelled
  }
}

// Initialize once so injected-macro guards have a deterministic starting value.
try {
  macroCancel.reset()
} catch (e) {
  logger.warn('[MacroCancel] init failed (ignored)', e)
}
