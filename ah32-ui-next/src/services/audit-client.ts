import { logger } from '@/utils/logger'
import { getRuntimeConfig } from '@/utils/runtime-config'
import { getClientId } from '@/utils/client-id'

export interface AuditEventPayload {
  session_id?: string
  host_app?: string
  mode: 'plan' | 'js' | 'unknown'
  block_id?: string
  ops?: string[]
  success: boolean
  error_type?: string
  error_message?: string
  extra?: Record<string, any>
}

export async function reportAuditEvent(payload: AuditEventPayload): Promise<void> {
  try {
    const cfg = getRuntimeConfig()
    const uid = (() => { try { return getClientId() } catch (_e) { return '' } })()
    const response = await fetch(`${cfg.apiBase}/agentic/audit/record`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {}),
        ...(cfg.tenantId ? { 'X-AH32-Tenant-Id': cfg.tenantId } : {}),
        ...(cfg.accessToken ? { Authorization: `Bearer ${cfg.accessToken}` } : {}),
        ...(uid ? { 'X-AH32-User-Id': uid } : {}),
      },
      body: JSON.stringify(payload || {})
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
  } catch (e) {
    logger.debug?.('[audit] report failed', e)
  }
}

