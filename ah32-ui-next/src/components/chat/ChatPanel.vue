<template>
  <div class="chat-panel">
    <!-- 消息列表 -->
    <div class="messages-container" ref="messagesContainer">
      <div class="messages-wrapper">
        <MessageItem
          v-for="message in chatStore.messages"
          :key="message.id"
          :message="message"
          @action="handleMessageAction"
        />

        <!-- AI 思考指示器 -->
        <ThinkingIndicator v-if="chatStore.isThinking" />

        <!-- 空状态：Agentic 引导提示 -->
        <div v-if="!chatStore.messages.length && !chatStore.isThinking" class="empty-state">
          <el-icon :size="48"><ChatDotRound /></el-icon>
          <p>我是 阿蛤，您的通用办公助手 - 3秒明白，2秒解决</p>
          <div class="agentic-hint">
            <p>您可以用自然语言完成各种办公操作：</p>
            <ul>
              <li>"在文档中插入一个表格"</li>
              <li>"设置当前段落为标题样式"</li>
              <li>"在选区位置插入图片"</li>
              <li>"调整文档页边距"</li>
              <li>"为文档添加页眉页脚"</li>
              <li>"批量替换文档中的文字"</li>
            </ul>
          </div>
        </div>
      </div>
    </div>

    <!-- 输入区域 -->
    <div class="input-area">
      <!-- 全局加载条 -->
      <div v-if="chatStore.isSending" class="global-loading-bar">
        <div class="loading-progress"></div>
      </div>

      <!-- 统一状态指示器 -->
      <div class="input-header">
        <div class="input-hint-container">
          <UnifiedStatusIndicator
            :is-thinking="chatStore.isThinking"
            :phase="chatStore.streamPhase"
            :elapsed-ms="chatStore.streamElapsedMs"
          />
          <span class="input-hint">阿蛤 - 3秒明白，2秒解决</span>
          <span v-if="currentDocStatus" class="doc-status" :class="`status-${currentDocStatus.status}`">
            {{ currentDocStatus.status }}
          </span>
          <el-button
            v-if="currentDocStatus && currentDocStatus.status === '等待写回'"
            type="text"
            size="small"
            class="cancel-writeback-btn"
            @click="cancelWritebackQueue"
          >
            取消写回
          </el-button>
        </div>
        <div
          v-if="
            (chatStore.selectedSkillsHint || '').trim().length > 0 ||
            (chatStore.selectedSkills || []).length > 0 ||
            (chatStore.appliedSkillsHint || '').trim().length > 0 ||
            (chatStore.appliedSkills || []).length > 0
          "
          class="skills-hint-row"
        >
          <div class="skills-hint">
            <span class="skills-label">技能</span>

            <el-tooltip
              :content="chatStore.selectedSkillsHint || '本轮注入的技能（后端路由选择）'"
              placement="top"
              trigger="hover"
            >
              <div class="skills-group">
                <span class="skills-sub-label">选</span>
                <span v-if="(chatStore.selectedSkills || []).length === 0" class="skills-empty">
                  {{ chatStore.selectedSkillsHint || '未命中' }}
                </span>
                <el-tag
                  v-for="s in (chatStore.selectedSkills || []).slice(0, 2)"
                  :key="s.id"
                  size="small"
                  effect="plain"
                  type="info"
                  class="skill-tag"
                >
                  {{ s.name }}
                </el-tag>
                <el-tag
                  v-if="(chatStore.selectedSkills || []).length > 2"
                  size="small"
                  effect="plain"
                  type="info"
                  class="skill-tag more-tag"
                >
                  +{{ (chatStore.selectedSkills || []).length - 2 }}
                </el-tag>
              </div>
            </el-tooltip>

            <span
              v-if="(chatStore.selectedSkillsMetrics?.lazyActivationCalls || 0) > 0"
              class="skills-metrics"
              :title="`懒激活: 调用 ${chatStore.selectedSkillsMetrics.lazyActivationCalls} 次，缓存命中 ${chatStore.selectedSkillsMetrics.lazyActivationCacheHits} 次，耗时 ${chatStore.selectedSkillsMetrics.lazyActivationMs.toFixed(1)} ms`"
            >
              ⚡{{ chatStore.selectedSkillsMetrics.lazyActivationCalls }}
              / 缓存{{ chatStore.selectedSkillsMetrics.lazyActivationCacheHits }}
              / {{ chatStore.selectedSkillsMetrics.lazyActivationMs.toFixed(1) }}ms
            </span>

            <span class="skills-sep">|</span>

            <el-tooltip
              :content="chatStore.appliedSkillsHint || '输出中检测到的技能（后验）'"
              placement="top"
              trigger="hover"
            >
              <div class="skills-group">
                <span class="skills-sub-label">用</span>
                <span v-if="(chatStore.appliedSkills || []).length === 0" class="skills-empty">
                  {{ chatStore.appliedSkillsHint || '未命中' }}
                </span>
                <el-tag
                  v-for="s in (chatStore.appliedSkills || []).slice(0, 2)"
                  :key="s.id"
                  size="small"
                  effect="plain"
                  type="success"
                  class="skill-tag"
                >
                  {{ s.name }}
                </el-tag>
                <el-tag
                  v-if="(chatStore.appliedSkills || []).length > 2"
                  size="small"
                  effect="plain"
                  type="success"
                  class="skill-tag more-tag"
                >
                  +{{ (chatStore.appliedSkills || []).length - 2 }}
                </el-tag>
              </div>
            </el-tooltip>
          </div>
        </div>
      </div>

      <div class="input-wrapper">
        <el-input
          ref="textareaRef"
          v-model="inputText"
          type="textarea"
          :rows="3"
          placeholder="输入您的需求，阿蛤帮您3秒明白...（例如：@D:\资料\合同.docx 检查合同）"
          :disabled="chatStore.isSending"
          @keydown="handleKeydown"
          @compositionend="handleInput"
          @input="handleInput"
          resize="none"
          maxlength="500"
          show-word-limit
          class="custom-textarea"
        />

        <!-- 操作按钮 -->
        <div class="input-actions">
          <!-- 发送 / 取消 -->
          <el-button
            v-if="chatStore.isSending"
            type="danger"
            size="small"
            class="send-button"
            @click="cancelMessage"
          >
            <el-icon><CircleClose /></el-icon>
            <span>取消</span>
          </el-button>
          <el-button
            v-else-if="hasPendingWriteback"
            type="warning"
            size="small"
            class="send-button"
            @click="cancelPendingWriteback"
          >
            <el-icon><CircleClose /></el-icon>
            <span>取消写回</span>
          </el-button>
          <el-button
            v-else-if="inputText.length > 0"
            type="primary"
            size="small"
            class="send-button"
            @click="sendMessage"
          >
            <el-icon><Promotion /></el-icon>
            <span>发送</span>
          </el-button>

          <!-- 清空按钮 -->
          <el-button
            v-if="inputText.length > 0"
            type="text"
            size="small"
            class="action-button"
            :disabled="chatStore.isSending"
            @click="clearInput"
          >
            <el-icon><Delete /></el-icon>
          </el-button>
        </div>

        <!-- @符号智能提示 -->
        <div v-if="showAtHelper" class="at-helper-popup">
          <div class="at-helper-header">
            <el-icon><Link /></el-icon>
            <span>@ 符号使用说明</span>
            <div class="keyboard-hint">
              <span class="hint-text">↑↓ 选择</span>
              <span class="hint-text">Enter 确认</span>
              <span class="hint-text">Esc 关闭</span>
            </div>
            <el-button
              type="text"
              size="small"
              @click="hideAtHelper"
              class="close-button"
            >
              <el-icon><Close /></el-icon>
            </el-button>
          </div>
          <div class="at-helper-content">
            <!-- 已打开文档列表 -->
            <div v-if="openDocuments.length > 0" class="open-documents-section">
              <div class="section-title">
                <el-icon><Document /></el-icon>
                <span>已打开的文档 ({{ openDocuments.length }})</span>
              </div>

              <!-- 搜索框 -->
              <el-input
                v-model="searchKeyword"
                placeholder="搜索文档..."
                size="small"
                class="doc-search-input"
              >
                <template #prefix>
                  <el-icon><Search /></el-icon>
                </template>
              </el-input>

              <!-- 文档列表 -->
              <div class="documents-list">
                <div
                  v-for="(doc, index) in filteredDocuments"
                  :key="doc.id"
                  class="document-item"
                  :class="{ 'is-selected': index === selectedIndex }"
                  @click="insertDocument(doc)"
                  @mouseenter="selectedIndex = index"
                  :ref="el => setDocumentItemRef(el, index)"
                >
                  <div class="doc-info">
                    <div class="doc-row">
                      <div class="doc-name">
                        <el-icon v-if="doc.isActive" class="active-doc-icon"><StarFilled /></el-icon>
                        <span>{{ doc.name }}</span>
                      </div>
                      <div class="doc-path" v-if="doc.fullPath">
                        <span>{{ doc.fullPath }}</span>
                      </div>
                    </div>
                    <div class="doc-status-row" v-if="getDocStatus(doc).status">
                      <span class="doc-status" :class="`status-${getDocStatus(doc).status}`">
                        {{ getDocStatus(doc).status }}
                      </span>
                    </div>
                  </div>
                  <el-icon class="insert-icon"><Plus /></el-icon>
                </div>
              </div>
            </div>
            <div v-else class="open-documents-empty">
              <div class="empty-row">
                <el-icon class="empty-icon"><WarningFilled /></el-icon>
                <span>未检测到已打开的文档</span>
              </div>
              <div class="empty-actions">
                <el-button size="small" @click="loadOpenDocuments">刷新</el-button>
              </div>
            </div>

	          </div>
	        </div>
	      </div>
	    </div>
	  </div>

	  <RememberMemoryDialog
	    v-model="rememberVisible"
	    :patches="rememberPatches"
	    :default-selected="rememberDefaultSelected"
	    :auto-confirm-seconds="5"
	    @confirm="handleRememberConfirm"
	    @cancel="handleRememberCancel"
	  />
	</template>

	<script setup lang="ts">
	import { ref, nextTick, watch, onMounted, onUnmounted, computed } from 'vue'
	import { storeToRefs } from 'pinia'
	import { ElMessage } from 'element-plus'
import { ChatDotRound, Link, WarningFilled, Close, Document, Search, StarFilled, Plus, Delete, Promotion, CircleClose } from '@element-plus/icons-vue'
import { useChatStore } from '@/stores/chat'
import { useDocumentStore } from '@/stores/document'
import { WPSHelper, wpsBridge } from '@/services/wps-bridge'
import { logger } from '@/utils/logger'
	import RememberMemoryDialog from './RememberMemoryDialog.vue'
	import { memoryApi, type MemoryPatch } from '@/services/memory-api'
	import MessageItem from './MessageItem.vue'
	import ThinkingIndicator from './ThinkingIndicator.vue'
	import UnifiedStatusIndicator from './UnifiedStatusIndicator.vue'

// 定义事件
const emit = defineEmits<{
  (e: 'tool-result', result: {
    type: 'images' | 'analysis' | 'document' | 'write' | 'clear'
    data?: any
    message?: string
  }): void
}>()

	const chatStore = useChatStore()
	const documentStore = useDocumentStore()
	const { currentSessionId } = storeToRefs(chatStore)

// 核心响应式数据
const inputText = ref('')
const messagesContainer = ref<HTMLElement>()
const textareaRef = ref<HTMLElement>()  // 优化DOM查询
const isRecovering = ref(false)  // 是否正在恢复状态
	const showAtHelper = ref(false) // 是否显示@符号帮助
	const openDocuments = ref<any[]>([]) // 已打开的文档列表
	const searchKeyword = ref('') // 文档搜索关键词
	const selectedIndex = ref(0) // 当前选中的文档索引
	const documentItems = ref<HTMLElement[]>([]) // 文档项DOM元素引用

	// Remember memory dialog state
	const rememberVisible = ref(false)
	const rememberPatches = ref<MemoryPatch[]>([])
	const rememberDefaultSelected = ref<string[]>([])
	const rememberBusy = ref(false)

// When the active document changes, switch chat history bucket automatically.
const activeDocumentKey = computed(() => {
  const d = documentStore.documents.find(doc => doc.isActive)
  try {
    if (!d) return ''
    const host = String((d as any)?.hostApp || wpsBridge.getHostApp() || 'unknown').trim() || 'unknown'
    const id = String((d as any)?.id || '').trim()
    const path = String((d as any)?.path || (d as any)?.fullName || '').trim()
    const name = String((d as any)?.name || '').trim()
    if (id) return `${host}:${id}`
    if (path) return `${host}:${path}`
    if (name) return `${host}:name:${name}`
    return ''
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/ChatPanel.vue', e)
    return ''
  }
})
watch(
  activeDocumentKey,
  () => {
    Promise.resolve(chatStore.syncSessionToActiveDocument?.()).catch((e) => { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/ChatPanel.vue', e) })
  },
  { immediate: true }
)

const AT_SYMBOLS = ['@', '＠', '﹫'] as const
const findLastAtIndex = (value: string): number => {
  return Math.max(value.lastIndexOf(AT_SYMBOLS[0]), value.lastIndexOf(AT_SYMBOLS[1]), value.lastIndexOf(AT_SYMBOLS[2]))
}

const isAtTriggerKey = (e: KeyboardEvent): boolean => {
  const key = e.key
  if (key && (AT_SYMBOLS as readonly string[]).includes(key)) {
    return true
  }

  const code = (e as any).code as string | undefined
  const keyCode = (e as any).keyCode as number | undefined
  const which = (e as any).which as number | undefined
  const numericCode = typeof keyCode === 'number' ? keyCode : which

  return Boolean(
    e.shiftKey &&
      (key === '2' || code === 'Digit2' || numericCode === 50)
  )
}

// 防抖定时器
let inputDebounceTimer: NodeJS.Timeout | null = null
let documentLoadTimer: NodeJS.Timeout | null = null
let searchDebounceTimer: NodeJS.Timeout | null = null

// Per-document status (idle/generating/writeback...) derived from chat store.
const buildDocKey = (doc: any): string => {
  try {
    const host = String(doc?.hostApp || wpsBridge.getHostApp() || 'unknown').trim() || 'unknown'
    const id = String(doc?.id || '').trim()
    const path = String(doc?.path || doc?.fullPath || '').trim()
    const name = String(doc?.name || '').trim()
    if (id) return `${host}:${id}`
    if (path) return `${host}:${path}`
    if (name) return `${host}:name:${name}`
    return ''
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/ChatPanel.vue', e)
    return ''
  }
}

const currentDocStatus = computed(() => {
  try {
    const key = String(chatStore.currentDocKey || '').trim()
    if (key) return chatStore.getSessionStatusByDocKey(key)
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/ChatPanel.vue', e)
  }
  return chatStore.getSessionStatusBySessionId(currentSessionId.value)
})

const getDocStatus = (doc: any) => {
  const key = buildDocKey(doc)
  return chatStore.getSessionStatusByDocKey(key)
}

const hasPendingWriteback = computed(() => {
  const status = currentDocStatus.value?.status || ''
  return status === '等待写回'
})

const cancelPendingWriteback = () => {
  try {
    chatStore.cancelPendingMacroJobs({ sessionId: currentSessionId.value || undefined })
  } catch (e) {
    logger.warn('[chat] cancel pending writeback failed', e)
  }
}

let suppressAtHelperOnce = false

let nativeTextarea: HTMLTextAreaElement | null = null
let nativeKeydownHandler: ((e: KeyboardEvent) => void) | null = null
let nativeInputHandler: ((e: Event) => void) | null = null
let nativeCompositionEndHandler: ((e: Event) => void) | null = null

// 键盘导航状态
const keyboardNavigation = {
  isActive: computed(() => showAtHelper.value && filteredDocuments.value.length > 0),
  currentIndex: ref(0)
}

const recoverFromError = () => {
  isRecovering.value = true
  console.log('尝试从错误中恢复...')

  // 重置发送状态
  if (chatStore.isSending) {
    chatStore.isSending = false
    console.log('已重置发送状态')
  }

  // 重置思考状态
  if (chatStore.isThinking) {
    chatStore.isThinking = false
    console.log('已重置思考状态')
  }

  // 延迟重置恢复标志
  setTimeout(() => {
    isRecovering.value = false
    console.log('恢复完成')
  }, 1000)
}

const cancelWritebackQueue = () => {
  try {
    const key = String((chatStore as any)?.currentDocKey || '').trim()
    if (!key) return
    const res = (chatStore as any).cancelPendingMacroJobs?.({ docKey: key })
    const jobs = Number(res?.cancelledJobs || 0) || 0
    if (jobs <= 0) ElMessage.info('当前没有待写回任务')
    else ElMessage.success(`已取消 ${jobs} 个待写回任务`)
  } catch (e: any) {
    ElMessage.error(`取消写回失败：${String(e?.message || e)}`)
  }
}

// 生命周期钩子
onMounted(() => {
  if (typeof window !== 'undefined') {
    // 注册点击外部关闭帮助
    document.addEventListener('click', handleClickOutside)
  }

  // Auto-switch chat history bucket based on the active document (no extra user action).
  Promise.resolve(chatStore.syncSessionToActiveDocument?.()).catch((e) => { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/ChatPanel.vue', e) })

  // Fallback: in some embedded runtimes (e.g., WPS taskpane), component-level key/input
  // events can be flaky. Attach to the underlying textarea directly.
  nextTick(() => {
    const textareaHost = (textareaRef.value as any)?.$el || textareaRef.value
    const textarea = textareaHost?.querySelector?.('textarea') as HTMLTextAreaElement | undefined
    if (!textarea) {
      return
    }

    nativeTextarea = textarea

    nativeKeydownHandler = (e: KeyboardEvent) => {
      if (isAtTriggerKey(e)) {
        handleKeydown(e)
        return
      }

      if (keyboardNavigation.isActive.value) {
        const navKeys = ['ArrowUp', 'ArrowDown', 'Enter', 'Escape', 'Tab']
        if (navKeys.includes(e.key)) {
          handleKeydown(e)
        }
      }
    }

    nativeInputHandler = () => {
      scheduleAtHelperUpdate(textarea.value)
    }

    nativeCompositionEndHandler = () => {
      scheduleAtHelperUpdate(textarea.value)
    }

    textarea.addEventListener('keydown', nativeKeydownHandler)
    textarea.addEventListener('input', nativeInputHandler)
    textarea.addEventListener('compositionend', nativeCompositionEndHandler)
  })
})

onUnmounted(() => {
  // 清理所有防抖定时器
  if (inputDebounceTimer) {
    clearTimeout(inputDebounceTimer)
    inputDebounceTimer = null
  }
  if (documentLoadTimer) {
    clearTimeout(documentLoadTimer)
    documentLoadTimer = null
  }
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
    searchDebounceTimer = null
  }

  // 移除全局错误处理
  if (typeof window !== 'undefined') {
    // 移除点击外部关闭帮助
    document.removeEventListener('click', handleClickOutside)
  }

  // 清理DOM引用
  cleanupDocumentRefs()

  if (nativeTextarea) {
    if (nativeKeydownHandler) {
      nativeTextarea.removeEventListener('keydown', nativeKeydownHandler)
    }
    if (nativeInputHandler) {
      nativeTextarea.removeEventListener('input', nativeInputHandler)
    }
    if (nativeCompositionEndHandler) {
      nativeTextarea.removeEventListener('compositionend', nativeCompositionEndHandler)
    }
  }
  nativeTextarea = null
  nativeKeydownHandler = null
  nativeInputHandler = null
  nativeCompositionEndHandler = null

  console.log('[ChatPanel] ✅ 事件清理完成')
})

// 获取已打开的文档列表
const loadOpenDocuments = async () => {
  try {
    // Prefer backend-aggregated list (cross-host union scoped by client_id).
    try {
      const sync = await import('../../services/document-sync')
      // Best-effort: refresh backend snapshot for this host, so newly opened docs appear immediately.
      await sync.syncOpenDocumentsNow()
      const docs = await sync.getSyncedDocuments()
      openDocuments.value = docs as any
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/ChatPanel.vue', e)
      // Fallback to local host-only list.
      const docs = wpsBridge.getAllOpenDocuments()
      openDocuments.value = docs
    }
    console.log(`[ChatPanel] 已加载文档: ${(openDocuments.value || []).length} 个`)

    // 当弹出框显示时，自动聚焦到第一个文件
    nextTick(() => {
      if (showAtHelper.value && filteredDocuments.value.length > 0) {
        selectedIndex.value = 0
        scrollToSelectedItem()
      }
    })
  } catch (error) {
    console.warn('获取文档列表失败:', error)
    // 向用户显示错误
    ElMessage.error('加载文档列表失败，请检查WPS环境')
  }
}

// 插入文档到输入框
const insertDocument = (doc: any) => {
  const docPath = doc.path || doc.fullPath || doc.name

  // 检查是否已经包含该文档的引用
  const isAlreadyReferenced = inputText.value.includes(docPath)

  if (isAlreadyReferenced) {
    ElMessage.warning('该文档已被引用')
    hideAtHelper()
    return
  }

  // 检查是否已经包含@符号（兼容全角＠）
  const hasAtSymbol = findLastAtIndex(inputText.value) !== -1

  let docText = ''
  if (hasAtSymbol) {
    // 如果已有@符号，只添加文档路径和空格
    docText = `${docPath} `
  } else {
    // 如果没有@符号，添加完整的@文档路径
    docText = `@${docPath} `
  }

  inputText.value += docText
  suppressAtHelperOnce = true
  hideAtHelper()

  // 聚焦到输入框（使用ref优化DOM查询）
  nextTick(() => {
    const textareaHost = (textareaRef.value as any)?.$el || textareaRef.value
    const textarea = textareaHost?.querySelector?.('textarea') as HTMLTextAreaElement | undefined
    if (textarea) {
      textarea.focus()
    }
  })
}

// 过滤文档列表
const filteredDocuments = computed(() => {
  if (!searchKeyword.value) {
    return openDocuments.value
  }
  return openDocuments.value.filter((doc: any) =>
    doc.name.toLowerCase().includes(searchKeyword.value.toLowerCase()) ||
    ((doc.path || doc.fullPath) && String(doc.path || doc.fullPath).toLowerCase().includes(searchKeyword.value.toLowerCase()))
  )
})

// 监听搜索关键词变化，重置选中状态（带防抖）
watch(searchKeyword, (newValue) => {
  // 清除之前的防抖定时器
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
  }

  // 使用防抖，避免频繁更新
  searchDebounceTimer = setTimeout(() => {
    selectedIndex.value = 0
  }, 200) // 200ms防抖
})

// 输入处理函数 - 检测@符号并显示帮助（带防抖）
const handleInput = (rawValue: string | Event) => {
  const value =
    typeof rawValue === 'string'
      ? rawValue
      : ((rawValue as any)?.target?.value as string | undefined) ?? inputText.value

  scheduleAtHelperUpdate(value)
}

const scheduleAtHelperUpdate = (value: string) => {
  if (suppressAtHelperOnce) {
    suppressAtHelperOnce = false
    return
  }

  // 清除之前的防抖定时器
  if (inputDebounceTimer) {
    clearTimeout(inputDebounceTimer)
  }

  // 使用防抖，避免频繁触发
  inputDebounceTimer = setTimeout(() => {
    const wasVisible = showAtHelper.value

    // 智能检测@符号 - 只有在合适的情况下才显示帮助
    const shouldShowHelper = shouldShowAtHelper(value)
    showAtHelper.value = shouldShowHelper

    // 如果关闭弹窗，清理状态
    if (wasVisible && !shouldShowHelper) {
      hideAtHelper()
      return
    }

    // 如果显示帮助（首次打开），加载已打开的文档列表
    if (shouldShowHelper && !wasVisible) {
      loadOpenDocuments()
    }

    // 每次输入时重置选中索引
    selectedIndex.value = 0
  }, 150) // 150ms防抖
}

// 兜底：某些环境下 el-input 的 @input 事件可能不稳定，这里用 v-model 的变化做二次触发
watch(inputText, (value) => {
  scheduleAtHelperUpdate(value)
})

// 智能判断是否应该显示@符号帮助
const shouldShowAtHelper = (value: string): boolean => {
  // 如果不包含@符号（兼容全角＠），不显示
  if (findLastAtIndex(value) === -1) {
    return false
  }

  // 查找最后一个@符号的位置
  const lastAtIndex = findLastAtIndex(value)

  // 获取@符号后面的内容
  const afterAt = value.substring(lastAtIndex + 1)
  const afterAtTrimStart = afterAt.replace(/^\s+/, '')

  // 如果@后面没有任何内容，显示帮助（用户刚输入@）
  if (afterAt.length === 0) {
    return true
  }

  // 如果@后面只有空格，显示帮助
  if (afterAtTrimStart.length === 0) {
    return true
  }

  // 如果@后面跟了标点符号，不显示帮助（已完成选择）
  const punctuationPattern = /^[,，.。!！?？;；:：""''（）()\[\]{}【】]/
  if (punctuationPattern.test(afterAtTrimStart)) {
    return false
  }

  // 如果@后面有内容且不是标点，检查是否看起来像是一个完整的引用
  // 如果内容很长或者包含了明显的需求描述，不显示帮助
  if (afterAtTrimStart.length > 50) {
    return false
  }

  // 其他情况下显示帮助
  return true
}

// 点击外部关闭帮助
const handleClickOutside = (event: MouseEvent) => {
  const target = event.target
  if (!(target instanceof HTMLElement)) {
    return
  }
  if (!target.closest('.at-helper-popup') && !target.closest('.custom-textarea')) {
    hideAtHelper()
  }
}

// 设置文档项DOM引用
const setDocumentItemRef = (el: HTMLElement | null, index: number) => {
  if (el) {
    documentItems.value[index] = el
  } else {
    documentItems.value[index] = undefined as any
  }
}

// 向上导航
const navigateUp = () => {
  if (selectedIndex.value > 0) {
    selectedIndex.value--
  } else {
    selectedIndex.value = filteredDocuments.value.length - 1
  }
  scrollToSelectedItem()
}

// 向下导航
const navigateDown = () => {
  if (selectedIndex.value < filteredDocuments.value.length - 1) {
    selectedIndex.value++
  } else {
    selectedIndex.value = 0
  }
  scrollToSelectedItem()
}

// 滚动到选中的项目
const scrollToSelectedItem = () => {
  nextTick(() => {
    const selectedEl = documentItems.value[selectedIndex.value]
    if (selectedEl) {
      selectedEl.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth'
      })
    }
  })
}

// 清理DOM引用
const cleanupDocumentRefs = () => {
  documentItems.value = []
}

// 选择当前文档
const selectCurrentDocument = () => {
  if (filteredDocuments.value[selectedIndex.value]) {
    insertDocument(filteredDocuments.value[selectedIndex.value])
  }
}

// 隐藏@符号帮助
const hideAtHelper = () => {
  showAtHelper.value = false
  selectedIndex.value = 0
  searchKeyword.value = ''
}

// 发送消息
const sendMessage = async () => {
  if (!inputText.value.trim()) return

  const message = inputText.value
  inputText.value = ''

  // 检查是否正在恢复中
  if (isRecovering.value) {
    ElMessage.warning('系统正在恢复中，请稍后再试')
    return
  }

  try {
    // 先处理简单的文档操作指令（前端可直接处理）
    if (await handleDocumentCommand(message)) {
      return
    }

    // 其他操作由后端 Agent 决策
    // sendMessage 会自动检测当前文档并生成 sessionId
    await chatStore.sendMessage(message)
  } catch (error) {
    ElMessage.error('发送消息失败，请重试')
    console.error('Send message error:', error)
    // 发生错误时尝试恢复状态
    recoverFromError()
  }
}

const cancelMessage = () => {
  try {
    ;(chatStore as any).cancelCurrentRequest?.()
  } catch (e) {
    console.warn('[ChatPanel] cancelCurrentRequest failed:', e)
  }
}

// 处理简单的文档操作指令（符合 Agentic 模式）
// 根据 docs/AH32_RULES.md 规则，只有用户意图非常明确的简单操作才由前端直接处理
// 其他复杂操作（如写入、搜索、分析）都由后端 Agent 自主判断
const handleDocumentCommand = async (message: string): Promise<boolean> => {
  const lowerMsg = message.toLowerCase()

  // Dev helper: execute a Plan JSON directly (no LLM / no macro queue).
  //
  // Usage:
  // - `/plan { ... }`
  // - `/plan ```json\\n{ ... }\\n``` ` (fences are tolerated best-effort)
  if (lowerMsg.trim().startsWith('/plan')) {
    try {
      const trimmed = String(message || '').trim()
      const jsonRaw = trimmed.replace(/^\/plan\b/i, '').trim()
      if (!jsonRaw) {
        ElMessage.info('用法：/plan <ah32.plan.v1 的 JSON>（不会发送到后端，会直接执行写回）')
        inputText.value = message
        return true
      }

      const stripFences = (s: string): string => {
        let t = String(s || '').trim()
        if (!t) return t
        if (t.startsWith('```')) {
          t = t.replace(/^```[a-z0-9_.-]*\s*/i, '').replace(/```$/i, '').trim()
        }
        const nl = t.indexOf('\n')
        if (nl > 0 && nl <= 20) {
          const first = t.slice(0, nl).trim().toLowerCase()
          const rest = t.slice(nl + 1).trim()
          if ((first === 'json' || first === 'plan' || first.startsWith('ah32')) && rest.startsWith('{')) {
            t = rest
          }
        }
        return t
      }

      let plan: any = null
      try {
        plan = JSON.parse(stripFences(jsonRaw))
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/ChatPanel.vue', e)
        try {
          ;(globalThis as any).__ah32_logToBackend?.(
            `[UI] /plan JSON.parse failed: ${String((e as any)?.message || e)}`,
            'warning'
          )
        } catch (e2) {
          ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/ChatPanel.vue', e2)
        }
        ElMessage.error('Plan JSON 解析失败：请确认粘贴的是完整 JSON（以 { 开头，以 } 结尾）')
        inputText.value = message
        return true
      }

      const schemaVersion = String(plan?.schema_version || plan?.schemaVersion || plan?.schema || '').trim()
      if (schemaVersion !== 'ah32.plan.v1') {
        ElMessage.error('不是可执行的 Plan JSON：schema_version 必须是 \"ah32.plan.v1\"')
        inputText.value = message
        return true
      }

      try {
        chatStore.addSystemMessage('[Plan] 开始执行（/plan 直执行，不会走模型/修复环）')
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/ChatPanel.vue', e)
      }
      const res = await WPSHelper.executePlan(plan)
      const ok = !!res?.success
      const msg = String(res?.message || (ok ? 'ok' : 'failed'))
      try {
        if (ok) chatStore.addSystemMessage(`[Plan] 执行成功：${msg}`)
        else chatStore.addSystemMessage(`[Plan] 执行失败：${msg}`)
      } catch (e) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/ChatPanel.vue', e)
      }
      if (ok) ElMessage.success('Plan 执行成功')
      else ElMessage.error(`Plan 执行失败：${msg}`)
      return true
    } catch (e: any) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/ChatPanel.vue', e)
      try {
        ;(globalThis as any).__ah32_logToBackend?.(`[UI] /plan fatal: ${String(e?.message || e)}`, 'error')
      } catch (e2) {
        ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/chat/ChatPanel.vue', e2)
      }
      ElMessage.error(`Plan 执行异常：${String(e?.message || e || 'unknown_error')}`)
      inputText.value = message
      return true
    }
  }

  // 简单操作模式匹配（只有完全匹配特定模式才由前端处理）
  // 这些是用户意图非常明确的简单操作

  // 模式1: 用户非常明确地想“切换到某个已打开文档”（历史兼容：含“设为目标/设置目标”字样）
  if (lowerMsg.includes('设为目标') || lowerMsg.includes('设置目标')) {
    const docName = message.replace(/设为目标文档|设置目标文档/g, '').trim()
    const doc = documentStore.documents.find(d =>
      d.name.includes(docName) || d.id.includes(docName)
    )
    if (doc) {
      documentStore.activateDocument(doc.id)
      emit('tool-result', {
        type: 'document',
        message: `已切换到文档: ${doc.name}`
      })
      return true
    }
  }

  // 注意：其他所有操作都由后端 Agent 自主判断处理
  // 例如：
  //   - "把第3章添加到当前文档" → Agent 决定是否读取文档、生成 JS 宏
  //   - "分析这个文档" → Agent 决定调用哪些分析工具
  //   - "有什么风险" → Agent 决定调用风险评估工具
  // 前端不预设任何工具链或操作步骤

  return false
}

// 优化的键盘事件处理
const handleKeydown = (e: KeyboardEvent) => {
  // 输入 @ 时，立即尝试打开弹窗（兼容全角＠），避免某些环境下 input 事件不触发/延迟
  if (isAtTriggerKey(e)) {
    showAtHelper.value = true
    selectedIndex.value = 0
    loadOpenDocuments()
    return
  }

  // @符号弹出框的键盘导航
  if (keyboardNavigation.isActive.value) {
    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault()
        navigateUp()
        return
      case 'ArrowDown':
        e.preventDefault()
        navigateDown()
        return
      case 'Enter':
        e.preventDefault()
        selectCurrentDocument()
        return
      case 'Escape':
        e.preventDefault()
        hideAtHelper()
        return
      case 'Tab':
        e.preventDefault()
        selectCurrentDocument()
        return
    }
  }

  // 普通键盘事件
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault()
    sendMessage()
  }
}

// 清空输入框
const clearInput = () => {
  inputText.value = ''  // 清空输入框内容
  emit('tool-result', { type: 'clear' })
}

// 处理消息操作（由后端 Agent 处理，前端仅转发事件）
	const handleMessageAction = async (action: { type: string; messageId: string; data?: any }) => {
  // Agentic 模式：所有复杂操作由后端 Agent 决策执行
  // 前端负责执行简单的文档操作
  
	  switch (action.type) {
	    case 'remember-memory': {
	      if (rememberBusy.value) return
	      const text = String(action.data?.text || '').trim()
	      if (!text) {
	        ElMessage.warning('没有可保存的内容')
	        return
	      }

	      rememberBusy.value = true
	      rememberPatches.value = []
	      rememberDefaultSelected.value = []
	      rememberVisible.value = true

	      try {
	        const sid = currentSessionId.value ? String(currentSessionId.value) : null
	        const resp = await memoryApi.suggest({
	          sessionId: sid,
	          message: text,
	          messageRole: String(action.data?.role || 'assistant'),
	          messageId: action.messageId
	        })
	        rememberPatches.value = resp.patches || []
	        rememberDefaultSelected.value = resp.recommended_patch_ids || []
	        if (!rememberPatches.value.length) {
	          ElMessage.info('没有可保存的记忆项')
	        }
	      } catch (e) {
	        console.error('[remember] suggest failed:', e)
	        ElMessage.error('生成记忆项失败: ' + (e instanceof Error ? e.message : '未知错误'))
	        rememberVisible.value = false
	      } finally {
	        rememberBusy.value = false
	      }
	      break
	    }
	      
	    default:
	      ElMessage.info('操作已提交，由 Agent 处理')
	  }
	}

	const handleRememberCancel = () => {
	  rememberPatches.value = []
	  rememberDefaultSelected.value = []
	}

	const handleRememberConfirm = async (selectedPatchIds: string[]) => {
	  if (rememberBusy.value) return
	  const ids = Array.isArray(selectedPatchIds) ? selectedPatchIds : []
	  const selected = rememberPatches.value.filter(p => ids.includes(p.patch_id))
	  if (!selected.length) {
	    ElMessage.warning('未选择任何记忆项')
	    rememberVisible.value = false
	    return
	  }

	  rememberBusy.value = true
	  try {
	    const sid = currentSessionId.value ? String(currentSessionId.value) : null
	    const resp = await memoryApi.commit({ sessionId: sid, patches: selected })
	    if (resp.success) {
	      ElMessage.success('已保存为记忆')
	    } else {
	      ElMessage.warning('部分记忆保存失败')
	    }
	    if (resp.errors && resp.errors.length) {
	      console.warn('[remember] commit errors:', resp.errors)
	    }
	  } catch (e) {
	    console.error('[remember] commit failed:', e)
	    ElMessage.error('保存失败: ' + (e instanceof Error ? e.message : '未知错误'))
	  } finally {
	    rememberBusy.value = false
	    rememberVisible.value = false
	  }
	}

// 优化的自动滚动逻辑：只在用户发送新消息或AI开始响应时滚动
let lastMessageCount = 0

watch(
  () => chatStore.messages.length,
  async (newCount, oldCount) => {
    await nextTick()
    
    // 只有在添加新消息时才滚动（不包括更新现有消息）
    if (newCount > oldCount) {
      // 检查是否是新用户消息或AI开始响应
      const latestMessage = chatStore.messages[chatStore.messages.length - 1]
      
      if (latestMessage && (latestMessage.type === 'user' || 
          (latestMessage.type === 'assistant' && !latestMessage.content))) {
        // 用户发送消息或AI开始响应，滚动到底部
        if (messagesContainer.value) {
          messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
        }
      }
    }
    
    lastMessageCount = newCount
  }
)

// 流式内容更新时只滚动一次
watch(
  () => chatStore.isThinking,
  async (isThinking) => {
    if (!isThinking && lastMessageCount > 0) {
      // AI思考结束，滚动一次到底部
      await nextTick()
      if (messagesContainer.value) {
        messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
      }
    }
  }
)
</script>

<style scoped lang="scss">
.chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #fff;
}

.messages-container {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
  min-height: 0;
  /* 添加柔和的滚动条 */
  scrollbar-width: thin;
  scrollbar-color: rgba(102, 126, 234, 0.3) transparent;

  /* Webkit浏览器的滚动条样式 */
  &::-webkit-scrollbar {
    width: 6px;
  }

  &::-webkit-scrollbar-track {
    background: transparent;
  }

  &::-webkit-scrollbar-thumb {
    background: linear-gradient(180deg, rgba(102, 126, 234, 0.3) 0%, rgba(118, 75, 162, 0.3) 100%);
    border-radius: 3px;
    transition: all 0.3s ease;
  }

  &::-webkit-scrollbar-thumb:hover {
    background: linear-gradient(180deg, rgba(102, 126, 234, 0.5) 0%, rgba(118, 75, 162, 0.5) 100%);
  }
}

.messages-wrapper {
  max-width: 100%;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 400px;
  color: #909399;
  padding: 40px 20px;

  .el-icon {
    color: #667eea;
    /* 添加微妙的脉动效果 */
    animation: gentlePulse 3s ease-in-out infinite;
  }

  p {
    margin: 16px 0 0 0;
    font-size: 16px;
    color: #4a5568;
    font-weight: 500;
    text-align: center;
  }

  .agentic-hint {
    margin-top: 20px;
    padding: 16px 20px;
    background: linear-gradient(135deg, rgba(102, 126, 234, 0.05) 0%, rgba(118, 75, 162, 0.05) 100%);
    border-radius: 12px;
    border: 1px solid rgba(102, 126, 234, 0.1);
    backdrop-filter: blur(10px);
    max-width: 500px;

    p {
      margin-bottom: 12px;
      font-size: 13px;
      color: #667eea;
      font-weight: 500;
      text-align: left;
    }

    ul {
      margin: 0;
      padding-left: 18px;
      color: #4a5568;

      li {
        margin-bottom: 8px;
        font-size: 14px;
        line-height: 1.5;
        position: relative;

        &::before {
          content: '';
          position: absolute;
          left: -18px;
          top: 8px;
          width: 6px;
          height: 6px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          border-radius: 50%;
          opacity: 0.7;
        }

        &:last-child {
          margin-bottom: 0;
        }
      }
    }
  }
}

@keyframes gentlePulse {
  0%, 100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.8;
    transform: scale(1.05);
  }
}

.input-area {
  padding: var(--spacing-xl);
  background: rgba(255, 255, 255, 0.8);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-top: 1px solid var(--border-lighter);
  position: relative;

  &::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 1px;
    background: linear-gradient(90deg, transparent 0%, rgba(102, 126, 234, 0.2) 50%, transparent 100%);
  }
}

// 全局加载条
.global-loading-bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: rgba(102, 126, 234, 0.1);
  border-radius: 0 0 var(--border-radius-base) var(--border-radius-base);
  overflow: hidden;
  z-index: 20;

  .loading-progress {
    height: 100%;
    background: var(--primary-gradient);
    border-radius: 0 0 var(--border-radius-base) var(--border-radius-base);
    animation: loadingProgress 1.5s ease-in-out infinite;
    box-shadow: 0 0 8px rgba(102, 126, 234, 0.4);
  }
}

@keyframes loadingProgress {
  0% {
    transform: translateX(-100%);
  }
  50% {
    transform: translateX(0%);
  }
  100% {
    transform: translateX(100%);
  }
}

.input-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--spacing-md);
  padding: 0 var(--spacing-sm);
  gap: var(--spacing-sm);

  .input-hint-container {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
  }

  .skills-hint-row {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .skills-hint {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 2px 6px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.55);
    border: 1px solid rgba(148, 163, 184, 0.25);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }

  .skills-label {
    font-size: 11px;
    color: var(--text-secondary);
    font-weight: 600;
    white-space: nowrap;
  }

  .skills-group {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }

  .skills-sub-label {
    font-size: 10px;
    color: var(--text-secondary);
    font-weight: 700;
    opacity: 0.9;
    white-space: nowrap;
  }

  .skills-sep {
    font-size: 11px;
    color: var(--text-secondary);
    opacity: 0.55;
    padding: 0 2px;
    user-select: none;
  }

  .skills-metrics {
    font-size: 11px;
    color: var(--text-secondary);
    opacity: 0.9;
    white-space: nowrap;
    user-select: none;
    margin: 0 2px;
  }

  .skills-empty {
    font-size: 11px;
    color: var(--text-secondary);
    opacity: 0.85;
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .skill-tag {
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .more-tag {
    opacity: 0.8;
  }

  .input-hint {
    font-size: 13px;
    background: var(--primary-gradient);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    font-weight: 600;
  }

  .char-count {
    font-size: 12px;
    color: var(--text-secondary);
    font-weight: 500;
  }
}

.input-wrapper {
  position: relative;
  display: flex;
  align-items: stretch;
  background: rgba(255, 255, 255, 0.6);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-radius: var(--border-radius-2xl);
  border: 2px solid rgba(102, 126, 234, 0.1);
  transition: var(--transition-normal);
  overflow: visible;

  &:focus-within {
    border-color: var(--primary-color);
    box-shadow: 0 0 0 4px rgba(102, 126, 234, 0.1);
    background: rgba(255, 255, 255, 0.9);
  }
}

.doc-status {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.15);
  color: var(--text-secondary);
  border: 1px solid rgba(148, 163, 184, 0.3);
  white-space: nowrap;
}

.status-生成中,
.status-写回中 {
  background: rgba(59, 130, 246, 0.12);
  color: #2563eb;
  border-color: rgba(59, 130, 246, 0.35);
}

.status-等待写回 {
  background: rgba(245, 158, 11, 0.12);
  color: #d97706;
  border-color: rgba(245, 158, 11, 0.35);
}

.status-写回成功 {
  background: rgba(34, 197, 94, 0.12);
  color: #16a34a;
  border-color: rgba(34, 197, 94, 0.35);
}

.status-写回失败 {
  background: rgba(239, 68, 68, 0.12);
  color: #dc2626;
  border-color: rgba(239, 68, 68, 0.35);
}

// 自定义文本域样式
:deep(.custom-textarea) {
  flex: 1;

  .el-textarea__inner {
    border-radius: var(--border-radius-2xl);
    border: none;
    padding: var(--spacing-lg) var(--spacing-xl);
    font-size: 14px;
    line-height: 1.7;
    transition: var(--transition-normal);
    background: transparent;
    resize: none;
    min-height: 80px;
    max-height: 140px;
    overflow-y: auto;
    font-weight: 400;

    &:focus {
      outline: none;
    }

    &::placeholder {
      color: var(--text-placeholder);
      font-weight: 400;
    }
  }

  .el-input__count {
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
    padding: var(--spacing-sm) var(--spacing-md);
    border-radius: var(--border-radius-base);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
  }
}

// 输入框操作按钮
.input-actions {
  position: absolute;
  right: var(--spacing-md);
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  gap: var(--spacing-xs);
  z-index: 10;

  .send-button {
    padding: 8px 16px;
    height: 36px;
    border-radius: var(--border-radius-xl);
    font-size: 13px;
    font-weight: 500;
    transition: var(--transition-normal);
    background: var(--primary-gradient);
    border: none;
    color: white;
    box-shadow: var(--shadow-sm);
    display: flex;
    align-items: center;
    gap: 6px;

    &:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: var(--shadow-md);
    }

    &:disabled {
      opacity: 0.7;
      cursor: not-allowed;
      transform: none !important;
    }

    .el-icon {
      font-size: 14px;
    }
  }

  .action-button {
    width: 36px;
    height: 36px;
    padding: 0;
    border-radius: var(--border-radius-xl);
    color: var(--text-secondary);
    transition: var(--transition-normal);
    background: rgba(255, 255, 255, 0.9);
    border: 1px solid var(--border-light);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    box-shadow: var(--shadow-xs);

    &:hover:not(:disabled) {
      color: var(--primary-color);
      background: rgba(102, 126, 234, 0.1);
      border-color: rgba(102, 126, 234, 0.3);
      transform: scale(1.05);
      box-shadow: var(--shadow-sm);
    }

    &:active:not(:disabled) {
      transform: scale(0.95);
    }

    &:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      transform: none;
    }

    .el-icon {
      font-size: 16px;
    }
  }
}

/* @符号智能提示样式 */
.at-helper-popup {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  margin-bottom: var(--spacing-md);
  width: 100%;
  max-width: 520px;
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(102, 126, 234, 0.2);
  border-radius: var(--border-radius-xl);
  box-shadow: var(--shadow-2xl);
  padding: var(--spacing-lg);
  z-index: 1000;
  animation: fadeInUp var(--transition-normal);

  &::before {
    content: '';
    position: absolute;
    bottom: -8px;
    left: 24px;
    width: 16px;
    height: 16px;
    background: rgba(255, 255, 255, 0.95);
    border: 1px solid rgba(102, 126, 234, 0.2);
    border-left: none;
    border-top: none;
    transform: rotate(45deg);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
}

.at-helper-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-md);
  padding-bottom: var(--spacing-md);
  border-bottom: 1px solid rgba(102, 126, 234, 0.1);

  .el-icon:first-child {
    color: var(--primary-color);
    font-size: 16px;
  }

  > span {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .keyboard-hint {
    display: flex;
    gap: var(--spacing-xs);
    margin-left: auto;
    margin-right: var(--spacing-sm);

    .hint-text {
      font-size: 11px;
      color: var(--text-secondary);
      background: rgba(102, 126, 234, 0.08);
      padding: 4px 8px;
      border-radius: var(--border-radius-sm);
      border: 1px solid rgba(102, 126, 234, 0.15);
      white-space: nowrap;
      font-weight: 500;
    }
  }

  .close-button {
    padding: var(--spacing-xs);
    color: var(--text-secondary);
    transition: var(--transition-fast);

    &:hover {
      color: var(--primary-color);
      background: rgba(102, 126, 234, 0.08);
      border-radius: var(--border-radius-sm);
    }

    .el-icon {
      font-size: 14px;
    }
  }
}

.at-helper-content {
  .open-documents-empty {
    padding: var(--spacing-md);
    background: rgba(245, 158, 11, 0.04);
    border-radius: var(--border-radius-lg);
    border: 1px solid rgba(245, 158, 11, 0.15);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--spacing-md);

    .empty-row {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      color: var(--text-secondary);
      font-size: 13px;

      .empty-icon {
        color: #f59e0b;
        font-size: 14px;
      }
    }

    .empty-actions {
      flex: none;
    }
  }

  .open-documents-section {
    padding: var(--spacing-md);
    background: rgba(102, 126, 234, 0.04);
    border-radius: var(--border-radius-lg);
    border: 1px solid rgba(102, 126, 234, 0.1);

    .section-title {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      margin-bottom: var(--spacing-md);
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);

      .el-icon {
        color: var(--primary-color);
        font-size: 14px;
      }
    }

    .doc-search-input {
      margin-bottom: var(--spacing-md);

      :deep(.el-input__wrapper) {
        border-radius: var(--border-radius-base);
        border: 1px solid rgba(102, 126, 234, 0.2);
        box-shadow: none;
        background: rgba(255, 255, 255, 0.9);
        transition: var(--transition-normal);

        &:hover {
          border-color: rgba(102, 126, 234, 0.4);
          box-shadow: var(--shadow-xs);
        }

        &.is-focus {
          border-color: var(--primary-color);
          box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }
      }
    }

    .documents-list {
      max-height: 200px;
      overflow-y: auto;

      &::-webkit-scrollbar {
        width: 4px;
      }

      &::-webkit-scrollbar-track {
        background: transparent;
      }

      &::-webkit-scrollbar-thumb {
        background: rgba(102, 126, 234, 0.2);
        border-radius: 2px;
      }

      .document-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-sm) var(--spacing-md);
        margin-bottom: var(--spacing-xs);
        border-radius: var(--border-radius-base);
        cursor: pointer;
        transition: var(--transition-normal);
        border: 1px solid transparent;

        &:hover {
          background: rgba(102, 126, 234, 0.08);
          border-color: rgba(102, 126, 234, 0.2);
          transform: translateX(2px);
        }

        &.is-selected {
          background: rgba(102, 126, 234, 0.15);
          border-color: rgba(102, 126, 234, 0.4);
          transform: translateX(4px);
          box-shadow: var(--shadow-sm);
        }

        &:last-child {
          margin-bottom: 0;
        }

        .doc-info {
          flex: 1;
          min-width: 0;

          .doc-row {
            display: flex;
            align-items: center;
            gap: var(--spacing-sm);
            width: 100%;
            min-width: 0;
            flex-wrap: nowrap;
          }

          .doc-name {
            display: flex;
            align-items: center;
            gap: var(--spacing-xs);
            font-size: 13px;
            font-weight: 600;
            color: var(--text-primary);
            flex: 0 0 auto;

            .active-doc-icon {
              color: var(--warning-color);
              font-size: 12px;
            }

            span {
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
            }
          }

          .doc-path {
            font-size: 11px;
            color: var(--text-secondary);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            flex: 1;
            min-width: 0;
            opacity: 0.8;
          }

          .doc-status-row {
            margin-top: 4px;
          }
        }

        .insert-icon {
          color: var(--primary-color);
          font-size: 14px;
          opacity: 0;
          transition: var(--transition-fast);
          background: rgba(102, 126, 234, 0.1);
          border-radius: 50%;
          padding: 2px;
        }

        &:hover .insert-icon {
          opacity: 1;
          background: rgba(102, 126, 234, 0.2);
        }
      }
    }
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
</style>
