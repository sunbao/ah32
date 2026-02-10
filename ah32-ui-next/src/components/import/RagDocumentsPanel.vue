<template>
  <div class="rag-documents-panel">
    <div class="panel-header">
      <h3>🗄️ RAG知识库文档</h3>
      <div class="stats">
        <el-tag type="info">总文档: {{ statistics.totalDocuments }} 个</el-tag>
        <el-tag type="success">总向量: {{ formatNumber(statistics.totalVectors) }} 个</el-tag>
        <el-tag type="warning">存储: {{ statistics.storageSize }}</el-tag>
        <el-text size="small" type="info" style="margin-left: 8px;">
          当前检索范围: {{ (statistics.scopeProjectLabel || '当前项目') }} + 全局库
        </el-text>
        <el-button size="small" type="primary" @click="$emit('refresh')">刷新</el-button>
      </div>
    </div>

    <!-- 按导入方式分组的文档列表 -->
    <div class="documents-by-method">
      <!-- 如果没有文档，显示空状态 -->
      <div v-if="documents.length === 0" class="empty-state">
        <div class="empty-content">
          <div class="empty-icon">🗄️</div>
          <h4 class="empty-title">暂无RAG文档</h4>
          <p class="empty-desc">请使用上方导入方式同步文档到知识库</p>
        </div>
      </div>

      <!-- 有文档时显示分组列表 -->
      <template v-else>
        <div
          v-for="(methodGroup, index) in documents"
          :key="methodGroup.method"
          class="method-group"
        >
          <div class="group-header">
            <span class="method-icon">{{ getMethodIcon(methodGroup.method) }}</span>
            <span class="method-name">{{ getMethodName(methodGroup.method, methodGroup.name) }}</span>
            <el-badge :value="methodGroup.count" class="method-badge" />
            <el-button
              size="small"
              type="primary"
              @click="toggleGroup(methodGroup.method)"
            >
              {{ isExpanded(methodGroup.method) ? '收起' : '展开' }}
            </el-button>
          </div>

          <div
            v-if="isExpanded(methodGroup.method)"
            class="documents-list"
          >
            <div class="docs-container">
              <div
                v-for="doc in (isShowAll(methodGroup.method) ? methodGroup.documents : methodGroup.documents.slice(0, 3))"
                :key="doc.path || doc.name"
                class="document-item"
              >
                <div class="doc-info">
                  <span class="doc-name">{{ doc.name }}</span>
                  <span class="doc-meta">
                    {{ doc.size }} | {{ doc.vectors }}向量 | {{ doc.importTime }}
                  </span>
                  <el-tag size="small" type="info">{{ getMethodName(doc.importMethod, doc.importMethod) }}</el-tag>
                  <el-tag size="small" :type="getScopeTagType(doc.scope)" style="margin-left: 6px;">
                    {{ getScopeLabel(doc.scope) }}
                  </el-tag>
                </div>

                <div class="doc-actions">
                  <el-button
                    size="small"
                    text
                    @click="$emit('view', doc)"
                    title="查看详情"
                  >
                    <el-icon><View /></el-icon>
                  </el-button>

                  <el-button
                    size="small"
                    text
                    @click="$emit('reimport', doc)"
                    title="重新导入"
                  >
                    <el-icon><Refresh /></el-icon>
                  </el-button>

                  <el-button
                    size="small"
                    text
                    @click="$emit('delete', doc)"
                    title="删除文档"
                    class="delete-btn"
                  >
                    <el-icon><Delete /></el-icon>
                  </el-button>
                </div>
              </div>

              <div
                v-if="methodGroup.documents.length > 3 && !isShowAll(methodGroup.method)"
                class="show-more"
                @click="showAllDocuments(methodGroup.method)"
              >
                还有 {{ methodGroup.documents.length - 3 }} 个文档...
                <el-icon><ArrowDown /></el-icon>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, withDefaults } from 'vue'
import { View, Refresh, Delete, ArrowDown } from '@element-plus/icons-vue'

interface DocumentItem {
  name: string
  path: string
  displayPath?: string
  size: string
  importMethod: string
  importTime: string
  vectors: number
  scope?: 'global' | 'project' | 'both' | 'unscoped'
  projectsCount?: number
}

interface MethodGroup {
  method: string
  name: string
  count: number
  documents: DocumentItem[]
}

interface Props {
  documents?: MethodGroup[]
  statistics?: {
    totalDocuments: number
    totalVectors: number
    storageSize: string
    scopeProjectId?: string | null
    scopeProjectLabel?: string | null
    includeGlobal?: boolean
    globalDocuments?: number | null
    projectDocuments?: number | null
  }
}

const props = withDefaults(defineProps<Props>(), {
  documents: () => [],
  statistics: () => ({
    totalDocuments: 0,
    totalVectors: 0,
    storageSize: '-'
  })
})
defineEmits(['view', 'reimport', 'delete', 'refresh'])

const expandedGroups = ref<string[]>([])
const showAllGroups = ref<string[]>([])

const normMethod = (m: string) => String(m || '').trim()
const isExpanded = (method: string) => expandedGroups.value.includes(normMethod(method))
const isShowAll = (method: string) => showAllGroups.value.includes(normMethod(method))

const formatNumber = (num: number) => {
  return num.toLocaleString()
}

const getMethodName = (method: string, fallbackName?: string) => {
  const nameMap: Record<string, string> = {
    'wps': 'WPS同步导入',
    'agent': '目录导入',
    'api': 'API集成导入',
    'command': '命令行导入',
    'atref': '@引用导入',
    'reimport': '重新导入',
    // 兼容后端/历史返回的中文命名
    'Agent智能导入': '目录导入'
  }

  return nameMap[method] || fallbackName || method
}

const getMethodIcon = (method: string) => {
  const iconMap: Record<string, string> = {
    'wps': '📄',
    'agent': '🤖',
    'command': '⌨️',
    'atref': '📎',
    'api': '🔗'
  }
  return iconMap[method] || '📄'
}

const getScopeLabel = (scope?: string) => {
  if (scope === 'global') return '全局'
  if (scope === 'project') return '项目'
  if (scope === 'both') return '项目+全局'
  return '未分组'
}

const getScopeTagType = (scope?: string) => {
  if (scope === 'global') return 'success'
  if (scope === 'project') return 'primary'
  if (scope === 'both') return 'warning'
  return 'info'
}

const toggleGroup = (method: string) => {
  const m = normMethod(method)
  const index = expandedGroups.value.indexOf(m)
  if (index > -1) {
    expandedGroups.value.splice(index, 1)
    const showAllIndex = showAllGroups.value.indexOf(m)
    if (showAllIndex > -1) showAllGroups.value.splice(showAllIndex, 1)
  } else {
    expandedGroups.value.push(m)
  }
}

const showAllDocuments = (method: string) => {
  const m = normMethod(method)
  if (!expandedGroups.value.includes(m)) {
    expandedGroups.value.push(m)
  }
  if (!showAllGroups.value.includes(m)) {
    showAllGroups.value.push(m)
  }
}

// 当有文档时，默认展开第一个组
watch(() => props.documents, (newDocs) => {
  if (!Array.isArray(newDocs)) return
  if (newDocs.length > 0 && expandedGroups.value.length === 0) {
    expandedGroups.value.push(normMethod(newDocs[0].method))
  }
}, { immediate: true })
</script>

<style scoped>
.rag-documents-panel {
  margin-bottom: 24px;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  padding: 16px;
  background: white;
  min-height: 200px;
}

.empty-state {
  padding: 20px;
  text-align: center;
}

.empty-content {
  padding: 32px 20px;
  background: #f8f9fa;
  border-radius: 8px;
  border: 1px dashed #dcdfe6;
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 12px;
}

.empty-title {
  margin: 0 0 8px 0;
  color: #303133;
  font-size: 15px;
  font-weight: 500;
}

.empty-desc {
  margin: 0;
  color: #909399;
  font-size: 13px;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid #e4e7ed;
  gap: 16px;
}

.panel-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #303133;
  flex-shrink: 0;
  white-space: nowrap;
}

.stats {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.documents-by-method {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.method-group {
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  overflow: hidden;
}

.group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background-color: #f5f7fa;
  border-bottom: 1px solid #e4e7ed;
}

.method-icon {
  font-size: 20px;
}

.method-name {
  flex: 1;
  font-size: 14px;
  font-weight: 500;
  color: #303133;
}

.method-badge {
  margin-right: 8px;
}

.documents-list {
  padding: 8px;
}

.docs-container {
  /* 移除max-height和overflow，让内容自然展开 */
  overflow-x: hidden;
}

.document-item {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  border-radius: 4px;
  transition: background-color 0.3s;
}

.document-item:hover {
  background-color: #f5f7fa;
}

.doc-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.doc-name {
  font-size: 14px;
  font-weight: 500;
  color: #303133;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.doc-meta {
  font-size: 12px;
  color: #909399;
  display: flex;
  align-items: center;
  gap: 8px;
}

.doc-actions {
  display: flex;
  gap: 4px;
}

.delete-btn {
  color: #f56c6c;
}

.delete-btn:hover {
  color: #ff6b6b;
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
  margin-top: 8px;
  border-top: 1px dashed #e4e7ed;
}

.show-more:hover {
  opacity: 0.85;
}
</style>
