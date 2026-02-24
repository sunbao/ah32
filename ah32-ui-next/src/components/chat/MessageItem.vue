<template>

  <div class="message-item" :class="`message-${props.message.type}`">

    <!-- 错误边界显示 -->

    <div v-if="componentError" class="error-boundary">

      <el-alert

        title="组件渲染错误"

        type="error"

        :description="componentError.message"

        show-icon

        :closable="false"

      />

    </div>



    <div class="message-avatar">

      <el-avatar :size="36" :icon="getAvatarIcon()" />

    </div>

    <div class="message-content">

      <div class="message-header">

        <span class="message-sender">{{ getSenderName() }}</span>

        <span class="message-time">{{ formatTime(props.message.timestamp) }}</span>

      </div>



      <!-- 思考内容显示 - 只在 thinking 类型的消息中显示 -->

      <div v-if="props.message.type === 'thinking'" class="thinking-wrapper" :class="{ 'thinking-completed': props.message.thinking?.includes('思考完成') }">

        <div class="thinking-header" @click="thinkingExpanded = !thinkingExpanded">

          <div class="thinking-label">

            <el-icon class="thinking-icon" :class="{ rotated: thinkingExpanded }">

              <ArrowRight />

            </el-icon>

            <span>思考过程</span>

          </div>

          <div class="thinking-actions">

            <span class="thinking-toggle">{{ thinkingExpanded ? '收起' : '展开' }}</span>

          </div>

        </div>

        <div class="thinking-content" v-show="thinkingExpanded">

          {{ props.message.thinking }}

        </div>

      </div>



      <!-- JS 宏执行卡片：默认不展示代码（客户不懂代码，只看进度/结果） -->

      <div v-if="codeBlocks.length > 0" class="code-blocks">

          <div

          v-for="(block, index) in codeBlocks"

          :key="index"

          class="code-block"

        >

          <div class="code-header">

            <span class="code-title">

              <el-icon><Document /></el-icon>

              <span class="code-title-text">

                自动写入：{{ block.description || '文档操作' }}

                <span v-if="codeBlocks.length > 1" class="code-title-count">{{ index + 1 }}/{{ codeBlocks.length }}</span>

              </span>

            </span>

            <div class="code-actions">

              <!-- Keep the top-right status compact: icon-only (text via title) -->

              <el-tag v-if="block.executed" size="small" type="success" effect="plain" class="status-tag icon-only" title="执行成功">

                <el-icon><Select /></el-icon>

              </el-tag>

              <el-tag v-else-if="block.error" size="small" type="danger" effect="plain" class="status-tag icon-only" title="执行失败">

                <el-icon><CircleClose /></el-icon>

              </el-tag>

              <el-tag v-else-if="block.runStatus === 'running'" size="small" type="warning" effect="plain" class="status-tag icon-only" title="执行中">

                <el-icon><Loading class="loading-icon" /></el-icon>

              </el-tag>

              <el-tag v-else-if="block.runStatus === 'queued'" size="small" type="info" effect="plain" class="status-tag icon-only" title="排队中">

                <el-icon><Clock /></el-icon>

              </el-tag>

              <el-tag v-else size="small" type="primary" effect="plain" class="status-tag icon-only" title="等待执行">

                <el-icon><ArrowRight /></el-icon>

              </el-tag>

            </div>

          </div>



          <!-- VibeCoding 步骤：只展示步骤，不展示代码 -->

          <div v-if="(block.steps || []).length > 0" class="macro-steps">

            <div v-for="(s, si) in (block.steps || [])" :key="si" class="macro-step">

              <div class="macro-step-title">{{ s.title || s.type || '步骤' }}</div>

              <div class="macro-step-content">{{ s.content || '' }}</div>

            </div>

          </div>

          <div v-else class="macro-steps macro-steps-empty">

            <span v-if="block.executed">执行成功</span>

            <span v-else-if="block.error">执行失败</span>

            <span v-else-if="block.runStatus === 'running'">正在处理...</span>

            <span v-else-if="block.runStatus === 'queued'">排队中...</span>

            <span v-else>等待执行...</span>



            <div v-if="confirmHintForBlock(block)" class="macro-confirm-hint">

              {{ confirmHintForBlock(block) }}

            </div>



            <!-- confirmation-required: allow apply writeback (no code shown, still uses global macro queue) -->

            <div

              v-if="needsConfirm(block) && !!(block.code || '').trim() && !block.executed && !block.error && block.runStatus !== 'queued' && block.runStatus !== 'running'"

              class="macro-actions-row"

            >

              <el-button

                type="primary"

                size="small"

                @click="applyWritebackNow(block)"

              >

                <el-icon><CaretRight /></el-icon>

                {{ needsConfirm(block) ? '确认应用' : '应用到文档' }}

              </el-button>

            </div>



            <!-- apply_with_backup: allow one-click rollback when a backup exists -->

            <div v-if="block.executed && hasBackupForBlock(block.blockId)" class="macro-actions-row">

              <el-button

                type="warning"

                size="small"

                plain

                @click="rollbackBlockNow(block)"

              >

                <el-icon><Refresh /></el-icon>

                回退上一版

              </el-button>

            </div>

          </div>



          <!-- 开发者模式：可选展示代码 -->

          <template v-if="showMacroCode">

            <pre class="code-content"><code :class="`language-${block.type === 'plan' ? 'json' : block.type}`">{{ block.code }}</code></pre>

          </template>



          <!-- 错误信息显示 -->

          <div v-if="block.error" class="error-info">

            <el-alert

              :title="block.error"

              type="error"

              :closable="false"

              show-icon

              size="small"

            />

          </div>

        </div>

      </div>



       <!-- 正常消息内容 - 只对用户消息和AI回复消息显示 -->

       <div v-if="props.message.type !== 'thinking' && (props.message.type === 'user' || hasAssistantText)" class="message-bubble">

         <div v-if="props.message.type === 'user'" class="message-text">

           {{ contentWithoutJS }}

         </div>

         <div v-else class="message-text">

           <div v-html="formatContent(assistantTextForDisplay)" />

         </div>

       </div>



      <!-- 消息操作按钮（由 Agent 处理） -->

      <div v-if="showActions && props.message.type === 'assistant'" class="message-actions">

        <el-button

          type="text"

          size="small"

          @click="handleAction('copy')"

        >

          <el-icon><CopyDocument /></el-icon>

          复制

        </el-button>

        <el-button

          type="text"

          size="small"

          @click="handleAction('remember')"

        >

          <el-icon><Document /></el-icon>

          记住

        </el-button>

        <span class="agentic-hint">由 Agent 智能处理</span>

      </div>

    </div>

  </div>

</template>



<script setup lang="ts">

import {

  User,

  ChatDotRound,

  CopyDocument,

  Document,

  ArrowRight,

  Select,

  Loading,

  CircleClose,

  Clock,

  Refresh,

  CaretRight

} from '@element-plus/icons-vue'

import { ref, computed, onErrorCaptured, onMounted } from 'vue'

import { ElMessage } from 'element-plus'

import { useChatStore } from '@/stores/chat'

import type { Message } from '@/services/types'
import { isDevUiEnabled } from '@/utils/dev-ui'



// 错误边界处理

const componentError = ref<Error | null>(null)

onErrorCaptured((error: Error) => {

  console.error('MessageItem组件错误:', error)

  componentError.value = error

  return false // 阻止错误继续传播

})



interface CodeBlock {

  type: 'js' | 'plan'

  code: string

  blockId: string

  description: string

  confirm?: boolean

  executed: boolean

  runStatus?: 'queued' | 'running' | 'success' | 'error'

  error?: string

  steps?: any[]

}



interface Props {

  message: Message

  showActions?: boolean

}



const props = withDefaults(defineProps<Props>(), {

  showActions: true

})



const emit = defineEmits<{

  (e: 'action', action: { type: string; messageId: string; data?: any }): void

}>()



const chatStore = useChatStore()

// 思考展开状态：只在 thinking 类型消息中显示工具条，assistant 类型不显示

const thinkingExpanded = ref(false)

const showMacroCode = ref(false)

const macroTargetBlockId = ref<string | null>(null)



const needsConfirm = (block: CodeBlock): boolean => {

  return !!block?.confirm

}



const confirmHintForBlock = (block: CodeBlock): string => {

  if (block?.confirm) return 'AI 建议确认后执行'

  return ''

}



const _docStorageIdForMessage = (): string => {

  try {

    const ctx: any = (props.message as any)?.metadata?.docContext || {}

    const path = String(ctx?.path || '').trim()

    const name = String(ctx?.name || '').trim()

    return path || name || ''

  } catch (e) {

    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e)

    return ''

  }

}



const hasBackupForBlock = (blockId: string): boolean => {

  try {

    if (typeof localStorage === 'undefined') return false

    const docId = _docStorageIdForMessage()

    const ah32 = String(blockId || '').trim()

    if (!docId || !ah32) return false

    const key = `__ah32:block_backup:${docId}:${ah32}`

    return !!localStorage.getItem(key)

  } catch (e) {

    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e)

    return false

  }

}



const applyWritebackNow = (block?: CodeBlock) => {

  try {

    const fn = (chatStore as any).enqueueWritebackForAssistantMessage

    if (typeof fn !== 'function') throw new Error('macro_queue_api_missing')

    const ah32 = String((block?.blockId || '') || (macroTargetBlockId.value || '')).trim()

    const opts = ah32 ? { onlyBlockIds: [ah32] } : undefined

    fn(props.message as any, macroTargetBlockId.value, opts)

  } catch (e: any) {

    console.error('应用写回失败:', e)

    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e)

    try {
      const msg = `应用写回失败：${String(e?.message || e || 'unknown_error')}`
      ;(globalThis as any).__ah32_logToBackend?.(`[UI] ${msg}`, 'error')
      ;(globalThis as any).__ah32_notify?.({
        type: 'error',
        title: '写回失败',
        message: `${msg}\n建议：确认目标文档仍打开并处于前台，然后点击“应用写回”重试；必要时截图反馈。`,
        durationMs: 0
      })
    } catch (e2) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e2)
      ElMessage.error('应用失败：请检查后端/插件是否连接正常，并重试。')
    }

  }

}



const rollbackBlockNow = (block: CodeBlock) => {

  try {

    const fn = (chatStore as any).enqueueRollbackForBlockId

    if (typeof fn !== 'function') throw new Error('macro_queue_api_missing')

    const dc = (props.message as any)?.metadata?.docContext || null

    fn({ blockId: block.blockId, messageId: props.message.id, docContext: dc })

  } catch (e: any) {

    console.error('回退失败:', e)

    ElMessage.error('回退失败：未找到上一版或文档不可用。')

  }

}



const getLatestAssistantMessageId = (): string | null => {

  try {

    const msgs = (chatStore as any).messages || []

    for (let i = msgs.length - 1; i >= 0; i--) {

      const m = msgs[i]

      if (m && m.type === 'assistant' && !m.isSystem) return m.id

    }

  } catch (e) {

    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e)

  }

  return null

}



// ==================== ✅ 修复：缓存代码块解析结果 ====================

let cachedTextSource = ''

let cachedTextValue = ''

let cachedBlocksKey = ''

let cachedCodeBlocks: CodeBlock[] = []

let cachedRunsTick = 0

const _isLikelyPlanJson = (s: string): boolean => {
  try {
    const t = String(s || '').trim()
    if (!t) return false
    if (!(t.startsWith('{') && t.endsWith('}'))) return false
    return t.includes('"schema_version"') && t.includes('ah32.plan.v1')
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e)
    return false
  }
}

const _extractPlansFromContent = (content: string): any[] => {
  const src = String(content || '')
  const out: any[] = []
  try {
    const re = /```json\\s*([\\s\\S]*?)```/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      const raw = String(m[1] || '').trim()
      if (!raw) continue
      try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && (parsed as any).schema_version === 'ah32.plan.v1') out.push(parsed)
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e)
      }
    }
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e)
  }

  // Some models output a raw JSON object (no ```json fence). Accept it for preview/UI rendering.
  try {
    const t = src.trim()
    if (_isLikelyPlanJson(t)) {
      const parsed = JSON.parse(t)
      if (parsed && typeof parsed === 'object' && (parsed as any).schema_version === 'ah32.plan.v1') out.push(parsed)
    }
  } catch (e) {
    // Best-effort: ignore but keep it observable.
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e)
  }

  return out
}

const _planTextPreviewFromPlan = (plan: any): string => {
  const texts: string[] = []
  const walk = (actions: any[]) => {
    for (const a of actions || []) {
      if (!a || typeof a !== 'object') continue
      const op = String((a as any).op || '').trim()
      if (op === 'insert_text' || op === 'insert_after_text' || op === 'insert_before_text') {
        const t = String((a as any).text || '')
        if (t.trim()) texts.push(t)
      }
      if (op === 'upsert_block' && Array.isArray((a as any).actions)) walk((a as any).actions)
      else if (Array.isArray((a as any).actions)) walk((a as any).actions)
    }
  }
  try { if (Array.isArray((plan as any)?.actions)) walk((plan as any).actions) } catch (e) { ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e) }
  const joined = texts.join('\\n').trim()
  // Keep UI responsive: cap preview length.
  return joined.length > 12000 ? `${joined.slice(0, 12000)}\\n…（已截断）` : joined
}

const _buildPlanStepsPreview = (plan: any): Array<{ title?: string; type?: string; content?: string }> => {
  const steps: Array<{ title?: string; type?: string; content?: string }> = []
  const add = (title: string, content: string) => {
    steps.push({ title, content })
  }
  const walk = (actions: any[]) => {
    for (const a of actions || []) {
      if (!a || typeof a !== 'object') continue
      const op = String((a as any).op || '').trim()
      if (op === 'upsert_block') {
        const bid = String((a as any).block_id || '').trim()
        if (bid) add('写回块', bid)
        if (Array.isArray((a as any).actions)) walk((a as any).actions)
        continue
      }
      if (op === 'insert_text' || op === 'insert_after_text' || op === 'insert_before_text') {
        const t = String((a as any).text || '')
        const n = t ? t.length : 0
        add('插入文本', n > 0 ? `${n} 字` : '')
        continue
      }
      if (op === 'delete_block') {
        const bid = String((a as any).block_id || '').trim()
        add('删除块', bid)
        continue
      }
      if (op) add('操作', op)
      if (Array.isArray((a as any).actions)) walk((a as any).actions)
    }
  }
  try { if (Array.isArray((plan as any)?.actions)) walk((plan as any).actions) } catch (e) { ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e) }
  return steps.slice(0, 12)
}

const _redactForDisplay = (obj: any): any => {
  const MAX_STR = 160
  const redactKeys = new Set(['text', 'anchor_text', 'html', 'markdown', 'content', 'prompt'])
  const walk = (v: any): any => {
    if (v == null) return v
    if (typeof v === 'string') {
      if (v.length <= MAX_STR) return v
      return `〈省略 ${v.length} 字〉`
    }
    if (Array.isArray(v)) return v.map(walk)
    if (typeof v === 'object') {
      const out: any = {}
      for (const [k, val] of Object.entries(v)) {
        if (redactKeys.has(k) && typeof val === 'string') {
          out[k] = val.length <= MAX_STR ? val : `〈省略 ${val.length} 字〉`
        } else {
          out[k] = walk(val)
        }
      }
      return out
    }
    return v
  }
  return walk(obj)
}



// 移除 JS 宏代码后的纯文本内容

const contentWithoutJS = computed(() => {

  // thinking消息的content字段本身就是空字符串，不需要在正常内容区域显示

  if (props.message.type === 'thinking') {

    return ''  // 确保thinking消息不显示正常内容

  }



  const sourceContent = props.message.content || ''



  // ✅ 缓存优化：只有 content 变化时才重新计算
  if (sourceContent === cachedTextSource) {

    return cachedTextValue

  }



  cachedTextSource = sourceContent

  const maybeSseMetaEnvelope = (() => {

    const s = sourceContent.trim()

    if (!s || s.length > 6000) return false

    if (!s.startsWith('{') || !s.endsWith('}')) return false

    return s.includes('"session_id"') && s.includes('"elapsed_ms"') && s.includes('"token_usage"')

  })()

  if (maybeSseMetaEnvelope) {

    cachedTextValue = ''

    return cachedTextValue

  }

  // If the model output is a raw Plan JSON object, don't show it as normal chat text.
  // We'll render a readable preview instead (derived from actions).
  if (_isLikelyPlanJson(sourceContent)) {

    cachedTextValue = ''

    return cachedTextValue

  }

  cachedTextValue = sourceContent

    .replace(/```(?:js|javascript)\s*[\s\S]*?```/g, '')

    .replace(/```json\s*([\s\S]*?)```/g, (full, body) => {

      const s = String(body || '')

      if (s.includes('"schema_version"') && s.includes('ah32.plan.v1')) return ''

      return full

    })

    .trim()

  return cachedTextValue

})

const planDerivedAssistantText = computed(() => {
  try {
    if (props.message.type !== 'assistant') return ''
    const plans = _extractPlansFromContent(String(props.message.content || ''))
    if (!plans || plans.length <= 0) return ''
    const text = _planTextPreviewFromPlan(plans[0])
    return String(text || '').trim()
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e)
    return ''
  }
})

const assistantTextForDisplay = computed(() => {
  try {
    if (props.message.type !== 'assistant') return String(contentWithoutJS.value || '')
    const t = String(contentWithoutJS.value || '').trim()
    if (t) return t
    return String(planDerivedAssistantText.value || '').trim()
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e)
    return String(contentWithoutJS.value || '')
  }
})

const hasAssistantText = computed(() => {
  try {
    if (props.message.type !== 'assistant') return false
    return !!String(assistantTextForDisplay.value || '').trim()
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e)
    return false
  }
})



// 提取代码块 (只支持 JS 宏)

const codeBlocks = computed<CodeBlock[]>(() => {

  const blocks: CodeBlock[] = []



  // thinking消息不包含代码块，代码块只在assistant消息的content中

  if (props.message.type === 'thinking') {

    return blocks

  }



  const sourceContent = props.message.content || ''

  const cacheKey = `${sourceContent}::${macroTargetBlockId.value || ''}`

  const runsTick = (() => {

    try { return Number((chatStore as any).macroBlockRunsTick) || 0 } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e); return 0 }

  })()



  const extractBlockIdHeader = (code: string): string | null => {

    const m = String(code || '').match(/^\s*\/\/\s*@ah32:blockId\s*=\s*([^\s]+)\s*$/m)

    if (!m || !m[1]) return null

    return String(m[1]).trim()

  }



  const stripBlockIdHeader = (code: string): string => {

    // Remove any existing header lines; we always inject the correct one at execution time.

    const out = String(code || '').replace(

      /^\s*\/\/\s*@ah32:blockId\s*=\s*[^\s]+\s*$(\r?\n)?/gm,

      ''

    )

    return out.trim()

  }



  const rehydrateFromRuns = (src: CodeBlock[]): CodeBlock[] => {

    try {

      return (src || []).map((b) => {

        try {

          const run = (chatStore as any).getMacroBlockRun?.(props.message.id, b.blockId)

          const s = String(run?.status || '')

          const executed = s === 'success'

          const error = s === 'error'

            ? ((typeof run?.error === 'string' && run.error.trim()) ? run.error.trim() : '执行失败')

            : undefined

          // Prefer finalCode from store if present (may include the injected header).

          let code = b.code

          if (typeof run?.finalCode === 'string' && run.finalCode.trim()) {

            code = stripBlockIdHeader(run.finalCode.trim())

          }

          // Plan JSON can be huge; redact long text fields for display (正文 belongs in the document/bubble, not macro card).
          if (b.type === 'plan') {

            try {

              const parsed = JSON.parse(code)

              code = JSON.stringify(_redactForDisplay(parsed), null, 2)

            } catch (e) {

              // keep as-is

            }

          }

          return {

            ...b,

            code,

            executed,

            runStatus: (s === 'queued' || s === 'running' || s === 'success' || s === 'error') ? (s as any) : undefined,

            error

          }

        } catch (e) {

          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e)

          return b

        }

      })

    } catch (e) {

      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e)

      return src

    }

  }



  // ✅ 缓存优化：只有 content 变化时才重新解析

  if (cacheKey === cachedBlocksKey && cachedCodeBlocks.length > 0) {

    // Only rehydrate statuses when runs change; avoid re-parsing huge content repeatedly.

    if (cachedRunsTick !== runsTick) {

      cachedCodeBlocks = rehydrateFromRuns(cachedCodeBlocks)

      cachedRunsTick = runsTick

    }

    return cachedCodeBlocks

  }



  // JS 宏通道已移除：忽略所有 ```js```/```javascript``` 代码块，避免误执行/误展示。

  const regex = /a^/g

  let match

  let jsIndex = 0



  while ((match = regex.exec(sourceContent)) !== null) {

    if (match[1]) {

      const rawCode = match[1].trim()

      const headerId = extractBlockIdHeader(rawCode)

      const isUpdate = !!macroTargetBlockId.value && jsIndex === 0

      // For updates, always reuse the target blockId (avoid “new id” that causes duplication).

      const blockId = isUpdate

        ? String(macroTargetBlockId.value)

        : (headerId || `macro_${props.message.id}_${jsIndex + 1}`)

      // Hydrate execution status from persisted store so reopened history can render it.

      let executed = false

      let error: string | undefined = undefined

      let hydratedCode = rawCode

      try {

        const run = (chatStore as any).getMacroBlockRun?.(props.message.id, blockId)

        if (run && typeof run === 'object') {

          if (run.status === 'success') executed = true

          if (run.status === 'error') {

            error = (typeof run.error === 'string' && run.error.trim()) ? run.error : '执行失败'

          }

          if (typeof run.finalCode === 'string' && run.finalCode.trim()) {

            hydratedCode = run.finalCode.trim()

          }

        }

      } catch (e) {

        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e)

      }

      // Backward-compat: older sessions only recorded "message executed" without per-block state.

      if (!executed && !error) {

        try {

          if ((chatStore as any).isMacroMessageExecuted?.(props.message.id)) executed = true

        } catch (e) {

          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e)

        }

      }

      blocks.push({

        type: 'js',

        code: stripBlockIdHeader(hydratedCode),

        blockId,

        description: extractDescription(rawCode),

        confirm: hasConfirmDirective(hydratedCode || rawCode),

        executed,

        runStatus: (() => {

          try {

            const run = (chatStore as any).getMacroBlockRun?.(props.message.id, blockId)

            const s = String(run?.status || '')

            return (s === 'queued' || s === 'running' || s === 'success' || s === 'error') ? (s as any) : undefined

          } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e); return undefined }

        })(),

        error

      })

      jsIndex += 1

    }

  }



  // Plan JSON blocks (```json ...```), recognized by schema_version.

  const planRegex = /```json\s*([\s\S]*?)```/gi

  let planMatch

  let planIndex = 0

  while ((planMatch = planRegex.exec(sourceContent)) !== null) {

    const raw = String(planMatch[1] || '').trim()
    if (raw.length > 500000) {
      try {
        ;(globalThis as any).__ah32_reportError?.(
          'ah32-ui-next/src/components/chat/MessageItem.vue',
          new Error(`plan json too large in message item (${raw.length})`)
        )
      } catch (e) {
        try {
          ;(globalThis as any).__ah32_logToBackend?.(
            `[MessageItem] report oversized plan failed: ${String((e as any)?.message || e)}`,
            'warning'
          )
        } catch (e2) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e2)
        }
      }
      continue
    }

    if (!raw) continue

    let plan: any = null

    try {

      plan = JSON.parse(raw)

    } catch (e) {

      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e)

      plan = null

    }

    if (!plan || plan.schema_version !== 'ah32.plan.v1') continue



    const walkFind = (actions: any[]): string => {
      for (const a of actions || []) {
        if (!a || typeof a !== 'object') continue
        if ((a as any).op === 'upsert_block' && typeof (a as any).block_id === 'string') return String((a as any).block_id || '').trim()
        if ((a as any).op === 'delete_block' && typeof (a as any).block_id === 'string') return String((a as any).block_id || '').trim()
        if (Array.isArray((a as any).actions)) {
          const nested = walkFind((a as any).actions)
          if (nested) return nested
        }
      }
      return ''
    }

    const walkOverride = (actions: any[], blockId: string): boolean => {
      for (const a of actions || []) {
        if (!a || typeof a !== 'object') continue
        if ((a as any).op === 'upsert_block') {
          ;(a as any).block_id = blockId
          return true
        }
        if (Array.isArray((a as any).actions) && walkOverride((a as any).actions, blockId)) return true
      }
      return false
    }

    const isUpdate = !!macroTargetBlockId.value && planIndex === 0
    if (isUpdate) {
      try { if (Array.isArray((plan as any).actions)) walkOverride((plan as any).actions, String(macroTargetBlockId.value)) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e) }
    }

    const planBlockId = walkFind((plan as any).actions)
    const blockId = isUpdate
      ? String(macroTargetBlockId.value)
      : (planBlockId || `plan_${props.message.id}_${planIndex + 1}`)



    let executed = false

    let error: string | undefined = undefined

    let hydratedCode = (() => {
      try { return JSON.stringify(plan) } catch (e) { return raw }
    })()

    try {

      const run = (chatStore as any).getMacroBlockRun?.(props.message.id, blockId)

      if (run && typeof run === 'object') {

        if (run.status === 'success') executed = true

        if (run.status === 'error') {

          error = (typeof run.error === 'string' && run.error.trim()) ? run.error : '执行失败'

        }

        if (typeof run.finalCode === 'string' && run.finalCode.trim()) {

          hydratedCode = run.finalCode.trim()

        }

      }

    } catch (e: any) {

      throw e

    }

    if (!executed && !error) {

      try {

        if ((chatStore as any).isMacroMessageExecuted?.(props.message.id)) executed = true

      } catch (e) {

        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e)

      }

    }



    const description =

      (typeof plan?.meta?.title === 'string' && plan.meta.title.trim())

        ? String(plan.meta.title).trim()

        : (typeof plan?.actions?.[0]?.title === 'string' && String(plan.actions[0].title).trim())

          ? String(plan.actions[0].title).trim()

          : 'Plan'

    // Prepare a redacted code view for Dev UI (do not dump正文 into macro card).

    let displayCode = hydratedCode

    try {

      const parsed = JSON.parse(hydratedCode)

      displayCode = JSON.stringify(_redactForDisplay(parsed), null, 2)

    } catch (e) {

      displayCode = hydratedCode

    }



       blocks.push({

         type: 'plan',

         code: displayCode,

         blockId,

         description,

         steps: _buildPlanStepsPreview(plan),

         executed,

         runStatus: (() => {

           try {

             const run = (chatStore as any).getMacroBlockRun?.(props.message.id, blockId)

             const s = String(run?.status || '')

            return (s === 'queued' || s === 'running' || s === 'success' || s === 'error') ? (s as any) : undefined

          } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e); return undefined }

        })(),

        error

      })

      planIndex += 1

  }

  // Raw plan JSON (no ```json fence). Keep it consistent with chat store extraction.

  if (planIndex === 0) {

    try {

      const raw = String(sourceContent || '').trim()

      if (_isLikelyPlanJson(raw)) {

        const plan: any = JSON.parse(raw)

        if (plan && typeof plan === 'object' && plan.schema_version === 'ah32.plan.v1') {

          const walkFind = (actions: any[]): string => {
            for (const a of actions || []) {
              if (!a || typeof a !== 'object') continue
              if ((a as any).op === 'upsert_block' && typeof (a as any).block_id === 'string') return String((a as any).block_id || '').trim()
              if ((a as any).op === 'delete_block' && typeof (a as any).block_id === 'string') return String((a as any).block_id || '').trim()
              if (Array.isArray((a as any).actions)) {
                const nested = walkFind((a as any).actions)
                if (nested) return nested
              }
            }
            return ''
          }

          const planBlockId = (() => {
            try { return Array.isArray((plan as any).actions) ? walkFind((plan as any).actions) : '' } catch (e) { ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e); return '' }
          })()

          const isUpdate = !!macroTargetBlockId.value
          const blockId = isUpdate
            ? String(macroTargetBlockId.value)
            : (planBlockId || `plan_${props.message.id}_1`)

          const description =
            (typeof plan?.meta?.title === 'string' && String(plan.meta.title).trim())
              ? String(plan.meta.title).trim()
              : (typeof plan?.actions?.[0]?.title === 'string' && String(plan.actions[0].title).trim())
                ? String(plan.actions[0].title).trim()
                : 'Plan'

          let executed = false
          let error: string | undefined = undefined
          let hydratedCode = (() => {
            try { return JSON.stringify(plan) } catch (e) { return raw }
          })()

          try {
            const run = (chatStore as any).getMacroBlockRun?.(props.message.id, blockId)
            if (run && typeof run === 'object') {
              if (run.status === 'success') executed = true
              if (run.status === 'error') error = (typeof run.error === 'string' && run.error.trim()) ? run.error : '执行失败'
              if (typeof run.finalCode === 'string' && run.finalCode.trim()) hydratedCode = run.finalCode.trim()
            }
          } catch (e) {
            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e)
          }

          let displayCode = hydratedCode
          try {
            const parsed = JSON.parse(hydratedCode)
            displayCode = JSON.stringify(_redactForDisplay(parsed), null, 2)
          } catch (e) {
            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e)
          }

          blocks.push({
            type: 'plan',
            code: displayCode,
            blockId,
            description,
            steps: _buildPlanStepsPreview(plan),
            executed,
            runStatus: (() => {
              try {
                const run = (chatStore as any).getMacroBlockRun?.(props.message.id, blockId)
                const s = String(run?.status || '')
                return (s === 'queued' || s === 'running' || s === 'success' || s === 'error') ? (s as any) : undefined
              } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e); return undefined }
            })(),
            error
          })

        }

      }

    } catch (e) {

      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e)

    }

  }



  // If the message stores structured macro blocks (e.g. tool-based execution), render from metadata

  // even if the plain text content doesn't contain fenced code.

  if (blocks.length === 0) {

    try {

      const metaBlocks = (props.message as any)?.metadata?.macroBlocks

      if (Array.isArray(metaBlocks) && metaBlocks.length > 0) {

        for (const mb of metaBlocks) {

          const blockId = String(mb?.blockId || '').trim()

          if (!blockId) continue

          const kind = (mb?.type === 'plan') ? 'plan' : 'js'
          const description = String(mb?.description || mb?.title || '宏任务').trim() || '宏任务'

          let executed = false
          let runStatus: CodeBlock['runStatus'] = undefined
          let error: string | undefined = undefined
          let code = ''
          let steps: any[] | undefined = undefined

          try {
            const run = (chatStore as any).getMacroBlockRun?.(props.message.id, blockId)
            const s = String(run?.status || '')
            runStatus = (s === 'queued' || s === 'running' || s === 'success' || s === 'error') ? (s as any) : undefined
            executed = s === 'success'
            if (s === 'error') {
              error = (typeof run?.error === 'string' && run.error.trim()) ? run.error.trim() : '执行失败'
            }
            if (typeof run?.finalCode === 'string' && run.finalCode.trim()) {
              // Prefer persisted finalCode so users can retry even if message content is truncated.
              code = kind === 'js' ? stripBlockIdHeader(run.finalCode.trim()) : run.finalCode.trim()
            }
          } catch (e) {
            ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e)
          }

          if (kind === 'plan' && code) {
            try {
              const parsed = JSON.parse(code)
              steps = _buildPlanStepsPreview(parsed)
              code = JSON.stringify(_redactForDisplay(parsed), null, 2)
            } catch (e) {
              // keep as-is
            }
          }

          blocks.push({
            type: kind,
            code,
            blockId,
            description,
            steps,
            executed,
            runStatus,
            error
          })

        }

      }

    } catch (e) {

      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e)

    }

  }



  // If parsing yields no fenced macros, keep previous cards (they represent real queued/running work)

  // so users don't lose visibility mid-execution.

  if (blocks.length === 0 && cachedCodeBlocks.length > 0) {

    if (cachedRunsTick !== runsTick) {

      cachedCodeBlocks = rehydrateFromRuns(cachedCodeBlocks)

      cachedRunsTick = runsTick

    }

    return cachedCodeBlocks

  }



  cachedBlocksKey = cacheKey

  cachedCodeBlocks = rehydrateFromRuns(blocks)

  cachedRunsTick = runsTick

  return cachedCodeBlocks

})



/**

 * 提取 JS 宏代码描述

 * ⭐ 从代码注释或函数名提取描述

 */

const hasConfirmDirective = (code: string): boolean => {

  try {

    const m = String(code || '').match(/^\s*\/\/\s*@ah32:confirm(?:\s*=\s*([^\s]+))?\s*$/mi)

    if (!m) return false

    const raw = String(m[1] || '').trim().toLowerCase()

    if (!raw) return true

    if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false

    return true

  } catch (e) {

    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e)

    return false

  }

}



const extractDescription = (code: string): string => {

  // 1. 提取第一行注释作为描述（支持 // 注释）

  const firstLine = String(code || '').split(/\r?\n/)[0] || ''

  const firstLineTrimmed = firstLine.trim()

  // If the model puts internal directives on the first line (commented or not), never show it to users.

  // Examples: "@ah32:anchor=end", "/* @ah32:anchor=end */"

  const looksLikeInternalDirective = /@ah32\s*:/i.test(firstLineTrimmed)

  const commentMatch = firstLine.match(/^\s*\/\/\s*(.+)/)

  if (commentMatch && commentMatch[1] && commentMatch[1].trim()) {

    const t = commentMatch[1].trim()

    // Hide internal directives from user-facing titles.

    if (/@ah32\s*:/i.test(t)) {

      // e.g. "@ah32:anchor=end" -> ignore

    } else {

      return t

    }

  }

  if (!looksLikeInternalDirective) {

    // Some models emit a plain-text first line (no leading //) that still describes the macro.

    // Keep it conservative: only accept a short first line.

    const t = firstLineTrimmed

    if (t && t.length <= 40 && !/^\s*(function|const|let|var)\b/.test(t)) {

      return t

    }

  }



  // 2. 提取函数名作为描述

  const funcMatch = code.match(/function\s+(\w+)/)

  if (funcMatch) {

    return funcMatch[1]

  }



  // 3. 提取箭头函数名（如果变量声明中有）

  const arrowMatch = code.match(/const\s+(\w+)\s*=/)

  if (arrowMatch) {

    return arrowMatch[1]

  }



  // 4. 默认描述

  return '文档操作'

}





const getSenderName = () => {

  if (props.message.type === 'user') return '我'

  if (props.message.type === 'assistant') return '阿蛤'

  if (props.message.type === 'thinking') return '思考中...'

  return '未知'

}



const getAvatarIcon = () => {

  if (props.message.type === 'user') return User

  return ChatDotRound

}



const formatTime = (time: Date) => {

  return new Date(time).toLocaleTimeString('zh-CN', {

    hour: '2-digit',

    minute: '2-digit'

  })

}



const formatContent = (content: string) => {

  return content

    .replace(/\n/g, '<br>')

    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')

    .replace(/\*(.*?)\*/g, '<em>$1</em>')

    .replace(/`(.*?)`/g, '<code>$1</code>')

}



// 宏卡片：只负责展示状态（执行由 chat store 的宏队列统一调度，避免并发踩踏）。

onMounted(() => {

  // 只对助手消息自动执行

  if (props.message.type !== 'assistant') return



  // 只自动执行“最新的一条助手消息”，避免历史消息/恢复会话时重复改文档。

  const latestAssistantId = getLatestAssistantMessageId()

  if (!latestAssistantId || props.message.id !== latestAssistantId) return



  // 如果用户这轮是“优化/修改上一次”，复用上一次 blockId，保证覆盖而不是叠加。

  try {

    macroTargetBlockId.value = (chatStore as any).consumePendingMacroUpdateBlockId?.() || null

  } catch (e) {

    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e)

  }



  // 默认不展示代码；仅在启用 Dev UI（.env / build-time）时展示，避免引入运行时开关。
  showMacroCode.value = isDevUiEnabled()

  // 仅在展示代码时做高亮，避免无意义的 DOM 扫描

  if (showMacroCode.value) {

    highlightCodeBlocks()

  }

})



// 简单的JavaScript代码高亮函数

const highlightCodeBlocks = () => {

  const codeBlocks = document.querySelectorAll('.code-content code')

  codeBlocks.forEach(block => {

    if (block.classList.contains('language-js')) {

      const code = block.textContent || ''

      const highlightedCode = highlightJavaScript(code)

      block.innerHTML = highlightedCode

    }

  })

}



// JavaScript语法高亮实现

const highlightJavaScript = (code: string): string => {

  // 关键字

  const keywords = /\b(break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|function|if|import|in|instanceof|let|new|return|super|switch|this|throw|try|typeof|var|void|while|with|yield)\b/g



  // 字符串

  const strings = /(["'`])(?:(?=(\\?))\2.)*?\1/g



  // 注释

  const comments = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g



  // 数字

  const numbers = /\b\d+(\.\d+)?\b/g



  // 函数

  const functions = /\b[a-zA-Z_$][a-zA-Z0-9_$]*\s*(?=\()/g



  let highlightedCode = code

    .replace(comments, '<span class="token comment">$&</span>')

    .replace(strings, '<span class="token string">$1</span>')

    .replace(keywords, '<span class="token keyword">$1</span>')

    .replace(numbers, '<span class="token number">$&</span>')

    .replace(functions, '<span class="token function">$&</span>')



  return highlightedCode

}



const handleAction = async (actionType: string) => {

  switch (actionType) {

    case 'copy':

      try {

        // If this assistant message is plan-only, copy the readable preview instead of raw JSON.

        const preview = String(assistantTextForDisplay.value || '').trim()

        const isPlanOnly = props.message.type === 'assistant' && !String(contentWithoutJS.value || '').trim() && !!preview

        if (isPlanOnly) {

          await navigator.clipboard.writeText(preview)

          ElMessage.success('已复制到剪贴板')

          break

        }

      } catch (e) {

        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/MessageItem.vue', e)

      }

      {

        const success = await chatStore.copyMessage(props.message.id)

        if (success) {

          ElMessage.success('已复制到剪贴板')

        } else {

          ElMessage.error('复制失败')

        }

      }

      break

    case 'remember':

      emit('action', {

        type: 'remember-memory',

        messageId: props.message.id,

        data: {

          text: assistantTextForDisplay.value || contentWithoutJS.value || props.message.content || '',

          role: props.message.type

        }

      })

      break

  }

}



</script>



<style scoped lang="scss">

.message-item {

  display: flex;

  gap: 8px;

  margin-bottom: 12px;

  /* 添加微妙的进入动画 */

  animation: fadeInUp 0.3s ease-out;



  &.message-user {

    flex-direction: row-reverse;



    .message-content {

      align-items: flex-end;

    }



    .message-bubble {

      background: var(--primary-gradient);

      color: #fff;

      border-radius: var(--border-radius-xl) var(--border-radius-xl) var(--border-radius-sm) var(--border-radius-xl);

      box-shadow: var(--shadow-lg);

      position: relative;

      overflow: hidden;

      backdrop-filter: blur(10px);

      -webkit-backdrop-filter: blur(10px);

      border: 1px solid rgba(255, 255, 255, 0.2);



      &::before {

        content: '';

        position: absolute;

        top: 0;

        left: 0;

        right: 0;

        bottom: 0;

        background: linear-gradient(135deg, rgba(255, 255, 255, 0.15) 0%, rgba(255, 255, 255, 0) 100%);

        pointer-events: none;

      }



      &::after {

        content: '';

        position: absolute;

        top: 8px;

        right: -4px;

        width: 0;

        height: 0;

        border-left: 8px solid rgba(102, 126, 234, 0.8);

        border-top: 6px solid transparent;

        border-bottom: 6px solid transparent;

        filter: blur(1px);

      }

    }



    .message-header {

      flex-direction: row-reverse;

    }



    .message-avatar {

      .el-avatar {

        border: 2px solid var(--primary-color);

        box-shadow: var(--shadow-sm);

      }

    }

  }



  &.message-assistant {

    .message-bubble {

      background: var(--bg-color);

      color: var(--text-primary);

      border-radius: var(--border-radius-xl) var(--border-radius-xl) var(--border-radius-xl) var(--border-radius-sm);

      box-shadow: var(--shadow-md);

      border: 1px solid var(--border-light);

      position: relative;

      overflow: hidden;

      backdrop-filter: blur(12px);

      -webkit-backdrop-filter: blur(12px);



      &::before {

        content: '';

        position: absolute;

        top: 0;

        left: 0;

        width: 4px;

        height: 100%;

        background: var(--primary-gradient);

        border-radius: 0 var(--border-radius-sm) var(--border-radius-sm) 0;

      }



      &::after {

        content: '';

        position: absolute;

        top: 0;

        left: 0;

        right: 0;

        bottom: 0;

        background: linear-gradient(135deg, rgba(102, 126, 234, 0.02) 0%, rgba(118, 75, 162, 0.02) 100%);

        pointer-events: none;

      }

    }



    .message-avatar {

      .el-avatar {

        background: var(--secondary-gradient);

        border: 2px solid rgba(102, 126, 234, 0.2);

        box-shadow: var(--shadow-sm);

      }

    }

  }



  &.message-thinking {

    .thinking-wrapper {

      background: rgba(102, 126, 234, 0.05);

      border: 1px solid rgba(102, 126, 234, 0.15);

      border-radius: var(--border-radius-lg);

      padding: var(--spacing-md);

      margin-bottom: var(--spacing-sm);

      box-shadow: var(--shadow-sm);

      backdrop-filter: blur(8px);

      -webkit-backdrop-filter: blur(8px);

      position: relative;

      overflow: hidden;



      &::before {

        content: '';

        position: absolute;

        top: 0;

        left: 0;

        right: 0;

        height: 1px;

        background: linear-gradient(90deg, transparent 0%, rgba(102, 126, 234, 0.3) 50%, transparent 100%);

      }

    }



    .thinking-header {

      display: flex;

      align-items: center;

      justify-content: space-between;

      cursor: pointer;

      user-select: none;

      padding: var(--spacing-sm);

      border-radius: var(--border-radius-base);

      transition: var(--transition-normal);



      &:hover {

        background-color: rgba(102, 126, 234, 0.08);

      }

    }



    .thinking-label {

      display: flex;

      align-items: center;

      gap: var(--spacing-sm);

      font-weight: 600;

      color: var(--primary-color);

      font-size: 13px;

    }



    .thinking-icon {

      transition: transform var(--transition-normal);

      color: var(--primary-color);

      font-size: 14px;



      &.rotated {

        transform: rotate(90deg);

      }

    }



    .thinking-toggle {

      font-size: 12px;

      color: var(--text-secondary);

      opacity: 0.8;

      font-weight: 500;

    }



    .thinking-content {

      margin-top: var(--spacing-sm);

      padding: var(--spacing-md);

      background: rgba(255, 255, 255, 0.6);

      border-radius: var(--border-radius-base);

      white-space: pre-wrap;

      word-break: break-word;

      font-size: 13px;

      line-height: 1.6;

      color: var(--text-regular);

      border-left: 3px solid var(--primary-color);

      backdrop-filter: blur(4px);

      -webkit-backdrop-filter: blur(4px);

    }

  }



  .error-boundary {

    width: 100%;

    margin-bottom: 12px;

  }



  .message-avatar {

    flex-shrink: 0;



    .el-avatar {

      transition: var(--transition-normal);

      box-shadow: var(--shadow-sm);



      &:hover {

        transform: scale(1.05);

        box-shadow: var(--shadow-md);

      }

    }

  }



  .message-content {

    flex: 1;

    display: flex;

    flex-direction: column;

    align-items: flex-start;

    min-width: 0;

  }



  .message-header {

    display: flex;

    align-items: center;

    gap: var(--spacing-sm);

    margin-bottom: var(--spacing-xs);

  }



  .message-sender {

    font-weight: 600;

    color: var(--text-primary);

    font-size: 14px;

    background: var(--primary-gradient);

    -webkit-background-clip: text;

    -webkit-text-fill-color: transparent;

    background-clip: text;

  }



  .message-time {

    font-size: 12px;

    color: var(--text-secondary);

    opacity: 0.8;

  }



  .message-bubble {

    padding: var(--spacing-md) var(--spacing-lg);

    max-width: 100%;

    word-wrap: break-word;

    line-height: 1.7;

    transition: var(--transition-normal);

    backdrop-filter: blur(12px);

    -webkit-backdrop-filter: blur(12px);

    position: relative;



    &:hover {

      transform: translateY(-1px);

      box-shadow: var(--shadow-lg);

    }

  }



  .message-text {

    font-size: 14px;

    line-height: 1.7;

    white-space: pre-wrap;

    word-break: break-word;

  }



  .code-blocks {

    margin-top: var(--spacing-md);

    position: relative;

  }



  .code-block {

    background: #0f172a;

    border-radius: var(--border-radius-lg);

    overflow: hidden;

    margin-bottom: var(--spacing-md);

    box-shadow: var(--shadow-xl);

    border: 1px solid rgba(102, 126, 234, 0.2);

    transition: var(--transition-normal);

    position: relative;



    &::before {

      content: '';

      position: absolute;

      top: 0;

      left: 0;

      right: 0;

      height: 1px;

      background: linear-gradient(90deg, transparent 0%, rgba(102, 126, 234, 0.4) 50%, transparent 100%);

    }



    &:hover {

      transform: translateY(-2px);

      box-shadow: var(--shadow-2xl);

      border-color: rgba(102, 126, 234, 0.4);

    }

  }



  .code-header {

    display: flex;

    align-items: center;

    justify-content: space-between;

    flex-wrap: nowrap;

    /* Extra padding so the status tag won't visually clip on the rounded corner. */

    padding: calc(var(--spacing-md) + 2px) calc(var(--spacing-lg) + 12px);

    background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);

    border-bottom: 1px solid rgba(102, 126, 234, 0.3);

    position: relative;

    gap: var(--spacing-md);



    &::after {

      content: '';

      position: absolute;

      bottom: 0;

      left: 0;

      right: 0;

      height: 1px;

      background: linear-gradient(90deg, transparent 0%, rgba(102, 126, 234, 0.5) 50%, transparent 100%);

    }

  }



  .code-title {

    display: flex;

    align-items: center;

    gap: var(--spacing-sm);

    font-size: 13px;

    font-weight: 600;

    color: #e2e8f0;

    flex: 1;

    min-width: 0;



    .el-icon {

      color: var(--primary-color);

      font-size: 13px;

    }

  }



  .code-title-text {

    overflow: hidden;

    text-overflow: ellipsis;

    white-space: nowrap;

    display: inline-block;

    min-width: 0;

  }



  .code-title-count {

    margin-left: 6px;

    font-size: 11px;

    opacity: 0.75;

    white-space: nowrap;

  }



  .code-actions {

    display: flex;

    align-items: center;

    gap: var(--spacing-sm);

    flex-shrink: 0;

    margin-left: auto;

    margin-right: 0;

    justify-content: flex-end;



    .status-tag {

      display: inline-flex;

      align-items: center;

      gap: 4px;

      white-space: nowrap;

      line-height: 1;

      border-radius: var(--border-radius-sm);

      font-weight: 500;

      font-size: 11px;

      padding: 3px 6px;

      backdrop-filter: blur(4px);

      -webkit-backdrop-filter: blur(4px);



      &.icon-only {

        width: 22px;

        height: 22px;

        padding: 0;

        justify-content: center;

        gap: 0;

      }



      .loading-icon {

        animation: spin 1s linear infinite;

      }

    }

  }



  .code-content {

    margin: 0;

    padding: var(--spacing-lg);

    overflow-x: auto;

    background: #0f172a;

    font-family: 'SF Mono', 'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', 'Courier New', monospace;



    code {

      font-size: 13px;

      line-height: 1.7;

      color: #e2e8f0;

      font-feature-settings: "liga" 1, "calt" 1;

      font-variant-ligatures: common-ligatures;



      /* 语法高亮样式 - 增强对比度 */

      .token.comment {

        color: #64748b;

        font-style: italic;

      }



      .token.string {

        color: #10b981;

        font-weight: 500;

      }



      .token.keyword {

        color: #8b5cf6;

        font-weight: 600;

      }



      .token.number {

        color: #f59e0b;

        font-weight: 500;

      }



      .token.function {

        color: #3b82f6;

        font-weight: 500;

      }



      .token.punctuation {

        color: #94a3b8;

      }



      .token.operator {

        color: #f97316;

      }



      .token.variable {

        color: #ef4444;

      }

    }

  }



  @keyframes spin {

    from {

      transform: rotate(0deg);

    }

    to {

      transform: rotate(360deg);

    }

  }



  @keyframes fadeInUp {

    from {

      opacity: 0;

      transform: translateY(10px);

    }

    to {

      opacity: 1;

      transform: translateY(0);

    }

  }



  .error-info {

    padding: 8px 12px;

    background: #fff5f5;

    border-top: 1px solid #ff4d4f;



    :deep(.el-alert) {

      margin: 0;

      padding: 8px 12px;



      .el-alert__title {

        font-size: 12px;

        line-height: 1.4;

        word-break: break-word;

      }

    }

  }



  .code-operations {

    padding: var(--spacing-md) var(--spacing-lg);

    border-top: 1px solid rgba(62, 64, 72, 0.5);

    display: flex;

    justify-content: center;

    gap: var(--spacing-md);

    background: rgba(15, 23, 42, 0.5);

  }



  .macro-steps {

    padding: var(--spacing-md) var(--spacing-lg);

    background: rgba(2, 6, 23, 0.35);

    border-top: 1px solid rgba(102, 126, 234, 0.18);

  }



  .macro-steps-empty {

    color: rgba(226, 232, 240, 0.75);

    font-size: 13px;

  }



  .macro-confirm-hint {

    margin-top: 8px;

    color: #fbbf24;

    font-size: 12px;

  }



  .macro-actions-row {

    margin-top: 10px;

    display: flex;

    gap: var(--spacing-sm);

    flex-wrap: wrap;

  }



  .macro-step {

    padding: 10px 12px;

    border: 1px solid rgba(148, 163, 184, 0.18);

    border-radius: 10px;

    background: rgba(15, 23, 42, 0.55);

    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.22);



    & + .macro-step {

      margin-top: 10px;

    }

  }



  .macro-step-title {

    color: #e2e8f0;

    font-size: 13px;

    font-weight: 600;

    margin-bottom: 6px;

  }



  .macro-step-content {

    color: rgba(226, 232, 240, 0.82);

    font-size: 13px;

    line-height: 1.6;

    white-space: pre-wrap;

    word-break: break-word;

  }



  .message-actions {

    display: flex;

    align-items: center;

    gap: var(--spacing-sm);

    margin-top: var(--spacing-md);

    padding: var(--spacing-md) 0;

    border-top: 1px solid var(--border-lighter);

    background: rgba(255, 255, 255, 0.02);

    backdrop-filter: blur(4px);

    -webkit-backdrop-filter: blur(4px);

    border-radius: var(--border-radius-base);

  }



  .agentic-hint {

    margin-left: auto;

    font-size: 12px;

    color: var(--text-secondary);

    font-style: italic;

    opacity: 0.7;

  }



  /* 错误信息样式增强 */

  .error-info {

    padding: var(--spacing-md) var(--spacing-lg);

    background: rgba(239, 68, 68, 0.05);

    border-top: 1px solid rgba(239, 68, 68, 0.2);

    backdrop-filter: blur(8px);

    -webkit-backdrop-filter: blur(8px);



    :deep(.el-alert) {

      margin: 0;

      padding: var(--spacing-md) var(--spacing-lg);

      border-radius: var(--border-radius-base);

      background: rgba(239, 68, 68, 0.1);

      border: 1px solid rgba(239, 68, 68, 0.2);

      backdrop-filter: blur(4px);

      -webkit-backdrop-filter: blur(4px);



      .el-alert__title {

        font-size: 13px;

        line-height: 1.5;

        word-break: break-word;

        color: var(--danger-color);

      }

    }

  }

}

</style>

