import { getRuntimeConfig } from '@/utils/runtime-config'
import { getClientId } from '@/utils/client-id'

export type ClientSkillSummary = {
  id: string
  name: string
  version?: string
  priority?: number
  description?: string
  group?: string
  default_writeback?: string
  hosts?: string[]
  tags?: string[]
  intents?: string[]
  triggers?: string[]
  examples?: string[]
  output_schema?: string
  style_spec_hints?: string
  prompt_text?: string | null
}

type CatalogEnvelope = {
  schema_version?: string
  generated_at?: string
  skills?: ClientSkillSummary[]
}

const _catalogCacheByKey = new Map<string, { at: number; skills: ClientSkillSummary[] }>()
const CATALOG_TTL_MS = 60_000
const _catalogReportAtByKey = new Map<string, number>()
const CATALOG_REPORT_TTL_MS = 30_000

const reportCatalogFailureOnce = (key: string, message: string) => {
  try {
    const now = Date.now()
    const last = _catalogReportAtByKey.get(key) || 0
    if (now - last < CATALOG_REPORT_TTL_MS) return
    _catalogReportAtByKey.set(key, now)
    const fn = (globalThis as any).__ah32_logToBackend as ((msg: string, level?: any) => void) | undefined
    if (typeof fn === 'function') fn(`[skills_catalog] ${message}`.slice(0, 1600), 'warning')
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/skills-catalog.ts', e)
  }
}

export async function getClientSkillsCatalog(opts?: {
  force?: boolean
  includePrompt?: boolean
  maxPromptChars?: number
}): Promise<ClientSkillSummary[]> {
  const force = !!opts?.force
  const includePrompt = !!opts?.includePrompt
  const maxPromptChars = Number.isFinite(Number(opts?.maxPromptChars))
    ? Math.max(0, Number(opts?.maxPromptChars))
    : 6000
  const key = `${includePrompt ? 'p1' : 'p0'}:${maxPromptChars}`
  const now = Date.now()
  const cached = _catalogCacheByKey.get(key)
  if (!force && cached && cached.skills.length > 0 && now - cached.at < CATALOG_TTL_MS) {
    return cached.skills
  }

  const cfg = getRuntimeConfig()
  const qs = includePrompt ? `?include_prompt=1&max_prompt_chars=${encodeURIComponent(String(maxPromptChars))}` : ''
  const url = `${cfg.apiBase}/agentic/skills/catalog${qs}`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) headers['X-API-Key'] = cfg.apiKey
  if (cfg.tenantId) headers['X-AH32-Tenant-Id'] = cfg.tenantId
  if (cfg.accessToken) headers['Authorization'] = `Bearer ${cfg.accessToken}`
  try {
    const uid = getClientId()
    if (uid) headers['X-AH32-User-Id'] = uid
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/skills-catalog.ts', e)
  }

  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 1200)
    const resp = await fetch(url, { method: 'GET', headers, signal: ac.signal })
    clearTimeout(timer)
    if (!resp.ok) {
      reportCatalogFailureOnce(key, `fetch failed status=${resp.status}`)
      return cached?.skills || []
    }
    const data = (await resp.json()) as CatalogEnvelope
    const skills = Array.isArray(data?.skills) ? data.skills : []
    const normalized = skills
      .map((s) => ({
        id: String(s?.id || '').trim(),
        name: String(s?.name || '').trim(),
        version: s?.version ? String(s.version) : undefined,
        priority: typeof s?.priority === 'number' ? s.priority : Number(s?.priority) || 0,
        description: s?.description ? String(s.description) : undefined,
        group: s?.group ? String(s.group) : undefined,
        default_writeback: s?.default_writeback ? String(s.default_writeback) : undefined,
        hosts: Array.isArray(s?.hosts) ? s.hosts.map((x: any) => String(x || '')).filter((x: string) => !!x.trim()) : [],
        tags: Array.isArray(s?.tags) ? s.tags.map((x: any) => String(x || '')).filter((x: string) => !!x.trim()) : [],
        intents: Array.isArray(s?.intents)
          ? s.intents.map((x: any) => String(x || '')).filter((x: string) => !!x.trim())
          : [],
        triggers: Array.isArray(s?.triggers)
          ? s.triggers.map((x: any) => String(x || '')).filter((x: string) => !!x.trim())
          : [],
        examples: Array.isArray(s?.examples)
          ? s.examples.map((x: any) => String(x || '')).filter((x: string) => !!x.trim())
          : [],
        output_schema: s?.output_schema ? String(s.output_schema) : undefined,
        style_spec_hints: s?.style_spec_hints ? String(s.style_spec_hints) : undefined,
        prompt_text: Object.prototype.hasOwnProperty.call(s || {}, 'prompt_text') ? (s as any).prompt_text : undefined,
      }))
      .filter((s) => !!s.id && !!s.name)

    _catalogCacheByKey.set(key, { at: now, skills: normalized })
    return normalized
  } catch (e) {
    reportCatalogFailureOnce(key, `fetch error: ${String((e as any)?.message || e)}`)
    return cached?.skills || []
  }
}
