import { logger } from '@/utils/logger'
import { getRuntimeConfig } from '@/utils/runtime-config'
import { wpsBridge, type WPSHostApp } from './wps-bridge'
import { getClientId } from '@/utils/client-id'

export interface PlanGenerateResult {
  success: boolean
  plan?: any
  error?: string
}

export interface PlanRepairResult {
  success: boolean
  plan?: any
  error?: string
}

export class PlanClient {
  private sessionId: string | null = null
  private documentName: string | null = null
  private hostApp: WPSHostApp = 'unknown'

  setContext(sessionId: string, documentName: string, hostApp?: WPSHostApp) {
    this.sessionId = sessionId
    this.documentName = documentName
    this.hostApp = hostApp || 'unknown'
  }

  async generatePlan(userQuery: string, selectedSkillIds: string[] = []): Promise<PlanGenerateResult> {
    try {
      const cfg = getRuntimeConfig()
      const capabilities = wpsBridge.getCapabilities(false)
      const uid = (() => { try { return getClientId() } catch (_e) { return '' } })()

      const response = await fetch(`${cfg.apiBase}/agentic/plan/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {}),
          ...(cfg.tenantId ? { 'X-AH32-Tenant-Id': cfg.tenantId } : {}),
          ...(cfg.accessToken ? { Authorization: `Bearer ${cfg.accessToken}` } : {}),
          ...(uid ? { 'X-AH32-User-Id': uid } : {}),
        },
        body: JSON.stringify({
          user_query: userQuery,
          session_id: this.sessionId,
          document_name: this.documentName,
          host_app: this.hostApp,
          capabilities,
          selected_skill_ids: Array.isArray(selectedSkillIds) ? selectedSkillIds : []
        })
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const data = await response.json()
      return {
        success: !!data?.success,
        plan: data?.plan,
        error: typeof data?.error === 'string' ? data.error : undefined
      }
    } catch (error) {
      logger.error('[PlanClient] generatePlan failed', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async repairPlan(
    plan: any,
    errorType: string,
    errorMessage: string,
    attempt: number = 1,
    selectedSkillIds: string[] = [],
  ): Promise<PlanRepairResult> {
    try {
      const cfg = getRuntimeConfig()
      const capabilities = wpsBridge.getCapabilities(false)
      const uid = (() => { try { return getClientId() } catch (_e) { return '' } })()

      const response = await fetch(`${cfg.apiBase}/agentic/plan/repair`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {}),
          ...(cfg.tenantId ? { 'X-AH32-Tenant-Id': cfg.tenantId } : {}),
          ...(cfg.accessToken ? { Authorization: `Bearer ${cfg.accessToken}` } : {}),
          ...(uid ? { 'X-AH32-User-Id': uid } : {}),
        },
        body: JSON.stringify({
          session_id: this.sessionId,
          document_name: this.documentName,
          host_app: this.hostApp,
          capabilities,
          selected_skill_ids: Array.isArray(selectedSkillIds) ? selectedSkillIds : [],
          attempt,
          error_type: errorType,
          error_message: errorMessage,
          plan
        })
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const data = await response.json()
      return {
        success: !!data?.success,
        plan: data?.plan,
        error: typeof data?.error === 'string' ? data.error : undefined
      }
    } catch (error) {
      logger.error('[PlanClient] repairPlan failed', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
}

export const planClient = new PlanClient()
