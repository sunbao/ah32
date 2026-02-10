import { logger } from '@/utils/logger'
import { getRuntimeConfig } from '@/utils/runtime-config'
import { wpsBridge, type WPSHostApp } from './wps-bridge'

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

  async generatePlan(userQuery: string): Promise<PlanGenerateResult> {
    try {
      const cfg = getRuntimeConfig()
      const capabilities = wpsBridge.getCapabilities(false)

      const response = await fetch(`${cfg.apiBase}/agentic/plan/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {})
        },
        body: JSON.stringify({
          user_query: userQuery,
          session_id: this.sessionId,
          document_name: this.documentName,
          host_app: this.hostApp,
          capabilities
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

  async repairPlan(plan: any, errorType: string, errorMessage: string, attempt: number = 1): Promise<PlanRepairResult> {
    try {
      const cfg = getRuntimeConfig()
      const capabilities = wpsBridge.getCapabilities(false)

      const response = await fetch(`${cfg.apiBase}/agentic/plan/repair`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {})
        },
        body: JSON.stringify({
          session_id: this.sessionId,
          document_name: this.documentName,
          host_app: this.hostApp,
          capabilities,
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
