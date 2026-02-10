<template>
  <div class="opened-documents-panel">
    <div class="panel-header">
      <h3>📄 已打开的WPS文档</h3>
      <el-tag type="info" v-if="documents.length > maxVisible">
        显示前 {{ maxVisible }} 个，共 {{ documents.length }} 个
      </el-tag>
    </div>

    <div class="documents-list" v-if="documents.length > 0">
      <div
        v-for="doc in visibleDocuments"
        :key="doc.id"
        class="document-item"
        :class="{ 'active': doc.isActive }"
      >
        <div class="doc-icon">
          {{ getFileIcon(doc.name) }}
        </div>

        <div class="doc-info">
          <div class="doc-name">{{ doc.name }}</div>
          <div class="doc-meta">
            <el-tag size="small" :type="doc.isActive ? 'success' : 'info'">
              {{ doc.isActive ? '活动' : '后台' }}
            </el-tag>
            <span v-if="doc.pageCount">页数: {{ doc.pageCount }}</span>
            <span v-if="doc.wordCount">字数: {{ formatNumber(doc.wordCount) }}</span>
          </div>
        </div>

        <div class="doc-actions">
          <el-button
            size="small"
            type="primary"
            @click="$emit('sync', doc)"
            :loading="syncingDocId === doc.id"
          >
            <el-icon><Upload /></el-icon>
            同步到RAG
          </el-button>
        </div>
      </div>

      <div v-if="documents.length > maxVisible" class="show-more" @click="showAll = !showAll">
        {{ showAll ? '收起' : `显示全部 ${documents.length} 个文档` }}
        <el-icon>
          <ArrowDown v-if="!showAll" />
          <ArrowUp v-else />
        </el-icon>
      </div>
    </div>

    <el-empty v-else description="没有打开的WPS文档" :image-size="80" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { ArrowDown, ArrowUp, Upload } from '@element-plus/icons-vue'

interface WPSDocument {
  id: string
  name: string
  path?: string
  fullName?: string
  isActive: boolean
  pageCount?: number
  wordCount?: number
}

interface Props {
  documents: WPSDocument[]
  maxVisible?: number
}

const props = withDefaults(defineProps<Props>(), {
  maxVisible: 5
})

defineEmits(['sync'])

const syncingDocId = ref<string | null>(null)
const showAll = ref(false)

const visibleDocuments = computed(() => {
  if (showAll.value || props.documents.length <= props.maxVisible) {
    return props.documents
  }
  return props.documents.slice(0, props.maxVisible)
})

const getFileIcon = (fileName: string) => {
  const ext = fileName.split('.').pop()?.toLowerCase()
  const iconMap: Record<string, string> = {
    'doc': '📄',
    'docx': '📄',
    'pdf': '📋',
    'xls': '📊',
    'xlsx': '📊',
    'ppt': '📑',
    'pptx': '📑',
    'txt': '📝'
  }
  return iconMap[ext || ''] || '📄'
}

const formatNumber = (num: number) => {
  if (num >= 10000) {
    return (num / 10000).toFixed(1) + '万'
  }
  return num.toLocaleString()
}
</script>

<style scoped>
.opened-documents-panel {
  margin-bottom: 24px;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  padding: 16px;
  background: white;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.panel-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}

.documents-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.document-item {
  display: flex;
  align-items: center;
  padding: 12px;
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  transition: all 0.3s;
}

.document-item:hover {
  border-color: var(--primary-color);
  box-shadow: 0 2px 4px rgba(102, 126, 234, 0.12);
}

.document-item.active {
  border-color: #67c23a;
  background-color: rgba(103, 194, 58, 0.08);
}

.doc-icon {
  font-size: 32px;
  margin-right: 12px;
}

.doc-info {
  flex: 1;
  min-width: 0;
}

.doc-name {
  font-size: 14px;
  font-weight: 500;
  color: #303133;
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.doc-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #606266;
}

.doc-actions {
  display: flex;
  gap: 8px;
}

.show-more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 8px;
  color: var(--primary-color);
  cursor: pointer;
  font-size: 13px;
}

.show-more:hover {
  opacity: 0.85;
}
</style>
