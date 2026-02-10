import { logger } from '@/utils/logger'
import { getRuntimeConfig } from '@/utils/runtime-config'

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
    const response = await fetch(`${cfg.apiBase}/agentic/audit/record`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {})
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

