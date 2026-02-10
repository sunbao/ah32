<template>
  <div class="document-import-center">
    <div v-if="isInitializing" class="loading-overlay">
      <el-icon class="loading-icon" :size="40">
        <Loading />
      </el-icon>
      <p class="loading-text">正在加载文档导入中心...</p>
    </div>

    <template v-else>
      <div class="import-content">

        <ImportMethodSelector
          :methods="importMethods"
          @select="handleMethodSelect"
          @execute="handleMethodExecute"
        />

        <RagDocumentsPanel
          :documents="ragDocuments"
          :statistics="ragStatistics"
          @view="handleViewDocument"
          @reimport="handleReimport"
          @delete="handleDeleteDocument"
          @refresh="handleRefreshRag"
        />

        <TaskManager
          :tasks="importTasks"
          @start="handleTaskStart"
          @pause="handleTaskPause"
          @cancel="handleTaskCancel"
          @refresh="handleTaskRefresh"
          @clear-all="handleClearAllTasks"
        />
      </div>
    </template>

    <!-- 文档详情弹窗 -->
    <el-dialog v-model="detailVisible" title="RAG文档详情" width="720px">
      <div v-loading="detailLoading">
        <el-alert v-if="detailError" :title="detailError" type="error" :closable="false" show-icon />
        <template v-else-if="detailData">
          <div style="margin-bottom: 8px;">
            <div><strong>文件：</strong>{{ detailData.name }}</div>
            <div><strong>路径：</strong>{{ detailData.path }}</div>
            <div><strong>大小：</strong>{{ detailData.size }}；<strong>修改时间：</strong>{{ detailData.modified }}</div>
            <div><strong>Chunks：</strong>{{ detailData.chunks }}</div>
          </div>
          <el-divider />
          <div style="max-height: 320px; overflow: auto; padding-right: 8px;">
            <div v-for="(c, idx) in (detailData.chunksData || []).slice(0, 20)" :key="idx" style="margin-bottom: 10px;">
              <el-tag size="small" type="info">chunk {{ idx + 1 }}</el-tag>
              <div style="white-space: pre-wrap; font-size: 12px; color: #334155; margin-top: 6px;">
                {{ c.content_preview || c.content || '' }}
              </div>
            </div>
            <el-text v-if="(detailData.chunksData || []).length > 20" type="info" size="small">
              仅展示前20个chunk（共{{ detailData.chunks }}个）
            </el-text>
          </div>
        </template>
      </div>
      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { ElMessageBox, ElMessage } from 'element-plus'
import { Loading } from '@element-plus/icons-vue'
import { useDocumentStore } from '@/stores/document'
import { useImportStore } from '@/stores/import'
import { ragApi } from '@/services/rag-api'
import { getRuntimeConfig } from '@/utils/runtime-config'
import ImportMethodSelector from './ImportMethodSelector.vue'
import RagDocumentsPanel from './RagDocumentsPanel.vue'
import TaskManager from './TaskManager.vue'

const documentStore = useDocumentStore()
const importStore = useImportStore()

const isInitializing = ref(true)
const detailVisible = ref(false)
const detailLoading = ref(false)
const detailError = ref('')
const detailData = ref<any>(null)
const detailDoc = ref<any>(null)

const ragStatistics = computed(() => importStore.statistics)

const ragDocuments = computed(() => importStore.documents)

const importTasks = computed(() => importStore.tasks)

const currentContextPath = computed(() => documentStore.targetDocument?.path || '')

const isRemoteBackend = (): boolean => {
  try {
    const base = getRuntimeConfig().apiBase || ''
    const u = new URL(base)
    const host = (u.hostname || '').toLowerCase()
    return host !== '127.0.0.1' && host !== 'localhost'
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/import/DocumentImportCenter.vue', e)
    return false
  }
}

const pickFolderFiles = (): Promise<File[]> => {
  return new Promise((resolve) => {
    try {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      ;(input as any).webkitdirectory = true
      ;(input as any).directory = true
      input.onchange = () => {
        const list = input.files ? Array.from(input.files) : []
        resolve(list)
      }
      input.click()
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/import/DocumentImportCenter.vue', e)
      resolve([])
    }
  })
}

const importMethods = [
  { id: 'wps', name: 'WPS同步', icon: '📄', description: '同步WPS已打开文档' },
  { id: 'agent', name: '目录导入', icon: '🤖', description: '导入一个文件夹（目录扫描）' },
  { id: 'api', name: 'API集成', icon: '🔗', description: '外部系统集成' }
]

const handleWpsSync = async (doc: any) => {
  try {
    console.log('[DocumentImportCenter] 开始同步WPS文档到RAG:', doc.name)
    ElMessage.info(`正在同步文档 "${doc.name}" 到RAG知识库...`)

    const taskId = importStore.createTask('wps', {
      documentId: doc.id,
      documentName: doc.name,
      documentPath: doc.path || doc.fullName,
      includeMetadata: true
    })
    importStore.startTask(taskId)

    ElMessage.success(`已启动同步任务: ${doc.name}`)
  } catch (error) {
    console.error('[DocumentImportCenter] 同步WPS文档失败:', error)
    ElMessage.error(`同步文档 "${doc.name}" 失败: ${error.message}`)
  }
}

const handleMethodSelect = (method: string) => {
  console.log('选择导入方式:', method)
}

const handleMethodExecute = async (method: string) => {
  try {
    if (method === 'wps') {
      const active = documentStore.documents.find(d => d.isActive)
      if (!active) {
        ElMessage.warning('未找到活动文档，请先在WPS中打开并激活一个文档')
        return
      }
      await handleWpsSync(active)
      return
    }

    if (method === 'agent') {
      // Remote backend cannot scan a client-local folder path. Use folder upload without adding new UI.
      if (isRemoteBackend()) {
        const files = await pickFolderFiles()
        if (!files || files.length === 0) return
        const taskId = importStore.createTask('agent', { files })
        importStore.startTask(taskId)
        ElMessage.success(`已启动上传入库任务（${files.length} 个文件）`)
        return
      }

      const { value } = await ElMessageBox.prompt('请输入要扫描的目录路径（将导入 txt/md/doc/docx）', '开始扫描', {
        confirmButtonText: '开始扫描',
        cancelButtonText: '取消',
        inputPlaceholder: '例如：D:\\资料\\招投标\\',
        inputValidator: (v: string) => !!v?.trim(),
        inputErrorMessage: '目录不能为空'
      })
      const taskId = importStore.createTask('agent', { directory: value.trim() })
      importStore.startTask(taskId)
      ElMessage.success('已启动扫描任务')
      return
    }

    if (method === 'api') {
      ElMessage.info('API集成功能尚未实现（可先用WPS同步/Agent扫描）')
      return
    }
  } catch (e) {
    // 用户取消等
  }
}

const handleViewDocument = (doc: any) => {
  detailDoc.value = doc
  detailVisible.value = true
  detailLoading.value = true
  detailError.value = ''
  detailData.value = null

  ragApi.getDocumentDetail(doc.path).then((resp) => {
    if (!resp.success) {
      detailError.value = resp.error || resp.message || '获取详情失败'
      return
    }
    detailData.value = resp.data
  }).catch((err) => {
    detailError.value = err?.message || String(err)
  }).finally(() => {
    detailLoading.value = false
  })
}

const handleReimport = (doc: any) => {
  const p = String(doc?.path || '').trim()
  if (!p || p.startsWith('upload://')) {
    ElMessage.warning('该文档为“上传入库”类型，不支持重导入；如需更新请重新上传/再次同步。')
    return
  }
  const taskId = importStore.createTask('reimport', {
    documentPath: doc.path,
    documentName: doc.name
  })
  importStore.startTask(taskId)
}

const handleDeleteDocument = async (doc: any) => {
  ElMessageBox.confirm(
    `确定要删除文档 "${doc.name}" 吗？\n此操作不可撤销。`,
    '删除文档',
    {
      confirmButtonText: '确定删除',
      cancelButtonText: '取消',
      type: 'warning',
    }
  ).then(async () => {
    try {
      await ragApi.deleteDocument(doc.path)
      await loadRagDocuments()
      // Keep totals in sync after delete (docs/vectors/storage).
      await importStore.fetchRagStatistics()
      ElMessage.success('文档删除成功')
    } catch (error) {
      console.error('删除文档失败:', error)
      ElMessage.error('删除文档失败')
    }
  }).catch(() => {
    // 用户取消删除
  })
}

const handleTaskStart = (taskId: string) => {
  importStore.startTask(taskId)
}

const handleTaskPause = (taskId: string) => {
  importStore.pauseTask(taskId)
}

const handleTaskCancel = (taskId: string) => {
  importStore.cancelTask(taskId)
  ElMessage.info('任务已取消')
}

const handleTaskRefresh = () => {
  console.log('[DocumentImportCenter] 刷新任务列表')
  // 任务列表是响应式的，会自动更新
}

const handleClearAllTasks = () => {
  console.log('[DocumentImportCenter] 清空所有任务')
  importStore.clearAllTasks()
  ElMessage.success('所有任务已清空')
}

const loadRagDocuments = async () => {
  try {
    await importStore.fetchDocumentsByMethod({
      contextDocumentPath: currentContextPath.value,
      includeGlobal: true
    })
  } catch (error) {
    console.error('[DocumentImportCenter] RAG文档加载失败:', error)
  }
}

const handleRefreshRag = async () => {
  await loadRagDocuments()
  await importStore.fetchRagStatistics({
    contextDocumentPath: currentContextPath.value,
    includeGlobal: true
  })
}

onMounted(async () => {
  try {
    console.log('[DocumentImportCenter] 开始初始化...')

    // 首次加载RAG数据
    await loadRagDocuments()
    await importStore.fetchRagStatistics({
      contextDocumentPath: currentContextPath.value,
      includeGlobal: true
    })

    console.log('[DocumentImportCenter] 初始化完成，设置事件监听器')
    setupWPSEventListeners()
  } catch (error) {
    console.error('[DocumentImportCenter] 初始化失败:', error)
  } finally {
    isInitializing.value = false
    console.log('[DocumentImportCenter] isInitializing 设置为 false')
  }
})

const setupWPSEventListeners = () => {
  console.log('[DocumentImportCenter] 开始设置WPS事件监听器...')

  window.addEventListener('message', async (event) => {
    console.log('[DocumentImportCenter] 收到message事件! 数据:', event.data)

    try {
      let messageData = event.data

      if (typeof messageData === 'string') {
        messageData = JSON.parse(messageData)
      }

      const { type, data } = messageData || {}

      console.log(`[DocumentImportCenter] 解析消息: type=${type}, data=`, data)

      if (type === 'WPSDocumentChange') {
        console.log('[DocumentImportCenter] 处理WPS文档变化事件:', data)
        await documentStore.refreshDocuments()
        // Active doc may change -> refresh scoped list/statistics.
        handleRefreshRag()
      } else if (type === 'RefreshDocumentList') {
        documentStore.refreshDocuments()
        handleRefreshRag()
      }
    } catch (error) {
      console.warn('[DocumentImportCenter] 消息解析失败:', error)
    }
  })

  setTimeout(() => {
    console.log('[DocumentImportCenter] 测试：在浏览器控制台运行以下代码模拟WPS事件:')
    console.log(`
window.dispatchEvent(new CustomEvent('message', {
  detail: {
    type: 'WPSDocumentChange',
    data: {
      type: 'open',
      docName: '测试文档.docx',
      timestamp: ${Date.now()}
    }
  }
}))
    `.trim())
  }, 2000)
}
</script>

<style scoped>
.document-import-center {
  padding: 0;
  position: relative;
  background: transparent;
  overflow: visible;
}

.loading-overlay {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 16px;
}

.loading-icon {
  color: var(--primary-color);
  animation: rotate 1.5s linear infinite;
}

.loading-text {
  color: #909399;
  font-size: 14px;
  margin: 0;
}

/* 内容区域 - 移除滚动条，让内容自然展开 */
.import-content {
  overflow: visible;
  padding: 0;
  box-sizing: border-box;
}

/* 各面板优化间距 */
.import-content > * {
  margin-bottom: 0;
}

.import-content > *:last-child {
  margin-bottom: 0;
}

@keyframes rotate {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
