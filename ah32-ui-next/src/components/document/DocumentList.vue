<template>
  <div class="document-list">
    <!-- 标题栏 -->
    <div class="list-header">
      <div class="title-section">
        <span class="title">📋 文档列表</span>
        <div class="status-row">
          <span class="mechanism-status" :class="mechanismClass">
            {{ mechanismText }}
          </span>
          <span v-if="wpsEnvironmentStatus === 'checking'" class="env-status checking">
            🔄 检查中...
          </span>
          <span v-else-if="wpsEnvironmentStatus === 'available'" class="env-status available">
            ✅ WPS就绪
          </span>
          <span v-else-if="wpsEnvironmentStatus === 'unavailable'" class="env-status unavailable">
            ❌ WPS不可用
          </span>
        </div>
      </div>
      <div class="header-actions">
        <el-button
          v-if="currentMechanism === 'manual' || !isEventInitialized"
          type="text"
          :icon="Refresh"
          @click="reinitializeEventDriven"
          class="action-btn"
          title="重新初始化事件驱动"
          :loading="isInitializing"
        />
        <el-button
          v-else
          type="text"
          :icon="Refresh"
          @click="refreshDocuments"
          class="action-btn"
          title="刷新文档列表"
          :disabled="documentStore.isLoading"
        />
      </div>
    </div>

    <!-- 文档列表 -->
    <div class="list-content" v-if="documentStore.documents.length > 0">
      <div
        v-for="doc in documentStore.documents"
        :key="doc.id"
        class="document-item"
        :class="{
          'is-active': doc.isActive
        }"
        @click="handleSelectDocument(doc.id)"
      >
        <div class="doc-icon">
          <el-icon v-if="doc.isActive" class="target-icon"><Star /></el-icon>
          <el-icon v-else>
            <Document />
          </el-icon>
        </div>
        <div class="doc-info">
          <div class="doc-name-row">
            <span class="doc-name" :title="doc.name">{{ doc.name }}</span>
            <el-tag size="small" effect="plain" class="doc-tag">
              {{ hostLabel(doc.hostApp) }}
            </el-tag>
          </div>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else class="empty-state">
      <el-empty :description="emptyDescription">
        <template #description>
          <div v-if="currentMechanism === 'manual'" class="manual-mode-notice">
            <p class="notice-title">⚠️ 事件驱动未启用</p>
            <p class="notice-content">
              请检查 WPS 插件是否正确加载<br>
              或尝试重新打开任务窗格
            </p>
          </div>
          <div v-else>
            <p>请在 WPS 中打开文档</p>
            <p class="hint">或通过对话创建新文档</p>
          </div>
        </template>
      </el-empty>
    </div>

    <!-- 统计信息 -->
    <div v-if="documentStore.documents.length > 0" class="list-footer">
      <div class="stats">
        <span class="stat-item">
          已打开: {{ documentStore.documents.length }}
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue'
import { Document, Star, Refresh } from '@element-plus/icons-vue'
import { useDocumentStore } from '@/stores/document'
import { wpsBridge } from '@/services/wps-bridge'
import { ElMessage } from 'element-plus'


const documentStore = useDocumentStore()

const hostLabel = (host?: string) => {
  const h = String(host || '').toLowerCase()
  if (h === 'et') return 'ET'
  if (h === 'wpp') return 'WPP'
  if (h === 'wps') return 'Writer'
  return (host || 'WPS')
}

// 事件监听器管理
const removeEventListener = ref<(() => void) | null>(null)
const currentMechanism = ref<'event' | 'manual'>('manual')
const isEventInitialized = ref(false)  // 防止重复初始化
const isInitializing = ref(false)     // 防止并发初始化

// WPS环境状态
const wpsEnvironmentStatus = ref<'checking' | 'available' | 'unavailable'>('checking')

// 机制状态计算属性
const mechanismText = computed(() => {
  switch (currentMechanism.value) {
    case 'event':
      return '🔔 事件驱动'
    case 'manual':
      return '⚠️ 手动刷新'
    default:
      return '❓ 未知状态'
  }
})

const mechanismClass = computed(() => {
  switch (currentMechanism.value) {
    case 'event':
      return 'status-event'
    case 'manual':
      return 'status-manual'
    default:
      return 'status-unknown'
  }
})

// 空状态描述
const emptyDescription = computed(() => {
  if (currentMechanism.value === 'manual') {
    return '事件驱动未启用'
  }
  return '暂无打开的文档'
})

// 刷新文档列表
const refreshDocuments = async () => {
  try {
    console.log('[DocumentList] 🔄 手动刷新文档列表...')
    await documentStore.refreshDocuments()
    console.log('[DocumentList] ✅ 文档列表刷新完成')
  } catch (error) {
    console.error('[DocumentList] ❌ 刷新失败:', error)
    ElMessage.error('刷新文档列表失败')
  }
}

// 选择文档
const handleSelectDocument = (docId: string) => {
  documentStore.activateDocument(docId)
  ElMessage.success('已切换到该文档')
}

// 初始化事件驱动机制（防重复和并发）
const initEventDriven = async () => {
  // 防止重复初始化
  if (isEventInitialized.value || isInitializing.value) {
    console.log('[DocumentList] 事件已初始化或正在初始化，跳过')
    return
  }

  isInitializing.value = true
  try {
    console.log('[DocumentList] 开始初始化事件驱动机制...')

    // 首先检查WPS环境
    const isWPSAvailable = wpsBridge.isInWPSEnvironment()
    wpsEnvironmentStatus.value = isWPSAvailable ? 'available' : 'unavailable'

    if (!isWPSAvailable) {
      console.warn('[DocumentList] WPS环境不可用，使用手动模式')
      currentMechanism.value = 'manual'
      await documentStore.refreshDocuments()
      return
    }

    // 异步初始化事件监听器
    const eventInitSuccess = await wpsBridge.initDocumentEventListeners()

    // 监听WPS插件事件通知
    wpsBridge.listenToPluginEvents()

    // 检查当前使用的检测机制
    const mechanism = wpsBridge.getDetectionMechanism()
    currentMechanism.value = mechanism

    console.log(`[DocumentList] 事件机制: ${mechanism}, 初始化${eventInitSuccess ? '成功' : '失败'}`)

    // 注册文档变化监听器（只注册一次）
    if (!removeEventListener.value) {
      const removeListener = wpsBridge.addDocumentChangeListener(async (docs) => {
        console.log('[DocumentList] 📄 检测到文档变化，刷新列表:', docs.length, '个文档')
        // 使用防抖，避免频繁刷新
        debouncedRefreshDocuments()
      })

      removeEventListener.value = removeListener
      console.log('[DocumentList] ✅ 事件监听器已注册')
    }

    // 如果事件初始化失败，立即进行一次手动刷新
    if (!eventInitSuccess) {
      console.log('[DocumentList] 事件初始化失败，执行手动刷新')
      await documentStore.refreshDocuments()
    }

    isEventInitialized.value = true
    console.log('[DocumentList] ✅ 事件驱动初始化完成')

  } catch (error) {
    console.error('[DocumentList] 事件驱动初始化失败:', error)
    // 确保在所有错误情况下都能恢复到手动模式，添加try-catch确保不抛出异常
    try {
      currentMechanism.value = 'manual'
      wpsEnvironmentStatus.value = 'unavailable'
      // 降级到手动刷新，添加try-catch确保不抛出异常
      await documentStore.refreshDocuments()
    } catch (refreshError) {
      console.error('[DocumentList] 手动刷新也失败:', refreshError)
    }
  } finally {
    isInitializing.value = false
  }
}

// 防抖刷新文档列表
let refreshTimer: NodeJS.Timeout | null = null
const debouncedRefreshDocuments = () => {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
  }
  refreshTimer = setTimeout(() => {
    documentStore.refreshDocuments()
  }, 500) // 500ms防抖
}

// 强制重新初始化事件（用于手动刷新）
const reinitializeEventDriven = async () => {
  console.log('[DocumentList] 强制重新初始化事件驱动...')
  isEventInitialized.value = false
  await initEventDriven()
}

onMounted(async () => {
  try {
    console.log('[DocumentList] 📄 组件挂载，开始初始化...')

    // 先初始化文档store
    await documentStore.init()

    // 然后初始化事件驱动机制
    await initEventDriven()

    console.log('[DocumentList] ✅ 组件挂载完成')
  } catch (error) {
    console.error('[DocumentList] ❌ 组件挂载失败:', error)
    // 即使初始化失败，也设置为手动模式
    currentMechanism.value = 'manual'
  }
})

onUnmounted(() => {
  console.log('[DocumentList] 🔄 组件卸载，开始清理...')

  // 清理防抖定时器
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }

  // 清理事件监听器
  if (removeEventListener.value) {
    try {
      removeEventListener.value()
      console.log('[DocumentList] ✅ 事件监听器已清理')
    } catch (error) {
      console.error('[DocumentList] ❌ 清理事件监听器失败:', error)
    }
    removeEventListener.value = null
  }

  // 重置状态
  isEventInitialized.value = false
  isInitializing.value = false

  console.log('[DocumentList] ✅ 组件卸载完成')
})
</script>

<style scoped lang="scss">
.document-list {
  display: flex;
  flex-direction: column;
  /* Don't monopolize the entire right panel. Keep the import/RAG area visible below. */
  height: auto;
  max-height: clamp(220px, 40vh, 420px);
  background: #fff;
}

.list-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-lighter, #ebeef5);

  .title-section {
    display: flex;
    flex-direction: column;
    gap: 2px;

    .title {
      font-weight: 600;
      font-size: 12px;
      color: var(--text-primary, #303133);
    }

    .status-row {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;

      .mechanism-status {
        font-size: 10px;
        font-weight: 500;
        padding: 2px 6px;
        border-radius: 10px;
        display: inline-block;

        &.status-event {
          background: #f0f9ff;
          color: #0369a1;
          border: 1px solid #bae6fd;
        }

        &.status-manual {
          background: #fef2f2;
          color: #dc2626;
          border: 1px solid #fecaca;
        }

        &.status-unknown {
          background: #f8fafc;
          color: #64748b;
          border: 1px solid #e2e8f0;
        }
      }

      .env-status {
        font-size: 10px;
        font-weight: 500;
        padding: 2px 6px;
        border-radius: 10px;
        display: inline-block;

        &.checking {
          background: #fef3c7;
          color: #92400e;
          border: 1px solid #fde68a;
        }

        &.available {
          background: #d1fae5;
          color: #065f46;
          border: 1px solid #a7f3d0;
        }

        &.unavailable {
          background: #fee2e2;
          color: #991b1b;
          border: 1px solid #fecaca;
        }
      }
    }
  }

  .header-actions {
    display: flex;
    gap: 4px;
  }

  .action-btn {
    padding: 4px 8px;
    min-height: 20px;
  }
}

.list-content {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 4px;
}

.document-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;
  margin-bottom: 2px;

  &:hover {
    background: var(--bg-color-secondary, #f5f7fa);
    transform: translateX(2px);
  }

  &.is-active {
    background: var(--primary-color-light, #ecf5ff);

    .doc-name {
      color: var(--primary-color, #409eff);
      font-weight: 500;
    }
  }

  &.is-target {
    .doc-icon {
      color: #e6a23c;
    }
  }
}

.doc-icon {
  flex-shrink: 0;
  font-size: 14px;
  color: var(--text-secondary, #909399);

  .target-icon {
    font-size: 12px;
  }
}

.doc-info {
  flex: 1;
  min-width: 0;
}

.doc-name-row {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
}

.doc-name {
  flex: 1;
  font-size: 11px;
  color: var(--text-primary, #303133);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.doc-tag {
  flex-shrink: 0;
  padding: 0 4px;
  height: 16px;
  line-height: 14px;
  font-size: 10px;
}

.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;

  .hint {
    font-size: 11px;
    color: #909399;
    margin-top: 4px;
  }

  .manual-mode-notice {
    text-align: center;

    .notice-title {
      font-size: 12px;
      font-weight: 600;
      color: #dc2626;
      margin-bottom: 8px;
    }

    .notice-content {
      font-size: 11px;
      color: #64748b;
      line-height: 1.5;
    }
  }
}

.list-footer {
  padding: 6px 10px;
  border-top: 1px solid var(--border-lighter, #ebeef5);
  background: var(--bg-color-secondary, #f5f7fa);
}

.stats {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #909399;
}

.stat-item {
  &.target {
    color: #e6a23c;
    font-weight: 500;
  }
}

.stat-divider {
  color: #dcdfe6;
}
</style>
