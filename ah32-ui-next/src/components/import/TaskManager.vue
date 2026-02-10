<template>
  <div class="task-manager">
    <div class="panel-header">
      <h3>📋 导入任务管理</h3>
      <div class="header-actions">
        <el-button size="small" @click="$emit('refresh')">
          <el-icon><Refresh /></el-icon>
          刷新
        </el-button>
        <el-button size="small" type="danger" @click="handleClearAll" :disabled="tasks.length === 0">
          <el-icon><Delete /></el-icon>
          清空
        </el-button>
      </div>
    </div>

    <div class="tasks-container" v-if="tasks.length > 0">
      <div
        v-for="task in tasks"
        :key="task.id"
        class="task-item"
        :class="`task-${task.status}`"
      >
        <div class="task-header">
          <div class="task-info">
            <span class="task-icon">{{ getTaskIcon(task.type) }}</span>
            <div class="task-details">
              <div class="task-name">{{ task.name }}</div>
              <div class="task-meta">
                <el-tag size="small" :type="getStatusType(task.status)">
                  {{ getStatusText(task.status) }}
                </el-tag>
                <span class="task-time">{{ formatTime(task.startTime) }}</span>
              </div>
            </div>
          </div>

          <div class="task-actions">
            <el-button
              v-if="task.status === 'pending'"
              size="small"
              type="primary"
              @click="$emit('start', task.id)"
            >
              <el-icon><VideoPlay /></el-icon>
              开始
            </el-button>

            <el-button
              v-if="task.status === 'running'"
              size="small"
              @click="$emit('pause', task.id)"
            >
              <el-icon><VideoPause /></el-icon>
              暂停
            </el-button>

            <el-button
              v-if="task.status === 'paused'"
              size="small"
              type="primary"
              @click="$emit('start', task.id)"
            >
              <el-icon><VideoPlay /></el-icon>
              继续
            </el-button>

            <el-button
              v-if="task.status !== 'completed' && task.status !== 'failed'"
              size="small"
              type="danger"
              text
              @click="$emit('cancel', task.id)"
            >
              <el-icon><Close /></el-icon>
              取消
            </el-button>
          </div>
        </div>

        <!-- 进度条 -->
        <div v-if="task.status === 'running' || task.status === 'completed'" class="task-progress">
          <el-progress
            :percentage="task.progress"
            :status="task.status === 'completed' ? 'success' : undefined"
            :show-text="true"
            :stroke-width="8"
          />
          <div class="progress-info">
            <span>{{ task.currentStep }}</span>
            <span>{{ task.progress }}%</span>
          </div>
        </div>

        <!-- 错误信息 -->
        <div v-if="task.status === 'failed'" class="task-error">
          <el-alert
            :title="task.error || '任务执行失败'"
            type="error"
            :closable="false"
            show-icon
          />
        </div>

        <!-- 任务结果 -->
        <div v-if="task.status === 'completed' && task.result" class="task-result">
          <el-alert
            :title="task.result"
            type="success"
            :closable="false"
            show-icon
          />
        </div>
      </div>
    </div>

    <el-empty v-else description="暂无导入任务" :image-size="80" />
  </div>
</template>

<script setup lang="ts">
import { Refresh, Delete, VideoPlay, VideoPause, Close } from '@element-plus/icons-vue'

interface ImportTask {
  id: string
  type: 'wps' | 'agent' | 'api' | 'reimport'
  name: string
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  progress: number
  currentStep: string
  startTime: Date
  endTime?: Date
  error?: string
  result?: string
}

interface Props {
  tasks: ImportTask[]
}

defineProps<Props>()
const emit = defineEmits(['start', 'pause', 'cancel', 'refresh', 'clear-all'])

const getTaskIcon = (type: string) => {
  const iconMap: Record<string, string> = {
    'wps': '📄',
    'agent': '🤖',
    'api': '🔗',
    'reimport': '🔄'
  }
  return iconMap[type] || '📋'
}

const getStatusType = (status: string) => {
  const typeMap: Record<string, any> = {
    'pending': 'info',
    'running': 'primary',
    'paused': 'warning',
    'completed': 'success',
    'failed': 'danger',
    'cancelled': 'info'
  }
  return typeMap[status] || 'info'
}

const getStatusText = (status: string) => {
  const textMap: Record<string, string> = {
    'pending': '等待中',
    'running': '执行中',
    'paused': '已暂停',
    'completed': '已完成',
    'failed': '失败',
    'cancelled': '已取消'
  }
  return textMap[status] || '未知'
}

const formatTime = (date: Date) => {
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}天前`
  if (hours > 0) return `${hours}小时前`
  if (minutes > 0) return `${minutes}分钟前`
  return '刚刚'
}

const handleClearAll = () => {
  console.log('[TaskManager] 请求清空所有任务')
  emit('clear-all')
}
</script>

<style scoped>
.task-manager {
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
  padding-bottom: 16px;
  border-bottom: 1px solid #e4e7ed;
}

.panel-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.tasks-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.task-item {
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  padding: 12px;
  transition: all 0.3s;
}

.task-item:hover {
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
}

.task-pending {
  background-color: #f5f7fa;
}

.task-running {
  border-color: var(--primary-color);
  background-color: rgba(102, 126, 234, 0.08);
}

.task-paused {
  border-color: #e6a23c;
  background-color: #fdf6ec;
}

.task-completed {
  border-color: #67c23a;
  background-color: rgba(103, 194, 58, 0.08);
}

.task-failed {
  border-color: #f56c6c;
  background-color: #fef0f0;
}

.task-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.task-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.task-icon {
  font-size: 24px;
}

.task-details {
  min-width: 0;
}

.task-name {
  font-size: 14px;
  font-weight: 500;
  color: #303133;
  margin-bottom: 4px;
}

.task-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.task-time {
  font-size: 12px;
  color: #909399;
}

.task-actions {
  display: flex;
  gap: 4px;
}

.task-progress {
  margin-top: 8px;
}

.progress-info {
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
  font-size: 12px;
  color: #909399;
}

.task-error,
.task-result {
  margin-top: 8px;
}
</style>
