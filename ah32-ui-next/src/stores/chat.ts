/**
 * 聊天状态管理
 */
import {defineStore} from 'pinia'
import { ref, watch, reactive, computed } from 'vue'
import {chatApi} from '@/services/api'
import type {Message} from '@/services/types'
import { wpsBridge, WPSHelper } from '@/services/wps-bridge'
import { planClient } from '@/services/plan-client'
import { macroCancel } from '@/services/macro-cancel'
import {detectAndSync, logToBackend} from '@/services/document-sync'
import { emitTelemetryEvent } from '@/services/telemetry'
import { chatSessionStore } from '@/services/chat-session-store'
import {useSessionStore} from '@/stores/session'
import {logger} from '@/utils/logger'
import {getRuntimeConfig} from '@/utils/runtime-config'

// ==================== 工具调用相关 ====================

/**
 * 检测内容是否为工具调用 JSON
 */
function isToolCall(content: string): boolean {
    try {
        const parsed = JSON.parse(content)
        return parsed && typeof parsed === 'object' && 'action' in parsed
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
        return false
    }
}

function looksLikeToolCall(content: string): boolean {
    const s = String(content || '').trim()
    if (!s) return false
    // Fast path: avoid JSON.parse on every streaming chunk.
    if (!s.startsWith('{')) return false
    if (s.length > 10_000) return false
    return s.includes('"action"') || s.includes("'action'")
}

/**
 * 解析工具调用
 */
function parseToolCall(content: string): { action: string; input: string } {
    const parsed = JSON.parse(content)
    return {
        action: parsed.action,
        input: parsed.input || ''
    }
}

function extractExecutableJS(raw: string): string {
    const s = String(raw || '').trim()
    if (!s) return ''
    const m = s.match(/```(?:js|javascript)\s*([\s\S]*?)```/i)
    if (m && m[1]) return String(m[1]).trim()
    return s
}

function looksLikeJSMacroSnippet(raw: string): boolean {
    const s = String(raw || '').trim()
    if (!s) return false
    // Reject obvious wrong types early.
    if (/^<!DOCTYPE\s+html/i.test(s) || /^<html\b/i.test(s) || /^<div\b/i.test(s) || /^<p\b/i.test(s)) return false
    // Cheap macro heuristics (keep aligned with backend sanitize/looks_like_wps_js_macro).
    if (/\bfunction\b/.test(s)) return true
    if (s.includes('window.Application')) return true
    if (s.includes('WPS.GetApplication')) return true
    if (s.includes('app.Selection')) return true
    if (s.includes('app.ActiveDocument') || s.includes('app.ActiveWorkbook') || s.includes('app.ActivePresentation')) return true
    if (s.includes('BID.')) return true
    return false
}

/**
 * 执行工具调用
 */
async function executeTool(action: string, input: string): Promise<string> {
    // 2026-02: 移除 JS 宏通道后，不再允许前端执行任何“工具调用”（尤其是执行/生成宏）。
    // 仍保留展示，便于排查模型是否误输出了工具 JSON。
    const act = String(action || '').trim()
    const inp = String(input || '')
    return `[工具调用已禁用: ${act || 'unknown'}] 输入: ${inp}`
}

// ==================== 聊天状态管理 ====================

export const useChatStore = defineStore('chat', () => {
    const normalizeSessionId = (sid?: string | null): string => {
        const v = (sid ? String(sid) : '').trim()
        return v || '__default__'
    }

    type SessionRuntime = {
        isThinking: boolean
        isSending: boolean
        abortController: AbortController | null
        cancelRequested: boolean
        lastStreamCancelled: boolean
        // Streaming observability: phase + elapsed time (helps diagnose "slow but alive" runs).
        streamPhase: string
        streamElapsedMs: number
        streamStartedAt: number
        // Per-turn telemetry correlation.
        turnRunId: string
        turnFirstTokenMs: number
        // Best-effort token usage (if backend provides it).
        lastTokenUsage: any
        // Passive observability: skills routing for the latest turn (selected vs actually applied).
        selectedSkills: Array<{ id: string; name: string; version?: string; priority?: number; score?: number }>
        selectedSkillsHint: string
        appliedSkills: Array<{ id: string; name: string; version?: string; priority?: number; score?: number }>
        appliedSkillsHint: string
        selectedSkillsMetrics: {
            lazyActivationCalls: number
            lazyActivationCacheHits: number
            lazyActivationMs: number
            lazyActivatedSkills: string[]
        }
    }

    const runtimeBySession = reactive<Record<string, SessionRuntime>>({})

    const getRuntime = (sid?: string | null): SessionRuntime => {
        const s = normalizeSessionId(sid)
        if (!runtimeBySession[s]) {
            runtimeBySession[s] = {
                isThinking: false,
                isSending: false,
                abortController: null,
                cancelRequested: false,
                lastStreamCancelled: false,
                streamPhase: 'idle',
                streamElapsedMs: 0,
                streamStartedAt: 0,
                turnRunId: '',
                turnFirstTokenMs: 0,
                lastTokenUsage: null,
                selectedSkills: [],
                selectedSkillsHint: '',
                appliedSkills: [],
                appliedSkillsHint: '',
                selectedSkillsMetrics: {
                    lazyActivationCalls: 0,
                    lazyActivationCacheHits: 0,
                    lazyActivationMs: 0,
                    lazyActivatedSkills: []
                }
            }
        }
        return runtimeBySession[s]
    }

    // 状态（当前可见 session bucket）
    // Important: store messages per-session so switching documents won't detach an in-flight stream.
    const messages = ref<Message[]>([])
    const messageBucketsBySession = reactive<Record<string, Message[]>>({})
    const getBucketMessages = (sid?: string | null): Message[] => {
        const s = normalizeSessionId(sid)
        if (!messageBucketsBySession[s]) messageBucketsBySession[s] = []
        return messageBucketsBySession[s]!
    }
    const currentSessionId = ref<string | null>(null)
    // Stable mapping between "document identity" (path/name/id) and session_id.
    // This keeps per-document chat history isolated while remaining transparent to users.
    const currentDocKey = ref<string>('')
    const docKeyToSessionId = ref<Record<string, string>>({})

    // Session-scoped observability for the currently visible bucket.
    const isThinking = computed(() => getRuntime(currentSessionId.value).isThinking)
    const isSending = computed(() => getRuntime(currentSessionId.value).isSending)
    const streamPhase = computed(() => getRuntime(currentSessionId.value).streamPhase)
    const streamElapsedMs = computed(() => getRuntime(currentSessionId.value).streamElapsedMs)
    const lastTokenUsage = computed(() => getRuntime(currentSessionId.value).lastTokenUsage)
    const selectedSkills = computed(() => getRuntime(currentSessionId.value).selectedSkills)
    const selectedSkillsHint = computed(() => getRuntime(currentSessionId.value).selectedSkillsHint)
    const selectedSkillsMetrics = computed(() => getRuntime(currentSessionId.value).selectedSkillsMetrics)
    const appliedSkills = computed(() => getRuntime(currentSessionId.value).appliedSkills)
    const appliedSkillsHint = computed(() => getRuntime(currentSessionId.value).appliedSkillsHint)

    // ==================== JS 宏“产物”上下文（VibeCoding 风格） ====================
    // 目标：同一产物反复优化时覆盖更新，而不是重复插入多份。
    const lastUserQuery = ref<string>('')
    const lastMacroBlockId = ref<string | null>(null)
    const lastMacroBlockIdBySession = ref<Record<string, string | null>>({})
    const pendingMacroUpdateBlockId = ref<string | null>(null)
    const macroArtifacts = ref<Array<{
        sessionId: string
        blockId: string
        title: string
        createdAt: string
        updatedAt: string
    }>>([])
    const MAX_MACRO_ARTIFACTS = 500
    const pendingMacroClarification = ref<null | {
        action: 'update' | 'delete' | 'rename'
        originalRequest: string
        candidates: Array<{ blockId: string; title: string }>
        renameTo?: string
    }>(null)
    const pendingRenameTargetBlockId = ref<string | null>(null)

    // Macro artifact "shortcuts" (list/rename/delete/update).
    // Keep these conservative to avoid intercepting normal document requests.
    const _hasAny = (t: string, words: string[]): boolean => {
        try {
            return (words || []).some((w) => !!w && t.includes(w))
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
            return false
        }
    }

    const _NEW_ARTIFACT_HINTS = [
        '\u518d\u6765\u4e00\u4e2a',
        '\u518d\u751f\u6210',
        '\u65b0\u589e',
        '\u65b0\u5efa',
        '\u53e6\u5916',
        '\u518d\u505a\u4e00\u4efd',
        '\u8ffd\u52a0\u4e00\u4e2a',
    ]

    const _ARTIFACT_REFS = [
        '\u4e0a\u9762',
        '\u521a\u624d',
        '\u8fd9\u4e2a',
        '\u90a3\u4e2a',
        '\u90a3\u5f20',
        '\u90a3\u4efd',
        '\u4e0a\u4e00',
        '\u6700\u540e',
        '\u4ea7\u7269',
        '\u751f\u6210\u7684',
        '\u8868\u683c',
        '\u56fe\u8868',
        '\u5757',
        'block',
    ]

    const _UPDATE_VERBS = [
        '\u4f18\u5316',
        '\u6539\u8fdb',
        '\u4fee\u6539',
        '\u8c03\u6574',
        '\u5b8c\u5584',
        '\u66f4\u65b0',
        '\u91cd\u505a',
        '\u91cd\u65b0',
        '\u7f8e\u5316',
        '\u4fee\u590d',
    ]

    const _DELETE_VERBS = [
        '\u5220\u9664',
        '\u5220\u6389',
        '\u79fb\u9664',
        '\u53bb\u6389',
        '\u6e05\u9664',
    ]

    const _RENAME_VERBS = [
        '\u547d\u540d\u4e3a',
        '\u6539\u540d\u4e3a',
        '\u91cd\u547d\u540d\u4e3a',
        '\u540d\u79f0\u6539\u4e3a',
        '\u6539\u6210',
    ]

    const _LIST_VERBS = [
        '\u6709\u54ea\u4e9b',
        '\u6709\u4ec0\u4e48',
        '\u5217\u51fa',
        '\u67e5\u770b',
        '\u770b\u770b',
        '\u5c55\u793a',
    ]

    const _LIST_QA = [
        '\u6211\u505a\u4e86\u4ec0\u4e48',
        '\u6211\u4eec\u505a\u4e86\u4ec0\u4e48',
        '\u751f\u6210\u4e86\u4ec0\u4e48',
        '\u505a\u8fc7\u4ec0\u4e48',
        '\u521a\u624d\u505a\u4e86\u4ec0\u4e48',
    ]

    const _ARTIFACT_WORDS = [
        '\u4ea7\u7269',
        '\u751f\u6210\u7269',
        '\u7ed3\u679c',
        '\u751f\u6210\u7684\u5185\u5bb9',
        '\u505a\u8fc7\u7684\u5185\u5bb9',
        '\u4e0a\u9762\u751f\u6210\u7684',
        '\u521a\u624d\u751f\u6210\u7684',
    ]

    const isUpdateIntent = (text: string): boolean => {
        const t = (text || '').trim()
        if (!t) return false

        if (/^\/update(?:\s|$)/i.test(t)) return true
        if (_hasAny(t, _NEW_ARTIFACT_HINTS)) return false

        const hasVerb = _hasAny(t, _UPDATE_VERBS)
        if (!hasVerb) return false

        // Short follow-up like "tweak it" usually implies updating the last artifact.
        if (t.length <= 16) return true

        return _hasAny(t, _ARTIFACT_REFS)
    }

    const isDeleteIntent = (text: string): boolean => {
        const t = (text || '').trim()
        if (!t) return false

        if (/^\/delete(?:\s|$)/i.test(t)) return true
        if (!_hasAny(t, _DELETE_VERBS)) return false

        // Require a reference to avoid matching normal document instructions.
        return _hasAny(t, _ARTIFACT_REFS)
    }

    const isRenameIntent = (text: string): boolean => {
        const t = (text || '').trim()
        if (!t) return false

        if (/^\/rename(?:\s|$)/i.test(t)) return true
        if (!_hasAny(t, _RENAME_VERBS)) return false

        // "rename to xxx" can omit reference and imply the last artifact.
        if (t.length <= 24) return true

        return _hasAny(t, _ARTIFACT_REFS)
    }

    const isListArtifactsIntent = (text: string): boolean => {
        const t = (text || '').trim()
        if (!t) return false

        if (/^\/(artifacts|artifact|list|ls)(?:\s|$)/i.test(t)) return true

        if (_hasAny(t, _LIST_QA)) return true

        const hasListVerb = _hasAny(t, _LIST_VERBS)
        const hasArtifactWord = _hasAny(t, _ARTIFACT_WORDS)
        if (hasListVerb && hasArtifactWord) return true

        // Short fallback: "artifact list / result list".
        if (_hasAny(t, ['\u4ea7\u7269\u5217\u8868', '\u4ea7\u7269\u6e05\u5355', '\u7ed3\u679c\u5217\u8868', '\u7ed3\u679c\u6e05\u5355'])) return true

        return false
    }

    const extractRenameTo = (text: string): string => {
        const t = (text || '').trim()
        const m = t.match(/(?:命名为|改名为|重命名为|名称改为|叫做)\s*([^\n\r]{1,40})/)
        return (m && m[1] ? m[1].trim() : '').replace(/[。？！!?,，]/g, '').trim()
    }

    const consumePendingMacroUpdateBlockId = (): string | null => {
        const v = pendingMacroUpdateBlockId.value
        pendingMacroUpdateBlockId.value = null
        return v
    }

    const getSessionKey = () => currentSessionId.value || '__default__'

    const isContinueIntent = (text: string): boolean => {
        const t = String(text || '').trim()
        return /^(继续|continue)$/i.test(t)
    }

    const getLastAssistantPartial = (): string => {
        try {
            for (let i = messages.value.length - 1; i >= 0; i--) {
                const m = messages.value[i]
                if (m?.type === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
                    // Keep it small so we don't bloat prompt; tail helps "continue from where it stopped".
                    return m.content.trim().slice(-1200)
                }
            }
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
        }
        return ''
    }

    const setSkillsPhase = (
        phase: 'selected' | 'applied',
        skills: any,
        hint: string,
        sessionId?: string | null,
        metrics?: any,
    ) => {
        const sid = normalizeSessionId(sessionId || currentSessionId.value)
        const rt = getRuntime(sid)
        try {
            const list = Array.isArray(skills) ? skills : []
            const normalized = list
                .map((s: any) => ({
                    id: String(s?.id || ''),
                    name: String(s?.name || ''),
                    version: s?.version ? String(s.version) : undefined,
                    priority: typeof s?.priority === 'number' ? s.priority : undefined,
                    score: typeof s?.score === 'number' ? s.score : undefined
                }))
                .filter(s => s.id && s.name)

            if (phase === 'selected') {
                rt.selectedSkills = normalized
                rt.selectedSkillsHint = String(hint || '')
                rt.selectedSkillsMetrics = {
                    lazyActivationCalls: Number.isFinite(Number(metrics?.lazy_activation_calls)) ? Number(metrics?.lazy_activation_calls) : 0,
                    lazyActivationCacheHits: Number.isFinite(Number(metrics?.lazy_activation_cache_hits)) ? Number(metrics?.lazy_activation_cache_hits) : 0,
                    lazyActivationMs: Number.isFinite(Number(metrics?.lazy_activation_ms)) ? Number(metrics?.lazy_activation_ms) : 0,
                    lazyActivatedSkills: Array.isArray(metrics?.lazy_activated_skills)
                        ? metrics.lazy_activated_skills.map((x: any) => String(x || '')).filter((x: string) => !!x)
                        : [],
                }
            } else {
                rt.appliedSkills = normalized
                rt.appliedSkillsHint = String(hint || '')
            }
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
            if (phase === 'selected') {
                rt.selectedSkills = []
                rt.selectedSkillsHint = ''
                rt.selectedSkillsMetrics = {
                    lazyActivationCalls: 0,
                    lazyActivationCacheHits: 0,
                    lazyActivationMs: 0,
                    lazyActivatedSkills: []
                }
            } else {
                rt.appliedSkills = []
                rt.appliedSkillsHint = ''
            }
        }
    }

    const syncLastMacroBlockIdForSession = (sessionId?: string | null) => {
        const sid = (sessionId ? String(sessionId) : '').trim() || getSessionKey()
        // Prefer explicit per-session memory if it exists.
        if (Object.prototype.hasOwnProperty.call(lastMacroBlockIdBySession.value, sid)) {
            lastMacroBlockId.value = lastMacroBlockIdBySession.value[sid] || null
            return
        }
        // Fallback: newest artifact for the session.
        const first = macroArtifacts.value.find(a => a.sessionId === sid)
        lastMacroBlockId.value = first?.blockId || null
    }

    const setLastMacroBlockId = (blockId: string) => {
        const sid = getSessionKey()
        const id = String(blockId || '').trim() || null
        lastMacroBlockId.value = id
        lastMacroBlockIdBySession.value[sid] = id
    }

    const registerMacroArtifact = (blockId: string, title: string) => {
        const id = String(blockId || '').trim()
        if (!id) return
        const now = new Date().toISOString()
        const t = String(title || '').trim() || `宏产物 ${id}`
        const sid = getSessionKey()

        const idx = macroArtifacts.value.findIndex(a => a.blockId === id && a.sessionId === sid)
        if (idx >= 0) {
            const updated = {
                ...macroArtifacts.value[idx],
                title: t,
                updatedAt: now
            }
            // Keep most-recent items at the top (makes "第N个/最近" deterministic).
            macroArtifacts.value.splice(idx, 1)
            macroArtifacts.value.unshift(updated)
        } else {
            macroArtifacts.value.unshift({
                sessionId: sid,
                blockId: id,
                title: t,
                createdAt: now,
                updatedAt: now
            })
        }
        // Keep the list bounded to avoid unbounded growth in long sessions.
        if (macroArtifacts.value.length > MAX_MACRO_ARTIFACTS) {
            macroArtifacts.value = macroArtifacts.value.slice(0, MAX_MACRO_ARTIFACTS)
        }
    }

    const removeMacroArtifact = (blockId: string) => {
        const id = String(blockId || '').trim()
        if (!id) return
        const sid = getSessionKey()
        macroArtifacts.value = macroArtifacts.value.filter(a => !(a.sessionId === sid && a.blockId === id))
        if (lastMacroBlockId.value === id) {
            const first = macroArtifacts.value.find(a => a.sessionId === sid)
            lastMacroBlockId.value = first?.blockId || null
        }
        if (lastMacroBlockIdBySession.value[sid] === id) {
            const first = macroArtifacts.value.find(a => a.sessionId === sid)
            lastMacroBlockIdBySession.value[sid] = first?.blockId || null
        }
    }

    const formatArtifactsList = (limit: number = 8) => {
        const sid = getSessionKey()
        const all = macroArtifacts.value
            .filter(a => a.sessionId === sid)
            .slice()
            .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        const list = all.slice(0, limit)
        if (list.length === 0) return '当前还没有可修改的产物。'
        return (
            '当前可修改的产物（按最近更新时间）：\n' +
            list.map((a, i) => `${i + 1}. ${a.title}`).join('\n') +
            (all.length > limit
                ? `\n…还有 ${all.length - limit} 个`
                : '')
        )
    }

    const resolveTargetArtifact = (userText: string) => {
        const raw = (userText || '').trim()
        const text = raw
            .replace(/(?:请|帮我|麻烦|能否|把|将|对|给我)/g, ' ')
            .replace(/(?:优化|改进|修改|调整|完善|更新|重做|重新|美化|修一下|修复|删除|移除|去掉|清除|撤销|取消|不要了|删掉|命名为|改名为|重命名为|名称改为|叫做)/g, ' ')
            .replace(/[。？！!?,，]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
        const sid = getSessionKey()
        const artifacts = macroArtifacts.value
            .filter(a => a.sessionId === sid)
            .slice()
            .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        if (artifacts.length === 0) {
            return { kind: 'none' as const }
        }

        // "第N个" => by recency (newest first).
        const nth = raw.match(/第\s*(\d+)\s*个/)
        if (nth && nth[1]) {
            const n = Number(nth[1])
            if (Number.isFinite(n) && n >= 1 && n <= artifacts.length) {
                return { kind: 'resolved' as const, blockId: artifacts[n - 1]!.blockId }
            }
        }

        // "上一个/刚才那个/最近那个"
        if (/(上一个|刚才|最近|上次|刚刚)/.test(raw)) {
            if (lastMacroBlockId.value) return { kind: 'resolved' as const, blockId: lastMacroBlockId.value }
        }

        // Match by title substring (best-effort).
        const norm = (s: string) => (s || '').toLowerCase()
        const q = norm(text)
        const matches = artifacts.filter(a => q && norm(a.title).includes(q))
        if (matches.length === 1) {
            return { kind: 'resolved' as const, blockId: matches[0]!.blockId }
        }
        if (matches.length > 1) {
            return { kind: 'ambiguous' as const, candidates: matches.slice(0, 5) }
        }

        return { kind: 'none' as const }
    }
    const restoredFromStorage = ref(false)
    const executedMacroMessageIds = ref<string[]>([])
    // Persist per-macro-block execution status so history can show "queued/running/executed/failed"
    // after reopening a session (important for long-running MacroBench + taskpane reloads).
    type MacroBlockRun = {
        status: 'queued' | 'running' | 'success' | 'error'
        updatedAt: string
        messageId: string
        blockId: string
        error?: string
        finalCode?: string
    }
    const macroBlockRuns = ref<Record<string, MacroBlockRun>>({})
    // Incrementing tick for UI recompute (MessageItem caches parsing aggressively).
    const macroBlockRunsTick = ref(0)
    const macroRunKey = (messageId: string, blockId: string) => {
        return `${String(messageId || '').trim()}::${String(blockId || '').trim()}`
    }

    // Session-level "writeback status" so the document list can show:
    // idle / waiting / running / success / error.
    const lastWritebackBySession = ref<Record<string, MacroBlockRun>>({})

    const _findSessionIdForMessageId = (messageId: string): string | null => {
        const mid = String(messageId || '').trim()
        if (!mid) return null
        try {
            for (const sid of Object.keys(messageBucketsBySession)) {
                const bucket = messageBucketsBySession[sid]
                if (!bucket || bucket.length === 0) continue
                if (bucket.some((m) => String((m as any)?.id || '') === mid)) return sid
            }
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
        }
        return null
    }

    // ==================== 宏写回队列（全局互斥，失败继续下一条） ====================
    // Why: even if chat can be concurrent across documents/sessions, WPS JS macros must not execute
    // concurrently because they operate on ActiveDocument/Selection and can easily stomp each other.
    type MacroJobBlock = {
        type: 'plan'
        blockId: string
        code: string
        confirm?: boolean
    }

    type MacroJob = {
        id: string
        createdAt: string
        sessionId: string
        messageId: string
        docContext: null | {
            docId: string
            docKey: string
            name: string
            path: string
            hostApp: string
        }
        blocks: MacroJobBlock[]
    }

    const macroJobQueue = ref<MacroJob[]>([])
    const macroJobRunning = ref(false)
    const macroJobActiveSessionId = ref<string>('')

    const cancelPendingMacroJobs = (opts?: { sessionId?: string; docKey?: string }): { cancelledJobs: number; cancelledBlocks: number } => {
        const sid = normalizeSessionId(opts?.sessionId || '')
        const docKey = String(opts?.docKey || '').trim()
        let cancelledJobs = 0
        let cancelledBlocks = 0

        try {
            if (macroJobQueue.value.length === 0) return { cancelledJobs: 0, cancelledBlocks: 0 }
            const keep: MacroJob[] = []
            for (const job of macroJobQueue.value) {
                const matchByDoc = docKey && String(job?.docContext?.docKey || '').trim() === docKey
                const matchBySid = sid !== '__default__' && String(job?.sessionId || '') === sid
                const shouldCancel = matchByDoc || (!docKey && matchBySid)
                if (!shouldCancel) {
                    keep.push(job)
                    continue
                }
                cancelledJobs += 1
                try {
                    for (const b of job.blocks || []) {
                        cancelledBlocks += 1
                        try {
                            setMacroBlockRun(b.blockId, {
                                status: 'error',
                                messageId: job.messageId,
                                error: 'cancelled'
                            })
                        } catch (e) {
                          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                        }
                    }
                } catch (e) {
                  ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                }
            }
            macroJobQueue.value = keep
        } catch (e) {
            logger.warn('[MacroQueue] cancelPendingMacroJobs failed (ignored)', e)
        }

        // UX: only append a hint to the currently visible session to avoid cross-doc noise.
        try {
            const activeSid = normalizeSessionId(currentSessionId.value)
            const same = (docKey && String(currentDocKey.value || '').trim() === docKey) || (sid !== '__default__' && sid === activeSid)
            if (same && (cancelledJobs > 0 || cancelledBlocks > 0)) {
                addSystemMessage(`已取消写回队列：${cancelledJobs} 个任务（${cancelledBlocks} 个块）。`)
            }
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
        }

        return { cancelledJobs, cancelledBlocks }
    }

    const getSessionMessageIdSet = (sid?: string | null): Set<string> => {
        const s = normalizeSessionId(sid)
        const bucket = getBucketMessages(s)
        const ids = new Set<string>()
        for (const m of bucket) {
            if (m && m.id) ids.add(String(m.id))
        }
        return ids
    }

    const getSessionStatusBySessionId = (sessionId?: string | null): { status: string; detail?: string } => {
        const sid = normalizeSessionId(sessionId)
        if (!sid) return { status: '空闲' }

        const rt = getRuntime(sid)
        if (rt.isSending) return { status: '生成中' }

        const hasQueued = macroJobQueue.value.some(j => normalizeSessionId(j.sessionId) === sid)
        if (hasQueued) return { status: '等待写回' }

        if (macroJobRunning.value && normalizeSessionId(macroJobActiveSessionId.value) === sid) {
            return { status: '写回中' }
        }

        const msgIds = getSessionMessageIdSet(sid)
        const runs = Object.values(macroBlockRuns.value || {}).filter((r) => msgIds.has(String(r.messageId || '')))
        if (runs.some(r => r.status === 'running')) return { status: '写回中' }

        let latest: any = null
        for (const r of runs) {
            if (!latest) latest = r
            else if (String(r.updatedAt || '') > String(latest.updatedAt || '')) latest = r
        }
        if (latest?.status === 'success') return { status: '写回成功' }
        if (latest?.status === 'error') return { status: '写回失败', detail: String(latest?.error || '') }

        return { status: '空闲' }
    }

    const getSessionStatusByDocKey = (docKey?: string | null): { status: string; detail?: string } => {
        const key = String(docKey || '').trim()
        if (!key) return { status: '空闲' }
        const sid = docKeyToSessionId.value[key]
        return getSessionStatusBySessionId(sid || undefined)
    }

    // ==================== 持久化（按 session 分桶，避免多文档串线） ====================
    // Legacy (single-bucket) key kept for one-time migration.
    const CHAT_LEGACY_STATE_KEY = 'ah32_chat_state_v1'
    const CHAT_INDEX_KEY = 'ah32_chat_index_v1'
    const CHAT_SESSION_KEY_PREFIX = 'ah32_chat_session_v1:'
    const CHAT_INDEX_VERSION = 1
    const CHAT_SESSION_VERSION = 1
    const MAX_STORED_MESSAGES = 2000
    const MAX_STORED_CHARS = 2_000_000
    // localStorage is small + synchronous in WPS webviews; keep its fallback payload compact.
    const MAX_STORED_MESSAGES_LOCAL = 200
    const MAX_STORED_CHARS_LOCAL = 300_000

    type PersistedMessage = Omit<Message, 'timestamp'> & { timestamp: string }
    type PersistedChatSession = {
        version: number
        savedAt: string
        sessionId: string
        docKey?: string
        docName?: string | null
        docPath?: string | null
        messages: PersistedMessage[]
        // Macro artifact context
        lastUserQuery?: string
        lastMacroBlockId?: string | null
        lastMacroBlockIdBySession?: Record<string, string | null>
        macroArtifacts?: Array<{
            sessionId?: string
            blockId: string
            title: string
            createdAt: string
            updatedAt: string
        }>
        executedMacroMessageIds?: string[]
        macroBlockRuns?: Record<string, MacroBlockRun>
    }

    type PersistedChatIndex = {
        version: number
        savedAt: string
        activeSessionId: string | null
        docKeyToSessionId?: Record<string, string>
    }

    const safeJsonParse = <T = any>(raw: string): T | null => {
        try {
            return JSON.parse(raw) as T
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
            return null
        }
    }

    const normalizeMessagesForStorage = (
        source: Message[],
        opts?: { maxMessages?: number; maxChars?: number }
    ): PersistedMessage[] => {
        const maxMessages = Number.isFinite(opts?.maxMessages) ? Math.max(1, Number(opts?.maxMessages)) : MAX_STORED_MESSAGES
        const maxChars = Number.isFinite(opts?.maxChars) ? Math.max(10_000, Number(opts?.maxChars)) : MAX_STORED_CHARS

        // Keep the newest messages and cap total size to avoid storage overflow.
        let kept = (source || []).slice(-maxMessages)

        const msgSize = (m: Message) => (m?.content?.length || 0) + (m?.thinking?.length || 0)
        let totalChars = kept.reduce((sum, m) => sum + msgSize(m), 0)
        while (kept.length > 0 && totalChars > maxChars) {
            const removed = kept.shift()
            if (removed) totalChars -= msgSize(removed)
        }

        return kept.map((m) => ({
            id: m.id,
            type: m.type,
            content: m.content || '',
            thinking: m.thinking,
            isSystem: m.isSystem,
            metadata: m.metadata,
            timestamp: (m.timestamp instanceof Date ? m.timestamp : new Date(m.timestamp as any)).toISOString()
        }))
    }

    type LegacyPersistedChatState = {
        version: number
        savedAt: string
        currentSessionId: string | null
        messages: PersistedMessage[]
        lastUserQuery?: string
        lastMacroBlockId?: string | null
        lastMacroBlockIdBySession?: Record<string, string | null>
        macroArtifacts?: Array<{
            sessionId?: string
            blockId: string
            title: string
            createdAt: string
            updatedAt: string
        }>
        executedMacroMessageIds?: string[]
        macroBlockRuns?: Record<string, MacroBlockRun>
    }

    const sessionStorageKey = (sid: string): string => `${CHAT_SESSION_KEY_PREFIX}${normalizeSessionId(sid)}`

    const persistIndex = () => {
        try {
            if (typeof localStorage === 'undefined') return
            const payload: PersistedChatIndex = {
                version: CHAT_INDEX_VERSION,
                savedAt: new Date().toISOString(),
                activeSessionId: currentSessionId.value,
                docKeyToSessionId: docKeyToSessionId.value
            }
            localStorage.setItem(CHAT_INDEX_KEY, JSON.stringify(payload))
        } catch (e) {
            logger.warn('[chat] persistIndex failed (ignored)', e)
        }
    }

    const persistSessionBucket = () => {
        try {
            const sid = normalizeSessionId(currentSessionId.value)
            const payload: PersistedChatSession = {
                version: CHAT_SESSION_VERSION,
                savedAt: new Date().toISOString(),
                sessionId: sid,
                docKey: currentDocKey.value || undefined,
                messages: normalizeMessagesForStorage(messages.value),
                lastUserQuery: lastUserQuery.value,
                lastMacroBlockId: lastMacroBlockId.value,
                lastMacroBlockIdBySession: lastMacroBlockIdBySession.value,
                macroArtifacts: macroArtifacts.value,
                executedMacroMessageIds: executedMacroMessageIds.value,
                macroBlockRuns: macroBlockRuns.value
            }

            if (chatSessionStore.isAvailable()) {
                void chatSessionStore.setSession(payload as any).catch((e) => {
                    logger.warn('[chat] persistSessionBucket idb failed, fallback to localStorage', e)
                    try {
                        if (typeof localStorage !== 'undefined') {
                            localStorage.setItem(
                                sessionStorageKey(sid),
                                JSON.stringify({ ...payload, messages: normalizeMessagesForLocalStorage(messages.value) })
                            )
                        }
                    } catch (e2) {
                        logger.warn('[chat] persistSessionBucket localStorage fallback failed (ignored)', e2)
                    }
                })
            } else {
                try {
                    if (typeof localStorage !== 'undefined') {
                        localStorage.setItem(
                            sessionStorageKey(sid),
                            JSON.stringify({ ...payload, messages: normalizeMessagesForLocalStorage(messages.value) })
                        )
                    }
                } catch (e2) {
                    logger.warn('[chat] persistSessionBucket localStorage failed (ignored)', e2)
                }
            }
        } catch (e) {
            logger.warn('[chat] persistSessionBucket failed (ignored)', e)
        }
    }

    const normalizeMessagesForLocalStorage = (source: Message[]): PersistedMessage[] => {
        return normalizeMessagesForStorage(source, { maxMessages: MAX_STORED_MESSAGES_LOCAL, maxChars: MAX_STORED_CHARS_LOCAL })
    }

    // Persist a specific session bucket even when it's not the currently displayed one.
    // This is required for multi-document usage: user may switch active documents while
    // another session is still streaming; we must not lose that in-flight content.
    const persistSessionBucketById = (sid: string, bucketMessages: Message[]) => {
        try {
            const s = normalizeSessionId(sid)
            const active = normalizeSessionId(currentSessionId.value)

            const inferredDocKey = (() => {
                try {
                    if (s === active) return currentDocKey.value || undefined
                    const entries = Object.entries(docKeyToSessionId.value || {})
                    for (const [dk, ss] of entries) {
                        if (normalizeSessionId(ss as any) === s) return dk || undefined
                    }
                } catch (e) {
                  ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                }
                return undefined
            })()

            const payload: PersistedChatSession = {
                version: CHAT_SESSION_VERSION,
                savedAt: new Date().toISOString(),
                sessionId: s,
                docKey: inferredDocKey,
                messages: normalizeMessagesForStorage(bucketMessages),
                lastUserQuery: (s === active ? lastUserQuery.value : undefined),
                lastMacroBlockId: (s === active ? lastMacroBlockId.value : undefined),
                lastMacroBlockIdBySession: lastMacroBlockIdBySession.value,
                macroArtifacts: macroArtifacts.value,
                executedMacroMessageIds: executedMacroMessageIds.value,
                macroBlockRuns: macroBlockRuns.value
            }

            if (chatSessionStore.isAvailable()) {
                void chatSessionStore.setSession(payload as any).catch((e) => {
                    logger.warn('[chat] persistSessionBucketById idb failed, fallback to localStorage', e)
                    try {
                        if (typeof localStorage !== 'undefined') {
                            localStorage.setItem(
                                sessionStorageKey(s),
                                JSON.stringify({ ...payload, messages: normalizeMessagesForLocalStorage(bucketMessages) })
                            )
                        }
                    } catch (e2) {
                        logger.warn('[chat] persistSessionBucketById localStorage fallback failed (ignored)', e2)
                    }
                })
            } else {
                try {
                    if (typeof localStorage !== 'undefined') {
                        localStorage.setItem(
                            sessionStorageKey(s),
                            JSON.stringify({ ...payload, messages: normalizeMessagesForLocalStorage(bucketMessages) })
                        )
                    }
                } catch (e2) {
                    logger.warn('[chat] persistSessionBucketById localStorage failed (ignored)', e2)
                }
            }
        } catch (e) {
            logger.warn('[chat] persistSessionBucketById failed (ignored)', e)
        }
    }

    const persistBucketTimers = new Map<string, any>()
    const schedulePersistSessionBucketById = (sid: string, bucketMessages: Message[]) => {
        try {
            const s = normalizeSessionId(sid)
            const prev = persistBucketTimers.get(s)
            if (prev) clearTimeout(prev)
            const t = setTimeout(() => {
                persistBucketTimers.delete(s)
                persistSessionBucketById(s, bucketMessages)
            }, 350)
            persistBucketTimers.set(s, t)
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
            // ignore
        }
    }

    const persistState = () => {
        // Persist current bucket first, then the global index.
        persistSessionBucket()
        persistIndex()
    }

    let persistTimer: ReturnType<typeof setTimeout> | null = null
    const schedulePersistState = () => {
        if (persistTimer) clearTimeout(persistTimer)
        persistTimer = setTimeout(() => {
            persistTimer = null
            persistState()
        }, 350)
    }

    const restoreSessionBucket = (sid: string) => {
        const s = normalizeSessionId(sid)

        const restoreFromParsed = (parsed: PersistedChatSession) => {
            if (!parsed || !Array.isArray(parsed.messages)) return

            const bucket = getBucketMessages(s)
            const restored = parsed.messages.map((m) => ({
                id: m.id,
                type: m.type,
                content: m.content || '',
                thinking: m.thinking,
                isSystem: m.isSystem,
                metadata: m.metadata,
                timestamp: new Date(m.timestamp)
            }))
            try {
                bucket.length = 0
                bucket.push(...restored)
            } catch (e) {
              ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                // Fallback: replace by reference
                messageBucketsBySession[normalizeSessionId(s)] = restored
            }
            messages.value = getBucketMessages(s)
            currentSessionId.value = parsed.sessionId || s
            currentDocKey.value = parsed.docKey || ''

            if (typeof parsed.lastUserQuery === 'string') lastUserQuery.value = parsed.lastUserQuery
            if (typeof parsed.lastMacroBlockId === 'string' || parsed.lastMacroBlockId === null) {
                lastMacroBlockId.value = parsed.lastMacroBlockId ?? null
            }
            if (parsed.lastMacroBlockIdBySession && typeof parsed.lastMacroBlockIdBySession === 'object') {
                const obj: any = parsed.lastMacroBlockIdBySession
                const next: Record<string, string | null> = {}
                for (const k of Object.keys(obj)) {
                    const v = obj[k]
                    next[String(k)] = v === null ? null : (typeof v === 'string' ? v : null)
                }
                lastMacroBlockIdBySession.value = next
            } else {
                lastMacroBlockIdBySession.value = {}
            }
            if (Array.isArray(parsed.macroArtifacts)) {
                macroArtifacts.value = parsed.macroArtifacts
                    .filter((a) => a && typeof a.blockId === 'string')
                    .slice(0, MAX_MACRO_ARTIFACTS)
                    .map((a) => ({
                        sessionId: (a as any).sessionId ? String((a as any).sessionId) : s,
                        blockId: String((a as any).blockId),
                        title: String((a as any).title || (a as any).blockId),
                        createdAt: String((a as any).createdAt || parsed.savedAt || new Date().toISOString()),
                        updatedAt: String((a as any).updatedAt || (a as any).createdAt || parsed.savedAt || new Date().toISOString()),
                    }))
            } else {
                macroArtifacts.value = []
            }
            if (Array.isArray(parsed.executedMacroMessageIds)) {
                executedMacroMessageIds.value = parsed.executedMacroMessageIds
                    .filter((id) => typeof id === 'string')
                    .slice(-500)
            } else {
                executedMacroMessageIds.value = []
            }
            if (parsed.macroBlockRuns && typeof parsed.macroBlockRuns === 'object') {
                const obj: any = parsed.macroBlockRuns
                const next: Record<string, MacroBlockRun> = {}
                for (const k of Object.keys(obj)) {
                    const v = obj[k]
                    if (!v || typeof v !== 'object') continue
                    const rawKey = String(k)
                    const sep = rawKey.indexOf('::')
                    const keyMsgId = sep >= 0 ? rawKey.slice(0, sep) : ''
                    const keyBlockId = sep >= 0 ? rawKey.slice(sep + 2) : rawKey
                    const status = (v as any).status
                    const messageId = (typeof (v as any).messageId === 'string' && (v as any).messageId.trim())
                        ? String((v as any).messageId).trim()
                        : String(keyMsgId || '').trim()
                    const blockId = (typeof (v as any).blockId === 'string' && (v as any).blockId.trim())
                        ? String((v as any).blockId).trim()
                        : String(keyBlockId || '').trim()
                    const updatedAt = (v as any).updatedAt
                    if (status !== 'success' && status !== 'error') continue
                    if (!messageId) continue
                    if (!blockId) continue
                    if (typeof updatedAt !== 'string' || !updatedAt.trim()) continue
                    const error = (typeof (v as any).error === 'string' && (v as any).error.trim())
                        ? String((v as any).error).trim().slice(0, 2000)
                        : undefined
                    let finalCode = (typeof (v as any).finalCode === 'string') ? String((v as any).finalCode).trim() : undefined
                    if (finalCode && finalCode.length > 50_000) finalCode = finalCode.slice(0, 50_000)
                    if (finalCode && !finalCode.trim()) finalCode = undefined
                    next[macroRunKey(messageId, blockId)] = { status, messageId, blockId, updatedAt: updatedAt.trim(), error, finalCode }
                }
                macroBlockRuns.value = next
            } else {
                macroBlockRuns.value = {}
            }

            // Seed per-session last block id memory if missing (best-effort).
            const active = normalizeSessionId(parsed.sessionId || s)
            if (!Object.prototype.hasOwnProperty.call(lastMacroBlockIdBySession.value, active)) {
                lastMacroBlockIdBySession.value[active] = lastMacroBlockId.value
            }
            syncLastMacroBlockIdForSession(active)
        }

        // 1) Fast path: localStorage (older versions / fallback).
        try {
            if (typeof localStorage !== 'undefined') {
                const raw = localStorage.getItem(sessionStorageKey(s))
                if (raw) {
                    const parsed = safeJsonParse<PersistedChatSession>(raw)
                    if (parsed) {
                        restoreFromParsed(parsed)
                        // Migrate to IndexedDB in background (and free localStorage quota).
                        if (chatSessionStore.isAvailable()) {
                            void chatSessionStore.setSession(parsed as any).then(() => {
                                try { localStorage.removeItem(sessionStorageKey(s)) } catch (e) { /* ignore */ }
                            }).catch((e) => logger.warn('[chat] migrate session bucket to idb failed (ignored)', e))
                        }
                        return
                    }
                }
            }
        } catch (e) {
            logger.warn('[chat] restoreSessionBucket localStorage failed (ignored)', e)
        }

        // 2) IndexedDB restore (async).
        if (chatSessionStore.isAvailable()) {
            void chatSessionStore.getSession<PersistedChatSession>(s).then((row) => {
                if (row) restoreFromParsed(row)
            }).catch((e) => {
                logger.warn('[chat] restoreSessionBucket idb failed (ignored)', e)
            })
        }
    }

    const restoreState = () => {
        try {
            if (typeof localStorage === 'undefined') return

            // 1) Restore index (docKey->session mapping + last active session)
            const indexRaw = localStorage.getItem(CHAT_INDEX_KEY)
            const indexParsed = indexRaw ? safeJsonParse<PersistedChatIndex>(indexRaw) : null
            if (indexParsed && indexParsed.docKeyToSessionId && typeof indexParsed.docKeyToSessionId === 'object') {
                docKeyToSessionId.value = { ...(indexParsed.docKeyToSessionId as any) }
            }

            let sid = normalizeSessionId(indexParsed?.activeSessionId || null)

            // 2) One-time migration from legacy single-bucket state.
            const legacyRaw = localStorage.getItem(CHAT_LEGACY_STATE_KEY)
            if (legacyRaw) {
                const legacy = safeJsonParse<LegacyPersistedChatState>(legacyRaw)
                if (legacy && Array.isArray(legacy.messages)) {
                    sid = normalizeSessionId(legacy.currentSessionId || sid)
                    const payload: PersistedChatSession = {
                        version: CHAT_SESSION_VERSION,
                        savedAt: legacy.savedAt || new Date().toISOString(),
                        sessionId: sid,
                        messages: legacy.messages,
                        lastUserQuery: legacy.lastUserQuery,
                        lastMacroBlockId: legacy.lastMacroBlockId ?? null,
                        lastMacroBlockIdBySession: legacy.lastMacroBlockIdBySession,
                        macroArtifacts: legacy.macroArtifacts,
                        executedMacroMessageIds: legacy.executedMacroMessageIds,
                        macroBlockRuns: legacy.macroBlockRuns
                    }
                    if (chatSessionStore.isAvailable()) {
                        void chatSessionStore.setSession(payload as any).catch((e) => {
                            logger.warn('[chat] legacy migration to idb failed, fallback to localStorage', e)
                            try {
                                localStorage.setItem(
                                    sessionStorageKey(sid),
                                    JSON.stringify({ ...payload, messages: normalizeMessagesForLocalStorage((legacy as any).messages || []) })
                                )
                            } catch (e2) { /* ignore */ }
                        })
                    } else {
                        try {
                            localStorage.setItem(
                                sessionStorageKey(sid),
                                JSON.stringify({ ...payload, messages: normalizeMessagesForLocalStorage((legacy as any).messages || []) })
                            )
                        } catch (e) { /* ignore */ }
                    }
                    localStorage.removeItem(CHAT_LEGACY_STATE_KEY)
                    // Ensure we have an index after migration.
                    persistIndex()
                }
            }

            // 3) Restore the active session bucket.
            restoreSessionBucket(sid)

            // 4) Best-effort: rebuild pending macro queue for the active bucket.
            // This makes reload/disconnect survivable during long-running macro writebacks.
            try {
                const activeSid = normalizeSessionId(currentSessionId.value || sid)
                const bucket = getBucketMessages(activeSid)
                const msgIndex: Record<string, any> = {}
                for (const m of (bucket || [])) {
                    if (m && typeof (m as any).id === 'string') msgIndex[(m as any).id] = m
                }
                const runs = Object.values(macroBlockRuns.value || {}).filter(
                    (r: any) => r && (r.status === 'queued' || r.status === 'running') && !!msgIndex[String(r.messageId || '')]
                )
                if (runs.length > 0) {
                    // Group pending blocks by assistant message so we re-execute deterministically.
                    const byMsg: Record<string, MacroJob> = {}
                    const runningToQueued: Array<{ blockId: string; messageId: string; code: string }> = []
                    for (const r of runs) {
                        const mid = String((r as any).messageId || '').trim()
                        if (!mid) continue
                        const msg: any = msgIndex[mid]
                        const meta: any = msg?.metadata || {}
                        const docContext = meta?.docContext || null
                        if (!byMsg[mid]) {
                            byMsg[mid] = {
                                id: _randId('macrojob_restore'),
                                createdAt: _nowIso(),
                                sessionId: activeSid,
                                messageId: mid,
                                docContext: docContext
                                    ? {
                                        docId: String(docContext.docId || '').trim(),
                                        docKey: String(docContext.docKey || '').trim(),
                                        name: String(docContext.name || '').trim(),
                                        path: String(docContext.path || '').trim(),
                                        hostApp: String(docContext.hostApp || wpsBridge.getHostApp() || '').trim()
                                    }
                                    : null,
                                blocks: []
                            }
                        }
                        const ah32 = String((r as any).blockId || '').trim()
                        const code = String((r as any).finalCode || '').trim()
                        if (!ah32 || !code) continue
                        byMsg[mid]!.blocks.push({ type: 'plan', blockId: ah32, code })
                        // "running" can never be resumed as-is; re-queue it (deferred to avoid TDZ).
                        if ((r as any).status === 'running') {
                            runningToQueued.push({ blockId: ah32, messageId: mid, code })
                        }
                    }
                    const jobs = Object.values(byMsg).filter(j => (j.blocks || []).length > 0)
                    if (jobs.length > 0) {
                        // Defer to avoid TDZ: setMacroBlockRun/processMacroJobQueue are defined later in setup().
                        setTimeout(() => {
                            try {
                                for (const x of runningToQueued) {
                                    try { setMacroBlockRun(x.blockId, { status: 'queued', messageId: x.messageId, finalCode: x.code }) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e) }
                                }
                                macroJobQueue.value.push(...jobs)
                                try { logToBackend?.(`[MacroQueue] restored pending jobs=${jobs.length} blocks=${runs.length}`) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e) }
                                // Resume automatically (user can cancel from UI).
                                void processMacroJobQueue()
                            } catch (e2: any) {
                                logger.warn('[chat] resume restored macro queue failed (ignored)', e2)
                            }
                        }, 0)
                    }
                }
            } catch (e: any) {
                logger.warn('[chat] rebuild macro queue failed (ignored)', e)
            }

            restoredFromStorage.value = messages.value.length > 0 || !!currentSessionId.value
        } catch (e) {
            logger.warn('[chat] restoreState failed (ignored)', e)
        }
    }

    // Restore early so the UI renders recovered history on first paint.
    restoreState()

    // Persist on changes (debounced).
    // NOTE: Avoid deep-watching `messages` during streaming. In WPS webviews this can cause heavy
    // deep-traversal work and trigger taskpane reloads. Streaming updates call
    // `schedulePersistSessionBucketById()` explicitly; here we only persist on structural changes.
    watch(() => messages.value.length, () => schedulePersistState())
    watch(currentSessionId, (sid) => {
        syncLastMacroBlockIdForSession(sid)
        schedulePersistState()
    })
    watch(macroArtifacts, schedulePersistState, { deep: true })
    watch(lastMacroBlockId, schedulePersistState)
    watch(executedMacroMessageIds, schedulePersistState, { deep: true })
    watch(macroBlockRuns, schedulePersistState, { deep: true })
    watch(docKeyToSessionId, schedulePersistState, { deep: true })
    watch(currentDocKey, schedulePersistState)
    watch(isSending, (sending, prevSending) => {
        // If user switched documents while a message was streaming, re-sync buckets after send completes.
        if (prevSending && !sending) scheduleSyncSessionToActiveDocument()
    })

    const isMacroMessageExecuted = (messageId: string): boolean => {
        return executedMacroMessageIds.value.includes(messageId)
    }

    const markMacroMessageExecuted = (messageId: string) => {
        const id = String(messageId || '').trim()
        if (!id) return
        if (executedMacroMessageIds.value.includes(id)) return
        executedMacroMessageIds.value.push(id)
        // Keep bounded
        if (executedMacroMessageIds.value.length > 500) {
            executedMacroMessageIds.value = executedMacroMessageIds.value.slice(-500)
        }
    }

    const getMacroBlockRun = (messageId: string, blockId: string): MacroBlockRun | null => {
        const mid = String(messageId || '').trim()
        const ah32 = String(blockId || '').trim()
        if (!mid || !ah32) return null
        return macroBlockRuns.value[macroRunKey(mid, ah32)] || null
    }

    const setMacroBlockRun = (
        blockId: string,
        run: { status: 'queued' | 'running' | 'success' | 'error'; messageId: string; error?: string; finalCode?: string }
    ) => {
        const ah32 = String(blockId || '').trim()
        if (!ah32) return
        const msgId = String(run?.messageId || '').trim()
        if (!msgId) return
        const id = macroRunKey(msgId, ah32)

        const err = (typeof run.error === 'string' && run.error.trim())
            ? run.error.trim().slice(0, 2000)
            : undefined
        let finalCode = (typeof run.finalCode === 'string') ? run.finalCode.trim() : undefined
        if (finalCode && finalCode.length > 50_000) {
            // Avoid blowing up localStorage: keep only the head of very large macros.
            finalCode = finalCode.slice(0, 50_000)
        }
        if (finalCode && !finalCode.trim()) finalCode = undefined

        macroBlockRuns.value[id] = {
            status: run.status,
            messageId: msgId,
            blockId: ah32,
            error: err,
            finalCode,
            updatedAt: new Date().toISOString()
        }
        try { macroBlockRunsTick.value += 1 } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e) }

        // Track the last writeback status per session for doc-level UI badges.
        try {
            const sid = _findSessionIdForMessageId(msgId)
            if (sid) lastWritebackBySession.value[sid] = macroBlockRuns.value[id] as any
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
        }

        // Keep bounded (avoid long-running sessions blowing up localStorage).
        const keys = Object.keys(macroBlockRuns.value)
        if (keys.length > 600) {
            const sorted = keys
                .map((k) => ({ k, t: String(macroBlockRuns.value[k]?.updatedAt || '') }))
                .sort((a, b) => a.t.localeCompare(b.t)) // oldest first
            for (let i = 0; i < sorted.length - 500; i++) {
                const k = sorted[i]?.k
                if (k) delete macroBlockRuns.value[k]
            }
        }
    }

    // 生成消息ID
    const generateMessageId = () => {
        return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
    }

    // 创建消息
    const createMessage = (
        type: Message['type'],
        content: string,
        thinking?: string,
        metadata?: Record<string, any>
    ): Message => {
        return {
            id: generateMessageId(),
            type,
            content,
            thinking,
            timestamp: new Date(),
            metadata
        }
    }

    // 添加消息
    const addMessage = (message: Message) => {
        messages.value.push(message)
    }

    // 添加系统消息
    const addSystemMessage = (content: string) => {
        const message = createMessage('assistant', content)
        message.isSystem = true
        addMessage(message)
    }

    type _UINotifyPayload = {
        type?: 'success' | 'info' | 'warning' | 'error'
        title?: string
        message: string
        durationMs?: number
    }

    const _uiNotify = (payload: _UINotifyPayload) => {
        try {
            const fn = (globalThis as any).__ah32_notify
            if (typeof fn === 'function') fn(payload)
        } catch (e) {
            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
        }
    }

    const _addSystemMessageToSessionBucketSafe = (sid: string, text: string, docContext?: any) => {
        try {
            const s = normalizeSessionId(sid)
            if (!s) return
            const bucket = getBucketMessages(s)
            const msg = createMessage('assistant', String(text || ''), undefined, docContext ? { docContext } : undefined)
            msg.isSystem = true
            bucket.push(msg)
            schedulePersistSessionBucketById(s, bucket)
        } catch (e) {
            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
            // fallback: at least show in current visible stream
            try { addSystemMessage(String(text || '')) } catch (e2) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e2) }
        }
    }

    const _macroErrorNotifyDedup = new Map<string, number>()
    const _notifyMacroWritebackError = (args: { job: MacroJob; blockId: string; error: string; errCode?: string }) => {
        try {
            const job = args.job
            const blockId = String(args.blockId || '').trim()
            const err = String(args.error || '').trim() || 'unknown_error'
            const errCode = String(args.errCode || '').trim()
            if (!blockId) return
            if (err === 'cancelled') return

            const sid = normalizeSessionId(job?.sessionId || '')
            const dc = job?.docContext || null
            const docName = String(dc?.name || '').trim()
            const hostHint = String(dc?.hostApp || '').trim() || String(wpsBridge.getHostApp() || '').trim()

            const looksLikeNoPlanBlock = errCode === 'no_plan_block'
            const looksLikeJsWritebackRequired = errCode === 'json_writeback_required'

            const looksLikeLegacyParamsPlan = (() => {
                // Backend strict schema errors when LLM returns { op:'upsert_block', params:{...} }.
                const t = err.toLowerCase()
                return t.includes("extra_forbidden") && t.includes("params") && t.includes("upsert_block")
            })()
            const looksLikeUnexpectedToken = (() => {
                const t = err.toLowerCase()
                return t.includes('syntaxerror') && (t.includes('invalid or unexpected token') || t.includes('unexpected token'))
            })()
            const looksLikeHostAppMismatch = (() => {
                const t = err.toLowerCase()
                return t.includes('host_app mismatch') || t.includes('hostapp mismatch')
            })()
            const looksLikeUpsertBlockMissingActions = (() => {
                const t = err.toLowerCase()
                return (
                    t.includes('upsert_block')
                    && (
                        t.includes('requires non-empty actions')
                        || t.includes('actions is not iterable')
                        || t.includes('not iterable')
                    )
                )
            })()
            const looksLikePlanExecutorNotAvailable = (() => {
                const t = err.toLowerCase()
                return (
                    t.includes('plan executor not available') ||
                    t.includes('load plan-executor failed') ||
                    t.includes('加载 plan 执行器失败') ||
                    t.includes('加载plan执行器失败')
                )
            })()
            const looksLikeInvalidPlan = (() => {
                const t = err.toLowerCase()
                return t.includes('invalid plan')
            })()
            const looksLikeBackendNormalizeBug = (() => {
                const t = err.toLowerCase()
                return (
                    t.includes('_normalize_action') ||
                    t.includes('normalize_plan_payload') ||
                    t.includes('missing 1 required keyword-only argument')
                )
            })()

            const dedupKey = `${sid}::${blockId}::${errCode || err}`.slice(0, 220)
            const now = Date.now()
            const last = _macroErrorNotifyDedup.get(dedupKey) || 0
            if (now - last < 2500) return
            _macroErrorNotifyDedup.set(dedupKey, now)

            let extraHint = looksLikeLegacyParamsPlan
                ? "\n提示：检测到 Plan 使用了 params/content/format 这类非 schema 字段，通常是后端未更新或未重启；请先重启后端再重试写回。"
                : looksLikeNoPlanBlock
                  ? `\n提示：当前消息里没有可执行的 Plan JSON。请让模型只输出 Plan JSON（schema_version=\"ah32.plan.v1\"${hostHint ? `, host_app=\"${hostHint}\"` : ''}），然后再点击“应用写回”。`
                  : looksLikeJsWritebackRequired
                    ? "\n提示：检测到 JS 宏代码块；当前分支仅支持 Plan JSON 写回。请让模型输出 ah32.plan.v1 的 Plan JSON。"
                    : looksLikeUnexpectedToken
                      ? "\n提示：该错误通常由“智能引号/全角标点/不可见字符”导致；新版前端会在执行前自动清洗。请刷新任务窗格/更新插件后重试。"
                      : looksLikePlanExecutorNotAvailable
                        ? "\n提示：Plan 执行器未加载，通常是前端资源未完整加载（代码分割 chunk 丢失/缓存损坏/版本不一致）。请先刷新任务窗格或更新插件；仍不行请重启 WPS 后再试。"
                        : ""
            if (!extraHint && looksLikeBackendNormalizeBug) {
                extraHint =
                    "\n提示：该错误更像后端 Plan 归一化/校验代码异常（版本不一致或未重启）。请先更新并重启后端后再试。"
            }
            if (!extraHint && looksLikeHostAppMismatch) {
                extraHint = "\n提示：Plan.host_app 与当前宿主不一致（wps/et/wpp）。请让模型输出正确的 host_app 后再写回，或确保当前前台就是目标文档。"
            } else if (!extraHint && looksLikeUpsertBlockMissingActions) {
                extraHint = "\n提示：upsert_block 必须提供非空 actions: [...]；不要把写回内容塞到 content/options 这类旧字段里。请让模型按 ah32.plan.v1 输出 upsert_block.actions。"
            }
            const suggestion = looksLikeInvalidPlan
                ? "建议：该错误属于 Plan 归一化/校验失败（通常与文档前台无关）。请让模型按错误信息修复 Plan JSON 或重新生成后再写回。"
                : "建议：确认目标文档仍打开并处于前台，然后点击“应用写回”重试；必要时截图反馈。"
            const chatText = `【写回失败】${docName ? `文档：${docName}；` : ''}块：${blockId}。\n原因：${err}\n${suggestion}${extraHint}`
            _addSystemMessageToSessionBucketSafe(sid || currentSessionId.value || '__default__', chatText, dc || undefined)

            const shortErr = err.length > 280 ? `${err.slice(0, 260)}...` : err
            let toastHint = looksLikeLegacyParamsPlan
                ? "\n提示：请重启后端。"
                : looksLikeNoPlanBlock
                  ? "\n提示：请让模型输出 Plan JSON 后再写回。"
                  : looksLikeJsWritebackRequired
                    ? "\n提示：请改为输出 Plan JSON。"
                    : looksLikeUnexpectedToken
                      ? "\n提示：刷新任务窗格/更新插件。"
                      : looksLikePlanExecutorNotAvailable
                        ? "\n提示：刷新任务窗格/更新插件；必要时重启 WPS。"
                        : ""
            if (!toastHint && looksLikeBackendNormalizeBug) {
                toastHint = "\n提示：重启后端。"
            }
            if (!toastHint && looksLikeHostAppMismatch) {
                toastHint = "\n提示：host_app 不一致。"
            } else if (!toastHint && looksLikeUpsertBlockMissingActions) {
                toastHint = "\n提示：upsert_block 缺少 actions。"
            }
            const toastSuggestion = looksLikeInvalidPlan
                ? "建议：请修复/重新生成 Plan JSON 后再写回。"
                : "建议：确认目标文档仍打开并处于前台，然后重试写回。"
            const toastMsg = `${docName ? `文档：${docName}\n` : ''}块：${blockId}\n原因：${shortErr}\n${toastSuggestion}${toastHint}`
            _uiNotify({ type: 'error', title: '写回失败', message: toastMsg, durationMs: 0 })

            try {
                logToBackend?.(`[MacroQueue] writeback failed block=${blockId} err=${errCode || err}`)
            } catch (e) {
                ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
            }
        } catch (e) {
            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
        }
    }

    // 添加思考消息
    const addThinkingMessage = (thinking: string) => {
        const message = createMessage('thinking', '', thinking)
        addMessage(message)
        return message
    }

    // 更新思考消息
    const updateThinkingMessage = (messageId: string, thinking: string) => {
        const message = messages.value.find(m => m.id === messageId)
        if (message) {
            message.thinking = thinking
        }
    }

    type ActiveDocMeta = {
        id: string
        name: string
        path: string
        hostApp: string
        docKey: string
    }

    type DocMeta = ActiveDocMeta & {
        isActive?: boolean
        normName?: string
    }

    const normalizeDocName = (name: string): string => {
        try {
            const raw = String(name || '').trim().toLowerCase()
            if (!raw) return ''
            return raw.replace(/\.(docx|doc|wps|wpt|pptx|ppt|dps|xlsx|xls|et)$/i, '')
        } catch (e) {
            logger.warn('[chat] normalizeDocName failed (ignored)', e)
            return String(name || '').trim().toLowerCase()
        }
    }

    const computeDocKey = (args: { hostApp?: string; id?: string; path?: string; name?: string }, allDocs?: any[]): string => {
        try {
            const host = String(args?.hostApp || wpsBridge.getHostApp() || 'unknown').trim() || 'unknown'
            const id = String(args?.id || '').trim()
            const path = String(args?.path || '').trim()
            const name = String(args?.name || '').trim()

            // Strongest identity: host + docId (wpsBridge ensures docId is stable per opened document).
            if (id) return `${host}:${id}`

            // Next: host + full path (stable for saved docs).
            if (path) return `${host}:${path}`

            // Last resort: host + name (may collide). Add a de-dupe suffix if possible.
            if (name) {
                let suffix = ''
                try {
                    const list = Array.isArray(allDocs) ? allDocs : []
                    const matches = list.filter((d: any) => String(d?.name || '').trim() === name)
                    if (matches.length > 1) {
                        const idx = matches.findIndex((d: any) => String(d?.id || '').trim() === id && id)
                        if (idx >= 0) suffix = `#${idx + 1}`
                    }
                } catch (e) {
                  ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                }
                return `${host}:name:${name}${suffix}`
            }

            return ''
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
            return ''
        }
    }

    const buildDocMetasFromDocs = (docs: any[]): DocMeta[] => {
        const out: DocMeta[] = []
        try {
            for (const d of docs || []) {
                const name = String((d as any)?.name || '').trim()
                const path = String((d as any)?.fullPath || '').trim()
                const id = String((d as any)?.id || '').trim()
                const hostApp = String((d as any)?.hostApp || wpsBridge.getHostApp() || 'unknown').trim() || 'unknown'
                const docKey = computeDocKey({ hostApp, id, path, name }, docs)
                if (!docKey) continue
                out.push({
                    id,
                    name,
                    path,
                    hostApp,
                    docKey,
                    isActive: !!(d as any)?.isActive,
                    normName: normalizeDocName(name)
                })
            }
        } catch (e) {
            logger.warn('[chat] buildDocMetasFromDocs failed (ignored)', e)
        }
        return out
    }

    const migratePersistedSessionDocKey = (sid: string, nextDocKey: string) => {
        try {
            const s = normalizeSessionId(sid)
            if (!s || s === '__default__') return

            const docKey = String(nextDocKey || '').trim()
            if (!docKey) return

            // Update IndexedDB record (preferred).
            if (chatSessionStore.isAvailable()) {
                void chatSessionStore.getSession<PersistedChatSession>(s).then((row) => {
                    if (!row) return
                    if (String((row as any).docKey || '') === docKey) return
                    ;(row as any).docKey = docKey
                    ;(row as any).savedAt = new Date().toISOString()
                    return chatSessionStore.setSession(row as any)
                }).catch((e) => logger.warn('[chat] migratePersistedSessionDocKey idb failed (ignored)', e))
            }

            // Keep localStorage fallback in sync when present.
            try {
                if (typeof localStorage !== 'undefined') {
                    const raw = localStorage.getItem(sessionStorageKey(s))
                    if (!raw) return
                    const parsed = safeJsonParse<PersistedChatSession>(raw)
                    if (!parsed || typeof parsed !== 'object') return
                    if (String(parsed.docKey || '') === docKey) return
                    parsed.docKey = docKey
                    parsed.savedAt = new Date().toISOString()
                    localStorage.setItem(sessionStorageKey(s), JSON.stringify(parsed))
                }
            } catch (e) {
                logger.warn('[chat] migratePersistedSessionDocKey localStorage failed (ignored)', e)
            }
        } catch (e) {
            logger.warn('[chat] migratePersistedSessionDocKey failed (ignored)', e)
        }
    }

    const updateDocContextForSession = (sid: string, prev: DocMeta, next: DocMeta) => {
        try {
            const s = normalizeSessionId(sid)
            if (!s || s === '__default__') return
            const bucket = getBucketMessages(s)
            for (const msg of bucket) {
                const meta: any = (msg as any)?.metadata
                const dc: any = meta?.docContext
                if (!dc) continue
                const matchKey = String(dc.docKey || '').trim() === String(prev.docKey || '').trim()
                const matchId = String(dc.docId || '').trim() === String(prev.id || '').trim()
                if (!matchKey && !matchId) continue
                meta.docContext = {
                    ...dc,
                    docId: String(next.id || '').trim(),
                    docKey: String(next.docKey || '').trim(),
                    name: String(next.name || '').trim(),
                    path: String(next.path || '').trim(),
                    hostApp: String(next.hostApp || '').trim()
                }
            }
            schedulePersistSessionBucketById(s, bucket)
        } catch (e) {
            logger.warn('[chat] updateDocContextForSession failed (ignored)', e)
        }
    }

    const updateQueuedJobsForDoc = (prev: DocMeta, next: DocMeta) => {
        try {
            const prevKey = String(prev.docKey || '').trim()
            const prevId = String(prev.id || '').trim()
            for (const job of macroJobQueue.value) {
                const dc = job?.docContext
                if (!dc) continue
                const matchKey = String(dc.docKey || '').trim() === prevKey
                const matchId = String(dc.docId || '').trim() === prevId
                if (!matchKey && !matchId) continue
                job.docContext = {
                    ...dc,
                    docId: String(next.id || '').trim(),
                    docKey: String(next.docKey || '').trim(),
                    name: String(next.name || '').trim(),
                    path: String(next.path || '').trim(),
                    hostApp: String(next.hostApp || '').trim()
                }
            }
        } catch (e) {
            logger.warn('[chat] updateQueuedJobsForDoc failed (ignored)', e)
        }
    }

    const pickDocCandidate = (candidates: DocMeta[]): DocMeta | null => {
        if (!candidates || candidates.length === 0) return null
        if (candidates.length === 1) return candidates[0] || null
        const active = candidates.filter(c => !!c.isActive)
        if (active.length === 1) return active[0] || null
        return null
    }

    let lastDocMetas: DocMeta[] = []
    const maybeMigrateDocKeysAfterSave = (docs: any[]) => {
        try {
            const metas = buildDocMetasFromDocs(docs || [])
            const prevMetas = lastDocMetas
            lastDocMetas = metas
            if (!prevMetas || prevMetas.length === 0) return

            const currentKeys = new Set(metas.map(m => m.docKey))
            const prevUnsaved = prevMetas.filter(m => !String(m.path || '').trim())
            if (prevUnsaved.length === 0) return

            const prevUnsavedByName = new Map<string, DocMeta[]>()
            for (const m of prevUnsaved) {
                const key = `${m.hostApp || ''}::${m.normName || normalizeDocName(m.name || '')}`
                const arr = prevUnsavedByName.get(key) || []
                arr.push(m)
                prevUnsavedByName.set(key, arr)
            }

            const migratePair = (from: DocMeta, to: DocMeta, reason: string): boolean => {
                const fromKey = String(from?.docKey || '').trim()
                const toKey = String(to?.docKey || '').trim()
                if (!fromKey || !toKey || fromKey === toKey) return false
                if (currentKeys.has(fromKey)) return false
                const sid = docKeyToSessionId.value[fromKey]
                if (!sid || docKeyToSessionId.value[toKey]) return false
                docKeyToSessionId.value[toKey] = sid
                delete docKeyToSessionId.value[fromKey]
                if (currentDocKey.value === fromKey) currentDocKey.value = toKey
                migratePersistedSessionDocKey(sid, toKey)
                updateDocContextForSession(sid, from, to)
                updateQueuedJobsForDoc(from, to)
                persistIndex()
                logger.info(`[chat] migrated docKey (${reason}) ${fromKey} -> ${toKey}`)
                return true
            }

            const prevActiveUnsaved = prevUnsaved.find(m => m.isActive)
            const currActiveUnsaved = metas.find(m => !!m.isActive && !String(m.path || '').trim())
            const currActiveSaved = metas.find(m => !!m.isActive && !!String(m.path || '').trim())

            // Handle "Save As" / rename while still unsaved:
            // some WPS builds update the document Name (and thus docId/docKey) before FullName/Path becomes available.
            // If we don't migrate at this stage, the UI may bind to a fresh session id and the original chat history
            // appears "lost" after rename/save.
            if (prevActiveUnsaved && currActiveUnsaved && prevActiveUnsaved.hostApp === currActiveUnsaved.hostApp) {
                const prevUnsavedCount = prevUnsaved.length
                const currUnsavedCount = metas.filter(m => !String(m.path || '').trim()).length
                if (prevUnsavedCount === 1 && currUnsavedCount === 1) {
                    if (migratePair(prevActiveUnsaved, currActiveUnsaved, 'active_rename')) return
                }
            }

            if (prevActiveUnsaved && currActiveSaved && prevActiveUnsaved.hostApp === currActiveSaved.hostApp) {
                if (migratePair(prevActiveUnsaved, currActiveSaved, 'active_save')) return
            }

            for (const m of metas) {
                if (!String(m.path || '').trim()) continue
                if (docKeyToSessionId.value[m.docKey]) continue
                const key = `${m.hostApp || ''}::${m.normName || normalizeDocName(m.name || '')}`
                const candidates = (prevUnsavedByName.get(key) || []).filter(c => !currentKeys.has(c.docKey))
                const pick = pickDocCandidate(candidates)
                if (pick) {
                    migratePair(pick, m, 'name_match')
                }
            }
        } catch (e) {
            logger.warn('[chat] maybeMigrateDocKeysAfterSave failed (ignored)', e)
        }
    }

    const getActiveDocumentMeta = (): ActiveDocMeta | null => {
        try {
            const docs = wpsBridge.getAllOpenDocuments()
            const active = docs.find(d => d.isActive)
            if (!active) return null
            const name = String(active.name || '').trim()
            const path = String(active.fullPath || '').trim()
            const id = String(active.id || '').trim()
            const hostApp = String((active as any).hostApp || wpsBridge.getHostApp() || 'unknown').trim() || 'unknown'
            const docKey = computeDocKey({ hostApp, id, path, name }, docs)
            if (!docKey) return null
            return { id, name, path, hostApp, docKey }
        } catch (e) {
            logger.warn('[chat] getActiveDocumentMeta failed:', e)
            return null
        }
    }

    let docSyncTimer: any = null
    let removeDocChangeListener: (() => void) | null = null

    const scheduleSyncSessionToActiveDocument = () => {
        try {
            if (docSyncTimer) clearTimeout(docSyncTimer)
            docSyncTimer = setTimeout(() => {
                syncSessionToActiveDocument().catch((e) => { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e) })
            }, 150)
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
            // ignore
        }
    }

    const resetSessionScopedState = () => {
        // Legacy helper kept for callers that expect it, but it MUST NOT clear message buckets anymore.
        // Clearing buckets detaches in-flight SSE streams and the UI will show "only user messages".
        lastUserQuery.value = ''
        lastMacroBlockId.value = null
        pendingMacroUpdateBlockId.value = null
        pendingMacroClarification.value = null
        pendingRenameTargetBlockId.value = null
        // NOTE: runtime/observability is stored per-session in `runtimeBySession`.
    }

    const resolveSessionIdForDocument = async (doc: ActiveDocMeta): Promise<string> => {
        const key = doc.docKey
        let cached = docKeyToSessionId.value[key]

        // One-time migration for docKey scheme changes:
        // older builds used (path || id || name) without host prefix; keep history if possible.
        if (!cached) {
            try {
                const legacyKeys = [doc.path, doc.id, doc.name]
                    .map((x) => String(x || '').trim())
                    .filter(Boolean)
                for (const lk of legacyKeys) {
                    const v = docKeyToSessionId.value[lk]
                    if (v) {
                        docKeyToSessionId.value[key] = v
                        cached = v
                        break
                    }
                }
            } catch (e) {
              ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
            }
        }
        if (cached) {
            const cachedNorm = normalizeSessionId(cached)
            const isTemp = cachedNorm === '__default__' || cachedNorm.startsWith('temp_')
            const isLegacy = /^session_[a-f0-9]{32}_\d+_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cachedNorm)
            // If we already have a deterministic session id, keep it (fast path).
            // If it's legacy/non-deterministic, re-resolve via backend and migrate bucket best-effort.
            if (!isTemp && !isLegacy) return cachedNorm
        }

        // De-dupe concurrent requests for the same document key.
        try {
            const w = typeof window !== 'undefined' ? (window as any) : null
            if (w) {
                if (!w.__ah32_session_id_inflight) w.__ah32_session_id_inflight = new Map()
                const inflight: Map<string, Promise<string>> = w.__ah32_session_id_inflight
                if (inflight.has(key)) return await inflight.get(key)
                const p = (async () => {
                    try {
                        const sessionStore = useSessionStore()
                        return await sessionStore.generateSessionIdFromBackend({
                            name: doc.name,
                            path: doc.path,
                            id: doc.id,
                            hostApp: doc.hostApp
                        })
                    } finally {
                        try { inflight.delete(key) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e) }
                    }
                })()
                inflight.set(key, p)
                const sid = await p

                // Best-effort migration for legacy/non-deterministic ids (only when we had an old id for THIS docKey).
                try {
                    if (typeof localStorage !== 'undefined') {
                        const oldSid = normalizeSessionId(cached || '')
                        const newSid = normalizeSessionId(sid)
                        if (
                            oldSid &&
                            newSid &&
                            oldSid !== '__default__' &&
                            !oldSid.startsWith('temp_') &&
                            oldSid !== newSid
                        ) {
                            const oldKey = sessionStorageKey(oldSid)
                            const newKey = sessionStorageKey(newSid)
                            const oldRaw = localStorage.getItem(oldKey)
                            if (oldRaw && !localStorage.getItem(newKey)) {
                                localStorage.setItem(newKey, oldRaw)
                            }
                            // Update the payload's sessionId when possible.
                            try {
                                const parsed = safeJsonParse<any>(oldRaw || '')
                                if (parsed && typeof parsed === 'object') {
                                    parsed.sessionId = newSid
                                    localStorage.setItem(newKey, JSON.stringify(parsed))
                                }
                            } catch (e) {
                              ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                            }
                            localStorage.removeItem(oldKey)
                        }
                    }

                    // Also migrate IndexedDB bucket (preferred persistence on WPS).
                    try {
                        if (chatSessionStore.isAvailable()) {
                            void (async () => {
                                const oldSid = normalizeSessionId(cached || '')
                                const newSid = normalizeSessionId(sid)
                                if (!oldSid || !newSid || oldSid === newSid) return
                                const oldRow = await chatSessionStore.getSession<any>(oldSid)
                                if (!oldRow) return
                                const exists = await chatSessionStore.getSession<any>(newSid)
                                if (exists) {
                                    await chatSessionStore.deleteSession(oldSid)
                                    return
                                }
                                oldRow.sessionId = newSid
                                oldRow.docKey = key
                                oldRow.savedAt = new Date().toISOString()
                                await chatSessionStore.setSession(oldRow)
                                await chatSessionStore.deleteSession(oldSid)
                            })().catch((e) => logger.warn('[chat] migrate session bucket idb failed (ignored)', e))
                        }
                    } catch (e) {
                      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                    }
                } catch (e) {
                  ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                }

                docKeyToSessionId.value[key] = sid
                return sid
            }
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
            // ignore; fallback to normal path below
        }

        try {
            const sessionStore = useSessionStore()
            const sid = await sessionStore.generateSessionIdFromBackend({
                name: doc.name,
                path: doc.path,
                id: doc.id,
                hostApp: doc.hostApp
            })

            // Best-effort migration: only when we previously had a non-deterministic id for THIS docKey.
            try {
                if (typeof localStorage !== 'undefined') {
                    const oldSid = normalizeSessionId(cached || '')
                    const newSid = normalizeSessionId(sid)
                    if (
                        oldSid &&
                        newSid &&
                        oldSid !== '__default__' &&
                        !oldSid.startsWith('temp_') &&
                        oldSid !== newSid
                    ) {
                        const oldKey = sessionStorageKey(oldSid)
                        const newKey = sessionStorageKey(newSid)
                        const oldRaw = localStorage.getItem(oldKey)
                        const newRaw = localStorage.getItem(newKey)
                        if (oldRaw && !newRaw) {
                            // Update the payload's sessionId when possible.
                            const parsed = safeJsonParse<any>(oldRaw)
                            if (parsed && typeof parsed === 'object') {
                                parsed.sessionId = newSid
                                parsed.docKey = key
                                parsed.savedAt = new Date().toISOString()
                                localStorage.setItem(newKey, JSON.stringify(parsed))
                            } else {
                                localStorage.setItem(newKey, oldRaw)
                            }
                            localStorage.removeItem(oldKey)
                        }
                    }
                }

                // Also migrate IndexedDB bucket (preferred persistence on WPS).
                try {
                    if (chatSessionStore.isAvailable()) {
                        void (async () => {
                            const oldSid = normalizeSessionId(cached || '')
                            const newSid = normalizeSessionId(sid)
                            if (!oldSid || !newSid || oldSid === newSid) return
                            const oldRow = await chatSessionStore.getSession<any>(oldSid)
                            if (!oldRow) return
                            const exists = await chatSessionStore.getSession<any>(newSid)
                            if (exists) {
                                await chatSessionStore.deleteSession(oldSid)
                                return
                            }
                            oldRow.sessionId = newSid
                            oldRow.docKey = key
                            oldRow.savedAt = new Date().toISOString()
                            await chatSessionStore.setSession(oldRow)
                            await chatSessionStore.deleteSession(oldSid)
                        })().catch((e) => logger.warn('[chat] migrate session bucket idb failed (ignored)', e))
                    }
                } catch (e) {
                  ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                }
            } catch (e) {
              ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
            }

            docKeyToSessionId.value[key] = sid
            return sid
        } catch (e) {
            logger.warn('[chat] resolveSessionIdForDocument failed, fallback temp:', e)
            const sid = `temp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
            docKeyToSessionId.value[key] = sid
            return sid
        }
    }

    const switchToSessionBucket = async (sessionId: string, doc?: ActiveDocMeta | null) => {
        const nextSid = normalizeSessionId(sessionId)
        const currentSid = normalizeSessionId(currentSessionId.value)
        const nextDocKey = doc?.docKey || ''

        if (currentSid === nextSid && (!nextDocKey || currentDocKey.value === nextDocKey)) {
            return
        }

        // Persist current bucket before switching away, but don't block UI switching.
        try {
            const sid = normalizeSessionId(currentSessionId.value)
            const snapshot = {
                sid,
                docKey: currentDocKey.value || '',
                messages: getBucketMessages(sid).slice(),
                lastUserQuery: lastUserQuery.value,
                lastMacroBlockId: lastMacroBlockId.value,
                lastMacroBlockIdBySession: { ...(lastMacroBlockIdBySession.value || {}) },
                macroArtifacts: macroArtifacts.value.slice(),
                executedMacroMessageIds: executedMacroMessageIds.value.slice(),
                macroBlockRuns: { ...(macroBlockRuns.value || {}) }
            }
            setTimeout(() => {
                try {
                    if (!snapshot.sid || snapshot.sid === '__default__') return
                    const payload: PersistedChatSession = {
                        version: CHAT_SESSION_VERSION,
                        savedAt: new Date().toISOString(),
                        sessionId: snapshot.sid,
                        docKey: snapshot.docKey || undefined,
                        messages: normalizeMessagesForStorage(snapshot.messages),
                        lastUserQuery: snapshot.lastUserQuery,
                        lastMacroBlockId: snapshot.lastMacroBlockId,
                        lastMacroBlockIdBySession: snapshot.lastMacroBlockIdBySession,
                        macroArtifacts: snapshot.macroArtifacts,
                        executedMacroMessageIds: snapshot.executedMacroMessageIds,
                        macroBlockRuns: snapshot.macroBlockRuns
                    }

                    if (chatSessionStore.isAvailable()) {
                        void chatSessionStore.setSession(payload as any).catch((e) => {
                            logger.warn('[chat] switchToSessionBucket snapshot idb failed, fallback to localStorage', e)
                            try {
                                if (typeof localStorage !== 'undefined') {
                                    localStorage.setItem(
                                        sessionStorageKey(snapshot.sid),
                                        JSON.stringify({ ...payload, messages: normalizeMessagesForLocalStorage(snapshot.messages) })
                                    )
                                }
                            } catch (e2) { /* ignore */ }
                        })
                    } else {
                        try {
                            if (typeof localStorage !== 'undefined') {
                                localStorage.setItem(
                                    sessionStorageKey(snapshot.sid),
                                    JSON.stringify({ ...payload, messages: normalizeMessagesForLocalStorage(snapshot.messages) })
                                )
                            }
                        } catch (e2) { /* ignore */ }
                    }
                } catch (e) {
                  ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                    // ignore
                }
            }, 0)
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
            // ignore
        }

        resetSessionScopedState()
        currentSessionId.value = nextSid
        currentDocKey.value = nextDocKey

        // Switch UI pointer immediately (no flicker / no detached arrays).
        messages.value = getBucketMessages(nextSid)

        // Load the bucket from storage if it exists and hasn't been loaded yet.
        try {
            if (messages.value.length === 0) restoreSessionBucket(nextSid)
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
        }

        // Keep macro targeting consistent with the active session.
        syncLastMacroBlockIdForSession(nextSid)
        restoredFromStorage.value = messages.value.length > 0
        persistIndex()
    }

    // Public helper: allow dev tools (MacroBench etc.) to force the visible bucket.
    // Avoid exposing internal doc meta types across the store boundary.
    const switchToSession = async (sessionId: string, opts?: { bindToActiveDocument?: boolean }) => {
        const doc = opts?.bindToActiveDocument ? getActiveDocumentMeta() : null
        await switchToSessionBucket(sessionId, doc)
    }

    const syncSessionToActiveDocument = async () => {
        const doc = getActiveDocumentMeta()
        if (!doc) return
        const sid = await resolveSessionIdForDocument(doc)
        await switchToSessionBucket(sid, doc)
    }

    const initDocumentSessionSync = () => {
        try {
            if (removeDocChangeListener) return
            if (!wpsBridge.isInWPSEnvironment()) return

            // Ensure the unified "document watcher" is running (idempotent).
            wpsBridge.initDocumentEventListeners().catch((e) => { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e) })

            const prewarmSessionsForDocs = async (docs: any[]) => {
                try {
                    maybeMigrateDocKeysAfterSave(docs as any)
                    // Pre-resolve session ids for all open docs so switching buckets is instant.
                    const seen = new Set<string>()
                    const metas: ActiveDocMeta[] = []
                    for (const d of docs || []) {
                        const name = String((d as any)?.name || '').trim()
                        const path = String((d as any)?.fullPath || '').trim()
                        const id = String((d as any)?.id || '').trim()
                        const hostApp = String((d as any)?.hostApp || wpsBridge.getHostApp() || 'unknown').trim() || 'unknown'
                        const docKey = computeDocKey({ hostApp, id, path, name }, docs)
                        if (!docKey || seen.has(docKey)) continue
                        seen.add(docKey)
                        metas.push({ id, name, path, hostApp, docKey })
                    }

                    // Only prewarm missing/legacy mappings.
                    const isBad = (sid: any) => {
                        const s = normalizeSessionId(sid || '')
                        if (!s) return true
                        if (s === '__default__') return true
                        if (s.startsWith('temp_')) return true
                        return /^session_[a-f0-9]{32}_\d+_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
                    }

                    const pending = metas.filter(m => isBad(docKeyToSessionId.value[m.docKey]))
                    if (pending.length === 0) return

                    // Limit concurrency to keep UI smooth.
                    const concurrency = 3
                    for (let i = 0; i < pending.length; i += concurrency) {
                        const batch = pending.slice(i, i + concurrency)
                        await Promise.allSettled(batch.map(async (m) => {
                            const sid = await resolveSessionIdForDocument(m)
                            docKeyToSessionId.value[m.docKey] = sid
                        }))
                    }
                } catch (e) {
                  ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                    // ignore
                }
            }

            removeDocChangeListener = wpsBridge.addDocumentChangeListener((docs) => {
                prewarmSessionsForDocs(docs as any).catch((e) => { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e) })
                scheduleSyncSessionToActiveDocument()
            })

            // First sync after reload so buckets match the real active document.
            scheduleSyncSessionToActiveDocument()
            // Also prewarm immediately for already-open docs.
            prewarmSessionsForDocs(wpsBridge.getAllOpenDocuments() as any).catch((e) => { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e) })
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
            // ignore
        }
    }



    // 清空消息
    const clearMessages = () => {
        const sid = normalizeSessionId(currentSessionId.value)
        try {
            const b = getBucketMessages(sid)
            b.length = 0
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
        }
        messages.value = []
        currentSessionId.value = null
        currentDocKey.value = ''
        lastUserQuery.value = ''
        lastMacroBlockId.value = null
        lastMacroBlockIdBySession.value = {}
        pendingMacroUpdateBlockId.value = null
        macroArtifacts.value = []
        pendingMacroClarification.value = null
        pendingRenameTargetBlockId.value = null
        executedMacroMessageIds.value = []
        macroBlockRuns.value = {}
        restoredFromStorage.value = false
        try {
            // Clear only the active session bucket; keep other documents' history.
            if (chatSessionStore.isAvailable()) {
                void chatSessionStore.deleteSession(sid).catch((e) => logger.warn('[chat] delete session idb failed (ignored)', e))
            }
            if (typeof localStorage !== 'undefined') {
                localStorage.removeItem(sessionStorageKey(sid))
            }
            persistIndex()
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
        }
    }

    const cancelCurrentRequest = (sessionId?: string): boolean => {
        const sid = normalizeSessionId(sessionId || currentSessionId.value)
        const rt = getRuntime(sid)
        if (!rt.isSending) return false
        if (rt.cancelRequested) return true
        rt.cancelRequested = true
        rt.lastStreamCancelled = true
        try {
            rt.abortController?.abort()
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
        }
        try {
            cancelPendingMacroJobs({ sessionId: sid })
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
        }
        // Keep UX minimal: one short system line, user can type "继续" to resume.
        try {
            if (normalizeSessionId(currentSessionId.value) === sid) {
                addSystemMessage('已取消。想继续请输入“继续”。')
            }
        } catch (e) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
        }
        return true
    }

    const _nowIso = () => new Date().toISOString()
    const _randId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    const _extractMacroBlocksFromContent = (
        raw: string,
        messageId: string,
        opts?: { updateTargetBlockId?: string | null }
    ): MacroJobBlock[] => {
        const blocks: MacroJobBlock[] = []
        const content = String(raw || '')
        if (!content.trim()) return blocks

        const updateTarget = String(opts?.updateTargetBlockId || '').trim() || null

        const parsePlanCandidate = (candidate: string): any | null => {
            // IMPORTANT: this is a best-effort heuristic and must never throw.
            try {
                let text = String(candidate || '').trim()
                if (!text) return null

                // Common malformed cases from LLMs / markdown tools:
                // - fenced body captured as: "json\\n{...}" (unlabeled ``` fence but first line is language)
                // - accidental wrapping: "```json\\n{...}\\n```"
                try {
                    if (text.startsWith('```')) {
                        text = text.replace(/^```[a-z0-9_.-]*\s*/i, '').replace(/```$/i, '').trim()
                    }
                    const nl = text.indexOf('\n')
                    if (nl > 0 && nl <= 20) {
                        const first = text.slice(0, nl).trim().toLowerCase()
                        const rest = text.slice(nl + 1).trim()
                        if ((first === 'json' || first === 'plan' || first.startsWith('ah32')) && rest.startsWith('{')) {
                            text = rest
                        }
                    }
                } catch (e) {
                    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                }

                try {
                    const parsed = JSON.parse(text)
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                        const schemaVersion = String(
                            (parsed as any).schema_version
                            || (parsed as any).schemaVersion
                            || (parsed as any).schema
                            || ''
                        ).trim()
                        if (schemaVersion === 'ah32.plan.v1') {
                            if (!(parsed as any).schema_version) (parsed as any).schema_version = schemaVersion
                            return parsed
                        }
                    }
                } catch (e) {
                    // Expected: most fenced blocks are not plans. Keep it debug-only and do not crash.
                    logger.debug('[MacroQueue] parsePlanCandidate direct JSON parse failed', e)
                }

                const firstBrace = text.indexOf('{')
                const lastBrace = text.lastIndexOf('}')
                if (firstBrace < 0 || lastBrace <= firstBrace) return null
                try {
                    const parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1))
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                        const schemaVersion = String(
                            (parsed as any).schema_version
                            || (parsed as any).schemaVersion
                            || (parsed as any).schema
                            || ''
                        ).trim()
                        if (schemaVersion === 'ah32.plan.v1') {
                            if (!(parsed as any).schema_version) (parsed as any).schema_version = schemaVersion
                            return parsed
                        }
                    }
                } catch (e) {
                    logger.debug('[MacroQueue] parsePlanCandidate brace-extract parse failed', e)
                }
                return null
            } catch (e) {
                // Absolutely never crash writeback queue due to parsing heuristics.
                logger.debug('[MacroQueue] parsePlanCandidate fatal guard', e)
                ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                return null
            }
        }

        const extractBalancedJsonObjects = (text: string): string[] => {
            const objects: string[] = []
            const source = String(text || '')
            let objectStart = -1
            let depth = 0
            let inString = false
            let escaped = false
            for (let index = 0; index < source.length; index++) {
                const char = source[index]
                if (objectStart < 0) {
                    if (char === '{') {
                        objectStart = index
                        depth = 1
                        inString = false
                        escaped = false
                    }
                    continue
                }
                if (inString) {
                    if (escaped) {
                        escaped = false
                    } else if (char === '\\') {
                        escaped = true
                    } else if (char === '"') {
                        inString = false
                    }
                    continue
                }
                if (char === '"') {
                    inString = true
                    continue
                }
                if (char === '{') {
                    depth += 1
                    continue
                }
                if (char === '}') {
                    depth -= 1
                    if (depth === 0) {
                        objects.push(source.slice(objectStart, index + 1))
                        objectStart = -1
                    }
                }
            }
            return objects
        }

        const planCandidates: Array<{ plan: any; raw: string }> = []
        const seenPlanKeys = new Set<string>()
        const pushPlanCandidate = (rawCandidate: string) => {
            const parsed = parsePlanCandidate(rawCandidate)
            if (!parsed) return
            let key = ''
            try {
                key = JSON.stringify(parsed)
            } catch (e) {
                logger.debug('[MacroQueue] stringify parsed plan failed, fallback key', e)
                ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                key = `plan_${planCandidates.length + 1}`
            }
            if (seenPlanKeys.has(key)) return
            seenPlanKeys.add(key)
            planCandidates.push({ plan: parsed, raw: String(rawCandidate || '').trim() })
        }

        const planFenceRe = /```(?:json|plan|ah32[-_.]?plan(?:\.v1)?)\s*([\s\S]*?)```/gi
        let planFenceMatch: RegExpExecArray | null = null
        while ((planFenceMatch = planFenceRe.exec(content)) !== null) {
            const body = String(planFenceMatch[1] || '').trim()
            if (!body) continue
            pushPlanCandidate(body)
        }

        const unlabeledFenceRe = /```\s*([\s\S]*?)```/gi
        let unlabeledFenceMatch: RegExpExecArray | null = null
        while ((unlabeledFenceMatch = unlabeledFenceRe.exec(content)) !== null) {
            const body = String(unlabeledFenceMatch[1] || '').trim()
            if (!body) continue
            pushPlanCandidate(body)
        }

        if (
            !planCandidates.length
            && content.includes('ah32.plan.v1')
            && (
                content.includes('"schema_version"')
                || content.includes('"schemaVersion"')
                || content.includes('"schema"')
            )
        ) {
            pushPlanCandidate(content)
            if (!planCandidates.length) {
                const jsonObjects = extractBalancedJsonObjects(content)
                for (const objectText of jsonObjects) {
                    pushPlanCandidate(objectText)
                    if (planCandidates.length > 0) break
                }
            }
        }

        let pidx = 0
        for (const candidate of planCandidates) {
            const plan = candidate.plan

            const walkFind = (actions: any[]): string => {
                for (const a of actions || []) {
                    if (!a || typeof a !== 'object') continue
                    if (a.op === 'upsert_block' && typeof a.block_id === 'string') return String(a.block_id || '').trim()
                    if (a.op === 'delete_block' && typeof a.block_id === 'string') return String(a.block_id || '').trim()
                    if (Array.isArray(a.actions)) {
                        const nested = walkFind(a.actions)
                        if (nested) return nested
                    }
                }
                return ''
            }
            const walkOverride = (actions: any[], blockId: string): boolean => {
                for (const a of actions || []) {
                    if (!a || typeof a !== 'object') continue
                    if (a.op === 'upsert_block') {
                        a.block_id = blockId
                        return true
                    }
                    if (Array.isArray(a.actions) && walkOverride(a.actions, blockId)) return true
                }
                return false
            }

            // For updates, always reuse the target blockId (avoid LLM inventing a new id).
            if (updateTarget && pidx === 0) {
                try {
                    if (Array.isArray(plan.actions)) walkOverride(plan.actions, updateTarget)
                } catch (e) {
                    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                }
            }

            const blockId = (updateTarget && pidx === 0)
                ? updateTarget
                : (walkFind(plan.actions) || `plan_${messageId}_${pidx + 1}`)

            let normalizedCode = candidate.raw
            try {
                normalizedCode = JSON.stringify(plan)
            } catch (e) {
                logger.debug('[MacroQueue] stringify normalized plan failed, keep raw', e)
                ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
            }
            blocks.push({ type: 'plan', blockId, code: normalizedCode })
            pidx += 1
        }

        return blocks
    }

    const _looksLikeSseDoneMetaEnvelope = (content: string): boolean => {
        try {
            const s = String(content || '').trim()
            if (!s || s.length > 6000) return false
            if (!s.startsWith('{') || !s.endsWith('}')) return false
            return (
                s.includes('"session_id"')
                && s.includes('"elapsed_ms"')
                && s.includes('"token_usage"')
            )
        } catch (e) {
            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
            return false
        }
    }

    const enqueueMacroJobForAssistantMessage = (
        assistantMsg: Message,
        updateTargetBlockId?: string | null,
        opts?: { onlyBlockIds?: string[]; onlyTypes?: Array<'plan'>; excludeConfirm?: boolean }
    ) => {
        try {
            if (!assistantMsg || assistantMsg.type !== 'assistant') return
            const content = String(assistantMsg.content || '')

            const meta: any = (assistantMsg as any).metadata || {}
            const docContext = meta?.docContext || null
            let blocks = _extractMacroBlocksFromContent(content, assistantMsg.id, { updateTargetBlockId })
            if (!blocks.length) {
                try {
                    const hasJsFence = /```(?:javascript|js)\s*[\s\S]*?```/i.test(content)
                    const errCode = hasJsFence ? 'json_writeback_required' : 'no_plan_block'
                    const errMsg = hasJsFence
                        ? '检测到 JS 宏代码块；当前分支仅支持 Plan JSON 写回。'
                        : '未检测到可执行 Plan JSON 代码块。'

                    _notifyMacroWritebackError({
                        job: {
                            id: _randId('macrojob'),
                            createdAt: _nowIso(),
                            sessionId: normalizeSessionId(_findSessionIdForMessageId(assistantMsg.id) || currentSessionId.value || '__default__'),
                            messageId: assistantMsg.id,
                            docContext: docContext
                                ? {
                                    docId: String(docContext.docId || '').trim(),
                                    docKey: String(docContext.docKey || '').trim(),
                                    name: String(docContext.name || '').trim(),
                                    path: String(docContext.path || '').trim(),
                                    hostApp: String(docContext.hostApp || wpsBridge.getHostApp() || '').trim()
                                }
                                : null,
                            blocks: [],
                        },
                        blockId: updateTargetBlockId ? String(updateTargetBlockId) : `plan_${assistantMsg.id}`,
                        error: errMsg,
                        errCode,
                    })
                    emitTelemetryEvent(
                        'macro.exec_done',
                        { ok: false, type: 'plan', error: errCode },
                        {
                            run_id: _randId('macrojob'),
                            mode: 'macro',
                            host_app: String(docContext?.hostApp || wpsBridge.getHostApp() || ''),
                            doc_id: String(docContext?.docId || ''),
                            doc_key: String(docContext?.docKey || ''),
                            session_id: String(_findSessionIdForMessageId(assistantMsg.id) || currentSessionId.value || ''),
                            message_id: String(assistantMsg.id || ''),
                            block_id: updateTargetBlockId ? String(updateTargetBlockId) : `plan_${assistantMsg.id}`,
                        } as any
                    )
                } catch (e) {
                    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                }
                return
            }

            const onlyIds = Array.isArray(opts?.onlyBlockIds)
                ? opts?.onlyBlockIds.map((x) => String(x || '').trim()).filter((x) => !!x)
                : []
            if (onlyIds.length) {
                blocks = blocks.filter((b) => onlyIds.includes(String(b.blockId || '').trim()))
            }
            const onlyTypes = Array.isArray(opts?.onlyTypes)
                ? (opts?.onlyTypes as any[]).map((x) => String(x || '').trim()).filter((x) => x === 'plan')
                : []
            if (onlyTypes.length) {
                blocks = blocks.filter((b) => onlyTypes.includes(String((b as any).type || '').trim()))
            }
            if (opts?.excludeConfirm) {
                blocks = blocks.filter((b) => !b.confirm)
            }
            // Safety: auto-writeback (no explicit blockId selection) should execute at most one plan block.
            // LLMs may output multiple fenced plans (e.g. an extra "reply user" plan). Keep the rest visible
            // for manual apply, but don't auto-run them to avoid polluting the document.
            if (!onlyIds.length && opts?.excludeConfirm && blocks.length > 1) {
                blocks = blocks.slice(0, 1)
            }
            if (!blocks.length) return

            // Mark blocks as queued so UI can reflect "排队/执行中/成功/失败" without relying on component-local state.
            for (const b of blocks) {
                try {
                    setMacroBlockRun(b.blockId, {
                        status: 'queued',
                        messageId: assistantMsg.id,
                        error: undefined,
                        // For plan blocks, keep the JSON too so the card can render even if message content changes.
                        finalCode: b.code || undefined
                    })
                } catch (e) {
                  ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                }
            }

            const job: MacroJob = {
                id: _randId('macrojob'),
                createdAt: _nowIso(),
                sessionId: normalizeSessionId(_findSessionIdForMessageId(assistantMsg.id) || currentSessionId.value || '__default__'),
                messageId: assistantMsg.id,
                docContext: docContext
                    ? {
                        docId: String(docContext.docId || '').trim(),
                        docKey: String(docContext.docKey || '').trim(),
                        name: String(docContext.name || '').trim(),
                        path: String(docContext.path || '').trim(),
                        hostApp: String(docContext.hostApp || wpsBridge.getHostApp() || '').trim()
                    }
                    : null,
                blocks
            }
            macroJobQueue.value.push(job)
            try {
                emitTelemetryEvent(
                    'macro.queue_enqueued',
                    { blocks: (job.blocks || []).map(b => ({ block_id: b.blockId, type: b.type })) },
                    {
                        run_id: job.id,
                        mode: 'macro',
                        host_app: String(job.docContext?.hostApp || wpsBridge.getHostApp() || ''),
                        doc_id: String(job.docContext?.docId || ''),
                        doc_key: String(job.docContext?.docKey || ''),
                        session_id: String(job.sessionId || ''),
                        message_id: String(job.messageId || ''),
                    } as any
                )
            } catch (e: any) {
                logger.debug('[telemetry] emit macro.queue_enqueued failed', e)
            }
            void processMacroJobQueue()
        } catch (e: any) {
            logger.debug('[MacroQueue] enqueueMacroJobForAssistantMessage failed', e)
        }
    }

    const enqueueRollbackForBlockId = (args: { blockId: string; messageId: string; docContext?: any }) => {
        try {
            const blockId = String(args?.blockId || '').trim()
            const messageId = String(args?.messageId || '').trim()
            if (!blockId || !messageId) return

            // JS 宏通道已移除：回滚改为执行 Plan.delete_block(block_id)
            const hostApp = String(args?.docContext?.hostApp || wpsBridge.getHostApp() || 'wps').trim()
            const plan = {
                schema_version: 'ah32.plan.v1',
                host_app: (hostApp === 'et' || hostApp === 'wpp') ? hostApp : 'wps',
                meta: { kind: 'rollback' },
                actions: [
                    { id: `rollback_${blockId}`.slice(0, 64), title: 'Rollback block', op: 'delete_block', block_id: blockId },
                ],
            }
            const codeToRun = JSON.stringify(plan)
            setMacroBlockRun(blockId, { status: 'queued', messageId, error: undefined, finalCode: codeToRun })

            const dc = args?.docContext || null
            const job: MacroJob = {
                id: _randId('macrojob'),
                createdAt: _nowIso(),
                sessionId: normalizeSessionId(_findSessionIdForMessageId(messageId) || currentSessionId.value || '__default__'),
                messageId,
                docContext: dc
                    ? {
                        docId: String(dc.docId || '').trim(),
                        docKey: String(dc.docKey || '').trim(),
                        name: String(dc.name || '').trim(),
                        path: String(dc.path || '').trim(),
                        hostApp: String(dc.hostApp || wpsBridge.getHostApp() || '').trim()
                    }
                    : null,
                blocks: [{ type: 'plan', blockId, code: codeToRun }],
            }
            macroJobQueue.value.push(job)
            void processMacroJobQueue()
        } catch (e: any) {
            logger.debug('[MacroQueue] enqueueRollbackForBlockId failed', e)
        }
    }

    const processMacroJobQueue = async () => {
        if (macroJobRunning.value) return
        macroJobRunning.value = true
        try {
            while (macroJobQueue.value.length > 0) {
                try {
                    if (macroCancel.isCancelled()) {
                        logToBackend?.('[MacroQueue] cancelled by MacroCancel')
                        break
                    }
                } catch (e) {
                  ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                }

                const job = macroJobQueue.value.shift()!
                macroJobActiveSessionId.value = normalizeSessionId(job.sessionId)
                const docContext = job.docContext || null
                const docId = String(docContext?.docId || '').trim()
                const hostFromRuntime = String(wpsBridge.getHostApp() || '').trim()
                const hostFromContext = String(docContext?.hostApp || '').trim()
                const host = (hostFromRuntime && hostFromRuntime !== 'unknown') ? hostFromRuntime : hostFromContext

                // Plan repair needs stable context (session/doc/host).
                try {
                    planClient.setContext(String(job.sessionId || ''), String(docContext?.name || ''), host as any)
                } catch (e) {
                    logger.warn('[MacroQueue] set plan context failed (ignored)', e)
                }

                for (const b of job.blocks) {
                    const execStartAt = Date.now()
                    try {
                        if (macroCancel.isCancelled()) break
                    } catch (e) {
                      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                    }

                    try {
                        setMacroBlockRun(b.blockId, { status: 'running', messageId: job.messageId })
                    } catch (e) {
                      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                    }

                    try {
                        emitTelemetryEvent(
                            'macro.exec_start',
                            { type: b.type },
                            {
                                run_id: job.id,
                                mode: 'macro',
                                host_app: host,
                                doc_id: docId,
                                doc_key: String(job.docContext?.docKey || ''),
                                session_id: String(job.sessionId || ''),
                                message_id: String(job.messageId || ''),
                                block_id: b.blockId,
                            } as any
                        )
                    } catch (e: any) {
                        logger.debug('[telemetry] emit macro.exec_start failed', e)
                    }

                    // Strict: always bind to the originating document (id -> fullPath -> name).
                    // If we can't activate it, fail this block to avoid writing to the wrong doc.
                    try {
                        if (!docContext) {
                            const userMsg = '未找到目标文档，已停止写回。请在文档中重试。'
                            const errCode = 'document_context_missing'
                            try { setMacroBlockRun(b.blockId, { status: 'error', messageId: job.messageId, error: userMsg }) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e) }
                            try { _notifyMacroWritebackError({ job, blockId: b.blockId, error: userMsg, errCode }) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e) }
                            try {
                                emitTelemetryEvent(
                                    'macro.exec_done',
                                    { ok: false, exec_ms: Math.max(0, Date.now() - execStartAt), error: errCode },
                                    {
                                        run_id: job.id,
                                        mode: 'macro',
                                        host_app: host,
                                        doc_id: docId,
                                        doc_key: String(job.docContext?.docKey || ''),
                                        session_id: String(job.sessionId || ''),
                                        message_id: String(job.messageId || ''),
                                        block_id: b.blockId,
                                    } as any
                                )
                            } catch (e: any) {
                                logger.debug('[telemetry] emit macro.exec_done failed', e)
                            }
                            continue
                        }
                        const ok = wpsBridge.activateDocumentByContext({
                            docId: docContext.docId,
                            fullPath: docContext.path,
                            name: docContext.name
                        })
                        if (!ok) {
                            const userMsg = '目标文档不可用或已关闭，已停止写回。请重新打开文档后再试。'
                            const errCode = `document_not_active_or_closed:${docId || docContext.name || docContext.path || ''}`
                            setMacroBlockRun(b.blockId, { status: 'error', messageId: job.messageId, error: userMsg })
                            try { _notifyMacroWritebackError({ job, blockId: b.blockId, error: userMsg, errCode }) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e) }
                            try {
                                emitTelemetryEvent(
                                    'macro.exec_done',
                                    { ok: false, exec_ms: Math.max(0, Date.now() - execStartAt), error: errCode },
                                    {
                                        run_id: job.id,
                                        mode: 'macro',
                                        host_app: host,
                                        doc_id: docId,
                                        doc_key: String(job.docContext?.docKey || ''),
                                        session_id: String(job.sessionId || ''),
                                        message_id: String(job.messageId || ''),
                                        block_id: b.blockId,
                                    } as any
                                )
                            } catch (e: any) {
                                logger.debug('[telemetry] emit macro.exec_done failed', e)
                            }
                            continue
                        }
                    } catch (e) {
                        const userMsg = '激活目标文档失败，已停止写回。请重新打开文档后再试。'
                        const errCode = `document_activate_failed:${docId || docContext?.name || docContext?.path || ''}`
                        try { setMacroBlockRun(b.blockId, { status: 'error', messageId: job.messageId, error: userMsg }) } catch (e2) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e2) }
                        try { _notifyMacroWritebackError({ job, blockId: b.blockId, error: userMsg, errCode }) } catch (e2) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e2) }
                        try {
                            emitTelemetryEvent(
                                'macro.exec_done',
                                { ok: false, exec_ms: Math.max(0, Date.now() - execStartAt), error: errCode },
                                {
                                    run_id: job.id,
                                    mode: 'macro',
                                    host_app: host,
                                    doc_id: docId,
                                    doc_key: String(job.docContext?.docKey || ''),
                                    session_id: String(job.sessionId || ''),
                                    message_id: String(job.messageId || ''),
                                    block_id: b.blockId,
                                } as any
                            )
                        } catch (e2: any) {
                            logger.debug('[telemetry] emit macro.exec_done failed', e2)
                        }
                        continue
                    }

                    try {
                        let plan: any = null
                        try { plan = JSON.parse(b.code) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e); plan = null }
                        if (!plan) {
                            setMacroBlockRun(b.blockId, { status: 'error', messageId: job.messageId, error: 'invalid_plan_json' })
                            try { logToBackend?.(`[MacroQueue] invalid_plan_json block=${b.blockId} bytes=${String(b.code || '').length}`) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e) }
                            try { _notifyMacroWritebackError({ job, blockId: b.blockId, error: 'invalid_plan_json', errCode: 'invalid_plan_json' }) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e) }
                            try {
                                emitTelemetryEvent(
                                    'macro.exec_done',
                                    { ok: false, exec_ms: Math.max(0, Date.now() - execStartAt), error: 'invalid_plan_json' },
                                    {
                                        run_id: job.id,
                                        mode: 'macro',
                                        host_app: host,
                                        doc_id: docId,
                                        doc_key: String(job.docContext?.docKey || ''),
                                        session_id: String(job.sessionId || ''),
                                        message_id: String(job.messageId || ''),
                                        block_id: b.blockId,
                                    } as any
                                )
                            } catch (e: any) {
                                logger.debug('[telemetry] emit macro.exec_done failed', e)
                            }
                            continue
                        }

                         // Execute + repair loop (strict: no fallback to JS macros).
                         let currentPlan: any = plan
                         let executed = false
                         let lastErr = ''
                         let didRepair = false
                        // Preflight: normalize + validate (fast-path only) before touching WPS runtime.
                        // This avoids wasting a first execution attempt on obviously invalid plans.
                        try {
                            const preflight = await planClient.repairPlan(
                                currentPlan,
                                'preflight_validate',
                                'preflight_validate',
                                0
                            )
                            if (preflight.success && preflight.plan) {
                                currentPlan = preflight.plan
                            } else if (preflight.error) {
                                const pe = String(preflight.error || '')
                                if (pe.toLowerCase().includes('invalid plan')) {
                                    didRepair = true
                                    const repaired0 = await planClient.repairPlan(currentPlan, 'invalid_plan', pe, 1)
                                    if (!repaired0.success || !repaired0.plan) {
                                        lastErr = String(repaired0.error || pe || 'plan_repair_failed')
                                    } else {
                                        currentPlan = repaired0.plan
                                    }
                                } else {
                                    try {
                                        logToBackend?.(`[MacroQueue] plan.preflight skipped: ${pe}`)
                                    } catch (e) {
                                        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                                    }
                                }
                            }
                        } catch (e: any) {
                            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                        }

                        for (let attempt = 1; attempt <= 2 && !lastErr; attempt++) {
                            try {
                                const opsHint = (() => {
                                    try {
                                        const actions = Array.isArray(currentPlan?.actions) ? currentPlan.actions : []
                                        const ops: string[] = []
                                        const walk = (arr: any[]) => {
                                            for (const a of arr || []) {
                                                if (a && typeof a.op === 'string') ops.push(String(a.op))
                                                if (a && Array.isArray(a.actions)) walk(a.actions)
                                            }
                                        }
                                        walk(actions)
                                        return Array.from(new Set(ops)).slice(0, 12).join(',')
                                    } catch (e) {
                                        return ''
                                    }
                                })()
                                logToBackend?.(`[MacroQueue] plan.exec_start block=${b.blockId} attempt=${attempt} bytes=${String(JSON.stringify(currentPlan) || '').length} ops=${opsHint} doc=${String(docContext?.name || '')}`)
                            } catch (e) {
                                ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                            }
                            const res = await WPSHelper.executePlan(currentPlan)
                            try {
                                logToBackend?.(`[MacroQueue] plan.exec_result block=${b.blockId} attempt=${attempt} ok=${!!res?.success} msg=${String(res?.message || '')}`)
                            } catch (e) {
                                ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                            }
                            if (res?.success) {
                                executed = true
                                break
                            }
                            lastErr = String(res?.message || 'Plan execution failed')
                            if (attempt >= 2) break
                            didRepair = true
                            const repaired = await planClient.repairPlan(currentPlan, 'exec_failed', lastErr, attempt)
                            if (!repaired.success || !repaired.plan) {
                                lastErr = String(repaired.error || 'plan_repair_failed')
                                try { logToBackend?.(`[MacroQueue] plan.repair_failed block=${b.blockId} attempt=${attempt} err=${lastErr}`) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e) }
                                break
                            }
                            currentPlan = repaired.plan
                        }

                        let finalPlanText = ''
                        try { finalPlanText = JSON.stringify(currentPlan) } catch (e) { finalPlanText = String(b.code || '') }

                        if (executed) {
                            setMacroBlockRun(b.blockId, { status: 'success', messageId: job.messageId, finalCode: finalPlanText })
                            try { markMacroMessageExecuted(job.messageId) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e) }
                            try {
                                emitTelemetryEvent(
                                    'macro.exec_done',
                                    { ok: true, exec_ms: Math.max(0, Date.now() - execStartAt), type: 'plan', repaired: didRepair },
                                    {
                                        run_id: job.id,
                                        mode: 'macro',
                                        host_app: host,
                                        doc_id: docId,
                                        doc_key: String(job.docContext?.docKey || ''),
                                        session_id: String(job.sessionId || ''),
                                        message_id: String(job.messageId || ''),
                                        block_id: b.blockId,
                                    } as any
                                )
                            } catch (e: any) {
                                logger.debug('[telemetry] emit macro.exec_done failed', e)
                            }
                        } else {
                            setMacroBlockRun(b.blockId, { status: 'error', messageId: job.messageId, error: lastErr || 'Plan execution failed', finalCode: finalPlanText })
                            try { _notifyMacroWritebackError({ job, blockId: b.blockId, error: lastErr || 'Plan execution failed', errCode: 'plan_exec_failed' }) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e) }
                            try {
                                emitTelemetryEvent(
                                    'macro.exec_done',
                                    { ok: false, exec_ms: Math.max(0, Date.now() - execStartAt), type: 'plan', repaired: didRepair, error: lastErr || 'Plan execution failed' },
                                    {
                                        run_id: job.id,
                                        mode: 'macro',
                                        host_app: host,
                                        doc_id: docId,
                                        doc_key: String(job.docContext?.docKey || ''),
                                        session_id: String(job.sessionId || ''),
                                        message_id: String(job.messageId || ''),
                                        block_id: b.blockId,
                                    } as any
                                )
                            } catch (e: any) {
                                logger.debug('[telemetry] emit macro.exec_done failed', e)
                            }
                        }
                    } catch (e: any) {
                        const errMsg = String(e?.message || e)
                        setMacroBlockRun(b.blockId, { status: 'error', messageId: job.messageId, error: errMsg })
                        try { _notifyMacroWritebackError({ job, blockId: b.blockId, error: errMsg, errCode: 'macro_exec_exception' }) } catch (e2) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e2) }
                        try {
                            emitTelemetryEvent(
                                'macro.exec_done',
                                { ok: false, exec_ms: Math.max(0, Date.now() - execStartAt), error: errMsg },
                                {
                                    run_id: job.id,
                                    mode: 'macro',
                                    host_app: host,
                                    doc_id: docId,
                                    doc_key: String(job.docContext?.docKey || ''),
                                    session_id: String(job.sessionId || ''),
                                    message_id: String(job.messageId || ''),
                                    block_id: b.blockId,
                                } as any
                            )
                        } catch (e2: any) {
                            logger.debug('[telemetry] emit macro.exec_done failed', e2)
                        }
                        // Failures should not stop the queue; continue next block/job.

                    }
                }

                // Passive observability: queue progress (avoid spamming).
                try {
                    logToBackend?.(`[MacroQueue] done job=${job.id} host=${host} remaining=${macroJobQueue.value.length}`)
                } catch (e) {
                  ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                }
                macroJobActiveSessionId.value = ''
            }
        } finally {
            macroJobRunning.value = false
            macroJobActiveSessionId.value = ''
        }
    }

    // 发送消息
    // NOTE: `disableShortcuts` is used by MacroBench chat-mode so test prompts won't be intercepted
    // by local artifact-management shortcuts (list/rename/delete/update).
    const sendMessage = async (
        content: string,
        sessionId?: string,
        options?: {
            disableShortcuts?: boolean
            ensureDocSync?: boolean
            frontendContextPatch?: Record<string, any>
            ruleFiles?: string[]
        }
    ) => {
        const shortcutsEnabled = !(options && options.disableShortcuts === true)
        // Product decision: artifact shortcuts should be explicit to avoid false-positives.
        // Explicit slash commands are always allowed: `/artifacts`, `/rename`, `/delete`, `/update`.
        const allowNaturalShortcuts = false
        const isExplicitShortcutCommand = (() => {
            const t = String(content || '').trim()
            return /^\/(update|delete|rename|artifacts|artifact|list|ls)\b/i.test(t)
        })()
        const allowShortcutsForThisMessage = shortcutsEnabled && (isExplicitShortcutCommand || allowNaturalShortcuts)

        // Determine the right session bucket for this send.
        const activeDoc = getActiveDocumentMeta()
        const docName: string | null = activeDoc?.name || null
        const docContext = activeDoc
            ? {
                docId: activeDoc.id,
                docKey: activeDoc.docKey,
                name: activeDoc.name,
                path: activeDoc.path,
                hostApp: activeDoc.hostApp || wpsBridge.getHostApp()
            }
            : null

        let finalSessionId: string
        if (sessionId) {
            finalSessionId = normalizeSessionId(sessionId)
            await switchToSessionBucket(finalSessionId, activeDoc)
            logger.info('使用传入的 sessionId:', finalSessionId)
        } else if (activeDoc) {
            finalSessionId = await resolveSessionIdForDocument(activeDoc)
            await switchToSessionBucket(finalSessionId, activeDoc)
            logger.info('基于活动文档选择 sessionId:', finalSessionId)
        } else if (currentSessionId.value) {
            finalSessionId = normalizeSessionId(currentSessionId.value)
            logger.info('无活动文档，复用当前 sessionId:', finalSessionId)
        } else {
            finalSessionId = `temp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
            await switchToSessionBucket(finalSessionId, null)
            logger.info('无活动文档且无缓存，使用临时 sessionId:', finalSessionId)
        }

        const sid = normalizeSessionId(finalSessionId)

        const rt = getRuntime(sid)
        // Only block the SAME session; other documents can continue chatting concurrently.
        if (rt.isSending) throw new Error(`chat_busy:session:${sid}`)

        rt.lastTokenUsage = null
        rt.isSending = true
        rt.isThinking = true

        // Stream diagnostics (phase/elapsed) so we can tell "stuck" vs "slow but alive".
        rt.streamStartedAt = Date.now()
        rt.streamElapsedMs = 0
        rt.streamPhase = 'init'
        rt.turnRunId = `chat_${sid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        rt.turnFirstTokenMs = 0

        rt.cancelRequested = false
        // New controller per-send; allows user cancel without reloading the taskpane.
        rt.abortController = new AbortController()

        currentSessionId.value = normalizeSessionId(currentSessionId.value || finalSessionId)
        logger.info('最终 sessionId:', currentSessionId.value)

        // Plan repair needs stable context (session/doc/host). JS 宏通道移除后改用 planClient。
        try {
            const hostApp = String(docContext?.hostApp || wpsBridge.getHostApp() || 'unknown') as any
            planClient.setContext(finalSessionId, docName || '', hostApp)
        } catch (e) {
            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
        }

        // 发送消息前同步文档（不要阻塞聊天；必须吞掉异常，避免 unhandledrejection 导致任务窗格“重进加载”）
        detectAndSync().catch((err) => {
            logger.warn('[chat] detectAndSync failed (ignored)', err)
        })

        // Capture the bucket array for this send so streaming updates won't be stomped
        // if the user switches documents/sessions mid-stream.
        const sendSid = sid
        const sendBucketMessages = getBucketMessages(sendSid)

        try {
            const userVisibleContent = content
            let backendContent = content
            if (rt.lastStreamCancelled && isContinueIntent(userVisibleContent)) {
                const tail = getLastAssistantPartial()
                backendContent = tail
                    ? `请继续上一条回答，从中断处接着写，不要重复已经输出的内容。\n\n已输出片段（仅供参考，避免重复）：\n${tail}`
                    : '请继续上一条回答，从中断处接着写，不要重复已经输出的内容。'
            }
            // Once a new request starts, we are no longer in the "cancelled" state.
            rt.lastStreamCancelled = false

            // 添加用户消息（展示给用户的内容保持原样）
            const userMessage = createMessage('user', userVisibleContent, undefined, docContext ? { docContext } : undefined)
            // Always append into the originating session bucket (even if UI switches mid-flight).
            sendBucketMessages.push(userMessage)
            schedulePersistSessionBucketById(sendSid, sendBucketMessages)

            // Telemetry: per-turn start (best-effort).
            try {
                const hostApp = String(docContext?.hostApp || wpsBridge.getHostApp() || '')
                emitTelemetryEvent(
                    'chat.turn_start',
                    {
                        message_len: String(backendContent || '').length,
                        visible_message_len: String(userVisibleContent || '').length,
                        has_frontend_context: true,
                    },
                    {
                        run_id: rt.turnRunId,
                        mode: 'chat',
                        host_app: hostApp,
                        doc_id: docContext?.docId,
                        doc_key: docContext?.docKey,
                        session_id: sendSid,
                        message_id: userMessage.id,
                    } as any
                )
            } catch (e: any) {
                logger.debug('[telemetry] emit chat.turn_start failed', e)
            }

            // 记录宏上下文：优先通过对话解析目标产物；必要时在聊天里追问澄清（不做额外功能区）。
            lastUserQuery.value = userVisibleContent
            try {
                if (typeof window !== 'undefined') {
                    ;(window as any).__BID_LAST_USER_QUERY = userVisibleContent
                    ;(window as any).__BID_LAST_USER_QUERY_TS = Date.now()
                    if (options?.ruleFiles && Array.isArray(options.ruleFiles)) {
                        ;(window as any).__BID_LAST_RULE_FILES = options.ruleFiles.slice()
                        ;(window as any).__BID_LAST_RULE_FILES_TS = Date.now()
                    }
                }
            } catch (e) {
              ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
            }

            // 快捷指令触发的写回（删除等）也必须走全局宏队列：
            // 多个文档的 SSE 可能并行，否则会出现并发写回“踩踏”。
            const addSystemMessageToSendBucketSafe = (text: string) => {
                try {
                    const msg = createMessage('assistant', String(text || ''), undefined, docContext ? { docContext } : undefined)
                    msg.isSystem = true
                    sendBucketMessages.push(msg)
                    schedulePersistSessionBucketById(sendSid, sendBucketMessages)
                } catch (e) {
                    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                    // 兜底：尽量写到当前可见 bucket，避免完全丢失提示。
                    try { addSystemMessage(String(text || '')) } catch (e2) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e2) }
                }
            }
            const _sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
            const waitForMacroBlockDone = async (
                messageId: string,
                blockId: string,
                timeoutMs: number = 120_000
            ): Promise<MacroBlockRun | null> => {
                const mid = String(messageId || '').trim()
                const ah32 = String(blockId || '').trim()
                if (!mid || !ah32) return null

                const deadline = Date.now() + Math.max(1000, timeoutMs)
                while (Date.now() < deadline) {
                    const run = getMacroBlockRun(mid, ah32)
                    const s = String(run?.status || '')
                    if (s === 'success' || s === 'error') return run
                    await _sleep(180)
                }
                return getMacroBlockRun(mid, ah32)
            }

            const enqueueDeleteBlock = (blockId: string, title: string) => {
                const ah32 = String(blockId || '').trim()
                if (!ah32) return

                const hostApp = String(docContext?.hostApp || wpsBridge.getHostApp() || 'wps').trim()
                const plan = {
                    schema_version: 'ah32.plan.v1',
                    host_app: (hostApp === 'et' || hostApp === 'wpp') ? hostApp : 'wps',
                    meta: { kind: 'shortcut_delete' },
                    actions: [
                        { id: `delete_${ah32}`.slice(0, 64), title: 'Delete block', op: 'delete_block', block_id: ah32 },
                    ],
                }
                const codeToRun = JSON.stringify(plan)
                try { setMacroBlockRun(ah32, { status: 'queued', messageId: userMessage.id, finalCode: codeToRun }) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e) }

                const ctx: any = docContext || null
                const dc = ctx ? {
                    docId: String(ctx?.docId || '').trim(),
                    docKey: String(ctx?.docKey || '').trim(),
                    name: String(ctx?.name || '').trim(),
                    path: String(ctx?.path || '').trim(),
                    hostApp: String(ctx?.hostApp || wpsBridge.getHostApp() || '').trim()
                } : null

                const job: MacroJob = {
                    id: _randId('macrojob'),
                    createdAt: _nowIso(),
                    sessionId: normalizeSessionId(sendSid),
                    messageId: userMessage.id,
                    docContext: dc,
                    blocks: [{ type: 'plan', blockId: ah32, code: codeToRun }],
                }
                macroJobQueue.value.push(job)
                try {
                    emitTelemetryEvent(
                        'macro.queue_enqueued',
                        { blocks: 1, source: 'shortcut:delete' },
                        {
                            run_id: job.id,
                            mode: 'macro',
                            host_app: String(dc?.hostApp || ''),
                            doc_id: String(dc?.docId || ''),
                            doc_key: String(dc?.docKey || ''),
                            session_id: String(job.sessionId || ''),
                            message_id: String(job.messageId || ''),
                            block_id: ah32,
                        } as any
                    )
                } catch (e: any) {
                    logger.debug('[telemetry] emit macro.queue_enqueued (shortcut delete) failed', e)
                }

                const titleText = String(title || '').trim() || ah32
                addSystemMessageToSendBucketSafe(`正在删除：${titleText}（已加入队列）`)
                void processMacroJobQueue()
                void (async () => {
                    try {
                        const run = await waitForMacroBlockDone(userMessage.id, ah32, 120_000)
                        if (run?.status === 'success') {
                            removeMacroArtifact(ah32)
                            addSystemMessageToSendBucketSafe(`已删除：${titleText}`)
                            return
                        }
                        if (run?.status === 'error') {
                            const errMsg = String(run?.error || '').trim()
                            addSystemMessageToSendBucketSafe(errMsg ? `删除失败：${errMsg}` : '删除失败：未知错误')
                            return
                        }
                        // Timed out: do not claim failure; the queue may still be running.
                        addSystemMessageToSendBucketSafe(`删除仍在排队：${titleText}（请稍后查看文档/状态）`)
                    } catch (e) {
                        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                        addSystemMessageToSendBucketSafe('删除失败：发生异常，请重试。')
                    }
                })()
            }

            // If we are waiting for a clarification choice, treat this message as the choice.
            if (shortcutsEnabled && pendingMacroClarification.value) {
                const raw = (content || '').trim()
                const m = raw.match(/^(\d+)$/) || raw.match(/第\s*(\d+)\s*个/)
                const idx = m ? Number(m[1]) : NaN
                const candidates = pendingMacroClarification.value.candidates || []
                if (Number.isFinite(idx) && idx >= 1 && idx <= candidates.length) {
                    const chosen = candidates[idx - 1]!
                    const action = pendingMacroClarification.value.action
                    const original = pendingMacroClarification.value.originalRequest
                    const renameTo = pendingMacroClarification.value.renameTo
                    pendingMacroClarification.value = null

                    if (action === 'update') {
                        pendingMacroUpdateBlockId.value = chosen.blockId
                        addSystemMessage(`已选择要更新的内容：${chosen.title}。开始执行“${original}”`)
                        content = original
                    } else if (action === 'delete') {
                        enqueueDeleteBlock(chosen.blockId, chosen.title)
                        rt.isSending = false
                        rt.isThinking = false
                        return
                    } else if (action === 'rename') {
                        if (!renameTo) {
                            pendingRenameTargetBlockId.value = chosen.blockId
                            addSystemMessage(`请回复新的名称，用于重命名：${chosen.title}`)
                            rt.isSending = false
                            rt.isThinking = false
                            return
                        }
                        registerMacroArtifact(chosen.blockId, renameTo)
                        addSystemMessage(`已重命名为：${renameTo}`)
                        rt.isSending = false
                        rt.isThinking = false
                        return
                    }
                } else {
                    addSystemMessage(`请回复 1-${candidates.length} 选择要修改的内容。`)
                    rt.isSending = false
                    rt.isThinking = false
                    return
                }
            } else if (shortcutsEnabled && pendingRenameTargetBlockId.value) {
                const newName = (content || '').trim()
                if (!newName) {
                    addSystemMessage('请输入新的名称（不能为空）。')
                    rt.isSending = false
                    rt.isThinking = false
                    return
                }
                registerMacroArtifact(pendingRenameTargetBlockId.value, newName)
                pendingRenameTargetBlockId.value = null
                addSystemMessage(`已重命名为：${newName}`)
                rt.isSending = false
                rt.isThinking = false
                return
            } else if (allowShortcutsForThisMessage && isListArtifactsIntent(content)) {
                addSystemMessage(formatArtifactsList(8))
                rt.isSending = false
                rt.isThinking = false
                return
            } else if (allowShortcutsForThisMessage && isDeleteIntent(content)) {
                const resolved = resolveTargetArtifact(content)
                if (resolved.kind === 'ambiguous') {
                    const candidates = resolved.candidates.map(c => ({ blockId: c.blockId, title: c.title }))
                    pendingMacroClarification.value = { action: 'delete', originalRequest: content, candidates }
                    addSystemMessage(
                        '你想删除一个产物，但我发现有多个候选。请回复序号选择：\n' +
                        candidates.map((c, i) => `${i + 1}. ${c.title}`).join('\n')
                    )
                    rt.isSending = false
                    rt.isThinking = false
                    return
                }
                const blockId = resolved.kind === 'resolved' ? resolved.blockId : lastMacroBlockId.value
                if (!blockId) {
                    addSystemMessage('当前没有可删除的产物。')
                    rt.isSending = false
                    rt.isThinking = false
                    return
                }

                const sid = getSessionKey()
                const title = macroArtifacts.value.find(a => a.sessionId === sid && a.blockId === blockId)?.title || blockId
                enqueueDeleteBlock(blockId, title)
                rt.isSending = false
                rt.isThinking = false
                return
            } else if (allowShortcutsForThisMessage && isRenameIntent(content)) {
                const renameTo = extractRenameTo(content)
                const resolved = resolveTargetArtifact(content)
                if (resolved.kind === 'ambiguous') {
                    const candidates = resolved.candidates.map(c => ({ blockId: c.blockId, title: c.title }))
                    pendingMacroClarification.value = { action: 'rename', originalRequest: content, candidates, renameTo: renameTo || undefined }
                    addSystemMessage(
                        '你想重命名一个产物，但我发现有多个候选。请回复序号选择：\n' +
                        candidates.map((c, i) => `${i + 1}. ${c.title}`).join('\n')
                    )
                    rt.isSending = false
                    rt.isThinking = false
                    return
                }

                const blockId = resolved.kind === 'resolved' ? resolved.blockId : lastMacroBlockId.value
                if (!blockId) {
                    addSystemMessage('当前没有可重命名的产物。')
                    rt.isSending = false
                    rt.isThinking = false
                    return
                }
                if (!renameTo) {
                    pendingRenameTargetBlockId.value = blockId
                    const sid = getSessionKey()
                    const title = macroArtifacts.value.find(a => a.sessionId === sid && a.blockId === blockId)?.title || blockId
                    addSystemMessage(`请回复新的名称，用于重命名：${title}`)
                    rt.isSending = false
                    rt.isThinking = false
                    return
                }
                registerMacroArtifact(blockId, renameTo)
                addSystemMessage(`已重命名为：${renameTo}`)
                rt.isSending = false
                rt.isThinking = false
                return
            } else if (allowShortcutsForThisMessage && isUpdateIntent(content)) {
                const resolved = resolveTargetArtifact(content)
                if (resolved.kind === 'ambiguous') {
                    const candidates = resolved.candidates.map(c => ({ blockId: c.blockId, title: c.title }))
                    pendingMacroClarification.value = { action: 'update', originalRequest: content, candidates }
                    addSystemMessage(
                        '你想“修改/优化”，但我发现有多个可修改的产物。请回复序号选择：\n' +
                        candidates.map((c, i) => `${i + 1}. ${c.title}`).join('\n')
                    )
                    rt.isSending = false
                    rt.isThinking = false
                    return
                }
                if (resolved.kind === 'resolved') {
                    pendingMacroUpdateBlockId.value = resolved.blockId
                } else {
                    pendingMacroUpdateBlockId.value = lastMacroBlockId.value
                }
            } else {
                pendingMacroUpdateBlockId.value = null
            }
            // Snapshot update target so macro execution can reuse the same blockId even if UI switches sessions
            // or the component-based "consumePendingMacroUpdateBlockId" path is bypassed.
            const updateTargetBlockId = pendingMacroUpdateBlockId.value

            // 添加思考指示器（仅影响当前 session）
            rt.isThinking = true
            let thinkingMessageId: string | null = null
            let thinkingIteration = 0  // 思考迭代计数器，用于区分不同思考步骤
            let lastPhaseNote = '' // avoid spamming the same phase line
            const debugSse = false
            let lastDebugTs = 0
            // 默认不往聊天记录里塞“思考过程”消息（用户觉得吵）。
            // 仅在 `.env` 开启 `VITE_SHOW_THOUGHTS=true` 时才展示 thinking/reasoning 的原始流。
            const wantThinkingMessage = (() => {
                try { return !!getRuntimeConfig().showThoughts } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e); return false }
            })()

            // Per-send streaming buffer (session-local by closure) so concurrent sessions won't mix chunks.
            let contentBuffer = ''
            let bufferTarget: string | null = null
            // MacroBench chat-runner executes macros itself (for timing + asserts). Avoid double execution.
            const disableAutoWriteback = !!options?.frontendContextPatch?.bench
            const addMessageToSendBucket = (message: Message) => {
                sendBucketMessages.push(message)
                schedulePersistSessionBucketById(sendSid, sendBucketMessages)
            }
            const addSystemMessageToSendBucket = (content: string) => {
                const message = createMessage('assistant', content)
                message.isSystem = true
                addMessageToSendBucket(message)
                return message
            }
            const addThinkingMessageToSendBucket = (thinking: string) => {
                const message = createMessage('thinking', '', thinking)
                addMessageToSendBucket(message)
                return message
            }
            // Track whether this turn produced any assistant message (for MacroBench + UX fallback).
            let firstAssistantMessageId: string | null = null
            const markAssistantMessage = (msg: Message | null | undefined) => {
                const id = msg && (msg as any).id ? String((msg as any).id) : ''
                if (!firstAssistantMessageId && id) firstAssistantMessageId = id
            }

            // Tool-call handling (model emits JSON {"action": "...", "input": "..."}).
            // Important: bind execution to the document that initiated this chat turn.
            const _extractBlockIdHeader = (code: string): string | null => {
                try {
                    const m = String(code || '').match(/^\s*\/\/\s*@(ah32|bidagent):blockId\s*=\s*([^\s]+)\s*$/m)
                    return (m && m[2]) ? String(m[2]).trim() : null
                } catch (e) {
                  ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                    return null
                }
            }
            const _stripBlockIdHeader = (code: string): string => {
                try {
                    return String(code || '').replace(/^\s*\/\/\s*@(ah32|bidagent):blockId\s*=\s*[^\s]+\s*$(\r?\n)?/gm, '').trim()
                } catch (e) {
                  ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                    return String(code || '').trim()
                }
            }
            const _upsertMessageMacroBlockMeta = (msg: Message, block: { type: 'plan'; blockId: string; description?: string }) => {
                try {
                    const meta: any = (msg as any).metadata || {}
                    const arr = Array.isArray(meta.macroBlocks) ? meta.macroBlocks.slice() : []
                    const ah32 = String(block.blockId || '').trim()
                    if (!ah32) return
                    const exists = arr.some((x: any) => String(x?.blockId || '').trim() === ah32)
                    if (!exists) {
                        arr.push({
                            type: block.type,
                            blockId: ah32,
                            description: String(block.description || '').trim() || undefined
                        })
                    }
                    meta.macroBlocks = arr
                    ;(msg as any).metadata = meta
                } catch (e) {
                  ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                }
            }
            const _handleToolCall = async (action: string, input: string, targetMsg: Message) => {
                const act = String(action || '').trim()
                if (!act) return

                // JS 宏通道已移除：不再支持 tool:execute_js_macro / generate_js_macro_code 等“前端执行工具”。

                // Default: keep tool outputs as system messages; do not overwrite assistant content.
                try {
                    const result = await executeTool(act, input)
                    try { addSystemMessageToSendBucket(`[Tool:${act}] ${result}`) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e) }
                } catch (e: any) {
                    try { addSystemMessageToSendBucket(`[Tool:${act}] 失败：${String(e?.message || e)}`) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e) }
                }
            }

            const combinedFrontendContextPatch = (() => {
                const base =
                    options?.frontendContextPatch && typeof options.frontendContextPatch === 'object'
                        ? { ...(options.frontendContextPatch as any) }
                        : {}
                const hostApp = String(docContext?.hostApp || wpsBridge.getHostApp() || '')
                const rc = {
                    run_id: rt.turnRunId,
                    mode: 'chat',
                    host_app: hostApp,
                    doc_id: docContext?.docId,
                    doc_key: docContext?.docKey,
                    session_id: sendSid,
                    message_id: String(userMessage?.id || ''),
                }
                try {
                    const existing = (base as any).run_context
                    ;(base as any).run_context =
                        existing && typeof existing === 'object' ? { ...existing, ...rc } : rc
                } catch (e: any) {
                    logger.debug('[chat] merge run_context failed', e)
                    ;(base as any).run_context = rc
                }
                return base
            })()

            await chatApi.streamResponse(
                backendContent,
                finalSessionId,
                docName,
                async (chunk) => {
                    const {type, data} = chunk

                    try {
                        if (rt.streamStartedAt) {
                            rt.streamElapsedMs = Math.max(0, Date.now() - rt.streamStartedAt)
                        }
                    } catch (e) {
                      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                    }

                    // Avoid logging every SSE chunk to backend; it slows streaming and can stall the UI.
                    if (debugSse) {
                        const now = Date.now()
                        if (now - lastDebugTs > 1200) {
                            lastDebugTs = now
                            logToBackend(`[SSE-${type}] ${JSON.stringify(data).substring(0, 200)}...`)
                        }
                    }

                    switch (type) {
                        case 'start':
                            rt.streamPhase = 'start'
                            break

                        case 'meta':
                            try {
                                if (typeof window !== 'undefined') {
                                    ;(window as any).__BID_LAST_MODEL_INFO = data || {}
                                    ;(window as any).__BID_LAST_MODEL_INFO_TS = Date.now()
                                }
                            } catch (e) {
                              ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                            }
                            break

                        case 'phase':
                            if (data?.phase) {
                                rt.streamPhase = String(data.phase)
                                try {
                                    emitTelemetryEvent(
                                        'chat.stream_phase',
                                        { phase: String(data.phase || ''), stage: String((data as any)?.stage || '') },
                                        {
                                            run_id: rt.turnRunId,
                                            mode: 'chat',
                                            host_app: String(docContext?.hostApp || wpsBridge.getHostApp() || ''),
                                            doc_id: docContext?.docId,
                                            doc_key: docContext?.docKey,
                                            session_id: sendSid,
                                        } as any
                                    )
                                } catch (e: any) {
                                    logger.debug('[telemetry] emit chat.stream_phase failed', e)
                                }
                                if (wantThinkingMessage && thinkingMessageId) {
                                    // Dev-only: append phase trace into the thinking message.
                                    try {
                                        const p = String(data.phase || '').trim()
                                        const stage = String((data as any)?.stage || '').trim()
                                        const note = stage ? `阶段：${p}（${stage}）` : `阶段：${p}`
                                        if (note && note !== lastPhaseNote) {
                                            lastPhaseNote = note
                                            const msg = sendBucketMessages.find(m => m.id === thinkingMessageId)
                                            if (msg) msg.thinking = (msg.thinking || '') + `\n${note}`
                                            schedulePersistSessionBucketById(sendSid, sendBucketMessages)
                                        }
                                    } catch (e) {
                                      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                                    }
                                }
                            }
                            break

                        case 'heartbeat':
                            if (data?.phase) {
                                rt.streamPhase = String(data.phase)
                                if (wantThinkingMessage && thinkingMessageId) {
                                    try {
                                        const p = String(data.phase || '').trim()
                                        const note = p ? `阶段：${p}` : ''
                                        if (note && note !== lastPhaseNote) {
                                            lastPhaseNote = note
                                            const msg = sendBucketMessages.find(m => m.id === thinkingMessageId)
                                            if (msg) msg.thinking = (msg.thinking || '') + `\n${note}`
                                            schedulePersistSessionBucketById(sendSid, sendBucketMessages)
                                        }
                                    } catch (e) {
                                      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                                    }
                                }
                            }
                            break

                        case 'thinking':
                        case 'reasoning': // reasoning 事件包含思考内容，需要追加
                            rt.streamPhase = 'thinking'
                            thinkingIteration++
                            if (wantThinkingMessage) {
                                if (!thinkingMessageId) {
                                    const thinkingMsg = addThinkingMessageToSendBucket(`步骤 ${thinkingIteration}: ${data.content}`)
                                    thinkingMessageId = thinkingMsg.id
                                    if (debugSse) logToBackend(`[THINKING] 创建思考消息: ${thinkingMsg.id}, 类型: ${type}`)
                                } else {
                                    const message = sendBucketMessages.find(m => m.id === thinkingMessageId)
                                    if (message) {
                                        const newThinking = (message.thinking || '') + data.content
                                        const index = sendBucketMessages.findIndex(m => m.id === thinkingMessageId)
                                        if (index !== -1) {
                                            sendBucketMessages[index]!.thinking = newThinking
                                            if (debugSse) logToBackend(`[THINKING] 追加到消息: ${thinkingMessageId}`)
                                            schedulePersistSessionBucketById(sendSid, sendBucketMessages)
                                        }
                                    }
                                }
                            }
                            break

                        case 'rag':
                            rt.streamPhase = 'retrieval'
                            // Debug-only: show a compact RAG hit summary when enabled via env/runtime config.
                            try {
                                if (data?.content) {
                                    addSystemMessageToSendBucket(`[RAG] ${data.content}`)
                                }
                                try {
                                    if (typeof window !== 'undefined') {
                                        ;(window as any).__BID_LAST_RAG_SUMMARY = String(data?.content || '')
                                        ;(window as any).__BID_LAST_RAG_TS = Date.now()
                                    }
                                } catch (e) {
                                  ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                                }
                            } catch (e) {
                              ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                            }
                            break

                        case 'rag_meta':
                            try {
                                if (typeof window !== 'undefined') {
                                    ;(window as any).__BID_LAST_RAG_SUMMARY = String(data?.content || '')
                                    ;(window as any).__BID_LAST_RAG_TS = Date.now()
                                }
                            } catch (e) {
                              ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                            }
                            break

                        case 'skills':
                            rt.streamPhase = 'skills'
                            // Passive hint: backend-selected skills for this turn.
                            {
                                const phase = (data?.skills_phase === 'selected' || data?.skills_phase === 'applied')
                                    ? data.skills_phase
                                    : (data?.skills_kind === 'selected' ? 'selected' : 'applied')
                                setSkillsPhase(phase, data?.skills, data?.content || '', sendSid, data?.skills_metrics)
                                try {
                                    if (typeof window !== 'undefined') {
                                        ;(window as any).__BID_LAST_SKILLS = data?.skills || data?.content || ''
                                        ;(window as any).__BID_LAST_SKILLS_TS = Date.now()
                                    }
                                } catch (e) {
                                  ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                                }
                            }
                            break

                        case 'content':
                            rt.streamPhase = 'responding'
                            {
                                const rawChunkContent = String((data as any)?.content || '')
                                if (_looksLikeSseDoneMetaEnvelope(rawChunkContent)) {
                                    logger.debug('[chat] ignored sse done-meta envelope leaked as content')
                                    break
                                }
                            }
                            try {
                                if (!rt.turnFirstTokenMs && String((data as any)?.content || '').length > 0) {
                                    rt.turnFirstTokenMs = Math.max(0, Date.now() - (rt.streamStartedAt || Date.now()))
                                    emitTelemetryEvent(
                                        'chat.first_token',
                                        { first_token_ms: rt.turnFirstTokenMs },
                                        {
                                            run_id: rt.turnRunId,
                                            mode: 'chat',
                                            host_app: String(docContext?.hostApp || wpsBridge.getHostApp() || ''),
                                            doc_id: docContext?.docId,
                                            doc_key: docContext?.docKey,
                                            session_id: sendSid,
                                        } as any
                                    )
                                }
                            } catch (e: any) {
                                logger.debug('[telemetry] emit chat.first_token failed', e)
                            }
                            if (wantThinkingMessage && thinkingMessageId) {
                                const thinkingMsg = sendBucketMessages.find(m => m.id === thinkingMessageId)
                                if (thinkingMsg && !thinkingMsg.thinking?.includes('思考完成')) {
                                    thinkingMsg.thinking = (thinkingMsg.thinking || '') + `\n\n思考完成，开始生成回答...`
                                    schedulePersistSessionBucketById(sendSid, sendBucketMessages)
                                }
                            }

                            // 使用缓冲机制累积内容，减少频繁更新
                            const lastMessage = sendBucketMessages[sendBucketMessages.length - 1]
                            
                            // 检查累积的内容是否包含工具调用
                            const deltaRaw = (data as any)?.content
                            const delta =
                                (typeof deltaRaw === 'string' || typeof deltaRaw === 'number') ? String(deltaRaw) : ''
                            if (delta) contentBuffer += delta
                            if (!bufferTarget) {
                                bufferTarget = lastMessage?.id || null
                            }

                            // 当缓冲区达到30字符或收到 done 事件时检查
                            const currentContent = contentBuffer
                            
                            // 检测是否为工具调用 JSON（避免对每个 chunk 都 JSON.parse）
                            if (looksLikeToolCall(currentContent) && isToolCall(currentContent)) {
                                // 清空缓冲区
                                contentBuffer = ''
                                bufferTarget = null

                                // 解析工具调用
                                const { action, input } = parseToolCall(currentContent)

                                // NOTE: tool calls must not overwrite assistant content (it makes macro cards disappear).
                                // Prefer a stable assistant target message and render macro cards from metadata + run status.
                                let targetMsg = lastMessage && lastMessage.type === 'assistant' ? lastMessage : null
                                if (!targetMsg) {
                                    targetMsg = createMessage('assistant', '', undefined, docContext ? { docContext } : undefined)
                                    addMessageToSendBucket(targetMsg)
                                }
                                markAssistantMessage(targetMsg)
                                await _handleToolCall(action, input, targetMsg)
                            } else if (currentContent.length >= 30) {
                                // 普通内容，累积到消息中
                                if (lastMessage && lastMessage.type === 'assistant') {
                                    markAssistantMessage(lastMessage)
                                    lastMessage.content += currentContent
                                } else {
                                    const assistantMessage = createMessage(
                                        'assistant',
                                        currentContent,
                                        undefined,
                                        docContext ? { docContext } : undefined
                                    )
                                    addMessageToSendBucket(assistantMessage)
                                    markAssistantMessage(assistantMessage)
                                }
                                schedulePersistSessionBucketById(sendSid, sendBucketMessages)
                                contentBuffer = ''
                                bufferTarget = null
                            }
                            break

                        case 'done':
                            rt.streamPhase = 'done'
                            // Capture optional token usage for MacroBench (maxCost) and debugging.
                            try {
                                rt.lastTokenUsage = (data as any)?.token_usage || (data as any)?.usage || null
                            } catch (e) {
                              ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                                rt.lastTokenUsage = null
                            }

                            // Some backends may include a final content chunk in the `done` event.
                            // Preserve it so we don't silently drop the last part (important for writeback plans).
                            try {
                                const finalChunk = (data as any)?.content
                                if (typeof finalChunk === 'string' && finalChunk) {
                                    contentBuffer += finalChunk
                                }
                            } catch (e) {
                              ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                            }
                            try {
                                const chatMs = rt.streamStartedAt ? Math.max(0, Date.now() - rt.streamStartedAt) : 0
                                emitTelemetryEvent(
                                    'chat.turn_done',
                                    {
                                        ok: true,
                                        chat_ms: chatMs,
                                        first_token_ms: rt.turnFirstTokenMs || undefined,
                                        token_usage: rt.lastTokenUsage || undefined,
                                    },
                                    {
                                        run_id: rt.turnRunId,
                                        mode: 'chat',
                                        host_app: String(docContext?.hostApp || wpsBridge.getHostApp() || ''),
                                        doc_id: docContext?.docId,
                                        doc_key: docContext?.docKey,
                                        session_id: sendSid,
                                    } as any
                                )
                            } catch (e: any) {
                                logger.debug('[telemetry] emit chat.turn_done failed', e)
                            }
                            // 思考消息保持独立，标记最终完成状态
                            if (wantThinkingMessage && thinkingMessageId) {
                                const thinkingMsg = sendBucketMessages.find(m => m.id === thinkingMessageId)
                                if (thinkingMsg && !thinkingMsg.thinking?.includes('🎯')) {
                                    thinkingMsg.thinking = (thinkingMsg.thinking || '') + `\n\n🎯 回答生成完成`
                                    schedulePersistSessionBucketById(sendSid, sendBucketMessages)
                                }
                                thinkingMessageId = null
                            }
                            thinkingIteration = 0  // 确保重置迭代计数器

                            // 消息完成传输后，重新检测JS宏代码
                            if (debugSse) logToBackend('[DONE] 消息传输完成，重新检测JS宏代码')
                            const doneLastMessage = sendBucketMessages[sendBucketMessages.length - 1]
                            if (doneLastMessage && doneLastMessage.type === 'assistant') {
                                // 手动触发JS宏代码检测
                                if (debugSse) {
                                    logToBackend(`[DONE-FINAL] 最终消息长度: ${doneLastMessage.content.length}`)
                                    logToBackend(`[DONE-FINAL] 消息内容: ${doneLastMessage.content.substring(0, 200)}...`)
                                }

                                // 检查是否包含JS宏代码标记
                                if (doneLastMessage.content.includes('```js') || doneLastMessage.content.includes('```javascript')) {
                                    if (debugSse) logToBackend('[DONE-FINAL] 检测到JS宏代码标记，开始详细分析')
                                    // 这里会触发MessageItem.vue中的codeBlocks computed重新计算
                                } else {
                                    if (debugSse) logToBackend('[DONE-FINAL] 未检测到JS宏代码标记')
                                }
                            }
                            
                            // 响应完成，处理剩余缓冲区内容
                            if (contentBuffer) {
                                const currentContent = contentBuffer
                                const bufferLastMessage = sendBucketMessages[sendBucketMessages.length - 1]

                                // 检测是否为工具调用
                                if (looksLikeToolCall(currentContent) && isToolCall(currentContent)) {
                                    const { action, input } = parseToolCall(currentContent)
                                    
                                    // NOTE: this callback runs per-SSE event. Do not reference variables
                                    // declared in other event branches (e.g. `lastMessage` from 'content'),
                                    // otherwise we may hit a TDZ ReferenceError and crash the taskpane.
                                    let targetMsg = bufferLastMessage && bufferLastMessage.type === 'assistant'
                                      ? bufferLastMessage
                                      : null
                                    if (!targetMsg) {
                                        targetMsg = createMessage('assistant', '', undefined, docContext ? { docContext } : undefined)
                                        addMessageToSendBucket(targetMsg)
                                    }
                                    markAssistantMessage(targetMsg)
                                    await _handleToolCall(action, input, targetMsg)
                                } else {
                                    // 普通内容
                                    if (bufferLastMessage && bufferLastMessage.type === 'assistant') {
                                        markAssistantMessage(bufferLastMessage)
                                        bufferLastMessage.content += currentContent
                                    } else {
                                        const assistantMessage = createMessage(
                                            'assistant',
                                            currentContent,
                                            undefined,
                                            docContext ? { docContext } : undefined
                                        )
                                        addMessageToSendBucket(assistantMessage)
                                        markAssistantMessage(assistantMessage)
                                    }
                                }
                                schedulePersistSessionBucketById(sendSid, sendBucketMessages)
                                contentBuffer = ''
                                bufferTarget = null
                            }

                            // If no assistant message was ever produced, surface a minimal fallback.
                            if (!firstAssistantMessageId) {
                                const fallback = createMessage(
                                    'assistant',
                                    '抱歉，本轮没有返回可展示的内容，请重试。',
                                    undefined,
                                    docContext ? { docContext } : undefined
                                )
                                addMessageToSendBucket(fallback)
                                markAssistantMessage(fallback)
                            }

                            // Auto-enqueue macro writeback jobs for this assistant message (global queue, failure continues).
                            try {
                            if (!disableAutoWriteback) {
                                const lastMsg = sendBucketMessages[sendBucketMessages.length - 1]
                                if (lastMsg && lastMsg.type === 'assistant') {
                                    // Gate auto-writeback:
                                    // - If backend says this is a chat-only turn (want_writeback=false), do NOT enqueue.
                                    // - Otherwise, enqueue only when a plan block exists, unless backend explicitly
                                    //   expects writeback (want_writeback=true) in which case we enqueue to surface
                                    //   a clear error for missing/invalid plans.
                                    let wantWriteback: boolean | null = null
                                    try {
                                        const v = (data as any)?.want_writeback
                                        const v2 = (data as any)?.wantWriteback
                                        if (typeof v === 'boolean') wantWriteback = v
                                        else if (typeof v2 === 'boolean') wantWriteback = v2
                                    } catch (e) {
                                        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                                        wantWriteback = null
                                    }

                                    if (wantWriteback !== false) {
                                        let hasPlanBlocks = false
                                        try {
                                            const previewBlocks = _extractMacroBlocksFromContent(
                                                String((lastMsg as any)?.content || ''),
                                                String((lastMsg as any)?.id || ''),
                                                { updateTargetBlockId }
                                            )
                                            hasPlanBlocks = (previewBlocks || []).length > 0
                                        } catch (e) {
                                            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                                            hasPlanBlocks = false
                                        }

                                        if (hasPlanBlocks || wantWriteback === true) {
                                            // Auto-writeback: JSON-only in this branch (Plan blocks only).
                                            enqueueMacroJobForAssistantMessage(lastMsg as any, updateTargetBlockId, { excludeConfirm: true, onlyTypes: ['plan'] })
                                        }
                                    }
                                }
                            }
                            } catch (e) {
                                logger.debug('[MacroQueue] auto-enqueue writeback failed', e)
                            }
                            
                            rt.isSending = false
                            rt.isThinking = false
                            break

                        case 'error':
                            rt.streamPhase = 'error'
                            rt.isSending = false
                            rt.isThinking = false
                            throw new Error(data?.message || data?.error || '未知错误')
                    }
                },
                rt.abortController || undefined,
                {
                    ensureDocSync: !!options?.ensureDocSync,
                    frontendContextPatch: combinedFrontendContextPatch,
                    ruleFiles: options?.ruleFiles || undefined
                }
            )
        } catch (error) {
            logger.error('Send message error:', error)
            rt.streamPhase = 'error'
            rt.isThinking = false

            // User cancellation: do not treat as "error"; keep partial output and allow "继续".
            const msg = String((error as any)?.message || '')
            const cancelled = rt.cancelRequested || msg.includes('请求已取消') || msg.includes('已取消')
            if (cancelled) {
                rt.lastStreamCancelled = true
                try {
                    const chatMs = rt.streamStartedAt ? Math.max(0, Date.now() - rt.streamStartedAt) : 0
                    emitTelemetryEvent(
                        'chat.turn_done',
                        { ok: false, cancelled: true, chat_ms: chatMs, error: msg || 'cancelled' },
                        {
                            run_id: rt.turnRunId,
                            mode: 'chat',
                            host_app: String(docContext?.hostApp || wpsBridge.getHostApp() || ''),
                            doc_id: docContext?.docId,
                            doc_key: docContext?.docKey,
                            session_id: sendSid,
                        } as any
                    )
                } catch (e: any) {
                    logger.debug('[telemetry] emit cancelled chat.turn_done failed', e)
                }
                return
            }

            // 确保发送状态被重置
            rt.isSending = false

            try {
                const chatMs = rt.streamStartedAt ? Math.max(0, Date.now() - rt.streamStartedAt) : 0
                emitTelemetryEvent(
                    'chat.turn_done',
                    { ok: false, chat_ms: chatMs, error: msg || 'unknown_error' },
                    {
                        run_id: rt.turnRunId,
                        mode: 'chat',
                        host_app: String(docContext?.hostApp || wpsBridge.getHostApp() || ''),
                        doc_id: docContext?.docId,
                        doc_key: docContext?.docKey,
                        session_id: sendSid,
                    } as any
                )
            } catch (e: any) {
                logger.debug('[telemetry] emit error chat.turn_done failed', e)
            }

            // 添加错误消息
            const errorMessage = createMessage(
                'assistant',
                `抱歉，发生了错误：${error instanceof Error ? error.message : '未知错误'}`,
                undefined,
                docContext ? { docContext } : undefined
            )
            try {
                // Append to the same session bucket even if the user switched documents mid-stream.
                sendBucketMessages.push(errorMessage)
                schedulePersistSessionBucketById(sendSid, sendBucketMessages)
            } catch (e) {
              ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/stores/chat.ts', e)
                addMessage(errorMessage)
            }

            throw error
        } finally {
            // Ensure only this session's runtime is reset (multi-document safe).
            rt.isSending = false
            rt.isThinking = false
            rt.cancelRequested = false
            rt.abortController = null
            // Keep phase/elapsed visible, but stop the live timer marker.
            rt.streamStartedAt = 0
        }
    }

    // 重试发送消息
    const retrySendMessage = async (messageIndex: number) => {
        const message = messages.value[messageIndex]
        if (message && message.type === 'user') {
            // 删除该用户消息之后的所有消息
            messages.value = messages.value.slice(0, messageIndex)
            return sendMessage(message.content, currentSessionId.value!)
        }
    }

    // 删除消息
    const deleteMessage = (messageId: string) => {
        const index = messages.value.findIndex(m => m.id === messageId)
        if (index !== -1) {
            messages.value.splice(index, 1)
        }
    }

    // 复制消息内容
    const copyMessage = async (messageId: string) => {
        const message = messages.value.find(m => m.id === messageId)
        if (message) {
            try {
                await navigator.clipboard.writeText(message.content)
                return true
            } catch (error) {
                logger.error('Failed to copy message:', error)
                return false
            }
        }
        return false
    }

    // 获取消息统计
    const getMessageStats = () => {
        const userMessages = messages.value.filter(m => m.type === 'user').length
        const assistantMessages = messages.value.filter(m => m.type === 'assistant').length
        const totalCharacters = messages.value.reduce((sum, m) => sum + m.content.length, 0)

        return {
            total: messages.value.length,
            user: userMessages,
            assistant: assistantMessages,
            characters: totalCharacters
        }
    }

    // Bind chat bucket switching to the WPSBridge document watcher (no UI polling fallback).
    initDocumentSessionSync()

    return {
        // 状态
        messages,
        isThinking,
        isSending,
        streamPhase,
        streamElapsedMs,
        currentSessionId,
        currentDocKey,
        docKeyToSessionId,
        selectedSkills,
        selectedSkillsHint,
        selectedSkillsMetrics,
        appliedSkills,
        appliedSkillsHint,
        restoredFromStorage,
        lastUserQuery,
        lastMacroBlockId,
        lastTokenUsage,
        macroArtifacts,

        // 方法
        addMessage,
        addSystemMessage,
        clearMessages,
        cancelCurrentRequest,
        cancelPendingMacroJobs,
        getSessionStatusBySessionId,
        getSessionStatusByDocKey,
        switchToSession,
        syncSessionToActiveDocument,
        sendMessage,
        retrySendMessage,
        deleteMessage,
        copyMessage,
        getMessageStats,
        consumePendingMacroUpdateBlockId,
        setLastMacroBlockId,
        consumeLastTokenUsage: () => {
            const rt = getRuntime(currentSessionId.value)
            const v = rt.lastTokenUsage
            rt.lastTokenUsage = null
            return v
        },
        registerMacroArtifact,
        enqueueWritebackForAssistantMessage: enqueueMacroJobForAssistantMessage,
        enqueueRollbackForBlockId,
        isMacroMessageExecuted,
        markMacroMessageExecuted,
        getMacroBlockRun,
        setMacroBlockRun,
        macroBlockRunsTick
    }
})
