export type RuntimeConfig = {
  apiBase: string
  apiKey: string
  tenantId: string
  accessToken: string
  showThoughts: boolean
  showRagHits: boolean
}

const STORAGE_KEYS = {
  tenantId: 'ah32_tenant_id',
  accessToken: 'ah32_access_token',
} as const

const normalizeBase = (base: string): string => {
  return base.replace(/\/+$/, '')
}

const enforceFixedPort = (base: string): string => {
  const fallback = 'http://127.0.0.1:5123'
  const raw = (base || '').trim()
  if (!raw) {
    return fallback
  }

  try {
    const url = new URL(raw)
    url.port = '5123'
    return normalizeBase(url.toString())
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/utils/runtime-config.ts', e)
    return fallback
  }
}

export const getRuntimeConfig = (): RuntimeConfig => {
  const baseFromEnv = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:5123'
  const apiKeyFromEnv = import.meta.env.VITE_API_KEY || ''
  const showThoughtsFromEnv = import.meta.env.VITE_SHOW_THOUGHTS === 'true'
  const showRagHitsFromEnv = import.meta.env.VITE_SHOW_RAG_HITS === 'true'

  let tenantIdFromStorage = ''
  let accessTokenFromStorage = ''
  try {
    if (typeof localStorage !== 'undefined') {
      tenantIdFromStorage = String(localStorage.getItem(STORAGE_KEYS.tenantId) || '').trim()
      accessTokenFromStorage = String(localStorage.getItem(STORAGE_KEYS.accessToken) || '').trim()
    }
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/utils/runtime-config.ts', e)
  }

  return {
    apiBase: enforceFixedPort(baseFromEnv),
    apiKey: apiKeyFromEnv,
    tenantId: tenantIdFromStorage,
    accessToken: accessTokenFromStorage,
    showThoughts: showThoughtsFromEnv,
    showRagHits: showRagHitsFromEnv
  }
}

export const setTenantId = (tenantId: string) => {
  try {
    if (typeof localStorage === 'undefined') return
    const v = String(tenantId || '').trim()
    if (!v) localStorage.removeItem(STORAGE_KEYS.tenantId)
    else localStorage.setItem(STORAGE_KEYS.tenantId, v)
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/utils/runtime-config.ts', e)
  }
}

export const setAccessToken = (accessToken: string) => {
  try {
    if (typeof localStorage === 'undefined') return
    const v = String(accessToken || '').trim()
    if (!v) localStorage.removeItem(STORAGE_KEYS.accessToken)
    else localStorage.setItem(STORAGE_KEYS.accessToken, v)
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/utils/runtime-config.ts', e)
  }
}

export const clearTenantAuth = () => {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.removeItem(STORAGE_KEYS.tenantId)
    localStorage.removeItem(STORAGE_KEYS.accessToken)
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/utils/runtime-config.ts', e)
  }
}
