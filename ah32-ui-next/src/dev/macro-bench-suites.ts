export type MacroBenchHost = 'wps' | 'et' | 'wpp'

// 6 built-in business scenarios (match installer/assets/user-docs/skills/* ids).
export type MacroBenchSuiteId =
  | 'finance-audit'
  | 'contract-review'
  | 'bidding-helper'
  | 'meeting-minutes'
  | 'policy-format'
  | 'risk-register'
  | 'answer-mode'

export type MacroBenchCase = {
  // Stable identity for diffing across runs.
  id: string
  suiteId: MacroBenchSuiteId
  host: MacroBenchHost
  // Display name
  name: string
  // User query for /agentic/plan/generate
  query: string
  // Optional tags for filtering.
  tags?: string[]
}

export type MacroBenchSuite = {
  id: MacroBenchSuiteId
  name: string
  description: string
}

export const MACRO_BENCH_SUITES: MacroBenchSuite[] = [
  { id: 'finance-audit', name: '财务审计', description: '报表/预算/费用/台账/核对' },
  { id: 'contract-review', name: '法务合同', description: '风险点/条款审阅/修改建议/对照表' },
  { id: 'bidding-helper', name: '招投标', description: '需求响应/证据材料/清单/里程碑' },
  { id: 'meeting-minutes', name: '会议纪要', description: '模板/待办/行动项/纪要结构' },
  { id: 'policy-format', name: '制度排版', description: '标题层级/目录/段落样式/格式统一' },
  { id: 'risk-register', name: '风险台账', description: '风险清单/评分/对策/责任人' },
  { id: 'answer-mode', name: '答题写回', description: '题号定位/括号下划线写回/不改题干' },
]

type Template = {
  id: string
  host: MacroBenchHost
  title: string
  tags: string[]
  // one template can expand into multiple cases via variants
  variants: Array<{ suffix: string; query: string }>
}

// Keep templates conservative and WPS-compatible. Avoid emojis; prefer simple punctuation.
const T: Record<MacroBenchSuiteId, Template[]> = {
  'finance-audit': [
    // Writer
    {
      id: 'wps_finance_audit_checklist',
      host: 'wps',
      title: '财务审核清单表格',
      tags: ['table', 'finance', 'writer'],
      variants: [
        { suffix: 'v1', query: '在光标处插入“财务审核清单”表格：项目/金额/凭证是否齐全/备注。写3行示例。' },
        { suffix: 'v2', query: '在文档末尾插入“费用报销核对表”表格：报销人/部门/金额/发票/异常说明。写4行示例。' },
        { suffix: 'v3', query: '插入“应收账款台账”表格：客户/账期/应收金额/已收/未收；写3行并给出合计行。' },
      ],
    },
    {
      id: 'wps_finance_summary',
      host: 'wps',
      title: '财务小结',
      tags: ['text', 'finance', 'writer'],
      variants: [
        { suffix: 'v1', query: '在光标处写一段“财务小结”：列3条要点，语气正式。' },
        { suffix: 'v2', query: '在文档末尾追加“审计发现与整改建议”小节：标题+3条发现+对应建议。' },
      ],
    },
    // ET
    {
      id: 'et_budget_vs_actual',
      host: 'et',
      title: '预算 vs 实际',
      tags: ['table', 'formula', 'finance', 'et'],
      variants: [
        { suffix: 'v1', query: '在A1写预算表：类别/预算/实际/差异，填4行示例，并计算差异。' },
        { suffix: 'v2', query: '生成一张“部门费用汇总”表：部门/本月费用/上月费用/环比%，填3行并计算环比%。' },
        { suffix: 'v3', query: '生成开票清单：客户/发票类型/金额/税率/含税金额，填4行示例，并计算含税金额。' },
      ],
    },
    {
      id: 'et_cashflow_chart',
      host: 'et',
      title: '现金流趋势图',
      tags: ['chart', 'finance', 'et'],
      variants: [
        { suffix: 'v1', query: '创建工作表“现金流”，写入月份(1-6)与净现金流(-12/5/18/10/22/15)，并生成折线图。' },
      ],
    },
    // WPP
    {
      id: 'wpp_finance_kpi',
      host: 'wpp',
      title: '财务KPI页',
      tags: ['slide', 'finance', 'wpp'],
      variants: [
        { suffix: 'v1', query: '生成1页财务KPI：大字“毛利率 32%”，下方两条说明。' },
        { suffix: 'v2', query: '生成1页费用结构：标题“费用结构”，列出3项费用占比（示例数据）。' },
      ],
    },
  ],

  'contract-review': [
    // Writer
    {
      id: 'wps_contract_risk_table',
      host: 'wps',
      title: '合同风险清单',
      tags: ['table', 'legal', 'writer'],
      variants: [
        { suffix: 'v1', query: '在当前光标处插入一张“合同风险清单”表格：风险点/条款位置/风险等级/建议修改。填入3行示例。' },
        { suffix: 'v2', query: '插入“条款审阅意见表”表格：条款标题/原文要点/风险说明/建议改写。写3行示例。' },
      ],
    },
    {
      id: 'wps_contract_clause_outline',
      host: 'wps',
      title: '合同审阅输出结构',
      tags: ['outline', 'legal', 'writer'],
      variants: [
        { suffix: 'v1', query: '在光标处插入一个合同审阅输出大纲：总体意见/重点风险/修改建议/待确认事项；每项一行说明。' },
      ],
    },
    // ET
    {
      id: 'et_clause_matrix',
      host: 'et',
      title: '条款对照矩阵',
      tags: ['table', 'legal', 'et'],
      variants: [
        { suffix: 'v1', query: '生成“条款对照表”：条款项/甲方义务/乙方义务/风险提示，填3行示例。' },
      ],
    },
    // WPP
    {
      id: 'wpp_contract_risk_slide',
      host: 'wpp',
      title: '合同风险要点页',
      tags: ['slide', 'legal', 'wpp'],
      variants: [
        { suffix: 'v1', query: '生成1页合同风险：标题“合同风险要点”，列3条风险及应对建议。' },
      ],
    },
  ],

  'bidding-helper': [
    // Writer
    {
      id: 'wps_bid_response_table',
      host: 'wps',
      title: '需求-响应对照表',
      tags: ['table', 'ah32', 'writer'],
      variants: [
        { suffix: 'v1', query: '在光标处插入“需求-响应对照表”表格：需求点/响应说明/证据材料/负责人。写3行示例。' },
        { suffix: 'v2', query: '在文档末尾插入“投标文件自查清单”表：章节/是否齐全/风险/备注，写4行示例。' },
      ],
    },
    {
      id: 'wps_evidence_list',
      host: 'wps',
      title: '证据材料清单',
      tags: ['text', 'ah32', 'writer'],
      variants: [
        { suffix: 'v1', query: '插入“证明文件清单”小节：营业执照/法人授权/财务/社保/信用；每项一行。' },
      ],
    },
    // ET
    {
      id: 'et_scoring_matrix',
      host: 'et',
      title: '评分项拆解表',
      tags: ['table', 'ah32', 'et'],
      variants: [
        { suffix: 'v1', query: '生成评分项拆解表：评分项/分值/响应要点/证据材料，填4行示例。' },
      ],
    },
    // WPP
    {
      id: 'wpp_bid_agenda',
      host: 'wpp',
      title: '投标汇报议程页',
      tags: ['slide', 'ah32', 'wpp'],
      variants: [
        { suffix: 'v1', query: '生成1页议程：标题“投标汇报议程”，列出4个要点：背景/方案/优势/交付。' },
      ],
    },
  ],

  'meeting-minutes': [
    // Writer
    {
      id: 'wps_meeting_minutes',
      host: 'wps',
      title: '会议纪要模板',
      tags: ['table', 'meeting', 'writer'],
      variants: [
        { suffix: 'v1', query: '在文档写入会议纪要模板：会议主题/时间/参会人/结论/待办(表格)。' },
        { suffix: 'v2', query: '在光标处插入“行动项”表格：事项/负责人/截止日期/状态，写3行示例。' },
      ],
    },
    {
      id: 'wps_meeting_summary',
      host: 'wps',
      title: '会议结论小结',
      tags: ['text', 'meeting', 'writer'],
      variants: [
        { suffix: 'v1', query: '插入“会议结论”标题，并列出3条要点。' },
      ],
    },
    // ET
    {
      id: 'et_action_items_tracker',
      host: 'et',
      title: '行动项跟踪表',
      tags: ['table', 'meeting', 'et'],
      variants: [
        { suffix: 'v1', query: '生成行动项跟踪表：事项/负责人/截止日期/状态，填4行示例。' },
      ],
    },
    // WPP
    {
      id: 'wpp_meeting_summary_slide',
      host: 'wpp',
      title: '会议纪要汇报页',
      tags: ['slide', 'meeting', 'wpp'],
      variants: [
        { suffix: 'v1', query: '生成1页会议纪要汇报：标题“会议纪要”，三条要点：结论/待办/风险。' },
      ],
    },
  ],

  'policy-format': [
    // Writer
    {
      id: 'wps_policy_outline_toc',
      host: 'wps',
      title: '制度大纲与标题层级',
      tags: ['outline', 'format', 'writer'],
      variants: [
        { suffix: 'v1', query: '在光标处插入一个三级标题大纲：1概述/2目标/3范围/4职责/5流程/6附则；每个下面一行说明。' },
        { suffix: 'v2', query: '在文档末尾追加“附录”小节：标题“附录”，下方插入2条编号条目。' },
      ],
    },
    {
      id: 'wps_policy_formatting_demo',
      host: 'wps',
      title: '排版示例',
      tags: ['format', 'writer'],
      variants: [
        { suffix: 'v1', query: '在光标处写一段文字并加粗标题：标题“注意事项”，正文两行。' },
      ],
    },
    // ET
    {
      id: 'et_policy_checklist',
      host: 'et',
      title: '制度检查清单(表格)',
      tags: ['table', 'format', 'et'],
      variants: [
        { suffix: 'v1', query: '生成制度检查清单：条款/是否覆盖/证据/备注，写4行示例。' },
      ],
    },
    // WPP
    {
      id: 'wpp_policy_slide',
      host: 'wpp',
      title: '制度解读页',
      tags: ['slide', 'format', 'wpp'],
      variants: [
        { suffix: 'v1', query: '生成1页制度解读：标题“制度要点”，列出3条要点与一句落地建议。' },
      ],
    },
  ],

  'risk-register': [
    // Writer
    {
      id: 'wps_risk_register_table',
      host: 'wps',
      title: '风险台账表格',
      tags: ['table', 'risk', 'writer'],
      variants: [
        { suffix: 'v1', query: '插入一个小型风险台账表格：风险/影响/概率/对策。填3行。' },
        { suffix: 'v2', query: '插入“项目风险清单”表格：风险点/触发条件/应对措施/责任人/状态，填3行示例。' },
      ],
    },
    {
      id: 'wps_risk_summary',
      host: 'wps',
      title: '风险总结段落',
      tags: ['text', 'risk', 'writer'],
      variants: [
        { suffix: 'v1', query: '在文档末尾插入“主要风险与对策”小节：标题+3条风险+对策。' },
      ],
    },
    // ET
    {
      id: 'et_risk_scoring',
      host: 'et',
      title: '风险评分表',
      tags: ['table', 'risk', 'et'],
      variants: [
        { suffix: 'v1', query: '生成风险评分表：风险/影响(1-5)/概率(1-5)/评分(乘积)/对策，写4行并计算评分。' },
      ],
    },
    // WPP
    {
      id: 'wpp_risk_slide',
      host: 'wpp',
      title: '风险页',
      tags: ['slide', 'risk', 'wpp'],
      variants: [
        { suffix: 'v1', query: '生成1页风险：标题“主要风险”，列3条风险及对策。' },
      ],
    },
  ],

  // Chat-mode bench covers Answer Mode; macro-mode can add templates later.
  'answer-mode': [],
}

export type MacroBenchPreset = 'quick' | 'standard' | 'full'

export const MACRO_BENCH_PRESETS: Array<{ id: MacroBenchPreset; name: string; limitPerSuitePerHost: number }> = [
  { id: 'quick', name: '快速(少量)', limitPerSuitePerHost: 3 },
  { id: 'standard', name: '标准(中等)', limitPerSuitePerHost: 8 },
  { id: 'full', name: '加压(更多)', limitPerSuitePerHost: 20 },
]

// Deterministic ordering; stable ids make result diffing meaningful.
export const buildBenchCases = (args: {
  host: MacroBenchHost
  suiteId?: MacroBenchSuiteId | 'all'
  preset?: MacroBenchPreset
  limitPerSuitePerHost?: number
}): MacroBenchCase[] => {
  const host = args.host
  const suiteId = args.suiteId || 'all'
  const preset = args.preset || 'standard'
  const presetCfg = MACRO_BENCH_PRESETS.find(p => p.id === preset)
  const limit = Number(args.limitPerSuitePerHost || presetCfg?.limitPerSuitePerHost || 8)

  const suiteIds: MacroBenchSuiteId[] =
    suiteId === 'all'
      ? MACRO_BENCH_SUITES.map(s => s.id)
      : ([suiteId] as MacroBenchSuiteId[])

  const out: MacroBenchCase[] = []
  for (const sid of suiteIds) {
    const templates = (T[sid] || []).filter(x => x.host === host)
    const candidates: MacroBenchCase[] = []
    for (const tpl of templates) {
      for (const v of tpl.variants) {
        const id = `${sid}:${tpl.id}:${v.suffix}:${host}`
        candidates.push({
          id,
          suiteId: sid,
          host,
          name: `${tpl.title} (${v.suffix})`,
          query: v.query,
          tags: tpl.tags,
        })
      }
    }
    // Keep deterministic, then limit.
    candidates.sort((a, b) => a.id.localeCompare(b.id))
    out.push(...candidates.slice(0, Math.max(1, limit)))
  }

  return out
}
