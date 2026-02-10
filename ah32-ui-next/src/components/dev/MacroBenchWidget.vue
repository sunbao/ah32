<template>
  <div class="macro-bench">
    <div class="macro-bench-row">
      <div class="macro-bench-title">宏基准测试(开发)</div>
      <div class="macro-bench-actions">
        <el-select v-model="runMode" size="small" style="width: 120px" :disabled="running">
          <el-option label="宏直出" value="macro" />
          <el-option label="对话驱动" value="chat" />
        </el-select>
        <el-select v-model="suiteId" size="small" style="width: 140px" :disabled="running">
          <el-option label="全部场景" value="all" />
          <el-option v-for="s in suites" :key="s.id" :label="s.name" :value="s.id" />
        </el-select>
        <el-select v-model="preset" size="small" style="width: 120px" :disabled="running">
          <el-option v-for="p in presets" :key="p.id" :label="p.name" :value="p.id" />
        </el-select>
        <el-button size="small" type="primary" :loading="running" @click="start" :disabled="running">
          运行(当前宿主)
        </el-button>
        <el-button
          v-if="runMode === 'chat'"
          size="small"
          type="primary"
          plain
          @click="resume"
          :disabled="running || !canResume"
        >
          续跑
        </el-button>
        <el-button size="small" type="default" @click="stop" :disabled="!running">
          停止
        </el-button>
      </div>
    </div>

    <div v-if="runMode === 'chat'" class="macro-bench-row">
      <div class="macro-bench-title">Run 预算(0=无限)</div>
      <div class="macro-bench-actions">
        <span class="macro-bench-label">maxHours</span>
        <el-input-number v-model="maxHours" size="small" :min="0" :step="1" :disabled="running" style="width: 110px" />
        <span class="macro-bench-label">maxTurns</span>
        <el-input-number v-model="maxTurns" size="small" :min="0" :step="10" :disabled="running" style="width: 110px" />
        <span class="macro-bench-label">maxFailures (warn)</span>
        <el-input-number v-model="maxFailures" size="small" :min="0" :step="1" :disabled="running" style="width: 110px" />
        <span class="macro-bench-label">maxCost</span>
        <el-input-number v-model="maxCost" size="small" :min="0" :step="1" :disabled="running" style="width: 110px" />
      </div>
    </div>

    <div v-if="progressText" class="macro-bench-progress">{{ progressText }}</div>

    <div v-if="lastSummary" class="macro-bench-summary">
      <div class="macro-bench-summary-line">
        宿主: {{ lastSummary.host }}；场景: {{ suiteLabel }}；共 {{ lastSummary.total }}；成功 {{ lastSummary.ok }}；失败
        {{ lastSummary.fail }}；模式: {{ lastMode === 'chat' ? '对话驱动' : '宏直出' }}
      </div>
      <div class="macro-bench-summary-line">
        0修复: {{ lastSummary.buckets['0'] }}；
        1修复: {{ lastSummary.buckets['1'] }}；
        2修复: {{ lastSummary.buckets['2'] }}；
        3修复: {{ lastSummary.buckets['3'] }}；
        4修复: {{ lastSummary.buckets['4'] }}；
        5修复: {{ lastSummary.buckets['5'] }}；
        失败: {{ lastSummary.buckets.fail }}
      </div>
      <div class="macro-bench-summary-line">
        0修复成功率: {{ Math.round(lastSummary.ok0Rate * 100) }}%；
        <template v-if="lastMode === 'chat'">
          平均对话: {{ (lastSummary as any).avgChatMs }}ms（p95 {{ (lastSummary as any).p95ChatMs }}ms）；
          平均执行(含修复): {{ (lastSummary as any).avgExecTotalMs }}ms（p95 {{ (lastSummary as any).p95ExecTotalMs }}ms）
        </template>
        <template v-else>
          平均生成: {{ (lastSummary as any).avgGenerateMs }}ms（p95 {{ (lastSummary as any).p95GenerateMs }}ms）；
          平均执行(含修复): {{ (lastSummary as any).avgExecTotalMs }}ms（p95 {{ (lastSummary as any).p95ExecTotalMs }}ms）
        </template>
      </div>
      <div v-if="lastMode === 'chat'" class="macro-bench-summary-line">
        断言通过率 {{ Math.round(((lastSummary as any).assertOkRate || 0) * 100) }}%；平均评分 {{ (lastSummary as any).avgScore }} (p95 {{ (lastSummary as any).p95Score }})
      </div>
      <div v-if="suiteId === 'all' && suiteBreakdown.length" class="macro-bench-suite-table">
        <div class="macro-bench-suite-row macro-bench-suite-head">
          <div class="col name">场景</div>
          <div class="col ok0">0修复%</div>
          <div class="col ok">成功</div>
          <div class="col fail">失败</div>
          <div class="col gen">{{ lastMode === 'chat' ? '对话均值' : '生成均值' }}</div>
          <div class="col exec">执行均值</div>
        </div>
        <div v-for="row in suiteBreakdown" :key="row.id" class="macro-bench-suite-row">
          <div class="col name">{{ row.name }}</div>
          <div class="col ok0">{{ Math.round(row.summary.ok0Rate * 100) }}%</div>
          <div class="col ok">{{ row.summary.ok }}/{{ row.summary.total }}</div>
          <div class="col fail">{{ row.summary.fail }}</div>
          <div class="col gen">
            {{ lastMode === 'chat' ? row.summary.avgChatMs : row.summary.avgGenerateMs }}ms
          </div>
          <div class="col exec">{{ row.summary.avgExecTotalMs }}ms</div>
        </div>
      </div>
      <div class="macro-bench-actions">
        <el-button size="small" type="default" @click="copyJson">复制结果JSON</el-button>
        <el-button size="small" type="default" @click="clear">清空</el-button>
      </div>

      <div v-if="lastMode === 'chat' && (lastRun as any)?.results?.length" class="macro-bench-turns">
        <div class="macro-bench-turns-title">Turn 明细（最近 {{ Math.min(20, (lastRun as any).results.length) }} 条）</div>
        <div
          v-for="r in ((lastRun as any).results || []).slice(-20)"
          :key="String(r.macroSessionId || r.assistantMessageId || Math.random())"
          class="macro-bench-turn"
        >
          <div class="macro-bench-turn-head">
            <span class="k">{{ r.story?.suiteId }}</span>
            <span class="k">{{ r.story?.name }}</span>
            <span class="k">{{ r.turn?.name || r.turn?.id }}</span>
            <span class="k" :class="{ ok: !!r.ok, bad: !r.ok }">{{ r.ok ? 'OK' : 'FAIL' }}</span>
            <span class="k">score {{ r.score }}</span>
            <span class="k">chat {{ r.chatMs }}ms</span>
            <span class="k">exec {{ r.execTotalMs }}ms</span>
            <span class="k">repairs {{ r.repairsUsed }}</span>
          </div>
          <div v-if="r.assistantPreview" class="macro-bench-turn-sub">chat: {{ r.assistantPreview }}</div>
          <div v-if="r.assertFailures && r.assertFailures.length" class="macro-bench-turn-sub bad">
            asserts:
            <span v-for="(f, idx) in r.assertFailures.slice(0, 4)" :key="idx" class="fail">
              {{ f.type }} ({{ f.points }}): {{ f.message }}
            </span>
            <span v-if="r.assertFailures.length > 4" class="fail">…(+{{ r.assertFailures.length - 4 }})</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { loadBenchResults, runMacroBenchCurrentHost, type MacroBenchRun, type MacroBenchSummary, getSuiteName } from '@/dev/macro-bench'
import { MACRO_BENCH_PRESETS, MACRO_BENCH_SUITES, type MacroBenchHost, type MacroBenchPreset, type MacroBenchSuiteId } from '@/dev/macro-bench-suites'
import { loadChatBenchResults, runChatBenchCurrentHost, type ChatBenchRun, type ChatBenchSummary } from '@/dev/macro-bench-chat'
import { wpsBridge } from '@/services/wps-bridge'
import { useChatStore } from '@/stores/chat'

type RunMode = 'macro' | 'chat'

const running = ref(false)
const stopped = ref(false)
const progress = ref<any>(null)
const lastSummary = ref<any>(null)
const lastJson = ref<string>('')
const lastRun = ref<MacroBenchRun | ChatBenchRun | null>(null)
const lastMode = ref<RunMode>('macro')

const suites = MACRO_BENCH_SUITES
const presets = MACRO_BENCH_PRESETS
const suiteId = ref<MacroBenchSuiteId | 'all'>('all')
const preset = ref<MacroBenchPreset>('standard')
const runMode = ref<RunMode>('macro')

// Chat-run budgets (0 disables the cap).
const maxHours = ref<number>(0)
const maxTurns = ref<number>(0)
const maxFailures = ref<number>(0)
// NOTE: not enforced yet (we don't have reliable token/cost usage in SSE).
const maxCost = ref<number>(0)

const chatStore = useChatStore()
const canResume = computed(() => {
  if (runMode.value !== 'chat') return false
  try {
    const host = (wpsBridge.getHostApp() || 'wps') as MacroBenchHost
    const loaded = loadChatBenchResults({ host, suiteId: suiteId.value, preset: preset.value })
    const run = loaded?.run
    if (!run) return false
    const nextIdx = Number(run.nextIdx || 0) || 0
    const total = Number(run.totalPlanned || 0) || 0
    return total > 0 && nextIdx < total
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e)
    return false
  }
})

const progressText = computed(() => {
  if (!running.value || !progress.value) return ''
  const suite = getSuiteName(progress.value.suiteId)
  if (lastMode.value === 'chat') {
    return `正在运行: ${progress.value.idx}/${progress.value.total} - ${progress.value.storyName} / ${progress.value.turnName} [${suite}] (${progress.value.host})`
  }
  return `正在运行: ${progress.value.idx}/${progress.value.total} - ${progress.value.caseName} [${suite}] (${progress.value.host})`
})

const suiteLabel = computed(() => (suiteId.value === 'all' ? '全部场景' : getSuiteName(suiteId.value)))

const suiteBreakdown = computed(() => {
  if (!lastRun.value?.summaryBySuite) return []
  const rows = Object.keys(lastRun.value.summaryBySuite).map(id => {
    const sid = id as MacroBenchSuiteId
    return { id: sid, name: getSuiteName(sid), summary: lastRun.value!.summaryBySuite[id] }
  })
  rows.sort((a, b) => a.id.localeCompare(b.id))
  return rows
})

const start = async () => {
  if (running.value) return
  running.value = true
  stopped.value = false
  progress.value = null
  lastSummary.value = null
  lastJson.value = ''
  lastRun.value = null
  lastMode.value = runMode.value

  // Let current macro execution abort quickly.
  try { (await import('@/services/macro-cancel')).macroCancel.reset() } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e) }

  try {
    if (runMode.value === 'chat') {
      const out = await runChatBenchCurrentHost(chatStore as any, {
        onProgress: (p) => { progress.value = p },
        shouldStop: () => stopped.value,
        suiteId: suiteId.value,
        preset: preset.value,
        maxHours: maxHours.value,
        maxTurns: maxTurns.value,
        maxFailures: maxFailures.value,
        maxCost: maxCost.value
      })
      lastSummary.value = out.summary as ChatBenchSummary
      lastRun.value = out as ChatBenchRun
      lastJson.value = JSON.stringify(out, null, 2)
      if (!stopped.value) ElMessage.success(`对话驱动跑测完成：成功 ${out.summary.ok}/${out.summary.total}`)
      else ElMessage.info('对话驱动跑测已停止')
    } else {
      const out = await runMacroBenchCurrentHost({
        onProgress: (p) => { progress.value = p },
        shouldStop: () => stopped.value,
        suiteId: suiteId.value,
        preset: preset.value
      })
      lastSummary.value = out.summary as MacroBenchSummary
      lastRun.value = out as MacroBenchRun
      lastJson.value = JSON.stringify(out, null, 2)
      if (!stopped.value) ElMessage.success(`宏基准测试完成：成功 ${out.summary.ok}/${out.summary.total}`)
      else ElMessage.info('宏基准测试已停止')
    }
  } catch (e: any) {
    ElMessage.error(`${runMode.value === 'chat' ? '对话驱动跑测' : '宏基准测试'}失败：${String(e?.message || e)}`)
  } finally {
    running.value = false
    // Best-effort: show persisted results from last run.
    try {
      const host = (progress.value?.host || ((wpsBridge.getHostApp() || 'wps') as MacroBenchHost)) as MacroBenchHost
      if (lastMode.value === 'chat') {
        const loaded = loadChatBenchResults({ host, suiteId: suiteId.value, preset: preset.value })
        if (loaded?.run) {
          lastRun.value = loaded.run
          lastSummary.value = loaded.run.summary
          if (!lastJson.value) lastJson.value = JSON.stringify(loaded.run, null, 2)
        }
      } else {
        const loaded = loadBenchResults({ host, suiteId: suiteId.value, preset: preset.value })
        if (loaded?.run) {
          lastRun.value = loaded.run
          lastSummary.value = loaded.run.summary
          if (!lastJson.value) lastJson.value = JSON.stringify(loaded.run, null, 2)
        }
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e)
    }
  }
}

const resume = async () => {
  if (running.value) return
  if (runMode.value !== 'chat') return

  const host = (wpsBridge.getHostApp() || 'wps') as MacroBenchHost
  const loaded = loadChatBenchResults({ host, suiteId: suiteId.value, preset: preset.value })
  const prev = loaded?.run
  if (!prev) return

  running.value = true
  stopped.value = false
  progress.value = null
  lastSummary.value = null
  lastJson.value = ''
  lastRun.value = null
  lastMode.value = 'chat'

  try {
    const out = await runChatBenchCurrentHost(chatStore as any, {
      onProgress: (p) => { progress.value = p },
      shouldStop: () => stopped.value,
      suiteId: suiteId.value,
      preset: preset.value,
      resumeFrom: prev,
      maxHours: maxHours.value,
      maxTurns: maxTurns.value,
      maxFailures: maxFailures.value,
      maxCost: maxCost.value
    })
    lastSummary.value = out.summary as ChatBenchSummary
    lastRun.value = out as ChatBenchRun
    lastJson.value = JSON.stringify(out, null, 2)
    if (!stopped.value) ElMessage.success(`续跑完成：成功 ${out.summary.ok}/${out.summary.total}`)
    else ElMessage.info('续跑已停止')
  } catch (e: any) {
    ElMessage.error(`续跑失败：${String(e?.message || e)}`)
  } finally {
    running.value = false
    try {
      const host2 = (progress.value?.host || ((wpsBridge.getHostApp() || 'wps') as MacroBenchHost)) as MacroBenchHost
      const loaded2 = loadChatBenchResults({ host: host2, suiteId: suiteId.value, preset: preset.value })
      if (loaded2?.run) {
        lastRun.value = loaded2.run
        lastSummary.value = loaded2.run.summary
        if (!lastJson.value) lastJson.value = JSON.stringify(loaded2.run, null, 2)
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e)
    }
  }
}

const stop = () => {
  stopped.value = true
  try { void import('@/services/macro-cancel').then(m => m.macroCancel.cancel()).catch((e) => { ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e) }) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e) }
  try { (chatStore as any).cancelCurrentRequest?.() } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e) }
}

const copyJson = async () => {
  if (!lastJson.value) return
  try {
    await navigator.clipboard.writeText(lastJson.value)
    ElMessage.success('已复制结果JSON')
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e)
    try {
      // Fallback: old WPS WebView might not support clipboard.
      ;(window as any).__BID_BENCH_JSON = lastJson.value
      ElMessage.warning('复制失败：已写入 window.__BID_BENCH_JSON（可在控制台复制）')
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e)
      ElMessage.error('复制失败')
    }
  }
}

const clear = () => {
  lastSummary.value = null
  lastJson.value = ''
  progress.value = null
  lastRun.value = null
  ElMessage.success('已清空(仅本次显示)')
}
</script>

<style scoped>
.macro-bench {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 6px;
}

.macro-bench-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.macro-bench-title {
  font-size: 12px;
  color: #6b7280;
}

.macro-bench-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.macro-bench-label {
  font-size: 12px;
  color: #6b7280;
  align-self: center;
}

.macro-bench-progress {
  font-size: 12px;
  color: #111827;
}

.macro-bench-summary {
  font-size: 12px;
  color: #111827;
  border-top: 1px solid rgba(0, 0, 0, 0.06);
  padding-top: 8px;
}

.macro-bench-summary-line {
  line-height: 1.4;
  margin: 2px 0;
}

.macro-bench-suite-table {
  margin-top: 6px;
  border-top: 1px dashed rgba(0, 0, 0, 0.08);
  padding-top: 6px;
}

.macro-bench-suite-row {
  display: grid;
  grid-template-columns: 1.5fr 0.7fr 0.7fr 0.6fr 0.9fr 0.9fr;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  line-height: 1.4;
  padding: 2px 0;
}

.macro-bench-suite-head {
  color: #6b7280;
}

.macro-bench-suite-row .col {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.macro-bench-turns {
  margin-top: 8px;
  border-top: 1px dashed rgba(0, 0, 0, 0.08);
  padding-top: 8px;
}

.macro-bench-turns-title {
  font-size: 12px;
  color: #6b7280;
  margin-bottom: 6px;
}

.macro-bench-turn {
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 8px;
  padding: 6px 8px;
  margin: 6px 0;
}

.macro-bench-turn-head {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  font-size: 12px;
}

.macro-bench-turn-head .k {
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.04);
  color: #111827;
}

.macro-bench-turn-head .k.ok {
  background: rgba(16, 185, 129, 0.14);
  color: #065f46;
}

.macro-bench-turn-head .k.bad {
  background: rgba(239, 68, 68, 0.14);
  color: #7f1d1d;
}

.macro-bench-turn-sub {
  margin-top: 4px;
  font-size: 12px;
  color: #374151;
  line-height: 1.4;
}

.macro-bench-turn-sub.bad {
  color: #7f1d1d;
}

.macro-bench-turn-sub .fail {
  margin-left: 6px;
  white-space: nowrap;
}
</style>
