import { getRuntimeConfig } from '@/utils/runtime-config'

export type MemoryScope = 'global' | 'document'
export type MemoryKind = 'user_profile' | 'user_preferences' | 'project_context' | 'document_note'

export interface MemoryPatch {
  patch_id: string
  scope: MemoryScope
  kind: MemoryKind
  title: string
  preview: string
  data: Record<string, any>
  recommended: boolean
  reason: string
}

export interface SuggestResponse {
  success: boolean
  recommended_patch_ids: string[]
  patches: MemoryPatch[]
}

export interface CommitResponse {
  success: boolean
  applied_patch_ids: string[]
  errors: string[]
}

export const memoryApi = {
  async suggest(params: { sessionId?: string | null; message: string; messageRole?: string; messageId?: string }): Promise<SuggestResponse> {
    const cfg = getRuntimeConfig()
    const res = await fetch(`${cfg.apiBase}/memory/suggest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {})
      },
      body: JSON.stringify({
        session_id: params.sessionId || null,
        message: params.message,
        message_role: params.messageRole,
        message_id: params.messageId
      })
    })
    if (!res.ok) {
      const txt = await res.text()
      throw new Error(txt || `HTTP ${res.status}`)
    }
    return await res.json()
  },

  async commit(params: { sessionId?: string | null; patches: MemoryPatch[] }): Promise<CommitResponse> {
    const cfg = getRuntimeConfig()
    const res = await fetch(`${cfg.apiBase}/memory/commit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {})
      },
      body: JSON.stringify({
        session_id: params.sessionId || null,
        patches: params.patches
      })
    })
    if (!res.ok) {
      const txt = await res.text()
      throw new Error(txt || `HTTP ${res.status}`)
    }
    return await res.json()
  }
}
