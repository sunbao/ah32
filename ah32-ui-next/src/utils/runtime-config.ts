export type RuntimeConfig = {
  apiBase: string
  apiKey: string
  showThoughts: boolean
  showRagHits: boolean
}

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

  return {
    apiBase: enforceFixedPort(baseFromEnv),
    apiKey: apiKeyFromEnv,
    showThoughts: showThoughtsFromEnv,
    showRagHits: showRagHitsFromEnv
  }
}
