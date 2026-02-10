// Stable per-install client id (browser localStorage).
// Used to scope "open documents" aggregation to the current machine/profile.
//
// NOTE: 历史上出现过两个 key。优先读旧 key，保证 session_id 生成 / telemetry / 文档同步
// 用的是同一个 client_id，避免“同一台机器被当成两个客户端”导致会话/观测串台。
const LEGACY_KEY = 'ah32_client_id'
const KEY = 'ah32_client_id_v1'

export function getClientId(): string {
  try {
    // 优先读旧 key（保证老用户稳定）。
    const legacy = localStorage.getItem(LEGACY_KEY)
    if (legacy && legacy.trim()) return legacy.trim()

    const existing = localStorage.getItem(KEY)
    if (existing && existing.trim()) {
      // 迁移：把 v1 写回旧 key，后续所有模块都能读到同一个值。
      try { localStorage.setItem(LEGACY_KEY, existing.trim()) } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/utils/client-id.ts', e)
      }
      return existing.trim()
    }
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/utils/client-id.ts', e)
  }

  let id = ''
  try {
    id = (crypto as any)?.randomUUID?.() || ''
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/utils/client-id.ts', e)
  }
  if (!id) {
    id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  }

  try {
    // 兼容：两个 key 都写，避免不同版本模块各读各的。
    localStorage.setItem(LEGACY_KEY, id)
    localStorage.setItem(KEY, id)
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/utils/client-id.ts', e)
  }
  return id
}

