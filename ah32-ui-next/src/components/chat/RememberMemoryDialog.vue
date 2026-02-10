<template>
  <el-dialog
    v-model="visibleLocal"
    title="保存为记忆"
    width="520px"
    :close-on-click-modal="false"
    @close="handleCancel"
  >
    <div class="desc">
      已为你生成可保存的记忆项（默认勾选推荐项）。如不需要自动确认，请及时取消。
    </div>

    <el-checkbox-group v-model="selectedLocal" class="patches" @change="resetCountdown">
      <div v-for="p in patches" :key="p.patch_id" class="patch">
        <el-checkbox :label="p.patch_id">
          <div class="patch-title">
            <span>{{ p.title }}</span>
            <el-tag v-if="p.recommended" size="small" type="success" effect="plain">推荐</el-tag>
          </div>
          <div class="patch-preview" v-if="p.preview">{{ p.preview }}</div>
          <div class="patch-reason" v-if="p.reason">{{ p.reason }}</div>
        </el-checkbox>
      </div>
    </el-checkbox-group>

    <template #footer>
      <div class="footer">
        <div class="countdown">自动确认：{{ countdown }}s</div>
        <div class="actions">
          <el-button @click="handleCancel">取消</el-button>
          <el-button type="primary" :disabled="selectedLocal.length === 0" @click="handleConfirm">
            确认 ({{ countdown }})
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { MemoryPatch } from '@/services/memory-api'

const props = defineProps<{
  modelValue: boolean
  patches: MemoryPatch[]
  defaultSelected: string[]
  autoConfirmSeconds?: number
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'confirm', selectedPatchIds: string[]): void
  (e: 'cancel'): void
}>()

const visibleLocal = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v)
})

const selectedLocal = ref<string[]>([])
const countdown = ref<number>(props.autoConfirmSeconds ?? 5)
let timer: number | null = null

const resetCountdown = () => {
  countdown.value = props.autoConfirmSeconds ?? 5
}

const startTimer = () => {
  stopTimer()
  timer = window.setInterval(() => {
    countdown.value -= 1
    if (countdown.value <= 0) {
      stopTimer()
      if (selectedLocal.value.length > 0) {
        emit('confirm', selectedLocal.value.slice())
      } else {
        handleCancel()
      }
    }
  }, 1000)
}

const stopTimer = () => {
  if (timer !== null) {
    window.clearInterval(timer)
    timer = null
  }
}

const initSelection = () => {
  const ids = (props.defaultSelected || []).filter(Boolean)
  selectedLocal.value = ids.length > 0 ? ids : (props.patches.map(p => p.patch_id).slice(0, 1))
  resetCountdown()
}

const handleCancel = () => {
  stopTimer()
  emit('update:modelValue', false)
  emit('cancel')
}

const handleConfirm = () => {
  stopTimer()
  emit('confirm', selectedLocal.value.slice())
}

watch(
  () => props.modelValue,
  (v) => {
    if (v) {
      initSelection()
      startTimer()
    } else {
      stopTimer()
    }
  }
)

watch(
  () => props.defaultSelected,
  () => {
    if (props.modelValue) initSelection()
  }
)

onMounted(() => {
  if (props.modelValue) {
    initSelection()
    startTimer()
  }
})

onUnmounted(() => stopTimer())
</script>

<style scoped>
.desc {
  font-size: 12px;
  color: #666;
  margin-bottom: 12px;
}

.patches {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.patch {
  padding: 10px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 10px;
}

.patch-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.patch-preview {
  font-size: 12px;
  color: #333;
  margin-top: 6px;
  white-space: pre-wrap;
}

.patch-reason {
  font-size: 12px;
  color: #888;
  margin-top: 6px;
}

.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.countdown {
  font-size: 12px;
  color: #666;
}

.actions {
  display: flex;
  gap: 8px;
}
</style>

