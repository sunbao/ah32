import { getRuntimeConfig } from '@/utils/runtime-config'
import { getClientId } from '@/utils/client-id'
import { patchReloadDiag } from '@/utils/reload-diag'
import { wpsBridge } from './wps-bridge'

type HostApp = 'wps' | 'et' | 'wpp' | 'unknown'

type DocSnapshotInitResponse = {
  snapshot_id?: string
  export?: { required?: boolean; target_ext?: string | null; notes?: string | null }
}

type DocSnapshotFinalizeResponse = {
  ready?: boolean
  parts?: Record<string, any>
}

const _docSnapshotReportAtByKey = new Map<string, number>()
const REPORT_TTL_MS = 30_000
const _docSnapshotNotifyAtByKey = new Map<string, number>()
const NOTIFY_TTL_MS = 30_000

const reportOnce = (key: string, message: string) => {
  try {
    const now = Date.now()
    const last = _docSnapshotReportAtByKey.get(key) || 0
    if (now - last < REPORT_TTL_MS) return
    _docSnapshotReportAtByKey.set(key, now)
    const fn = (globalThis as any).__ah32_logToBackend as ((msg: string, level?: any) => void) | undefined
    if (typeof fn === 'function') fn(`[doc_snapshot] ${message}`.slice(0, 1800), 'warning')
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/doc-snapshot.ts', e)
  }
}

const notifyOnce = (
  key: string,
  payload: { type: 'warning' | 'error' | 'info'; title: string; message: string; durationMs?: number }
) => {
  try {
    const now = Date.now()
    const last = _docSnapshotNotifyAtByKey.get(key) || 0
    if (now - last < NOTIFY_TTL_MS) return
    _docSnapshotNotifyAtByKey.set(key, now)
    const fn = (globalThis as any).__ah32_notify as ((p: any) => void) | undefined
    if (typeof fn === 'function') fn({ ...payload, durationMs: payload.durationMs ?? 10_000 })
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/doc-snapshot.ts', e)
  }
}

const normalizeHost = (raw: any): HostApp => {
  const s = String(raw || '').trim().toLowerCase()
  return s === 'wps' || s === 'et' || s === 'wpp' ? (s as HostApp) : 'unknown'
}

export async function ensureDocSnapshotForChat(opts: {
  frontendContext: any
  signal?: AbortSignal
}): Promise<{ snapshotId: string | null; meta: any }> {
  const fc = opts?.frontendContext && typeof opts.frontendContext === 'object' ? opts.frontendContext : null
  const key = 'ensureDocSnapshotForChat'
  const startedAt = Date.now()
  const startedAtIso = new Date().toISOString()

  try {
    try {
      patchReloadDiag({
        lastDocSnapshotAttemptAt: startedAtIso,
        inflight_doc_snapshot: { at: startedAtIso, stage: 'start' },
      })
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/doc-snapshot.ts', e)
    }

    if (!fc) {
      notifyOnce(`${key}:missing_frontend_context`, {
        type: 'warning',
        title: '没拿到文档上下文',
        message: '本轮对话没有带上文档信息（可能是前端上下文缺失）。这轮我只能按聊天内容回答，无法读取你正在编辑的文档。',
      })
      try {
        patchReloadDiag({
          inflight_doc_snapshot: null,
          lastDocSnapshotOk: false,
          lastDocSnapshotReason: 'missing_frontend_context',
          lastDocSnapshotEndAt: new Date().toISOString(),
        })
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/doc-snapshot.ts', e)
      }
      return { snapshotId: null, meta: { ok: false, reason: 'missing_frontend_context' } }
    }

    const docs: any[] = Array.isArray(fc.documents) ? fc.documents : []
    const active =
      docs.find((d) => d && typeof d === 'object' && !!(d as any).isActive) ||
      (fc as any).activeDocument ||
      (fc as any).active_document ||
      null
    const hostApp: HostApp = normalizeHost(fc.host_app || active?.hostApp || active?.host_app)
    const clientId = (() => {
      try {
        return getClientId()
      } catch (_e) {
        return ''
      }
    })()

    if (!active) {
      notifyOnce(`${key}:no_active_document`, {
        type: 'warning',
        title: '没有找到当前文档',
        message: '我没找到“当前正在编辑的文档”。请先在 WPS 里打开/切到需要处理的文档，再发起对话。',
      })
      try {
        patchReloadDiag({
          inflight_doc_snapshot: null,
          lastDocSnapshotOk: false,
          lastDocSnapshotReason: 'no_active_document',
          lastDocSnapshotEndAt: new Date().toISOString(),
        })
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/doc-snapshot.ts', e)
      }
      return { snapshotId: null, meta: { ok: false, reason: 'no_active_document' } }
    }

    const docId = String(active?.id || active?.doc_id || active?.docId || active?.name || 'active').trim()
    const docName = String(active?.name || active?.doc_name || active?.docName || '').trim() || null
    if (!docId) {
      notifyOnce(`${key}:missing_doc_id`, {
        type: 'warning',
        title: '文档标识缺失',
        message: '当前文档没有拿到稳定的 doc_id。这轮我无法上传文档快照，只能按聊天内容回答。',
      })
      try {
        patchReloadDiag({
          inflight_doc_snapshot: null,
          lastDocSnapshotOk: false,
          lastDocSnapshotReason: 'missing_doc_id',
          lastDocSnapshotEndAt: new Date().toISOString(),
        })
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/doc-snapshot.ts', e)
      }
      return { snapshotId: null, meta: { ok: false, reason: 'missing_doc_id' } }
    }

    const targetExt = hostApp === 'wps' ? 'docx' : hostApp === 'et' ? 'xlsx' : hostApp === 'wpp' ? 'pptx' : null
    const targetMime =
      hostApp === 'wps'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : hostApp === 'et'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : hostApp === 'wpp'
            ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
            : 'application/octet-stream'

    // Best-effort: if the active document is already a saved OOXML file, upload bytes in addition to extracted_text.
    const localPath =
      String(
        active?.fullPath ||
          active?.full_path ||
          active?.path ||
          active?.document_path ||
          active?.fullName ||
          active?.full_name ||
          ''
      ).trim() || ''
    let ooxmlBuf: ArrayBuffer | null = null
    let ooxmlName: string | null = null
    try {
      if (targetExt && localPath && localPath.toLowerCase().endsWith(`.${targetExt}`)) {
        const buf = wpsBridge.readLocalFileAsArrayBuffer(localPath, { maxBytes: 60_000_000 })
        if (buf && buf.byteLength > 0) {
          ooxmlBuf = buf
          const base = localPath.split(/[/\\]+/g).filter((x) => !!x).pop() || ''
          ooxmlName = base || (docName ? `${docName}.${targetExt}` : `${docId}.${targetExt}`)
        }
      }
    } catch (e) {
      ooxmlBuf = null
      ooxmlName = null
      reportOnce(key, `read OOXML bytes failed host=${hostApp}: ${String((e as any)?.message || e)}`)
    }

    // Extract bounded text (fallback when OOXML export is not implemented yet).
    // Ensure the bridge refreshes its live-object index so docId matching is stable.
    try {
      wpsBridge.getAllOpenDocuments({ includeStats: false } as any)
    } catch (_e) {
      // ignore
    }
    let extractedText = ''
    try {
      const maxChars = hostApp === 'wps' ? 400_000 : hostApp === 'et' ? 260_000 : 260_000
      extractedText = String(wpsBridge.extractDocumentTextById(docId, { maxChars }) || '')
      if (!extractedText.trim()) extractedText = ''
    } catch (e) {
      extractedText = ''
      reportOnce(key, `extract failed host=${hostApp}: ${String((e as any)?.message || e)}`)
    }

    if (!extractedText && !ooxmlBuf) {
      reportOnce(key, `no extracted_text and no ooxml_bytes host=${hostApp} doc_id=${docId}`)
      notifyOnce(`${key}:missing_doc_context:${hostApp}`, {
        type: 'warning',
        title: '文档没传过去（读不到内容）',
        message:
          '我这轮读不到文档内容，所以没法把“文档快照”传给后端。这轮对话会继续，但只能按你聊天输入回答。\n' +
          '你可以先把文档另存为 .docx/.xlsx/.pptx（或确保文档不是空白），再重试一次。',
        durationMs: 14_000,
      })
      try {
        patchReloadDiag({
          inflight_doc_snapshot: null,
          lastDocSnapshotOk: false,
          lastDocSnapshotReason: 'missing_doc_context',
          lastDocSnapshotHostApp: hostApp,
          lastDocSnapshotDocId: docId,
          lastDocSnapshotEndAt: new Date().toISOString(),
        })
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/doc-snapshot.ts', e)
      }
      return { snapshotId: null, meta: { ok: false, reason: 'missing_doc_context', host_app: hostApp } }
    }

    const cfg = getRuntimeConfig()
    try {
      patchReloadDiag({
        inflight_doc_snapshot: {
          at: startedAtIso,
          stage: 'init',
          host_app: hostApp,
          doc_id: docId,
          doc_name: docName,
          extracted_text_chars: extractedText ? extractedText.length : 0,
          ooxml_bytes: ooxmlBuf ? ooxmlBuf.byteLength : 0,
        },
      })
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/doc-snapshot.ts', e)
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (cfg.apiKey) headers['X-API-Key'] = cfg.apiKey
    if (cfg.tenantId) headers['X-AH32-Tenant-Id'] = cfg.tenantId
    if (cfg.accessToken) headers['Authorization'] = `Bearer ${cfg.accessToken}`
    if (clientId) headers['X-AH32-User-Id'] = clientId
    if (clientId) headers['X-AH32-Client-Id'] = clientId

    const initResp = await fetch(`${cfg.apiBase}/agentic/doc-snapshots/init`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        client_id: clientId || 'default',
        host_app: hostApp,
        doc_id: docId,
        doc_name: docName,
        replace_previous: true,
        source: { mode: 'http_upload_bytes' },
      }),
      signal: opts?.signal,
    })
    if (!initResp.ok) {
      reportOnce(key, `init failed status=${initResp.status}`)
      notifyOnce(`${key}:init_failed:${initResp.status}`, {
        type: 'warning',
        title: '文档快照初始化失败',
        message: `后端没能创建文档快照（HTTP ${initResp.status}）。这轮对话会继续，但后端读不到你的文档。\n建议检查后端是否启动、网络是否通、tenant/user 配置是否正确，然后重试。`,
        durationMs: 14_000,
      })
      try {
        patchReloadDiag({
          inflight_doc_snapshot: null,
          lastDocSnapshotOk: false,
          lastDocSnapshotReason: 'init_failed',
          lastDocSnapshotStatus: initResp.status,
          lastDocSnapshotElapsedMs: Date.now() - startedAt,
          lastDocSnapshotEndAt: new Date().toISOString(),
        })
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/doc-snapshot.ts', e)
      }
      return { snapshotId: null, meta: { ok: false, reason: 'init_failed', status: initResp.status } }
    }

    const init = (await initResp.json()) as DocSnapshotInitResponse
    const snapshotId = String(init?.snapshot_id || '').trim()
    if (!snapshotId) {
      reportOnce(key, 'init returned empty snapshot_id')
      notifyOnce(`${key}:missing_snapshot_id`, {
        type: 'warning',
        title: '文档快照创建异常',
        message: '后端返回了空的 snapshot_id。这轮对话会继续，但后端读不到你的文档。建议重试一次，或把后端日志里的 trace_id 发给开发排查。',
        durationMs: 14_000,
      })
      try {
        patchReloadDiag({
          inflight_doc_snapshot: null,
          lastDocSnapshotOk: false,
          lastDocSnapshotReason: 'missing_snapshot_id',
          lastDocSnapshotElapsedMs: Date.now() - startedAt,
          lastDocSnapshotEndAt: new Date().toISOString(),
        })
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/doc-snapshot.ts', e)
      }
      return { snapshotId: null, meta: { ok: false, reason: 'missing_snapshot_id' } }
    }

    try {
      patchReloadDiag({
        inflight_doc_snapshot: {
          at: startedAtIso,
          stage: 'upload',
          host_app: hostApp,
          doc_id: docId,
          snapshot_id: snapshotId,
          extracted_text_chars: extractedText ? extractedText.length : 0,
          ooxml_bytes: ooxmlBuf ? ooxmlBuf.byteLength : 0,
        },
      })
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/doc-snapshot.ts', e)
    }

    const uploadHeaders: Record<string, string> = {}
    if (cfg.apiKey) uploadHeaders['X-API-Key'] = cfg.apiKey
    if (cfg.tenantId) uploadHeaders['X-AH32-Tenant-Id'] = cfg.tenantId
    if (cfg.accessToken) uploadHeaders['Authorization'] = `Bearer ${cfg.accessToken}`
    if (clientId) uploadHeaders['X-AH32-User-Id'] = clientId
    if (clientId) uploadHeaders['X-AH32-Client-Id'] = clientId

    const manifest = {
      schema_version: 'ah32.doc_snapshot_manifest.v1',
      host_app: hostApp,
      client_id: clientId || 'default',
      doc_id: docId,
      doc_name: docName,
      extracted_text: { present: !!extractedText, max_chars: extractedText.length },
      ooxml: ooxmlBuf ? { present: true, bytes: ooxmlBuf.byteLength, filename: ooxmlName } : { present: false },
      export: init?.export || null,
      ts: new Date().toISOString(),
    }

    const form = new FormData()
    form.append('manifest', JSON.stringify(manifest))
    if (ooxmlBuf && targetExt) {
      try {
        const blob = new Blob([ooxmlBuf], { type: targetMime })
        form.append('doc_file', blob, ooxmlName || (docName ? `${docName}.${targetExt}` : `${docId}.${targetExt}`))
      } catch (e) {
        reportOnce(key, `append doc_file failed: ${String((e as any)?.message || e)}`)
      }
    } else if (init?.export?.required && init?.export?.target_ext) {
      const need = String(init.export.target_ext || '').trim().toLowerCase()
      const note = String(init.export.notes || '').trim()
      notifyOnce(`${key}:export_hint`, {
        type: 'warning',
        title: '建议另存为 OOXML',
        message: `远端后端需要上传原始文件（优先 .${need}）。当前无法直接读取本地文件（可能未保存或不是 .${need}）。\n当前先用“文本摘录”兜底，可能缺少图片/表格/格式。\n${note ? `说明：${note}` : ''}`.trim(),
        durationMs: 12_000,
      })
    }
    if (extractedText) form.append('extracted_text', extractedText)

    const uploadResp = await fetch(`${cfg.apiBase}/agentic/doc-snapshots/${encodeURIComponent(snapshotId)}/parts`, {
      method: 'PUT',
      headers: uploadHeaders,
      body: form,
      signal: opts?.signal,
    })
    if (!uploadResp.ok) {
      reportOnce(key, `upload failed status=${uploadResp.status}`)
      notifyOnce(`${key}:upload_failed:${uploadResp.status}`, {
        type: 'warning',
        title: '文档快照上传失败',
        message: `文档快照没上传成功（HTTP ${uploadResp.status}）。这轮对话会继续，但后端读不到你的文档。\n建议检查网络/后端，然后点重试。`,
        durationMs: 14_000,
      })
      try {
        patchReloadDiag({
          inflight_doc_snapshot: null,
          lastDocSnapshotOk: false,
          lastDocSnapshotReason: 'upload_failed',
          lastDocSnapshotStatus: uploadResp.status,
          lastDocSnapshotElapsedMs: Date.now() - startedAt,
          lastDocSnapshotEndAt: new Date().toISOString(),
        })
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/doc-snapshot.ts', e)
      }
      return { snapshotId: null, meta: { ok: false, reason: 'upload_failed', status: uploadResp.status } }
    }

    try {
      patchReloadDiag({
        inflight_doc_snapshot: {
          at: startedAtIso,
          stage: 'finalize',
          host_app: hostApp,
          doc_id: docId,
          snapshot_id: snapshotId,
        },
      })
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/doc-snapshot.ts', e)
    }

    const finalizeResp = await fetch(`${cfg.apiBase}/agentic/doc-snapshots/${encodeURIComponent(snapshotId)}/finalize`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
      signal: opts?.signal,
    })
    if (!finalizeResp.ok) {
      reportOnce(key, `finalize failed status=${finalizeResp.status}`)
      notifyOnce(`${key}:finalize_failed:${finalizeResp.status}`, {
        type: 'warning',
        title: '文档快照确认失败',
        message: `后端没能确认文档快照就绪（HTTP ${finalizeResp.status}）。这轮对话会继续，但后端可能读不到你的文档。\n建议重试一次。`,
        durationMs: 14_000,
      })
      try {
        patchReloadDiag({
          inflight_doc_snapshot: null,
          lastDocSnapshotOk: false,
          lastDocSnapshotReason: 'finalize_failed',
          lastDocSnapshotStatus: finalizeResp.status,
          lastDocSnapshotElapsedMs: Date.now() - startedAt,
          lastDocSnapshotEndAt: new Date().toISOString(),
        })
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/doc-snapshot.ts', e)
      }
      return { snapshotId: null, meta: { ok: false, reason: 'finalize_failed', status: finalizeResp.status } }
    }

    const fin = (await finalizeResp.json()) as DocSnapshotFinalizeResponse
    if (!fin || fin.ready === false) {
      // Backend may still treat extracted_text-only snapshots as usable; keep it permissive.
      reportOnce(key, `finalize not ready (best-effort) snapshot_id=${snapshotId}`)
    }

    const mode = ooxmlBuf ? (extractedText ? 'ooxml+extracted_text' : 'ooxml') : 'extracted_text'
    try {
      patchReloadDiag({
        inflight_doc_snapshot: null,
        lastDocSnapshotOk: true,
        lastDocSnapshotReason: 'ok',
        lastDocSnapshotElapsedMs: Date.now() - startedAt,
        lastDocSnapshotEndAt: new Date().toISOString(),
        lastDocSnapshotMeta: {
          host_app: hostApp,
          mode,
          extracted_text_chars: extractedText ? extractedText.length : 0,
          ooxml_bytes: ooxmlBuf ? ooxmlBuf.byteLength : 0,
        }
      })
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/doc-snapshot.ts', e)
    }
    return {
      snapshotId,
      meta: {
        ok: true,
        snapshot_id: snapshotId,
        host_app: hostApp,
        export: init?.export || null,
        mode,
        ooxml: ooxmlBuf ? { bytes: ooxmlBuf.byteLength, filename: ooxmlName } : null,
        extracted_text: extractedText ? { chars: extractedText.length } : null,
      },
    }
  } catch (e) {
    const msg = String((e as any)?.message || e)
    reportOnce(key, `error: ${msg}`)
    notifyOnce(`${key}:exception`, {
      type: 'warning',
      title: '文档快照出错',
      message: `文档快照流程出错：${msg}\n这轮对话会继续，但后端读不到你的文档。建议重试一次，并截图把 trace_id 发给开发排查。`,
      durationMs: 14_000,
    })
    try {
      patchReloadDiag({
        inflight_doc_snapshot: null,
        lastDocSnapshotOk: false,
        lastDocSnapshotReason: 'exception',
        lastDocSnapshotError: msg,
        lastDocSnapshotElapsedMs: Date.now() - startedAt,
        lastDocSnapshotEndAt: new Date().toISOString(),
      })
    } catch (e2) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/services/doc-snapshot.ts', e2)
    }
    return { snapshotId: null, meta: { ok: false, reason: 'exception', error: msg } }
  }
}
