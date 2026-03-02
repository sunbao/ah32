import type { ClientSkillSummary } from './skills-catalog'
import { getClientSkillsCatalog } from './skills-catalog'

type SkillsPackSkill = {
  skill_id: string
  name: string
  version?: string
  priority?: number
  enabled?: boolean
  group?: string
  default_writeback?: string
  hosts?: string[]
  tags?: string[]
  intents?: string[]
  triggers?: string[]
  examples?: string[]
  output_schema?: string
  style_spec_hints?: string
  prompt_text?: string
  markers?: string[]
  capabilities?: Record<string, any>
}

export type SkillsPackV1 = {
  schema_version: 'ah32.skills_pack.v1'
  pack_hash: string
  host_app: string
  skills: SkillsPackSkill[]
}

export type SkillsPackEnvelope = {
  ref: string
  pack?: SkillsPackV1
}

const fnv1a64Hex = (input: string): string => {
  let h = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const s = String(input || '')
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i))
    h = (h * prime) & 0xffffffffffffffffn
  }
  return h.toString(16).padStart(16, '0')
}

const stableJson = (value: any): string => {
  const seen = new Set<any>()
  const walk = (v: any): any => {
    if (v === null || v === undefined) return v
    if (typeof v !== 'object') return v
    if (seen.has(v)) return null
    seen.add(v)
    if (Array.isArray(v)) return v.map(walk)
    const keys = Object.keys(v).sort()
    const out: any = {}
    for (const k of keys) out[k] = walk(v[k])
    return out
  }
  return JSON.stringify(walk(value))
}

const pickPackSkill = (s: ClientSkillSummary): SkillsPackSkill | null => {
  const id = String(s?.id || '').trim()
  const name = String(s?.name || '').trim()
  if (!id || !name) return null
  const prompt = s?.prompt_text != null ? String(s.prompt_text || '') : ''
  return {
    skill_id: id,
    name,
    version: s?.version ? String(s.version) : undefined,
    priority: typeof s?.priority === 'number' ? s.priority : Number(s?.priority) || 0,
    enabled: true,
    group: s?.group ? String(s.group) : undefined,
    default_writeback: s?.default_writeback ? String(s.default_writeback) : undefined,
    hosts: Array.isArray(s?.hosts) ? s.hosts.slice() : [],
    tags: Array.isArray(s?.tags) ? s.tags.slice() : [],
    intents: Array.isArray(s?.intents) ? s.intents.slice() : [],
    triggers: Array.isArray(s?.triggers) ? s.triggers.slice() : [],
    examples: Array.isArray(s?.examples) ? s.examples.slice() : [],
    output_schema: s?.output_schema ? String(s.output_schema) : undefined,
    style_spec_hints: s?.style_spec_hints ? String(s.style_spec_hints) : undefined,
    prompt_text: prompt,
  }
}

const _cacheBySession = new Map<string, { ref: string; pack: SkillsPackV1 }>()

export async function buildSkillsPackForSelection(args: {
  sessionId: string
  hostApp: string
  acceptedSkillIds: string[]
}): Promise<SkillsPackEnvelope | null> {
  const sid = String(args.sessionId || '').trim() || '__default__'
  const host = String(args.hostApp || '').trim().toLowerCase()
  const ids = (args.acceptedSkillIds || []).map((x) => String(x || '').trim()).filter((x) => !!x)
  if (ids.length === 0) return null

  // Fetch prompts (local/dev fallback). In remote-backend mode, the client should build the pack locally.
  const catalog = await getClientSkillsCatalog({ includePrompt: true, maxPromptChars: 8000 })
  const byId = new Map<string, ClientSkillSummary>()
  for (const s of catalog) byId.set(String(s.id), s)

  const skills: SkillsPackSkill[] = []
  for (const id of ids.slice(0, 5)) {
    const s = byId.get(id)
    if (!s) continue
    const item = pickPackSkill(s)
    if (!item) continue
    // If prompt_text is missing (older backend), skip pack to avoid poisoning.
    if (!String(item.prompt_text || '').trim()) continue
    skills.push(item)
  }
  if (skills.length === 0) return null
  skills.sort((a, b) => String(a.skill_id).localeCompare(String(b.skill_id)))

  const packNoHash = { schema_version: 'ah32.skills_pack.v1' as const, host_app: host, skills }
  const ref = fnv1a64Hex(stableJson(packNoHash))
  const pack: SkillsPackV1 = { ...packNoHash, pack_hash: ref }

  const cached = _cacheBySession.get(sid)
  if (cached && cached.ref === ref) return { ref }

  _cacheBySession.set(sid, { ref, pack })
  return { ref, pack }
}

