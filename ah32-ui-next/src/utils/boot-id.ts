const BOOT_ID_KEY = 'ah32_boot_id_v1'
const BOOT_SEQ_KEY = 'ah32_boot_seq_v1'

const _genBootId = (): string => {
  try {
    const id = (crypto as any)?.randomUUID?.()
    if (typeof id === 'string' && id.trim()) return `boot_${id.trim()}`
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/utils/boot-id.ts', e)
  }
  return `boot_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

export const bumpBootSeq = (): number => {
  try {
    const raw = localStorage.getItem(BOOT_SEQ_KEY)
    const n = Number.parseInt(String(raw || '0'), 10)
    const next = (Number.isFinite(n) ? n : 0) + 1
    localStorage.setItem(BOOT_SEQ_KEY, String(next))
    return next
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/utils/boot-id.ts', e)
    return 0
  }
}

export const getBootSeq = (): number => {
  try {
    const raw = localStorage.getItem(BOOT_SEQ_KEY)
    const n = Number.parseInt(String(raw || '0'), 10)
    return Number.isFinite(n) ? n : 0
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/utils/boot-id.ts', e)
    return 0
  }
}

export const getBootId = (): string => {
  try {
    const existing = (globalThis as any).__AH32_BOOT_ID__
    if (typeof existing === 'string' && existing.trim()) return existing.trim()
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/utils/boot-id.ts', e)
  }

  try {
    const fromLs = localStorage.getItem(BOOT_ID_KEY)
    if (fromLs && fromLs.trim()) {
      try { (globalThis as any).__AH32_BOOT_ID__ = fromLs.trim() } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/utils/boot-id.ts', e)
      }
      return fromLs.trim()
    }
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/utils/boot-id.ts', e)
  }

  const id = _genBootId()
  try { localStorage.setItem(BOOT_ID_KEY, id) } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/utils/boot-id.ts', e)
  }
  try { (globalThis as any).__AH32_BOOT_ID__ = id } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/utils/boot-id.ts', e)
  }
  return id
}

