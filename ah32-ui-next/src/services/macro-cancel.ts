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
      } catch {
        // Final best-effort fallback: diagnostics must never crash macro cancellation.
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
        } catch {
          // Final best-effort fallback.
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
