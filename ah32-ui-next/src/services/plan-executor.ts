import { wpsBridge, type WPSHostApp } from './wps-bridge'
import { logger } from '@/utils/logger'
import { reportAuditEvent } from './audit-client'
import { emitTelemetryEvent } from './telemetry'

let _lastPlanDiagAt = 0
const _planDiag = (level: 'info' | 'warning' | 'error', msg: string) => {
  try {
    const now = Date.now()
    // Keep logs low-volume; this runs in tight UI environments (WPS webview).
    if (now - _lastPlanDiagAt < 800) return
    _lastPlanDiagAt = now
    ;(globalThis as any).__ah32_logToBackend?.(`[PlanExecutor] ${String(msg || '').slice(0, 800)}`, level)
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
  }
}

const _errMsg = (error: unknown): string => {
  try {
    if (error instanceof Error) return String(error.message || error.name || 'Error')
    const msg = (error as any)?.message
    if (typeof msg === 'string' && msg.trim()) return msg
    if (typeof error === 'string') return error
    if (error && typeof error === 'object') {
      try {
        return JSON.stringify(error)
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
        const keys = Object.keys(error as any)
        if (keys.length) {
          const summary: Record<string, any> = {}
          for (const key of keys.slice(0, 8)) summary[key] = (error as any)[key]
          try {
            return JSON.stringify(summary)
          } catch (e2) {
            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e2)
          }
        }
      }
    }
    return String(error)
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    return 'unknown error'
  }
}

export type PlanSchemaVersion = 'ah32.plan.v1'

export interface PlanBaseAction {
  id: string
  title: string
  op: string
}

export type SelectionAnchor = 'cursor' | 'start_of_document' | 'end_of_document'

export interface SetSelectionAction extends PlanBaseAction {

  op: 'set_selection'

  anchor: SelectionAnchor

  offset_lines?: number

  offset_chars?: number

}

export interface InsertTextAction extends PlanBaseAction {
  op: 'insert_text'
  text: string
  new_paragraph_before?: boolean
  new_paragraph_after?: boolean
}

export interface InsertAfterTextAction extends PlanBaseAction {
  op: 'insert_after_text'
  anchor_text: string
  text: string
  new_paragraph_before?: boolean
  new_paragraph_after?: boolean
}

export interface InsertBeforeTextAction extends PlanBaseAction {
  op: 'insert_before_text'
  anchor_text: string
  text: string
  new_paragraph_before?: boolean
  new_paragraph_after?: boolean
}

export interface InsertTableAction extends PlanBaseAction {
  op: 'insert_table'
  rows: number
  cols: number
  borders?: boolean | null
  style?: string | null
  header?: boolean | null
  auto_fit?: number | null
}

export interface InsertChartFromSelectionAction extends PlanBaseAction {
  op: 'insert_chart_from_selection'
  chart_type?: number | null
  width?: number | null
  height?: number | null
}

export interface InsertWordArtAction extends PlanBaseAction {
  op: 'insert_word_art'
  text: string
  preset?: number | null
  font?: string | null
  size?: number | null
  bold?: boolean | null
  italic?: boolean | null
}

export interface SetTextStyleAction extends PlanBaseAction {
  op: 'set_text_style'
  font?: string | null
  size?: number | null
  bold?: boolean | null
  italic?: boolean | null
  color?: string | null
  apply_to_selection?: boolean
}

export interface SetCellFormulaAction extends PlanBaseAction {
  op: 'set_cell_formula'
  cell: string
  formula: string
}

export interface SetNumberFormatAction extends PlanBaseAction {
  op: 'set_number_format'
  range: string
  number_format: string
}

export interface SetConditionalFormatAction extends PlanBaseAction {
  op: 'set_conditional_format'
  range: string
  rule_type?: 'color_scale' | 'cell_value'
  operator?:
    | 'between'
    | 'not_between'
    | 'equal'
    | 'not_equal'
    | 'greater_than'
    | 'less_than'
    | 'greater_or_equal'
    | 'less_or_equal'
    | null
  formula1?: string | null
  formula2?: string | null
  min_color?: string | null
  mid_color?: string | null
  max_color?: string | null
  fill_color?: string | null
  font_color?: string | null
  bold?: boolean | null
  clear_existing?: boolean
}

export interface SetDataValidationAction extends PlanBaseAction {
  op: 'set_data_validation'
  range: string
  validation_type?: 'list' | 'whole_number' | 'decimal' | 'date' | 'time' | 'text_length' | 'custom'
  operator?:
    | 'between'
    | 'not_between'
    | 'equal'
    | 'not_equal'
    | 'greater_than'
    | 'less_than'
    | 'greater_or_equal'
    | 'less_or_equal'
    | null
  formula1: string
  formula2?: string | null
  allow_blank?: boolean
  in_cell_dropdown?: boolean
  show_input?: boolean
  show_error?: boolean
  input_title?: string | null
  input_message?: string | null
  error_title?: string | null
  error_message?: string | null
}

export interface SortRangeAction extends PlanBaseAction {
  op: 'sort_range'
  range: string
  key: string
  order?: 'asc' | 'desc'
  has_header?: boolean
}

export interface FilterRangeAction extends PlanBaseAction {
  op: 'filter_range'
  range: string
  field: number
  criteria1: string
  operator?: 'and' | 'or' | null
  criteria2?: string | null
  visible_dropdown?: boolean
}

export interface PivotValueField {
  field: string
  summary?: 'sum' | 'count' | 'average' | 'max' | 'min'
  title?: string | null
}

export interface CreatePivotTableAction extends PlanBaseAction {
  op: 'create_pivot_table'
  source_range: string
  destination: string
  rows: string[]
  columns?: string[]
  values: PivotValueField[]
  filters?: string[]
  table_name?: string | null
  replace_existing?: boolean
}

export interface SetSlideBackgroundAction extends PlanBaseAction {
  op: 'set_slide_background'
  color: string
  apply_to_all?: boolean
}

export interface SetSlideTextStyleAction extends PlanBaseAction {
  op: 'set_slide_text_style'
  font?: string | null
  size?: number | null
  bold?: boolean | null
  color?: string | null
  apply_to_all?: boolean
}

export interface SetSlideThemeAction extends PlanBaseAction {
  op: 'set_slide_theme'
  theme_name?: string | null
  theme_index?: number | null
  template_path?: string | null
  apply_to_all?: boolean
}

export interface SetSlideLayoutAction extends PlanBaseAction {
  op: 'set_slide_layout'
  layout: number
  apply_to_all?: boolean
}

export interface SetShapeStyleAction extends PlanBaseAction {
  op: 'set_shape_style'
  shape_name?: string | null
  fill_color?: string | null
  line_color?: string | null
  line_width?: number | null
  text_color?: string | null
  bold?: boolean | null
  apply_to_all?: boolean
}

export interface SetTableStyleAction extends PlanBaseAction {
  op: 'set_table_style'
  shape_name?: string | null
  style_name?: string | null
  first_row?: boolean | null
  last_row?: boolean | null
  banded_rows?: boolean | null
  banded_columns?: boolean | null
  apply_to_all?: boolean
}

export interface AnswerModeItem {
  q: string
  answer: string
}

export interface AnswerModeApplyAction extends PlanBaseAction {
  op: 'answer_mode_apply'
  block_id?: string | null
  answers: AnswerModeItem[]
  strict?: boolean
  search_window_chars?: number
  backup?: boolean | null
}

export interface DeleteBlockAction extends PlanBaseAction {
  op: 'delete_block'
  block_id: string
}

export interface UpsertBlockAction extends PlanBaseAction {
  op: 'upsert_block'
  block_id: string
  anchor?: 'cursor' | 'end'
  freeze_cursor?: boolean
  actions: PlanAction[]
}

export type PlanAction =
  | SetSelectionAction

  | InsertTextAction
  | InsertAfterTextAction
  | InsertBeforeTextAction
  | InsertTableAction
  | InsertChartFromSelectionAction
  | InsertWordArtAction
  | SetTextStyleAction
  | SetCellFormulaAction
  | SetNumberFormatAction
  | SetConditionalFormatAction
  | SetDataValidationAction
  | SortRangeAction
  | FilterRangeAction
  | CreatePivotTableAction
  | SetSlideBackgroundAction
  | SetSlideTextStyleAction
  | SetSlideThemeAction
  | SetSlideLayoutAction
  | SetShapeStyleAction
  | SetTableStyleAction
  | AnswerModeApplyAction
  | DeleteBlockAction
  | UpsertBlockAction

export interface Plan {
  schema_version: PlanSchemaVersion
  host_app: Exclude<WPSHostApp, 'unknown'>
  meta?: Record<string, any>
  actions: PlanAction[]
}

export interface PlanExecutionStep {
  id: string
  title: string
  op: string
  content?: string
  status: 'processing' | 'completed' | 'error'
  timestamp: number
  error?: string
}

export interface PlanExecutionResult {
  success: boolean
  message: string
  steps: PlanExecutionStep[]
  debugInfo?: any
}

export class PlanExecutor {
  private readonly MAX_PLAN_JSON_CHARS = 500_000

  private emitCapabilityEvent(
    eventName: string,
    payload: Record<string, any>
  ) {
    try {
      const hostApp = String(payload.host_app || wpsBridge.getHostApp() || '').trim() || 'unknown'
      const op = String(payload.op || '').trim() || 'unknown'
      const branch = String(payload.branch || '').trim() || 'unknown'
      const fallback = Boolean(payload.fallback)
      const success = payload.success == null ? true : Boolean(payload.success)
      const matrixPayload = {
        ...payload,
        host_app: hostApp,
        op,
        branch,
        fallback,
        success,
        capability_key: `${hostApp}:${op}:${branch}`,
      }
      const normalizedEventName = 'plan.capability_matrix'

      emitTelemetryEvent(normalizedEventName, matrixPayload, {
        mode: 'plan',
        host_app: hostApp,
        block_id: typeof payload.block_id === 'string' ? payload.block_id : undefined,
      })
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }
  }

  executePlan(plan: unknown, onStep?: (step: PlanExecutionStep) => void): PlanExecutionResult {
    const steps: PlanExecutionStep[] = []
    const emit = (s: PlanExecutionStep) => {
      steps.push(s)
      onStep?.(s)
    }

    try {
      const parsed = this.parsePlan(plan)

      try {
        const actions = Array.isArray((parsed as any)?.actions) ? (parsed as any).actions : []
        _planDiag('info', `start host=${String((parsed as any)?.host_app || '')} actions=${actions.length}`)
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }

      const app = wpsBridge.getApplication()
      if (!app) throw new Error('WPS Application not available')
      const actualHost = this.detectHostFromApplication(app)
      if (parsed.host_app && parsed.host_app !== actualHost) {
        throw new Error(`host_app mismatch: plan=${parsed.host_app} actual=${actualHost}`)
      }

      if (actualHost === 'wps') {
        const doc = this.getActiveDocument(app)
        const selection = this.getSelection(app)
        if (!doc || !selection) throw new Error('WPS document/selection not available')
        this.executeActions({ app, doc, selection }, parsed.actions, emit)
      } else if (actualHost === 'et') {
        const wb = this.getActiveWorkbook(app)
        const selection = this.getSelection(app)
        if (!wb || !selection) throw new Error('WPS workbook/selection not available')
        this.executeActionsEt({ app, wb, selection }, parsed.actions, emit)
      } else if (actualHost === 'wpp') {
        const pres = this.getActivePresentation(app)
        if (!pres) throw new Error('WPS presentation not available')
        this.executeActionsWpp({ app, pres }, parsed.actions, emit)
      } else {
        throw new Error(`unsupported host: ${actualHost}`)
      }

      const result: PlanExecutionResult = {
        success: true,
        message: 'Plan executed successfully',
        steps,
        debugInfo: { schema_version: parsed.schema_version, host_app: parsed.host_app, actual_host: actualHost }
      }
      try {
        const ops: string[] = []
        const collect = (actions: any[]) => {
          for (const a of actions || []) {
            if (a && typeof a.op === 'string') ops.push(a.op)
            if (a && a.op === 'upsert_block' && Array.isArray(a.actions)) collect(a.actions)
          }
        }
        collect(parsed.actions as any)
        const blockId = (() => {
          const find = (actions: any[]): string => {
            for (const a of actions || []) {
              if (a && a.op === 'upsert_block' && typeof a.block_id === 'string') return a.block_id
              if (a && Array.isArray(a.actions)) {
                const nested = find(a.actions)
                if (nested) return nested
              }
            }
            return ''
          }
          return find(parsed.actions as any)
        })()
        void reportAuditEvent({
          mode: 'plan',
          host_app: parsed.host_app,
          block_id: blockId,
          ops: Array.from(new Set(ops)),
          success: true,
          extra: { schema_version: parsed.schema_version }
        })
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      return result
    } catch (error) {
      const msg = _errMsg(error)
      _planDiag('error', `failed: ${msg}`)
      logger.error('[PlanExecutor] execution failed', error)
      try {
        void reportAuditEvent({
          mode: 'plan',
          host_app: wpsBridge.getHostApp() || 'unknown',
          success: false,
          error_type: 'execution_error',
          error_message: msg
        })
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      return { success: false, message: msg, steps, debugInfo: { error: msg } }
    }
  }

  private parsePlan(input: unknown): Plan {
    const obj = typeof input === 'string' ? this.parseJsonLike(input) : input
    if (!obj || typeof obj !== 'object') throw new Error('invalid plan: not an object')
    const normalized = this.normalizePlanObject(obj as any)
    if (normalized.schema_version !== 'ah32.plan.v1') throw new Error('invalid plan: schema_version mismatch')
    if (normalized.host_app !== 'wps' && normalized.host_app !== 'et' && normalized.host_app !== 'wpp') {
      throw new Error('invalid plan: host_app')
    }
    if (!Array.isArray(normalized.actions) || normalized.actions.length === 0) {
      throw new Error('invalid plan: actions')
    }
    return normalized as Plan
  }

  private parseJsonLike(raw: string): any {
    const s = String(raw || '').trim()
    if (!s) return null
    const m = s.match(/```(?:json|plan|ah32[-_.]?plan(?:\.v1)?)?\s*([\s\S]*?)```/i)
    const payload = (m && m[1]) ? String(m[1]).trim() : s
    if (payload.length > this.MAX_PLAN_JSON_CHARS) {
      throw new Error(`invalid plan: json payload too large (${payload.length})`)
    }
    try {
      return JSON.parse(payload)
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      throw new Error('invalid plan: malformed json')
    }
  }

  private normalizePlanObject(input: any): any {
    const p: any = { ...(input || {}) }
    // Accept legacy/alternate field name.
    if (!p.schema_version && p.schema) p.schema_version = p.schema
    if (!p.host_app && p.hostApp) p.host_app = p.hostApp

    const isPlainObject = (v: any): v is Record<string, any> =>
      !!v && typeof v === 'object' && !Array.isArray(v)

    const normOp = (op: any) => {
      const s = String(op || '').trim()
      const map: Record<string, string> = {
        upsertBlock: 'upsert_block',
        deleteBlock: 'delete_block',
        insertText: 'insert_text',
        insertAfterText: 'insert_after_text',
        insertBeforeText: 'insert_before_text',
        insertTable: 'insert_table',
        insertChartFromSelection: 'insert_chart_from_selection',
        insert_chart: 'insert_chart_from_selection',
        insertWordArt: 'insert_word_art',
        setTextStyle: 'set_text_style',
        setCellFormula: 'set_cell_formula',
        setNumberFormat: 'set_number_format',
        setConditionalFormat: 'set_conditional_format',
        setDataValidation: 'set_data_validation',
        sortRange: 'sort_range',
        filterRange: 'filter_range',
        createPivotTable: 'create_pivot_table',
        setSlideBackground: 'set_slide_background',
        setSlideTextStyle: 'set_slide_text_style',
        setSlideTheme: 'set_slide_theme',
        setSlideLayout: 'set_slide_layout',
        setShapeStyle: 'set_shape_style',
        setTableStyle: 'set_table_style',

        setSelection: 'set_selection',
        answerModeApply: 'answer_mode_apply',
      }
      return map[s] || s
    }

    const normKeys = (obj: any): any => {
      if (!obj || typeof obj !== 'object') return obj
      if (Array.isArray(obj)) return obj.map(normKeys)
      const out: any = {}
      for (const [k, v] of Object.entries(obj)) {
        const keyMap: Record<string, string> = {
          blockId: 'block_id',
          anchorText: 'anchor_text',
          newParagraphBefore: 'new_paragraph_before',
          newParagraphAfter: 'new_paragraph_after',
          freezeCursor: 'freeze_cursor',
          chartType: 'chart_type',
          autoFit: 'auto_fit',
          searchWindowChars: 'search_window_chars',
          applyToAll: 'apply_to_all',
          applyToSelection: 'apply_to_selection',
          numberFormat: 'number_format',
          ruleType: 'rule_type',
          minColor: 'min_color',
          midColor: 'mid_color',
          maxColor: 'max_color',
          fillColor: 'fill_color',
          fontColor: 'font_color',
          clearExisting: 'clear_existing',
          validationType: 'validation_type',
          allowBlank: 'allow_blank',
          inCellDropdown: 'in_cell_dropdown',
          showInput: 'show_input',
          showError: 'show_error',
          inputTitle: 'input_title',
          inputMessage: 'input_message',
          errorTitle: 'error_title',
          errorMessage: 'error_message',
          themeName: 'theme_name',
          themeIndex: 'theme_index',
          templatePath: 'template_path',
          hasHeader: 'has_header',
          visibleDropdown: 'visible_dropdown',
          sourceRange: 'source_range',
          tableName: 'table_name',
          replaceExisting: 'replace_existing',
          valueFields: 'values',
          shapeName: 'shape_name',
          lineColor: 'line_color',
          lineWidth: 'line_width',
          textColor: 'text_color',
          styleName: 'style_name',
          firstRow: 'first_row',
          lastRow: 'last_row',
          bandedRows: 'banded_rows',
          bandedColumns: 'banded_columns',
          schema: 'schema_version',
          hostApp: 'host_app'
        }
        const nk = keyMap[k] || k
        out[nk] = normKeys(v)
      }
      if (out.op) out.op = normOp(out.op)
      // actions are normalized later (after params flatten + upsert_block fixes)
      return out
    }

    const normalizeAction = (action: any, fallbackId: string): any => {
      if (!isPlainObject(action)) return action

      // Common model pattern: { op, id, title, params: {...} }. Flatten params for executor.
      let a: any = { ...(action || {}) }
      if (isPlainObject(a.params)) {
        const params = a.params
        delete a.params
        a = { ...params, ...a }
      }

      if (a.op) a.op = normOp(a.op)

      if (a.op === 'insert_chart' as any) a.op = 'insert_chart_from_selection'

      if (a.op === 'insert_chart_from_selection' && (a.chart_type == null || a.chart_type === '')) {
        const dt = String((a as any).data_type || (a as any).chart_type_name || '').trim().toLowerCase()
        const typeMap: Record<string, number> = {
          column: 51,
          bar: 57,
          line: 4,
          pie: 5,
          area: 1,
          scatter: -4169,
        }
        if (dt && typeof typeMap[dt] === 'number') {
          a.chart_type = typeMap[dt]
        }
      }

      if (!a.id) a.id = String(fallbackId || 'step_1')
      if (!a.title) a.title = String(a.op || 'action')

      // Normalize common anchor variants.
      if (a.anchor === 'end_of_document' || a.anchor === 'endOfDocument') a.anchor = 'end'
      if (a.anchor === 'current' || a.anchor === 'cursor') a.anchor = 'cursor'

      if (a.op === 'upsert_block') {
        if (!a.block_id && a.blockId) a.block_id = a.blockId

        // Some models mistakenly put writeback payload as "content" (or "text") directly on upsert_block.
        // Convert it into a nested insert_text action to avoid "actions is not iterable".
        if (!Array.isArray(a.actions) || a.actions.length === 0) {
          const content =
            typeof a.content === 'string'
              ? a.content
              : (typeof a.text === 'string' ? a.text : '')
          if (content && String(content).trim()) {
            a.actions = [
              {
                id: `${a.id}_1`,
                title: 'Insert text',
                op: 'insert_text',
                text: String(content),
                new_paragraph_after: true
              }
            ]
          }
        }
      }

      if (a.op === 'set_cell_formula') {
        if (!a.cell && a.address) a.cell = a.address
        if (!a.formula && typeof a.text === 'string') a.formula = a.text
      }

      if (a.op === 'set_number_format') {
        if (!a.range && a.address) a.range = a.address
        if (!a.number_format && typeof a.format === 'string') a.number_format = a.format
      }

      if (a.op === 'set_conditional_format') {
        if (!a.range && a.address) a.range = a.address
        if (!a.rule_type) a.rule_type = 'color_scale'
        if (a.clear_existing == null) a.clear_existing = true
      }

      if (a.op === 'set_data_validation') {
        if (!a.range && a.address) a.range = a.address
        if (!a.validation_type) a.validation_type = 'list'
        if (!a.formula1 && typeof a.source === 'string') a.formula1 = a.source
        if (!a.formula1 && typeof a.value === 'string') a.formula1 = a.value
        if (a.allow_blank == null) a.allow_blank = true
        if (a.in_cell_dropdown == null) a.in_cell_dropdown = true
        if (a.show_input == null) a.show_input = true
        if (a.show_error == null) a.show_error = true
      }

      if (a.op === 'sort_range') {
        if (!a.range && a.address) a.range = a.address
        if (!a.key && a.sort_by) a.key = a.sort_by
        if (!a.order) a.order = 'asc'
        if (a.has_header == null) a.has_header = false
      }

      if (a.op === 'filter_range') {
        if (!a.range && a.address) a.range = a.address
        if (!a.criteria1 && typeof a.criteria === 'string') a.criteria1 = a.criteria
        if (a.visible_dropdown == null) a.visible_dropdown = true
      }

      if (a.op === 'create_pivot_table') {
        if (!a.source_range && a.source) a.source_range = a.source
        if (!a.destination && a.dest) a.destination = a.dest
        if (!Array.isArray(a.rows)) a.rows = []
        if (!Array.isArray(a.columns)) a.columns = []
        if (!Array.isArray(a.values) && Array.isArray(a.value_fields)) a.values = a.value_fields
        if (!Array.isArray(a.values)) a.values = []
        if (!Array.isArray(a.filters)) a.filters = []
        if (a.replace_existing == null) a.replace_existing = true
      }

      if (a.op === 'set_slide_background') {
        if (!a.color && typeof a.fill === 'string') a.color = a.fill
        if (a.apply_to_all == null) a.apply_to_all = false
      }

      if (a.op === 'set_slide_text_style') {
        if (a.apply_to_all == null) a.apply_to_all = false
      }

      if (a.op === 'set_slide_theme') {
        if (a.apply_to_all == null) a.apply_to_all = true
      }

      if (a.op === 'set_slide_layout') {
        if (a.apply_to_all == null) a.apply_to_all = false
      }

      if (a.op === 'set_shape_style') {
        if (a.apply_to_all == null) a.apply_to_all = false
      }

      if (a.op === 'set_table_style') {
        if (a.apply_to_all == null) a.apply_to_all = false
      }

      if (a.op === 'set_text_style') {
        if (a.apply_to_selection == null) a.apply_to_selection = true
      }

      if (Array.isArray(a.actions)) {
        a.actions = a.actions.map((child: any, i: number) => normalizeAction(child, `${a.id}_${i + 1}`))
      }

      return a
    }

    const base = normKeys(p)
    try {
      if (isPlainObject(base) && Array.isArray((base as any).actions)) {
        ;(base as any).actions = (base as any).actions.map((a: any, i: number) =>
          normalizeAction(a, `step_${i + 1}`)
        )
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }

    return base
  }

  private detectHostFromApplication(app: any): 'wps' | 'et' | 'wpp' | 'unknown' {
    try {
      if (!app) return 'unknown'
      try {
        if (app.ActiveDocument || app.Documents) return 'wps'
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      try {
        if (app.ActiveWorkbook || app.Workbooks) return 'et'
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      try {
        if (app.ActivePresentation || app.Presentations) return 'wpp'
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      return 'unknown'
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      return 'unknown'
    }
  }

  private executeActions(
    ctx: { app: any; doc: any; selection: any },
    actions: PlanAction[],
    emit: (step: PlanExecutionStep) => void
  ) {
    for (const action of actions) {
      const ts = Date.now()
      emit({
        id: action.id,
        title: action.title,
        op: action.op,
        content: `op=${action.op}`,
        status: 'processing',
        timestamp: ts
      })
      try {
        this.executeAction(ctx, action, emit)
        emit({
          id: action.id,
          title: action.title,
          op: action.op,
          content: `op=${action.op} status=completed`,
          status: 'completed',
          timestamp: Date.now()
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        emit({
          id: action.id,
          title: action.title,
          op: action.op,
          content: `op=${action.op} status=error`,
          status: 'error',
          timestamp: Date.now(),
          error: msg
        })
        throw e
      }
    }
  }

  private executeAction(
    ctx: { app: any; doc: any; selection: any },
    action: PlanAction,
    emit: (step: PlanExecutionStep) => void
  ) {
    switch (action.op) {
      case 'set_selection':

        this.setSelection(
          ctx.selection,
          (action as any).anchor,
          (action as any).offset_lines,
          (action as any).offset_chars
        )

        return

      case 'insert_text':
        this.insertText(ctx.selection, action.text, action.new_paragraph_before, action.new_paragraph_after)
        return
      case 'insert_after_text':
        this.insertAfterText(
          ctx.doc,
          action.anchor_text,
          action.text,
          action.new_paragraph_before,
          action.new_paragraph_after
        )
        return
      case 'insert_before_text':
        this.insertBeforeText(
          ctx.doc,
          action.anchor_text,
          action.text,
          action.new_paragraph_before,
          action.new_paragraph_after
        )
        return
      case 'insert_table':
        this.insertTable(ctx.doc, ctx.selection, action)
        return
      case 'insert_chart_from_selection':
        this.insertChartFromSelection(ctx.doc, ctx.selection, action)
        return
      case 'insert_word_art':
        this.insertWordArt(ctx.doc, ctx.selection, action)
        return
      case 'set_text_style':
        this.setTextStyle(ctx.doc, ctx.selection, action as any)
        return
      case 'answer_mode_apply':
        this.answerModeApply(ctx, action as any)
        return
      case 'delete_block':
        this.deleteBlock(ctx.doc, action.block_id)
        return
      case 'upsert_block':
        this.upsertBlock(ctx, action, emit)
        return
      default:
        throw new Error(`unsupported op: ${(action as any)?.op}`)
    }
  }

  private getActiveDocument(app: any): any {
    try {
      return app.ActiveDocument || null
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      return null
    }
  }

  private getSelection(app: any): any {
    try {
      return app.Selection || null
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      return null
    }
  }

  private getActiveWorkbook(app: any): any {
    try {
      return app.ActiveWorkbook || (app.Workbooks && app.Workbooks.Count > 0 ? app.Workbooks.Item(1) : null)
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      return null
    }
  }

  private getActivePresentation(app: any): any {
    try {
      return app.ActivePresentation || (app.Presentations && app.Presentations.Count > 0 ? app.Presentations.Item(1) : null)
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      return null
    }
  }

  private safe<T>(fn: () => T, fallback: T | null = null): T | null {
    try {
      return fn()
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      return fallback
    }
  }

  private freezeSelection(sel: any): Record<string, any> {
    const saved: Record<string, any> = {}
    if (!sel) return saved

    // Do NOT monkey-patch Selection methods (EndKey/HomeKey/GoTo) - some WPS builds expose these
    // as non-configurable properties and will throw "Cannot redefine property".
    // Instead, capture the current selection range and restore it after the upsert_block completes.
    try {
      let start: any = null
      let end: any = null

      try {
        const r = this.safe(() => sel.Range)
        if (r) {
          start = this.safe(() => (r as any).Start)
          end = this.safe(() => (r as any).End)
        }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }

      if (typeof start !== 'number') start = this.safe(() => (sel as any).Start)
      if (typeof end !== 'number') end = this.safe(() => (sel as any).End)

      if (typeof start === 'number' && typeof end === 'number') {
        saved.__range_start = start
        saved.__range_end = end
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }

    return saved
  }

  private _hexToBgrLong(colorHex: string): number | null {
    try {
      const s = String(colorHex || '').trim().replace(/^#/, '')
      if (!/^[0-9a-fA-F]{6}$/.test(s)) return null
      const r = parseInt(s.slice(0, 2), 16)
      const g = parseInt(s.slice(2, 4), 16)
      const b = parseInt(s.slice(4, 6), 16)
      return (b << 16) | (g << 8) | r
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      return null
    }
  }

  private setTextStyle(doc: any, selection: any, action: SetTextStyleAction) {
    const target = this.safe(() => selection?.Range) || this.safe(() => doc?.Content)
    if (!target) throw new Error('set_text_style target range not available')

    const font = this.safe(() => (target as any).Font)
    if (!font) throw new Error('set_text_style font not available')

    const fontName = String((action as any)?.font || '').trim()
    const sizeRaw = (action as any)?.size
    const hasSize = Number.isFinite(Number(sizeRaw)) && Number(sizeRaw) > 0
    const boldRaw = (action as any)?.bold
    const italicRaw = (action as any)?.italic
    const colorRaw = String((action as any)?.color || '').trim()
    const color = colorRaw ? this._hexToBgrLong(colorRaw) : null

    if (fontName) this.safe(() => ((font as any).Name = fontName))
    if (hasSize) this.safe(() => ((font as any).Size = Number(sizeRaw)))
    if (typeof boldRaw === 'boolean') this.safe(() => ((font as any).Bold = boldRaw ? 1 : 0))
    if (typeof italicRaw === 'boolean') this.safe(() => ((font as any).Italic = italicRaw ? 1 : 0))
    if (color != null) this.safe(() => ((font as any).Color = color))
  }

  private restoreSelection(sel: any, saved: Record<string, any> | null) {
    if (!sel || !saved) return

    // Restore selection range first (best-effort).
    try {
      const start = (saved as any).__range_start
      const end = (saved as any).__range_end
      if (typeof start === 'number' && typeof end === 'number') {
        if (typeof (sel as any).SetRange === 'function') {
          this.safe(() => (sel as any).SetRange(start, end))
        } else {
          const r = this.safe(() => (sel as any).Range)
          if (r && typeof (r as any).SetRange === 'function') this.safe(() => (r as any).SetRange(start, end))
        }
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }

    // Legacy restore: if we ever store other patched fields, restore them too.
    for (const k of Object.keys(saved)) {
      if (k === '__range_start' || k === '__range_end') continue
      try {
        ;(sel as any)[k] = (saved as any)[k]
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
    }
  }

  private answerModeApply(ctx: { app: any; doc: any; selection: any }, action: AnswerModeApplyAction) {
    const bid = (globalThis as any).BID || (globalThis as any).window?.BID
    if (!bid || typeof bid.answerModeApply !== 'function') {
      throw new Error('BID.answerModeApply not available (js-macro runtime not loaded)')
    }

    const answers = Array.isArray(action.answers) ? action.answers : []
    if (!answers.length) throw new Error('answer_mode_apply: answers is empty')

    const opts: any = {}
    if (typeof action.block_id === 'string' && action.block_id.trim()) opts.blockId = action.block_id.trim()
    if (action.strict === false) opts.strict = false
    if (typeof action.search_window_chars === 'number' && isFinite(action.search_window_chars)) {
      opts.searchWindowChars = action.search_window_chars
    }
    if (action.backup === false) opts.backup = false

    const res = bid.answerModeApply(answers, opts)
    try {
      const ok = (res && typeof res === 'object' && 'ok' in res) ? String((res as any).ok) : 'true'
      _planDiag('info', `answer_mode_apply ok=${ok} answers=${answers.length}`)
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }
  }

  private tag(id: string, kind: 'START' | 'END'): string {
    return `[[AH32:${String(id || 'ah32_auto')}:${kind}]]`
  }

  private bookmarkName(blockId: string): string {
    // Word/WPS bookmark names are restrictive; keep it short and safe.
    let s = String(blockId || 'ah32_auto').replace(/[^a-zA-Z0-9_]/g, '_')
    if (!/^[a-zA-Z]/.test(s)) s = `B_${s}`
    s = `AH32_${s}`
    // Word bookmark name max length is typically 40; keep under that.
    if (s.length > 40) s = s.slice(0, 40)
    return s
  }

  private getBookmarkRange(doc: any, name: string): any {
    try {
      const bms = this.safe(() => doc?.Bookmarks)
      if (!bms) return null

      // Exists(name) is not guaranteed; use it if available.
      try {
        if (typeof (bms as any).Exists === 'function') {
          const ok = this.safe(() => !!(bms as any).Exists(name), false as any) as any
          if (!ok) return null
        }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }

      const bm = this.resolveBookmark(bms, name)

      const r = bm ? this.safe(() => (bm as any).Range) : null
      return r
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      return null
    }
  }

  private deleteBookmark(doc: any, name: string) {
    try {
      const bms = this.safe(() => doc?.Bookmarks)
      if (!bms) return

      const bm = this.resolveBookmark(bms, name)

      if (bm && typeof (bm as any).Delete === 'function') this.safe(() => (bm as any).Delete())
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }
  }

  private resolveBookmark(bookmarks: any, name: string): any {
    try {
      if (!bookmarks || !name) return null

      // 1) Common object-model path.
      const byItemName = this.safe(() => (typeof (bookmarks as any).Item === 'function' ? (bookmarks as any).Item(name) : null))
      if (byItemName) return byItemName

      // 2) Some runtimes expose indexer-like property access.
      const byIndexer = this.safe(() => ((bookmarks as any)[name] ? (bookmarks as any)[name] : null))
      if (byIndexer) return byIndexer

      // 3) Only call as function when collection itself is callable.
      if (typeof bookmarks === 'function') {
        const byCallable = this.safe(() => (bookmarks as any)(name))
        if (byCallable) return byCallable
      }

      // 4) Fallback: iterate by numeric index and compare Name.
      const count = this.safe(() => Number((bookmarks as any).Count || 0), 0 as any) as any
      if (typeof count === 'number' && count > 0 && typeof (bookmarks as any).Item === 'function') {
        for (let index = 1; index <= count; index++) {
          const candidate = this.safe(() => (bookmarks as any).Item(index))
          if (!candidate) continue
          const candidateName = this.safe(() => String((candidate as any).Name || ''), '' as any)
          if (String(candidateName || '') === String(name)) return candidate
        }
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }
    return null
  }

  private getDocRange(doc: any, start: number, end: number): any {
    const direct = this.safe(() => doc.Range(start, end))
    if (direct) return direct
    const r = this.safe(() => doc.Range())
    if (r && typeof r.SetRange === 'function') {
      this.safe(() => r.SetRange(start, end))
      return r
    }
    return null
  }

  private findTextRange(doc: any, text: string, startAt?: number): any {
    try {
      const r = doc.Range()
      if (typeof startAt === 'number') {
        this.safe(() => r.SetRange(startAt, r.End))
      }
      if (r && r.Find) {
        this.safe(() => r.Find.ClearFormatting && r.Find.ClearFormatting())
        this.safe(() => (r.Find.Text = text))
        this.safe(() => (r.Find.Forward = true))
        this.safe(() => (r.Find.Wrap = 0))
        const ok = this.safe(() => !!r.Find.Execute(), false as any) as any
        if (ok) return r
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }

    try {
      const full = doc.Range()
      const t = String(full.Text || '')
      const from = typeof startAt === 'number' ? startAt : 0
      const idx = t.indexOf(text, from)
      if (idx >= 0) return this.getDocRange(doc, idx, idx + text.length)
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }

    return null
  }

  private formatMarkerRange(rng: any) {
    if (!rng) return
    // IMPORTANT: Do NOT use Font.Hidden for markers.
    // Some WPS runtimes fail to Find() hidden text, causing "markers missing" and breaking idempotency.
    this.safe(() => (rng.Font.Hidden = 0))
    this.safe(() => (rng.Font.Hidden = false))
    this.safe(() => (rng.Font.Size = 1))
    // Best-effort: make it visually unobtrusive (white on default page background).
    try {
      let RGB = (window as any).RGB
      if (typeof RGB !== 'function') {
        RGB = function (r: any, g: any, b: any) {
          const rr = Number(r) & 255
          const gg = Number(g) & 255
          const bb = Number(b) & 255
          return rr + (gg << 8) + (bb << 16)
        }
      }
      if (typeof RGB === 'function') {
        this.safe(() => (rng.Font.Color = RGB(255, 255, 255)))
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }
  }

  private snapshotFont(range: any): Record<string, any> | null {
    try {
      if (!range) return null
      const font = this.safe(() => range.Font)
      if (!font) return null
      const out: Record<string, any> = {}
      const keys = ['Name', 'Size', 'Bold', 'Italic', 'Underline', 'Color', 'Hidden']
      for (const k of keys) {
        try {
          out[k] = (font as any)[k]
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
        }
      }
      return out
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      return null
    }
  }

  private restoreFont(range: any, snapshot: Record<string, any> | null) {
    try {
      if (!range || !snapshot) return
      const font = this.safe(() => range.Font)
      if (!font) return
      for (const [k, v] of Object.entries(snapshot)) {
        try {
          ;(font as any)[k] = v
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
        }
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }
  }

  private clearHiddenFormattingForRange(rng: any) {
    if (!rng) return
    try {
      this.safe(() => (rng.Font.Hidden = 0))
      this.safe(() => (rng.Font.Hidden = false))
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }
  }

  private insertParagraphAfter(selection: any) {
    const r = this.safe(() => selection?.Range)
    if (r && typeof r.InsertParagraphAfter === 'function') {
      this.safe(() => r.InsertParagraphAfter())
      return
    }
    if (selection && typeof selection.TypeParagraph === 'function') {
      this.safe(() => selection.TypeParagraph())
      return
    }
    if (r) this.safe(() => (r.Text = '\n'))
  }

  private insertParagraphBefore(range: any) {
    if (range && typeof range.InsertParagraphBefore === 'function') {
      this.safe(() => range.InsertParagraphBefore())
      return
    }
    // Best-effort: no-op if not supported.
  }

  private setSelection(
    selection: any,
    anchor: SelectionAnchor,
    offsetLines?: number,
    offsetChars?: number
  ) {
    const wdMove = 0
    const wdStory = 6
    const wdLine = 5
    const wdCharacter = 1

    if (!selection) throw new Error('set_selection: selection not available')

    try {
      if (anchor === 'start_of_document') selection.StartOf(wdStory, wdMove)
      else if (anchor === 'end_of_document') selection.EndOf(wdStory, wdMove)
      // cursor: keep current selection
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      throw new Error(`set_selection: failed to move to anchor=${String(anchor || '')}`)
    }

    const l = Number(offsetLines || 0)
    if (l) {
      try {
        if (l > 0) selection.MoveDown(wdLine, l, wdMove)
        else selection.MoveUp(wdLine, Math.abs(l), wdMove)
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
        throw new Error(`set_selection: failed to offset_lines=${String(offsetLines)}`)
      }
    }

    const c = Number(offsetChars || 0)
    if (c) {
      try {
        if (c > 0) selection.MoveRight(wdCharacter, c, wdMove)
        else selection.MoveLeft(wdCharacter, Math.abs(c), wdMove)
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
        throw new Error(`set_selection: failed to offset_chars=${String(offsetChars)}`)
      }
    }
  }

  private insertText(selection: any, text: string, before?: boolean, after?: boolean) {
    const r = this.safe(() => selection?.Range)
    if (!r) throw new Error('selection range not available')
    if (before) this.insertParagraphBefore(r)
    // Macro markers may set Hidden formatting; ensure user-visible text stays visible.
    this.clearHiddenFormattingForRange(r)
    try {
      ;(r as any).Text = String(text || '')
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      throw new Error(`insert_text failed: ${_errMsg(e)}`)
    }
    if (after) this.insertParagraphAfter(selection)
  }

  private insertAfterText(doc: any, anchorText: string, insertText: string, before?: boolean, after?: boolean) {
    const anchor = this.findTextRange(doc, String(anchorText || '').trim())
    if (!anchor) throw new Error(`anchor not found: ${String(anchorText || '')}`)
    const pos = anchor.End
    const r = this.getDocRange(doc, pos, pos)
    if (!r) throw new Error('failed to get insert range')
    if (before) this.insertParagraphBefore(r)
    this.clearHiddenFormattingForRange(r)
    try {
      ;(r as any).Text = String(insertText || '')
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      throw new Error(`insert_after_text failed: ${_errMsg(e)}`)
    }
    if (after) this.safe(() => r.InsertParagraphAfter && r.InsertParagraphAfter())
  }

  private insertBeforeText(doc: any, anchorText: string, insertText: string, before?: boolean, after?: boolean) {
    const anchor = this.findTextRange(doc, String(anchorText || '').trim())
    if (!anchor) throw new Error(`anchor not found: ${String(anchorText || '')}`)
    const pos = anchor.Start
    const r = this.getDocRange(doc, pos, pos)
    if (!r) throw new Error('failed to get insert range')
    if (before) this.insertParagraphBefore(r)
    this.clearHiddenFormattingForRange(r)
    try {
      ;(r as any).Text = String(insertText || '')
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      throw new Error(`insert_before_text failed: ${_errMsg(e)}`)
    }
    if (after) this.safe(() => r.InsertParagraphAfter && r.InsertParagraphAfter())
  }

  private insertTable(doc: any, selection: any, action: InsertTableAction) {
    const r = this.safe(() => selection?.Range)
    if (!r) throw new Error('selection range not available')
    const rows = Number(action.rows) || 2
    const cols = Number(action.cols) || 2

    let table = this.safe(() => doc.Tables.Add(r, rows, cols))
    if (!table) table = this.safe(() => r.Tables?.Add(r, rows, cols))
    if (!table) table = this.safe(() => doc.Tables.Add(r, rows, cols, 1, 1) as any)
    if (!table) throw new Error('insert_table failed')

    if (action.borders === false) this.safe(() => (table.Borders.Enable = 0))
    if (action.borders === true) this.safe(() => (table.Borders.Enable = 1))
    if (action.style) this.safe(() => (table.Style = action.style))
    if (typeof action.auto_fit === 'number') this.safe(() => table.AutoFitBehavior && table.AutoFitBehavior(action.auto_fit))
    if (action.header) this.safe(() => table.Rows && table.Rows(1).HeadingFormat && (table.Rows(1).HeadingFormat = 1))
  }

  private insertChartFromSelection(doc: any, _selection: any, action: InsertChartFromSelectionAction) {
    const chartType = action.chart_type || 51

    let shape = this.safe(() => doc.InlineShapes.AddChart2(chartType))
    if (!shape) shape = this.safe(() => doc.Shapes.AddChart2(chartType))
    if (!shape) throw new Error('insert_chart_from_selection failed')

    if (action.width) this.safe(() => (shape.Width = action.width))
    if (action.height) this.safe(() => (shape.Height = action.height))
  }

  private insertWordArt(doc: any, selection: any, action: InsertWordArtAction) {
    const t = String(action.text || '')
    const preset = action.preset || 1
    const font = action.font || '微软雅黑'
    const size = Number(action.size) || 36
    const bold = !!action.bold
    const italic = !!action.italic

    let shape = this.safe(() => doc.Shapes.AddTextEffect(preset, t, font, size, bold, italic, 0, 0))
    if (!shape) shape = this.safe(() => doc.Shapes.AddTextEffect(preset, t, font, size, bold, italic))
    if (!shape) throw new Error('insert_word_art failed')

    // Some WPS builds expose `Shape.Anchor` as non-writable/non-configurable.
    // Attempting to assign it may throw and can destabilize the taskpane runtime.
  }

  private deleteBlock(doc: any, blockId: string) {
    const id = String(blockId || 'ah32_auto')

    // Prefer bookmarks (invisible, more reliable than hidden marker text in some WPS builds).
    try {
      const name = this.bookmarkName(id)
      const r = this.getBookmarkRange(doc, name)
      if (r) {
        this.safe(() => (r.Text = ''))
        this.safe(() => r.Delete && r.Delete())
        this.deleteBookmark(doc, name)
        return
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }

    const startTag = this.tag(id, 'START')
    const endTag = this.tag(id, 'END')
    const startR = this.findTextRange(doc, startTag)
    if (!startR) return
    const endR = this.findTextRange(doc, endTag, startR.End)
    if (!endR) return

    const r = this.getDocRange(doc, startR.Start, endR.End)
    if (!r) return
    this.safe(() => (r.Text = ''))
    this.safe(() => r.Delete && r.Delete())
  }

  private upsertBlock(
    ctx: { app: any; doc: any; selection: any },
    action: UpsertBlockAction,
    emit: (step: PlanExecutionStep) => void
  ) {
    const id = String(action.block_id || 'ah32_auto')
    const startTag = this.tag(id, 'START')
    const endTag = this.tag(id, 'END')

    // Optional anchor control (best-effort).
    if (action.anchor === 'end') {
      try {
        const endPos = this.safe(() => ctx.doc.Range().End)
        if (typeof endPos === 'number') {
          this.safe(() => ctx.selection.SetRange && ctx.selection.SetRange(endPos, endPos))
          this.safe(() => ctx.selection.Range?.SetRange && ctx.selection.Range.SetRange(endPos, endPos))
          const endRng = this.getDocRange(ctx.doc, endPos, endPos)
          this.safe(() => endRng && endRng.Select && endRng.Select())
        }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
    }

    // Default: keep cursor stable inside the upsert block to avoid duplicates on re-run.
    // Some WPS runtimes expose Selection members as read-only/non-configurable; freezing must be best-effort.
    let savedSelection: Record<string, any> | null = null
    if (action.freeze_cursor !== false) {
      try {
        savedSelection = this.freezeSelection(ctx.selection)
      } catch (e) {
        const msg = _errMsg(e)
        _planDiag('warning', `freezeSelection failed, continue without freeze: ${msg}`)
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
        savedSelection = null
      }
    }

    // Prefer bookmark-based block tracking when available (more reliable than hidden text markers).
    // This avoids failures like: "upsert_block markers missing after create" on some WPS builds.
    const bmName = this.bookmarkName(id)
    let usedBookmark = false
    try {
      const bms = this.safe(() => ctx.doc?.Bookmarks)
      if (bms && bmName) {
        const bmRange = this.getBookmarkRange(ctx.doc, bmName)
        if (bmRange) {
          const startPos = this.safe(() => (bmRange as any).Start)
          const endPos = this.safe(() => (bmRange as any).End)
          if (typeof startPos === 'number' && typeof endPos === 'number' && endPos >= startPos) {
            const r = this.getDocRange(ctx.doc, startPos, endPos)
            if (r) this.safe(() => ((r as any).Text = ''))

            this.safe(() => ctx.selection.SetRange && ctx.selection.SetRange(startPos, startPos))
            this.safe(() => ctx.selection.Range?.SetRange && ctx.selection.Range.SetRange(startPos, startPos))

            this.executeActions(ctx, action.actions, emit)

            const afterR = this.safe(() => ctx.selection?.Range)
            const newEnd = afterR ? this.safe(() => (afterR as any).End) : null
            const finalEnd = typeof newEnd === 'number' ? newEnd : startPos

            this.deleteBookmark(ctx.doc, bmName)
            const r2 = this.getDocRange(ctx.doc, startPos, finalEnd)
            if (r2) this.safe(() => (bms as any).Add && (bms as any).Add(bmName, r2))
            usedBookmark = true
            return
          }
        } else {
          const selR = this.safe(() => ctx.selection?.Range)
          const startPos = selR ? this.safe(() => (selR as any).Start) : null

          this.executeActions(ctx, action.actions, emit)

          const afterR = this.safe(() => ctx.selection?.Range)
          const endPos = afterR ? this.safe(() => (afterR as any).End) : null
          if (typeof startPos === 'number' && typeof endPos === 'number' && endPos >= startPos) {
            this.deleteBookmark(ctx.doc, bmName)
            const r2 = this.getDocRange(ctx.doc, startPos, endPos)
            if (r2) this.safe(() => (bms as any).Add && (bms as any).Add(bmName, r2))
            usedBookmark = true
            return
          }
        }
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    } finally {
      if (usedBookmark && savedSelection) this.restoreSelection(ctx.selection, savedSelection)
    }

    let startR = this.findTextRange(ctx.doc, startTag)
    let endR = startR ? this.findTextRange(ctx.doc, endTag, startR.End) : null

    // Create new block.
    if (!startR || !endR) {
      const selRange = this.safe(() => ctx.selection?.Range)
      if (!selRange) throw new Error('selection range not available')

      try {
        const fontSnap = this.snapshotFont(selRange)
        this.clearHiddenFormattingForRange(selRange)
        try {
          ;(selRange as any).Text = startTag
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
          throw new Error(`upsert_block failed to insert start marker: ${_errMsg(e)}`)
        }
        this.formatMarkerRange(selRange)
        this.insertParagraphAfter(ctx.selection)
        try {
          const r2 = this.safe(() => ctx.selection?.Range)
          this.clearHiddenFormattingForRange(r2)
          // Restore original font so inserted content doesn't inherit marker formatting (white/size=1).
          this.restoreFont(r2, fontSnap)
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
        }

        this.executeActions(ctx, action.actions, emit)

        this.insertParagraphAfter(ctx.selection)
        const endRange = this.safe(() => ctx.selection?.Range)
        if (!endRange) throw new Error('selection range not available')
        this.clearHiddenFormattingForRange(endRange)
        try {
          ;(endRange as any).Text = endTag
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
          throw new Error(`upsert_block failed to insert end marker: ${_errMsg(e)}`)
        }
        this.formatMarkerRange(endRange)
        this.insertParagraphAfter(ctx.selection)
        const s2 = this.findTextRange(ctx.doc, startTag)
        const e2 = s2 ? this.findTextRange(ctx.doc, endTag, s2.End) : null
        if (!s2 || !e2) {
          // Do not hard-fail the writeback. Markers are only used for idempotency; some WPS builds
          // fail to Find hidden marker text reliably. The content has already been written.
          try {
            _planDiag(
              'warning',
              'markers missing after create; writeback succeeded but idempotency may be degraded (prefer bookmark mode)'
            )
          } catch (e) {
            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
          }
        }
        return
      } finally {
        if (savedSelection) this.restoreSelection(ctx.selection, savedSelection)
      }
    }

    // Update existing block: clear inner content and run again at the same position.
    const contentStart = startR.End
    const contentEnd = endR.Start
    if (typeof contentStart === 'number' && typeof contentEnd === 'number' && contentEnd >= contentStart) {
      const inner = this.getDocRange(ctx.doc, contentStart, contentEnd)
      if (inner) {
        this.safe(() => (inner.Text = ''))
        // NOTE: Avoid calling Delete() after setting Text='' - some WPS builds may over-delete,
        // removing our hidden block markers and breaking idempotency.
      }

      const anchor = this.getDocRange(ctx.doc, contentStart, contentStart)
      this.safe(() => anchor && anchor.Select && anchor.Select())
      this.safe(() => ctx.selection.SetRange && ctx.selection.SetRange(contentStart, contentStart))
      this.safe(() => ctx.selection.Range?.SetRange && ctx.selection.Range.SetRange(contentStart, contentStart))
    }

    // Re-find tags in case selection moves caused range invalidation.
    startR = this.findTextRange(ctx.doc, startTag)
    endR = startR ? this.findTextRange(ctx.doc, endTag, startR.End) : null
    if (!startR || !endR) {
      // Best-effort recovery: recreate the block at cursor rather than failing the whole writeback.
      try { _planDiag('warning', `markers missing for block_id=${id}; recreating block at cursor`) } catch (e) { ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e) }
      try {
        const selRange2 = this.safe(() => ctx.selection?.Range)
        if (!selRange2) throw new Error('selection range not available')

        this.safe(() => (selRange2.Text = startTag))
        this.formatMarkerRange(selRange2)
        this.insertParagraphAfter(ctx.selection)

        this.executeActions(ctx, action.actions, emit)

        this.insertParagraphAfter(ctx.selection)
        const endRange2 = this.safe(() => ctx.selection?.Range)
        if (!endRange2) throw new Error('selection range not available')
        this.safe(() => (endRange2.Text = endTag))
        this.formatMarkerRange(endRange2)
        this.insertParagraphAfter(ctx.selection)
        return
      } finally {
        if (savedSelection) this.restoreSelection(ctx.selection, savedSelection)
      }
    }

    try {
      this.executeActions(ctx, action.actions, emit)
    } finally {
      if (savedSelection) this.restoreSelection(ctx.selection, savedSelection)
    }
  }

  // ----------------------- ET (Spreadsheets) -----------------------

  private sanitizeSheetName(name: string): string {
    let s = String(name || 'AH32')
    s = s.replace(/[:\\/\?\*\[\]]/g, '_')
    if (s.length > 31) s = s.slice(0, 31)
    if (!s) s = 'AH32'
    return s
  }

  private getOrCreateSheet(wb: any, sheetName: string): any {
    const sheets = this.safe(() => wb.Worksheets)
    if (!sheets) throw new Error('Worksheets not available')
    const count = Number(this.safe(() => sheets.Count, 0)) || 0
    for (let i = 1; i <= count; i++) {
      const s = this.safe(() => sheets.Item(i))
      if (!s) continue
      const n = String(this.safe(() => s.Name, '') || '')
      if (n === sheetName) return s
    }
    const created = this.safe(() => sheets.Add())
    if (!created) throw new Error('failed to create worksheet')
    this.safe(() => (created.Name = sheetName))
    return created
  }

  private clearSheet(sheet: any) {
    const ok = this.safe(() => (sheet.Cells && typeof sheet.Cells.Clear === 'function' ? sheet.Cells.Clear() : null))
    if (ok !== null) return
    this.safe(() => (sheet.UsedRange && typeof sheet.UsedRange.Clear === 'function' ? sheet.UsedRange.Clear() : null))
  }

  private activateSheet(sheet: any) {
    this.safe(() => (typeof sheet.Activate === 'function' ? sheet.Activate() : null))
  }

  private selectA1(sheet: any) {
    try {
      const r = this.safe(() => sheet.Range('A1'))
      if (r && typeof r.Select === 'function') {
        this.safe(() => r.Select())
        return
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }
    try {
      const cell = this.safe(() => sheet.Cells(1, 1))
      if (cell && typeof cell.Select === 'function') {
        this.safe(() => cell.Select())
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }
  }

  private insertTextEt(selection: any, text: string) {
    const s = selection
    if (!s) throw new Error('selection not available')
    // Prefer Value assignment on Range.
    const setValue = () => {
      try {
        if ('Value' in s) {
          ;(s as any).Value = String(text || '')
          return true
        }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      try {
        if (s.Cells && s.Cells(1, 1) && 'Value' in s.Cells(1, 1)) {
          s.Cells(1, 1).Value = String(text || '')
          return true
        }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      return false
    }
    if (!setValue()) throw new Error('failed to write cell value')
  }

  private setCellFormulaEt(app: any, selection: any, action: SetCellFormulaAction) {
    const cellAddr = String((action as any)?.cell || '').trim()
    const formulaRaw = String((action as any)?.formula || '').trim()
    if (!cellAddr) throw new Error('set_cell_formula requires cell')
    if (!formulaRaw) throw new Error('set_cell_formula requires formula')

    const sel = selection || this.safe(() => app?.Selection)
    const sheet = this.safe(() => sel?.Worksheet) || this.safe(() => app?.ActiveSheet)
    if (!sheet) throw new Error('ET active sheet not available')

    const cell = this.safe(() => (sheet as any).Range(cellAddr))
    if (!cell) throw new Error(`invalid cell address: ${cellAddr}`)

    const formula = formulaRaw.startsWith('=') ? formulaRaw : `=${formulaRaw}`
    let wrote = false
    wrote = !!this.safe(() => {
      ;(cell as any).Formula = formula
      return true
    }, false as any)
    if (!wrote) {
      wrote = !!this.safe(() => {
        ;(cell as any).Value = formula
        return true
      }, false as any)
    }
    if (!wrote) throw new Error('failed to set formula')
  }

  private setNumberFormatEt(app: any, selection: any, action: SetNumberFormatAction) {
    const rangeAddr = String((action as any)?.range || '').trim()
    const format = String((action as any)?.number_format || '').trim()
    if (!rangeAddr) throw new Error('set_number_format requires range')
    if (!format) throw new Error('set_number_format requires number_format')

    const sel = selection || this.safe(() => app?.Selection)
    const sheet = this.safe(() => sel?.Worksheet) || this.safe(() => app?.ActiveSheet)
    if (!sheet) throw new Error('ET active sheet not available')
    const rng = this.safe(() => (sheet as any).Range(rangeAddr))
    if (!rng) throw new Error(`invalid range address: ${rangeAddr}`)

    const ok = !!this.safe(() => {
      ;(rng as any).NumberFormat = format
      return true
    }, false as any)
    if (!ok) throw new Error('failed to set number format')
  }

  private etConditionOperator(operator: string | null | undefined): number | null {
    const key = String(operator || '').trim().toLowerCase()
    const map: Record<string, number> = {
      between: 1,
      not_between: 2,
      equal: 3,
      not_equal: 4,
      greater_than: 5,
      less_than: 6,
      greater_or_equal: 7,
      less_or_equal: 8,
    }
    return map[key] ?? null
  }

  private setConditionalFormatEt(app: any, selection: any, action: SetConditionalFormatAction) {
    const rangeAddr = String((action as any)?.range || '').trim()
    if (!rangeAddr) throw new Error('set_conditional_format requires range')

    const sel = selection || this.safe(() => app?.Selection)
    const sheet = this.safe(() => sel?.Worksheet) || this.safe(() => app?.ActiveSheet)
    if (!sheet) throw new Error('ET active sheet not available')
    const rng = this.safe(() => (sheet as any).Range(rangeAddr))
    if (!rng) throw new Error(`invalid range address: ${rangeAddr}`)

    const clearExisting = (action as any)?.clear_existing !== false
    if (clearExisting) {
      this.safe(() => (rng as any)?.FormatConditions?.Delete?.())
    }

    const formatConditions = this.safe(() => (rng as any)?.FormatConditions)
    if (!formatConditions) throw new Error('FormatConditions not available')

    const ruleType = String((action as any)?.rule_type || 'color_scale').trim().toLowerCase()
    if (ruleType === 'color_scale') {
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'et',
        op: 'set_conditional_format',
        branch: 'color_scale',
        fallback: false,
        success: true,
      })
      const cs = this.safe(() => (formatConditions as any).AddColorScale?.(3))
      if (!cs) throw new Error('failed to add color scale')
      const minColor = this._hexToBgrLong(String((action as any)?.min_color || '').trim())
      const midColor = this._hexToBgrLong(String((action as any)?.mid_color || '').trim())
      const maxColor = this._hexToBgrLong(String((action as any)?.max_color || '').trim())

      if (minColor != null) {
        this.safe(() => {
          const c = (cs as any).ColorScaleCriteria(1)
          if (c?.FormatColor) c.FormatColor.Color = minColor
          return null as any
        })
      }
      if (midColor != null) {
        this.safe(() => {
          const c = (cs as any).ColorScaleCriteria(2)
          if (c?.FormatColor) c.FormatColor.Color = midColor
          return null as any
        })
      }
      if (maxColor != null) {
        this.safe(() => {
          const c = (cs as any).ColorScaleCriteria(3)
          if (c?.FormatColor) c.FormatColor.Color = maxColor
          return null as any
        })
      }
      return
    }

    if (ruleType !== 'cell_value') {
      throw new Error(`unsupported conditional format rule_type: ${ruleType}`)
    }

    const operator = this.etConditionOperator((action as any)?.operator)
    if (operator == null) throw new Error('set_conditional_format cell_value requires operator')
    const formula1 = String((action as any)?.formula1 || '').trim()
    if (!formula1) throw new Error('set_conditional_format cell_value requires formula1')
    const formula2Raw = String((action as any)?.formula2 || '').trim()

    let cond = this.safe(
      () =>
        (formatConditions as any).Add(
          1,
          operator,
          formula1,
          formula2Raw ? formula2Raw : undefined
        ),
      null as any
    )
    let usedFallback = false
    if (!cond) {
      usedFallback = true
      cond = this.safe(() => (formatConditions as any).Add(1, operator, formula1), null as any)
    }
    if (!cond) {
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'et',
        op: 'set_conditional_format',
        branch: 'cell_value',
        fallback: usedFallback,
        success: false,
      })
      throw new Error('failed to add cell-value conditional format')
    }
    this.emitCapabilityEvent('plan.capability_matrix', {
      host_app: 'et',
      op: 'set_conditional_format',
      branch: 'cell_value',
      fallback: usedFallback,
      success: true,
    })

    const fillColor = this._hexToBgrLong(String((action as any)?.fill_color || '').trim())
    const fontColor = this._hexToBgrLong(String((action as any)?.font_color || '').trim())
    const boldRaw = (action as any)?.bold
    if (fillColor != null) this.safe(() => ((cond as any).Interior.Color = fillColor))
    if (fontColor != null) this.safe(() => ((cond as any).Font.Color = fontColor))
    if (typeof boldRaw === 'boolean') this.safe(() => ((cond as any).Font.Bold = boldRaw ? 1 : 0))
  }

  private etValidationType(validationType: string | null | undefined): number {
    const key = String(validationType || 'list').trim().toLowerCase()
    const map: Record<string, number> = {
      whole_number: 1,
      decimal: 2,
      list: 3,
      date: 4,
      time: 5,
      text_length: 6,
      custom: 7,
    }
    return map[key] ?? 3
  }

  private setDataValidationEt(app: any, selection: any, action: SetDataValidationAction) {
    const rangeAddr = String((action as any)?.range || '').trim()
    const formula1 = String((action as any)?.formula1 || '').trim()
    if (!rangeAddr) throw new Error('set_data_validation requires range')
    if (!formula1) throw new Error('set_data_validation requires formula1')

    const sel = selection || this.safe(() => app?.Selection)
    const sheet = this.safe(() => sel?.Worksheet) || this.safe(() => app?.ActiveSheet)
    if (!sheet) throw new Error('ET active sheet not available')
    const rng = this.safe(() => (sheet as any).Range(rangeAddr))
    if (!rng) throw new Error(`invalid range address: ${rangeAddr}`)

    const validation = this.safe(() => (rng as any)?.Validation)
    if (!validation) throw new Error('Validation object not available')

    this.safe(() => (validation as any).Delete?.())

    const validationType = this.etValidationType((action as any)?.validation_type)
    const operator = this.etConditionOperator((action as any)?.operator)
    const formula2Raw = String((action as any)?.formula2 || '').trim()

    const added = this.safe(() => {
      ;(validation as any).Add(
        validationType,
        1,
        operator == null ? 1 : operator,
        formula1,
        formula2Raw ? formula2Raw : undefined
      )
      return true
    }, false as any)
    if (!added) {
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'et',
        op: 'set_data_validation',
        branch: 'Validation.Add',
        fallback: false,
        success: false,
      })
      throw new Error('failed to set data validation')
    }
    this.emitCapabilityEvent('plan.capability_matrix', {
      host_app: 'et',
      op: 'set_data_validation',
      branch: 'Validation.Add',
      fallback: false,
      success: true,
    })

    const allowBlank = (action as any)?.allow_blank
    if (typeof allowBlank === 'boolean') this.safe(() => ((validation as any).IgnoreBlank = allowBlank ? 1 : 0))

    const inCellDropdown = (action as any)?.in_cell_dropdown
    if (typeof inCellDropdown === 'boolean') {
      this.safe(() => ((validation as any).InCellDropdown = inCellDropdown ? 1 : 0))
    }

    const showInput = (action as any)?.show_input
    if (typeof showInput === 'boolean') this.safe(() => ((validation as any).ShowInput = showInput ? 1 : 0))

    const showError = (action as any)?.show_error
    if (typeof showError === 'boolean') this.safe(() => ((validation as any).ShowError = showError ? 1 : 0))

    const inputTitle = String((action as any)?.input_title || '').trim()
    const inputMessage = String((action as any)?.input_message || '').trim()
    const errorTitle = String((action as any)?.error_title || '').trim()
    const errorMessage = String((action as any)?.error_message || '').trim()

    if (inputTitle) this.safe(() => ((validation as any).InputTitle = inputTitle))
    if (inputMessage) this.safe(() => ((validation as any).InputMessage = inputMessage))
    if (errorTitle) this.safe(() => ((validation as any).ErrorTitle = errorTitle))
    if (errorMessage) this.safe(() => ((validation as any).ErrorMessage = errorMessage))
  }

  private setSortRangeEt(app: any, selection: any, action: SortRangeAction) {
    const rangeAddr = String((action as any)?.range || '').trim()
    const keyAddr = String((action as any)?.key || '').trim()
    const order = String((action as any)?.order || 'asc').trim().toLowerCase()
    if (!rangeAddr) throw new Error('sort_range requires range')
    if (!keyAddr) throw new Error('sort_range requires key')

    const sel = selection || this.safe(() => app?.Selection)
    const sheet = this.safe(() => sel?.Worksheet) || this.safe(() => app?.ActiveSheet)
    if (!sheet) throw new Error('ET active sheet not available')

    const rng = this.safe(() => (sheet as any).Range(rangeAddr))
    if (!rng) throw new Error(`invalid range address: ${rangeAddr}`)
    const keyRange = this.safe(() => (sheet as any).Range(keyAddr))
    if (!keyRange) throw new Error(`invalid key address: ${keyAddr}`)

    const orderNum = order === 'desc' ? 2 : 1
    const hasHeader = (action as any)?.has_header ? 1 : 2

    let ok = !!this.safe(() => {
      ;(rng as any).Sort?.(
        keyRange,
        orderNum,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        hasHeader
      )
      return true
    }, false as any)

    if (!ok) {
      ok = !!this.safe(() => {
        const sortObj = (sheet as any).Sort
        if (!sortObj) return false
        if (typeof sortObj.SetRange === 'function') sortObj.SetRange(rng)
        if (sortObj.SortFields && typeof sortObj.SortFields.Clear === 'function') {
          sortObj.SortFields.Clear()
        }
        if (sortObj.SortFields && typeof sortObj.SortFields.Add === 'function') {
          sortObj.SortFields.Add(keyRange, 0, orderNum)
        }
        if ('Header' in sortObj) sortObj.Header = hasHeader
        if (typeof sortObj.Apply === 'function') sortObj.Apply()
        return true
      }, false as any)
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'et',
        op: 'sort_range',
        branch: 'SortObject',
        fallback: true,
        success: ok,
      })
    } else {
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'et',
        op: 'sort_range',
        branch: 'Range.Sort',
        fallback: false,
        success: true,
      })
    }

    if (!ok) throw new Error('failed to sort range')
  }

  private setFilterRangeEt(app: any, selection: any, action: FilterRangeAction) {
    const rangeAddr = String((action as any)?.range || '').trim()
    const field = Number((action as any)?.field || 0)
    const criteria1 = String((action as any)?.criteria1 || '').trim()
    const criteria2 = String((action as any)?.criteria2 || '').trim()
    const operatorRaw = String((action as any)?.operator || '').trim().toLowerCase()
    const visibleDropdown = (action as any)?.visible_dropdown !== false

    if (!rangeAddr) throw new Error('filter_range requires range')
    if (!Number.isFinite(field) || field <= 0) throw new Error('filter_range requires positive field')
    if (!criteria1) throw new Error('filter_range requires criteria1')

    const sel = selection || this.safe(() => app?.Selection)
    const sheet = this.safe(() => sel?.Worksheet) || this.safe(() => app?.ActiveSheet)
    if (!sheet) throw new Error('ET active sheet not available')

    const rng = this.safe(() => (sheet as any).Range(rangeAddr))
    if (!rng) throw new Error(`invalid range address: ${rangeAddr}`)

    const operator = operatorRaw === 'or' ? 2 : operatorRaw === 'and' ? 1 : undefined
    const ok = !!this.safe(() => {
      if (operator && criteria2) {
        ;(rng as any).AutoFilter(field, criteria1, operator, criteria2, visibleDropdown)
      } else {
        ;(rng as any).AutoFilter(field, criteria1, undefined, undefined, visibleDropdown)
      }
      return true
    }, false as any)
    if (!ok) {
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'et',
        op: 'filter_range',
        branch: 'Range.AutoFilter',
        fallback: false,
        success: false,
      })
      throw new Error('failed to apply filter')
    }
    this.emitCapabilityEvent('plan.capability_matrix', {
      host_app: 'et',
      op: 'filter_range',
      branch: 'Range.AutoFilter',
      fallback: false,
      success: true,
    })
  }

  private pivotSummaryToConst(summary: string | null | undefined): number {
    const key = String(summary || 'sum').trim().toLowerCase()
    const map: Record<string, number> = {
      sum: -4157,
      count: -4112,
      average: -4106,
      max: -4136,
      min: -4139,
    }
    return map[key] ?? -4157
  }

  private createPivotTableEt(app: any, selection: any, action: CreatePivotTableAction) {
    const sourceRangeAddr = String((action as any)?.source_range || '').trim()
    const destinationAddr = String((action as any)?.destination || '').trim()
    const rows = Array.isArray((action as any)?.rows) ? (action as any).rows : []
    const columns = Array.isArray((action as any)?.columns) ? (action as any).columns : []
    const values = Array.isArray((action as any)?.values) ? (action as any).values : []
    const filters = Array.isArray((action as any)?.filters) ? (action as any).filters : []
    const tableName = String((action as any)?.table_name || '').trim()

    if (!sourceRangeAddr) throw new Error('create_pivot_table requires source_range')
    if (!destinationAddr) throw new Error('create_pivot_table requires destination')
    if (rows.length <= 0) throw new Error('create_pivot_table requires at least one row field')
    if (values.length <= 0) throw new Error('create_pivot_table requires at least one value field')

    const sel = selection || this.safe(() => app?.Selection)
    const wb = this.safe(() => app?.ActiveWorkbook)
    const sheet = this.safe(() => sel?.Worksheet) || this.safe(() => app?.ActiveSheet)
    if (!wb || !sheet) throw new Error('ET workbook/sheet not available')

    const sourceRange = this.safe(() => (sheet as any).Range(sourceRangeAddr))
    if (!sourceRange) throw new Error(`invalid source_range address: ${sourceRangeAddr}`)
    const destinationRange = this.safe(() => (sheet as any).Range(destinationAddr))
    if (!destinationRange) throw new Error(`invalid destination address: ${destinationAddr}`)

    const pivotCaches = this.safe(() => (wb as any).PivotCaches())
    if (!pivotCaches) throw new Error('PivotCaches not available')

    const sourceData = this.safe(() => (sourceRange as any).Address?.(true, true, 1, true)) || sourceRangeAddr
    const cache = this.safe(() => (pivotCaches as any).Create?.(1, sourceData))
    if (!cache) throw new Error('failed to create pivot cache')

    const pivotName = tableName || `ah32_pivot_${Date.now()}`
    const existing = this.safe(() => (sheet as any).PivotTables?.(pivotName), null as any)
    if (existing && (action as any)?.replace_existing !== false) {
      this.safe(() => (existing as any).TableRange2?.Clear?.())
    }

    const pivot = this.safe(() => (cache as any).CreatePivotTable?.(destinationRange, pivotName))
    if (!pivot) throw new Error('failed to create pivot table')

    const setOrientation = (fieldName: string, orientation: number, position?: number) => {
      const pf = this.safe(() => (pivot as any).PivotFields?.(String(fieldName)))
      if (!pf) return false
      this.safe(() => {
        ;(pf as any).Orientation = orientation
        if (typeof position === 'number') (pf as any).Position = position
        return null as any
      })
      return true
    }

    let rowPos = 1
    for (const r of rows) {
      if (typeof r !== 'string' || !r.trim()) continue
      setOrientation(r, 1, rowPos++)
    }

    let colPos = 1
    for (const c of columns) {
      if (typeof c !== 'string' || !c.trim()) continue
      setOrientation(c, 2, colPos++)
    }

    for (const f of filters) {
      if (typeof f !== 'string' || !f.trim()) continue
      setOrientation(f, 3)
    }

    for (const valueField of values) {
      const fieldName = String((valueField as any)?.field || '').trim()
      if (!fieldName) continue
      const baseField = this.safe(() => (pivot as any).PivotFields?.(fieldName))
      if (!baseField) continue
      const summary = this.pivotSummaryToConst((valueField as any)?.summary)
      const title = String((valueField as any)?.title || '').trim()
      let usedFallback = false
      this.safe(() => {
        if (typeof (pivot as any).AddDataField === 'function') {
          ;(pivot as any).AddDataField(baseField, title || undefined, summary)
          return null as any
        }
        usedFallback = true
        ;(baseField as any).Orientation = 4
        ;(baseField as any).Function = summary
        if (title) (baseField as any).Name = title
        return null as any
      })
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'et',
        op: 'create_pivot_table',
        branch: usedFallback ? 'PivotField.Orientation' : 'PivotTable.AddDataField',
        fallback: usedFallback,
        success: true,
      })
    }
  }

  private deleteBlockEt(app: any, wb: any, blockId: string) {
    const suffix = String(blockId || 'ah32_auto').replace(/[^a-zA-Z0-9_\-:.]/g, '_').slice(0, 20)
    const sheetName = this.sanitizeSheetName(`BID_${suffix}`)
    const sheets = this.safe(() => wb.Worksheets)
    if (!sheets) return
    const count = Number(this.safe(() => sheets.Count, 0)) || 0
    let target = null as any
    for (let i = 1; i <= count; i++) {
      const s = this.safe(() => sheets.Item(i))
      if (!s) continue
      const n = String(this.safe(() => s.Name, '') || '')
      if (n === sheetName) {
        target = s
        break
      }
    }
    if (!target) return
    let prevAlerts: any = null
    try {
      prevAlerts = (app as any).DisplayAlerts
      ;(app as any).DisplayAlerts = 0
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }
    try {
      this.safe(() => (typeof target.Delete === 'function' ? target.Delete() : null))
    } finally {
      try {
        if (prevAlerts !== null) ;(app as any).DisplayAlerts = prevAlerts
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
    }
  }

  private executeActionsEt(
    ctx: { app: any; wb: any; selection: any },
    actions: PlanAction[],
    emit: (step: PlanExecutionStep) => void
  ) {
    for (const action of actions) {
      const ts = Date.now()
      emit({
        id: action.id,
        title: action.title,
        op: action.op,
        content: `op=${action.op}`,
        status: 'processing',
        timestamp: ts
      })
      try {
        switch (action.op) {
          case 'insert_text':
            this.insertTextEt(ctx.selection, action.text)
            break
          case 'set_cell_formula':
            this.setCellFormulaEt(ctx.app, ctx.selection, action as any)
            break
          case 'set_number_format':
            this.setNumberFormatEt(ctx.app, ctx.selection, action as any)
            break
          case 'set_conditional_format':
            this.setConditionalFormatEt(ctx.app, ctx.selection, action as any)
            break
          case 'set_data_validation':
            this.setDataValidationEt(ctx.app, ctx.selection, action as any)
            break
          case 'sort_range':
            this.setSortRangeEt(ctx.app, ctx.selection, action as any)
            break
          case 'filter_range':
            this.setFilterRangeEt(ctx.app, ctx.selection, action as any)
            break
          case 'create_pivot_table':
            this.createPivotTableEt(ctx.app, ctx.selection, action as any)
            break
          case 'insert_chart_from_selection':
            this.insertChartFromSelectionEt(ctx.app, ctx.wb, ctx.selection, action as any)
            break
          case 'delete_block':
            this.deleteBlockEt(ctx.app, ctx.wb, (action as any).block_id)
            break
          case 'upsert_block': {
            const id = String((action as any).block_id || 'ah32_auto')
            const suffix = id.replace(/[^a-zA-Z0-9_\-:.]/g, '_').slice(0, 20)
            const sheetName = this.sanitizeSheetName(String((action as any).sheet_name || `BID_${suffix}`))
            const sheet = this.getOrCreateSheet(ctx.wb, sheetName)
            this.activateSheet(sheet)
            this.clearSheet(sheet)
            this.selectA1(sheet)
            const selection = this.getSelection(ctx.app) || ctx.selection
            this.executeActionsEt({ app: ctx.app, wb: ctx.wb, selection }, (action as any).actions || [], emit)
            break
          }
          default:
            throw new Error(`unsupported op for et: ${(action as any)?.op}`)
        }
        emit({
          id: action.id,
          title: action.title,
          op: action.op,
          content: `op=${action.op} status=completed`,
          status: 'completed',
          timestamp: Date.now()
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        emit({
          id: action.id,
          title: action.title,
          op: action.op,
          content: `op=${action.op} status=error`,
          status: 'error',
          timestamp: Date.now(),
          error: msg
        })
        throw e
      }
    }
  }

  private insertChartFromSelectionEt(app: any, wb: any, selection: any, action: InsertChartFromSelectionAction) {
    const sheet = this.safe(() => wb?.ActiveSheet) || this.safe(() => app?.ActiveSheet)
    if (!sheet) throw new Error('ET active sheet not available')

    let rng: any = null
    if (selection && this.safe(() => !!selection.Cells, false as any)) rng = selection
    if (!rng) {
      const sel = this.safe(() => app?.Selection)
      if (sel && this.safe(() => !!(sel as any).Cells, false as any)) rng = sel
      if (!rng) {
        const addr = this.safe(() => {
          const s = sel as any
          if (!s) return ''
          if (typeof s.Address === 'string') return s.Address
          if (typeof s.Address === 'function') return s.Address()
          return ''
        }, '' as any) as any
        if (addr) rng = this.safe(() => (sheet as any).Range(addr as string))
      }
    }
    if (!rng) throw new Error('璇峰厛閫夋嫨鏁版嵁鍖哄煙鍚庡啀鎻掑叆鍥捐〃')

    let chartObj: any = null
    chartObj = this.safe(() => (sheet as any).Shapes?.AddChart?.())
    if (!chartObj) {
      const chartObjects = this.safe(() => (sheet as any).ChartObjects)
      if (chartObjects) {
        chartObj = this.safe(() => (typeof (chartObjects as any).Add === 'function'
          ? (chartObjects as any).Add(120, 40, 420, 260)
          : null))
      }
    }
    if (!chartObj) throw new Error('insert_chart_from_selection failed for et')

    const chart = this.safe(() => ((chartObj as any).Chart ? (chartObj as any).Chart : chartObj))
    if (!chart) throw new Error('chart object unavailable')

    this.safe(() => (typeof (chart as any).SetSourceData === 'function' ? (chart as any).SetSourceData(rng) : null))
    const chartType = Number((action as any)?.chart_type || 0)
    if (Number.isFinite(chartType) && chartType > 0) {
      this.safe(() => {
        ;(chart as any).ChartType = chartType
        return null as any
      })
    }
  }

  // ----------------------- WPP (Presentation) -----------------------

  private wppTag(id: string): string {
    return `AH32_BLOCKID:${String(id || 'ah32_auto')}`
  }

  private findSlideByTag(pres: any, id: string): any {
    const slides = this.safe(() => pres.Slides)
    if (!slides) return null
    const count = Number(this.safe(() => slides.Count, 0)) || 0
    const needle = this.wppTag(id)
    for (let i = 1; i <= count; i++) {
      const s = this.safe(() => slides.Item(i))
      if (!s) continue
      // Prefer Tags.
      try {
        if (s.Tags && typeof s.Tags.Item === 'function') {
          const v = s.Tags.Item('AH32_BLOCKID')
          if (String(v || '') === String(id)) return s
        }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      // Fallback: scan shapes AlternativeText/Text for the marker.
      try {
        const shapes = s.Shapes
        const sc = shapes ? shapes.Count : 0
        for (let j = 1; j <= sc; j++) {
          const sh = this.safe(() => shapes.Item(j))
          if (!sh) continue
          try {
            if (String(sh.AlternativeText || '').includes(needle)) return s
          } catch (e) {
            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
          }
          try {
            if (sh.TextFrame && sh.TextFrame.HasText) {
              const t = sh.TextFrame.TextRange ? sh.TextFrame.TextRange.Text : ''
              if (String(t || '').includes(needle)) return s
            }
          } catch (e) {
            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
          }
        }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
    }
    return null
  }

  private ensureSlideMarked(slide: any, id: string) {
    try {
      if (slide.Tags && typeof slide.Tags.Add === 'function') {
        slide.Tags.Add('AH32_BLOCKID', String(id))
        return
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }
    // Fallback: add a tiny textbox marker.
    try {
      if (slide.Shapes && typeof slide.Shapes.AddTextbox === 'function') {
        const marker = slide.Shapes.AddTextbox(1, 0, 0, 1, 1)
        this.safe(() => (marker.Visible = 0))
        this.safe(() => (marker.AlternativeText = this.wppTag(id)))
        this.safe(() => (marker.TextFrame && marker.TextFrame.TextRange ? (marker.TextFrame.TextRange.Text = '') : null))
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }
  }

  private clearSlide(slide: any, id: string) {
    try {
      const shapes = slide.Shapes
      const count = shapes ? shapes.Count : 0
      for (let i = count; i >= 1; i--) {
        const sh = this.safe(() => shapes.Item(i))
        if (!sh) continue
        let keep = false
        try {
          if (String(sh.AlternativeText || '').includes(this.wppTag(id))) keep = true
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
        }
        if (!keep) this.safe(() => (typeof sh.Delete === 'function' ? sh.Delete() : null))
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }
  }

  private activateSlide(app: any, slide: any) {
    this.safe(() => (typeof slide.Select === 'function' ? slide.Select() : null))
    this.safe(() => {
      if (app && app.ActiveWindow && app.ActiveWindow.View && typeof app.ActiveWindow.View.GotoSlide === 'function') {
        app.ActiveWindow.View.GotoSlide(slide.SlideIndex)
      }
      return null
    })
  }

  private addTextbox(slide: any, text: string, opts?: any) {
    const o = opts || {}
    if (!slide || !slide.Shapes || typeof slide.Shapes.AddTextbox !== 'function') {
      throw new Error('Shapes.AddTextbox not available')
    }
    const left = Number(o.left || 60)
    const top = Number(o.top || 80)
    const width = Number(o.width || 600)
    const height = Number(o.height || 120)
    const box = slide.Shapes.AddTextbox(1, left, top, width, height)
    this.safe(() => (box.TextFrame.TextRange.Text = String(text || '')))
    this.safe(() => (o.fontSize ? (box.TextFrame.TextRange.Font.Size = Number(o.fontSize)) : null))
    this.safe(() => (o.bold ? (box.TextFrame.TextRange.Font.Bold = o.bold ? 1 : 0) : null))
    return box
  }

  private addWordArt(slide: any, text: string, opts?: any) {
    const o = opts || {}
    try {
      if (slide.Shapes && typeof slide.Shapes.AddTextEffect === 'function') {
        const left = Number(o.left || 60)
        const top = Number(o.top || 80)
        const fontName = String(o.fontName || o.font || 'Arial')
        const size = Number(o.fontSize || o.size || 48)
        return slide.Shapes.AddTextEffect(1, String(text || ''), fontName, size, 0, 0, left, top)
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }
    return this.addTextbox(slide, text, { left: o.left, top: o.top, width: o.width, height: o.height, fontSize: o.fontSize || o.size || 48, bold: true })
  }

  private _wppHexToRgbLong(colorHex: string): number | null {
    try {
      const s = String(colorHex || '').trim().replace(/^#/, '')
      if (!/^[0-9a-fA-F]{6}$/.test(s)) return null
      const r = parseInt(s.slice(0, 2), 16)
      const g = parseInt(s.slice(2, 4), 16)
      const b = parseInt(s.slice(4, 6), 16)
      return (b << 16) | (g << 8) | r
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      return null
    }
  }

  private setSlideBackgroundWpp(slide: any, action: SetSlideBackgroundAction) {
    const color = String((action as any)?.color || '').trim()
    if (!color) throw new Error('set_slide_background requires color')
    const rgb = this._wppHexToRgbLong(color)
    if (rgb == null) throw new Error('set_slide_background invalid color')

    const bg = this.safe(() => slide?.Background)
    if (!bg) throw new Error('slide background not available')
    const fill = this.safe(() => bg?.Fill)
    if (!fill) throw new Error('slide background fill not available')
    this.safe(() => (typeof fill.Solid === 'function' ? fill.Solid() : null))
    const ok = this.safe(() => {
      if (fill.ForeColor && 'RGB' in fill.ForeColor) {
        fill.ForeColor.RGB = rgb
        return true
      }
      return false
    }, false as any)
    if (!ok) throw new Error('failed to set slide background color')
  }

  private setSlideTextStyleWpp(slide: any, action: SetSlideTextStyleAction) {
    const font = String((action as any)?.font || '').trim()
    const sizeRaw = (action as any)?.size
    const boldRaw = (action as any)?.bold
    const colorRaw = String((action as any)?.color || '').trim()
    const rgb = colorRaw ? this._wppHexToRgbLong(colorRaw) : null
    const applySize = Number(sizeRaw)
    const hasSize = Number.isFinite(applySize) && applySize > 0
    const hasBold = typeof boldRaw === 'boolean'

    const shapes = this.safe(() => slide?.Shapes)
    const count = Number(this.safe(() => shapes?.Count, 0)) || 0
    let touched = 0
    for (let i = 1; i <= count; i++) {
      const sh = this.safe(() => shapes.Item(i))
      if (!sh) continue
      const tr = this.safe(() => sh?.TextFrame?.TextRange)
      if (!tr) continue
      const f = this.safe(() => tr?.Font)
      if (!f) continue
      if (font) this.safe(() => ((f as any).Name = font))
      if (hasSize) this.safe(() => ((f as any).Size = Number(applySize)))
      if (hasBold) this.safe(() => ((f as any).Bold = (boldRaw ? 1 : 0)))
      if (rgb != null) {
        this.safe(() => {
          if ((f as any).Color && 'RGB' in (f as any).Color) {
            ;(f as any).Color.RGB = rgb
          }
          return null as any
        })
      }
      touched += 1
    }
    if (touched <= 0) throw new Error('set_slide_text_style found no text shapes')
  }

  private setSlideThemeWpp(ctx: { app: any; pres: any }, action: SetSlideThemeAction) {
    const templatePath = String((action as any)?.template_path || '').trim()
    const themeName = String((action as any)?.theme_name || '').trim().toLowerCase()
    const themeIndex = Number((action as any)?.theme_index || 0)

    if (templatePath) {
      const ok = !!this.safe(() => {
        if (typeof (ctx.pres as any)?.ApplyTemplate === 'function') {
          ;(ctx.pres as any).ApplyTemplate(templatePath)
          return true
        }
        if (typeof (ctx.pres as any)?.ApplyTheme === 'function') {
          ;(ctx.pres as any).ApplyTheme(templatePath)
          return true
        }
        return false
      }, false as any)
      if (ok) {
        this.emitCapabilityEvent('plan.capability_matrix', {
          host_app: 'wpp',
          op: 'set_slide_theme',
          branch: 'ApplyTemplate/ApplyTheme',
          fallback: false,
          success: true,
        })
        return
      }
    }

    const foundByName = !!this.safe(() => {
      if (!themeName) return false
      const design = (ctx.pres as any)?.Designs
      const count = Number(design?.Count || 0)
      if (count <= 0 || typeof design?.Item !== 'function') return false
      for (let i = 1; i <= count; i++) {
        const item = design.Item(i)
        const name = String(item?.Name || '').trim().toLowerCase()
        if (name && name === themeName) {
          if (typeof item?.Apply === 'function') item.Apply()
          return true
        }
      }
      return false
    }, false as any)
    if (foundByName) {
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'wpp',
        op: 'set_slide_theme',
        branch: 'Designs.ItemByName',
        fallback: true,
        success: true,
      })
      return
    }

    const foundByIndex = !!this.safe(() => {
      if (!Number.isFinite(themeIndex) || themeIndex <= 0) return false
      const design = (ctx.pres as any)?.Designs
      if (!design || typeof design.Item !== 'function') return false
      const item = design.Item(themeIndex)
      if (!item) return false
      if (typeof item.Apply === 'function') {
        item.Apply()
        return true
      }
      return false
    }, false as any)
    if (foundByIndex) {
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'wpp',
        op: 'set_slide_theme',
        branch: 'Designs.ItemByIndex',
        fallback: true,
        success: true,
      })
      return
    }

    throw new Error('set_slide_theme failed: no applicable theme found')
  }

  private setSlideLayoutWpp(
    ctx: { app: any; pres: any; slide?: any },
    action: SetSlideLayoutAction
  ) {
    const layout = Number((action as any)?.layout || 0)
    if (!Number.isFinite(layout) || layout <= 0) {
      throw new Error('set_slide_layout requires positive layout')
    }

    const applyTo = [] as any[]
    if ((action as any)?.apply_to_all) {
      const slides = this.safe(() => ctx.pres?.Slides)
      const count = Number(this.safe(() => slides?.Count, 0)) || 0
      for (let i = 1; i <= count; i++) {
        const s = this.safe(() => slides?.Item(i))
        if (s) applyTo.push(s)
      }
    } else {
      const slide = ctx.slide || this.safe(() => ctx.app.ActiveWindow?.View?.Slide) || null
      if (!slide) throw new Error('active slide not available')
      applyTo.push(slide)
    }

    if (applyTo.length <= 0) throw new Error('set_slide_layout found no slides')

    let touched = 0
    for (const slide of applyTo) {
      const ok = !!this.safe(() => {
        ;(slide as any).Layout = layout
        return true
      }, false as any)
      if (!ok) {
        const ok2 = !!this.safe(() => {
          ;(slide as any).CustomLayout = layout
          return true
        }, false as any)
        this.emitCapabilityEvent('plan.capability_matrix', {
          host_app: 'wpp',
          op: 'set_slide_layout',
          branch: 'CustomLayout',
          fallback: true,
          success: ok2,
        })
        if (!ok2) continue
      } else {
        this.emitCapabilityEvent('plan.capability_matrix', {
          host_app: 'wpp',
          op: 'set_slide_layout',
          branch: 'Layout',
          fallback: false,
          success: true,
        })
      }
      touched += 1
    }

    if (touched <= 0) throw new Error('set_slide_layout failed on all slides')
  }

  private resolveTargetShapesWpp(
    ctx: { app: any; pres: any; slide?: any },
    action: { shape_name?: string | null; apply_to_all?: boolean }
  ): any[] {
    const shapeName = String((action as any)?.shape_name || '').trim()
    const slides: any[] = []

    if ((action as any)?.apply_to_all) {
      const allSlides = this.safe(() => ctx.pres?.Slides)
      const count = Number(this.safe(() => allSlides?.Count, 0)) || 0
      for (let i = 1; i <= count; i++) {
        const s = this.safe(() => allSlides?.Item(i))
        if (s) slides.push(s)
      }
    } else {
      const slide = ctx.slide || this.safe(() => ctx.app.ActiveWindow?.View?.Slide) || null
      if (!slide) throw new Error('active slide not available')
      slides.push(slide)
    }

    const targets: any[] = []
    for (const slide of slides) {
      const shapes = this.safe(() => slide?.Shapes)
      const count = Number(this.safe(() => shapes?.Count, 0)) || 0
      for (let i = 1; i <= count; i++) {
        const sh = this.safe(() => shapes?.Item(i))
        if (!sh) continue
        if (!shapeName) {
          targets.push(sh)
          continue
        }
        const name = String(this.safe(() => sh?.Name, '') || '').trim()
        if (name === shapeName) targets.push(sh)
      }
    }
    return targets
  }

  private setShapeStyleWpp(
    ctx: { app: any; pres: any; slide?: any },
    action: SetShapeStyleAction
  ) {
    const fillColor = this._wppHexToRgbLong(String((action as any)?.fill_color || '').trim())
    const lineColor = this._wppHexToRgbLong(String((action as any)?.line_color || '').trim())
    const textColor = this._wppHexToRgbLong(String((action as any)?.text_color || '').trim())
    const lineWidthRaw = Number((action as any)?.line_width || 0)
    const hasLineWidth = Number.isFinite(lineWidthRaw) && lineWidthRaw > 0
    const hasBold = typeof (action as any)?.bold === 'boolean'

    const targets = this.resolveTargetShapesWpp(ctx, action as any)
    if (targets.length <= 0) {
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'wpp',
        op: 'set_shape_style',
        branch: 'resolveTargetShapes',
        fallback: false,
        success: false,
      })
      throw new Error('set_shape_style found no target shapes')
    }

    let touched = 0
    for (const shape of targets) {
      let changed = false
      if (fillColor != null) {
        this.safe(() => {
          const fill = shape?.Fill
          if (fill && typeof fill.Solid === 'function') fill.Solid()
          if (fill?.ForeColor && 'RGB' in fill.ForeColor) {
            fill.ForeColor.RGB = fillColor
            changed = true
          }
          return null as any
        })
      }
      if (lineColor != null || hasLineWidth) {
        this.safe(() => {
          const line = shape?.Line
          if (lineColor != null && line?.ForeColor && 'RGB' in line.ForeColor) {
            line.ForeColor.RGB = lineColor
            changed = true
          }
          if (hasLineWidth && 'Weight' in (line || {})) {
            line.Weight = lineWidthRaw
            changed = true
          }
          return null as any
        })
      }
      if (textColor != null || hasBold) {
        this.safe(() => {
          const tr = shape?.TextFrame?.TextRange
          const font = tr?.Font
          if (font) {
            if (textColor != null) {
              if ((font as any).Color && 'RGB' in (font as any).Color) {
                ;(font as any).Color.RGB = textColor
              } else if ('Color' in font) {
                ;(font as any).Color = textColor
              }
              changed = true
            }
            if (hasBold) {
              ;(font as any).Bold = (action as any).bold ? 1 : 0
              changed = true
            }
          }
          return null as any
        })
      }
      if (changed) touched += 1
    }

    if (touched <= 0) {
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'wpp',
        op: 'set_shape_style',
        branch: 'shape_style_apply',
        fallback: false,
        success: false,
      })
      throw new Error('set_shape_style failed to apply any style')
    }
    this.emitCapabilityEvent('plan.capability_matrix', {
      host_app: 'wpp',
      op: 'set_shape_style',
      branch: 'shape_style_apply',
      fallback: false,
      success: true,
    })
  }

  private setTableStyleWpp(
    ctx: { app: any; pres: any; slide?: any },
    action: SetTableStyleAction
  ) {
    const targets = this.resolveTargetShapesWpp(ctx, action as any)
    if (targets.length <= 0) {
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'wpp',
        op: 'set_table_style',
        branch: 'resolveTargetShapes',
        fallback: false,
        success: false,
      })
      throw new Error('set_table_style found no target shapes')
    }

    const styleName = String((action as any)?.style_name || '').trim()
    const firstRow = (action as any)?.first_row
    const lastRow = (action as any)?.last_row
    const bandedRows = (action as any)?.banded_rows
    const bandedColumns = (action as any)?.banded_columns

    let touched = 0
    for (const shape of targets) {
      const table = this.safe(() => shape?.Table)
      if (!table) continue

      const applied = this.safe(() => {
        let changed = false
        if (styleName) {
          if ('Style' in table) {
            ;(table as any).Style = styleName
            this.emitCapabilityEvent('plan.capability_matrix', {
              host_app: 'wpp',
              op: 'set_table_style',
              branch: 'Table.Style',
              fallback: false,
              success: true,
            })
            changed = true
          } else if ('ApplyStyle' in table && typeof (table as any).ApplyStyle === 'function') {
            ;(table as any).ApplyStyle(styleName)
            this.emitCapabilityEvent('plan.capability_matrix', {
              host_app: 'wpp',
              op: 'set_table_style',
              branch: 'Table.ApplyStyle',
              fallback: true,
              success: true,
            })
            changed = true
          }
        }
        if (typeof firstRow === 'boolean' && 'FirstRow' in table) {
          ;(table as any).FirstRow = firstRow ? 1 : 0
          changed = true
        }
        if (typeof lastRow === 'boolean' && 'LastRow' in table) {
          ;(table as any).LastRow = lastRow ? 1 : 0
          changed = true
        }
        if (typeof bandedRows === 'boolean' && 'HorizBanding' in table) {
          ;(table as any).HorizBanding = bandedRows ? 1 : 0
          changed = true
        }
        if (typeof bandedColumns === 'boolean' && 'VertBanding' in table) {
          ;(table as any).VertBanding = bandedColumns ? 1 : 0
          changed = true
        }
        return changed
      }, false as any)

      if (applied) touched += 1
    }

    if (touched <= 0) {
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'wpp',
        op: 'set_table_style',
        branch: 'table_style_apply',
        fallback: false,
        success: false,
      })
      throw new Error('set_table_style found no applicable tables')
    }
    this.emitCapabilityEvent('plan.capability_matrix', {
      host_app: 'wpp',
      op: 'set_table_style',
      branch: 'table_style_apply',
      fallback: false,
      success: true,
    })
  }

  private executeActionsWpp(
    ctx: { app: any; pres: any; slide?: any },
    actions: PlanAction[],
    emit: (step: PlanExecutionStep) => void
  ) {
    for (const action of actions) {
      const ts = Date.now()
      emit({
        id: action.id,
        title: action.title,
        op: action.op,
        content: `op=${action.op}`,
        status: 'processing',
        timestamp: ts
      })
      try {
        switch (action.op) {
          case 'insert_text': {
            const slide = ctx.slide || this.safe(() => ctx.app.ActiveWindow?.View?.Slide) || null
            if (!slide) throw new Error('active slide not available')
            this.addTextbox(slide, (action as any).text || '')
            break
          }
          case 'insert_word_art': {
            const slide = ctx.slide || this.safe(() => ctx.app.ActiveWindow?.View?.Slide) || null
            if (!slide) throw new Error('active slide not available')
            this.addWordArt(slide, (action as any).text || '', action)
            break
          }
          case 'set_slide_background': {
            if ((action as any)?.apply_to_all) {
              const slides = this.safe(() => ctx.pres?.Slides)
              const count = Number(this.safe(() => slides?.Count, 0)) || 0
              if (count <= 0) throw new Error('no slides to apply background')
              for (let i = 1; i <= count; i++) {
                const s = this.safe(() => slides.Item(i))
                if (!s) continue
                this.setSlideBackgroundWpp(s, action as any)
              }
            } else {
              const slide = ctx.slide || this.safe(() => ctx.app.ActiveWindow?.View?.Slide) || null
              if (!slide) throw new Error('active slide not available')
              this.setSlideBackgroundWpp(slide, action as any)
            }
            break
          }
          case 'set_slide_text_style': {
            if ((action as any)?.apply_to_all) {
              const slides = this.safe(() => ctx.pres?.Slides)
              const count = Number(this.safe(() => slides?.Count, 0)) || 0
              if (count <= 0) throw new Error('no slides to apply text style')
              for (let i = 1; i <= count; i++) {
                const s = this.safe(() => slides.Item(i))
                if (!s) continue
                this.setSlideTextStyleWpp(s, action as any)
              }
            } else {
              const slide = ctx.slide || this.safe(() => ctx.app.ActiveWindow?.View?.Slide) || null
              if (!slide) throw new Error('active slide not available')
              this.setSlideTextStyleWpp(slide, action as any)
            }
            break
          }
          case 'set_slide_theme': {
            this.setSlideThemeWpp(ctx, action as any)
            break
          }
          case 'set_slide_layout': {
            this.setSlideLayoutWpp(ctx, action as any)
            break
          }
          case 'set_shape_style': {
            this.setShapeStyleWpp(ctx, action as any)
            break
          }
          case 'set_table_style': {
            this.setTableStyleWpp(ctx, action as any)
            break
          }
          case 'delete_block': {
            const id = String((action as any).block_id || 'ah32_auto')
            const slide = this.findSlideByTag(ctx.pres, id)
            if (slide) {
              this.clearSlide(slide, id)
              // Best-effort delete slide.
              this.safe(() => (typeof slide.Delete === 'function' ? slide.Delete() : null))
            }
            break
          }
          case 'upsert_block': {
            const id = String((action as any).block_id || 'ah32_auto')
            let slide = this.findSlideByTag(ctx.pres, id)
            if (!slide) {
              const slides = this.safe(() => ctx.pres.Slides)
              if (!slides) throw new Error('Slides not available')
              const idx = Number(this.safe(() => slides.Count, 0)) + 1
              const created = this.safe(() => slides.Add(idx, 12))
              if (!created) throw new Error('failed to create slide')
              slide = created
              this.ensureSlideMarked(slide, id)
            } else {
              this.clearSlide(slide, id)
              this.ensureSlideMarked(slide, id)
            }
            this.activateSlide(ctx.app, slide)
            this.executeActionsWpp({ app: ctx.app, pres: ctx.pres, slide }, (action as any).actions || [], emit)
            break
          }
          default:
            throw new Error(`unsupported op for wpp: ${(action as any)?.op}`)
        }
        emit({
          id: action.id,
          title: action.title,
          op: action.op,
          content: `op=${action.op} status=completed`,
          status: 'completed',
          timestamp: Date.now()
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        emit({
          id: action.id,
          title: action.title,
          op: action.op,
          content: `op=${action.op} status=error`,
          status: 'error',
          timestamp: Date.now(),
          error: msg
        })
        throw e
      }
    }
  }
}

export const planExecutor = new PlanExecutor()
