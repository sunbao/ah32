import { wpsBridge, type WPSHostApp } from './wps-bridge'
import { logger } from '@/utils/logger'
import { reportAuditEvent } from './audit-client'
import { emitTelemetryEvent } from './telemetry'

type PlanDiagLevel = 'info' | 'warning' | 'error'
const _planDiagLastAt: Record<PlanDiagLevel, number> = { info: 0, warning: 0, error: 0 }
const _planDiag = (level: PlanDiagLevel, msg: string) => {
  try {
    const now = Date.now()
    // Keep logs low-volume; this runs in tight UI environments (WPS webview).
    // NOTE: Do not let info logs suppress error logs; otherwise we lose root-cause diagnostics.
    const throttleMs = level === 'info' ? 800 : level === 'warning' ? 400 : 0
    const lastAt = _planDiagLastAt[level] || 0
    if (throttleMs > 0 && now - lastAt < throttleMs) return
    _planDiagLastAt[level] = now
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

  // ET-only (best-effort): select a range/cell on a sheet.
  sheet_name?: string | null
  cell?: string | null
  range?: string | null

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
  data?: (string | number)[][] | null
  borders?: boolean | null
  style?: string | null
  header?: boolean | null
  auto_fit?: number | null
}

export interface InsertChartFromSelectionAction extends PlanBaseAction {
  op: 'insert_chart_from_selection'
  chart_type?: number | null
  sheet_name?: string | null
  source_range?: string | null
  width?: number | null
  height?: number | null
  title?: string | null
  has_legend?: boolean | null
  legend_position?: 'right' | 'left' | 'top' | 'bottom' | null
  add_trendline?: boolean | null
  trendline_type?: string | null
  show_data_labels?: boolean | null
  data_labels_show_percent?: boolean | null
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

export interface SetParagraphFormatAction extends PlanBaseAction {
  op: 'set_paragraph_format'
  block_id?: string | null
  apply_to_selection?: boolean
  alignment?: 'left' | 'center' | 'right' | 'justify' | null
  line_spacing?: 'single' | '1.5' | 'double' | null
  space_before?: number | null
  space_after?: number | null
}

export interface ApplyParagraphStyleAction extends PlanBaseAction {
  op: 'apply_paragraph_style'
  block_id?: string | null
  apply_to_selection?: boolean
  max_paragraphs?: number | null
  font?: string | null
  size?: number | null
  bold?: boolean | null
  italic?: boolean | null
  color?: string | null
  alignment?: 'left' | 'center' | 'right' | 'justify' | null
  line_spacing?: 'single' | '1.5' | 'double' | null
  space_before?: number | null
  space_after?: number | null
}

export interface NormalizeHeadingsLevelStyle {
  level: number
  font?: string | null
  size?: number | null
  bold?: boolean | null
  italic?: boolean | null
  color?: string | null
  alignment?: 'left' | 'center' | 'right' | 'justify' | null
  line_spacing?: 'single' | '1.5' | 'double' | null
  space_before?: number | null
  space_after?: number | null
}

export interface NormalizeHeadingsAction extends PlanBaseAction {
  op: 'normalize_headings'
  block_id?: string | null
  apply_to_selection?: boolean
  max_paragraphs?: number | null
  levels?: NormalizeHeadingsLevelStyle[] | null
}

export interface ApplyTextStyleToMatchesAction extends PlanBaseAction {
  op: 'apply_text_style_to_matches'
  find_text: string
  max_matches?: number
  block_id?: string | null
  case_sensitive?: boolean
  whole_word?: boolean
  font?: string | null
  size?: number | null
  bold?: boolean | null
  italic?: boolean | null
  color?: string | null
}

export interface SetWriterTableStyleAction extends PlanBaseAction {
  op: 'set_writer_table_style'
  block_id?: string | null
  apply_to_selection?: boolean
  style_name?: string | null
  borders?: boolean | null
  header?: boolean | null
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

export interface TransformRangeAction extends PlanBaseAction {
  op: 'transform_range'
  source_range: string
  destination: string
  transform?: 'transpose' | string
  clear_existing?: boolean
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

// ===================== WPP新增操作类型 =====================

export interface AddSlideAction extends PlanBaseAction {
  op: 'add_slide'
  layout?: number
  title?: string | null
  content?: string | null
  position?: number | null
}

export interface AddTextboxAction extends PlanBaseAction {
  op: 'add_textbox'
  text?: string | null
  left?: number
  top?: number
  width?: number
  height?: number
  font_size?: number | null
  font_bold?: boolean | null
  font_color?: string | null
  alignment?: string | null
  placeholder_kind?: string | null
  placeholder_type?: number | null
  placeholder_index?: number | null
  slide_index?: number | null
}

export interface AddImageAction extends PlanBaseAction {
  op: 'add_image'
  path: string
  left?: number
  top?: number
  width?: number | null
  height?: number | null
  placeholder_kind?: string | null
  placeholder_type?: number | null
  placeholder_index?: number | null
  slide_index?: number | null
}

export interface AddChartAction extends PlanBaseAction {
  op: 'add_chart'
  chart_type?: string
  title?: string | null
  data?: (number | string)[][]
  left?: number
  top?: number
  width?: number
  height?: number
  placeholder_kind?: string | null
  placeholder_type?: number | null
  placeholder_index?: number | null
  slide_index?: number | null
}

export interface AddTableAction extends PlanBaseAction {
  op: 'add_table'
  rows?: number
  cols?: number
  data?: string[][]
  left?: number
  top?: number
  width?: number | null
  style?: string | null
  slide_index?: number | null
}

export interface AddShapeAction extends PlanBaseAction {
  op: 'add_shape'
  shape_type: string
  left?: number
  top?: number
  width?: number
  height?: number
  fill_color?: string | null
  line_color?: string | null
  text?: string | null
  slide_index?: number | null
}

export interface DeleteSlideAction extends PlanBaseAction {
  op: 'delete_slide'
  slide_index?: number | null
}

export interface DuplicateSlideAction extends PlanBaseAction {
  op: 'duplicate_slide'
  source_index?: number | null
  target_position?: number | null
}

export interface ReorderSlidesAction extends PlanBaseAction {
  op: 'reorder_slides'
  from_index: number
  to_index: number
}

export interface SetSlideTransitionAction extends PlanBaseAction {
  op: 'set_slide_transition'
  effect?: string
  duration?: number
  sound?: string | null
  advance_on_click?: boolean
  slide_index?: number | null
  apply_to_all?: boolean
}

export interface AddAnimationAction extends PlanBaseAction {
  op: 'add_animation'
  target_shape_name?: string | null
  target_index?: number | null
  effect: string
  trigger?: string
  duration?: number
  delay?: number
  slide_index?: number | null
}

export interface SetAnimationTimingAction extends PlanBaseAction {
  op: 'set_animation_timing'
  animation_index: number
  trigger?: string | null
  duration?: number | null
  delay?: number | null
  slide_index?: number | null
}

export interface AddHyperlinkAction extends PlanBaseAction {
  op: 'add_hyperlink'
  address: string
  text_to_display?: string | null
  tooltip?: string | null
  target_shape_name?: string | null
  slide_index?: number | null
}

export interface SetPresentationPropsAction extends PlanBaseAction {
  op: 'set_presentation_props'
  title?: string | null
  author?: string | null
  subject?: string | null
  comments?: string | null
}

// ===================== WPP新增操作类型结束 =====================

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
  | SetParagraphFormatAction
  | ApplyParagraphStyleAction
  | NormalizeHeadingsAction
  | ApplyTextStyleToMatchesAction
  | SetWriterTableStyleAction
  | SetCellFormulaAction
  | SetNumberFormatAction
  | SetConditionalFormatAction
  | SetDataValidationAction
  | SortRangeAction
  | FilterRangeAction
  | TransformRangeAction
  | CreatePivotTableAction
  | SetSlideBackgroundAction
  | SetSlideTextStyleAction
  | SetSlideThemeAction
  | SetSlideLayoutAction
  | SetShapeStyleAction
  | SetTableStyleAction
  // WPP新增操作
  | AddSlideAction
  | AddTextboxAction
  | AddImageAction
  | AddChartAction
  | AddTableAction
  | AddShapeAction
  | DeleteSlideAction
  | DuplicateSlideAction
  | ReorderSlidesAction
  | SetSlideTransitionAction
  | AddAnimationAction
  | SetAnimationTimingAction
  | AddHyperlinkAction
  | SetPresentationPropsAction
  // 通用操作
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

  private _planImageResources: Map<string, string> | null = null
  private _planImageUrlCache: Map<string, string> | null = null

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

    let parsed: Plan | null = null
    try {
      parsed = this.parsePlan(plan)
      this.preparePlanResources(parsed)

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
        // Best-effort tolerance: some models occasionally output the wrong host_app even though the ops
        // are compatible. If the plan contains ops unsupported by the actual host, keep this strict.
        const allowed = this.allowedOpsForHost(actualHost)
        const ops = this.collectOps(parsed.actions as any)
        const unsupported = ops.filter((op) => !allowed.has(op))
        if (unsupported.length > 0) {
          throw new Error(
            `host_app mismatch: plan=${parsed.host_app} actual=${actualHost} (unsupported ops for actual host: ${unsupported
              .slice(0, 8)
              .join(',')})`
          )
        }
        try {
          _planDiag('warning', `host_app mismatch: plan=${parsed.host_app} actual=${actualHost}; proceed with actual host`)
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
        }
        ;(parsed as any).host_app = actualHost
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
    } finally {
      this._planImageResources = null
      this._planImageUrlCache = null
    }
  }

  private preparePlanResources(plan: Plan) {
    try {
      this._planImageResources = new Map()
      this._planImageUrlCache = new Map()

      const meta = (plan as any)?.meta
      const resources = meta && typeof meta === 'object' ? (meta as any).resources : null
      const images = resources && typeof resources === 'object' ? (resources as any).images : null
      if (!Array.isArray(images)) return

      for (const img of images) {
        if (!img || typeof img !== 'object') continue
        const id = String((img as any).id || '').trim()
        const dataUrl = String((img as any).data_url || (img as any).dataUrl || '').trim()
        if (!id || !dataUrl) continue
        this._planImageResources.set(id, dataUrl)
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      this._planImageResources = null
      this._planImageUrlCache = null
    }
  }

  private allowedOpsForHost(host: 'wps' | 'et' | 'wpp' | 'unknown'): Set<string> {
    if (host === 'et') {
      return new Set([
        'upsert_block',
        'delete_block',
        'set_selection',
        'insert_text',
        'insert_table',
        'insert_chart_from_selection',
        'set_cell_formula',
        'set_number_format',
        'set_conditional_format',
        'set_data_validation',
        'sort_range',
        'filter_range',
        'transform_range',
        'create_pivot_table',
      ])
    }
    if (host === 'wpp') {
      return new Set([
        'upsert_block',
        'delete_block',
        'insert_text',
        'insert_word_art',
        'set_slide_background',
        'set_slide_text_style',
        'set_slide_theme',
        'set_slide_layout',
        'set_shape_style',
        'set_table_style',
        // WPP新增操作
        'add_slide',
        'add_textbox',
        'add_image',
        'add_chart',
        'add_table',
        'add_shape',
        'delete_slide',
        'duplicate_slide',
        'reorder_slides',
        'set_slide_transition',
        'add_animation',
        'set_animation_timing',
        'add_hyperlink',
        'set_presentation_props',
      ])
    }
    return new Set([
      'upsert_block',
      'delete_block',
      'set_selection',
      'insert_text',
      'insert_after_text',
      'insert_before_text',
      'insert_table',
      'insert_chart_from_selection',
      'insert_word_art',
      'set_text_style',
      'set_paragraph_format',
      'apply_paragraph_style',
      'normalize_headings',
      'apply_text_style_to_matches',
      'set_writer_table_style',
      'answer_mode_apply',
    ])
  }

  private collectOps(actions: any[]): string[] {
    const ops: string[] = []
    const walk = (arr: any[]) => {
      for (const a of arr || []) {
        if (a && typeof a.op === 'string') ops.push(String(a.op))
        if (a && a.op === 'upsert_block' && Array.isArray(a.actions)) walk(a.actions)
      }
    }
    walk(Array.isArray(actions) ? actions : [])
    return Array.from(new Set(ops)).filter((x) => !!x)
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
      if (!p.schema_version && p.schemaVersion) p.schema_version = p.schemaVersion
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
        setWriterTableStyle: 'set_writer_table_style',
        applyParagraphStyle: 'apply_paragraph_style',
        normalizeHeadings: 'normalize_headings',
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
          // Normalize a single action object into an array (common mistake).
          if (isPlainObject(a.actions) && (a.actions as any).op) {
            a.actions = [a.actions]
          } else {
            const contentText = (() => {
              try {
                if (typeof a.content === 'string') return a.content
                if (Array.isArray(a.content)) {
                  const parts: string[] = []
                  for (const item of a.content) {
                    if (typeof item === 'string') {
                      const s = String(item || '').trim()
                      if (s) parts.push(s)
                      continue
                    }
                    if (isPlainObject(item)) {
                      const t = (item as any).text
                      if (typeof t === 'string') {
                        const s = t.trim()
                        if (s) parts.push(s)
                      }
                    }
                  }
                  return parts.join('\n')
                }
                if (typeof a.text === 'string') return a.text
                return ''
              } catch (e) {
                ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
                return typeof a.text === 'string' ? a.text : ''
              }
            })()
            if (contentText && String(contentText).trim()) {
              a.actions = [
                {
                  id: `${a.id}_1`,
                  title: 'Insert text',
                  op: 'insert_text',
                  text: String(contentText),
                  new_paragraph_after: true
                }
              ]
            } else if (isPlainObject(a.content)) {
              // Legacy shape payloads sometimes appear as: { content: { options: { shapes: [...] } } }.
              // We don't support arbitrary shape specs in Plan JSON; degrade gracefully to a visible "sun" writeback
              // so users still see an effect and repair can pick it up if needed.
              const shapes = (() => {
                try {
                  const c: any = a.content
                  if (Array.isArray(c?.options?.shapes)) return c.options.shapes
                  if (Array.isArray(c?.shapes)) return c.shapes
                  return null
                } catch (e) {
                  ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
                  return null
                }
              })()
              if (Array.isArray(shapes) && shapes.length > 0) {
                a.actions = [
                  {
                    id: `${a.id}_1`,
                    title: 'Insert sun (fallback)',
                    op: 'insert_word_art',
                    text: '☀',
                    size: 96,
                    bold: true
                  }
                ]
              }
            }
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

      if (a.op === 'apply_paragraph_style') {
        if (a.apply_to_selection == null) a.apply_to_selection = true
        if (a.max_paragraphs == null) a.max_paragraphs = 2000
      }

      if (a.op === 'normalize_headings') {
        if (a.apply_to_selection == null) a.apply_to_selection = true
        if (a.max_paragraphs == null) a.max_paragraphs = 3000
        if (!Array.isArray(a.levels)) a.levels = []
      }

      if (a.op === 'set_writer_table_style') {
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
      case 'set_paragraph_format':
        this.setParagraphFormat(ctx.doc, ctx.selection, action as any)
        return
      case 'apply_paragraph_style':
        this.applyParagraphStyle(ctx.doc, ctx.selection, action as any)
        return
      case 'normalize_headings':
        this.normalizeHeadings(ctx.doc, ctx.selection, action as any)
        return
      case 'apply_text_style_to_matches':
        this.applyTextStyleToMatches(ctx.doc, action as any)
        return
      case 'set_writer_table_style':
        this.setWriterTableStyle(ctx.doc, ctx.selection, action as any)
        return
      case 'answer_mode_apply':
        this.answerModeApply(ctx, action as any)
        return
      case 'delete_block':
        this.deleteBlock(ctx.doc, action.block_id)
        return
      case 'upsert_block':
        if (!Array.isArray((action as any).actions) || (action as any).actions.length === 0) {
          throw new Error('upsert_block requires non-empty actions (do not use legacy content/options payloads)')
        }
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
    const applyToSelection = (action as any)?.apply_to_selection !== false
    const target = applyToSelection ? (this.safe(() => selection?.Range) || this.safe(() => doc?.Content)) : this.safe(() => doc?.Content)
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

  private setParagraphFormat(doc: any, selection: any, action: SetParagraphFormatAction) {
    const applyToSelection = (action as any)?.apply_to_selection !== false
    const blockId = String((action as any)?.block_id || '').trim()

    let target: any = null
    if (blockId) {
      try {
        const bmName = this.bookmarkName(blockId)
        const bmRange = this.getBookmarkRange(doc, bmName)
        const s = bmRange ? this.safe(() => (bmRange as any).Start) : null
        const e = bmRange ? this.safe(() => (bmRange as any).End) : null
        if (typeof s === 'number' && typeof e === 'number' && e >= s) {
          target = this.getDocRange(doc, s, e)
        } else {
          const startTag = this.tag(blockId, 'START')
          const endTag = this.tag(blockId, 'END')
          const startR = this.findTextRange(doc, startTag)
          const endR = startR ? this.findTextRange(doc, endTag, (startR as any).End) : null
          const innerStart = startR ? this.safe(() => (startR as any).End) : null
          const innerEnd = endR ? this.safe(() => (endR as any).Start) : null
          if (typeof innerStart === 'number' && typeof innerEnd === 'number' && innerEnd >= innerStart) {
            target = this.getDocRange(doc, innerStart, innerEnd)
          }
        }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
    }

    if (!target) {
      target = applyToSelection ? (this.safe(() => selection?.Range) || this.safe(() => doc?.Content)) : this.safe(() => doc?.Content)
    }
    if (!target) throw new Error('set_paragraph_format target range not available')

    const alignmentRaw = String((action as any)?.alignment || '').trim().toLowerCase()
    const lineSpacingRaw = String((action as any)?.line_spacing || '').trim().toLowerCase()
    const spaceBeforeRaw = (action as any)?.space_before
    const spaceAfterRaw = (action as any)?.space_after

    const hasSpaceBefore = Number.isFinite(Number(spaceBeforeRaw)) && Number(spaceBeforeRaw) >= 0
    const hasSpaceAfter = Number.isFinite(Number(spaceAfterRaw)) && Number(spaceAfterRaw) >= 0

    const applyToParagraphFormat = (pf: any) => {
      if (!pf) return
      const alignMap: Record<string, number> = { left: 0, center: 1, right: 2, justify: 3 }
      if (alignmentRaw && alignmentRaw in alignMap) this.safe(() => ((pf as any).Alignment = alignMap[alignmentRaw]))
      if (hasSpaceBefore) this.safe(() => ((pf as any).SpaceBefore = Number(spaceBeforeRaw)))
      if (hasSpaceAfter) this.safe(() => ((pf as any).SpaceAfter = Number(spaceAfterRaw)))

      const lsMap: Record<string, number> = { single: 0, '1.5': 1, double: 2 }
      if (lineSpacingRaw && lineSpacingRaw in lsMap) {
        // Best-effort: use Word-compatible constants when available.
        this.safe(() => ((pf as any).LineSpacingRule = lsMap[lineSpacingRaw]))
      }
    }

    // Fast path: set range-level paragraph format.
    const pf = this.safe(() => (target as any).ParagraphFormat)
    if (pf) applyToParagraphFormat(pf)

    // Best-effort: iterate paragraphs (scoped ranges are small; cap for safety).
    try {
      const paras = this.safe(() => (target as any).Paragraphs)
      const count = Number(this.safe(() => (paras as any)?.Count, 0)) || 0
      const cap = Math.min(500, Math.max(0, count))
      for (let i = 1; i <= cap; i++) {
        const p = this.safe(() => (paras as any).Item(i))
        const pr = p ? this.safe(() => (p as any).Range) : null
        const ppf = pr ? this.safe(() => (pr as any).ParagraphFormat) : null
        if (ppf) applyToParagraphFormat(ppf)
      }
      if (count > cap) {
        _planDiag('warning', `set_paragraph_format: paragraph count capped ${cap}/${count}`)
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }
  }

  private applyParagraphStyle(doc: any, selection: any, action: ApplyParagraphStyleAction) {
    const applyToSelection = (action as any)?.apply_to_selection !== false
    const blockId = String((action as any)?.block_id || '').trim()

    let target: any = null
    if (blockId) {
      try {
        const bmName = this.bookmarkName(blockId)
        const bmRange = this.getBookmarkRange(doc, bmName)
        const s = bmRange ? this.safe(() => (bmRange as any).Start) : null
        const e = bmRange ? this.safe(() => (bmRange as any).End) : null
        if (typeof s === 'number' && typeof e === 'number' && e >= s) {
          target = this.getDocRange(doc, s, e)
        } else {
          const startTag = this.tag(blockId, 'START')
          const endTag = this.tag(blockId, 'END')
          const startR = this.findTextRange(doc, startTag)
          const endR = startR ? this.findTextRange(doc, endTag, (startR as any).End) : null
          const innerStart = startR ? this.safe(() => (startR as any).End) : null
          const innerEnd = endR ? this.safe(() => (endR as any).Start) : null
          if (typeof innerStart === 'number' && typeof innerEnd === 'number' && innerEnd >= innerStart) {
            target = this.getDocRange(doc, innerStart, innerEnd)
          }
        }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
    }

    if (!target) {
      target = applyToSelection ? (this.safe(() => selection?.Range) || this.safe(() => doc?.Content)) : this.safe(() => doc?.Content)
    }
    if (!target) throw new Error('apply_paragraph_style target range not available')

    const fontName = String((action as any)?.font || '').trim()
    const sizeRaw = (action as any)?.size
    const hasSize = Number.isFinite(Number(sizeRaw)) && Number(sizeRaw) > 0
    const boldRaw = (action as any)?.bold
    const italicRaw = (action as any)?.italic
    const colorRaw = String((action as any)?.color || '').trim()
    const color = colorRaw ? this._hexToBgrLong(colorRaw) : null

    const alignmentRaw = String((action as any)?.alignment || '').trim().toLowerCase()
    const lineSpacingRaw = String((action as any)?.line_spacing || '').trim().toLowerCase()
    const spaceBeforeRaw = (action as any)?.space_before
    const spaceAfterRaw = (action as any)?.space_after
    const hasSpaceBefore = Number.isFinite(Number(spaceBeforeRaw)) && Number(spaceBeforeRaw) >= 0
    const hasSpaceAfter = Number.isFinite(Number(spaceAfterRaw)) && Number(spaceAfterRaw) >= 0

    const hasAny =
      !!fontName ||
      hasSize ||
      typeof boldRaw === 'boolean' ||
      typeof italicRaw === 'boolean' ||
      color != null ||
      !!alignmentRaw ||
      !!lineSpacingRaw ||
      hasSpaceBefore ||
      hasSpaceAfter
    if (!hasAny) throw new Error('apply_paragraph_style: no style fields provided')

    const applyToFont = (font: any) => {
      if (!font) return
      if (fontName) this.safe(() => ((font as any).Name = fontName))
      if (hasSize) this.safe(() => ((font as any).Size = Number(sizeRaw)))
      if (typeof boldRaw === 'boolean') this.safe(() => ((font as any).Bold = boldRaw ? 1 : 0))
      if (typeof italicRaw === 'boolean') this.safe(() => ((font as any).Italic = italicRaw ? 1 : 0))
      if (color != null) this.safe(() => ((font as any).Color = color))
    }

    const applyToParagraphFormat = (pf: any) => {
      if (!pf) return
      const alignMap: Record<string, number> = { left: 0, center: 1, right: 2, justify: 3 }
      if (alignmentRaw && alignmentRaw in alignMap) this.safe(() => ((pf as any).Alignment = alignMap[alignmentRaw]))
      if (hasSpaceBefore) this.safe(() => ((pf as any).SpaceBefore = Number(spaceBeforeRaw)))
      if (hasSpaceAfter) this.safe(() => ((pf as any).SpaceAfter = Number(spaceAfterRaw)))
      const lsMap: Record<string, number> = { single: 0, '1.5': 1, double: 2 }
      if (lineSpacingRaw && lineSpacingRaw in lsMap) this.safe(() => ((pf as any).LineSpacingRule = lsMap[lineSpacingRaw]))
    }

    // Fast path: range-level formatting.
    try {
      const f = this.safe(() => (target as any).Font)
      if (f) applyToFont(f)
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }
    try {
      const pf = this.safe(() => (target as any).ParagraphFormat)
      if (pf) applyToParagraphFormat(pf)
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }

    // Iterate paragraphs (cap for safety).
    const maxRaw = (action as any)?.max_paragraphs
    const maxCap = Math.max(1, Math.min(5000, Number.isFinite(Number(maxRaw)) ? Number(maxRaw) : 2000))

    let errors = 0
    let firstErr: any = null
    try {
      const paras = this.safe(() => (target as any).Paragraphs)
      const count = Number(this.safe(() => (paras as any)?.Count, 0)) || 0
      const cap = Math.min(maxCap, Math.max(0, count))
      for (let i = 1; i <= cap; i++) {
        try {
          const p = this.safe(() => (paras as any).Item(i))
          const pr = p ? this.safe(() => (p as any).Range) : null
          if (!pr) continue
          const pf = this.safe(() => (pr as any).ParagraphFormat)
          const f = this.safe(() => (pr as any).Font)
          if (pf) applyToParagraphFormat(pf)
          if (f) applyToFont(f)
        } catch (e) {
          errors += 1
          if (!firstErr) firstErr = e
        }
      }
      if (count > cap) _planDiag('warning', `apply_paragraph_style: paragraph count capped ${cap}/${count}`)
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }

    if (errors > 0) {
      _planDiag('warning', `apply_paragraph_style: errors=${errors}`)
      if (firstErr) ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', firstErr)
    }

    this.emitCapabilityEvent('plan.capability_matrix', {
      host_app: 'wps',
      op: 'apply_paragraph_style',
      branch: 'applyParagraphStyle',
      fallback: errors > 0,
      success: true,
      block_id: blockId || undefined,
    })
  }

  private normalizeHeadings(doc: any, selection: any, action: NormalizeHeadingsAction) {
    const applyToSelection = (action as any)?.apply_to_selection !== false
    const blockId = String((action as any)?.block_id || '').trim()

    let target: any = null
    if (blockId) {
      try {
        const bmName = this.bookmarkName(blockId)
        const bmRange = this.getBookmarkRange(doc, bmName)
        const s = bmRange ? this.safe(() => (bmRange as any).Start) : null
        const e = bmRange ? this.safe(() => (bmRange as any).End) : null
        if (typeof s === 'number' && typeof e === 'number' && e >= s) {
          target = this.getDocRange(doc, s, e)
        } else {
          const startTag = this.tag(blockId, 'START')
          const endTag = this.tag(blockId, 'END')
          const startR = this.findTextRange(doc, startTag)
          const endR = startR ? this.findTextRange(doc, endTag, (startR as any).End) : null
          const innerStart = startR ? this.safe(() => (startR as any).End) : null
          const innerEnd = endR ? this.safe(() => (endR as any).Start) : null
          if (typeof innerStart === 'number' && typeof innerEnd === 'number' && innerEnd >= innerStart) {
            target = this.getDocRange(doc, innerStart, innerEnd)
          }
        }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
    }

    if (!target) {
      target = applyToSelection ? (this.safe(() => selection?.Range) || this.safe(() => doc?.Content)) : this.safe(() => doc?.Content)
    }
    if (!target) throw new Error('normalize_headings target range not available')

    const maxRaw = (action as any)?.max_paragraphs
    const maxCap = Math.max(1, Math.min(5000, Number.isFinite(Number(maxRaw)) ? Number(maxRaw) : 3000))

    const rawLevels = Array.isArray((action as any)?.levels) ? (action as any).levels : []
    const byLevel = new Map<number, NormalizeHeadingsLevelStyle>()
    for (const it of rawLevels) {
      if (!it || typeof it !== 'object') continue
      const lvl = Number((it as any).level)
      if (!Number.isFinite(lvl) || lvl < 1 || lvl > 9) continue
      byLevel.set(Math.floor(lvl), it as any)
    }

    // Built-in defaults (only used when no levels are provided).
    if (byLevel.size === 0) {
      byLevel.set(1, { level: 1, bold: true, size: 16, space_before: 6, space_after: 6 })
      byLevel.set(2, { level: 2, bold: true, size: 14, space_before: 4, space_after: 4 })
      byLevel.set(3, { level: 3, bold: true, size: 12, space_before: 3, space_after: 3 })
    }

    const applyToFont = (font: any, st: NormalizeHeadingsLevelStyle) => {
      if (!font || !st) return
      const fontName = String((st as any)?.font || '').trim()
      const sizeRaw = (st as any)?.size
      const hasSize = Number.isFinite(Number(sizeRaw)) && Number(sizeRaw) > 0
      const boldRaw = (st as any)?.bold
      const italicRaw = (st as any)?.italic
      const colorRaw = String((st as any)?.color || '').trim()
      const color = colorRaw ? this._hexToBgrLong(colorRaw) : null
      if (fontName) this.safe(() => ((font as any).Name = fontName))
      if (hasSize) this.safe(() => ((font as any).Size = Number(sizeRaw)))
      if (typeof boldRaw === 'boolean') this.safe(() => ((font as any).Bold = boldRaw ? 1 : 0))
      if (typeof italicRaw === 'boolean') this.safe(() => ((font as any).Italic = italicRaw ? 1 : 0))
      if (color != null) this.safe(() => ((font as any).Color = color))
    }

    const applyToParagraphFormat = (pf: any, st: NormalizeHeadingsLevelStyle) => {
      if (!pf || !st) return
      const alignmentRaw = String((st as any)?.alignment || '').trim().toLowerCase()
      const lineSpacingRaw = String((st as any)?.line_spacing || '').trim().toLowerCase()
      const spaceBeforeRaw = (st as any)?.space_before
      const spaceAfterRaw = (st as any)?.space_after
      const hasSpaceBefore = Number.isFinite(Number(spaceBeforeRaw)) && Number(spaceBeforeRaw) >= 0
      const hasSpaceAfter = Number.isFinite(Number(spaceAfterRaw)) && Number(spaceAfterRaw) >= 0

      const alignMap: Record<string, number> = { left: 0, center: 1, right: 2, justify: 3 }
      if (alignmentRaw && alignmentRaw in alignMap) this.safe(() => ((pf as any).Alignment = alignMap[alignmentRaw]))
      if (hasSpaceBefore) this.safe(() => ((pf as any).SpaceBefore = Number(spaceBeforeRaw)))
      if (hasSpaceAfter) this.safe(() => ((pf as any).SpaceAfter = Number(spaceAfterRaw)))
      const lsMap: Record<string, number> = { single: 0, '1.5': 1, double: 2 }
      if (lineSpacingRaw && lineSpacingRaw in lsMap) this.safe(() => ((pf as any).LineSpacingRule = lsMap[lineSpacingRaw]))
    }

    const detectLevel = (p: any): number | null => {
      // Prefer OutlineLevel when available.
      const ol = Number(this.safe(() => (p as any).OutlineLevel, NaN as any) as any)
      if (Number.isFinite(ol) && ol >= 1 && ol <= 9) return Math.floor(ol)

      // Fallback: parse style name like "Heading 1" / "标题 1".
      const styleObj = this.safe(() => (p as any).Range?.Style) || this.safe(() => (p as any).Style)
      let name = ''
      if (typeof styleObj === 'string') name = styleObj
      else if (styleObj) {
        name =
          String(this.safe(() => (styleObj as any).NameLocal, '' as any) as any) ||
          String(this.safe(() => (styleObj as any).Name, '' as any) as any) ||
          ''
      }
      name = String(name || '').trim()
      if (!name) return null
      const m = name.match(/(?:heading|标题)\s*([1-9])/i)
      if (m && m[1]) {
        const n = Number(m[1])
        if (Number.isFinite(n) && n >= 1 && n <= 9) return n
      }
      return null
    }

    let applied = 0
    let errors = 0
    let firstErr: any = null
    try {
      const paras = this.safe(() => (target as any).Paragraphs)
      const count = Number(this.safe(() => (paras as any)?.Count, 0)) || 0
      const cap = Math.min(maxCap, Math.max(0, count))
      for (let i = 1; i <= cap; i++) {
        try {
          const p = this.safe(() => (paras as any).Item(i))
          if (!p) continue
          const lvl = detectLevel(p)
          if (!lvl) continue
          const st = byLevel.get(lvl)
          if (!st) continue
          const pr = this.safe(() => (p as any).Range)
          if (!pr) continue
          const pf = this.safe(() => (pr as any).ParagraphFormat)
          const f = this.safe(() => (pr as any).Font)
          if (pf) applyToParagraphFormat(pf, st)
          if (f) applyToFont(f, st)
          applied += 1
        } catch (e) {
          errors += 1
          if (!firstErr) firstErr = e
        }
      }
      if (count > cap) _planDiag('warning', `normalize_headings: paragraph count capped ${cap}/${count}`)
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }

    if (errors > 0) {
      _planDiag('warning', `normalize_headings: errors=${errors}`)
      if (firstErr) ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', firstErr)
    }
    _planDiag('info', `normalize_headings: applied=${applied}`)

    this.emitCapabilityEvent('plan.capability_matrix', {
      host_app: 'wps',
      op: 'normalize_headings',
      branch: 'normalizeHeadings',
      fallback: errors > 0,
      success: true,
      block_id: blockId || undefined,
      applied,
    })
  }

  private setWriterTableStyle(doc: any, selection: any, action: SetWriterTableStyleAction) {
    const applyToSelection = (action as any)?.apply_to_selection !== false
    const blockId = String((action as any)?.block_id || '').trim()

    const styleName = String((action as any)?.style_name || '').trim()
    const borders = (action as any)?.borders
    const header = (action as any)?.header

    let target: any = null
    if (blockId) {
      try {
        const bmName = this.bookmarkName(blockId)
        const bmRange = this.getBookmarkRange(doc, bmName)
        const s = bmRange ? this.safe(() => (bmRange as any).Start) : null
        const e = bmRange ? this.safe(() => (bmRange as any).End) : null
        if (typeof s === 'number' && typeof e === 'number' && e >= s) {
          target = this.getDocRange(doc, s, e)
        } else {
          const startTag = this.tag(blockId, 'START')
          const endTag = this.tag(blockId, 'END')
          const startR = this.findTextRange(doc, startTag)
          const endR = startR ? this.findTextRange(doc, endTag, (startR as any).End) : null
          const innerStart = startR ? this.safe(() => (startR as any).End) : null
          const innerEnd = endR ? this.safe(() => (endR as any).Start) : null
          if (typeof innerStart === 'number' && typeof innerEnd === 'number' && innerEnd >= innerStart) {
            target = this.getDocRange(doc, innerStart, innerEnd)
          }
        }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
    }

    if (!target) {
      target = applyToSelection
        ? (this.safe(() => selection?.Range) || this.safe(() => doc?.Content))
        : this.safe(() => doc?.Content)
    }
    if (!target) throw new Error('set_writer_table_style target range not available')

    const tables =
      this.safe(() => (target as any).Tables) ||
      this.safe(() => (selection as any)?.Range?.Tables) ||
      this.safe(() => (selection as any)?.Tables) ||
      null
    const count = Number(this.safe(() => (tables as any)?.Count, 0)) || 0
    if (!tables || count <= 0) {
      try {
        _planDiag(
          'warning',
          `set_writer_table_style: no tables found (block_id=${blockId || ''} apply_to_selection=${applyToSelection})`
        )
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'wps',
        op: 'set_writer_table_style',
        branch: 'resolveTables',
        fallback: true,
        success: false,
        block_id: blockId || undefined,
      })
      return
    }

    let styleOk: boolean | null = null
    let bordersOk: boolean | null = null
    let headerOk: boolean | null = null

    const cap = Math.min(80, Math.max(0, count))
    for (let i = 1; i <= cap; i++) {
      const table =
        this.safe(() => (tables as any).Item?.(i)) ||
        this.safe(() => (tables as any).Item(i)) ||
        this.safe(() => (tables as any)(i))
      if (!table) continue

      if (styleName) {
        try {
          this.safe(() => (((table as any).Style as any) = styleName))
          if (styleOk == null) styleOk = true
        } catch (e) {
          if (styleOk == null) styleOk = false
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
        }
      }

      if (typeof borders === 'boolean') {
        try {
          this.safe(() => ((((table as any).Borders as any).Enable as any) = borders ? 1 : 0))
          if (bordersOk == null) bordersOk = true
        } catch (e) {
          if (bordersOk == null) bordersOk = false
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
        }
      }

      if (typeof header === 'boolean') {
        try {
          const rows = this.safe(() => (table as any).Rows)
          const row1 = rows
            ? this.safe(() => (rows as any).Item?.(1)) ||
              this.safe(() => (rows as any).Item(1)) ||
              (typeof rows === 'function' ? this.safe(() => (rows as any)(1)) : null)
            : null
          if (row1) this.safe(() => (((row1 as any).HeadingFormat as any) = header ? 1 : 0))
          if (headerOk == null) headerOk = true
        } catch (e) {
          if (headerOk == null) headerOk = false
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
        }
      }
    }

    if (count > cap) _planDiag('warning', `set_writer_table_style: table_count=${count} capped=${cap}`)
    if (styleName && styleOk === false) _planDiag('warning', 'set_writer_table_style: failed to apply style_name')
    if (typeof borders === 'boolean' && bordersOk === false) _planDiag('warning', 'set_writer_table_style: failed to apply borders')
    if (typeof header === 'boolean' && headerOk === false) _planDiag('warning', 'set_writer_table_style: failed to apply header')

    if (styleName) {
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'wps',
        op: 'set_writer_table_style',
        branch: 'Table.Style',
        fallback: styleOk === false,
        success: styleOk !== false,
        block_id: blockId || undefined,
      })
    }
    if (typeof borders === 'boolean') {
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'wps',
        op: 'set_writer_table_style',
        branch: 'Table.Borders.Enable',
        fallback: bordersOk === false,
        success: bordersOk !== false,
        block_id: blockId || undefined,
      })
    }
    if (typeof header === 'boolean') {
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'wps',
        op: 'set_writer_table_style',
        branch: 'Table.Header',
        fallback: headerOk === false,
        success: headerOk !== false,
        block_id: blockId || undefined,
      })
    }
  }

  private applyTextStyleToMatches(doc: any, action: ApplyTextStyleToMatchesAction) {
    const findText = String((action as any)?.find_text || '').trim()
    if (!findText) throw new Error('apply_text_style_to_matches: find_text is required')

    const maxMatchesRaw = (action as any)?.max_matches
    const maxMatches = Math.max(1, Math.min(500, Number.isFinite(Number(maxMatchesRaw)) ? Number(maxMatchesRaw) : 50))

    const caseSensitive = (action as any)?.case_sensitive === true
    const wholeWord = (action as any)?.whole_word === true

    const fontName = String((action as any)?.font || '').trim()
    const sizeRaw = (action as any)?.size
    const hasSize = Number.isFinite(Number(sizeRaw)) && Number(sizeRaw) > 0
    const boldRaw = (action as any)?.bold
    const italicRaw = (action as any)?.italic
    const colorRaw = String((action as any)?.color || '').trim()
    const color = colorRaw ? this._hexToBgrLong(colorRaw) : null

    const styleHasAny =
      !!fontName || hasSize || typeof boldRaw === 'boolean' || typeof italicRaw === 'boolean' || color != null
    if (!styleHasAny) throw new Error('apply_text_style_to_matches: no style fields provided')

    // Optional: scope to an upsert_block by block_id (bookmark preferred).
    let scopeStart: number | null = null
    let scopeEnd: number | null = null
    const blockId = String((action as any)?.block_id || '').trim()
    if (blockId) {
      try {
        const bmName = this.bookmarkName(blockId)
        const bmRange = this.getBookmarkRange(doc, bmName)
        const s = bmRange ? this.safe(() => (bmRange as any).Start) : null
        const e = bmRange ? this.safe(() => (bmRange as any).End) : null
        if (typeof s === 'number' && typeof e === 'number' && e >= s) {
          scopeStart = s
          scopeEnd = e
        } else {
          const startTag = this.tag(blockId, 'START')
          const endTag = this.tag(blockId, 'END')
          const startR = this.findTextRange(doc, startTag)
          const endR = startR ? this.findTextRange(doc, endTag, (startR as any).End) : null
          const innerStart = startR ? this.safe(() => (startR as any).End) : null
          const innerEnd = endR ? this.safe(() => (endR as any).Start) : null
          if (typeof innerStart === 'number' && typeof innerEnd === 'number' && innerEnd >= innerStart) {
            scopeStart = innerStart
            scopeEnd = innerEnd
          }
        }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
    }

    const full = this.safe(() => doc?.Range?.())
    if (!full) throw new Error('apply_text_style_to_matches: doc.Range not available')

    const docStart = typeof scopeStart === 'number' ? scopeStart : (this.safe(() => (full as any).Start) as any)
    const docEnd = typeof scopeEnd === 'number' ? scopeEnd : (this.safe(() => (full as any).End) as any)
    if (typeof docStart !== 'number' || typeof docEnd !== 'number' || docEnd < docStart) {
      throw new Error('apply_text_style_to_matches: invalid scope range')
    }

    const r = this.getDocRange(doc, docStart, docEnd)
    if (!r || !(r as any).Find) throw new Error('apply_text_style_to_matches: Find not available')

    this.safe(() => (r as any).Find.ClearFormatting && (r as any).Find.ClearFormatting())
    this.safe(() => ((r as any).Find.Text = findText))
    this.safe(() => ((r as any).Find.Forward = true))
    this.safe(() => ((r as any).Find.Wrap = 0))
    // These are best-effort: some hosts expose booleans, some expose 0/1.
    this.safe(() => ((r as any).Find.MatchCase = caseSensitive ? 1 : 0))
    this.safe(() => ((r as any).Find.MatchWholeWord = wholeWord ? 1 : 0))

    let applied = 0
    for (let i = 0; i < maxMatches; i++) {
      const ok = this.safe(() => !!(r as any).Find.Execute(), false as any) as any
      if (!ok) break

      const font = this.safe(() => (r as any).Font)
      if (font) {
        if (fontName) this.safe(() => ((font as any).Name = fontName))
        if (hasSize) this.safe(() => ((font as any).Size = Number(sizeRaw)))
        if (typeof boldRaw === 'boolean') this.safe(() => ((font as any).Bold = boldRaw ? 1 : 0))
        if (typeof italicRaw === 'boolean') this.safe(() => ((font as any).Italic = italicRaw ? 1 : 0))
        if (color != null) this.safe(() => ((font as any).Color = color))
      }

      applied += 1

      // Move forward to avoid infinite loops.
      const nextStart = this.safe(() => (r as any).End)
      if (typeof nextStart !== 'number' || nextStart >= docEnd) break
      this.safe(() => (r as any).SetRange(nextStart, docEnd))
    }

    try {
      if (applied === 0) _planDiag('warning', `apply_text_style_to_matches: no matches for '${findText.slice(0, 60)}'`)
      else _planDiag('info', `apply_text_style_to_matches: applied=${applied} text='${findText.slice(0, 60)}'`)
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }
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

    // IMPORTANT: advance/collapse selection to the end, otherwise subsequent insert_text actions
    // may insert before/overwrite the previous text on some WPS builds (appears as reversed order).
    try {
      const endPos = this.safe(() => (r as any).End)
      if (typeof endPos === 'number') {
        this.safe(() => (r as any).SetRange && (r as any).SetRange(endPos, endPos))
        this.safe(() => selection.SetRange && selection.SetRange(endPos, endPos))
        this.safe(() => selection.Range?.SetRange && selection.Range.SetRange(endPos, endPos))
      }
      // Fallback: some runtimes only expose Collapse on Selection.
      this.safe(() => selection.Collapse && selection.Collapse(0))
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }
    if (after) this.insertParagraphAfter(selection)
  }

  private insertAfterText(doc: any, anchorText: string, insertText: string, before?: boolean, after?: boolean) {
    const anchor = this.findTextRange(doc, String(anchorText || '').trim())
    if (!anchor) throw new Error(`anchor not found: ${String(anchorText || '')}`)
    const pos = anchor.End
    const r = this.getDocRange(doc, pos, pos)
    if (!r) throw new Error(`failed to get insert range (after anchor at pos=${String(pos)})`)
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
    if (!r) throw new Error(`failed to get insert range (before anchor at pos=${String(pos)})`)
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

    const data = (action as any)?.data as any
    if (Array.isArray(data) && data.length > 0) {
      let cellErrors = 0
      let firstCellError: any = null
      for (let rr = 0; rr < Math.min(data.length, rows); rr++) {
        const row = Array.isArray(data[rr]) ? data[rr] : []
        for (let cc = 0; cc < Math.min(row.length, cols); cc++) {
          try {
            const cell = this.safe(() => table.Cell(rr + 1, cc + 1))
            const rng = cell ? this.safe(() => cell.Range) : null
            if (!rng) continue
            const text = row[cc] == null ? '' : String(row[cc])
            this.safe(() => ((rng as any).Text = text))
          } catch (e) {
            cellErrors += 1
            if (!firstCellError) firstCellError = e
          }
        }
      }
      if (cellErrors > 0) {
        _planDiag('warning', `insert_table(wps) fill cell errors=${cellErrors}`)
        if (firstCellError) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', firstCellError)
        }
      }
    }
  }

  private insertChartFromSelection(doc: any, _selection: any, action: InsertChartFromSelectionAction) {
    const chartType = action.chart_type || 51

    let shape = this.safe(() => doc.InlineShapes.AddChart2(chartType))
    if (!shape) shape = this.safe(() => doc.Shapes.AddChart2(chartType))
    if (!shape) throw new Error('insert_chart_from_selection failed')

    if (action.width) this.safe(() => (shape.Width = action.width))
    if (action.height) this.safe(() => (shape.Height = action.height))

    const title = (action as any)?.title
    const hasLegend = (action as any)?.has_legend
    const legendPos = (action as any)?.legend_position
    const chart = this.safe(() => (shape as any).Chart)
    if (chart) {
      if (title) {
        this.safe(() => ((chart as any).HasTitle = 1))
        const ct = this.safe(() => (chart as any).ChartTitle)
        if (ct) this.safe(() => ((ct as any).Text = String(title)))
      }
      if (hasLegend === false) this.safe(() => ((chart as any).HasLegend = 0))
      if (hasLegend === true) this.safe(() => ((chart as any).HasLegend = 1))
      if (legendPos) {
        const map: Record<string, number> = { right: -4152, left: -4131, top: -4160, bottom: -4107 }
        if (legendPos in map) {
          const lg = this.safe(() => (chart as any).Legend)
          if (lg) this.safe(() => ((lg as any).Position = map[legendPos]))
        }
      }

      // Best-effort: trendline / data labels (primarily for ET, but some WPS builds support them here too).
      const addTrendline = (action as any)?.add_trendline === true
      const showDataLabels = (action as any)?.show_data_labels === true
      const showPercent = (action as any)?.data_labels_show_percent === true
      if (addTrendline || showDataLabels) {
        const series =
          this.safe(() => (chart as any).SeriesCollection?.(1)) ||
          this.safe(() => (chart as any).SeriesCollection?.Item?.(1)) ||
          null
        if (series) {
          if (addTrendline) {
            const ok = !!this.safe(() => {
              const tls = typeof (series as any).Trendlines === 'function' ? (series as any).Trendlines() : (series as any).Trendlines
              if (tls && typeof tls.Add === 'function') {
                tls.Add()
                return true
              }
              return false
            }, false as any)
            this.emitCapabilityEvent('plan.capability_matrix', {
              host_app: 'wps',
              op: 'insert_chart_from_selection',
              branch: 'trendline',
              fallback: !ok,
              success: ok,
            })
          }
          if (showDataLabels) {
            const ok = !!this.safe(() => {
              if (typeof (series as any).ApplyDataLabels === 'function') (series as any).ApplyDataLabels()
              const dls = typeof (series as any).DataLabels === 'function' ? (series as any).DataLabels() : (series as any).DataLabels
              if (dls) {
                try { ;(dls as any).ShowValue = 1 } catch (e) { ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e) }
                if (showPercent) {
                  try { ;(dls as any).ShowPercentage = 1 } catch (e) { ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e) }
                }
              }
              return true
            }, false as any)
            this.emitCapabilityEvent('plan.capability_matrix', {
              host_app: 'wps',
              op: 'insert_chart_from_selection',
              branch: 'data_labels',
              fallback: !ok,
              success: ok,
            })
          }
        }
      }
    }
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
    const sheets = this.safe(() => wb?.Worksheets) || this.safe(() => wb?.Sheets)
    if (!sheets) throw new Error('Worksheets not available')
    const count = Number(this.safe(() => sheets.Count, 0)) || 0
    for (let i = 1; i <= count; i++) {
      const s =
        this.safe(() => (sheets as any).Item?.(i)) ||
        this.safe(() => (sheets as any).Item(i)) ||
        this.safe(() => (sheets as any)(i))
      if (!s) continue
      const n = String(this.safe(() => s.Name, '') || '')
      if (n === sheetName) return s
    }
    const addFn = (sheets as any)?.Add
    const created = typeof addFn === 'function' ? this.safe(() => addFn.call(sheets)) : null
    if (!created) throw new Error('failed to create worksheet')
    this.safe(() => (created.Name = sheetName))
    return created
  }

  private clearSheet(sheet: any) {
    const ok = this.safe(() => {
      const cells = (sheet as any)?.Cells
      if (cells && typeof (cells as any).Clear === 'function') return (cells as any).Clear()
      if (typeof cells === 'function') {
        const all = cells.call(sheet)
        if (all && typeof (all as any).Clear === 'function') return (all as any).Clear()
      }
      return null
    })
    if (ok !== null) return
    this.safe(() => ((sheet as any)?.UsedRange && typeof (sheet as any).UsedRange.Clear === 'function' ? (sheet as any).UsedRange.Clear() : null))
  }

  private activateSheet(sheet: any) {
    this.safe(() => (typeof sheet.Activate === 'function' ? sheet.Activate() : null))
  }

  private selectA1(sheet: any): any | null {
    try {
      const r = this.safe(() => sheet.Range('A1'))
      if (r && typeof r.Select === 'function') {
        this.safe(() => r.Select())
        return r
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }
    try {
      const cell = this.safe(() => {
        const cells = (sheet as any)?.Cells
        if (typeof cells === 'function') return cells.call(sheet, 1, 1)
        if (cells && typeof (cells as any).Item === 'function') return (cells as any).Item(1, 1)
        return null
      })
      if (cell && typeof cell.Select === 'function') {
        this.safe(() => cell.Select())
        return cell
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }
    return null
  }

  private insertTextEt(app: any, selection: any, text: string) {
    if (!selection) throw new Error('selection not available')
    const value = String(text || '')

    const errors: string[] = []
    let firstError: unknown = null

    const tryGetAddrA1 = (r: any): string => {
      try {
        const addr = (r as any)?.Address
        if (typeof addr === 'function') return String(addr.call(r, false, false) || '')
        if (typeof addr === 'string') return addr
      } catch (e) {
        if (!firstError) firstError = e
      }
      return ''
    }

    const tryGetSheetName = (r: any): string => {
      try {
        const ws = (r as any)?.Worksheet
        if (ws) return String(this.safe(() => (ws as any).Name, '' as any) || '')
      } catch (e) {
        if (!firstError) firstError = e
      }
      return ''
    }

    const tryWrite = (label: string, fn: () => void): boolean => {
      try {
        fn()
        return true
      } catch (e) {
        if (!firstError) firstError = e
        errors.push(`${label}: ${_errMsg(e)}`)
        return false
      }
    }

    const resolveRange = () => {
      // Some builds expose Selection as an object with .Range; others return Range directly.
      return this.safe(() => (selection as any)?.Range) || selection
    }

    const getFirstCell = (r: any) => {
      if (!r) return null
      try {
        const cells = (r as any).Cells
        if (typeof cells === 'function') return cells.call(r, 1, 1)
        if (cells && typeof cells.Item === 'function') return cells.Item(1, 1)
      } catch (e) {
        if (!firstError) firstError = e
        errors.push(`Range.Cells(1,1): ${_errMsg(e)}`)
      }
      return null
    }

    const writeToRange = (r: any): boolean => {
      if (!r) return false
      // Best-effort: ensure target is active; some hosts reject writes when not focused.
      tryWrite('Range.Select', () => {
        if (typeof (r as any).Select === 'function') (r as any).Select()
      })
      if (tryWrite('Range.Value2', () => { ;(r as any).Value2 = value })) return true
      if (tryWrite('Range.Value', () => { ;(r as any).Value = value })) return true
      return false
    }

    const range = resolveRange()
    const sheetName = tryGetSheetName(range)
    const addr = tryGetAddrA1(range)

    let ok = false
    ok = writeToRange(range)
    if (!ok) ok = writeToRange(getFirstCell(range))
    if (!ok) ok = writeToRange(this.safe(() => (app as any)?.ActiveCell))

    if (!ok) {
      try {
        _planDiag(
          'error',
          `insert_text(et) failed: sheet=${sheetName || ''} addr=${addr || ''} errors=${errors.slice(0, 4).join(' | ')}`
        )
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      if (firstError) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', firstError)
      }
      const detail = errors.filter(Boolean).slice(0, 2).join(' | ')
      throw new Error(detail ? `failed to write cell value: ${detail}` : 'failed to write cell value')
    }
  }

  private getSheetByNameEt(wb: any, sheetName: string): any | null {
    const name = String(sheetName || '')
      .trim()
      .replace(/^'/, '')
      .replace(/'$/, '')
    if (!name) return null

    const sheets = this.safe(() => wb?.Worksheets) || this.safe(() => wb?.Sheets)
    if (!sheets) return null

    const count = Number(this.safe(() => sheets.Count, 0)) || 0
    for (let i = 1; i <= count; i++) {
      const s =
        this.safe(() => (sheets as any).Item?.(i)) ||
        this.safe(() => (sheets as any).Item(i)) ||
        this.safe(() => (sheets as any)(i))
      if (!s) continue
      const n = String(this.safe(() => s.Name, '') || '')
      if (n === name) return s
    }
    return null
  }

  private parseEtSheetAndAddr(raw: string): { sheetName: string; addr: string } {
    let s = String(raw || '').trim()
    if (!s) return { sheetName: '', addr: '' }

    // Normalize common A1 notations:
    // - $A$1:$D$10 -> A1:D10
    // - Sheet1!$A$1:$D$10 -> (sheet=Sheet1, addr=A1:D10)
    s = s.replace(/\$/g, '')

    let sheetName = ''
    let addr = s
    const bang = s.indexOf('!')
    if (bang > 0) {
      sheetName = s.slice(0, bang).trim().replace(/^'/, '').replace(/'$/, '')
      addr = s.slice(bang + 1).trim()
    }

    // Strip an optional leading '=' (sometimes produced by copy/paste from formulas).
    addr = addr.replace(/^=/, '').trim()
    return { sheetName, addr }
  }

  private resolveSheetAndAddrEt(app: any, selection: any, addrRaw: string): { sheet: any; addr: string } {
    const wb = this.getActiveWorkbook(app)
    const baseSheet = this.safe(() => selection?.Worksheet) || this.safe(() => app?.ActiveSheet) || this.safe(() => wb?.ActiveSheet)
    const parsed = this.parseEtSheetAndAddr(addrRaw)
    let sheet = baseSheet
    if (parsed.sheetName) {
      if (!wb) throw new Error('workbook not available')
      const s = this.getSheetByNameEt(wb, parsed.sheetName)
      if (!s) throw new Error(`sheet not found: ${parsed.sheetName}`)
      sheet = s
      this.activateSheet(sheet)
    }
    if (!sheet) throw new Error('ET active sheet not available')
    return { sheet, addr: parsed.addr }
  }

  private setSelectionEt(ctx: { app: any; wb: any; selection: any }, action: SetSelectionAction): any {
    const wb = ctx.wb || this.getActiveWorkbook(ctx.app)
    if (!wb) throw new Error('workbook not available')

    let sheetName = String((action as any)?.sheet_name || '').trim()
    sheetName = sheetName.replace(/^'/, '').replace(/'$/, '')
    let sheet = this.safe(() => wb.ActiveSheet) || this.safe(() => ctx.app?.ActiveSheet)

    const addrRaw = String((action as any)?.range || (action as any)?.cell || '').trim()
    const parsed = this.parseEtSheetAndAddr(addrRaw)
    if (!sheetName && parsed.sheetName) sheetName = parsed.sheetName

    if (sheetName) {
      sheet = this.getSheetByNameEt(wb, sheetName)
      if (!sheet) throw new Error(`sheet not found: ${sheetName}`)
      this.activateSheet(sheet)
    }
    if (!sheet) throw new Error('active sheet not available')

    const addr = parsed.addr
    const anchor = String((action as any)?.anchor || 'cursor')

    let target: any = null
    if (addr) {
      target = this.safe(() => (sheet as any).Range(addr))
    } else {
      if (anchor === 'start_of_document') {
        target =
          this.safe(() => (sheet as any).Range('A1')) ||
          this.safe(() => {
            const cells = (sheet as any)?.Cells
            if (typeof cells === 'function') return cells.call(sheet, 1, 1)
            if (cells && typeof cells.Item === 'function') return cells.Item(1, 1)
            return null
          })
      } else if (anchor === 'end_of_document') {
        const ur = this.safe(() => (sheet as any).UsedRange)
        if (ur) {
          const startRow = Number(this.safe(() => (ur as any).Row, 0)) || 0
          const startCol = Number(this.safe(() => (ur as any).Column, 0)) || 0
          const relRows = Number(this.safe(() => (ur as any).Rows?.Count, 0)) || 0
          const relCols = Number(this.safe(() => (ur as any).Columns?.Count, 0)) || 0
          const r = relRows > 0 ? relRows : 1
          const c = relCols > 0 ? relCols : 1

          const errors: string[] = []
          const trySet = (label: string, fn: () => any) => {
            if (target) return
            try {
              const v = fn()
              if (v) target = v
              else errors.push(`${label}: returned null`)
            } catch (e) {
              errors.push(`${label}: ${_errMsg(e)}`)
            }
          }

          // UsedRange is 1-based relative; but some builds expose Cells as a non-callable collection.
          trySet('UsedRange.Cells(r,c)', () => {
            const cells = (ur as any).Cells
            if (typeof cells === 'function') return cells.call(ur, r, c)
            if (cells && typeof cells.Item === 'function') return cells.Item(r, c)
            return null
          })

          // Fallback: compute absolute sheet coordinates and use Sheet.Cells.
          trySet('Sheet.Cells(abs)', () => {
            const absRow = (startRow > 0 ? startRow : 1) + r - 1
            const absCol = (startCol > 0 ? startCol : 1) + c - 1
            const cells = (sheet as any).Cells
            if (typeof cells === 'function') return cells.call(sheet, absRow, absCol)
            if (cells && typeof cells.Item === 'function') return cells.Item(absRow, absCol)
            return null
          })

          if (!target) {
            try {
              _planDiag('warning', `set_selection(et) end_of_document failed; fallback to A1 errors=${errors.slice(0, 2).join(' | ')}`)
            } catch (e) {
              ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
            }
            target =
              this.safe(() => (sheet as any).Range('A1')) ||
              this.safe(() => {
                const cells = (sheet as any)?.Cells
                if (typeof cells === 'function') return cells.call(sheet, 1, 1)
                if (cells && typeof cells.Item === 'function') return cells.Item(1, 1)
                return null
              })
          }
        }
      } else {
        target = ctx.selection || this.getSelection(ctx.app) || this.safe(() => ctx.app?.Selection)
      }

      const dr = Number((action as any)?.offset_lines || 0) || 0
      const dc = Number((action as any)?.offset_chars || 0) || 0
      if ((dr !== 0 || dc !== 0) && target) {
        const off = this.safe(() => (target as any).Offset?.(dr, dc))
        if (off) target = off
      }
    }

    if (!target) {
      const sn = sheetName || String(this.safe(() => (sheet as any).Name, '') || '')
      throw new Error(`set_selection failed to resolve target range (sheet=${sn || 'unknown'} anchor=${anchor} addr=${addrRaw || ''})`)
    }
    this.safe(() => (typeof (target as any).Select === 'function' ? (target as any).Select() : null))

    return this.getSelection(ctx.app) || target
  }

  private setCellFormulaEt(app: any, selection: any, action: SetCellFormulaAction) {
    const cellAddrRaw = String((action as any)?.cell || '').trim()
    const formulaRaw = String((action as any)?.formula || '').trim()
    if (!cellAddrRaw) throw new Error('set_cell_formula requires cell')
    if (!formulaRaw) throw new Error('set_cell_formula requires formula')

    const sel = selection || this.safe(() => app?.Selection)
    const { sheet, addr: cellAddr } = this.resolveSheetAndAddrEt(app, sel, cellAddrRaw)

    const cell = this.safe(() => (sheet as any).Range(cellAddr))
    if (!cell) throw new Error(`invalid cell address: ${cellAddr}`)

    const formula = formulaRaw.startsWith('=') ? formulaRaw : `=${formulaRaw}`
    const errors: string[] = []
    const tryWrite = (label: string, fn: () => void) => {
      try {
        fn()
        return true
      } catch (e) {
        errors.push(`${label}: ${_errMsg(e)}`)
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
        return false
      }
    }

    let wrote = false
    let branch = 'Cell.Formula'
    wrote = tryWrite('Cell.Formula', () => { ;(cell as any).Formula = formula })
    if (!wrote) {
      branch = 'Cell.Value2'
      wrote = tryWrite('Cell.Value2', () => { ;(cell as any).Value2 = formula })
    }
    if (!wrote) {
      branch = 'Cell.Value'
      wrote = tryWrite('Cell.Value', () => { ;(cell as any).Value = formula })
    }

    this.emitCapabilityEvent('plan.capability_matrix', {
      host_app: 'et',
      op: 'set_cell_formula',
      branch,
      fallback: branch !== 'Cell.Formula',
      success: wrote,
      cell: cellAddrRaw,
      errors: wrote ? undefined : errors.slice(0, 4),
    })

    if (!wrote) {
      try {
        const sheetName = String(this.safe(() => (sheet as any).Name, '' as any) || '')
        _planDiag(
          'error',
          `set_cell_formula failed: sheet=${sheetName || ''} cell=${cellAddrRaw} errors=${errors.slice(0, 4).join(' | ')}`
        )
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      const detail = errors.filter(Boolean).slice(0, 2).join(' | ')
      throw new Error(detail ? `failed to set formula: ${detail}` : 'failed to set formula')
    }
  }

  private setNumberFormatEt(app: any, selection: any, action: SetNumberFormatAction) {
    const rangeAddrRaw = String((action as any)?.range || '').trim()
    const format = String((action as any)?.number_format || '').trim()
    if (!rangeAddrRaw) throw new Error('set_number_format requires range')
    if (!format) throw new Error('set_number_format requires number_format')

    const sel = selection || this.safe(() => app?.Selection)
    const { sheet, addr: rangeAddr } = this.resolveSheetAndAddrEt(app, sel, rangeAddrRaw)
    const rng = this.safe(() => (sheet as any).Range(rangeAddr))
    if (!rng) throw new Error(`invalid range address: ${rangeAddr}`)

    const errors: string[] = []
    const trySet = (label: string, fn: () => void) => {
      try {
        fn()
        return true
      } catch (e) {
        errors.push(`${label}: ${_errMsg(e)}`)
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
        return false
      }
    }

    let ok = false
    let branch = 'Range.NumberFormat'
    ok = trySet('Range.NumberFormat', () => { ;(rng as any).NumberFormat = format })
    if (!ok) {
      branch = 'Range.NumberFormatLocal'
      ok = trySet('Range.NumberFormatLocal', () => { ;(rng as any).NumberFormatLocal = format })
    }

    this.emitCapabilityEvent('plan.capability_matrix', {
      host_app: 'et',
      op: 'set_number_format',
      branch,
      fallback: branch !== 'Range.NumberFormat',
      success: ok,
      range: rangeAddrRaw,
      errors: ok ? undefined : errors.slice(0, 4),
    })

    if (!ok) {
      try {
        const sheetName = String(this.safe(() => (sheet as any).Name, '' as any) || '')
        _planDiag(
          'error',
          `set_number_format failed: sheet=${sheetName || ''} range=${rangeAddrRaw} format=${format.slice(0, 80)} errors=${errors
            .slice(0, 4)
            .join(' | ')}`
        )
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      const detail = errors.filter(Boolean).slice(0, 2).join(' | ')
      throw new Error(detail ? `failed to set number format: ${detail}` : 'failed to set number format')
    }
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
    const rangeAddrRaw = String((action as any)?.range || '').trim()
    if (!rangeAddrRaw) throw new Error('set_conditional_format requires range')

    const sel = selection || this.safe(() => app?.Selection)
    const { sheet, addr: rangeAddr } = this.resolveSheetAndAddrEt(app, sel, rangeAddrRaw)
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
      let cs: any = null
      const errors: string[] = []
      try {
        const fn = (formatConditions as any)?.AddColorScale
        if (typeof fn === 'function') {
          cs = fn.call(formatConditions, 3)
        }
      } catch (e) {
        errors.push(`AddColorScale(3): ${_errMsg(e)}`)
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      if (!cs) {
        this.emitCapabilityEvent('plan.capability_matrix', {
          host_app: 'et',
          op: 'set_conditional_format',
          branch: 'color_scale',
          fallback: false,
          success: false,
          range: rangeAddrRaw,
          errors: errors.slice(0, 4),
        })
        try {
          const sheetName = String(this.safe(() => (sheet as any).Name, '' as any) || '')
          _planDiag(
            'error',
            `set_conditional_format(color_scale) failed: sheet=${sheetName || ''} range=${rangeAddrRaw} errors=${errors
              .slice(0, 4)
              .join(' | ')}`
          )
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
        }
        const detail = errors.filter(Boolean).slice(0, 2).join(' | ')
        throw new Error(detail ? `failed to add color scale: ${detail}` : 'failed to add color scale')
      }
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'et',
        op: 'set_conditional_format',
        branch: 'color_scale',
        fallback: false,
        success: true,
        range: rangeAddrRaw,
      })
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

    let cond: any = null
    const addErrors: string[] = []
    try {
      const fn = (formatConditions as any)?.Add
      if (typeof fn === 'function') {
        cond = fn.call(formatConditions, 1, operator, formula1, formula2Raw ? formula2Raw : undefined)
      }
    } catch (e) {
      addErrors.push(`FormatConditions.Add(4args): ${_errMsg(e)}`)
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }
    let usedFallback = false
    if (!cond) {
      usedFallback = true
      try {
        const fn = (formatConditions as any)?.Add
        if (typeof fn === 'function') cond = fn.call(formatConditions, 1, operator, formula1)
      } catch (e) {
        addErrors.push(`FormatConditions.Add(3args): ${_errMsg(e)}`)
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
    }
    if (!cond) {
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'et',
        op: 'set_conditional_format',
        branch: 'cell_value',
        fallback: usedFallback,
        success: false,
        range: rangeAddrRaw,
        errors: addErrors.slice(0, 4),
      })
      try {
        const sheetName = String(this.safe(() => (sheet as any).Name, '' as any) || '')
        _planDiag(
          'error',
          `set_conditional_format(cell_value) failed: sheet=${sheetName || ''} range=${rangeAddrRaw} operator=${String(
            (action as any)?.operator || ''
          )} formula1=${formula1.slice(0, 80)} errors=${addErrors.slice(0, 4).join(' | ')}`
        )
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      const detail = addErrors.filter(Boolean).slice(0, 2).join(' | ')
      throw new Error(detail ? `failed to add cell-value conditional format: ${detail}` : 'failed to add cell-value conditional format')
    }
    this.emitCapabilityEvent('plan.capability_matrix', {
      host_app: 'et',
      op: 'set_conditional_format',
      branch: 'cell_value',
      fallback: usedFallback,
      success: true,
      range: rangeAddrRaw,
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
    const rangeAddrRaw = String((action as any)?.range || '').trim()
    const formula1 = String((action as any)?.formula1 || '').trim()
    if (!rangeAddrRaw) throw new Error('set_data_validation requires range')
    if (!formula1) throw new Error('set_data_validation requires formula1')

    const sel = selection || this.safe(() => app?.Selection)
    const { sheet, addr: rangeAddr } = this.resolveSheetAndAddrEt(app, sel, rangeAddrRaw)
    const rng = this.safe(() => (sheet as any).Range(rangeAddr))
    if (!rng) throw new Error(`invalid range address: ${rangeAddr}`)

    const validation = this.safe(() => (rng as any)?.Validation)
    if (!validation) throw new Error('Validation object not available')

    this.safe(() => (validation as any).Delete?.())

    const validationType = this.etValidationType((action as any)?.validation_type)
    const operator = this.etConditionOperator((action as any)?.operator)
    const formula2Raw = String((action as any)?.formula2 || '').trim()

    const addErrors: string[] = []
    const tryAdd = (label: string, args: any[]) => {
      try {
        const fn = (validation as any)?.Add
        if (typeof fn !== 'function') {
          addErrors.push('Validation.Add not available')
          return false
        }
        fn.apply(validation, args)
        return true
      } catch (e) {
        addErrors.push(`${label}: ${_errMsg(e)}`)
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
        return false
      }
    }

    const opConst = operator == null ? 1 : operator
    let ok = false
    let branch = 'Validation.Add(5args)'
    ok = tryAdd('Validation.Add(5args)', [
      validationType,
      1,
      opConst,
      formula1,
      formula2Raw ? formula2Raw : undefined,
    ])
    if (!ok) {
      branch = 'Validation.Add(4args)'
      ok = tryAdd('Validation.Add(4args)', [validationType, 1, opConst, formula1])
    }

    this.emitCapabilityEvent('plan.capability_matrix', {
      host_app: 'et',
      op: 'set_data_validation',
      branch,
      fallback: branch !== 'Validation.Add(5args)',
      success: ok,
      range: rangeAddrRaw,
      errors: ok ? undefined : addErrors.slice(0, 4),
    })

    if (!ok) {
      try {
        const sheetName = String(this.safe(() => (sheet as any).Name, '' as any) || '')
        _planDiag(
          'error',
          `set_data_validation failed: sheet=${sheetName || ''} range=${rangeAddrRaw} type=${String(
            (action as any)?.validation_type || ''
          )} formula1=${formula1.slice(0, 80)} errors=${addErrors.slice(0, 4).join(' | ')}`
        )
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      const detail = addErrors.filter(Boolean).slice(0, 2).join(' | ')
      throw new Error(detail ? `failed to set data validation: ${detail}` : 'failed to set data validation')
    }

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
    const rangeAddrRaw = String((action as any)?.range || '').trim()
    const keyAddrRaw = String((action as any)?.key || '').trim()
    const order = String((action as any)?.order || 'asc').trim().toLowerCase()
    if (!rangeAddrRaw) throw new Error('sort_range requires range')
    if (!keyAddrRaw) throw new Error('sort_range requires key')

    const sel = selection || this.safe(() => app?.Selection)
    const rangeParsed = this.parseEtSheetAndAddr(rangeAddrRaw)
    const keyParsed = this.parseEtSheetAndAddr(keyAddrRaw)
    if (rangeParsed.sheetName && keyParsed.sheetName && rangeParsed.sheetName !== keyParsed.sheetName) {
      throw new Error(`sort_range sheet mismatch: range=${rangeParsed.sheetName} key=${keyParsed.sheetName}`)
    }
    const seedSheetName = rangeParsed.sheetName || keyParsed.sheetName
    const { sheet } = this.resolveSheetAndAddrEt(app, sel, seedSheetName ? `${seedSheetName}!A1` : 'A1')
    const rangeAddr = rangeParsed.addr
    const keyAddr = keyParsed.addr

    const rng = this.safe(() => (sheet as any).Range(rangeAddr))
    if (!rng) throw new Error(`invalid range address: ${rangeAddr}`)
    const keyRange = this.safe(() => (sheet as any).Range(keyAddr))
    if (!keyRange) throw new Error(`invalid key address: ${keyAddr}`)

    const orderNum = order === 'desc' ? 2 : 1
    const hasHeader = (action as any)?.has_header ? 1 : 2

    const errors: string[] = []

    let ok = false
    try {
      const sortFn = (rng as any)?.Sort
      if (typeof sortFn === 'function') {
        sortFn.call(rng, keyRange, orderNum, undefined, undefined, undefined, undefined, undefined, hasHeader)
        ok = true
      } else if (sortFn != null) {
        // Some hosts expose Sort as a callable object.
        try {
          ;(rng as any).Sort(
            keyRange,
            orderNum,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            hasHeader
          )
          ok = true
        } catch (e2) {
          errors.push(`Range.Sort(callable): ${_errMsg(e2)}`)
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e2)
        }
      } else {
        errors.push('Range.Sort not available')
      }
    } catch (e) {
      errors.push(`Range.Sort: ${_errMsg(e)}`)
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }

    if (!ok) {
      ok = !!this.safe(() => {
        const sortObj = (sheet as any).Sort
        if (!sortObj) {
          errors.push('Sheet.Sort not available')
          return false
        }
        if (typeof sortObj.SetRange === 'function') sortObj.SetRange(rng)
        const sf = sortObj.SortFields
        if (sf && typeof sf.Clear === 'function') sf.Clear()
        if (sf && typeof sf.Add === 'function') sf.Add(keyRange, 0, orderNum)
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

    if (!ok) {
      try {
        const sheetName = String(this.safe(() => (sheet as any).Name, '' as any) || '')
        _planDiag(
          'error',
          `sort_range failed: sheet=${sheetName || ''} range=${rangeAddrRaw} key=${keyAddrRaw} order=${order} errors=${errors
            .slice(0, 4)
            .join(' | ')}`
        )
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      const detail = errors.filter(Boolean).slice(0, 2).join(' | ')
      throw new Error(detail ? `failed to sort range: ${detail}` : 'failed to sort range')
    }
  }

  private setFilterRangeEt(app: any, selection: any, action: FilterRangeAction) {
    const rangeAddrRaw = String((action as any)?.range || '').trim()
    const field = Number((action as any)?.field || 0)
    const criteria1 = String((action as any)?.criteria1 || '').trim()
    const criteria2 = String((action as any)?.criteria2 || '').trim()
    const operatorRaw = String((action as any)?.operator || '').trim().toLowerCase()
    const visibleDropdown = (action as any)?.visible_dropdown !== false

    if (!rangeAddrRaw) throw new Error('filter_range requires range')
    if (!Number.isFinite(field) || field <= 0) throw new Error('filter_range requires positive field')
    if (!criteria1) throw new Error('filter_range requires criteria1')

    const sel = selection || this.safe(() => app?.Selection)
    const { sheet, addr: rangeAddr } = this.resolveSheetAndAddrEt(app, sel, rangeAddrRaw)

    const rng = this.safe(() => (sheet as any).Range(rangeAddr))
    if (!rng) throw new Error(`invalid range address: ${rangeAddr}`)

    const operator = operatorRaw === 'or' ? 2 : operatorRaw === 'and' ? 1 : undefined
    const errors: string[] = []
    let ok = false
    try {
      const fn = (rng as any)?.AutoFilter
      if (typeof fn !== 'function') {
        errors.push('Range.AutoFilter not available')
      } else if (operator && criteria2) {
        fn.call(rng, field, criteria1, operator, criteria2, visibleDropdown)
        ok = true
      } else {
        fn.call(rng, field, criteria1, undefined, undefined, visibleDropdown)
        ok = true
      }
    } catch (e) {
      errors.push(`Range.AutoFilter: ${_errMsg(e)}`)
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }
    if (!ok) {
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'et',
        op: 'filter_range',
        branch: 'Range.AutoFilter',
        fallback: false,
        success: false,
        range: rangeAddrRaw,
        errors: errors.slice(0, 4),
      })
      try {
        const sheetName = String(this.safe(() => (sheet as any).Name, '' as any) || '')
        _planDiag(
          'error',
          `filter_range failed: sheet=${sheetName || ''} range=${rangeAddrRaw} field=${field} criteria1=${criteria1.slice(
            0,
            80
          )} errors=${errors.slice(0, 4).join(' | ')}`
        )
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      const detail = errors.filter(Boolean).slice(0, 2).join(' | ')
      throw new Error(detail ? `failed to apply filter: ${detail}` : 'failed to apply filter')
    }
    this.emitCapabilityEvent('plan.capability_matrix', {
      host_app: 'et',
      op: 'filter_range',
      branch: 'Range.AutoFilter',
      fallback: false,
      success: true,
      range: rangeAddrRaw,
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
    const sourceRangeAddrRaw = String((action as any)?.source_range || '').trim()
    const destinationAddrRaw = String((action as any)?.destination || '').trim()
    const rows = Array.isArray((action as any)?.rows) ? (action as any).rows : []
    const columns = Array.isArray((action as any)?.columns) ? (action as any).columns : []
    const values = Array.isArray((action as any)?.values) ? (action as any).values : []
    const filters = Array.isArray((action as any)?.filters) ? (action as any).filters : []
    const tableName = String((action as any)?.table_name || '').trim()

    if (!sourceRangeAddrRaw) throw new Error('create_pivot_table requires source_range')
    if (!destinationAddrRaw) throw new Error('create_pivot_table requires destination')
    if (rows.length <= 0) throw new Error('create_pivot_table requires at least one row field')
    if (values.length <= 0) throw new Error('create_pivot_table requires at least one value field')

    const sel = selection || this.safe(() => app?.Selection)
    const wb = this.safe(() => app?.ActiveWorkbook)
    if (!wb) throw new Error('ET workbook not available')

    const src = this.resolveSheetAndAddrEt(app, sel, sourceRangeAddrRaw)
    const srcSheet = src.sheet
    const sourceRangeAddr = src.addr

    // Destination may be on another sheet; create it when missing (best-effort) to avoid clobbering source sheet.
    const dstParsed = this.parseEtSheetAndAddr(destinationAddrRaw)
    let dstSheet: any = null
    if (dstParsed.sheetName) {
      const existing = this.getSheetByNameEt(wb, dstParsed.sheetName)
      if (existing) {
        dstSheet = existing
      } else {
        const safeName = this.sanitizeSheetName(dstParsed.sheetName)
        dstSheet = this.getOrCreateSheet(wb, safeName)
      }
      this.activateSheet(dstSheet)
    } else {
      dstSheet =
        this.safe(() => sel?.Worksheet) ||
        this.safe(() => app?.ActiveSheet) ||
        this.safe(() => wb?.ActiveSheet) ||
        srcSheet
    }
    if (!dstSheet) throw new Error('ET destination sheet not available')

    const destinationAddr = dstParsed.addr

    const sourceRange = this.safe(() => (srcSheet as any).Range(sourceRangeAddr))
    if (!sourceRange) throw new Error(`invalid source_range address: ${sourceRangeAddr}`)
    const destinationRange = this.safe(() => (dstSheet as any).Range(destinationAddr))
    if (!destinationRange) throw new Error(`invalid destination address: ${destinationAddr}`)

    const pivotCaches = this.safe(() => {
      const pc = (wb as any)?.PivotCaches
      if (typeof pc === 'function') return pc.call(wb)
      return pc
    })
    if (!pivotCaches) throw new Error('PivotCaches not available')

    const sourceData = (() => {
      try {
        const addr = (sourceRange as any)?.Address
        if (typeof addr === 'function') {
          const s = String(addr.call(sourceRange, true, true, 1, true) || '').trim()
          if (s) return s
        } else if (typeof addr === 'string') {
          const s = String(addr || '').trim()
          if (s) return s
        }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      return sourceRangeAddr
    })()

    let cache: any = null
    const cacheErrors: string[] = []
    const tryCache = (label: string, fn: () => any) => {
      if (cache) return
      try {
        const v = fn()
        if (v) cache = v
        else cacheErrors.push(`${label}: returned null`)
      } catch (e) {
        cacheErrors.push(`${label}: ${_errMsg(e)}`)
      }
    }

    tryCache('PivotCaches.Create(str)', () => {
      const fn = (pivotCaches as any)?.Create
      return typeof fn === 'function' ? fn.call(pivotCaches, 1, sourceData) : null
    })
    tryCache('PivotCaches.Create(range)', () => {
      const fn = (pivotCaches as any)?.Create
      return typeof fn === 'function' ? fn.call(pivotCaches, 1, sourceRange) : null
    })
    tryCache('PivotCaches.Add(str)', () => {
      const fn = (pivotCaches as any)?.Add
      return typeof fn === 'function' ? fn.call(pivotCaches, 1, sourceData) : null
    })
    tryCache('PivotCaches.Add(range)', () => {
      const fn = (pivotCaches as any)?.Add
      return typeof fn === 'function' ? fn.call(pivotCaches, 1, sourceRange) : null
    })

    if (!cache) {
      try {
        _planDiag(
          'error',
          `create_pivot_table failed to create pivot cache: source_range=${sourceRangeAddrRaw} sourceData=${sourceData} errors=${cacheErrors
            .slice(0, 4)
            .join(' | ')}`
        )
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      const detail = cacheErrors.filter(Boolean).slice(0, 2).join(' | ')
      throw new Error(detail ? `failed to create pivot cache: ${detail}` : 'failed to create pivot cache')
    }

    const pivotName = tableName || `ah32_pivot_${Date.now()}`
    const existing = this.safe(() => (dstSheet as any).PivotTables?.(pivotName), null as any)
    if (existing && (action as any)?.replace_existing !== false) {
      this.safe(() => (existing as any).TableRange2?.Clear?.())
    }

    let pivot: any = null
    const pivotErrors: string[] = []
    const tryPivot = (label: string, fn: () => any) => {
      if (pivot) return
      try {
        const v = fn()
        if (v) pivot = v
        else pivotErrors.push(`${label}: returned null`)
      } catch (e) {
        pivotErrors.push(`${label}: ${_errMsg(e)}`)
      }
    }
    tryPivot('Cache.CreatePivotTable', () => {
      const fn = (cache as any)?.CreatePivotTable
      return typeof fn === 'function' ? fn.call(cache, destinationRange, pivotName) : null
    })

    if (!pivot) {
      try {
        _planDiag(
          'error',
          `create_pivot_table failed to create pivot table: destination=${destinationAddrRaw} pivot_name=${pivotName} errors=${pivotErrors
            .slice(0, 4)
            .join(' | ')}`
        )
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      const detail = pivotErrors.filter(Boolean).slice(0, 2).join(' | ')
      throw new Error(detail ? `failed to create pivot table: ${detail}` : 'failed to create pivot table')
    }

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

  private transformRangeEt(app: any, selection: any, action: TransformRangeAction) {
    const transform = String((action as any)?.transform || 'transpose').trim().toLowerCase()
    if (transform !== 'transpose') throw new Error(`transform_range unsupported transform=${transform}`)

    const sourceRaw = String((action as any)?.source_range || '').trim()
    const destRaw = String((action as any)?.destination || '').trim()
    const clearExisting = (action as any)?.clear_existing !== false
    if (!sourceRaw) throw new Error('transform_range requires source_range')
    if (!destRaw) throw new Error('transform_range requires destination')

    const sel = selection || this.safe(() => app?.Selection)
    const wb = this.safe(() => app?.ActiveWorkbook)
    if (!wb) throw new Error('workbook not available')

    const src = this.resolveSheetAndAddrEt(app, sel, sourceRaw)
    const srcSheet = src.sheet
    const srcAddr = src.addr
    if (!srcSheet || !srcAddr) throw new Error('invalid source_range')

    const dstParsed = this.parseEtSheetAndAddr(destRaw)
    let dstSheet: any =
      (dstParsed.sheetName ? this.getSheetByNameEt(wb, dstParsed.sheetName) : null) ||
      this.safe(() => sel?.Worksheet) ||
      this.safe(() => app?.ActiveSheet) ||
      this.safe(() => wb?.ActiveSheet) ||
      srcSheet
    if (dstParsed.sheetName && !dstSheet) {
      dstSheet = this.getOrCreateSheet(wb, this.sanitizeSheetName(dstParsed.sheetName))
    }
    if (!dstSheet) throw new Error('destination sheet not available')
    this.activateSheet(dstSheet)

    const srcRange = this.safe(() => (srcSheet as any).Range(srcAddr))
    if (!srcRange) throw new Error(`invalid source_range address: ${srcAddr}`)
    const dstAddr = String(dstParsed.addr || '').trim() || 'A1'
    const dstRange = this.safe(() => (dstSheet as any).Range(dstAddr))
    if (!dstRange) throw new Error(`invalid destination address: ${dstAddr}`)

    if (clearExisting) {
      this.safe(() => {
        const cr = (dstRange as any).CurrentRegion
        if (cr && typeof cr.Clear === 'function') cr.Clear()
        else if (typeof (dstRange as any).Clear === 'function') (dstRange as any).Clear()
        return null as any
      })
    }

    let ok = false
    let usedFallback = false
    ok = !!this.safe(() => {
      if (typeof (srcRange as any).Copy === 'function') (srcRange as any).Copy()
      if (typeof (dstRange as any).PasteSpecial === 'function') {
        // Try: PasteAll with transpose=true (Excel: xlPasteAll=-4104)
        ;(dstRange as any).PasteSpecial(-4104, undefined, false, true)
        return true
      }
      return false
    }, false as any)

    if (!ok) {
      // Fallback: manual transpose for small ranges.
      usedFallback = true
      ok = !!this.safe(() => {
        const values = (srcRange as any).Value2
        if (!Array.isArray(values) || values.length <= 0 || !Array.isArray(values[0])) return false
        const rows = values.length
        const cols = values[0].length
        const cellLimit = 20_000
        if (rows * cols > cellLimit) throw new Error(`transform_range fallback too large: ${rows}x${cols}`)
        const out: any[][] = []
        for (let c = 0; c < cols; c++) {
          const row: any[] = []
          for (let r = 0; r < rows; r++) row.push(values[r]?.[c])
          out.push(row)
        }
        const target = this.safe(() => (dstRange as any).Resize(cols, rows)) || dstRange
        ;(target as any).Value2 = out
        return true
      }, false as any)
    }

    this.emitCapabilityEvent('plan.capability_matrix', {
      host_app: 'et',
      op: 'transform_range',
      branch: usedFallback ? 'transform.transpose.fallback' : 'transform.transpose',
      fallback: usedFallback,
      success: ok,
    })
    if (!ok) throw new Error('failed to transform range')
  }

  private deleteBlockEt(app: any, wb: any, blockId: string) {
    const suffix = String(blockId || 'ah32_auto').replace(/[^a-zA-Z0-9_\-:.]/g, '_').slice(0, 20)
    const sheetName = this.sanitizeSheetName(`BID_${suffix}`)
    const sheets = this.safe(() => wb?.Worksheets) || this.safe(() => wb?.Sheets)
    if (!sheets) return
    const count = Number(this.safe(() => sheets.Count, 0)) || 0
    let target = null as any
    for (let i = 1; i <= count; i++) {
      const s =
        this.safe(() => (sheets as any).Item?.(i)) ||
        this.safe(() => (sheets as any).Item(i)) ||
        this.safe(() => (sheets as any)(i))
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
    let selection = ctx.selection
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
          case 'set_selection':
            selection = this.setSelectionEt({ app: ctx.app, wb: ctx.wb, selection }, action as any)
            break
          case 'insert_text':
            this.insertTextEt(ctx.app, selection, action.text)
            break
          case 'set_cell_formula':
            this.setCellFormulaEt(ctx.app, selection, action as any)
            break
          case 'set_number_format':
            this.setNumberFormatEt(ctx.app, selection, action as any)
            break
          case 'set_conditional_format':
            this.setConditionalFormatEt(ctx.app, selection, action as any)
            break
          case 'set_data_validation':
            this.setDataValidationEt(ctx.app, selection, action as any)
            break
          case 'sort_range':
            this.setSortRangeEt(ctx.app, selection, action as any)
            break
          case 'filter_range':
            this.setFilterRangeEt(ctx.app, selection, action as any)
            break
          case 'transform_range':
            this.transformRangeEt(ctx.app, selection, action as any)
            break
          case 'create_pivot_table':
            this.createPivotTableEt(ctx.app, selection, action as any)
            break
          case 'insert_table':
            this.insertTableEt(ctx.app, ctx.wb, selection, action as any)
            break
          case 'insert_chart_from_selection':
            this.insertChartFromSelectionEt(ctx.app, ctx.wb, selection, action as any)
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
            const a1 = this.selectA1(sheet)
            const selection2 = a1 || this.getSelection(ctx.app) || selection
            const children = (action as any).actions
            if (!Array.isArray(children) || children.length === 0) {
              throw new Error('upsert_block requires non-empty actions (ET)')
            }
            this.executeActionsEt({ app: ctx.app, wb: ctx.wb, selection: selection2 }, children, emit)
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

  private insertTableEt(app: any, wb: any, selection: any, action: InsertTableAction) {
    const sel = selection || this.safe(() => (app as any)?.Selection)
    const sheet =
      this.safe(() => (sel as any)?.Worksheet) ||
      this.safe(() => wb?.ActiveSheet) ||
      this.safe(() => (app as any)?.ActiveSheet)
    if (!sheet) throw new Error('ET active sheet not available')

    const rows = Math.max(1, Math.min(100, Number(action.rows) || 2))
    const cols = Math.max(1, Math.min(50, Number(action.cols) || 2))

    const getCell = (sh: any, r: number, c: number) => {
      try {
        const cells = (sh as any)?.Cells
        if (typeof cells === 'function') return cells.call(sh, r, c)
        if (cells && typeof cells.Item === 'function') return cells.Item(r, c)
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      return null
    }

    const resolveStart = () => {
      const s = sel || {}
      let r = Number(this.safe(() => (s as any).Row, NaN as any) as any)
      let c = Number(this.safe(() => (s as any).Column, NaN as any) as any)
      if (Number.isFinite(r) && r > 0 && Number.isFinite(c) && c > 0) return { row: r, col: c }
      try {
        const first =
          (() => {
            const cells = (s as any)?.Cells
            if (typeof cells === 'function') return cells.call(s, 1, 1)
            if (cells && typeof cells.Item === 'function') return cells.Item(1, 1)
            return null
          })() || this.safe(() => (app as any)?.ActiveCell)
        r = Number(this.safe(() => (first as any)?.Row, NaN as any) as any)
        c = Number(this.safe(() => (first as any)?.Column, NaN as any) as any)
        if (Number.isFinite(r) && r > 0 && Number.isFinite(c) && c > 0) return { row: r, col: c }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      return { row: 1, col: 1 }
    }

    const start = resolveStart()
    const startRow = start.row
    const startCol = start.col
    const endRow = startRow + rows - 1
    const endCol = startCol + cols - 1

    const startCell = getCell(sheet, startRow, startCol) || this.safe(() => (sheet as any).Range('A1'))
    const endCell = getCell(sheet, endRow, endCol)

    let rng: any = null
    rng = this.safe(() => ((startCell as any)?.Resize ? (startCell as any).Resize(rows, cols) : null))
    if (!rng && startCell && endCell) {
      rng = this.safe(() => {
        const rangeFn = (sheet as any)?.Range
        if (typeof rangeFn === 'function') return rangeFn.call(sheet, startCell, endCell)
        return null
      })
    }
    if (!rng && startCell) rng = startCell
    if (!rng) throw new Error(`insert_table(et) failed to resolve range (row=${startRow} col=${startCol})`)

    // Normalize data into a rectangular (rows x cols) array.
    const values: any[][] = []
    const data = Array.isArray((action as any)?.data) ? ((action as any).data as any[]) : null
    for (let r = 0; r < rows; r++) {
      const srcRow = data && Array.isArray(data[r]) ? (data[r] as any[]) : []
      const outRow: any[] = []
      for (let c = 0; c < cols; c++) {
        const v = srcRow[c]
        outRow.push(v == null ? '' : v)
      }
      values.push(outRow)
    }

    let wrote = false
    let writeBranch = 'Range.Value2'
    let usedFallback = false
    wrote = !!this.safe(() => {
      ;(rng as any).Value2 = values
      return true
    }, false as any)
    if (!wrote) {
      writeBranch = 'Range.Value'
      wrote = !!this.safe(() => {
        ;(rng as any).Value = values
        return true
      }, false as any)
    }

    if (!wrote) {
      usedFallback = true
      writeBranch = 'cell_by_cell'
      let cellErrors = 0
      let wroteCells = 0
      let firstCellError: unknown = null
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cell = getCell(sheet, startRow + r, startCol + c)
          if (!cell) continue
          const v = values[r]?.[c]
          let ok = false
          try {
            ;(cell as any).Value2 = v
            ok = true
          } catch (e) {
            if (!firstCellError) firstCellError = e
          }
          if (!ok) {
            try {
              ;(cell as any).Value = v
              ok = true
            } catch (e) {
              if (!firstCellError) firstCellError = e
            }
          }
          if (ok) wroteCells += 1
          else cellErrors += 1
        }
      }
      if (cellErrors > 0) {
        try {
          _planDiag('warning', `insert_table(et) fallback cell writes partial: wrote=${wroteCells}/${rows * cols} errors=${cellErrors}`)
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
        }
        if (firstCellError) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', firstCellError)
        }
        if (wroteCells <= 0) throw new Error('insert_table(et) failed to write values')
      }
    }

    // Best-effort formatting.
    try {
      if ((action as any)?.header === true) {
        const row1 =
          this.safe(() => (rng as any).Rows?.(1)) ||
          this.safe(() => (rng as any).Rows?.Item?.(1)) ||
          this.safe(() => (rng as any).Rows?.Item(1)) ||
          null
        const font = row1 ? this.safe(() => (row1 as any).Font) : null
        if (font) this.safe(() => (((font as any).Bold as any) = 1))
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }

    try {
      if (typeof (action as any)?.borders === 'boolean') {
        const borders = this.safe(() => (rng as any).Borders) || null
        if (borders && 'LineStyle' in borders) {
          // Excel constants: xlContinuous=1, xlLineStyleNone=-4142
          const v = (action as any).borders ? 1 : -4142
          this.safe(() => (((borders as any).LineStyle as any) = v))
        }
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }

    try {
      if (typeof (action as any)?.auto_fit === 'number' && Number((action as any).auto_fit) > 0) {
        const colsObj = this.safe(() => (rng as any).Columns)
        if (colsObj && typeof (colsObj as any).AutoFit === 'function') this.safe(() => (colsObj as any).AutoFit())
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }

    try {
      const style = String((action as any)?.style || '').trim()
      if (style && 'Style' in (rng || {})) this.safe(() => (((rng as any).Style as any) = style))
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }

    this.emitCapabilityEvent('plan.capability_matrix', {
      host_app: 'et',
      op: 'insert_table',
      branch: writeBranch,
      fallback: usedFallback,
      success: true,
      rows,
      cols,
    })
  }

  private insertChartFromSelectionEt(app: any, wb: any, selection: any, action: InsertChartFromSelectionAction) {
    const sheet = this.safe(() => wb?.ActiveSheet) || this.safe(() => app?.ActiveSheet)
    if (!sheet) throw new Error('ET active sheet not available')

    let rng: any = null
    // Prefer explicit source_range (deterministic) when provided.
    const explicitSheetName = String((action as any)?.sheet_name || '').trim()
    const explicitRangeRaw = String((action as any)?.source_range || '').trim()
    if (explicitRangeRaw) {
      const addr = explicitSheetName ? `${explicitSheetName}!${explicitRangeRaw}` : explicitRangeRaw
      const sel = selection || this.safe(() => app?.Selection)
      const resolved = this.resolveSheetAndAddrEt(app, sel, addr)
      const resolvedSheet = resolved.sheet
      const resolvedAddr = resolved.addr
      if (resolvedSheet && resolvedAddr) {
        rng = this.safe(() => (resolvedSheet as any).Range(resolvedAddr))
      }
    }
    if (!rng && selection && this.safe(() => !!selection.Cells, false as any)) rng = selection
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
    if (!rng) throw new Error('insert_chart_from_selection(et): source range not available (selection/range unresolved)')

    let chartObj: any = null
    const chartErrors: string[] = []
    const tryCreate = (label: string, fn: () => any) => {
      if (chartObj) return
      try {
        const v = fn()
        if (v) chartObj = v
        else chartErrors.push(`${label}: returned null`)
      } catch (e) {
        chartErrors.push(`${label}: ${_errMsg(e)}`)
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
    }

    // Width/height are best-effort; only treat them as points when they look like points.
    const widthRaw = Number((action as any)?.width)
    const heightRaw = Number((action as any)?.height)
    const width = Number.isFinite(widthRaw) && widthRaw > 100 ? widthRaw : 420
    const height = Number.isFinite(heightRaw) && heightRaw > 100 ? heightRaw : 260

    // Prefer Shapes.AddChart/AddChart2 when available.
    const shapes = this.safe(() => {
      const s = (sheet as any)?.Shapes
      if (typeof s === 'function') return s.call(sheet)
      return s
    })
    if (shapes) {
      tryCreate('Shapes.AddChart', () => {
        const fn = (shapes as any)?.AddChart
        return typeof fn === 'function' ? fn.call(shapes) : null
      })
      tryCreate('Shapes.AddChart2', () => {
        const fn = (shapes as any)?.AddChart2
        return typeof fn === 'function' ? fn.call(shapes) : null
      })
    } else {
      chartErrors.push('Sheet.Shapes not available')
    }

    // Fallback: ChartObjects().Add(left, top, width, height)
    tryCreate('ChartObjects.Add', () => {
      const co = (sheet as any)?.ChartObjects
      const chartObjects = typeof co === 'function' ? co.call(sheet) : co
      if (!chartObjects) return null
      const addFn = (chartObjects as any)?.Add
      return typeof addFn === 'function' ? addFn.call(chartObjects, 120, 40, width, height) : null
    })

    if (!chartObj) {
      try {
        const sheetName = String(this.safe(() => (sheet as any).Name, '' as any) || '')
        _planDiag(
          'error',
          `insert_chart_from_selection(et) failed: sheet=${sheetName || ''} source_range=${explicitRangeRaw || ''} errors=${chartErrors
            .slice(0, 4)
            .join(' | ')}`
        )
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'et',
        op: 'insert_chart_from_selection',
        branch: 'create_chart',
        fallback: true,
        success: false,
        errors: chartErrors.slice(0, 4),
      })
      const detail = chartErrors.filter(Boolean).slice(0, 2).join(' | ')
      throw new Error(detail ? `insert_chart_from_selection failed: ${detail}` : 'insert_chart_from_selection failed for et')
    }

    const chart = this.safe(() => {
      const c = (chartObj as any)?.Chart
      if (typeof c === 'function') return c.call(chartObj)
      return c ? c : chartObj
    })
    if (!chart) throw new Error('chart object unavailable')

    try {
      const fn = (chart as any)?.SetSourceData
      if (typeof fn === 'function') fn.call(chart, rng)
      else _planDiag('warning', 'insert_chart_from_selection(et): Chart.SetSourceData not available')
    } catch (e) {
      try {
        _planDiag('warning', `insert_chart_from_selection(et): SetSourceData failed: ${_errMsg(e)}`)
      } catch (e2) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e2)
      }
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }
    const chartType = Number((action as any)?.chart_type || 0)
    if (Number.isFinite(chartType) && chartType > 0) {
      this.safe(() => {
        ;(chart as any).ChartType = chartType
        return null as any
      })
    }

    this.emitCapabilityEvent('plan.capability_matrix', {
      host_app: 'et',
      op: 'insert_chart_from_selection',
      branch: 'create_chart',
      fallback: chartErrors.length > 0,
      success: true,
    })

    const title = (action as any)?.title
    const hasLegend = (action as any)?.has_legend
    const legendPos = (action as any)?.legend_position
    if (title) {
      this.safe(() => ((chart as any).HasTitle = 1))
      const ct = this.safe(() => (chart as any).ChartTitle)
      if (ct) this.safe(() => ((ct as any).Text = String(title)))
    }
    if (hasLegend === false) this.safe(() => ((chart as any).HasLegend = 0))
    if (hasLegend === true) this.safe(() => ((chart as any).HasLegend = 1))
    if (legendPos) {
      const map: Record<string, number> = { right: -4152, left: -4131, top: -4160, bottom: -4107 }
      if (legendPos in map) {
        const lg = this.safe(() => (chart as any).Legend)
        if (lg) this.safe(() => ((lg as any).Position = map[legendPos]))
      }
    }

    // Best-effort: trendline + data labels
    const addTrendline = (action as any)?.add_trendline === true
    const showDataLabels = (action as any)?.show_data_labels === true
    const showPercent = (action as any)?.data_labels_show_percent === true
    const trendlineType = String((action as any)?.trendline_type || '').trim().toLowerCase()
    if (addTrendline || showDataLabels) {
      const series =
        this.safe(() => (chart as any).SeriesCollection?.(1)) ||
        this.safe(() => (chart as any).SeriesCollection?.Item?.(1)) ||
        null
      if (series) {
        if (addTrendline) {
          const typeMap: Record<string, number> = {
            linear: 9,
            exponential: 5,
            logarithmic: 3,
            moving_average: 6,
            movingaverage: 6,
            polynomial: 3,
          }
          const typeConst = trendlineType && trendlineType in typeMap ? typeMap[trendlineType] : null
          const ok = !!this.safe(() => {
            const tls = typeof (series as any).Trendlines === 'function' ? (series as any).Trendlines() : (series as any).Trendlines
            if (!tls) return false
            if (typeof tls.Add === 'function') {
              if (typeConst != null) {
                try {
                  tls.Add(typeConst)
                  return true
                } catch (e) {
                  ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
                }
              }
              tls.Add()
              return true
            }
            return false
          }, false as any)
          this.emitCapabilityEvent('plan.capability_matrix', {
            host_app: 'et',
            op: 'insert_chart_from_selection',
            branch: 'trendline',
            fallback: !ok,
            success: ok,
          })
        }
        if (showDataLabels) {
          const ok = !!this.safe(() => {
            if (typeof (series as any).ApplyDataLabels === 'function') (series as any).ApplyDataLabels()
            const dls = typeof (series as any).DataLabels === 'function' ? (series as any).DataLabels() : (series as any).DataLabels
            if (dls) {
              try { ;(dls as any).ShowValue = 1 } catch (e) { ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e) }
              if (showPercent) {
                try { ;(dls as any).ShowPercentage = 1 } catch (e) { ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e) }
              }
            }
            return true
          }, false as any)
          this.emitCapabilityEvent('plan.capability_matrix', {
            host_app: 'et',
            op: 'insert_chart_from_selection',
            branch: 'data_labels',
            fallback: !ok,
            success: ok,
          })
        }
      }
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
      try {
        _planDiag(
          'warning',
          `set_slide_theme: template_path not applicable; try Designs fallback (template_path='${templatePath.slice(0, 160)}')`
        )
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
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

    // Best-effort: WPP theme APIs vary a lot across versions/builds (especially for blank/new presentations).
    // Do not fail the whole writeback if the theme can't be resolved; log + emit telemetry and continue.
    const designsCount = Number(this.safe(() => (ctx.pres as any)?.Designs?.Count, 0)) || 0
    try {
      const themeIndexText = Number.isFinite(themeIndex) ? String(themeIndex) : 'NaN'
      _planDiag(
        'warning',
        `set_slide_theme: no applicable theme found; skip (designs=${designsCount} theme_name='${themeName.slice(0, 80)}' theme_index=${themeIndexText})`
      )
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }
    this.emitCapabilityEvent('plan.capability_matrix', {
      host_app: 'wpp',
      op: 'set_slide_theme',
      branch: 'not_found',
      fallback: true,
      success: false,
      designs_count: designsCount,
      has_template_path: Boolean(templatePath),
      has_theme_name: Boolean(themeName),
      has_theme_index: Number.isFinite(themeIndex) && themeIndex > 0,
    })
    return
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

  // ===================== WPP新增操作方法 =====================

  private addSlideWpp(ctx: { app: any; pres: any }, action: AddSlideAction) {
    const slides = this.safe(() => ctx.pres.Slides)
    if (!slides) throw new Error('Slides not available')

    const count = Number(this.safe(() => slides.Count, 0)) || 0
    const layoutRaw = (action as any)?.layout
    const layoutN = Number(layoutRaw)
    // 12 ~= blank layout in PowerPoint object model; keep a stable default across WPS versions.
    const desiredLayout = Number.isFinite(layoutN) && layoutN > 0 ? layoutN : 12

    const positionRaw = (action as any)?.position
    let desiredPosition = Number(positionRaw)
    if (!Number.isFinite(desiredPosition) || desiredPosition <= 0) desiredPosition = count + 1
    // Clamp to legal range: [1, Count+1].
    if (desiredPosition > count + 1) desiredPosition = count + 1
    const title = (action as any)?.title as string | undefined
    const content = (action as any)?.content as string | undefined

    let newSlide: any = null
    const errors: string[] = []

    const hasFn = (obj: any, name: string) => {
      try {
        return typeof obj?.[name] === 'function'
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
        return false
      }
    }

    const tryCall = (label: string, fn: any, args: any[]) => {
      if (newSlide) return
      if (typeof fn !== 'function') return
      try {
        const v = fn.apply(slides, args)
        if (v) newSlide = v
        else errors.push(`${label}: returned null`)
      } catch (e) {
        errors.push(`${label}: ${_errMsg(e)}`)
      }
    }

    const positionsToTry: number[] = []
    const pushPos = (v: number) => {
      if (!Number.isFinite(v)) return
      if (v < 0) return
      if (positionsToTry.includes(v)) return
      positionsToTry.push(v)
    }
    // Prefer the requested position; then end; then try 0-based variants for compatibility.
    pushPos(desiredPosition)
    pushPos(count + 1)
    pushPos(desiredPosition - 1)
    pushPos(count)

    const layoutsToTry: number[] = []
    const pushLayout = (v: number) => {
      if (!Number.isFinite(v)) return
      if (v <= 0) return
      if (layoutsToTry.includes(v)) return
      layoutsToTry.push(v)
    }
    // Prefer requested layout; then blank(12); then title(1) as a last resort.
    pushLayout(desiredLayout)
    pushLayout(12)
    pushLayout(1)

    const getCustomLayout = (layoutIndex: number) => {
      try {
        const master =
          this.safe(() => (ctx.pres as any).SlideMaster) ||
          this.safe(() => (ctx.pres as any).SlideMasters?.Item?.(1)) ||
          this.safe(() => (ctx.pres as any).SlideMasters?.Item?.call((ctx.pres as any).SlideMasters, 1))
        const layouts = master ? this.safe(() => (master as any).CustomLayouts) : null
        if (!layouts) return null
        const lc = Number(this.safe(() => (layouts as any).Count, 0)) || 0
        if (lc <= 0) return null
        const idx = Math.min(Math.max(1, Math.floor(layoutIndex) || 1), lc)
        return this.safe(() => (layouts as any).Item(idx))
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
        return null
      }
    }

    // NOTE: Object model differs across builds:
    // - Some expose Slides.Add(index, layoutNumber) (PowerPoint-compatible)
    // - Some expose Slides.AddSlide(index, customLayoutObject) (PowerPoint AddSlide signature)
    // - Some expose Slides.AddSlide(index, layoutNumber) (WPS variant)
    // Probe and fall back across variants/args.
    const addFn = (slides as any)?.Add
    const addSlideFn = (slides as any)?.AddSlide

    if (hasFn(slides, 'Add')) {
      for (const pos of positionsToTry) {
        for (const lay of layoutsToTry) {
          tryCall(`Slides.Add(pos=${pos},layout=${lay})`, addFn, [pos, lay])
          if (newSlide) break
        }
        if (newSlide) break
      }
      if (!newSlide) {
        for (const pos of positionsToTry) {
          tryCall(`Slides.Add(pos=${pos})`, addFn, [pos])
          if (newSlide) break
        }
      }
    }

    if (!newSlide && hasFn(slides, 'AddSlide')) {
      // Try PowerPoint AddSlide signature: (index, customLayoutObject)
      for (const pos of positionsToTry) {
        const cl = getCustomLayout(desiredLayout) || getCustomLayout(1)
        if (!cl) break
        tryCall(`Slides.AddSlide(pos=${pos},customLayout)`, addSlideFn, [pos, cl])
        if (newSlide) break
      }
      // Try WPS variant: (index, layoutNumber)
      if (!newSlide) {
        for (const pos of positionsToTry) {
          for (const lay of layoutsToTry) {
            tryCall(`Slides.AddSlide(pos=${pos},layout=${lay})`, addSlideFn, [pos, lay])
            if (newSlide) break
          }
          if (newSlide) break
        }
      }
      // Try 1-arg signature: (index)
      if (!newSlide) {
        for (const pos of positionsToTry) {
          tryCall(`Slides.AddSlide(pos=${pos})`, addSlideFn, [pos])
          if (newSlide) break
        }
      }
    }

    if (!newSlide) {
      try {
        const hasAdd = hasFn(slides, 'Add')
        const hasAddSlide = hasFn(slides, 'AddSlide')
        const viewType = this.safe(() => (ctx.app as any)?.ActiveWindow?.ViewType)
        _planDiag(
          'error',
          `add_slide failed: hasAdd=${hasAdd} hasAddSlide=${hasAddSlide} viewType=${String(viewType ?? '')} pos=${desiredPosition} layout=${desiredLayout} slides_count=${count} raw_position=${String(positionRaw ?? '')} raw_layout=${String(layoutRaw ?? '')} errors=${errors.slice(0, 4).join(' | ')}`
        )
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'wpp',
        op: 'add_slide',
        branch: 'addSlide',
        fallback: false,
        success: false,
        slides_count: count,
        position: desiredPosition,
        layout: desiredLayout,
        errors: errors.slice(0, 4),
      })
      const detail = errors.filter(Boolean).slice(0, 2).join(' | ')
      throw new Error(detail ? `failed to add slide: ${detail}` : 'failed to add slide')
    }

    // Best-effort: make subsequent ops target the newly created slide.
    try {
      ;(ctx as any).slide = newSlide
      this.activateSlide(ctx.app, newSlide)
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }

    // If we had to fall back to "append then move", try to move to desiredPosition.
    try {
      const idx = Number(this.safe(() => (newSlide as any).SlideIndex, NaN as any) as any)
      const total = Number(this.safe(() => slides.Count, 0)) || 0
      if (
        Number.isFinite(idx) &&
        Number.isFinite(desiredPosition) &&
        desiredPosition >= 1 &&
        desiredPosition <= total &&
        idx !== desiredPosition &&
        typeof (newSlide as any)?.MoveTo === 'function'
      ) {
        this.safe(() => (newSlide as any).MoveTo(desiredPosition))
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }

    // 设置标题
    let titleSet = false
    if (title) {
      const shapes = this.safe(() => newSlide.Shapes)
      if (shapes) {
        const titleShape = this.safe(() => shapes.Title)
        if (titleShape) {
          const tf = this.safe(() => titleShape.TextFrame)
          if (tf) {
            this.safe(() => {
              const tr = tf.TextRange
              if (tr) {
                tr.Text = title
                titleSet = true
              }
            })
          }
        }
      }
    }

    // 设置正文内容
    let contentSet = false
    if (content) {
      const shapes = this.safe(() => newSlide.Shapes)
      if (shapes) {
        // 尝试查找内容占位符
        for (let i = 1; i <= this.safe(() => shapes.Count || 0); i++) {
          const shape = this.safe(() => shapes.Item(i))
          if (!shape) continue
          const placeholder = this.safe(() => shape.PlaceholderFormat)
          if (placeholder && this.safe(() => placeholder.PlaceholderType) === 2) { // 2 = body
            const tf = this.safe(() => shape.TextFrame)
            if (tf) {
              const tr = this.safe(() => tf.TextRange)
              if (tr) {
                this.safe(() => tr.Text = content)
                contentSet = true
              }
            }
            break
          }
        }
      }
    }

    // Fallback: if blank/custom layout has no placeholders, insert visible textboxes.
    try {
      if (title && !titleSet) this.addTextbox(newSlide, title, { top: 24, height: 64, fontSize: 36, bold: true })
      if (content && !contentSet) this.addTextbox(newSlide, content, { top: 110, height: 320, fontSize: 20 })
    } catch (e) {
      try {
        _planDiag('warning', `add_slide fallback textboxes failed: ${_errMsg(e)}`)
      } catch (e2) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e2)
      }
    }

    this.emitCapabilityEvent('plan.capability_matrix', {
      host_app: 'wpp',
      op: 'add_slide',
      branch: 'addSlide',
      fallback: false,
      success: true,
    })
  }

  private addTextboxWpp(ctx: { app: any; pres: any; slide?: any }, action: AddTextboxAction) {
    const slide = this.resolveTargetSlideWpp(ctx, (action as any)?.slide_index)
    if (!slide) throw new Error('target slide not available')

    const text = (action as any)?.text as string | undefined

    const shapes = this.safe(() => slide.Shapes)
    if (!shapes) throw new Error('shapes not available')

    const hasCoord = (k: 'left' | 'top' | 'width' | 'height') => {
      const v = (action as any)?.[k]
      return v !== undefined && v !== null && Number.isFinite(Number(v))
    }

    const getSlideSize = () => {
      try {
        const ps = this.safe(() => ctx.pres?.PageSetup)
        const w = ps ? Number(this.safe(() => (ps as any).SlideWidth, NaN as any) as any) : NaN
        const h = ps ? Number(this.safe(() => (ps as any).SlideHeight, NaN as any) as any) : NaN
        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { w, h }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      return null
    }

    const getPlaceholderShape = (placeholderType: number, placeholderIndex: number, placeholderKind: string) => {
      let target: any = null
      try {
        if (placeholderKind === 'title') {
          target = this.safe(() => (shapes as any).Title)
        }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
        target = null
      }

      if (!target) {
        const candidates: any[] = []
        const count = Number(this.safe(() => (shapes as any).Count, 0)) || 0
        for (let i = 1; i <= count; i++) {
          const sh = this.safe(() => (shapes as any).Item(i))
          if (!sh) continue
          const pf = this.safe(() => (sh as any).PlaceholderFormat)
          if (!pf) continue
          const t = Number(this.safe(() => (pf as any).PlaceholderType, -1)) || -1
          if (t === placeholderType) candidates.push(sh)
        }
        target = candidates[Math.min(candidates.length - 1, placeholderIndex - 1)] || candidates[0] || null
      }
      return target
    }

    const getPlaceholderBounds = (placeholderType: number, placeholderIndex: number, placeholderKind: string) => {
      const target = getPlaceholderShape(placeholderType, placeholderIndex, placeholderKind)
      if (!target) return null
      const l = Number(this.safe(() => (target as any).Left, NaN as any) as any)
      const t = Number(this.safe(() => (target as any).Top, NaN as any) as any)
      const w = Number(this.safe(() => (target as any).Width, NaN as any) as any)
      const h = Number(this.safe(() => (target as any).Height, NaN as any) as any)
      if (Number.isFinite(l) && Number.isFinite(t) && Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        return { left: l, top: t, width: w, height: h }
      }
      return null
    }

    const fontSize = (action as any)?.font_size
    const fontBold = (action as any)?.font_bold
    const fontColor = (action as any)?.font_color
    const alignment = (action as any)?.alignment

    const applyStyleToTextRange = (tr: any) => {
      if (!tr) return
      if (fontSize || fontBold || alignment) {
        const font = this.safe(() => tr.Font)
        if (font) {
          if (fontSize) this.safe(() => (font.Size = fontSize))
          if (fontBold !== undefined && fontBold !== null) this.safe(() => (font.Bold = fontBold ? 1 : 0))
        }
        if (alignment) {
          const alignMap: Record<string, number> = { left: 1, center: 2, right: 3 }
          if (alignment in alignMap) {
            const pf = this.safe(() => tr.ParagraphFormat)
            if (pf) this.safe(() => (pf.Alignment = alignMap[alignment]))
          }
        }
      }

      if (fontColor) {
        const rgb = this._wppHexToRgbLong(fontColor)
        if (rgb !== null) {
          const font = this.safe(() => tr.Font)
          if (font) this.safe(() => (font.Color.RGB = rgb))
        }
      }
    }

    const placeholderKind = String((action as any)?.placeholder_kind || '').trim().toLowerCase()
    const placeholderTypeRaw = (action as any)?.placeholder_type
    const placeholderIndex = Math.max(1, Number((action as any)?.placeholder_index || 1) || 1)
    const kindMap: Record<string, number> = { title: 1, body: 2, subtitle: 4 }
    const placeholderType =
      Number.isFinite(Number(placeholderTypeRaw)) ? Number(placeholderTypeRaw) :
      (placeholderKind && placeholderKind in kindMap ? kindMap[placeholderKind] : null)

    // Best-effort: fill a placeholder (avoids guessed coords) when requested.
    if (text && placeholderType != null) {
      const target = getPlaceholderShape(placeholderType, placeholderIndex, placeholderKind)

      if (target) {
        const tf = this.safe(() => (target as any).TextFrame)
        const tr = tf ? this.safe(() => (tf as any).TextRange) : null
        if (tr) {
          this.safe(() => ((tr as any).Text = text))
          applyStyleToTextRange(tr)
          this.emitCapabilityEvent('plan.capability_matrix', {
            host_app: 'wpp',
            op: 'add_textbox',
            branch: 'addTextbox.placeholder',
            fallback: false,
            success: true,
          })
          return
        }
      }

      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'wpp',
        op: 'add_textbox',
        branch: 'addTextbox.placeholder',
        fallback: true,
        success: false,
      })
    }

    // Auto-placement: when no placeholder is specified and no coords are provided, prefer filling an empty
    // title/body placeholder (reduces coordinate guessing).
    if (
      text &&
      placeholderType == null &&
      !hasCoord('left') &&
      !hasCoord('top') &&
      !hasCoord('width') &&
      !hasCoord('height')
    ) {
      const isShortTitle = (() => {
        try {
          const s = String(text || '').trim()
          if (!s) return false
          if (s.length > 80) return false
          if (s.includes('\n')) return false
          return true
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
          return false
        }
      })()

      const tryFill = (t: number, kind: string) => {
        const target = getPlaceholderShape(t, 1, kind)
        if (!target) return false
        const tf = this.safe(() => (target as any).TextFrame)
        const tr = tf ? this.safe(() => (tf as any).TextRange) : null
        if (!tr) return false
        const existing = String(this.safe(() => (tr as any).Text, '' as any) as any).trim()
        if (existing) return false
        this.safe(() => ((tr as any).Text = text))
        applyStyleToTextRange(tr)
        return true
      }

      const ok = isShortTitle ? (tryFill(1, 'title') || tryFill(2, 'body')) : (tryFill(2, 'body') || tryFill(1, 'title'))
      if (ok) {
        this.emitCapabilityEvent('plan.capability_matrix', {
          host_app: 'wpp',
          op: 'add_textbox',
          branch: 'addTextbox.auto_placeholder',
          fallback: false,
          success: true,
        })
        return
      }
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'wpp',
        op: 'add_textbox',
        branch: 'addTextbox.auto_placeholder',
        fallback: true,
        success: false,
      })
    }

    // Determine placement bounds (prefer placeholder bounds when coords are not explicitly provided).
    const defaultBounds = (() => {
      const body = getPlaceholderBounds(2, 1, 'body')
      if (body) return body
      const title = getPlaceholderBounds(1, 1, 'title')
      if (title) {
        const size = getSlideSize()
        const gap = 10
        if (size) {
          const top = Math.min(size.h - 40, title.top + title.height + gap)
          const left = Math.max(20, title.left)
          const width = Math.max(200, Math.min(size.w - left - 20, title.width))
          const height = Math.max(120, Math.min(size.h - top - 20, 240))
          return { left, top, width, height }
        }
      }
      const size = getSlideSize()
      if (size) {
        const margin = Math.max(24, Math.min(60, size.w * 0.06))
        return {
          left: margin,
          top: margin,
          width: Math.max(200, size.w - margin * 2),
          height: Math.max(120, size.h - margin * 2),
        }
      }
      // Fallback to previous defaults.
      return { left: 28.35, top: 28.35, width: 10 * 28.35, height: 5 * 28.35 }
    })()

    const left = hasCoord('left') ? Number((action as any).left) * 28.35 : defaultBounds.left
    const top = hasCoord('top') ? Number((action as any).top) * 28.35 : defaultBounds.top
    const width = hasCoord('width') ? Number((action as any).width) * 28.35 : defaultBounds.width
    const height = hasCoord('height') ? Number((action as any).height) * 28.35 : defaultBounds.height

    // Fallback: place by coordinates.
    let textbox: any = null
    const addErrors: string[] = []
    const tryAddTextbox = (label: string, fn: () => any) => {
      if (textbox) return
      try {
        const v = fn()
        if (v) textbox = v
      } catch (e) {
        addErrors.push(`${label}: ${_errMsg(e)}`)
      }
    }

    tryAddTextbox('Shapes.AddTextbox', () => {
      const fn = (shapes as any)?.AddTextbox
      return typeof fn === 'function' ? fn.call(shapes, 1, left, top, width, height) : null
    })
    tryAddTextbox('Shapes.AddTextBox', () => {
      const fn = (shapes as any)?.AddTextBox
      return typeof fn === 'function' ? fn.call(shapes, 1, left, top, width, height) : null
    })

    if (!textbox) {
      try {
        _planDiag(
          'error',
          `add_textbox failed: left=${left} top=${top} width=${width} height=${height} errors=${addErrors
            .slice(0, 4)
            .join(' | ')}`
        )
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'wpp',
        op: 'add_textbox',
        branch: 'addTextbox.coords',
        fallback: true,
        success: false,
        errors: addErrors.slice(0, 4),
      })
      throw new Error('failed to add textbox')
    }

    if (text) {
      const tf = this.safe(() => textbox.TextFrame)
      if (tf) {
        const tr = this.safe(() => tf.TextRange)
        if (tr) this.safe(() => tr.Text = text)
        applyStyleToTextRange(tr)
      }
    } else {
      // Still apply style if possible (empty text may be populated later).
      const tf = this.safe(() => textbox.TextFrame)
      if (tf) {
        const tr = this.safe(() => tf.TextRange)
        applyStyleToTextRange(tr)
      }
    }

    this.emitCapabilityEvent('plan.capability_matrix', {
      host_app: 'wpp',
      op: 'add_textbox',
      branch: 'addTextbox.coords',
      fallback: placeholderType != null,
      success: true,
    })
  }

  private addImageWpp(ctx: { app: any; pres: any; slide?: any }, action: AddImageAction) {
    const slide = this.resolveTargetSlideWpp(ctx, (action as any)?.slide_index)
    if (!slide) throw new Error('target slide not available')

    const rawPath = String((action as any)?.path || '')
    if (!rawPath) throw new Error('image path is required')

    const resolveImagePath = (p: string) => {
      const s = String(p || '').trim()
      if (!s) return s
      const m = s.match(/^(?:res|resource):(.+)$/i)
      if (m && m[1]) {
        const id = String(m[1]).trim()
        const dataUrl = id && this._planImageResources ? this._planImageResources.get(id) : null
        if (dataUrl) return dataUrl
      }
      return s
    }

    const path = resolveImagePath(rawPath)

    const shapes = this.safe(() => slide.Shapes)
    if (!shapes) throw new Error('shapes not available')

    let left = Number((action as any)?.left || 1) * 28.35
    let top = Number((action as any)?.top || 1) * 28.35
    let width = (action as any)?.width ? Number((action as any).width) * 28.35 : -1
    let height = (action as any)?.height ? Number((action as any).height) * 28.35 : -1

    // Best-effort: use placeholder bounds when requested (reduces guessed coords).
    const placeholderKind = String((action as any)?.placeholder_kind || '').trim().toLowerCase()
    const placeholderTypeRaw = (action as any)?.placeholder_type
    const placeholderIndex = Math.max(1, Number((action as any)?.placeholder_index || 1) || 1)
    const kindMap: Record<string, number> = { title: 1, body: 2, subtitle: 4 }
    const placeholderType =
      Number.isFinite(Number(placeholderTypeRaw)) ? Number(placeholderTypeRaw) :
      (placeholderKind && placeholderKind in kindMap ? kindMap[placeholderKind] : null)
    if (placeholderType != null) {
      let target: any = null
      try {
        if (placeholderKind === 'title') target = this.safe(() => (shapes as any).Title)
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
        target = null
      }
      if (!target) {
        const candidates: any[] = []
        const count = Number(this.safe(() => (shapes as any).Count, 0)) || 0
        for (let i = 1; i <= count; i++) {
          const sh = this.safe(() => (shapes as any).Item(i))
          if (!sh) continue
          const pf = this.safe(() => (sh as any).PlaceholderFormat)
          if (!pf) continue
          const t = Number(this.safe(() => (pf as any).PlaceholderType, -1)) || -1
          if (t === placeholderType) candidates.push(sh)
        }
        target = candidates[Math.min(candidates.length - 1, placeholderIndex - 1)] || candidates[0] || null
      }
      if (target) {
        const l = Number(this.safe(() => (target as any).Left, NaN as any) as any)
        const t = Number(this.safe(() => (target as any).Top, NaN as any) as any)
        const w = Number(this.safe(() => (target as any).Width, NaN as any) as any)
        const h = Number(this.safe(() => (target as any).Height, NaN as any) as any)
        if (Number.isFinite(l) && Number.isFinite(t) && Number.isFinite(w) && Number.isFinite(h)) {
          left = l
          top = t
          width = w
          height = h
        }
      }
    }

    // Best-effort: support data URL image payloads (avoid requiring a local file path).
    try {
      const p = String(path || '').trim()
      if (/^data:image\//i.test(p)) {
        const pasted = this.pasteImageDataUrlToSlideWpp(ctx, slide, p, {
          left,
          top,
          width: width > 0 ? width : undefined,
          height: height > 0 ? height : undefined,
        })
        if (pasted) {
          this.emitCapabilityEvent('plan.capability_matrix', {
            host_app: 'wpp',
            op: 'add_image',
            branch: 'addImage.data_url_clipboard_paste',
            fallback: true,
            success: true,
          })
          return
        }
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
    }

    // -1 means let WPS calculate dimension
    const image = this.safe(() => shapes.AddPicture(path, false, true, left, top, width, height))
    if (!image) {
      // Best-effort: support http(s) URL by downloading bytes and pasting via clipboard.
      // This avoids requiring a local file path, which is often not available in WPP host.
      try {
        const url = String(path || '').trim()
        if (/^https?:\/\//i.test(url)) {
          const cached = this._planImageUrlCache ? this._planImageUrlCache.get(url) : null
          const downloaded = cached ? { data_url: cached } : this.downloadImageAsDataUrlSync(url, { maxBytes: 2_000_000 })
          if (downloaded?.data_url) {
            try {
              if (this._planImageUrlCache && !cached) this._planImageUrlCache.set(url, downloaded.data_url)
            } catch (e) {
              ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
            }
            const pasted = this.pasteImageDataUrlToSlideWpp(ctx, slide, downloaded.data_url, {
              left,
              top,
              width: width > 0 ? width : undefined,
              height: height > 0 ? height : undefined,
            })
            if (pasted) {
              try {
                _planDiag('warning', `add_image AddPicture failed; used clipboard paste for url=${url}`)
              } catch (e) {
                ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
              }
              this.emitCapabilityEvent('plan.capability_matrix', {
                host_app: 'wpp',
                op: 'add_image',
                branch: 'addImage.url_clipboard_paste',
                fallback: true,
                success: true,
              })
              return
            }
          }
        }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }

      // Best-effort fallback: insert a visible placeholder so the plan doesn't fail just because
      // the path is not reachable in the host environment.
      try {
        _planDiag('warning', `add_image failed; inserted placeholder for path=${path}`)
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      try {
        const slideIndex = Number(this.safe(() => (slide as any).SlideIndex, 0)) || null
        this.addShapeWpp(ctx, {
          id: `img_${Date.now()}`,
          title: 'Image placeholder',
          op: 'add_shape',
          shape_type: 'rectangle',
          left: (left / 28.35),
          top: (top / 28.35),
          width: ((width > 0 ? width : 12 * 28.35) / 28.35),
          height: ((height > 0 ? height : 7 * 28.35) / 28.35),
          text: `[IMAGE] ${path}`.slice(0, 5000),
          slide_index: (action as any)?.slide_index ?? slideIndex,
        } as any)
      } catch (e) {
        this.emitCapabilityEvent('plan.capability_matrix', {
          host_app: 'wpp',
          op: 'add_image',
          branch: 'addImage.placeholder',
          fallback: true,
          success: false,
        })
        throw new Error('failed to add image (and placeholder fallback failed)')
      }

      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'wpp',
        op: 'add_image',
        branch: 'addImage.placeholder',
        fallback: true,
        success: true,
      })
      return
    }

    this.emitCapabilityEvent('plan.capability_matrix', {
      host_app: 'wpp',
      op: 'add_image',
      branch: 'addImage',
      fallback: false,
      success: true,
    })
  }

  private downloadImageAsDataUrlSync(
    url: string,
    opts?: { maxBytes?: number },
  ): { data_url: string; mime: string; bytes: number } | null {
    const u = String(url || '').trim()
    if (!u) return null

    const maxBytes = Math.max(10_000, Math.min(20_000_000, Number(opts?.maxBytes || 0) || 2_000_000))

    const inferMimeFromBytes = (bytes: Uint8Array): string => {
      if (!bytes || bytes.length < 12) return ''
      // PNG: 89 50 4E 47 0D 0A 1A 0A
      if (
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
      ) return 'image/png'
      // JPEG: FF D8 FF
      if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
      // GIF87a / GIF89a
      const gif = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5])
      if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif'
      // WEBP: RIFF....WEBP
      const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
      const webp = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
      if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp'
      // BMP: BM
      if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
      return ''
    }

    const inferMime = (rawUrl: string): string => {
      const s = String(rawUrl || '').toLowerCase()
      if (s.endsWith('.png')) return 'image/png'
      if (s.endsWith('.jpg') || s.endsWith('.jpeg')) return 'image/jpeg'
      if (s.endsWith('.gif')) return 'image/gif'
      if (s.endsWith('.webp')) return 'image/webp'
      if (s.endsWith('.bmp')) return 'image/bmp'
      if (s.endsWith('.svg')) return 'image/svg+xml'
      return 'application/octet-stream'
    }

    try {
      const xhr = new XMLHttpRequest()
      xhr.open('GET', u, false)
      xhr.responseType = 'arraybuffer'
      xhr.send(null)

      const status = Number((xhr as any).status || 0) || 0
      if (!(status >= 200 && status < 300)) return null

      const buf = (xhr as any).response as ArrayBuffer | null
      if (!buf) return null

      const bytes = new Uint8Array(buf)
      if (bytes.byteLength <= 0) return null
      if (bytes.byteLength > maxBytes) return null

      let mime = ''
      try {
        mime = String(xhr.getResponseHeader('Content-Type') || '').split(';')[0].trim()
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
        mime = ''
      }
      if (!mime || !/^image\//i.test(mime)) {
        mime = inferMimeFromBytes(bytes) || inferMime(u)
      }
      if (!/^image\//i.test(mime)) return null

      // Convert bytes -> base64 (sync; bounded by maxBytes).
      const chunk = 0x8000
      let binary = ''
      for (let i = 0; i < bytes.length; i += chunk) {
        const sub = bytes.subarray(i, Math.min(bytes.length, i + chunk))
        try {
          // Avoid spreading typed arrays directly for compatibility.
          binary += String.fromCharCode.apply(null, Array.from(sub) as any)
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
          return null
        }
      }
      const b64 = btoa(binary)

      return {
        data_url: `data:${mime};base64,${b64}`,
        mime,
        bytes: bytes.byteLength,
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      return null
    }
  }

  private pasteImageDataUrlToSlideWpp(
    ctx: { app: any; pres: any; slide?: any },
    slide: any,
    dataUrl: string,
    pos: { left: number; top: number; width?: number; height?: number },
  ): any | null {
    const url = String(dataUrl || '').trim()
    if (!url) return null
    // Keep it conservative: avoid freezing UI with huge data URLs.
    if (url.length > 3_000_000) return null

    const doc = (globalThis as any).document as Document | undefined
    if (!doc || !doc.body) return null

    const escapeAttr = (v: string) => String(v || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

    const container = doc.createElement('div')
    container.setAttribute('contenteditable', 'true')
    container.style.position = 'fixed'
    container.style.left = '-10000px'
    container.style.top = '0'
    container.style.width = '10px'
    container.style.height = '10px'
    container.style.opacity = '0'
    // Some hosts are picky about clipboard formats; wrapping in a table is more compatible.
    container.innerHTML = `<table><tr><td><img src="${escapeAttr(url)}" /></td></tr></table>`

    try {
      doc.body.appendChild(container)
      try { (container as any).focus?.() } catch (e) { ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e) }

      const sel = doc.getSelection?.()
      if (!sel) return null
      sel.removeAllRanges()

      const r = doc.createRange()
      r.selectNodeContents(container)
      sel.addRange(r)

      const ok = typeof (doc as any).execCommand === 'function' ? (doc as any).execCommand('copy') : false
      sel.removeAllRanges()
      if (!ok) return null

      // Paste into slide
      this.activateSlide(ctx.app, slide)
      const shapes = this.safe(() => (slide as any).Shapes)
      let pasted: any = null
      pasted = this.safe(() => (shapes && typeof shapes.Paste === 'function' ? shapes.Paste() : null))
      if (!pasted) {
        pasted = this.safe(() =>
          ctx.app && ctx.app.ActiveWindow && ctx.app.ActiveWindow.View && typeof ctx.app.ActiveWindow.View.Paste === 'function'
            ? ctx.app.ActiveWindow.View.Paste()
            : null
        )
      }
      if (!pasted) return null

      const pickFirstShape = (obj: any) => {
        if (!obj) return null
        try {
          if (typeof obj.Item === 'function') return obj.Item(1)
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
        }
        return obj
      }
      const sh = pickFirstShape(pasted)
      if (!sh) return pasted

      try {
        const l = Number(pos.left)
        const t = Number(pos.top)
        if (Number.isFinite(l)) this.safe(() => (sh.Left = l))
        if (Number.isFinite(t)) this.safe(() => (sh.Top = t))
        if (typeof pos.width === 'number' && Number.isFinite(pos.width) && pos.width > 0) this.safe(() => (sh.Width = pos.width))
        if (typeof pos.height === 'number' && Number.isFinite(pos.height) && pos.height > 0) this.safe(() => (sh.Height = pos.height))
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }

      return sh
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      return null
    } finally {
      try {
        if (container && container.parentNode) container.parentNode.removeChild(container)
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
    }
  }

  private addChartWpp(ctx: { app: any; pres: any; slide?: any }, action: AddChartAction) {
    const slide = this.resolveTargetSlideWpp(ctx, (action as any)?.slide_index)
    if (!slide) throw new Error('target slide not available')

    let left = Number((action as any)?.left || 1) * 28.35
    let top = Number((action as any)?.top || 1) * 28.35
    let width = Number((action as any)?.width || 15) * 28.35
    let height = Number((action as any)?.height || 10) * 28.35
    const data = (action as any)?.data as Array<Array<any>> | undefined

    const shapes = this.safe(() => slide.Shapes)
    if (!shapes) throw new Error('shapes not available')

    // Best-effort: use placeholder bounds when requested (reduces guessed coords).
    const placeholderKind = String((action as any)?.placeholder_kind || '').trim().toLowerCase()
    const placeholderTypeRaw = (action as any)?.placeholder_type
    const placeholderIndex = Math.max(1, Number((action as any)?.placeholder_index || 1) || 1)
    const kindMap: Record<string, number> = { title: 1, body: 2, subtitle: 4 }
    const placeholderType =
      Number.isFinite(Number(placeholderTypeRaw)) ? Number(placeholderTypeRaw) :
      (placeholderKind && placeholderKind in kindMap ? kindMap[placeholderKind] : null)
    if (placeholderType != null) {
      let target: any = null
      try {
        if (placeholderKind === 'title') target = this.safe(() => (shapes as any).Title)
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
        target = null
      }
      if (!target) {
        const candidates: any[] = []
        const count = Number(this.safe(() => (shapes as any).Count, 0)) || 0
        for (let i = 1; i <= count; i++) {
          const sh = this.safe(() => (shapes as any).Item(i))
          if (!sh) continue
          const pf = this.safe(() => (sh as any).PlaceholderFormat)
          if (!pf) continue
          const t = Number(this.safe(() => (pf as any).PlaceholderType, -1)) || -1
          if (t === placeholderType) candidates.push(sh)
        }
        target = candidates[Math.min(candidates.length - 1, placeholderIndex - 1)] || candidates[0] || null
      }
      if (target) {
        const l = Number(this.safe(() => (target as any).Left, NaN as any) as any)
        const t = Number(this.safe(() => (target as any).Top, NaN as any) as any)
        const w = Number(this.safe(() => (target as any).Width, NaN as any) as any)
        const h = Number(this.safe(() => (target as any).Height, NaN as any) as any)
        if (Number.isFinite(l) && Number.isFinite(t) && Number.isFinite(w) && Number.isFinite(h)) {
          left = l
          top = t
          width = w
          height = h
        }
      }
    }

    // WPS PPT中图表类型对应常量
    const chartTypeMap: Record<string, number> = {
      bar: 51,      // xlBarClustered
      column: 51,  // xlColumnClustered
      line: 4,      // xlLine
      pie: 5,       // xlPie
      area: 1,      // xlArea
      scatter: -4169 // xlXYScatter
    }
    const chartType = chartTypeMap[String((action as any)?.chart_type || 'bar').toLowerCase()] || 51

    try {
      let chart: any = null
      const createErrors: string[] = []
      const tryCreate = (label: string, fn: () => any) => {
        if (chart) return
        try {
          const v = fn()
          if (v) chart = v
        } catch (e) {
          createErrors.push(`${label}: ${_errMsg(e)}`)
        }
      }

      // Prefer AddChart2 when available.
      tryCreate('Shapes.AddChart2', () => {
        const fn = (shapes as any)?.AddChart2
        return typeof fn === 'function' ? fn.call(shapes, -1, chartType, left, top, width, height) : null
      })

      // Fallback to older API variants.
      tryCreate('Shapes.AddChart(type,left,top,width,height)', () => {
        const fn = (shapes as any)?.AddChart
        return typeof fn === 'function' ? fn.call(shapes, chartType, left, top, width, height) : null
      })
      tryCreate('Shapes.AddChart(type)', () => {
        const fn = (shapes as any)?.AddChart
        return typeof fn === 'function' ? fn.call(shapes, chartType) : null
      })

      // When created without coords, best-effort move/resize.
      if (chart) {
        this.safe(() => {
          if ('Left' in chart) (chart as any).Left = left
          if ('Top' in chart) (chart as any).Top = top
          if ('Width' in chart) (chart as any).Width = width
          if ('Height' in chart) (chart as any).Height = height
          return null as any
        })
      }

      if (!chart) {
        const chartTypeName = String((action as any)?.chart_type || 'bar')
        const chartTitleText = String((action as any)?.title || '').trim()
        const matrixPreview = (() => {
          try {
            if (!Array.isArray(data) || data.length <= 0) return ''
            const rows = data
              .slice(0, 6)
              .map((r) => (Array.isArray(r) ? r.slice(0, 6) : [r]).map((v) => String(v ?? '')).join('\t'))
              .join('\n')
            return rows
          } catch (e) {
            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
            return ''
          }
        })()
        const placeholderText = [
          `[CHART] type=${chartTypeName}${chartTitleText ? ` title=${chartTitleText}` : ''}`,
          matrixPreview ? `data:\n${matrixPreview}` : '',
          createErrors.length ? `errors:\n${createErrors.slice(0, 4).join('\n')}` : '',
        ]
          .filter((x) => !!x)
          .join('\n')
          .slice(0, 5000)

        try {
          _planDiag('warning', `add_chart failed; inserted placeholder for type=${chartTypeName}`)
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
        }
        const slideIndex = Number(this.safe(() => (slide as any).SlideIndex, 0)) || null
        this.addShapeWpp(ctx, {
          id: `chart_${Date.now()}`,
          title: 'Chart placeholder',
          op: 'add_shape',
          shape_type: 'rectangle',
          left: left / 28.35,
          top: top / 28.35,
          width: width / 28.35,
          height: height / 28.35,
          fill_color: '#FFFFFF',
          line_color: '#999999',
          text: placeholderText,
          slide_index: (action as any)?.slide_index ?? slideIndex,
        } as any)
        this.emitCapabilityEvent('plan.capability_matrix', {
          host_app: 'wpp',
          op: 'add_chart',
          branch: 'addChart.placeholder',
          fallback: true,
          success: true,
        })
        return
      }

      // Best-effort: write chart data into the embedded ChartData workbook.
      // NOTE: WPS/Office builds differ; failures should not abort the whole op.
      if (Array.isArray(data) && data.length > 0) {
        let wrote = false
        try {
          const looksNumeric = (v: any) => {
            if (typeof v === 'number') return true
            const s = String(v ?? '').trim()
            if (!s) return false
            return /^[-+]?\d{1,3}(?:,\d{3})*(?:\.\d+)?%?$/.test(s) || /^[-+]?\d+(?:\.\d+)?%?$/.test(s)
          }

          const normalizeMatrix = (rows: Array<Array<any>>): any[][] => {
            const cleaned = rows
              .filter((r) => Array.isArray(r) && r.length > 0)
              .map((r) => r.slice(0, 50))
            if (cleaned.length === 0) return []
            const maxCols = Math.max(...cleaned.map((r) => r.length))
            if (maxCols <= 0) return []

            // Common shortcut: [[category, value], ...]
            if (maxCols === 2) {
              const r0 = cleaned[0]
              const hasHeader = cleaned.length >= 2 && !looksNumeric(r0?.[1]) && looksNumeric(cleaned[1]?.[1])
              const header = hasHeader ? [String(r0?.[0] ?? 'Category'), String(r0?.[1] ?? 'Value')] : ['Category', 'Value']
              const body = hasHeader ? cleaned.slice(1) : cleaned
              const out: any[][] = [header]
              for (const r of body) out.push([r?.[0] ?? '', r?.[1] ?? ''])
              return out
            }

            // Treat as a generic 2D table.
            const out: any[][] = []
            for (const r of cleaned) {
              const row = r.slice(0, maxCols)
              while (row.length < maxCols) row.push('')
              out.push(row)
            }
            return out
          }

          const matrix = normalizeMatrix(data)
          if (matrix.length > 0) {
            const colToLetters = (n: number) => {
              let x = Math.max(1, Math.floor(Number(n) || 1))
              let s = ''
              while (x > 0) {
                const m = (x - 1) % 26
                s = String.fromCharCode(65 + m) + s
                x = Math.floor((x - 1) / 26)
              }
              return s
            }

            const chartObj = this.safe(() => (chart as any).Chart) || (chart as any)
            const chartData = this.safe(() => (chartObj as any).ChartData)
            if (chartData && typeof (chartData as any).Activate === 'function') this.safe(() => (chartData as any).Activate())

            const wb = chartData ? this.safe(() => (chartData as any).Workbook) : null
            const ws =
              (wb ? this.safe(() => (wb as any).Worksheets?.Item?.(1)) : null) ||
              (wb ? this.safe(() => (wb as any).Sheets?.Item?.(1)) : null)
            if (!ws) throw new Error('chart data workbook not available')

            const rowCount = matrix.length
            const colCount = Math.max(1, ...matrix.map((r) => (Array.isArray(r) ? r.length : 1)))
            const clearRows = Math.max(rowCount, 30)
            const clearCols = Math.max(colCount, 10)

            const clearAddr = `A1:${colToLetters(clearCols)}${clearRows}`
            const clearRange = this.safe(() => (ws as any).Range(clearAddr))
            if (clearRange) this.safe(() => (clearRange as any).Clear?.())
            const addr = `A1:${colToLetters(colCount)}${rowCount}`
            const range = this.safe(() => (ws as any).Range(addr))

            if (range) {
              const ok = this.safe(() => {
                ;(range as any).Value2 = matrix
                return true
              }, false as any) as any
              wrote = !!ok
            }

            // Fallback: fill cell-by-cell when bulk write is not supported.
            if (!wrote) {
              for (let r = 0; r < rowCount; r++) {
                const row = Array.isArray(matrix[r]) ? matrix[r] : [matrix[r]]
                for (let c = 0; c < colCount; c++) {
                  const cell = this.safe(() => (ws as any).Cells(r + 1, c + 1))
                  if (cell) this.safe(() => ((cell as any).Value2 = row[c] ?? ''))
                }
              }
              wrote = true
            }

            if (wrote && typeof (chartObj as any).SetSourceData === 'function') {
              const src = range || this.safe(() => (ws as any).Range(addr))
              if (src) this.safe(() => (chartObj as any).SetSourceData(src))
            }
          }

          this.emitCapabilityEvent('plan.capability_matrix', {
            host_app: 'wpp',
            op: 'add_chart',
            branch: 'addChart.data',
            fallback: !wrote,
            success: wrote,
          })
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
          this.emitCapabilityEvent('plan.capability_matrix', {
            host_app: 'wpp',
            op: 'add_chart',
            branch: 'addChart.data',
            fallback: true,
            success: false,
          })
        }
      }

      const title = (action as any)?.title as string | undefined
      if (title) {
        const chartObj = this.safe(() => (chart as any).Chart) || (chart as any)
        const chartTitle = this.safe(() => (chartObj as any).ChartTitle)
        if (chartTitle) this.safe(() => chartTitle.Text = title)
      }

      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'wpp',
        op: 'add_chart',
        branch: 'addChart',
        fallback: false,
        success: true,
      })
    } catch (e) {
      // 如果AddChart2不可用，尝试插入图表占位
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'wpp',
        op: 'add_chart',
        branch: 'addChart',
        fallback: true,
        success: false,
      })
      throw e
    }
  }

  private addTableWpp(ctx: { app: any; pres: any; slide?: any }, action: AddTableAction) {
    const slide = this.resolveTargetSlideWpp(ctx, (action as any)?.slide_index)
    if (!slide) throw new Error('target slide not available')

    const rows = Number((action as any)?.rows || 2)
    const cols = Number((action as any)?.cols || 2)
    const left = Number((action as any)?.left || 1) * 28.35
    const top = Number((action as any)?.top || 1) * 28.35
    const getSlideSize = () => {
      try {
        const ps = this.safe(() => (ctx.pres as any)?.PageSetup)
        const w = Number(this.safe(() => (ps as any)?.SlideWidth, NaN as any) as any)
        const h = Number(this.safe(() => (ps as any)?.SlideHeight, NaN as any) as any)
        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { w, h }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      return null
    }

    let width = (action as any)?.width ? Number((action as any).width) * 28.35 : NaN
    let height = (action as any)?.height ? Number((action as any).height) * 28.35 : NaN
    const size = getSlideSize()
    if (!Number.isFinite(width) || width <= 0) {
      const suggested = 12 * 28.35
      width = size ? Math.max(200, Math.min(size.w - left - 20, suggested)) : suggested
    }
    if (!Number.isFinite(height) || height <= 0) {
      const suggested = Math.max(4 * 28.35, Math.min(10 * 28.35, rows * 0.8 * 28.35 + 1 * 28.35))
      height = size ? Math.max(120, Math.min(size.h - top - 20, suggested)) : suggested
    }
    const data = (action as any)?.data as string[][] | undefined

    const shapes = this.safe(() => slide.Shapes)
    if (!shapes) throw new Error('shapes not available')

    let table: any = null
    const createErrors: string[] = []
    try {
      const fn = (shapes as any)?.AddTable
      if (typeof fn === 'function') {
        table = fn.call(shapes, rows, cols, left, top, width, height)
      }
    } catch (e) {
      createErrors.push(`Shapes.AddTable: ${_errMsg(e)}`)
    }

    if (!table) {
      const preview = (() => {
        try {
          if (!Array.isArray(data) || data.length <= 0) return ''
          const rowsPreview = data
            .slice(0, Math.min(6, rows))
            .map((r) =>
              (Array.isArray(r) ? r.slice(0, Math.min(6, cols)) : [r]).map((v) => String(v ?? '')).join('\t')
            )
            .join('\n')
          return rowsPreview
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
          return ''
        }
      })()
      const placeholderText = [
        `[TABLE] rows=${rows} cols=${cols}`,
        preview ? `data:\n${preview}` : '',
        createErrors.length ? `errors:\n${createErrors.slice(0, 4).join('\n')}` : '',
      ]
        .filter((x) => !!x)
        .join('\n')
        .slice(0, 5000)

      try {
        _planDiag('warning', `add_table failed; inserted placeholder rows=${rows} cols=${cols}`)
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      const slideIndex = Number(this.safe(() => (slide as any).SlideIndex, 0)) || null
      this.addShapeWpp(ctx, {
        id: `table_${Date.now()}`,
        title: 'Table placeholder',
        op: 'add_shape',
        shape_type: 'rectangle',
        left: left / 28.35,
        top: top / 28.35,
        width: width / 28.35,
        height: height / 28.35,
        fill_color: '#FFFFFF',
        line_color: '#999999',
        text: placeholderText,
        slide_index: (action as any)?.slide_index ?? slideIndex,
      } as any)
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'wpp',
        op: 'add_table',
        branch: 'addTable.placeholder',
        fallback: true,
        success: true,
      })
      return
    }

    // 填充数据
    if (data && data.length > 0) {
      const tableObj = this.safe(() => table.Table)
      if (tableObj) {
        for (let r = 0; r < data.length && r < rows; r++) {
          for (let c = 0; c < data[r].length && c < cols; c++) {
            const cell = this.safe(() => tableObj.Cell(r + 1, c + 1))
            if (cell) {
              const tf = this.safe(() => cell.Shape.TextFrame)
              if (tf) {
                const tr = this.safe(() => tf.TextRange)
                if (tr) this.safe(() => tr.Text = data[r][c])
              }
            }
          }
        }
      }
    }

    this.emitCapabilityEvent('plan.capability_matrix', {
      host_app: 'wpp',
      op: 'add_table',
      branch: 'addTable',
      fallback: false,
      success: true,
    })
  }

  private addShapeWpp(ctx: { app: any; pres: any; slide?: any }, action: AddShapeAction) {
    const slide = this.resolveTargetSlideWpp(ctx, (action as any)?.slide_index)
    if (!slide) throw new Error('target slide not available')

    const shapeType = String((action as any)?.shape_type || 'rectangle').toLowerCase()
    const left = Number((action as any)?.left || 1) * 28.35
    const top = Number((action as any)?.top || 1) * 28.35
    const width = Number((action as any)?.width || 5) * 28.35
    const height = Number((action as any)?.height || 3) * 28.35
    const text = (action as any)?.text as string | undefined

    // 形状类型映射
    const shapeTypeMap: Record<string, number> = {
      rectangle: 1,
      oval: 9,
      diamond: 4,
      triangle: 5,
      arrow_right: 34,
      arrow_up: 33,
      arrow_down: 32,
      star: 92,
      heart: 153,
      lightning: 189,
      hexagon: 12,
      pentagon: 106
    }

    const msoType = shapeTypeMap[shapeType] || 1 // 默认矩形

    const shapes = this.safe(() => slide.Shapes)
    if (!shapes) throw new Error('shapes not available')

    let shape: any = null
    let usedBranch = 'AddShape'
    const createErrors: string[] = []
    try {
      const fn = (shapes as any)?.AddShape
      if (typeof fn === 'function') {
        shape = fn.call(shapes, msoType, left, top, width, height)
      }
    } catch (e) {
      createErrors.push(`Shapes.AddShape: ${_errMsg(e)}`)
    }

    if (!shape) {
      // Fallback: textboxes are still Shapes and support Fill/Line in many builds.
      usedBranch = 'AddTextbox'
      try {
        const fn = (shapes as any)?.AddTextbox
        if (typeof fn === 'function') {
          shape = fn.call(shapes, 1, left, top, width, height)
        }
      } catch (e) {
        createErrors.push(`Shapes.AddTextbox: ${_errMsg(e)}`)
      }
    }

    if (!shape) {
      usedBranch = 'AddTextBox'
      try {
        const fn = (shapes as any)?.AddTextBox
        if (typeof fn === 'function') {
          shape = fn.call(shapes, 1, left, top, width, height)
        }
      } catch (e) {
        createErrors.push(`Shapes.AddTextBox: ${_errMsg(e)}`)
      }
    }

    if (!shape) {
      try {
        _planDiag(
          'error',
          `add_shape failed: type=${shapeType} mso=${msoType} left=${left} top=${top} width=${width} height=${height} errors=${createErrors
            .slice(0, 4)
            .join(' | ')}`
        )
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'wpp',
        op: 'add_shape',
        branch: `addShape.${usedBranch}`,
        fallback: true,
        success: false,
        errors: createErrors.slice(0, 4),
      })
      throw new Error('failed to add shape')
    }

    // 填充颜色
    const fillColor = (action as any)?.fill_color
    if (fillColor) {
      const rgb = this._wppHexToRgbLong(fillColor)
      if (rgb !== null) {
        this.safe(() => {
          shape.Fill.ForeColor.RGB = rgb
          shape.Fill.Visible = 1
        })
      }
    }

    // 边框颜色
    const lineColor = (action as any)?.line_color
    if (lineColor) {
      const rgb = this._wppHexToRgbLong(lineColor)
      if (rgb !== null) {
        this.safe(() => {
          shape.Line.ForeColor.RGB = rgb
          shape.Line.Visible = 1
        })
      }
    }

    // 文本
    if (text) {
      const tf = this.safe(() => shape.TextFrame)
      if (tf) {
        const tr = this.safe(() => tf.TextRange)
        if (tr) this.safe(() => tr.Text = text)
      }
    }

    this.emitCapabilityEvent('plan.capability_matrix', {
      host_app: 'wpp',
      op: 'add_shape',
      branch: `addShape.${usedBranch}`,
      fallback: usedBranch !== 'AddShape',
      success: true,
    })
  }

  private deleteSlideWpp(ctx: { app: any; pres: any }, action: DeleteSlideAction) {
    const slides = this.safe(() => ctx.pres.Slides)
    if (!slides) throw new Error('Slides not available')

    const slideIndex = Number((action as any)?.slide_index)
    const count = Number(this.safe(() => slides.Count, 0)) || 0

    let targetIndex: number
    if (slideIndex && slideIndex > 0 && slideIndex <= count) {
      targetIndex = slideIndex
    } else {
      // 删除当前幻灯片
      const view = this.safe(() => ctx.app.ActiveWindow?.View)
      if (view) {
        targetIndex = Number(this.safe(() => view.Slide.SlideIndex)) || count
      } else {
        targetIndex = count
      }
    }

    const slide = this.safe(() => slides.Item(targetIndex))
    if (!slide) throw new Error('slide not found')

    this.safe(() => {
      if (typeof slide.Delete === 'function') slide.Delete()
    })

    this.emitCapabilityEvent('plan.capability_matrix', {
      host_app: 'wpp',
      op: 'delete_slide',
      branch: 'deleteSlide',
      fallback: false,
      success: true,
    })
  }

  private duplicateSlideWpp(ctx: { app: any; pres: any }, action: DuplicateSlideAction) {
    const slides = this.safe(() => ctx.pres.Slides)
    if (!slides) throw new Error('Slides not available')

    const sourceIndex = Number((action as any)?.source_index)
    const targetPosition = Number((action as any)?.target_position)
    const count = Number(this.safe(() => slides.Count, 0)) || 0

    let srcIdx = sourceIndex
    if (!srcIdx || srcIdx < 1 || srcIdx > count) {
      // 使用当前幻灯片
      const view = this.safe(() => ctx.app.ActiveWindow?.View)
      if (view) {
        srcIdx = Number(this.safe(() => view.Slide.SlideIndex)) || 1
      } else {
        srcIdx = count
      }
    }

    const sourceSlide = this.safe(() => slides.Item(srcIdx))
    if (!sourceSlide) throw new Error('source slide not found')

    // 复制幻灯片
    let duplicated: any = null
    let usedFallback = false
    const dupErrors: string[] = []

    try {
      const dupFn = (sourceSlide as any)?.Duplicate
      if (typeof dupFn === 'function') {
        duplicated = dupFn.call(sourceSlide)
      }
    } catch (e) {
      dupErrors.push(`Slide.Duplicate: ${_errMsg(e)}`)
    }

    if (!duplicated) {
      // Fallback: Copy + Slides.Paste (WPS/Office variants differ).
      usedFallback = true
      try {
        const copyFn = (sourceSlide as any)?.Copy
        if (typeof copyFn === 'function') {
          copyFn.call(sourceSlide)
        } else {
          dupErrors.push('Slide.Copy: not a function')
        }
      } catch (e) {
        dupErrors.push(`Slide.Copy: ${_errMsg(e)}`)
      }

      try {
        const pasteFn = (slides as any)?.Paste
        if (typeof pasteFn === 'function') {
          // Try paste at target position when supported.
          if (Number.isFinite(targetPosition) && targetPosition > 0) {
            try {
              duplicated = pasteFn.call(slides, targetPosition)
            } catch (e) {
              dupErrors.push(`Slides.Paste(pos): ${_errMsg(e)}`)
            }
          }
          if (!duplicated) {
            duplicated = pasteFn.call(slides)
          }
        } else {
          dupErrors.push('Slides.Paste: not a function')
        }
      } catch (e) {
        dupErrors.push(`Slides.Paste: ${_errMsg(e)}`)
      }

      if (!duplicated) {
        try {
          const view = this.safe(() => ctx.app.ActiveWindow?.View)
          const viewPaste = (view as any)?.Paste
          if (typeof viewPaste === 'function') {
            duplicated = viewPaste.call(view)
          }
        } catch (e) {
          dupErrors.push(`ActiveWindow.View.Paste: ${_errMsg(e)}`)
        }
      }
    }

    if (!duplicated) {
      try {
        _planDiag('error', `duplicate_slide failed: src=${srcIdx} errors=${dupErrors.slice(0, 4).join(' | ')}`)
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
      }
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'wpp',
        op: 'duplicate_slide',
        branch: usedFallback ? 'duplicateSlide.copy_paste' : 'duplicateSlide',
        fallback: usedFallback,
        success: false,
        errors: dupErrors.slice(0, 4),
      })
      throw new Error('failed to duplicate slide')
    }

    // WPS sometimes returns SlideRange; best-effort unwrap to a Slide.
    let newSlide: any = duplicated
    const first = this.safe(() => (duplicated as any).Item?.(1))
    if (first) newSlide = first

    // 移动到目标位置
    if (targetPosition && targetPosition > 0 && targetPosition <= count + 1) {
      if (typeof (newSlide as any).MoveTo === 'function') {
        this.safe(() => (newSlide as any).MoveTo(targetPosition))
      } else {
        const newIndex = Number(this.safe(() => (newSlide as any).SlideIndex, 0 as any) || 0)
        const byIndex = newIndex > 0 ? this.safe(() => slides.Item(newIndex)) : null
        if (byIndex && typeof (byIndex as any).MoveTo === 'function') {
          this.safe(() => (byIndex as any).MoveTo(targetPosition))
        }
      }
    }

    this.emitCapabilityEvent('plan.capability_matrix', {
      host_app: 'wpp',
      op: 'duplicate_slide',
      branch: usedFallback ? 'duplicateSlide.copy_paste' : 'duplicateSlide',
      fallback: usedFallback,
      success: true,
    })
  }

  private reorderSlidesWpp(ctx: { app: any; pres: any }, action: ReorderSlidesAction) {
    const slides = this.safe(() => ctx.pres.Slides)
    if (!slides) throw new Error('Slides not available')

    const fromIndex = Number((action as any)?.from_index)
    const toIndex = Number((action as any)?.to_index)
    const count = Number(this.safe(() => slides.Count, 0)) || 0

    if (!fromIndex || fromIndex < 1 || fromIndex > count) {
      throw new Error('invalid from_index')
    }
    if (!toIndex || toIndex < 1 || toIndex > count) {
      throw new Error('invalid to_index')
    }

    if (fromIndex === toIndex) return // 无需移动

    const slide = this.safe(() => slides.Item(fromIndex))
    if (!slide) throw new Error('source slide not found')

    // 使用MoveTo进行排序
    this.safe(() => {
      if (typeof slide.MoveTo === 'function') {
        slide.MoveTo(toIndex)
      }
    })

    this.emitCapabilityEvent('plan.capability_matrix', {
      host_app: 'wpp',
      op: 'reorder_slides',
      branch: 'reorderSlides',
      fallback: false,
      success: true,
    })
  }

  private resolveTargetSlideWpp(ctx: { app: any; pres: any; slide?: any }, slideIndex?: number | null): any {
    if (slideIndex) {
      const slides = this.safe(() => ctx.pres.Slides)
      if (slides) {
        const idx = Number(slideIndex)
        if (idx > 0 && idx <= Number(this.safe(() => slides.Count, 0) || 0)) {
          return this.safe(() => slides.Item(idx))
        }
      }
    }
    // 返回当前幻灯片或第一个幻灯片
    return ctx.slide || this.safe(() => ctx.app.ActiveWindow?.View?.Slide) || this.safe(() => ctx.pres.Slides?.Item(1))
  }

  private setSlideTransitionWpp(ctx: { app: any; pres: any }, action: SetSlideTransitionAction) {
    const effect = String((action as any)?.effect || 'fade').toLowerCase()
    const duration = Number((action as any)?.duration || 1)
    const slideIndex = (action as any)?.slide_index
    const applyToAll = (action as any)?.apply_to_all

    // 切换效果常量映射
    const effectMap: Record<string, number> = {
      fade: 1,
      push: 2,
      reveal: 3,
      split: 4,
      blind: 5,
      wipe: 6,
      slide: 7,
      cover: 8,
      uncover: 9,
      dissolve: 10,
      boxes: 11,
      wheels: 12
    }

    const effectId = effectMap[effect] || 1 // 默认fade

    const applySlides = [] as any[]
    if (applyToAll) {
      const slides = this.safe(() => ctx.pres.Slides)
      if (slides) {
        const count = Number(this.safe(() => slides.Count, 0)) || 0
        for (let i = 1; i <= count; i++) {
          const s = this.safe(() => slides.Item(i))
          if (s) applySlides.push(s)
        }
      }
    } else {
      const slide = this.resolveTargetSlideWpp(ctx, slideIndex)
      if (slide) applySlides.push(slide)
    }

    for (const slide of applySlides) {
      const ts = this.safe(() => slide.SlideShowTransition)
      if (ts) {
        this.safe(() => {
          ts.EntryEffect = effectId
          ts.Duration = duration
          ts.AdvanceOnClick = (action as any)?.advance_on_click !== false ? 1 : 0
        })
      }
    }

    this.emitCapabilityEvent('plan.capability_matrix', {
      host_app: 'wpp',
      op: 'set_slide_transition',
      branch: 'setSlideTransition',
      fallback: false,
      success: true,
    })
  }

  private addAnimationWpp(ctx: { app: any; pres: any; slide?: any }, action: AddAnimationAction) {
    const slide = this.resolveTargetSlideWpp(ctx, (action as any)?.slide_index)
    if (!slide) throw new Error('target slide not available')

    const effect = String((action as any)?.effect || 'fade').toLowerCase()
    const targetIndex = Number((action as any)?.target_index)
    const targetShapeName = (action as any)?.target_shape_name as string | undefined

    // 动画效果映射
    const effectMap: Record<string, number> = {
      fade_in: 1,
      appear: 2,
      zoom_in: 3,
      fly_in_left: 4,
      fly_in_right: 5,
      fly_in_top: 6,
      fly_in_bottom: 7,
      wipe_left: 8,
      wipe_right: 9,
      wipe_top: 10,
      wipe_bottom: 11,
      grow: 12,
      spin: 13,
      fade_out: 14,
      zoom_out: 15
    }

    const effectId = effectMap[effect] || 1

    // 触发方式
    const trigger = String((action as any)?.trigger || 'on_click').toLowerCase()
    const triggerMap: Record<string, number> = {
      on_click: 1,
      with_previous: 2,
      after_previous: 3
    }
    const triggerId = triggerMap[trigger] || 1

    try {
      // 尝试使用TimeLine添加动画
      const timeline = this.safe(() => slide.TimeLine)
      if (timeline) {
        const mainSeq = this.safe(() => timeline.MainSequence)
        if (mainSeq) {
          let target: any = null

          // 查找目标形状
          if (targetIndex) {
            const shapes = this.safe(() => slide.Shapes)
            if (shapes) {
              target = this.safe(() => shapes.Item(targetIndex))
            }
          } else if (targetShapeName) {
            const shapes = this.safe(() => slide.Shapes)
            if (shapes) {
              const count = Number(this.safe(() => shapes.Count, 0)) || 0
              for (let i = 1; i <= count; i++) {
                const s = this.safe(() => shapes.Item(i))
                if (s && this.safe(() => s.Name) === targetShapeName) {
                  target = s
                  break
                }
              }
            }
          }

          if (target) {
            const animEffect = this.safe(() => mainSeq.AddEffect(target, effectId, triggerId))
            if (animEffect) {
              const duration = Number((action as any)?.duration || 1)
              const delay = Number((action as any)?.delay || 0)
              this.safe(() => {
                if (animEffect.Timing) {
                  animEffect.Timing.Duration = duration
                  animEffect.Timing.TriggerDelayTime = delay
                }
              })
            }
          }
        }
      }

      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'wpp',
        op: 'add_animation',
        branch: 'addAnimation',
        fallback: false,
        success: true,
      })
    } catch (e) {
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'wpp',
        op: 'add_animation',
        branch: 'addAnimation',
        fallback: true,
        success: false,
      })
      throw e
    }
  }

  private setAnimationTimingWpp(ctx: { app: any; pres: any; slide?: any }, action: SetAnimationTimingAction) {
    const slide = this.resolveTargetSlideWpp(ctx, (action as any)?.slide_index)
    if (!slide) throw new Error('target slide not available')

    const animIndex = Number((action as any)?.animation_index)
    if (!animIndex || animIndex < 1) throw new Error('invalid animation_index')

    try {
      const timeline = this.safe(() => slide.TimeLine)
      if (timeline) {
        const mainSeq = this.safe(() => timeline.MainSequence)
        if (mainSeq) {
          const count = Number(this.safe(() => mainSeq.Count, 0)) || 0
          if (animIndex > 0 && animIndex <= count) {
            const effect = this.safe(() => mainSeq.Item(animIndex))
            if (effect && effect.Timing) {
              const trigger = (action as any)?.trigger
              const duration = (action as any)?.duration
              const delay = (action as any)?.delay

              if (trigger) {
                const triggerMap: Record<string, number> = { on_click: 1, with_previous: 2, after_previous: 3 }
                if (trigger in triggerMap) {
                  this.safe(() => effect.Timing.TriggerType = triggerMap[trigger])
                }
              }
              if (duration !== undefined && duration !== null) {
                this.safe(() => effect.Timing.Duration = duration)
              }
              if (delay !== undefined && delay !== null) {
                this.safe(() => effect.Timing.TriggerDelayTime = delay)
              }
            }
          }
        }
      }

      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'wpp',
        op: 'set_animation_timing',
        branch: 'setAnimationTiming',
        fallback: false,
        success: true,
      })
    } catch (e) {
      this.emitCapabilityEvent('plan.capability_matrix', {
        host_app: 'wpp',
        op: 'set_animation_timing',
        branch: 'setAnimationTiming',
        fallback: true,
        success: false,
      })
      throw e
    }
  }

  private addHyperlinkWpp(ctx: { app: any; pres: any; slide?: any }, action: AddHyperlinkAction) {
    const slide = this.resolveTargetSlideWpp(ctx, (action as any)?.slide_index)
    if (!slide) throw new Error('target slide not available')

    const address = String((action as any)?.address || '')
    if (!address) throw new Error('hyperlink address is required')

    const textToDisplay = (action as any)?.text_to_display as string | undefined
    const tooltip = (action as any)?.tooltip as string | undefined
    const targetShapeName = (action as any)?.target_shape_name as string | undefined

    let target: any = null

    // 查找目标形状
    if (targetShapeName) {
      const shapes = this.safe(() => slide.Shapes)
      if (shapes) {
        const count = Number(this.safe(() => shapes.Count, 0)) || 0
        for (let i = 1; i <= count; i++) {
          const s = this.safe(() => shapes.Item(i))
          if (s && this.safe(() => s.Name) === targetShapeName) {
            target = s
            break
          }
        }
      }
    }

    // 如果没有指定形状，创建一个文本框
    if (!target) {
      const shapes = this.safe(() => slide.Shapes)
      if (shapes) {
        const errors: string[] = []
        const tryCreate = (label: string, fn: () => any) => {
          if (target) return
          try {
            const v = fn()
            if (v) target = v
          } catch (e) {
            errors.push(`${label}: ${_errMsg(e)}`)
          }
        }
        tryCreate('Shapes.AddTextbox', () => {
          const fn = (shapes as any)?.AddTextbox
          return typeof fn === 'function' ? fn.call(shapes, 1, 100, 100, 200, 30) : null
        })
        tryCreate('Shapes.AddTextBox', () => {
          const fn = (shapes as any)?.AddTextBox
          return typeof fn === 'function' ? fn.call(shapes, 1, 100, 100, 200, 30) : null
        })
        if (!target && errors.length > 0) {
          try {
            _planDiag('warning', `add_hyperlink: failed to create textbox target: ${errors.slice(0, 4).join(' | ')}`)
          } catch (e) {
            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/plan-executor.ts', e)
          }
        }
        if (target && textToDisplay) {
          const tf = this.safe(() => target.TextFrame)
          if (tf) {
            const tr = this.safe(() => tf.TextRange)
            if (tr) this.safe(() => tr.Text = textToDisplay)
          }
        }
      }
    }

    if (!target) throw new Error('failed to create hyperlink target')

    // 添加超链接
    const hyperlink = this.safe(() => target.Hyperlink)
    if (hyperlink) {
      this.safe(() => hyperlink.Address = address)
      if (tooltip) this.safe(() => hyperlink.ScreenTip = tooltip)
    }

    this.emitCapabilityEvent('plan.capability_matrix', {
      host_app: 'wpp',
      op: 'add_hyperlink',
      branch: 'addHyperlink',
      fallback: false,
      success: true,
    })
  }

  private setPresentationPropsWpp(ctx: { app: any; pres: any }, action: SetPresentationPropsAction) {
    const props = this.safe(() => ctx.pres.PageSetup)
    if (!props) throw new Error('presentation not available')

    const title = (action as any)?.title
    const author = (action as any)?.author
    const subject = (action as any)?.subject
    const comments = (action as any)?.comments

    // 设置文档属性
    const builtInProps = this.safe(() => ctx.pres.BuiltInDocumentProperties)
    if (builtInProps) {
      if (title) {
        this.safe(() => ((builtInProps.Item('Title') as any).Value = title))
      }
      if (author) {
        this.safe(() => ((builtInProps.Item('Author') as any).Value = author))
      }
      if (subject) {
        this.safe(() => ((builtInProps.Item('Subject') as any).Value = subject))
      }
      if (comments) {
        this.safe(() => ((builtInProps.Item('Comments') as any).Value = comments))
      }
    }

    this.emitCapabilityEvent('plan.capability_matrix', {
      host_app: 'wpp',
      op: 'set_presentation_props',
      branch: 'setPresentationProps',
      fallback: false,
      success: true,
    })
  }

  // ===================== WPP新增操作方法结束 =====================

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
          // WPP新增操作
          case 'add_slide': {
            this.addSlideWpp(ctx, action as any)
            break
          }
          case 'add_textbox': {
            this.addTextboxWpp(ctx, action as any)
            break
          }
          case 'add_image': {
            this.addImageWpp(ctx, action as any)
            break
          }
          case 'add_chart': {
            this.addChartWpp(ctx, action as any)
            break
          }
          case 'add_table': {
            this.addTableWpp(ctx, action as any)
            break
          }
          case 'add_shape': {
            this.addShapeWpp(ctx, action as any)
            break
          }
          case 'delete_slide': {
            this.deleteSlideWpp(ctx, action as any)
            break
          }
          case 'duplicate_slide': {
            this.duplicateSlideWpp(ctx, action as any)
            break
          }
          case 'reorder_slides': {
            this.reorderSlidesWpp(ctx, action as any)
            break
          }
          case 'set_slide_transition': {
            this.setSlideTransitionWpp(ctx, action as any)
            break
          }
          case 'add_animation': {
            this.addAnimationWpp(ctx, action as any)
            break
          }
          case 'set_animation_timing': {
            this.setAnimationTimingWpp(ctx, action as any)
            break
          }
          case 'add_hyperlink': {
            this.addHyperlinkWpp(ctx, action as any)
            break
          }
          case 'set_presentation_props': {
            this.setPresentationPropsWpp(ctx, action as any)
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
            const children = (action as any).actions
            if (!Array.isArray(children) || children.length === 0) {
              throw new Error('upsert_block requires non-empty actions (WPP)')
            }
            this.executeActionsWpp({ app: ctx.app, pres: ctx.pres, slide }, children, emit)
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
