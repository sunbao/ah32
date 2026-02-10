<template>
  <div class="document-list">
    <!-- 标题栏 - 免费版优化 -->
    <div class="list-header">
      <div class="title-section">
        <span class="title">📋 文档列表</span>
        <div class="status-row">
          <span class="mechanism-status manual-mode">
            🔄 手动刷新模式
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
          type="text"
          :icon="Refresh"
          @click="manualRefresh"
          class="action-btn"
          title="刷新文档列表 (F5)"
          :loading="isRefreshing"
        />
      </div>
    </div>

    <!-- 免费版提示 -->
    <div class="free-mode-notice">
      <div class="notice-content">
        <div class="notice-icon">💡</div>
        <div class="notice-text">
          <div class="notice-title">WPS免费版优化</div>
          <div class="notice-description">
            免费版不支持事件监听，将自动检测文档变化<br>
            提示：按 F5 键可快速刷新列表
          </div>
        </div>
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
          <div class="doc-meta">
            <span class="doc-type">{{ getDocumentType(doc.name) }}</span>
            <span class="doc-time">{{ formatLastModified(doc.name) }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 空状态 - 免费版优化 -->
    <div v-else class="empty-state">
      <el-empty :description="getEmptyDescription()">
        <template #description>
          <div class="free-mode-empty">
            <div class="empty-icon">📄</div>
            <div class="empty-title">暂无打开的文档</div>
            <div class="empty-description">
              <p>请在 WPS 文字中打开一个文档</p>
              <p class="hint">或通过对话创建新文档</p>
              <div class="refresh-hint">
                💡 提示：按 <kbd>F5</kbd> 键可刷新列表
              </div>
            </div>
          </div>
        </template>
        <el-button type="primary" @click="manualRefresh" :loading="isRefreshing">
          <el-icon><Refresh /></el-icon>
          立即刷新
        </el-button>
      </el-empty>
    </div>

    <!-- 统计信息 -->
    <div v-if="documentStore.documents.length > 0" class="list-footer">
      <div class="stats">
        <span class="stat-item">
          已打开: {{ documentStore.documents.length }}
        </span>
        <span class="stat-divider">|</span>
        <span class="stat-item mode">
          免费版
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue'
import { Document, Star, Refresh } from '@element-plus/icons-vue'
import { useDocumentStore } from '@/stores/document'
import { wpsFreeCompat } from '@/services/wps-free-compat'
import { logger } from '@/utils/logger'

const documentStore = useDocumentStore()

const hostLabel = (host?: string) => {
  const h = String(host || '').toLowerCase()
  if (h === 'et') return 'ET'
  if (h === 'wpp') return 'WPP'
  if (h === 'wps') return 'Writer'
  return (host || 'WPS')
}

// 状态管理
const isRefreshing = ref(false)
const wpsEnvironmentStatus = ref<'checking' | 'available' | 'unavailable'>('checking')

// 刷新文档列表
const refreshDocuments = async () => {
  try {
    isRefreshing.value = true
    logger.info('手动刷新文档列表')
    await documentStore.refreshDocuments()
    logger.info('文档列表刷新完成')
  } catch (error) {
    logger.error('刷新文档列表失败:', error)
  } finally {
    isRefreshing.value = false
  }
}

// 手动刷新（带防抖）
const manualRefresh = async () => {
  if (isRefreshing.value) return
  await refreshDocuments()
}

// 选择文档
const handleSelectDocument = (docId: string) => {
  documentStore.activateDocument(docId)
}

// 获取文档类型
const getDocumentType = (docName: string): string => {
  const ext = docName.split('.').pop()?.toLowerCase()
  const typeMap: Record<string, string> = {
    'docx': 'Word文档',
    'doc': 'Word文档',
    'txt': '文本文档',
    'rtf': '富文本'
  }
  return typeMap[ext || ''] || '未知类型'
}

// 格式化最后修改时间（简化版）
const formatLastModified = (docName: string): string => {
  // 简化版本：在实际应用中可以从文件系统获取
  return '刚刚'
}

// 获取空状态描述
const getEmptyDescription = (): string => {
  if (!wpsFreeCompat.detectWPSEnvironment()) {
    return 'WPS环境不可用'
  }
  return '暂无打开的文档'
}

// 初始化
const initialize = async () => {
  try {
    logger.info('初始化WPS免费版文档列表组件')

    // 检测WPS环境
    const hasWPS = wpsFreeCompat.detectWPSEnvironment()
    wpsEnvironmentStatus.value = hasWPS ? 'available' : 'unavailable'

    if (hasWPS) {
      // 初始化免费版兼容性
      wpsFreeCompat.initialize(async () => {
        await refreshDocuments()
      })

      // 初始刷新
      await refreshDocuments()
    }

    logger.info('WPS免费版文档列表组件初始化完成')
  } catch (error) {
    logger.error('组件初始化失败:', error)
    wpsEnvironmentStatus.value = 'unavailable'
  }
}

onMounted(() => {
  initialize()
})

onUnmounted(() => {
  wpsFreeCompat.destroy()
})
</script>

<style scoped lang="scss">
.document-list {
  display: flex;
  flex-direction: column;
  height: 100%;
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

        &.manual-mode {
          background: #e0f2fe;
          color: #0277bd;
          border: 1px solid #81d4fa;
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

// 免费版提示
.free-mode-notice {
  padding: 8px 12px;
  background: linear-gradient(135deg, #e3f2fd 0%, #f3e5f5 100%);
  border-bottom: 1px solid #e1bee7;

  .notice-content {
    display: flex;
    align-items: center;
    gap: 8px;

    .notice-icon {
      font-size: 16px;
      flex-shrink: 0;
    }

    .notice-text {
      flex: 1;

      .notice-title {
        font-size: 11px;
        font-weight: 600;
        color: #1565c0;
        margin-bottom: 2px;
      }

      .notice-description {
        font-size: 10px;
        color: #666;
        line-height: 1.4;
      }
    }
  }
}

.list-content {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}

.document-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
  margin-bottom: 4px;
  border: 1px solid transparent;

  &:hover {
    background: var(--bg-color-secondary, #f5f7fa);
    border-color: #e0e0e0;
    transform: translateX(2px);
  }

  &.is-active {
    background: var(--primary-color-light, #ecf5ff);
    border-color: var(--primary-color, #409eff);

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
  gap: 6px;
  width: 100%;
  margin-bottom: 2px;
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
  padding: 0 6px;
  height: 16px;
  line-height: 14px;
  font-size: 10px;
}

.doc-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  color: var(--text-secondary, #909399);
}

.doc-type {
  font-weight: 500;
}

.doc-time {
  opacity: 0.8;
}

// 空状态
.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;

  .free-mode-empty {
    text-align: center;

    .empty-icon {
      font-size: 32px;
      margin-bottom: 12px;
    }

    .empty-title {
      font-size: 14px;
      font-weight: 500;
      color: var(--text-primary, #303133);
      margin-bottom: 8px;
    }

    .empty-description {
      font-size: 11px;
      color: var(--text-secondary, #666);
      line-height: 1.6;

      .hint {
        margin-top: 4px;
        opacity: 0.8;
      }

      .refresh-hint {
        margin-top: 12px;
        padding: 8px;
        background: #f0f9ff;
        border-radius: 4px;
        border: 1px solid #bae6fd;
        color: #0369a1;
        font-size: 10px;

        kbd {
          background: #e0e0e0;
          padding: 2px 4px;
          border-radius: 2px;
          font-family: monospace;
          font-size: 9px;
        }
      }
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
  gap: 8px;
  font-size: 11px;
  color: #909399;
}

.stat-item {
  &.target {
    color: #e6a23c;
    font-weight: 500;
  }

  &.mode {
    color: #409eff;
    font-weight: 500;
  }
}

.stat-divider {
  color: #dcdfe6;
}
</style>
