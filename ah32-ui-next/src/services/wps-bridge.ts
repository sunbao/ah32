/**
 * WPS 文档桥接服务
 * 提供与 WPS 文档的深度集成功能
 * 支持多文档管理、源文档读取、向当前活动文档写入
 *
 * 注意：WPS 免费版不支持 VBA，使用 JS 宏替代
 */

import { getClientId } from '@/utils/client-id'

// VBA常量映射表 - WPS免费版不支持VBA，但JS API仍使用这些值
const VBA_CONSTANTS = {
  STATISTIC_WORDS: 2,  // wdStatisticWords
  STATISTIC_PAGES: 1  // wdStatisticPages
} as const

// 延迟导入，避免循环依赖
let detectAndSync: () => Promise<boolean> = () => Promise.resolve(false)
let logToBackend: (msg: string, level?: 'info' | 'warning' | 'error') => void = () => {}

// 动态初始化导入
const initDocumentSync = () => {
  import('./document-sync').then(module => {
    detectAndSync = module.detectAndSync
    logToBackend = module.logToBackend
  }).catch((e: any) => {
    try { console.warn('[WPSBridge] failed to import document-sync', e) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e) }
  })
}

// 延迟初始化
initDocumentSync()

// 文档信息类型
export type WPSHostApp = 'wps' | 'et' | 'wpp' | 'unknown'

export interface WPSDocumentInfo {
  id: string
  name: string
  fullPath: string
  isActive: boolean
  hostApp?: WPSHostApp
  wordCount?: number
  pageCount?: number
}

// 写入选项
export interface WriteOptions {
  style?: 'heading' | 'normal' | 'quote'
  separator?: boolean  // 是否添加分隔符
  saveAfter?: boolean  // 写入后是否保存
}

/**
 * WPS 文档桥接类
 * 提供文档操作的核心功能
 */
export class WPSDocumentBridge {
  private cachedDocs: Map<string, WPSDocumentInfo> = new Map()
  private documentChangeCallbacks: Array<(docs: WPSDocumentInfo[]) => void | Promise<void>> = []
  private isEventListenersAdded = false
  private capabilitiesCache: { host: WPSHostApp; ts: number; value: any } | null = null
  private docWatchTimer: any = null
  private docWatchTickInFlight = false
  private docWatchTickPending = false
  private docWatchErrorStreak = 0
  private docWatchDelayMs = 1000
  private lastDocSnapshot: string = ''
  private lastDocs: WPSDocumentInfo[] = []
  // Runtime-only stable IDs for unsaved documents (Name-only is not unique and causes cross-doc stomps).
  private runtimeDocIds: Map<any, string> = new Map()
  // Best-effort: map docId -> live document object (helps activate without relying on re-identification).
  private docObjById: Map<string, any> = new Map()

  private execFuncBranchLogged: Set<string> = new Set()
  private execFuncFailLogged: Set<string> = new Set()
  private wpsApiErrorLogged: Set<string> = new Set()

  private reportWpsProbeError(scope: string, error: unknown): void {
    const isExecRequired = this._isExecFuncRequiredError(error)
    if (isExecRequired) {
      try {
        const key = `wps_probe_exec_required:${scope}`
        if (!this.wpsApiErrorLogged.has(key)) {
          this.wpsApiErrorLogged.add(key)
          logToBackend?.(
            `[WPSBridge] ${scope} requires ExecFunc context: ${String((error as any)?.message || error)}`,
            'warning'
          )
        }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
      }
      return
    }

    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', error)
  }

  private _isExecFuncRequiredError(error: unknown): boolean {
    try {
      const msg = String((error as any)?.message || error || '').toLowerCase()
      return msg.includes('execfunc') && (msg.includes('please execute') || msg.includes('wps api'))
    } catch {
      return false
    }
  }

  private execWpsApi<T>(label: string, fn: () => T, fallback: T): T {
    try {
      const w: any = window as any
      const inExec = !!w.__AH32_WPS_IN_EXECFUNC__
      const exec = w.ExecFunc

      if (!inExec && typeof exec === 'function') {
        // Some WPS runtimes require calling WPS APIs within window.ExecFunc().
        // Use a stable thunk runner to avoid stringifying complex args.
        try {
          if (typeof w.__AH32_WPS_EXEC_RUN__ !== 'function') {
            w.__AH32_WPS_EXEC_RUN__ = function () {
              const ww: any = window as any
              const thunk = ww.__AH32_WPS_EXEC_THUNK__
              ww.__AH32_WPS_EXEC_THUNK__ = null
              if (typeof thunk !== 'function') return null
              ww.__AH32_WPS_IN_EXECFUNC__ = true
              try {
                return thunk()
              } finally {
                ww.__AH32_WPS_IN_EXECFUNC__ = false
              }
            }
          }
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
        }

        try {
          w.__AH32_WPS_EXEC_THUNK__ = fn
          // Use explicit `window.` prefix for better compatibility across WPS runtimes.
          // Some environments fail to resolve bare global identifiers inside ExecFunc eval context.
          let result: any
          try {
            result = exec(`window.__AH32_WPS_EXEC_RUN__()`)
          } catch (e1) {
            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e1)
            result = exec(`__AH32_WPS_EXEC_RUN__()`)
          }
          try {
            if (!this.execFuncBranchLogged.has(label)) {
              this.execFuncBranchLogged.add(label)
              logToBackend?.(`[WPSBridge] using ExecFunc for ${label}`, 'info')
            }
          } catch (e) {
            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
          }
          return result as T
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
          try {
            if (!this.execFuncFailLogged.has(label)) {
              this.execFuncFailLogged.add(label)
              logToBackend?.(
                `[WPSBridge] ExecFunc failed for ${label}: ${String((e as any)?.message || e)}`,
                'warning'
              )
            }
          } catch (e2) {
            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e2)
          }
          // IMPORTANT: if ExecFunc exists but failed, do not run direct WPS API calls outside ExecFunc.
          // That would re-trigger "please execute in window.ExecFunc" errors on each watcher tick.
          return fallback
        } finally {
          try {
            w.__AH32_WPS_EXEC_THUNK__ = null
          } catch (e) {
            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
          }
        }
      }

      return fn()
    } catch (e) {
      const isExecRequired = this._isExecFuncRequiredError(e)
      if (!isExecRequired) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
      }
      try {
        const key = isExecRequired ? `execWpsApi:exec_required:${label}` : `execWpsApi:${label}`
        if (!this.wpsApiErrorLogged.has(key)) {
          this.wpsApiErrorLogged.add(key)
          const msg = String((e as any)?.message || e)
          logToBackend?.(
            isExecRequired
              ? `[WPSBridge] ${label} requires ExecFunc context: ${msg}`
              : `[WPSBridge] ${label} failed: ${msg}`,
            'warning'
          )
        }
      } catch (e2) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e2)
      }
      return fallback
    }
  }

  // Public wrapper: some WPS runtimes require *all* WPS API calls to happen within ExecFunc,
  // including ActiveDocument/Selection/Range manipulations (PlanExecutor, watchers, etc.).
  // Keep it message-first, convention-driven (no extra config toggles).
  runWithWpsApi<T>(label: string, fn: () => T, fallback: T): T {
    return this.execWpsApi(label, fn, fallback)
  }

  /**
   * 获取 WPS Application 实例
   */
  getApplication(): any {
    return this.execWpsApi('getApplication', () => {
      try {
        // 优先使用 window.Application（WPS 注入方式）
        const app = (window as any).Application
        if (app) return app
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
      }

      try {
        // 尝试从 WPS 对象获取
        const wps = (window as any).WPS
        if (wps && typeof wps.GetApplication === 'function') {
          return wps.GetApplication()
        }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
        try {
          if (!this.wpsApiErrorLogged.has('getApplication')) {
            this.wpsApiErrorLogged.add('getApplication')
            logToBackend?.(
              `[WPSBridge] getApplication failed: ${String((e as any)?.message || e)}`,
              'warning'
            )
          }
        } catch (e2) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e2)
        }
      }

      return null
    }, null)
  }

  /**
   * 尽量从 Application 对象推断当前宿主（Writer/Spreadsheets/Presentation）
   *
   * 说明：WPS 的 JSAPI 在不同宿主下暴露的集合不同：
   * - Writer: Documents / ActiveDocument
   * - ET: Workbooks / ActiveWorkbook
   * - WPP: Presentations / ActivePresentation
   */
  getHostApp(): WPSHostApp {
    return this.execWpsApi('getHostApp', () => {
      try {
        const app = this.getApplication()
        if (!app) return 'unknown'

        try {
          if (app.ActiveDocument || app.Documents) return 'wps'
        } catch (e) {
          this.reportWpsProbeError('getHostApp.ActiveDocument/Documents', e)
        }
        try {
          if (app.ActiveWorkbook || app.Workbooks) return 'et'
        } catch (e) {
          this.reportWpsProbeError('getHostApp.ActiveWorkbook/Workbooks', e)
        }
        try {
          if (app.ActivePresentation || app.Presentations) return 'wpp'
        } catch (e) {
          this.reportWpsProbeError('getHostApp.ActivePresentation/Presentations', e)
        }

        return 'unknown'
      } catch (e) {
        this.reportWpsProbeError('getHostApp', e)
        return 'unknown'
      }
    }, 'unknown')
  }

  /**
   * Best-effort capability probe. Used to guide LLM prompts and reduce “API not supported” failures.
   * Keep it lightweight and safe: only checks existence, never calls destructive APIs.
   */
  getCapabilities(force: boolean = false): any {
    const host = this.getHostApp()
    const now = Date.now()
    if (!force && this.capabilitiesCache && this.capabilitiesCache.host === host && (now - this.capabilitiesCache.ts) < 30_000) {
      return this.capabilitiesCache.value
    }

    const app = this.getApplication()
    const probeErrors: string[] = []
    const safe = (fn: () => any, fallback: any = false, label: string = 'probe') => {
      try {
        return fn()
      } catch (e: any) {
        const msg = String(e?.message || e || 'unknown')
        probeErrors.push(`${label}: ${msg}`)
        // Capabilities probe must be non-blocking, but should be observable.
        try { logToBackend(`[WPSBridge] capabilities probe failed: ${label}: ${msg}`, 'warning') } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e) }
        return fallback
      }
    }
    const hasFn = (fn: () => any) => safe(() => typeof fn() === 'function', false)
    const hasObj = (fn: () => any) => safe(() => !!fn(), false)

    const base = {
      host_app: host,
      app_version: safe(() => String(app?.Version || ''), '', 'app.Version'),
      timestamp: new Date().toISOString(),
    } as any

    if (!app) {
      base.available = false
      this.capabilitiesCache = { host, ts: now, value: base }
      return base
    }

    base.available = true
    if (probeErrors.length) {
      base.probe_errors = probeErrors.slice(0, 12)
    }

    if (host === 'wps') {
      const doc = safe(() => app.ActiveDocument, null, 'ActiveDocument')
      base.writer = {
        hasActiveDocument: !!doc,
        hasSelection: hasObj(() => app.Selection),
        hasTables: hasObj(() => doc?.Tables),
        hasShapes: hasObj(() => doc?.Shapes),
        canAddTextEffect: hasFn(() => doc?.Shapes?.AddTextEffect),
        canAddChart2: hasFn(() => doc?.InlineShapes?.AddChart2) || hasFn(() => doc?.Shapes?.AddChart2),
        canAddPicture: hasFn(() => doc?.InlineShapes?.AddPicture) || hasFn(() => doc?.Shapes?.AddPicture),
        rangeHasSetRange: hasFn(() => doc?.Range()?.SetRange),
        selectionHasSetRange: hasFn(() => app.Selection?.SetRange),
        review: {
          // Best-effort probe: do not mutate state here.
          supportsTrackRevisions: safe(() => typeof (doc as any)?.TrackRevisions !== 'undefined', false, 'TrackRevisions'),
          hasComments: hasObj(() => (doc as any)?.Comments),
          canAddComment: hasFn(() => (doc as any)?.Comments?.Add),
        },
        supportsBID: true,
        supportsBIDAnchorEnd: true,
      }
    } else if (host === 'et') {
      const wb = safe(() => app.ActiveWorkbook, null) || safe(() => app.Workbooks?.Item?.(1), null)
      const sheet = safe(() => app.ActiveSheet, null) || safe(() => wb?.ActiveSheet, null)
      base.et = {
        hasActiveWorkbook: !!wb,
        hasActiveSheet: !!sheet,
        hasSelection: hasObj(() => app.Selection),
        hasWorksheets: hasObj(() => wb?.Worksheets),
        canAddWorksheet: hasFn(() => wb?.Worksheets?.Add),
        canClearCells: hasFn(() => sheet?.Cells?.Clear) || hasFn(() => sheet?.UsedRange?.Clear),
        hasCharts: hasObj(() => sheet?.ChartObjects) || hasObj(() => wb?.Charts),
        supportsBID: true,
        supportsBIDAnchorEnd: false,
      }
    } else if (host === 'wpp') {
      const pres = safe(() => app.ActivePresentation, null) || safe(() => app.Presentations?.Item?.(1), null)
      base.wpp = {
        hasActivePresentation: !!pres,
        hasSelection: hasObj(() => app.Selection),
        hasSlides: hasObj(() => pres?.Slides),
        canAddSlide: hasFn(() => pres?.Slides?.Add),
        canSelectSlide: hasFn(() => pres?.Slides?.Item?.(1)?.Select),
        hasSlideTags: hasObj(() => pres?.Slides?.Item?.(1)?.Tags),
        hasShapes: hasObj(() => pres?.Slides?.Item?.(1)?.Shapes),
        canAddTextbox: hasFn(() => pres?.Slides?.Item?.(1)?.Shapes?.AddTextbox),
        supportsBID: true,
        supportsBIDAnchorEnd: false,
      }
    }

    this.capabilitiesCache = { host, ts: now, value: base }
    return base
  }

  /**
   * 检测是否在 WPS 环境中
   */
  isInWPSEnvironment(): boolean {
    const app = this.getApplication()
    if (app) {
      return true
    }

    // 检查 WPS 注入的其他对象
    const wps = (window as any).WPS
    if (wps) {
      return true
    }

    // 检查 PluginStorage（只有 WPS 插件环境才有）
    try {
      const storage = (window as any).Application?.PluginStorage
      if (storage) {
        return true
      }
    } catch (error) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', error)
      try {
        if (!this.wpsApiErrorLogged.has('isInWPSEnvironment:PluginStorage')) {
          this.wpsApiErrorLogged.add('isInWPSEnvironment:PluginStorage')
          logToBackend?.(
            `[WPSBridge] isInWPSEnvironment probe failed: ${String((error as any)?.message || error)}`,
            'warning'
          )
        }
      } catch (e2) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e2)
      }
    }

    return false
  }

  /**
   * 获取 WPS 版本信息
   */
  getVersion(): string | null {
    try {
      const app = this.getApplication()
      return app?.Version || null
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
      return null
    }
  }

  private _joinDocPath(dir: any, name: any): string {
    try {
      const d = String(dir || '').trim()
      const n = String(name || '').trim()
      if (!d || !n) return ''
      const sep = (d.endsWith('\\') || d.endsWith('/')) ? '' : '\\'
      return `${d}${sep}${n}`
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
      return ''
    }
  }

  /**
   * 获取所有打开的文档信息
   */
  getAllOpenDocuments(options?: { includeStats?: boolean }): WPSDocumentInfo[] {
    return this.execWpsApi('getAllOpenDocuments', () => {
      const docs: WPSDocumentInfo[] = []
      try {
        const app = this.getApplication()
        if (!app) {
          return docs
        }

        // Refresh live-object index on each poll.
        try { this.docObjById.clear() } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e) }

        // Avoid spamming console on every watcher tick.
        const debug = false
        const includeStats = options?.includeStats !== false

        const host = this.getHostApp()
        if (host === 'wps') {
          if (!app.Documents) {
            if (debug) console.warn('[WPSBridge] Documents 集合不存在')
            return docs
          }

          const wpsDocs = app.Documents
          if (debug) {
            console.log(`[WPSBridge] Documents.Count = ${wpsDocs.Count}`)
            console.log(`[WPSBridge] ActiveDocument =`, app.ActiveDocument ? app.ActiveDocument.Name : '无')
          }
          const activeId = app.ActiveDocument ? this.getDocId(app.ActiveDocument) : ''

          for (let i = 0; i < wpsDocs.Count; i++) {
            const doc = wpsDocs.Item(i + 1)  // WPS 文档集合是 1-based
            if (doc) {
              const inferredPath = this._joinDocPath((doc as any).Path, (doc as any).Name)
              const fullPath = (doc as any).FullName || inferredPath || ''
              const id = this.getDocId(doc)
              try { this.docObjById.set(String(id), doc) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e) }
              const info: WPSDocumentInfo = {
                id,
                name: doc.Name || '未命名',
                fullPath,
                isActive: !!activeId && id === activeId,
                hostApp: host
              }

              if (debug) {
                console.log(`[WPSBridge] 文档 ${i + 1}:`, {
                  name: info.name,
                  id: info.id,
                  isActive: info.isActive
                })
              }

              // 尝试获取统计信息
              try {
                // NOTE: ComputeStatistics can be expensive and may destabilize the embedded taskpane
                // when called frequently (e.g. document watcher ticks). Allow callers to opt-out.
                if (includeStats) {
                  info.wordCount = doc.ComputeStatistics(VBA_CONSTANTS.STATISTIC_WORDS)
                  info.pageCount = doc.ComputeStatistics(VBA_CONSTANTS.STATISTIC_PAGES)
                }
              } catch (error) {
                // 增强错误处理：记录错误但不中断流程
                if (debug) console.warn('[WPSBridge] 获取文档统计信息失败:', error)
              }

              docs.push(info)
            } else {
              if (debug) console.warn(`[WPSBridge] 第 ${i + 1} 个文档为空`)
            }
          }
        } else if (host === 'et') {
          const wbs = app.Workbooks
          if (!wbs) {
            if (debug) console.warn('[WPSBridge] Workbooks 集合不存在')
            return docs
          }

          if (debug) {
            console.log(`[WPSBridge] Workbooks.Count = ${wbs.Count}`)
            console.log(`[WPSBridge] ActiveWorkbook =`, app.ActiveWorkbook ? app.ActiveWorkbook.Name : '无')
          }
          const activeId = app.ActiveWorkbook ? this.getDocId(app.ActiveWorkbook) : ''

          for (let i = 0; i < wbs.Count; i++) {
            const wb = wbs.Item(i + 1)
            if (!wb) continue
            const inferredPath = this._joinDocPath((wb as any).Path, (wb as any).Name)
            const fullPath = (wb as any).FullName || inferredPath || ''
            const id = this.getDocId(wb)
            try { this.docObjById.set(String(id), wb) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e) }
            const info: WPSDocumentInfo = {
              id,
              name: wb.Name || '未命名',
              fullPath,
              isActive: !!activeId && id === activeId,
              hostApp: host
            }
            docs.push(info)
          }
        } else if (host === 'wpp') {
          const pres = app.Presentations
          if (!pres) {
            if (debug) console.warn('[WPSBridge] Presentations 集合不存在')
            return docs
          }

          if (debug) {
            console.log(`[WPSBridge] Presentations.Count = ${pres.Count}`)
            console.log(`[WPSBridge] ActivePresentation =`, app.ActivePresentation ? app.ActivePresentation.Name : '无')
          }
          const activeId = app.ActivePresentation ? this.getDocId(app.ActivePresentation) : ''

          for (let i = 0; i < pres.Count; i++) {
            const p = pres.Item(i + 1)
            if (!p) continue
            const inferredPath = this._joinDocPath((p as any).Path, (p as any).Name)
            const fullPath = (p as any).FullName || inferredPath || ''
            const id = this.getDocId(p)
            try { this.docObjById.set(String(id), p) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e) }
            const info: WPSDocumentInfo = {
              id,
              name: p.Name || '未命名',
              fullPath,
              isActive: !!activeId && id === activeId,
              hostApp: host
            }
            docs.push(info)
          }
        } else {
          if (debug) console.warn('[WPSBridge] 未识别宿主类型，无法列出文档')
          return docs
        }

        if (debug) {
          console.log(`[WPSBridge] 返回: ${docs.length} 个文档`)
          console.log(`[WPSBridge] 文档列表:`, docs.map(d => ({ name: d.name, id: d.id, isActive: d.isActive, hostApp: d.hostApp })))
        }
      } catch (error) {
        this.reportWpsProbeError('getAllOpenDocuments', error)
        try {
          if (!this.wpsApiErrorLogged.has('getAllOpenDocuments')) {
            this.wpsApiErrorLogged.add('getAllOpenDocuments')
            logToBackend?.(
              `[WPSBridge] getAllOpenDocuments failed: ${String((error as any)?.message || error)}`,
              'warning'
            )
          }
        } catch (e2) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e2)
        }
      }
      return docs
    }, [])
  }

  private _capText(raw: string, maxChars: number): string {
    try {
      const s = String(raw || '')
      if (!maxChars || maxChars <= 0) return s
      return s.length > maxChars ? s.slice(0, maxChars) : s
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
      return ''
    }
  }

  /**
   * Extract plain text from a document/workbook/presentation currently opened in the host app.
   * This is the foundation for "upload-to-RAG" mode when the backend cannot read local paths.
   */
  extractDocumentTextById(
    docId: string,
    options?: { maxChars?: number; maxRows?: number; maxCols?: number }
  ): string {
    const id = String(docId || '').trim()
    if (!id) return ''

    const app = this.getApplication()
    if (!app) return ''

    const host = this.getHostApp()
    const maxChars = options?.maxChars ?? 200_000
    const maxRows = options?.maxRows ?? 200
    const maxCols = options?.maxCols ?? 50

    try {
      if (host === 'wps') {
        const docs = app.Documents
        if (!docs) return ''
        for (let i = 0; i < docs.Count; i++) {
          const d = docs.Item(i + 1)
          if (!d) continue
          if (this.getDocId(d) !== id) continue
          const text = String(d?.Content?.Text || '')
          return this._capText(text, maxChars)
        }
        return ''
      }

      if (host === 'et') {
        const wbs = app.Workbooks
        if (!wbs) return ''
        for (let i = 0; i < wbs.Count; i++) {
          const wb = wbs.Item(i + 1)
          if (!wb) continue
          if (this.getDocId(wb) !== id) continue

          const sheet = wb.ActiveSheet || wb.Sheets?.Item?.(1)
          if (!sheet) return ''
          const used = sheet.UsedRange
          if (!used) return ''

          const values = (used as any).Value2
          const lines: string[] = []

          const pushRow = (row: any[]) => {
            const cells = row
              .slice(0, maxCols)
              .map((v) => (v == null ? '' : String(v)))
              .map((s) => s.replace(/\r?\n/g, ' ').trim())
            lines.push(cells.join('\t'))
          }

          if (Array.isArray(values)) {
            if (values.length > 0 && Array.isArray(values[0])) {
              for (let r = 0; r < Math.min(values.length, maxRows); r++) {
                const row = values[r]
                if (Array.isArray(row)) pushRow(row)
              }
            } else {
              // 1-D array
              for (let r = 0; r < Math.min(values.length, maxRows); r++) {
                pushRow([values[r]])
              }
            }
          } else {
            // Single cell
            pushRow([values])
          }

          return this._capText(lines.join('\n'), maxChars)
        }
        return ''
      }

      if (host === 'wpp') {
        const pres = app.Presentations
        if (!pres) return ''
        for (let i = 0; i < pres.Count; i++) {
          const p = pres.Item(i + 1)
          if (!p) continue
          if (this.getDocId(p) !== id) continue

          const parts: string[] = []
          const slides = p.Slides
          if (!slides) return ''
          for (let s = 0; s < slides.Count; s++) {
            const slide = slides.Item(s + 1)
            if (!slide) continue
            const shapes = slide.Shapes
            if (!shapes) continue
            for (let j = 0; j < shapes.Count; j++) {
              const sh = shapes.Item(j + 1)
              try {
                const hasTf = !!sh?.HasTextFrame
                const tf = sh?.TextFrame
                const hasText = !!tf?.HasText
                if (hasTf && tf && hasText) {
                  const t = String(tf.TextRange?.Text || '').trim()
                  if (t) parts.push(t)
                }
              } catch (e) {
                ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
                // ignore shape text errors
              }
            }
          }
          return this._capText(parts.join('\n'), maxChars)
        }
        return ''
      }
    } catch (e) {
      console.warn('[WPSBridge] extractDocumentTextById failed:', e)
      return ''
    }

    return ''
  }

  /**
   * 生成文档唯一 ID
   */
  private getDocId(doc: any): string {
    try {
      // Use path when available (cross-session stable). For unsaved docs, prefer deterministic
      // name-based ids (some hosts return a fresh proxy object each time, making runtime ids unstable).
      // Runtime-only ids are a last resort when even Name is missing.
      const full = String(doc?.FullName || '').trim()
      const joined = String(this._joinDocPath(doc?.Path, doc?.Name) || '').trim()
      const name = String(doc?.Name || '').trim()

      const stablePath = full || joined
      if (stablePath) {
        // 使用简单哈希算法替代 Buffer.from
        let hash = 0
        for (let i = 0; i < stablePath.length; i++) {
          const char = stablePath.charCodeAt(i)
          hash = ((hash << 5) - hash) + char
          hash = hash & hash // 转为 32 位整数
        }
        return 'doc_' + Math.abs(hash).toString(16).substring(0, 16)
      }

      if (name) {
        // Unsaved docs often have empty FullName/Path, and some host environments return a fresh
        // proxy object on each access (WeakMap-based runtime IDs become unstable). Prefer a
        // deterministic name-based id so doc binding survives polling/reload.
        let hash = 0
        for (let i = 0; i < name.length; i++) {
          const char = name.charCodeAt(i)
          hash = ((hash << 5) - hash) + char
          hash = hash & hash
        }
        return 'doc_' + Math.abs(hash).toString(16).substring(0, 16)
      }

      if (doc && (typeof doc === 'object' || typeof doc === 'function')) {
        const existing = this.runtimeDocIds.get(doc)
        if (existing) return existing
        const rid = `doc_rt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        this.runtimeDocIds.set(doc, rid)
        // Avoid unbounded growth in long-running taskpanes.
        if (this.runtimeDocIds.size > 200) this.runtimeDocIds.clear()
        return rid
      }

      return `doc_${Date.now()}`
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
      return 'doc_' + Date.now().toString()
    }
  }

  /**
   * 激活指定 docId（尽量把后续写入/宏执行绑定到该文档）。
   * 注意：不同宿主的对象模型不同；这里只做 best-effort。
   */
  activateDocumentById(docId: string): boolean {
    const id = String(docId || '').trim()
    if (!id) return false

    const app = this.getApplication()
    if (!app) return false

    const host = this.getHostApp()
    try {
      // Fast path: try activating the cached live object (avoids ID collisions / proxy identity changes).
      try {
        const obj = this.docObjById.get(id)
        if (obj) {
          try { if (typeof obj.Activate === 'function') obj.Activate() } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e) }
          try { if (obj.ActiveWindow && typeof obj.ActiveWindow.Activate === 'function') obj.ActiveWindow.Activate() } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e) }
          try { if (obj.Windows && obj.Windows.Count >= 1 && typeof obj.Windows.Item(1)?.Activate === 'function') obj.Windows.Item(1).Activate() } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e) }
          // Verify active matches requested id.
          try {
            const active = (host === 'wps') ? app.ActiveDocument : (host === 'et') ? app.ActiveWorkbook : (host === 'wpp') ? app.ActivePresentation : null
            if (active && this.getDocId(active) === id) return true
          } catch (e) {
            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
          }
        }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
      }

      if (host === 'wps') {
        const docs = app.Documents
        if (!docs) return false
        for (let i = 0; i < docs.Count; i++) {
          const d = docs.Item(i + 1)
          if (d && this.getDocId(d) === id) {
            try { if (typeof d.Activate === 'function') d.Activate() } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e) }
            try { if (d.ActiveWindow && typeof d.ActiveWindow.Activate === 'function') d.ActiveWindow.Activate() } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e) }
            // Verify: avoid writing macros into the wrong active document.
            try {
              const active = app.ActiveDocument
              if (active && this.getDocId(active) === id) return true
            } catch (e) {
              ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
            }
            return false
          }
        }
        return false
      }

      if (host === 'et') {
        const wbs = app.Workbooks
        if (!wbs) return false
        for (let i = 0; i < wbs.Count; i++) {
          const wb = wbs.Item(i + 1)
          if (wb && this.getDocId(wb) === id) {
            try { if (typeof wb.Activate === 'function') wb.Activate() } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e) }
            try { if (wb.Windows && wb.Windows.Count >= 1 && typeof wb.Windows.Item(1)?.Activate === 'function') wb.Windows.Item(1).Activate() } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e) }
            try {
              const active = app.ActiveWorkbook
              if (active && this.getDocId(active) === id) return true
            } catch (e) {
              ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
            }
            return false
          }
        }
        return false
      }

      if (host === 'wpp') {
        const pres = app.Presentations
        if (!pres) return false
        for (let i = 0; i < pres.Count; i++) {
          const p = pres.Item(i + 1)
          if (p && this.getDocId(p) === id) {
            // WPP activation APIs vary; try common window activation patterns.
            try { if (typeof p.Activate === 'function') p.Activate() } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e) }
            try { if (p.Windows && p.Windows.Count >= 1 && typeof p.Windows.Item(1)?.Activate === 'function') p.Windows.Item(1).Activate() } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e) }
            try {
              const active = app.ActivePresentation
              if (active && this.getDocId(active) === id) return true
            } catch (e) {
              ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
            }
            return false
          }
        }
        return false
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
      return false
    }

    return false
  }

  /**
   * Best-effort activation by context (id -> fullPath -> name).
   * This reduces "写到了错误文档" risks when multiple documents are open.
   */
  activateDocumentByContext(ctx?: { docId?: string; fullPath?: string; name?: string } | null): boolean {
    try {
      const docId = String((ctx as any)?.docId || '').trim()
      const fullPath = String((ctx as any)?.fullPath || '').trim()
      const name = String((ctx as any)?.name || '').trim()
      const normPath = (p: string) => String(p || '').replace(/\//g, '\\').trim().toLowerCase()
      const normName = (n: string) => String(n || '').trim().toLowerCase()

      if (docId) {
        if (this.activateDocumentById(docId)) return true
      }

      const docs = this.getAllOpenDocuments({ includeStats: false })
      if (!docs || docs.length <= 0) return false

      // Prefer exact fullPath match (most stable across sessions).
      if (fullPath) {
        const fp = normPath(fullPath)
        const matches = docs.filter((d) => normPath(String(d.fullPath || '')) === fp)
        if (matches.length === 1 && matches[0]?.id) {
          return this.activateDocumentById(String(matches[0]!.id))
        }
      }

      // Fall back to name only when it's unambiguous.
      if (name) {
        const nm = normName(name)
        const matches = docs.filter((d) => normName(String(d.name || '')) === nm)
        if (matches.length === 1 && matches[0]?.id) {
          return this.activateDocumentById(String(matches[0]!.id))
        }
        // If ambiguous, prefer current active doc when it matches the name (safer than "first match").
        if (matches.length > 1) {
          const active = matches.find((d: any) => !!d?.isActive && !!d?.id)
          if (active?.id) return this.activateDocumentById(String(active.id))
        }
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
      return false
    }

    return false
  }

  /**
   * 获取当前活动文档/工作簿/演示（作为默认写入对象）。
   */
  getTargetDocument(): any {
    try {
      const app = this.getApplication()
      if (!app) return null
      const host = this.getHostApp()
      if (host === 'wps') return app.ActiveDocument || null
      if (host === 'et') return app.ActiveWorkbook || (app.Workbooks ? app.Workbooks.Item?.(1) : null) || null
      if (host === 'wpp') return app.ActivePresentation || (app.Presentations ? app.Presentations.Item?.(1) : null) || null
      return app.ActiveDocument || app.ActiveWorkbook || app.ActivePresentation || null
    } catch (error) {
      console.error('获取当前文档失败:', error)
      return null
    }
  }

  /**
   * 读取当前活动文档的全部内容
   */
  async readActiveDocument(): Promise<string> {
    try {
      const app = this.getApplication()
      const doc = app?.ActiveDocument

      if (!doc) {
        return '[错误] 未找到活动文档，请先在 WPS 中打开一个文档'
      }

      // 读取文档内容
      const content = doc.Content.Text

      logToBackend(`[WPSBridge] 读取文档内容: ${content.length} 字符`)

      return content || ''
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      console.error('读取文档失败:', error)
      return `[错误] 读取文档失败: ${errorMsg}`
    }
  }

  /**
   * 写入内容到当前活动文档
   */
  async writeToTarget(content: string, options?: WriteOptions): Promise<boolean> {
    try {
      const app = this.getApplication()
      const doc = this.getTargetDocument()

      if (!app || !doc) {
        logToBackend('[WPSBridge] 写入失败: 文档不可用', 'error')
        return false
      }

      const selection = app.Selection

      // 处理选项
      const style = options?.style || 'normal'
      const addSeparator = options?.separator !== false
      const saveAfter = options?.saveAfter !== false

      // 根据样式设置格式
      switch (style) {
        case 'heading':
          selection.Font.Bold = true
          selection.Font.Size = 16
          break
        case 'quote':
          selection.Font.Italic = true
          selection.Font.Size = 12
          break
        default:
          // normal 样式
          selection.Font.Bold = false
          selection.Font.Size = 12
      }

      // 添加分隔符
      if (addSeparator) {
        selection.TypeParagraph()
        selection.Range.Text = '─'.repeat(30)
        selection.TypeParagraph()
      }

      // 写入内容（使用 Range.Text 替代 TypeText）
      selection.Range.Text = content
      selection.TypeParagraph()

      // 保存文档
      if (saveAfter) {
        doc.Save()
        logToBackend(`[WPSBridge] 内容已写入并保存: ${content.length} 字符`)
      } else {
        logToBackend(`[WPSBridge] 内容已写入: ${content.length} 字符`)
      }

      return true
    } catch (error) {
      logToBackend(`[WPSBridge] 写入失败: ${error}`, 'error')
      console.error('写入文档失败:', error)
      return false
    }
  }

  /**
   * 在当前活动文档中插入图片
   */
  async insertImageToTarget(imagePath: string, width?: number, height?: number): Promise<boolean> {
    try {
      const app = this.getApplication()
      const doc = this.getTargetDocument()

      if (!app || !doc) {
        return false
      }

      const selection = app.Selection

      // 插入图片
      const inlineShape = selection.InlineShapes.AddPicture(imagePath)

      // 设置尺寸
      if (width) {
        inlineShape.Width = width
      }
      if (height) {
        inlineShape.Height = height
      }

      // 保存文档
      doc.Save()

      logToBackend(`[WPSBridge] 图片已插入: ${imagePath}`)
      return true
    } catch (error) {
      logToBackend(`[WPSBridge] 插入图片失败: ${error}`, 'error')
      console.error('插入图片失败:', error)
      return false
    }
  }

  /**
   * 刷新文档缓存
   */
  async refreshCache(): Promise<void> {
    try {
      const docs = this.getAllOpenDocuments()
      this.cachedDocs.clear()

      for (const doc of docs) {
        this.cachedDocs.set(doc.id, doc)
      }

      logToBackend(`[WPSBridge] 文档缓存已刷新: ${docs.length} 个文档`)
    } catch (error) {
      console.error('刷新文档缓存失败:', error)
    }
  }

  /**
   * 同步文档列表到后端
   */
  async syncDocumentsToBackend(): Promise<boolean> {
    try {
      const docs = this.getAllOpenDocuments()
      logToBackend(`[WPSBridge] 同步文档列表: ${docs.length} 个文档`)

      // Perform a real backend sync (client-scoped union). Keep it lazy-imported to avoid circular deps.
      try {
        const mod = await import('./document-sync')
        await mod.syncOpenDocumentsNow()
      } catch (e) {
        logToBackend(`[WPSBridge] syncOpenDocumentsNow failed (ignored): ${String((e as any)?.message || e)}`, 'warning')
      }

      return true
    } catch (error) {
      logToBackend(`[WPSBridge] 同步文档列表失败: ${error}`, 'error')
      return false
    }
  }

  /**
   * 报告 JS 宏执行错误到后端
   */
  async reportJSMacroError(errorType: string, errorMessage: string, errorCode: string = '', correctionSuggestion: string = '', userContext: string = '', severity: string = 'medium', extra?: Record<string, any>): Promise<void> {
    try {
      // 获取API配置（优先 runtime-config；避免“静默 fallback 导致上报到错误的服务”）
      let apiBaseUrl = 'http://127.0.0.1:5123'
      let apiKey = ''
      try {
        const { getRuntimeConfig } = await import('@/utils/runtime-config')
        const cfg = getRuntimeConfig()
        apiBaseUrl = cfg.apiBase || apiBaseUrl
        apiKey = cfg.apiKey || apiKey
      } catch (e) {
        // Keep reporting best-effort, but don't swallow silently.
        try { logToBackend(`[WPSBridge] reportJSMacroError: failed to load runtime-config: ${String((e as any)?.message || e)}`, 'warning') } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e) }
      }

      // 构建错误报告
      const hostApp = this.getHostApp()
      let macroSessionId = ''
      try {
        const m = await import('./js-macro-executor')
        macroSessionId = String((m as any)?.jsMacroExecutor?.sessionId || '')
      } catch (e: any) {
        try { console.warn('[WPSBridge] failed to read jsMacroExecutor.sessionId', e) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e) }
      }

      let activeDoc: any = null
      try {
        const docs = this.getAllOpenDocuments({ includeStats: false } as any)
        activeDoc = Array.isArray(docs) ? (docs.find((d: any) => d && d.isActive) || null) : null
      } catch (e: any) {
        try { logToBackend?.(`[WPSBridge] failed to collect active document for error report: ${String(e?.message || e)}`, 'warning') } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e) }
      }

      let blockId = ''
      try {
        const m = String(errorCode || '').match(/^\s*\/\/\s*@ah32:blockId\s*=\s*([^\s]+)\s*$/m)
        if (m && m[1]) blockId = String(m[1]).trim()
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
      }

      const mergedExtra: Record<string, any> = (() => {
        const patch: Record<string, any> = (extra && typeof extra === 'object') ? { ...extra } : {}
        const base: Record<string, any> = {}
        try {
          if (typeof window !== 'undefined') {
            const w: any = window as any
            if (w.__BID_LAST_USER_QUERY) base.last_user_query = String(w.__BID_LAST_USER_QUERY)
            if (w.__BID_LAST_RAG_SUMMARY) base.last_rag_summary = String(w.__BID_LAST_RAG_SUMMARY)
            if (w.__BID_LAST_SKILLS) base.last_skills = w.__BID_LAST_SKILLS
            if (w.__BID_LAST_RULE_FILES) base.rule_files = w.__BID_LAST_RULE_FILES
          }
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
        }
        return { ...base, ...patch }
      })()

      const errorReport = {
        error_type: errorType,
        error_message: errorMessage,
        error_code: errorCode,
        correction_suggestion: correctionSuggestion,
        user_context: userContext,
        severity: severity,
        host_app: hostApp,
        session_id: macroSessionId,
        doc_id: String(activeDoc?.id || ''),
        doc_key: String(activeDoc?.fullPath || activeDoc?.id || activeDoc?.name || ''),
        document_name: String(activeDoc?.name || ''),
        document_path: String(activeDoc?.fullPath || ''),
        block_id: blockId,
        client_id: getClientId(),
        run_context: {
          mode: 'macro',
          host_app: hostApp,
          doc_id: String(activeDoc?.id || ''),
          doc_key: String(activeDoc?.fullPath || activeDoc?.id || activeDoc?.name || ''),
          session_id: macroSessionId,
          block_id: blockId,
          client_id: getClientId(),
        },
        extra: { client_context: mergedExtra },
      }

      // 发送错误报告到后端
      const response = await fetch(`${apiBaseUrl}/agentic/error/report`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'X-API-Key': apiKey } : {})
        },
        body: JSON.stringify(errorReport)
      })

      if (response.ok) {
        logToBackend(`[WPSBridge] 执行错误已报告: ${errorType}`, 'info')
      } else {
        logToBackend(`[WPSBridge] 错误报告失败: ${response.statusText}`, 'warning')
      }
    } catch (error) {
      console.error('报告JS宏执行错误失败:', error)
      logToBackend(`[WPSBridge] 错误报告异常: ${error}`, 'warning')
    }
  }

  /**
   * 执行 JS 宏代码的便捷方法
   */
  async executeJSMacro(
    jsCode: string,
    autoConfirm: boolean = true,
    onVibeStep?: (step: any) => void
  ): Promise<{
    success: boolean
    message: string
    debugInfo?: any
  }> {
    // 动态导入 JS 宏执行器
    try {
      const { jsMacroExecutor } = await import('./js-macro-executor')

      // Ensure the executor has a session context; required for backend repair calls.
      try {
        const anyExec = jsMacroExecutor as any
        if (!anyExec?.sessionId) {
          let docName = ''
          try {
            const app = this.getApplication()
            docName = app?.ActiveDocument?.Name || app?.ActiveWorkbook?.Name || app?.ActivePresentation?.Name || ''
          } catch (e) {
            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
          }
          jsMacroExecutor.setContext(`macro_${Date.now()}`, docName, this.getHostApp())
        }
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
      }

      const MAX_REPAIR_ATTEMPTS = 5
      const MAX_EXECUTE_MS = 90_000
      const hostApp = this.getHostApp()
      // Auto-enable verbose macro diagnostics only when needed (avoid extra UI toggles).
      let verboseMacroDebug = false
      let lastMacroLogAt = 0
      const debugLog = (msg: string) => {
        if (!verboseMacroDebug) return
        const now = Date.now()
        if (now - lastMacroLogAt < 1200) return
        lastMacroLogAt = now
        try { logToBackend?.(msg) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e) }
      }
      const enableVerboseMacroDebug = (reason: string, debugInfo?: any) => {
        if (verboseMacroDebug) return
        verboseMacroDebug = true
        try { logToBackend?.(`[JSMacro] 已自动开启调试日志：${reason}`, 'info') } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e) }
        try {
          if (!debugInfo) return
          const compact: any = {
            normalizeNotes: debugInfo?.normalizeNotes,
            suspiciousChars: debugInfo?.suspiciousChars,
            suspiciousCharsWrapped: debugInfo?.suspiciousCharsWrapped
          }
          const payload = JSON.stringify(compact)
          if (payload && payload !== '{}' && payload !== 'null') {
            logToBackend?.(`[JSMacro] debugInfo: ${payload.slice(0, 2000)}`, 'info')
          }
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
        }
      }

      const withTimeout = async <T>(work: Promise<T>, ms: number, label: string): Promise<T> => {
        let timer: any = null
        try {
          return await Promise.race([
            work,
            new Promise<T>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
            })
          ])
        } finally {
          if (timer) clearTimeout(timer)
        }
      }
      const extractBlockId = (code: string): string | null => {
        const m = (code || '').match(/^\s*\/\/\s*@ah32:blockId\s*=\s*([^\s]+)\s*$/m)
        if (!m || !m[1]) return null
        return String(m[1]).trim()
      }
      const extractAnchor = (code: string): string | null => {
        const m = (code || '').match(/^\s*\/\/\s*@ah32:anchor\s*=\s*([^\s]+)\s*$/m)
        if (!m || !m[1]) return null
        return String(m[1]).trim()
      }
      const ensureBlockId = (code: string, blockId: string | null): string => {
        const trimmed = (code || '').trim()
        if (!blockId) return trimmed
        if (/^\s*\/\/\s*@ah32:blockId\s*=/.test(trimmed)) return trimmed
        return `// @ah32:blockId=${blockId}\n${trimmed}`
      }
      const ensureAnchor = (code: string, anchor: string | null): string => {
        const trimmed = (code || '').trim()
        const a = (anchor || '').trim().toLowerCase()
        if (!a || a === 'cursor') return trimmed
        if (/^\s*\/\/\s*@ah32:anchor\s*=/.test(trimmed)) return trimmed
        if (/^\s*\/\/\s*@ah32:blockId\s*=/.test(trimmed)) {
          const lines = trimmed.split(/\r?\n/)
          const first = lines.shift() || ''
          return [first, `// @ah32:anchor=${a}`, lines.join('\n')].join('\n').trim()
        }
        return `// @ah32:anchor=${a}\n${trimmed}`
      }

      const targetBlockId = extractBlockId(jsCode)
      const targetAnchor = extractAnchor(jsCode)
      let currentCode = ensureAnchor(ensureBlockId(jsCode, targetBlockId), targetAnchor)
      let repaired = false
      let lastResult: any = null
      const repairSteps: any[] = []
      const pushStep = (step: any) => {
        try {
          repairSteps.push(step)
          onVibeStep?.(step)
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
        }
      }

      const shouldAutoRepair = (errorType: string, errorMessage: string): boolean => {
        // Environment issues are not code-fixable.
        if (!errorMessage) return false
        if (errorMessage.includes('请在WPS中打开文档')) return false
        if (errorMessage.includes('JS 宏执行器不可用')) return false

        // Only attempt repair for code-level issues.
        const repairable = new Set([
          'wps_api_error',
          'javascript_reference_error',
          'javascript_type_error',
          'javascript_syntax_error',
          'javascript_range_error',
          'undefined_variable',
          'execution_error'
        ])
        return repairable.has(errorType)
      }

      const buildRepairQuery = (code: string, errorType: string, errorMessage: string, attempt: number) => {
        const target = hostApp === 'et'
          ? 'WPS 表格(ET)'
          : hostApp === 'wpp'
            ? 'WPS 演示(WPP)'
            : 'WPS Writer'

        const apiConstraint = hostApp === 'et'
          ? '只能使用 `window.Application` / `app.ActiveWorkbook` / `app.ActiveSheet` / `app.Selection`'
          : hostApp === 'wpp'
            ? '只能使用 `window.Application` / `app.ActivePresentation` / `app.Selection`'
            : '只能使用 `window.Application` / `app.ActiveDocument` / `app.Selection`'

        const bidHint = hostApp === 'wps'
          ? [
              '可选：你可以使用 BID 助手对象（已在运行时注入）来更稳定地调用 WPS 内置功能：',
              '- BID.upsertBlock(blockId, fn, opts)  // Writer：避免重复插入；支持 // @ah32:blockId=...',
              '- Writer 额外：// @ah32:anchor_mode=bookmark_only   // 强制使用书签锚点（正文不插入 START/END；不支持则报错）',
              '- Writer 额外：// @ah32:anchor_mode=marker_only     // 强制使用文本标记锚点（兼容兜底）',
              '- BID.insertTable(rows, cols, opts)',
              '- BID.insertChartFromSelection(opts)',
              '- BID.insertWordArt(text, opts)',
              ''
            ].join('\n')
          : [
              '可选：你可以使用运行时已注入的 BID.upsertBlock(blockId, fn) 做“幂等产物”（ET=独立工作表/WPP=独立幻灯片，重跑会自动清空，避免重复）。',
              '其余能力（如表格/图表/艺术字）优先使用 app.* 原生 API；如果调用失败请 throw 以便进入下一轮自动修复。',
              ''
            ].join('\n')

        return [
          `你是 ${target} 的 JS 宏代码修复专家。以下 JS 宏在 WPS 任务窗格环境执行失败。`,
          '请基于错误信息修复代码，使其可执行，并尽量保持原始意图/行为不变（只修改必要部分）。',
          `约束：${apiConstraint}；不要使用 VBA 语法；不要输出 TypeScript 语法（类型注解/interface/type/as/非空断言!）；不要使用模板字符串（反引号\`）；常量用数字；避免依赖不确定存在的便捷 API。`,
          bidHint,
          `执行错误类型: ${errorType}`,
          `执行错误信息: ${errorMessage}`,
          `修复轮次: ${attempt}`,
          '',
          '原代码：',
          '```javascript',
          code,
          '```',
          '',
          '请只返回一个 ```javascript``` 代码块（不要输出其他解释）。'
        ].join('\n')
      }

      const tryFixInvalidRegexNothingToRepeat = (
        code: string,
        message: string
      ): { changed: boolean; code: string; note: string } => {
        try {
          const msg = String(message || '')
          if (!/Invalid regular expression/i.test(msg)) return { changed: false, code, note: '' }
          if (!/Nothing to repeat/i.test(msg)) return { changed: false, code, note: '' }

          // Example message:
          //   SyntaxError: Invalid regular expression: /^(?:√|*|对|错|正确|错误)$/: Nothing to repeat
          const m = msg.match(/Invalid regular expression:\s*(\/[\s\S]*?\/[gimsuy]*)\s*:/i)
          const lit = m && m[1] ? String(m[1]) : ''
          if (!lit) return { changed: false, code, note: '' }

          const escapeBareAsteriskAlternative = (s: string): string => {
            let out = String(s || '')
            // Standalone `*` as an alternative is invalid in JS regex: `(?:a|*|b)`.
            out = out.replace(/\|\*\|/g, '|\\*|')
            out = out.replace(/\(\?:\*\|/g, '(?:\\*|')
            out = out.replace(/\|\*\)/g, '|\\*)')
            out = out.replace(/\|\*\$/g, '|\\*$')
            out = out.replace(/^\*\|/g, '\\*|')
            out = out.replace(/\|\*$/g, '|\\*')
            return out
          }

          let next = String(code || '')
          let changed = false

          const litFixed = escapeBareAsteriskAlternative(lit)
          if (litFixed !== lit && next.includes(lit)) {
            next = next.split(lit).join(litFixed)
            changed = true
          }

          // If the regex came from RegExp('pattern') or new RegExp("pattern"),
          // patch the exact pattern string too (needs double backslash in source).
          try {
            const lastSlash = lit.lastIndexOf('/')
            if (lastSlash > 1) {
              const inner = lit.slice(1, lastSlash)
              const fixedInner = escapeBareAsteriskAlternative(inner)
              if (fixedInner !== inner) {
                const fixedInnerForString = fixedInner.replace(/\\/g, '\\\\')
                const s1 = `'${inner}'`
                const s1b = `'${fixedInnerForString}'`
                const s2 = `"${inner}"`
                const s2b = `"${fixedInnerForString}"`

                if (next.includes(s1)) {
                  next = next.split(s1).join(s1b)
                  changed = true
                }
                if (next.includes(s2)) {
                  next = next.split(s2).join(s2b)
                  changed = true
                }
              }
            }
          } catch (e) {
            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
          }

          if (!changed) return { changed: false, code, note: '' }
          return { changed: true, code: next, note: 'escaped standalone `*` in regex alternation (Nothing to repeat)' }
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
          return { changed: false, code, note: '' }
        }
      }

      for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
        const result = await withTimeout(
          jsMacroExecutor.executeJS(currentCode, autoConfirm),
          MAX_EXECUTE_MS,
          'WPS JS macro execution'
        ).catch((e) => ({
          success: false,
          message: e instanceof Error ? e.message : String(e),
          debugInfo: { timeout: true }
        }))
        lastResult = result

        if (result && result.success) {
          const msg = repaired
            ? `JS 宏已自动修复并执行成功（第 ${attempt} 次尝试）`
            : (result.message || 'JS 宏代码执行成功')
          return {
            ...result,
            message: msg,
            debugInfo: {
              ...(result.debugInfo || {}),
              repaired,
              attempts: attempt,
              finalCode: currentCode,
              repairSteps
            }
          }
        }

        let execResult: any = result
        let errorMsg = execResult?.message || 'JS 宏执行失败'
        let errorType = this._extractErrorType(errorMsg)
        let errorCode = this._extractErrorCode(currentCode)

        // Deterministic quick-fix: some LLMs produce invalid regex alternations like `(?:a|*|b)`,
        // which fails with "Invalid regular expression ... Nothing to repeat". Try escaping `*`
        // locally before entering expensive backend repair loops.
        try {
          const fx = tryFixInvalidRegexNothingToRepeat(currentCode, errorMsg)
          if (fx.changed) {
            const fixedCode = ensureAnchor(ensureBlockId(fx.code, targetBlockId), targetAnchor)
            if (fixedCode.trim() !== currentCode.trim()) {
              repaired = true
              currentCode = fixedCode
              try { logToBackend?.(`[JSMacro] applied deterministic regex fix: ${fx.note}`, 'warning') } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e) }
              if (onVibeStep) {
                pushStep({
                  type: 'deterministic_fix',
                  title: '本地语法修复：正则表达式',
                  content: fx.note,
                  timestamp: Date.now(),
                  status: 'completed'
                })
              }

              const retry = await withTimeout(
                jsMacroExecutor.executeJS(currentCode, autoConfirm),
                MAX_EXECUTE_MS,
                'WPS JS macro execution'
              ).catch((e) => ({
                success: false,
                message: e instanceof Error ? e.message : String(e),
                debugInfo: { timeout: true, deterministicFix: true }
              }))
              lastResult = retry

              if (retry && retry.success) {
                const msg = `JS 宏已自动修复并执行成功（本地正则修复；第 ${attempt} 次尝试）`
                return {
                  ...retry,
                  message: msg,
                  debugInfo: {
                    ...(retry.debugInfo || {}),
                    repaired: true,
                    attempts: attempt,
                    finalCode: currentCode,
                    repairSteps
                  }
                }
              }

              // Continue normal repair loop with the fixed code + latest error.
              execResult = retry
              errorMsg = execResult?.message || errorMsg
              errorType = this._extractErrorType(errorMsg)
              errorCode = this._extractErrorCode(currentCode)
            }
          }
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
        }
        try {
          const dbg: any = execResult?.debugInfo || {}
          const isSyntax = errorType === 'javascript_syntax_error' || /Invalid or unexpected token/i.test(errorMsg)
          const hasSuspiciousChars = Array.isArray(dbg?.suspiciousChars) && dbg.suspiciousChars.length > 0
          if (!verboseMacroDebug && (isSyntax || hasSuspiciousChars)) {
            enableVerboseMacroDebug(`${errorType}: ${String(errorMsg).slice(0, 160)}`, dbg)
          }
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
        }

        // Provide compact deterministic hints to the repair endpoint to improve first-try success
        // (without dumping full stack traces or huge payloads).
        const errorMsgForRepair = (() => {
          try {
            const dbg: any = execResult?.debugInfo || {}
            const notes = Array.isArray(dbg?.normalizeNotes) ? dbg.normalizeNotes.map((x: any) => String(x || '')).filter(Boolean) : []
            const suspicious = Array.isArray(dbg?.suspiciousChars) ? dbg.suspiciousChars : []
            const suspiciousWrapped = Array.isArray(dbg?.suspiciousCharsWrapped) ? dbg.suspiciousCharsWrapped : []
            const parts: string[] = []
            if (notes.length > 0) {
              parts.push(`normalizeNotes: ${notes.slice(0, 6).join(', ')}`)
            }
            if (suspicious.length > 0) {
              const sc = suspicious
                .slice(0, 6)
                .map((c: any) => `${String(c?.ch || '')}(${String(c?.codePoint || '')})@${String(c?.index ?? '')}`)
                .join(', ')
              parts.push(`suspiciousChars: ${sc}`)
            }
            if (suspiciousWrapped.length > 0) {
              const scw = suspiciousWrapped
                .slice(0, 6)
                .map((c: any) => `${String(c?.ch || '')}(${String(c?.codePoint || '')})@${String(c?.index ?? '')}`)
                .join(', ')
              parts.push(`suspiciousCharsWrapped: ${scw}`)
            }
            if (!parts.length) return errorMsg
            return `${errorMsg}\n\n[frontend_hint]\n${parts.join('\n')}`.slice(0, 2200)
          } catch (e) {
            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
            return errorMsg
          }
        })()

        // Always report failure for learning/diagnostics (include frontend hints when available).
        this.reportJSMacroError(
          errorType,
          errorMsgForRepair,
          errorCode,
          '',
          `JS宏执行失败 attempt=${attempt}`,
          'medium',
          {
            macro_attempt: attempt,
            macro_host: hostApp,
            macro_debug: execResult?.debugInfo,
            current_code_len: typeof currentCode === 'string' ? currentCode.length : undefined,
          }
        ).catch((e: any) => {
          // Best-effort: reporting failures should be visible to developers.
          try {
            logToBackend?.(`[WPSBridge] reportJSMacroError failed: ${String(e?.message || e)}`, 'warning')
          } catch (e) {
            try { console.warn('[WPSBridge] reportJSMacroError failed', e) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e) }
          }
        })

        if (attempt >= MAX_REPAIR_ATTEMPTS || !shouldAutoRepair(errorType, errorMsg)) {
          break
        }

        repaired = true
        logToBackend?.(`[JSMacro] 执行失败，开始自动修复 attempt=${attempt}: ${errorMsg}`, 'warning')

        let nextCode = ''

        if (onVibeStep) {
          // Visual mode: prefer the fast repair endpoint and synthesize visible steps locally.
          pushStep({
            type: 'repair_start',
            title: `自动修复（快路径）#${attempt}`,
            content: `错误类型: ${errorType}\n错误信息: ${errorMsgForRepair}`.slice(0, 2000),
            timestamp: Date.now(),
            status: 'processing'
          })
          pushStep({
            type: 'repair_call',
            title: '调用 /agentic/js-macro/repair',
            content: '向后端请求最小改动的 JS 修复（单次调用）。',
            timestamp: Date.now(),
            status: 'processing'
          })

          const repair = await jsMacroExecutor.repairCode(currentCode, errorType, errorMsgForRepair, attempt)
          nextCode = repair?.code || ''

          if (repair?.success && nextCode && nextCode.trim()) {
            pushStep({
              type: 'repair_result',
              title: '收到修复结果',
              content: `已返回修复后代码（长度: ${String(nextCode || '').length}）。`,
              timestamp: Date.now(),
              status: 'completed'
            })
            pushStep({
              type: 'repair_reexecute',
              title: '重新执行修复后代码',
              content: '开始重试执行…',
              timestamp: Date.now(),
              status: 'processing'
            })
          } else {
            // Make "Failed to fetch" actionable during dev testing (usually backend not reachable / CORS / timeout).
            let repairErr = repair?.error ? String(repair.error) : '后端未返回可用修复结果。'
            try {
              if (/Failed to fetch/i.test(repairErr) || /NetworkError/i.test(repairErr)) {
                const mod: any = await import('@/utils/runtime-config')
                const cfg = typeof mod?.getRuntimeConfig === 'function' ? mod.getRuntimeConfig() : null
                if (cfg?.apiBase) {
                  repairErr = `${repairErr}\n(apiBase=${String(cfg.apiBase)})`
                }
              }
            } catch (e) {
              ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
            }
            pushStep({
              type: 'repair_failed',
              title: '快路径修复失败',
              content: repairErr,
              timestamp: Date.now(),
              status: 'error'
            })

            // Fallback: try the full workflow stream to recover (slower, but more robust).
            pushStep({
              type: 'repair_fallback',
              title: '切换到全量修复链路',
              content: '快路径失败，尝试 VibeCoding 全量修复（更慢，但更强）。',
              timestamp: Date.now(),
              status: 'processing'
            })

            const repairQuery = buildRepairQuery(currentCode, errorType, errorMsgForRepair, attempt)
            const full = await jsMacroExecutor.generateCodeWithVibeCoding(repairQuery, (step: any) => {
              pushStep(step)
              const content = (step?.content || '').replace(/\r?\n/g, ' ')
              debugLog(`[VibeCoding] ${step?.type || 'step'}: ${content}`)
            })
            nextCode = full?.code || ''
          }
        } else {
          // Fast path: a single LLM call on the backend, much quicker than the full workflow.
          const repair = await jsMacroExecutor.repairCode(currentCode, errorType, errorMsgForRepair, attempt)
          nextCode = repair?.code || ''
          if (!repair?.success && repair?.error) {
            logToBackend?.(`[JSMacro] 自动修复失败：${repair.error}`, 'warning')
          }
        }

        if (!nextCode || !nextCode.trim()) {
          logToBackend?.('[JSMacro] 自动修复失败：后端未返回可用代码', 'error')
          break
        }

        // Preserve blockId + anchor across repair attempts (avoid losing writeback placement).
        nextCode = ensureAnchor(ensureBlockId(nextCode, targetBlockId), targetAnchor)
        if (nextCode.trim() === currentCode.trim()) {
          logToBackend?.('[JSMacro] 自动修复失败：返回代码与原代码一致，停止重试', 'warning')
          break
        }
        currentCode = nextCode
      }

      // Failed after auto-repair attempts
      const finalMsg = lastResult?.message || 'JS 宏执行失败'
      return {
        success: false,
        message: repaired
          ? `❌ JS 宏自动修复后仍执行失败（已尝试 ${MAX_REPAIR_ATTEMPTS} 次）\n\n最后错误：${finalMsg}`
          : finalMsg,
        debugInfo: {
          ...(lastResult?.debugInfo || {}),
          repaired,
          attempts: MAX_REPAIR_ATTEMPTS,
          finalCode: currentCode,
          repairSteps
        }
      }
    } catch (error) {
      return {
        success: false,
        message: '⚠️ JS 宏执行器不可用\n\n请检查：\n1. 是否在 WPS 环境中运行\n2. 插件是否正确加载\n3. 尝试重新打开任务窗格'
      }
    }
  }

  /**
   * 提取错误类型
   */
  private _extractErrorType(message: string): string {
    if (message.includes('app.Alert')) return 'wps_api_error'
    if (message.includes('ReferenceError')) return 'javascript_reference_error'
    if (message.includes('TypeError')) return 'javascript_type_error'
    if (message.includes('SyntaxError')) return 'javascript_syntax_error'
    if (message.includes('Unexpected token')) return 'javascript_syntax_error'
    if (message.includes('RangeError') || message.includes('Maximum call stack')) return 'javascript_range_error'
    if (message.includes('未定义')) return 'undefined_variable'
    if (message.includes('权限')) return 'permission_error'
    return 'execution_error'
  }

  /**
   * 提取错误代码片段
   */
  private _extractErrorCode(jsCode: string): string {
    // 返回前200个字符作为错误代码片段
    return jsCode.length > 200 ? jsCode.substring(0, 200) + '...' : jsCode
  }

  /**
   * 注册文档变化监听器
   */
  addDocumentChangeListener(callback: (docs: WPSDocumentInfo[]) => void | Promise<void>): () => void {
    this.documentChangeCallbacks.push(callback)

    // 返回取消监听的函数
    return () => {
      const index = this.documentChangeCallbacks.indexOf(callback)
      if (index > -1) {
        this.documentChangeCallbacks.splice(index, 1)
      }
    }
  }

  /**
   * 初始化文档事件监听
   *
   * WPS JSAPI 在不同版本/宿主上“原生事件”能力不稳定，因此这里采用一个轻量、可控的文档观察器：
   * - 定时读取当前打开文档列表 + active 标记
   * - 发生变化时触发回调（DocumentList / Chat 自动切桶依赖这个）
   *
   * 这不是“兜底”，而是我们统一的文档变化信号源。
   */
  async initDocumentEventListeners(): Promise<boolean> {
    try {
      if (!this.isInWPSEnvironment()) {
        return false
      }

      if (this.docWatchTimer || this.docWatchTickInFlight) {
        return true
      }

      this.docWatchErrorStreak = 0
      this.docWatchTickPending = false
      this.docWatchDelayMs = this._getDocWatchBaseDelayMs()

      this._runDocumentWatcherTick(true)

      // Also listen to messages from ribbon/taskpane helpers to trigger an immediate tick.
      this.listenToPluginEvents()

      console.log('[WPSBridge] ✅ 文档观察器已启动')
      return true
    } catch (e) {
      console.warn('[WPSBridge] 初始化文档观察器失败:', e)
      return false
    }
  }

  /**
   * 延迟函数
   */
  private _delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * 检查事件监听是否已初始化
   */
  isEventDriven(): boolean {
    return !!this.docWatchTimer || this.docWatchTickInFlight
  }

  /**
   * 获取当前使用的机制类型
   */
  getDetectionMechanism(): 'event' | 'manual' {
    return this.isEventDriven() ? 'event' : 'manual'
  }

  /**
   * 监听WPS插件事件通知
   * - 来自 ribbon.js 的 postMessage / PluginStorage “刷新命令”
   * - 用于加速同步，不依赖用户手动点击
   */
  listenToPluginEvents(): void {
    if (this.isEventListenersAdded) return
    this.isEventListenersAdded = true

    try {
      window.addEventListener('message', (event: any) => {
        try {
          let data = event?.data
          if (typeof data === 'string') {
            try { data = JSON.parse(data) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e) }
          }
          const type = data?.type
          if (type === 'WPSDocumentChange' || type === 'RefreshDocumentList') {
            this._queueDocumentWatcherTick(true, 0)
          }
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
        }
      })
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
    }
  }

  private _getDocWatchBaseDelayMs(): number {
    try {
      const envRaw = Number((import.meta as any)?.env?.VITE_DOC_WATCH_INTERVAL_MS)
      const fallback = 1000
      const raw = Number.isFinite(envRaw) && envRaw > 0 ? envRaw : fallback
      return Math.min(6000, Math.max(600, Math.round(raw)))
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
      return 1000
    }
  }

  private _queueDocumentWatcherTick(force: boolean, delayMs?: number) {
    const delay = Number.isFinite(Number(delayMs))
      ? Math.max(0, Number(delayMs))
      : Math.max(0, this.docWatchDelayMs)
    try {
      if (this.docWatchTimer) {
        clearTimeout(this.docWatchTimer)
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
    }
    this.docWatchTimer = setTimeout(() => {
      this.docWatchTimer = null
      this._runDocumentWatcherTick(force)
    }, delay)
  }

  private _runDocumentWatcherTick(force: boolean) {
    if (this.docWatchTickInFlight) {
      if (force) {
        this.docWatchTickPending = true
      }
      return
    }

    this.docWatchTickInFlight = true
    const forceThisTick = force || this.docWatchTickPending
    this.docWatchTickPending = false

    let ok = false
    try {
      ok = this._tickDocumentWatcher(forceThisTick)
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
      ok = false
    } finally {
      this.docWatchTickInFlight = false
    }

    const baseDelay = this._getDocWatchBaseDelayMs()
    if (ok) {
      this.docWatchErrorStreak = 0
      this.docWatchDelayMs = baseDelay
    } else {
      this.docWatchErrorStreak += 1
      const pow = Math.min(4, this.docWatchErrorStreak)
      this.docWatchDelayMs = Math.min(12000, Math.max(baseDelay, baseDelay * Math.pow(2, pow)))
      if (this.docWatchErrorStreak === 3 || this.docWatchErrorStreak === 6) {
        try {
          logToBackend(
            `[WPSBridge] document watcher backoff: streak=${this.docWatchErrorStreak} next_ms=${this.docWatchDelayMs}`,
            'warning'
          )
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
        }
      }
    }

    if (this.docWatchTickPending) {
      this.docWatchTickPending = false
      this._queueDocumentWatcherTick(true, 0)
      return
    }

    this._queueDocumentWatcherTick(false, this.docWatchDelayMs)
  }

  private _snapshotDocs(docs: WPSDocumentInfo[]): string {
    try {
      const stableKey = (d: WPSDocumentInfo) => {
        const h = String(d.hostApp || '')
        const p = String(d.fullPath || '')
        const id = String(d.id || '')
        const n = String(d.name || '')
        return `${h}|${p}|${id}|${n}`
      }

      const parts = docs
        .slice()
        .sort((a, b) => stableKey(a).localeCompare(stableKey(b)))
        .map(d => {
        const id = String(d.id || '')
        const p = String(d.fullPath || '')
        const a = d.isActive ? '1' : '0'
        const h = String(d.hostApp || '')
        return `${h}|${id}|${p}|${a}`
      })
      return parts.join(';;')
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
      return String(Date.now())
    }
  }

  private _tickDocumentWatcher(force: boolean): boolean {
    try {
      if (!this.isInWPSEnvironment()) return true
      // The watcher is high-frequency by design; avoid expensive per-document stats here.
      const docs = this.getAllOpenDocuments({ includeStats: false })
      const snap = this._snapshotDocs(docs)
      if (!force && snap === this.lastDocSnapshot) return true
      this.lastDocSnapshot = snap
      this.lastDocs = docs
      for (const cb of this.documentChangeCallbacks) {
        try {
          Promise.resolve(cb(docs)).catch((e) => {
            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
          })
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
        }
      }
      return true
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
      return false
    }
  }

}

// 创建全局实例
export const wpsBridge = new WPSDocumentBridge()

// 动态导入 JS 宏执行器（在需要时）
let _jsMacroExecutor: any = null

export async function getJSMacroExecutor() {
  if (!_jsMacroExecutor) {
    try {
      const module = await import('./js-macro-executor')
      _jsMacroExecutor = module.jsMacroExecutor
    } catch (e) {
      console.error('加载 JS 宏执行器失败:', e)
    }
  }
  return _jsMacroExecutor
}

// Deterministic Plan executor (loaded on demand).
let _planExecutor: any = null
let _planExecutorLoadError: string | null = null

export async function getPlanExecutor() {
  if (!_planExecutor) {
    try {
      const module = await import('./plan-executor')
      _planExecutor = module.planExecutor
      _planExecutorLoadError = null
    } catch (e) {
      console.error('加载 Plan 执行器失败:', e)
      _planExecutorLoadError = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
      try {
        ;(globalThis as any).__ah32_logToBackend?.(
          `[WPSBridge] load plan-executor failed: ${String(_planExecutorLoadError || '').slice(0, 800)}`,
          'error'
        )
      } catch (e2) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e2)
      }
    }
  }
  return _planExecutor
}

// 导出便捷方法
export const WPSHelper = {
  _planHasOp(plan: any, op: string): boolean {
    try {
      const want = String(op || '').trim()
      if (!want) return false

      const obj = typeof plan === 'string' ? JSON.parse(String(plan || '').trim()) : plan
      const actions = (obj as any)?.actions
      if (!Array.isArray(actions)) return false

      const walk = (xs: any[]): boolean => {
        for (const a of xs || []) {
          if (!a || typeof a !== 'object') continue
          if (String((a as any).op || '').trim() === want) return true
          const nested = (a as any).actions
          if (Array.isArray(nested) && walk(nested)) return true
        }
        return false
      }

      return walk(actions)
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
      return false
    }
  },

  checkEnvironment(): boolean {
    return wpsBridge.isInWPSEnvironment()
  },

  getVersion(): string | null {
    try {
      if (wpsBridge.isInWPSEnvironment()) {
        return wpsBridge.getApplication()?.Version || null
      }
      return null
    } catch (error) {
      console.error('获取版本信息失败:', error)
      return null
    }
  },

  // 多文档便捷方法
  getAllDocuments(): WPSDocumentInfo[] {
    return wpsBridge.getAllOpenDocuments()
  },

  // Backward-compatible alias: "target" == "activate" (UI no longer exposes target/reference).
  async activate(docId: string): Promise<boolean> {
    return wpsBridge.activateDocumentById(docId)
  },

  writeToTarget(content: string, options?: WriteOptions): void {
    wpsBridge.writeToTarget(content, options)
  },

  insertImageToTarget(imagePath: string, width?: number, height?: number): void {
    wpsBridge.insertImageToTarget(imagePath, width, height)
  },

  // JS 宏执行便捷方法
  async executeJSMacro(
    jsCode: string,
    autoConfirm: boolean = true,
    onVibeStep?: (step: any) => void
  ): Promise<{
    success: boolean
    message: string
    debugInfo?: any
  }> {
    return wpsBridge.executeJSMacro(jsCode, autoConfirm, onVibeStep)
  },

  async executePlan(plan: any, onStep?: (step: any) => void): Promise<{
    success: boolean
    message: string
    steps?: any[]
    debugInfo?: any
  }> {
    try {
      // Some plan ops (e.g. answer_mode_apply) delegate to BID helper functions implemented
      // in the JS macro runtime. Preload it only when required.
      if (WPSHelper._planHasOp(plan, 'answer_mode_apply')) {
        await getJSMacroExecutor()
      }
    } catch (e) {
      console.error('预加载宏运行时失败:', e)
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/wps-bridge.ts', e)
    }
    const executor = await getPlanExecutor()
    if (!executor) {
      return {
        success: false,
        message: 'Plan executor not available',
        debugInfo: _planExecutorLoadError ? { loadError: _planExecutorLoadError } : undefined
      }
    }
    return wpsBridge.runWithWpsApi(
      'executePlan',
      () => executor.executePlan(plan, onStep),
      { success: false, message: 'executePlan failed (WPS API not available)' }
    )
  },

  // 错误报告便捷方法
  async reportError(errorType: string, errorMessage: string, errorCode: string = '', correctionSuggestion: string = '', userContext: string = '', severity: string = 'medium', extra?: Record<string, any>): Promise<void> {
    return wpsBridge.reportJSMacroError(errorType, errorMessage, errorCode, correctionSuggestion, userContext, severity, extra)
  },

  isJSMacroCode(content: string): boolean {
    const trimmed = content.trim()
    return (
      trimmed.includes('function ') ||
      trimmed.includes('=>') ||
      /function\s+\w+\s*\(/.test(trimmed) ||
      /app\.ActiveDocument/.test(trimmed) ||
      /selection\./.test(trimmed)
    )
  }
}
