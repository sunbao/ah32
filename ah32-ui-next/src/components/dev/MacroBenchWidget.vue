<template>
  <div class="macro-bench">
    <div class="macro-bench-hero">
      <div class="macro-bench-hero-copy">
        <div class="macro-bench-eyebrow">开发工具</div>
        <div class="macro-bench-heading">宏基准测试</div>
        <div class="macro-bench-description">先选模式和场景，再运行。默认先看结论，需要排查时再展开技术细节。</div>
        <div class="macro-bench-shortcuts">快捷键：`Ctrl+Enter` 开始，`Ctrl+Shift+Enter` 继续跑，`Esc` 停止，`Ctrl+Alt+M/L/P` 聚焦模式/场景/预设，`Ctrl+Alt+R/K/E/T` 切到 Writer/生命周期/ET/PPT 烟测。</div>
        <div v-if="autoBenchDebugText" class="macro-bench-debug">{{ autoBenchDebugText }}</div>
      </div>
      <div class="macro-bench-state" :class="benchStateClass">{{ benchStateLabel }}</div>
    </div>

    <button
      v-if="running"
      type="button"
      class="macro-bench-stop-strip"
      :class="{ pending: stopped }"
      :disabled="stopped"
      @click="stop"
    >
      <span class="macro-bench-stop-copy">
        <span class="macro-bench-stop-title">{{ stopped ? '正在停止' : '正在跑测' }}</span>
        <span class="macro-bench-stop-text">
          {{ stopped ? '已发送停止指令，正在尽快中断当前步骤。' : '如需立刻中断，直接点这整条红色区域，不用去找右侧小按钮。' }}
        </span>
      </span>
      <span class="macro-bench-stop-cta">{{ stopped ? '停止中...' : '点击这里立即停止' }}</span>
    </button>

    <div class="macro-bench-panel">
      <div class="macro-bench-row">
        <div class="macro-bench-title">运行设置</div>
        <div class="macro-bench-actions">
          <!-- Use native <select> in WPS taskpane: ElementPlus poppers/teleport are flaky in some WebViews. -->
          <select ref="runModeSelectRef" v-model="runMode" class="macro-bench-native-select" :disabled="running">
            <option value="macro">宏直跑</option>
            <option value="chat">对话驱动</option>
          </select>
          <select ref="suiteSelectRef" v-model="suiteId" class="macro-bench-native-select macro-bench-native-select-wide" :disabled="running">
            <option value="all">全部场景</option>
            <option v-for="s in suites" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
          <select ref="presetSelectRef" v-model="preset" class="macro-bench-native-select" :disabled="running">
            <option v-for="p in presets" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <el-button size="small" type="primary" :loading="running" @click="start" :disabled="running">
            开始运行
          </el-button>
          <el-button
            v-if="runMode === 'chat'"
            size="small"
            type="primary"
            plain
            @click="resume"
            :disabled="running || !canResume"
          >
            继续跑
          </el-button>
          <el-button
            size="small"
            type="default"
            @click="stop"
            :disabled="!running || stopped"
            :loading="running && stopped"
          >
            {{ stopped ? '停止中' : '停止' }}
          </el-button>
          <el-button size="small" type="default" plain @click="restore" :disabled="running">
            恢复上次结果
          </el-button>
        </div>
      </div>

      <div v-if="runMode === 'chat'" class="macro-bench-row macro-bench-budget-row">
        <div class="macro-bench-title">对话预算（0 = 不限制）</div>
        <div class="macro-bench-actions">
          <span class="macro-bench-label">最长小时</span>
          <el-input-number v-model="maxHours" size="small" :min="0" :step="1" :disabled="running" style="width: 110px" />
          <span class="macro-bench-label">最多轮次</span>
          <el-input-number v-model="maxTurns" size="small" :min="0" :step="10" :disabled="running" style="width: 110px" />
          <span class="macro-bench-label">失败预警</span>
          <el-input-number v-model="maxFailures" size="small" :min="0" :step="1" :disabled="running" style="width: 110px" />
          <span class="macro-bench-label">成本上限</span>
          <el-input-number v-model="maxCost" size="small" :min="0" :step="1" :disabled="running" style="width: 110px" />
        </div>
      </div>
    </div>

    <div v-if="progressText" class="macro-bench-progress">{{ progressText }}</div>

    <div v-if="lastError" class="macro-bench-error">
      <div class="macro-bench-error-copy">
        <div class="macro-bench-error-title">这次跑测有报错</div>
        <div class="macro-bench-error-text">{{ lastError }}</div>
      </div>
      <div class="macro-bench-error-actions">
        <el-button size="small" type="default" plain @click="copyError">复制错误</el-button>
      </div>
    </div>

    <div v-if="lastSummary" class="macro-bench-summary">
      <div class="macro-bench-overview">
        <div v-for="card in overviewCards" :key="card.label" class="macro-bench-overview-card" :class="card.tone">
          <div class="macro-bench-overview-label">{{ card.label }}</div>
          <div class="macro-bench-overview-value">{{ card.value }}</div>
          <div v-if="card.hint" class="macro-bench-overview-hint">{{ card.hint }}</div>
        </div>
      </div>

      <div class="macro-bench-brief">
        <div class="macro-bench-brief-title">本次结论</div>
        <div class="macro-bench-brief-line">{{ summaryHeadline }}</div>
        <div class="macro-bench-brief-line">{{ summaryDetail }}</div>
        <div v-if="chatQualityLine" class="macro-bench-brief-line">{{ chatQualityLine }}</div>
      </div>

      <div v-if="suiteId === 'all' && suiteBreakdown.length" class="macro-bench-suite-table">
        <div class="macro-bench-section-title">各场景结果</div>
        <div class="macro-bench-suite-row macro-bench-suite-head">
          <div class="col name">场景</div>
          <div class="col ok0">0修复率</div>
          <div class="col ok">成功</div>
          <div class="col fail">失败</div>
          <div class="col gen">{{ lastMode === 'chat' ? '对话均耗时' : '生成均耗时' }}</div>
          <div class="col exec">执行均耗时</div>
        </div>
        <div v-for="row in suiteBreakdown" :key="row.id" class="macro-bench-suite-row">
          <div class="col name">{{ row.name }}</div>
          <div class="col ok0">{{ Math.round(row.summary.ok0Rate * 100) }}%</div>
          <div class="col ok">{{ row.summary.ok }}/{{ row.summary.total }}</div>
          <div class="col fail">{{ row.summary.fail }}</div>
          <div class="col gen">{{ lastMode === 'chat' ? row.summary.avgChatMs : row.summary.avgGenerateMs }}ms</div>
          <div class="col exec">{{ row.summary.avgExecTotalMs }}ms</div>
        </div>
      </div>

      <div v-if="failedTurns.length" class="macro-bench-turns">
        <div class="macro-bench-section-title">失败明细</div>
        <div class="macro-bench-turns-title">只展示最近 {{ failedTurns.length }} 条失败记录，便于先排查卡点。</div>
        <div
          v-for="r in failedTurns"
          :key="String(r.macroSessionId || r.assistantMessageId || Math.random())"
          class="macro-bench-turn"
        >
          <div class="macro-bench-turn-head">
            <span class="k">{{ r.story?.suiteId }}</span>
            <span class="k">{{ r.story?.name }}</span>
            <span class="k">{{ r.turn?.name || r.turn?.id }}</span>
            <span class="k bad">失败</span>
          </div>
          <div class="macro-bench-turn-sub">
            对话耗时 {{ r.chatMs || 0 }}ms；执行耗时 {{ r.execTotalMs || 0 }}ms；修复次数 {{ r.repairsUsed || 0 }}
          </div>
          <div v-if="r.message" class="macro-bench-turn-sub bad">系统提示：{{ r.message }}</div>
          <div v-if="r.assistantPreview" class="macro-bench-turn-sub">模型返回：{{ r.assistantPreview }}</div>
          <div v-if="r.assertFailures && r.assertFailures.length" class="macro-bench-turn-sub bad">
            断言失败：
            <span v-for="(f, idx) in r.assertFailures.slice(0, 4)" :key="idx" class="fail">
              {{ f.type }}（{{ f.points }}分）：{{ f.message }}
            </span>
            <span v-if="r.assertFailures.length > 4" class="fail">等 {{ r.assertFailures.length }} 条</span>
          </div>
        </div>
      </div>

      <details class="macro-bench-tech">
        <summary>展开技术细节</summary>
        <div class="macro-bench-tech-actions">
          <el-button size="small" type="default" @click="copyJson">复制结果 JSON</el-button>
          <el-button size="small" type="default" @click="clear">清空显示</el-button>
        </div>
        <pre v-if="lastJson" class="macro-bench-json">{{ lastJson }}</pre>
      </details>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { loadBenchResults, runMacroBenchCurrentHost, type MacroBenchRun, type MacroBenchSummary, getSuiteName } from '@/dev/macro-bench'
import { MACRO_BENCH_PRESETS, MACRO_BENCH_SUITES, type MacroBenchHost, type MacroBenchPreset, type MacroBenchSuiteId } from '@/dev/macro-bench-suites'
import { loadChatBenchResults, runChatBenchCurrentHost, type ChatBenchRun, type ChatBenchSummary } from '@/dev/macro-bench-chat'
import { wpsBridge } from '@/services/wps-bridge'
import { useChatStore } from '@/stores/chat'
import { hasConsumedDevBenchAuto, markDevBenchAutoConsumed, readDevBenchAutoConfig, type DevBenchAutoConfig } from '@/utils/dev-bench-auto'
import { parseJsonRelaxed } from '@/utils/relaxed-json'

type RunMode = 'macro' | 'chat'

const TOAST_Z_INDEX = 10002
const toast = (type: 'success' | 'warning' | 'info' | 'error', message: string) => {
  try {
    ElMessage({ type, message, showClose: true, duration: type === 'error' ? 6000 : 3000, zIndex: TOAST_Z_INDEX })
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e)
  }
}

const running = ref(false)
const stopped = ref(false)
const macroAbort = ref<AbortController | null>(null)
const progress = ref<any>(null)
const lastSummary = ref<any>(null)
const lastJson = ref<string>('')
const lastRun = ref<MacroBenchRun | ChatBenchRun | null>(null)
const lastMode = ref<RunMode>('macro')
const lastError = ref<string>('')
const latestDetailStage = ref<any>(null)
const autoBenchDebugText = ref<string>('')
let autoBenchPollTimer: number | null = null
let benchUnmounting = false

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

type MacroBenchWidgetState = {
  runMode?: RunMode
  suiteId?: MacroBenchSuiteId | 'all'
  preset?: MacroBenchPreset
  maxHours?: number
  maxTurns?: number
  maxFailures?: number
  maxCost?: number
  lastMode?: RunMode
  lastError?: string
}

const WIDGET_STATE_KEY = 'ah32_macro_bench_widget_state_v1'
const AUTO_RESUME_HINT_KEY = 'ah32_dev_macro_bench_resume_hint_v1'

const readAutoResumeHint = (): null | { runMode: RunMode; suiteId: MacroBenchSuiteId | 'all'; preset: MacroBenchPreset } => {
  try {
    const raw = localStorage.getItem(AUTO_RESUME_HINT_KEY)
    if (!raw) return null
    const parsed: any = JSON.parse(raw)
    const runModeRaw = String(parsed?.runMode || '').trim()
    const suiteIdRaw = String(parsed?.suiteId || '').trim()
    const presetRaw = String(parsed?.preset || '').trim()
    if (!isValidRunMode(runModeRaw)) return null
    if (!suiteIdRaw || !isValidSuiteId(suiteIdRaw)) return null
    if (!presetRaw || !isValidPreset(presetRaw)) return null
    return {
      runMode: runModeRaw as RunMode,
      suiteId: suiteIdRaw as MacroBenchSuiteId | 'all',
      preset: presetRaw as MacroBenchPreset,
    }
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e)
    return null
  }
}

const writeAutoResumeHint = () => {
  try {
    if (runMode.value !== 'chat') return
    localStorage.setItem(
      AUTO_RESUME_HINT_KEY,
      JSON.stringify({
        runMode: runMode.value,
        suiteId: suiteId.value,
        preset: preset.value,
        savedAt: new Date().toISOString(),
      })
    )
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e)
  }
}

const clearAutoResumeHint = () => {
  try {
    localStorage.removeItem(AUTO_RESUME_HINT_KEY)
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e)
  }
}

const safeHost = (): MacroBenchHost => {
  try {
    const raw = String(wpsBridge.getHostApp() || 'wps').toLowerCase()
    if (raw === 'et' || raw === 'wpp' || raw === 'wps') return raw as MacroBenchHost
    if (raw === 'writer') return 'wps'
    return 'wps'
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e)
    return 'wps'
  }
}

const parseIsoMs = (v: any): number => {
  const ms = Date.parse(String(v || ''))
  return Number.isFinite(ms) ? ms : 0
}

const isValidSuiteId = (v: any): v is MacroBenchSuiteId | 'all' => {
  if (v === 'all') return true
  return MACRO_BENCH_SUITES.some(s => s.id === v)
}

const isValidPreset = (v: any): v is MacroBenchPreset => {
  return MACRO_BENCH_PRESETS.some(p => p.id === v)
}

const isValidRunMode = (v: any): v is RunMode => v === 'macro' || v === 'chat'

const persistWidgetState = () => {
  try {
    const state: MacroBenchWidgetState = {
      runMode: runMode.value,
      suiteId: suiteId.value,
      preset: preset.value,
      maxHours: maxHours.value,
      maxTurns: maxTurns.value,
      maxFailures: maxFailures.value,
      maxCost: maxCost.value,
      lastMode: lastMode.value,
      lastError: lastError.value,
    }
    localStorage.setItem(WIDGET_STATE_KEY, JSON.stringify(state))
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e)
  }
}

const restoreWidgetState = () => {
  try {
    const raw = localStorage.getItem(WIDGET_STATE_KEY)
    if (!raw) return
    const parsed = parseJsonRelaxed(raw, { allowRepair: true })
    const v: any = parsed.ok ? parsed.value : null
    if (!v || typeof v !== 'object') return
    if (isValidRunMode(v?.runMode)) runMode.value = v.runMode
    if (isValidSuiteId(v?.suiteId)) suiteId.value = v.suiteId
    if (isValidPreset(v?.preset)) preset.value = v.preset
    if (typeof v?.maxHours === 'number') maxHours.value = Math.max(0, v.maxHours)
    if (typeof v?.maxTurns === 'number') maxTurns.value = Math.max(0, v.maxTurns)
    if (typeof v?.maxFailures === 'number') maxFailures.value = Math.max(0, v.maxFailures)
    if (typeof v?.maxCost === 'number') maxCost.value = Math.max(0, v.maxCost)
    if (isValidRunMode(v?.lastMode)) lastMode.value = v.lastMode
    if (typeof v?.lastError === 'string') lastError.value = v.lastError
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e)
  }
}

const loadLastRunFromStorage = (prefer?: RunMode) => {
  try {
    const host = safeHost()
    const preferMode: RunMode = prefer || runMode.value

    const macro = loadBenchResults({ host, suiteId: suiteId.value, preset: preset.value })
    const chat = loadChatBenchResults({ host, suiteId: suiteId.value, preset: preset.value })

    const chatRun = chat?.run || null
    const macroRun = macro?.run || null
    const chatAt = parseIsoMs(chat?.savedAt)
    const macroAt = parseIsoMs(macro?.updatedAt)

    const pick = (mode: RunMode) => {
      if (mode === 'chat') return chatRun
      return macroRun
    }

    let pickedMode: RunMode | null = null
    let pickedRun: any = null

    const preferred = pick(preferMode)
    if (preferred) {
      pickedMode = preferMode
      pickedRun = preferred
    } else if (chatRun && macroRun) {
      pickedMode = chatAt >= macroAt ? 'chat' : 'macro'
      pickedRun = pickedMode === 'chat' ? chatRun : macroRun
    } else if (chatRun) {
      pickedMode = 'chat'
      pickedRun = chatRun
    } else if (macroRun) {
      pickedMode = 'macro'
      pickedRun = macroRun
    }

    if (!pickedMode || !pickedRun) return
    lastMode.value = pickedMode
    runMode.value = pickedMode
    lastRun.value = pickedRun
    lastSummary.value = pickedRun.summary
    if (!lastJson.value) lastJson.value = JSON.stringify(pickedRun, null, 2)
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e)
  }
}

const restore = () => {
  restoreWidgetState()
  // Prefer the last-mode so the UI shows the same results after panel close/open.
  loadLastRunFromStorage(lastMode.value)
  persistWidgetState()
}

const chatStore = useChatStore()
const canResume = computed(() => {
  if (runMode.value !== 'chat') return false
  try {
    const host = safeHost()
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
    const phase = String((chatStore as any)?.streamPhase || '').trim()
    const elapsedMs = Number((chatStore as any)?.streamElapsedMs || 0) || 0
    const firstTokenMs = Number((chatStore as any)?.turnFirstTokenMs || 0) || 0
    const phaseText = phase ? ` · 阶段 ${phase}` : ''
    const elapsedText = elapsedMs > 0 ? ` · 已跑 ${elapsedMs}ms` : ''
    const firstTokenText = firstTokenMs > 0 ? ` · 首包 ${firstTokenMs}ms` : ''
    return `正在运行：${progress.value.idx}/${progress.value.total} - ${progress.value.storyName} / ${progress.value.turnName} [${suite}] (${progress.value.host})${phaseText}${elapsedText}${firstTokenText}`
  }
  return `正在运行：${progress.value.idx}/${progress.value.total} - ${progress.value.caseName} [${suite}] (${progress.value.host})`
})

const getChatRuntimeSnapshot = () => {
  try {
    const rawSkills = (chatStore as any)?.selectedSkills
    const selectedSkills = Array.isArray(rawSkills)
      ? rawSkills.map((x: any) => String(x?.id || x?.name || '').trim()).filter(Boolean).slice(0, 6)
      : []
    return {
      isSending: !!(chatStore as any)?.isSending,
      streamPhase: String((chatStore as any)?.streamPhase || '').trim(),
      streamElapsedMs: Number((chatStore as any)?.streamElapsedMs || 0) || 0,
      currentSessionId: String((chatStore as any)?.currentSessionId || '').trim(),
      turnFirstTokenMs: Number((chatStore as any)?.turnFirstTokenMs || 0) || 0,
      selectedSkills,
      lastTokenUsage: (chatStore as any)?.lastTokenUsage || null,
    }
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e)
    return null
  }
}

const suiteLabel = computed(() => (suiteId.value === 'all' ? '全部场景' : getSuiteName(suiteId.value)))
const runModeSelectRef = ref<HTMLSelectElement | null>(null)
const suiteSelectRef = ref<HTMLSelectElement | null>(null)
const presetSelectRef = ref<HTMLSelectElement | null>(null)

const suiteBreakdown = computed(() => {
  if (!lastRun.value?.summaryBySuite) return []
  const rows = Object.keys(lastRun.value.summaryBySuite).map(id => {
    const sid = id as MacroBenchSuiteId
    return { id: sid, name: getSuiteName(sid), summary: lastRun.value!.summaryBySuite[id] }
  })
  rows.sort((a, b) => a.id.localeCompare(b.id))
  return rows
})

const benchStateLabel = computed(() => {
  if (running.value && stopped.value) return '停止中'
  if (running.value) return '运行中'
  if (lastError.value) return '有错误'
  if (lastSummary.value) return '已完成'
  return '待开始'
})

const benchStateClass = computed(() => ({
  running: running.value,
  error: !running.value && !!lastError.value,
  done: !running.value && !lastError.value && !!lastSummary.value,
  idle: !running.value && !lastError.value && !lastSummary.value,
}))

const runModeLabel = computed(() => (lastMode.value === 'chat' ? '对话驱动' : '宏直跑'))

const overviewCards = computed(() => {
  if (!lastSummary.value) return []
  const summary: any = lastSummary.value
  const mainAvg = lastMode.value === 'chat' ? summary.avgChatMs : summary.avgGenerateMs
  return [
    { label: '总数', value: String(summary.total ?? 0), hint: `场景：${suiteLabel.value}`, tone: 'neutral' },
    { label: '成功', value: String(summary.ok ?? 0), hint: `失败：${summary.fail ?? 0}`, tone: 'good' },
    { label: '0修复率', value: `${Math.round((summary.ok0Rate || 0) * 100)}%`, hint: `0修复 ${summary.buckets?.['0'] ?? 0} 条`, tone: 'neutral' },
    {
      label: lastMode.value === 'chat' ? '平均对话耗时' : '平均生成耗时',
      value: `${mainAvg ?? 0}ms`,
      hint: `执行 ${(summary.avgExecTotalMs ?? 0)}ms`,
      tone: 'neutral'
    },
  ]
})

const summaryHeadline = computed(() => {
  if (!lastSummary.value) return ''
  return `主机 ${lastSummary.value.host} · ${suiteLabel.value} · ${runModeLabel.value}`
})

const summaryDetail = computed(() => {
  if (!lastSummary.value) return ''
  return `共 ${lastSummary.value.total} 个用例，成功 ${lastSummary.value.ok} 个，失败 ${lastSummary.value.fail} 个。`
})

const chatQualityLine = computed(() => {
  if (lastMode.value !== 'chat' || !lastSummary.value) return ''
  return `断言通过率 ${Math.round(((lastSummary.value as any).assertOkRate || 0) * 100)}%，平均评分 ${(lastSummary.value as any).avgScore ?? 0}。`
})

const failedTurns = computed(() => {
  const rows = Array.isArray((lastRun.value as any)?.results) ? (lastRun.value as any).results : []
  return rows.filter((row: any) => !row?.ok).slice(-8).reverse()
})

const buildBenchFailureDigest = (run: any) => {
  try {
    const rows = Array.isArray(run?.results) ? run.results : []
    return rows
      .filter((row: any) => !row?.ok)
      .slice(-6)
      .map((row: any) => ({
        suiteId: String(row?.story?.suiteId || row?.case?.suiteId || ''),
        name: String(row?.story?.name || row?.case?.name || row?.turn?.name || ''),
        turnId: String(row?.turn?.id || ''),
        message: String(row?.message || ''),
        assistantPreview: String(row?.assistantPreview || '').slice(0, 220),
        codeBlocks: Number(row?.codeBlocks || 0) || 0,
        assertFailures: Array.isArray(row?.assertFailures)
          ? row.assertFailures.slice(0, 4).map((f: any) => ({ type: String(f?.type || ''), message: String(f?.message || '') }))
          : [],
      }))
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e)
    return []
  }
}

const syncDevBenchStatus = (stage: string, extra?: Record<string, any>) => {
  try {
    if (safeHost() !== 'wps') return
    const payload = JSON.stringify({
      stage,
      runMode: runMode.value,
      suiteId: suiteId.value,
      preset: preset.value,
      running: running.value,
      stopped: stopped.value,
      at: new Date().toISOString(),
      ...(extra || {}),
    })
    wpsBridge.runWithWpsApi(
      'macroBenchWidget.syncDevBenchStatus',
      () => {
        const app = (window as any).Application
        const doc = app?.ActiveDocument
        const vars = doc?.Variables
        if (!vars) return false
        try {
          vars.Item('AH32_DEV_BENCH_STATUS').Value = payload
        } catch (_e) {
          vars.Add('AH32_DEV_BENCH_STATUS', payload)
        }
        return true
      },
      false
    )
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e)
  }
}


const readDevBenchRequestFromDocument = (): DevBenchAutoConfig | null => {
  try {
    if (safeHost() !== 'wps') return null
    const raw = wpsBridge.runWithWpsApi(
      'macroBenchWidget.readDevBenchRequest',
      () => {
        const app = (window as any).Application
        const vars = app?.ActiveDocument?.Variables
        if (!vars) return ''
        try {
          return String(vars.Item('AH32_DEV_BENCH_REQUEST').Value || '')
        } catch (_e) {
          return ''
        }
      },
      ''
    )
    const payload = String(raw || '').trim()
    if (!payload) return null
    const parsed = parseJsonRelaxed(payload, { allowRepair: true })
    const value: any = parsed.ok ? parsed.value : null
    if (!value || typeof value !== 'object') return null
    return {
      enabled: true,
      runMode: value.runMode === 'macro' || value.runMode === 'chat' ? value.runMode : null,
      suiteId: value.suiteId ? value.suiteId : null,
      preset: value.preset ? value.preset : null,
      action: value.action === 'resume' ? 'resume' : 'start',
      onceKey: String(value.onceKey || '').trim(),
    }
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e)
    return null
  }
}

const clearDevBenchRequestFromDocument = () => {
  try {
    if (safeHost() !== 'wps') return
    wpsBridge.runWithWpsApi(
      'macroBenchWidget.clearDevBenchRequest',
      () => {
        const app = (window as any).Application
        const vars = app?.ActiveDocument?.Variables
        if (!vars) return false
        try {
          vars.Item('AH32_DEV_BENCH_REQUEST').Value = ''
        } catch (_e) {
          // ignore
        }
        return true
      },
      false
    )
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e)
  }
}

const triggerAutoBench = (cfg: DevBenchAutoConfig, source: 'url' | 'doc_var') => {
  if (!cfg.enabled) return
  if (cfg.runMode && isValidRunMode(cfg.runMode)) runMode.value = cfg.runMode
  if (cfg.suiteId && isValidSuiteId(cfg.suiteId)) suiteId.value = cfg.suiteId
  if (cfg.preset && isValidPreset(cfg.preset)) preset.value = cfg.preset
  persistWidgetState()
  autoBenchDebugText.value = `auto cfg: enabled=1 action=${cfg.action} suite=${String(cfg.suiteId || '') || '-'} source=${source}`
  syncDevBenchStatus('mounted', {
    autoEnabled: true,
    autoAction: cfg.action,
    autoSuiteId: cfg.suiteId,
    autoSource: source,
  })
  if (cfg.onceKey && hasConsumedDevBenchAuto(cfg.onceKey)) {
    autoBenchDebugText.value = `${autoBenchDebugText.value} | skipped=consumed`
    syncDevBenchStatus('skipped_consumed', { onceKey: cfg.onceKey, autoSource: source })
    if (source === 'doc_var') clearDevBenchRequestFromDocument()
    return
  }
  if (cfg.onceKey) markDevBenchAutoConsumed(cfg.onceKey)
  if (source === 'doc_var') clearDevBenchRequestFromDocument()
  nextTick(() => {
    window.setTimeout(() => {
      if (running.value) return
      if (cfg.action === 'resume') {
        autoBenchDebugText.value = `${autoBenchDebugText.value} | trigger=resume`
        void resume()
        return
      }
      autoBenchDebugText.value = `${autoBenchDebugText.value} | trigger=start`
      void start()
    }, 1200)
  })
}

const pollAutoBenchRequest = () => {
  if (safeHost() !== 'wps') return
  if (running.value && runMode.value === 'chat') {
    const runtime = getChatRuntimeSnapshot()
    if (runtime) syncDevBenchStatus('running', { progress: progress.value || undefined, chatRuntime: runtime, detailStage: latestDetailStage.value || undefined })
  }
  if (running.value) return
  const docCfg = readDevBenchRequestFromDocument()
  if (!docCfg?.enabled) return
  triggerAutoBench(docCfg, 'doc_var')
}

const start = async () => {
  if (running.value) return
  benchUnmounting = false
  running.value = true
  stopped.value = false
  macroAbort.value = null
  progress.value = null
  lastError.value = ''
  latestDetailStage.value = null
  lastMode.value = runMode.value
  syncDevBenchStatus('starting')
  writeAutoResumeHint()

  try { (await import('@/services/macro-cancel')).macroCancel.reset() } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e) }

  try {
    if (runMode.value === 'chat') {
      const ctrl = new AbortController()
      macroAbort.value = ctrl
      const out = await runChatBenchCurrentHost(chatStore as any, {
        onProgress: (p) => {
          progress.value = p
          syncDevBenchStatus('running', { progress: p })
        },
        onStage: (p) => {
          latestDetailStage.value = p
          syncDevBenchStatus('running', { progress: progress.value || undefined, detailStage: p })
        },
        shouldStop: () => stopped.value,
        signal: ctrl.signal,
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
      syncDevBenchStatus(stopped.value ? 'stopped' : 'done', { ok: out.summary.ok, total: out.summary.total, running: false, recentFailures: buildBenchFailureDigest(out) })
      if (!stopped.value) toast('success', 'Chat bench finished: ' + out.summary.ok + '/' + out.summary.total)
      else toast('info', 'Chat bench stopped')
    } else {
      const ctrl = new AbortController()
      macroAbort.value = ctrl
      const out = await runMacroBenchCurrentHost({
        onProgress: (p) => {
          progress.value = p
          syncDevBenchStatus('running', { progress: p })
        },
        shouldStop: () => stopped.value,
        suiteId: suiteId.value,
        preset: preset.value,
        signal: ctrl.signal,
      })
      lastSummary.value = out.summary as MacroBenchSummary
      lastRun.value = out as MacroBenchRun
      lastJson.value = JSON.stringify(out, null, 2)
      syncDevBenchStatus(stopped.value ? 'stopped' : 'done', { ok: out.summary.ok, total: out.summary.total, running: false, recentFailures: buildBenchFailureDigest(out) })
      if (!stopped.value) toast('success', 'Macro bench finished: ' + out.summary.ok + '/' + out.summary.total)
      else toast('info', 'Macro bench stopped')
    }
  } catch (e: any) {
    const msgRaw = String(e?.message || e || '')
    const aborted = stopped.value || String(e?.name || '') === 'AbortError' || msgRaw.toLowerCase().includes('aborted')
    if (aborted) {
      syncDevBenchStatus('stopped', { message: msgRaw, running: false })
      toast('info', runMode.value === 'chat' ? 'Chat bench stopped' : 'Macro bench stopped')
    } else {
      const msg = (runMode.value === 'chat' ? 'Chat bench failed: ' : 'Macro bench failed: ') + msgRaw
      lastError.value = msg
      syncDevBenchStatus('error', { message: msg, running: false })
      toast('error', msg)
    }
  } finally {
    running.value = false
    macroAbort.value = null
    if (!benchUnmounting) clearAutoResumeHint()
    if (stopped.value || lastError.value) syncDevBenchStatus(stopped.value ? 'stopped' : 'error')
    try {
      const host = (progress.value?.host || safeHost()) as MacroBenchHost
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
    persistWidgetState()
  }
}

const resume = async () => {
  if (running.value) return
  if (runMode.value !== 'chat') return

  const host = safeHost()
  const loaded = loadChatBenchResults({ host, suiteId: suiteId.value, preset: preset.value })
  const prev = loaded?.run
  if (!prev) return

  running.value = true
  benchUnmounting = false
  stopped.value = false
  macroAbort.value = null
  progress.value = null
  lastError.value = ''
  latestDetailStage.value = null
  lastMode.value = 'chat'
  syncDevBenchStatus('starting_resume')
  writeAutoResumeHint()

  try {
    const ctrl = new AbortController()
    macroAbort.value = ctrl
    const out = await runChatBenchCurrentHost(chatStore as any, {
      onProgress: (p) => {
        progress.value = p
        syncDevBenchStatus('running', { progress: p, resumed: true })
      },
      onStage: (p) => {
        latestDetailStage.value = p
        syncDevBenchStatus('running', { progress: progress.value || undefined, resumed: true, detailStage: p })
      },
      shouldStop: () => stopped.value,
      signal: ctrl.signal,
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
    syncDevBenchStatus(stopped.value ? 'stopped' : 'done', { ok: out.summary.ok, total: out.summary.total, resumed: true, running: false, recentFailures: buildBenchFailureDigest(out) })
    if (!stopped.value) toast('success', 'Resume finished: ' + out.summary.ok + '/' + out.summary.total)
    else toast('info', 'Resume stopped')
  } catch (e: any) {
    const msgRaw = String(e?.message || e || '')
    const aborted = stopped.value || String(e?.name || '') === 'AbortError' || msgRaw.toLowerCase().includes('aborted')
    if (aborted) {
      syncDevBenchStatus('stopped', { message: msgRaw, resumed: true, running: false })
      toast('info', 'Resume stopped')
    } else {
      const msg = 'Resume failed: ' + msgRaw
      lastError.value = msg
      syncDevBenchStatus('error', { message: msg, resumed: true, running: false })
      toast('error', msg)
    }
  } finally {
    running.value = false
    if (!benchUnmounting) clearAutoResumeHint()
    if (stopped.value || lastError.value) syncDevBenchStatus(stopped.value ? 'stopped' : 'error', { resumed: true })
    try {
      const host2 = (progress.value?.host || safeHost()) as MacroBenchHost
      const loaded2 = loadChatBenchResults({ host: host2, suiteId: suiteId.value, preset: preset.value })
      if (loaded2?.run) {
        lastRun.value = loaded2.run
        lastSummary.value = loaded2.run.summary
        if (!lastJson.value) lastJson.value = JSON.stringify(loaded2.run, null, 2)
      }
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e)
    }
    persistWidgetState()
  }
}

const stop = () => {
  stopped.value = true
  syncDevBenchStatus('stop_requested', { running: true })
  try { macroAbort.value?.abort() } catch (e) { ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e) }
  toast('info', macroAbort.value ? 'Stop requested. Interrupting current request.' : 'Stop requested. Will stop after current step.')
  try { void import('@/services/macro-cancel').then(m => m.macroCancel.cancel()).catch((e) => { ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e) }) } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e) }
  try { (chatStore as any).cancelCurrentRequest?.() } catch (e) { (globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e) }
}

const focusBenchSelect = (target: 'mode' | 'suite' | 'preset') => {
  const el =
    target === 'mode'
      ? runModeSelectRef.value
      : target === 'suite'
        ? suiteSelectRef.value
        : presetSelectRef.value
  if (!el) return
  try {
    el.focus()
    el.click()
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e)
  }
}

const applyBenchSmokePreset = (presetId: 'writer-smoke' | 'lifecycle-smoke' | 'et-smoke' | 'ppt-smoke') => {
  runMode.value = 'chat'
  preset.value = 'standard'
  if (presetId === 'writer-smoke') suiteId.value = 'system-plan-repair'
  else if (presetId === 'lifecycle-smoke') suiteId.value = 'system-block-lifecycle'
  else if (presetId === 'et-smoke') suiteId.value = 'et-analyzer'
  else if (presetId === 'ppt-smoke') suiteId.value = 'ppt-creator'
  persistWidgetState()
}

const handleBenchHotkeys = (event: KeyboardEvent) => {
  const key = String(event.key || '')
  if (event.ctrlKey && event.altKey) {
    const lowered = key.toLowerCase()
    if (lowered === '1' || lowered === 'r') {
      event.preventDefault()
      event.stopPropagation()
      applyBenchSmokePreset('writer-smoke')
      return
    }
    if (lowered === '2' || lowered === 'k') {
      event.preventDefault()
      event.stopPropagation()
      applyBenchSmokePreset('lifecycle-smoke')
      return
    }
    if (lowered === '3' || lowered === 'e') {
      event.preventDefault()
      event.stopPropagation()
      applyBenchSmokePreset('et-smoke')
      return
    }
    if (lowered === '4' || lowered === 't') {
      event.preventDefault()
      event.stopPropagation()
      applyBenchSmokePreset('ppt-smoke')
      return
    }
    if (lowered === 'm') {
      event.preventDefault()
      event.stopPropagation()
      focusBenchSelect('mode')
      return
    }
    if (lowered === 'l') {
      event.preventDefault()
      event.stopPropagation()
      focusBenchSelect('suite')
      return
    }
    if (lowered === 'p') {
      event.preventDefault()
      event.stopPropagation()
      focusBenchSelect('preset')
      return
    }
  }
  if (key === 'Escape') {
    if (!running.value || stopped.value) return
    event.preventDefault()
    event.stopPropagation()
    stop()
    return
  }
  if (!(event.ctrlKey && key === 'Enter')) return
  event.preventDefault()
  event.stopPropagation()
  if (event.shiftKey) {
    if (runMode.value === 'chat' && !running.value && canResume.value) void resume()
    return
  }
  if (!running.value) void start()
}

const copyError = async () => {
  if (!lastError.value) return
  try {
    await navigator.clipboard.writeText(String(lastError.value || ''))
    toast('success', '已复制错误信息')
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e)
    try {
      ;(window as any).__BID_BENCH_LAST_ERROR = String(lastError.value || '')
      toast('warning', '复制失败：已写入 window.__BID_BENCH_LAST_ERROR，可在控制台复制')
    } catch (e2) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e2)
      toast('error', '复制失败')
    }
  }
}

const copyJson = async () => {
  if (!lastJson.value) return
  try {
    await navigator.clipboard.writeText(lastJson.value)
    toast('success', '已复制结果 JSON')
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e)
    try {
      // Fallback: old WPS WebView might not support clipboard.
      ;(window as any).__BID_BENCH_JSON = lastJson.value
      toast('warning', '复制失败：已写入 window.__BID_BENCH_JSON，可在控制台复制')
    } catch (e) {
      ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e)
      toast('error', '复制失败')
    }
  }
}

const clear = () => {
  lastSummary.value = null
  lastJson.value = ''
  progress.value = null
  lastRun.value = null
  lastError.value = ''
  toast('success', '已清空当前显示，不影响已保存结果')
  persistWidgetState()
}

watch([runMode, suiteId, preset, maxHours, maxTurns, maxFailures, maxCost], () => {
  persistWidgetState()
})

onMounted(() => {
  benchUnmounting = false
  restore()
  const resumeHint = readAutoResumeHint()
  if (resumeHint) {
    runMode.value = resumeHint.runMode
    suiteId.value = resumeHint.suiteId
    preset.value = resumeHint.preset
    persistWidgetState()
  }
  try { document.addEventListener('keydown', handleBenchHotkeys, true) } catch (e) { ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e) }
  const urlCfg = readDevBenchAutoConfig()
  const docCfg = !urlCfg.enabled ? readDevBenchRequestFromDocument() : null
  const finalCfg = docCfg && docCfg.enabled ? docCfg : urlCfg
  autoBenchDebugText.value = `auto cfg: enabled=${finalCfg.enabled ? '1' : '0'} action=${finalCfg.action} suite=${String(finalCfg.suiteId || '') || '-'}`
  syncDevBenchStatus('mounted', {
    autoEnabled: finalCfg.enabled,
    autoAction: finalCfg.action,
    autoSuiteId: finalCfg.suiteId,
    autoSource: docCfg ? 'doc_var' : 'url',
  })
  const shouldAutoResume = !!(resumeHint && runMode.value === 'chat' && canResume.value)
  if (shouldAutoResume) {
    autoBenchDebugText.value = `${autoBenchDebugText.value} | trigger=auto_resume`
    nextTick(() => {
      window.setTimeout(() => {
        if (!running.value && canResume.value) void resume()
      }, 1200)
    })
  } else if (resumeHint) {
    clearAutoResumeHint()
  }
  if (!shouldAutoResume && finalCfg.enabled) triggerAutoBench(finalCfg, docCfg?.enabled ? 'doc_var' : 'url')
  try {
    autoBenchPollTimer = window.setInterval(() => {
      pollAutoBenchRequest()
    }, 1500)
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e)
  }
})

onBeforeUnmount(() => {
  // Avoid leaving long-running bench promises updating UI after the widget is gone.
  benchUnmounting = true
  try { if (running.value) writeAutoResumeHint() } catch (e) { ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e) }
  try { if (running.value) stop() } catch (e) { ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e) }
  try {
    if (autoBenchPollTimer !== null) {
      window.clearInterval(autoBenchPollTimer)
      autoBenchPollTimer = null
    }
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e)
  }
  try { document.removeEventListener('keydown', handleBenchHotkeys, true) } catch (e) { ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/components/dev/MacroBenchWidget.vue', e) }
  persistWidgetState()
})
</script>

<style scoped>
.macro-bench {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 8px;
}

.macro-bench-hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 16px;
  background: linear-gradient(135deg, rgba(15, 23, 42, 0.96), rgba(30, 41, 59, 0.9));
  color: #f8fafc;
}

.macro-bench-hero-copy {
  min-width: 0;
}

.macro-bench-eyebrow {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(191, 219, 254, 0.95);
}

.macro-bench-heading {
  margin-top: 4px;
  font-size: 20px;
  font-weight: 800;
}

.macro-bench-description {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: rgba(226, 232, 240, 0.9);
}

.macro-bench-shortcuts {
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.4;
  color: rgba(191, 219, 254, 0.92);
}

.macro-bench-debug {
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.4;
  color: rgba(148, 163, 184, 0.92);
}

.macro-bench-state {
  flex: 0 0 auto;
  padding: 8px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  background: rgba(148, 163, 184, 0.24);
}

.macro-bench-state.running {
  background: rgba(59, 130, 246, 0.24);
  color: #dbeafe;
}

.macro-bench-state.error {
  background: rgba(239, 68, 68, 0.22);
  color: #fee2e2;
}

.macro-bench-state.done {
  background: rgba(16, 185, 129, 0.22);
  color: #d1fae5;
}

.macro-bench-state.idle {
  color: #e2e8f0;
}

.macro-bench-stop-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 14px 16px;
  border-radius: 14px;
  border: 1px solid rgba(239, 68, 68, 0.22);
  background: linear-gradient(135deg, rgba(255, 241, 242, 0.98), rgba(254, 226, 226, 0.96));
  box-shadow: 0 10px 28px rgba(127, 29, 29, 0.08);
  flex-wrap: wrap;
  appearance: none;
  cursor: pointer;
  text-align: left;
  position: sticky;
  top: 0;
  z-index: 4;
}

.macro-bench-stop-copy {
  min-width: 0;
  flex: 1 1 240px;
  display: flex;
  flex-direction: column;
}

.macro-bench-stop-title {
  font-size: 14px;
  font-weight: 800;
  color: #991b1b;
}

.macro-bench-stop-text {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: #b91c1c;
}

.macro-bench-stop-cta {
  min-width: 196px;
  min-height: 44px;
  padding: 10px 18px;
  font-weight: 800;
  border-radius: 999px;
  background: linear-gradient(135deg, #ef4444, #dc2626);
  color: #fff7ed;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 10px 20px rgba(220, 38, 38, 0.18);
}

.macro-bench-stop-strip:hover {
  border-color: rgba(220, 38, 38, 0.32);
  box-shadow: 0 12px 30px rgba(127, 29, 29, 0.12);
}

.macro-bench-stop-strip:focus-visible {
  outline: 2px solid rgba(220, 38, 38, 0.35);
  outline-offset: 2px;
}

.macro-bench-stop-strip.pending {
  cursor: wait;
  opacity: 0.92;
}

.macro-bench-panel,
.macro-bench-summary,
.macro-bench-error,
.macro-bench-progress {
  border-radius: 14px;
  border: 1px solid rgba(148, 163, 184, 0.2);
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.08);
}

.macro-bench-panel {
  padding: 14px 16px;
}

.macro-bench-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.macro-bench-budget-row {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed rgba(148, 163, 184, 0.28);
}

.macro-bench-title {
  font-size: 13px;
  font-weight: 700;
  color: #0f172a;
  min-width: 92px;
}

.macro-bench-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  flex: 1 1 auto;
}

.macro-bench-native-select {
  height: 34px;
  font-size: 13px;
  padding: 0 10px;
  border: 1px solid rgba(148, 163, 184, 0.5);
  border-radius: 10px;
  background: #fff;
  color: #111827;
}

.macro-bench-native-select:disabled {
  background: rgba(0, 0, 0, 0.03);
  color: rgba(17, 24, 39, 0.65);
}

.macro-bench-native-select-wide {
  min-width: 200px;
}

.macro-bench-label {
  font-size: 12px;
  color: #64748b;
  align-self: center;
}

.macro-bench-progress {
  padding: 12px 14px;
  font-size: 13px;
  color: #0f172a;
}

.macro-bench-error {
  padding: 12px 14px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  border-color: rgba(239, 68, 68, 0.22);
  background: rgba(254, 242, 242, 0.96);
}

.macro-bench-error-copy {
  flex: 1 1 auto;
  min-width: 240px;
}

.macro-bench-error-title {
  font-size: 13px;
  font-weight: 700;
  color: #991b1b;
  margin-bottom: 4px;
}

.macro-bench-error-text {
  font-size: 12px;
  color: #b91c1c;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.macro-bench-error-actions {
  flex: 0 0 auto;
}

.macro-bench-summary {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px 16px;
}

.macro-bench-overview {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
}

.macro-bench-overview-card {
  border-radius: 12px;
  border: 1px solid rgba(148, 163, 184, 0.2);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(248, 250, 252, 0.96));
  padding: 12px;
}

.macro-bench-overview-card.good {
  border-color: rgba(16, 185, 129, 0.24);
  background: linear-gradient(180deg, rgba(236, 253, 245, 0.96), rgba(255, 255, 255, 0.96));
}

.macro-bench-overview-label {
  font-size: 11px;
  font-weight: 700;
  color: #64748b;
}

.macro-bench-overview-value {
  margin-top: 6px;
  font-size: 22px;
  font-weight: 800;
  color: #0f172a;
}

.macro-bench-overview-hint {
  margin-top: 4px;
  font-size: 11px;
  color: #64748b;
}

.macro-bench-brief {
  border-radius: 12px;
  background: rgba(248, 250, 252, 0.92);
  border: 1px solid rgba(148, 163, 184, 0.18);
  padding: 12px 14px;
}

.macro-bench-brief-title,
.macro-bench-section-title {
  font-size: 13px;
  font-weight: 700;
  color: #0f172a;
  margin-bottom: 6px;
}

.macro-bench-brief-line {
  font-size: 12px;
  line-height: 1.5;
  color: #334155;
}

.macro-bench-suite-table {
  border-top: 1px dashed rgba(148, 163, 184, 0.28);
  padding-top: 12px;
}

.macro-bench-suite-row {
  display: grid;
  grid-template-columns: 1.5fr 0.8fr 0.8fr 0.7fr 1fr 1fr;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  line-height: 1.4;
  padding: 4px 0;
}

.macro-bench-suite-head {
  color: #64748b;
  font-weight: 700;
}

.macro-bench-suite-row .col {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.macro-bench-turns {
  border-top: 1px dashed rgba(148, 163, 184, 0.28);
  padding-top: 12px;
}

.macro-bench-turns-title {
  font-size: 12px;
  color: #64748b;
  margin-bottom: 8px;
}

.macro-bench-turn {
  border: 1px solid rgba(239, 68, 68, 0.16);
  border-radius: 10px;
  padding: 10px 12px;
  margin: 8px 0;
  background: rgba(255, 255, 255, 0.98);
}

.macro-bench-turn-head {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  font-size: 12px;
}

.macro-bench-turn-head .k {
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.06);
  color: #111827;
}

.macro-bench-turn-head .k.bad {
  background: rgba(239, 68, 68, 0.14);
  color: #991b1b;
}

.macro-bench-turn-sub {
  margin-top: 6px;
  font-size: 12px;
  color: #334155;
  line-height: 1.5;
}

.macro-bench-turn-sub.bad {
  color: #991b1b;
}

.macro-bench-turn-sub .fail {
  display: inline-block;
  margin-left: 6px;
}

.macro-bench-tech {
  border-top: 1px dashed rgba(148, 163, 184, 0.28);
  padding-top: 12px;
}

.macro-bench-tech > summary {
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  color: #1d4ed8;
}

.macro-bench-tech-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 10px 0;
}

.macro-bench-json {
  margin: 0;
  padding: 12px;
  border-radius: 12px;
  background: #0f172a;
  color: #e2e8f0;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 280px;
  overflow: auto;
}

@media (max-width: 720px) {
  .macro-bench-hero {
    flex-direction: column;
  }

  .macro-bench-state {
    align-self: flex-start;
  }

  .macro-bench-suite-row {
    grid-template-columns: 1.4fr 0.9fr 0.9fr 0.8fr 1fr 1fr;
  }
}
</style>

