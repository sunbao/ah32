<template>
  <div class="import-method-selector">
    <div class="panel-header">
      <h3>📥 文档导入方式</h3>
      <el-text type="info" size="small">选择不同的方式将文档导入到RAG知识库</el-text>
    </div>

    <div class="methods-grid">
      <div
        v-for="method in methods"
        :key="method.id"
        class="method-card"
        @click="selectMethod(method.id)"
        :class="{ 'active': selectedMethod === method.id }"
      >
        <div class="method-icon">{{ method.icon }}</div>
        <div class="method-content">
          <div class="method-name">{{ method.name }}</div>
          <div class="method-description">{{ method.description }}</div>
        </div>
        <div class="method-arrow">
          <el-icon><ArrowRight /></el-icon>
        </div>
      </div>
    </div>

    <!-- 方法详情展示 -->
    <div v-if="selectedMethod" class="method-details">
      <el-card shadow="never">
        <template #header>
          <div class="card-header">
            <span>{{ selectedMethodInfo.name }}</span>
            <el-button size="small" type="primary" @click="executeMethod">
              {{ getActionText(selectedMethod) }}
            </el-button>
          </div>
        </template>

        <div class="method-detail-content">
          <div v-if="selectedMethod === 'wps'" class="method-description">
            <p>同步当前WPS中已打开的文档到RAG知识库</p>
            <el-alert
              title="提示"
              type="info"
              :closable="false"
              show-icon
            >
              <template #default>
                <p>• 仅同步文档元信息，不读取文档内容</p>
                <p>• 自动去重，相同文件不会重复导入</p>
                <p>• 支持 Word、Excel、PowerPoint 格式</p>
              </template>
            </el-alert>
          </div>

          <div v-else-if="selectedMethod === 'agent'" class="method-description">
            <p>选择一个文件夹（目录导入），扫描其中的文档并批量入库到知识库</p>
            <el-alert
              title="注意"
              type="warning"
              :closable="false"
              show-icon
            >
              <template #default>
                <p>• 智能识别招标、投标、技术文档</p>
                <p>• 自动分类和标注</p>
                <p>• 支持批量处理</p>
              </template>
            </el-alert>
          </div>

          <div v-else-if="selectedMethod === 'api'" class="method-description">
            <p>通过REST API集成外部系统，实现自动化文档导入</p>
            <el-alert
              title="配置要求"
              type="warning"
              :closable="false"
              show-icon
            >
              <template #default>
                <p>• 需要配置API端点地址</p>
                <p>• 支持API密钥认证</p>
                <p>• 支持Webhook回调</p>
              </template>
            </el-alert>
          </div>
        </div>
      </el-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { ArrowRight } from '@element-plus/icons-vue'

interface ImportMethod {
  id: string
  name: string
  icon: string
  description: string
}

interface Props {
  methods: ImportMethod[]
}

const props = defineProps<Props>()
const emit = defineEmits(['select', 'execute'])

const selectedMethod = ref<string>('')

const selectedMethodInfo = computed(() => {
  return props.methods.find(m => m.id === selectedMethod.value) || props.methods[0]
})

const selectMethod = (methodId: string) => {
  selectedMethod.value = methodId
  emit('select', methodId)
}

const getActionText = (methodId: string) => {
  const actionMap: Record<string, string> = {
    'wps': '开始同步',
    'agent': '开始扫描',
    'api': '配置API'
  }
  return actionMap[methodId] || '执行'
}

const executeMethod = () => {
  emit('execute', selectedMethod.value)
}
</script>

<style scoped>
.import-method-selector {
  margin-bottom: 24px;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  padding: 16px;
  background: white;
}

.panel-header {
  margin-bottom: 16px;
}

.panel-header h3 {
  margin: 0 0 4px 0;
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}

.methods-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}

.method-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.3s;
  background: white;
}

.method-card:hover {
  border-color: var(--primary-color);
  box-shadow: 0 2px 4px rgba(102, 126, 234, 0.12);
}

.method-card.active {
  border-color: var(--primary-color);
  background-color: rgba(102, 126, 234, 0.08);
}

.method-icon {
  font-size: 32px;
  width: 48px;
  text-align: center;
}

.method-content {
  flex: 1;
  min-width: 0;
}

.method-name {
  font-size: 14px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 4px;
}

.method-description {
  font-size: 12px;
  color: #909399;
  line-height: 1.4;
}

.method-arrow {
  color: #c0c4cc;
}

.method-card:hover .method-arrow {
  color: var(--primary-color);
}

.method-details {
  margin-top: 16px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.card-header span {
  font-size: 14px;
  font-weight: 600;
  color: #303133;
}

.method-detail-content {
  font-size: 13px;
  color: #606266;
}

.method-detail-content p {
  margin: 0 0 8px 0;
  line-height: 1.6;
}

.el-alert {
  margin-top: 12px;
}
</style>
