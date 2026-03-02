import type { ClientSkillSummary } from './skills-catalog'

export type ClientSkillCandidate = {
  id: string
  name: string
  score: number
  reasons: string[]
}

export type ClientSkillSelection = {
  schema_version: 'ah32.client_skill_selection.v1'
  router: 'frontend.lex.v1'
  host_app: string
  explicit: boolean
  accept_threshold: number
  primary_skill_id: string | null
  primary_score: number
  candidates: ClientSkillCandidate[]
  decided_at: string
}

const _normalizeHost = (hostApp: string): string => {
  const h = String(hostApp || '').trim().toLowerCase()
  if (!h) return ''
  if (h === 'writer') return 'wps'
  if (h === 'spreadsheet') return 'et'
  if (h === 'presentation') return 'wpp'
  return h
}

const _findByIdOrName = (catalog: ClientSkillSummary[], needle: string): ClientSkillSummary | null => {
  const n = String(needle || '').trim().toLowerCase()
  if (!n) return null
  for (const s of catalog) {
    if (String(s.id || '').toLowerCase() === n) return s
  }
  for (const s of catalog) {
    const name = String(s.name || '').trim()
    if (name && name.toLowerCase() === n) return s
  }
  // Fuzzy contains (short needles only)
  if (n.length <= 20) {
    for (const s of catalog) {
      const name = String(s.name || '').trim().toLowerCase()
      if (name && name.includes(n)) return s
    }
  }
  return null
}

const _extractExplicitSkillTarget = (text: string): string => {
  const t = String(text || '').trim()
  if (!t) return ''

  // /skill bidding-helper
  {
    const m = t.match(/^\/skill\s+([a-z0-9][a-z0-9\-_]{1,63})\b/i)
    if (m && m[1]) return String(m[1]).trim()
  }
  // 切换到 标书助手 / 使用 标书助手
  {
    const m = t.match(/(?:切换到|切到|使用|按|进入)\s*([^\n\r]{1,40})/)
    if (m && m[1]) return String(m[1]).trim().replace(/[。？！!?,，：:；;]/g, '').trim()
  }
  return ''
}

const _isGenericFollowUp = (text: string): boolean => {
  const t = String(text || '').trim()
  if (!t) return true
  if (t.length <= 2) return true
  if (/^(继续|同上|再来|重来|再做一次|再生成|再画一版|改一下|优化一下|不对|不行|换一下|更好看|更正式)$/i.test(t)) return true
  if (/^(ok|okay|继续|go on|next)$/i.test(t)) return true
  return false
}

const _hasNegationNear = (haystackLower: string, triggerLower: string): boolean => {
  const negWords = ['不需要', '不要', '不用', '无需', '不必', '别', '勿', '不想', '不打算']
  let start = 0
  while (true) {
    const idx = haystackLower.indexOf(triggerLower, start)
    if (idx < 0) break
    const prefix = haystackLower.slice(Math.max(0, idx - 10), idx)
    if (negWords.some((n) => prefix.includes(n))) return true
    start = idx + Math.max(1, triggerLower.length)
  }
  return false
}

const _lexScore01 = (skill: ClientSkillSummary, message: string): { score01: number; reasons: string[] } => {
  const needle = String(message || '').trim().toLowerCase()
  const reasons: string[] = []
  if (!needle) return { score01: 0, reasons }

  let raw = 0
  const sid = String(skill.id || '').trim().toLowerCase()
  const sname = String(skill.name || '').trim().toLowerCase()
  if (sid && needle.includes(sid)) {
    raw += 1.2
    reasons.push(`id命中:${skill.id}`)
  }
  if (sname && sname !== sid && needle.includes(sname)) {
    raw += 1.0
    reasons.push(`name命中:${skill.name}`)
  }

  // Triggers (strong)
  let triggerHits = 0
  const triggers = Array.isArray(skill.triggers) ? skill.triggers : []
  for (const t of triggers) {
    const tt = String(t || '').trim().toLowerCase()
    if (!tt) continue
    if (!needle.includes(tt)) continue
    if (_hasNegationNear(needle, tt)) continue
    triggerHits += 1
    raw += 0.45
    reasons.push(`trigger命中:${String(t)}`)
    if (triggerHits >= 6) break
  }

  // Tags/intents (weak)
  const tags = Array.isArray(skill.tags) ? skill.tags : []
  for (const tag of tags.slice(0, 20)) {
    const tt = String(tag || '').trim().toLowerCase()
    if (tt && needle.includes(tt)) {
      raw += 0.18
      reasons.push(`tag命中:${String(tag)}`)
    }
  }
  const intents = Array.isArray(skill.intents) ? skill.intents : []
  for (const it of intents.slice(0, 20)) {
    const ii = String(it || '').trim().toLowerCase()
    if (ii && needle.includes(ii)) {
      raw += 0.18
      reasons.push(`intent命中:${String(it)}`)
    }
  }

  const priority = typeof skill.priority === 'number' ? skill.priority : Number(skill.priority) || 0
  raw += Math.min(0.15, Math.max(0, priority / 1000))
  const score01 = Math.max(0, Math.min(1, raw / 2.5))
  return { score01, reasons }
}

export function routeClientSkillSelection(args: {
  message: string
  hostApp: string
  catalog: ClientSkillSummary[]
  lastPrimarySkillId?: string | null
}): ClientSkillSelection {
  const decidedAt = new Date().toISOString()
  const host = _normalizeHost(args.hostApp)
  const msg = String(args.message || '')
  const catalog = Array.isArray(args.catalog) ? args.catalog : []
  const lastPrimary = String(args.lastPrimarySkillId || '').trim()

  const acceptThreshold = 0.62

  // 1) Explicit switch by user instruction.
  const explicitTarget = _extractExplicitSkillTarget(msg)
  if (explicitTarget) {
    const found = _findByIdOrName(catalog, explicitTarget)
    if (found) {
      return {
        schema_version: 'ah32.client_skill_selection.v1',
        router: 'frontend.lex.v1',
        host_app: host,
        explicit: true,
        accept_threshold: 0,
        primary_skill_id: found.id,
        primary_score: 1,
        candidates: [{ id: found.id, name: found.name, score: 1, reasons: [`explicit:${explicitTarget}`] }],
        decided_at: decidedAt,
      }
    }
  }

  // 2) Sticky follow-up: keep last primary if this turn is generic.
  if (lastPrimary && _isGenericFollowUp(msg)) {
    const found = catalog.find((s) => String(s.id || '') === lastPrimary) || null
    if (found) {
      return {
        schema_version: 'ah32.client_skill_selection.v1',
        router: 'frontend.lex.v1',
        host_app: host,
        explicit: false,
        accept_threshold: acceptThreshold,
        primary_skill_id: found.id,
        primary_score: 0.9,
        candidates: [{ id: found.id, name: found.name, score: 0.9, reasons: ['sticky:generic_followup'] }],
        decided_at: decidedAt,
      }
    }
  }

  // 3) Lexical routing.
  const candidates: ClientSkillCandidate[] = []
  for (const s of catalog) {
    if (!s || !s.id || !s.name) continue
    const hosts = Array.isArray(s.hosts) ? s.hosts.map((x) => _normalizeHost(String(x || ''))) : []
    if (host && hosts.length > 0 && !hosts.includes(host)) continue

    const { score01, reasons } = _lexScore01(s, msg)
    if (score01 <= 0) continue
    candidates.push({ id: s.id, name: s.name, score: score01, reasons })
  }
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const ap = (catalog.find((s) => s.id === a.id)?.priority || 0) as number
    const bp = (catalog.find((s) => s.id === b.id)?.priority || 0) as number
    if (bp !== ap) return bp - ap
    return String(a.id).localeCompare(String(b.id))
  })

  const top = candidates.slice(0, 5)
  const primary = top[0] || null

  return {
    schema_version: 'ah32.client_skill_selection.v1',
    router: 'frontend.lex.v1',
    host_app: host,
    explicit: false,
    accept_threshold: acceptThreshold,
    primary_skill_id: primary ? primary.id : null,
    primary_score: primary ? primary.score : 0,
    candidates: top,
    decided_at: decidedAt,
  }
}

