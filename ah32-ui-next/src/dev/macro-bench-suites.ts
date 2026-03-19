export type MacroBenchHost = 'wps' | 'et' | 'wpp'

// Built-in bench suites.
//
// Notes:
// - The repo ships more than just "business scenario" skills; some are "capability skills"
//   that define strict Plan-only delivery contracts (doc-*, et-*, ppt-*).
// - MacroBench aims to cover both: (1) customer-like scenarios and (2) deterministic skill coverage.
export type MacroBenchSuiteId =
  // Skill coverage (the "built-in" skills that are expected to reliably output Plan JSON).
  | 'doc-analyzer'
  | 'doc-editor'
  | 'doc-formatter'
  | 'exam-answering'
  | 'et-analyzer'
  | 'et-visualizer'
  | 'ppt-creator'
  | 'ppt-outline'
  | 'wpp-outline'
  | 'answer-mode'
  // Skill coverage (text-first).
  | 'ppt-review'
  // System coverage (executor/repair/UX-critical flows).
  | 'system-plan-repair'
  | 'system-block-lifecycle'
  | 'system-macro-queue'
  | 'system-tenant-skills'
  // Business scenarios (legacy / scenario-first suites).
  | 'finance-audit'
  | 'contract-review'
  | 'bidding-helper'
  | 'meeting-minutes'
  | 'policy-format'
  | 'risk-register'

export type MacroBenchCase = {
  // Stable identity for diffing across runs.
  id: string
  suiteId: MacroBenchSuiteId
  host: MacroBenchHost
  // Display name
  name: string
  // User query for /agentic/plan/generate
  query: string
  // Optional deterministic skill routing for plan generation.
  forceSkillId?: string
  // Optional deterministic executor smoke path.
  planOverride?: Record<string, any>
  // Optional tags for filtering.
  tags?: string[]
}

export type MacroBenchSuite = {
  id: MacroBenchSuiteId
  name: string
  description: string
}

export const MACRO_BENCH_SUITES: MacroBenchSuite[] = [
  { id: 'doc-analyzer', name: '文档结构分析', description: '结构报告/缺口清单/一致性问题（Plan-only）' },
  { id: 'doc-editor', name: '文档改写', description: '对照表+修订稿块交付（Plan-only）' },
  { id: 'doc-formatter', name: '文档排版', description: '排版规范+问题清单+模板块交付（Plan-only）' },
  { id: 'exam-answering', name: '试题答题', description: '不改题干，文末追加《答案与解析》（Plan-only）' },
  { id: 'et-analyzer', name: 'ET 数据分析', description: '透视/排序/筛选/格式化（Plan-only）' },
  { id: 'et-visualizer', name: 'ET 可视化', description: '汇总+做图/趋势线/数据标签（Plan-only）' },
  { id: 'ppt-creator', name: 'PPT 一键创建', description: '直接创建幻灯片（Plan-only）' },
  { id: 'ppt-outline', name: 'PPT 大纲讲稿', description: '逐页大纲+讲稿；显式要求时 Plan 创建' },
  { id: 'ppt-review', name: 'PPT 审稿优化', description: '逐页问题/结构叙事/一致性/缺口清单（文本为主）' },
  { id: 'wpp-outline', name: 'WPP 版式', description: '版式推荐/占位符填充/创建（Plan-only）' },
  { id: 'answer-mode', name: '答题写回', description: '题号定位/括号下划线写回/不改题干（Plan-only）' },
  { id: 'system-plan-repair', name: '系统：Plan 修复', description: '验证 /agentic/plan/repair 的 deterministic fast-path' },
  { id: 'system-block-lifecycle', name: '系统：块生命周期', description: 'upsert/update/rollback/delete 的可执行回归' },
  { id: 'system-macro-queue', name: '系统：宏队列', description: '跨文档写回队列：不串写/不踩踏/可回归' },
  { id: 'system-tenant-skills', name: '系统：租户 Skills', description: '租户内置技能：热更新/禁用/冲突优先级（dev-only）' },
  { id: 'finance-audit', name: '财务审计', description: '报表/预算/费用/台账/核对' },
  { id: 'contract-review', name: '法务合同', description: '风险点/条款审阅/修改建议/对照表' },
  { id: 'bidding-helper', name: '招投标', description: '需求响应/证据材料/清单/里程碑' },
  { id: 'meeting-minutes', name: '会议纪要', description: '模板/待办/行动项/纪要结构' },
  { id: 'policy-format', name: '制度排版', description: '标题层级/目录/段落样式/格式统一' },
  { id: 'risk-register', name: '风险台账', description: '风险清单/评分/对策/责任人' },
]

type Template = {
  id: string
  host: MacroBenchHost
  title: string
  tags: string[]
  forceSkillId?: string
  // one template can expand into multiple cases via variants
  variants: Array<{ suffix: string; query: string; planOverride?: Record<string, any> }>
}

// Keep templates conservative and WPS-compatible. Avoid emojis; prefer simple punctuation.
const T: Record<MacroBenchSuiteId, Template[]> = {
  // Skill coverage suites: chat-bench is the primary signal (skills routing + SSE plan).
  // Macro-direct keeps a small smoke set so we can quickly catch generator/executor regressions.
  'doc-analyzer': [
    {
      id: 'wps_doc_analyzer_report',
      forceSkillId: 'doc-analyzer',
      host: 'wps',
      title: '结构报告块（幂等写回）',
      tags: ['writer', 'doc', 'structure', 'writeback'],
      variants: [
        {
          suffix: 'v1',
          query:
            '分析当前文档结构是否完整与一致，写回到文末一个“结构报告块”（upsert_block，幂等）。' +
            '必须包含：结构大纲/缺口清单(P0/P1/P2)/一致性问题/整改顺序/自检清单。',
        },
      ],
    },
  ],
  'doc-editor': [
    {
      id: 'wps_doc_editor_compare',
      forceSkillId: 'doc-editor',
      host: 'wps',
      title: '对照表+修订稿（幂等写回）',
      tags: ['writer', 'doc', 'rewrite', 'writeback', 'table'],
      variants: [
        {
          suffix: 'v1',
          query:
            '把下面原文改写成正式商务沟通风格，但不要改动原文正文；在文末写回一个交付块（upsert_block，幂等）：' +
            '1) 改写范围与假设；2) 对照表(原文要点/建议改写/理由/风险)；3) 修订稿。\n' +
            '原文：我们这个方案很牛，肯定能搞定。可能会有点风险，但问题不大。交付时间看情况，资源也要再协调一下。',
        },
      ],
    },
  ],
  'doc-formatter': [
    {
      id: 'wps_doc_formatter_rules',
      forceSkillId: 'doc-formatter',
      host: 'wps',
      title: '排版规范+检查清单（幂等写回）',
      tags: ['writer', 'doc', 'format', 'writeback'],
      variants: [
        {
          suffix: 'v1',
          query:
            '给当前文档输出“排版规范+检查清单+模板段落”交付块（upsert_block，幂等；不要尝试全篇改样式）。' +
            '必须包含：标题层级/编号规则/段落间距/常见问题清单/可替换模板段落/自检清单。',
        },
      ],
    },
  ],
  'exam-answering': [
    {
      id: 'wps_exam_answering_appendix',
      forceSkillId: 'exam-answering',
      host: 'wps',
      title: '答案与解析（文末块）',
      tags: ['writer', 'exam', 'writeback'],
      variants: [
        {
          suffix: 'v1',
          query:
            '请完成下面试题：不要改题干；在文档末尾追加《答案与解析》（upsert_block，幂等），按题号输出。\n' +
            '1. 选择题：下列属于哺乳动物的是（ ）A 海豚 B 鲨鱼 C 海龟 D 章鱼\n' +
            '2. 填空题：我国首都是______。\n' +
            '3. 简答题：用不超过40字解释“合规”的含义。',
        },
      ],
    },
  ],
  'et-analyzer': [
    {
      id: 'et_analyzer_pivot',
      forceSkillId: 'et-analyzer',
      host: 'et',
      title: '明细->透视->图表',
      tags: ['et', 'analysis', 'pivot', 'chart'],
      variants: [
        {
          suffix: 'v1',
          query:
            '在Sheet1从A1生成“销售明细”表（至少20行，字段：日期/部门/产品/金额），冻结首行，金额为数字。' +
            '然后新建工作表“汇总”：做透视表按部门汇总金额，并插入柱状图（标题“部门金额汇总”）。',
          planOverride: {
            schema_version: 'ah32.plan.v1',
            host_app: 'et',
            meta: { kind: 'bench_et_analyzer_override_v1' },
            actions: [
              {
                id: 'seed_sheet1',
                title: 'Seed sales detail',
                op: 'ensure_sheet',
                sheet_name: 'Sheet1',
                clear_existing: true,
                activate: true,
                select_a1: true,
              },
              {
                id: 'seed_table',
                title: 'Insert detail table',
                op: 'insert_table',
                rows: 11,
                cols: 4,
                header: true,
                borders: true,
                auto_fit: 1,
                data: [
                  ['Date', 'Department', 'Product', 'Amount'],
                  ['2026-01-05', 'North', 'A', 1200],
                  ['2026-01-08', 'South', 'B', 980],
                  ['2026-01-14', 'North', 'C', 1560],
                  ['2026-01-20', 'East', 'A', 760],
                  ['2026-02-03', 'South', 'A', 1320],
                  ['2026-02-11', 'East', 'C', 1180],
                  ['2026-02-18', 'North', 'B', 1430],
                  ['2026-02-26', 'West', 'A', 890],
                  ['2026-03-06', 'West', 'C', 1670],
                  ['2026-03-15', 'South', 'B', 1210],
                ],
              },
              {
                id: 'select_detail',
                title: 'Select detail range',
                op: 'set_selection',
                range: 'Sheet1!A1:D11',
              },
              {
                id: 'ensure_summary',
                title: 'Prepare summary sheet',
                op: 'ensure_sheet',
                sheet_name: 'Summary',
                clear_existing: true,
                activate: true,
                select_a1: true,
              },
              {
                id: 'pivot',
                title: 'Create pivot table',
                op: 'create_pivot_table',
                source_range: 'Sheet1!A1:D11',
                destination: 'Summary!A1',
                table_name: 'ah32_et_summary',
                rows: ['Department'],
                values: [
                  {
                    field: 'Amount',
                    summary: 'sum',
                    title: 'Total Amount',
                  },
                ],
              },
              {
                id: 'select_summary',
                title: 'Select summary range',
                op: 'set_selection',
                range: 'Summary!A1:B5',
              },
              {
                id: 'chart',
                op: 'insert_chart_from_selection',
                sheet_name: 'Summary',
                source_range: 'A1:B5',
                chart_type: 51,
                title: 'Department Amount Summary',
                has_legend: false,
              },
            ],
          },
        },
      ],
    },
  ],
  'et-visualizer': [
    {
      id: 'et_visualizer_dual_charts',
      forceSkillId: 'et-visualizer',
      host: 'et',
      title: '占比饼图 + 趋势折线',
      tags: ['et', 'chart', 'visualize'],
      variants: [
        {
          suffix: 'v1',
          query:
            '在A1生成费用结构表：类别/金额，填5行示例，并插入饼图显示占比（显示百分比，标题“费用结构”）。' +
            '在旁边再生成月份(1-6)/销售额数据，并插入折线图（标题“销售趋势”）。',
          planOverride: {
            schema_version: 'ah32.plan.v1',
            host_app: 'et',
            meta: { kind: 'bench_et_visualizer_override_v1' },
            actions: [
              {
                id: 'ensure_sheet1',
                title: 'Prepare visualizer sheet',
                op: 'ensure_sheet',
                sheet_name: 'Sheet1',
                clear_existing: true,
                activate: true,
                select_a1: true,
              },
              {
                id: 'seed_cost_table',
                title: 'Insert expense table',
                op: 'insert_table',
                rows: 6,
                cols: 2,
                header: true,
                borders: true,
                auto_fit: 1,
                data: [
                  ['Category', 'Amount'],
                  ['HR', 320],
                  ['IT', 450],
                  ['Sales', 680],
                  ['Marketing', 390],
                  ['Admin', 210],
                ],
              },
              {
                id: 'cost_chart',
                op: 'insert_chart_from_selection',
                sheet_name: 'Sheet1',
                source_range: 'A1:B6',
                chart_type: 5,
                title: 'Expense Structure',
              },
              {
                id: 'select_trend_anchor',
                title: 'Move to trend area',
                op: 'set_selection',
                range: 'Sheet1!D1:E7',
              },
              {
                id: 'seed_trend_table',
                title: 'Insert trend table',
                op: 'insert_table',
                rows: 7,
                cols: 2,
                header: true,
                borders: true,
                auto_fit: 1,
                data: [
                  ['Month', 'Sales'],
                  [1, 120],
                  [2, 155],
                  [3, 182],
                  [4, 210],
                  [5, 238],
                  [6, 265],
                ],
              },
              {
                id: 'trend_chart',
                op: 'insert_chart_from_selection',
                sheet_name: 'Sheet1',
                source_range: 'D1:E7',
                chart_type: 4,
                title: 'Sales Trend',
              },
            ],
          },
        },
      ],
    },
  ],
  'ppt-creator': [
    {
      id: 'wpp_ppt_creator_3slides',
      forceSkillId: 'ppt-creator',
      host: 'wpp',
      title: '一键创建 3 页',
      tags: ['wpp', 'ppt', 'create', 'writeback'],
      variants: [
        {
          suffix: 'v1',
          query:
            '一键创建3页PPT并直接创建到当前演示文稿：' +
            '1) 封面：标题“项目汇报”，副标题“内部使用”；' +
            '2) 目录：列4个要点；' +
            '3) 结论：列3条结论与下一步。',
          planOverride: {
            schema_version: 'ah32.plan.v1',
            host_app: 'wpp',
            meta: { kind: 'bench_ppt_creator_override_v1' },
            actions: [
              {
                id: 'drop_default_slide',
                title: 'Remove default blank slide',
                op: 'delete_slide',
                slide_index: 1,
              },
              {
                id: 'slide_cover',
                op: 'add_slide',
                position: 1,
                layout: 1,
                title: '项目汇报',
                content: '内部使用',
              },
              {
                id: 'slide_agenda',
                op: 'add_slide',
                position: 2,
                layout: 2,
                title: '目录',
                content: '1. 项目背景\\n2. 当前目标\\n3. 主要风险\\n4. 下一步安排',
              },
              {
                id: 'slide_conclusion',
                op: 'add_slide',
                position: 3,
                layout: 2,
                title: '结论与下一步',
                content: '1. 方案可执行\\n2. 资源需要同步\\n3. 本周完成试运行',
              },
            ],
          },
        },
      ],
    },
  ],
  'ppt-outline': [
    {
      id: 'wpp_ppt_outline_4slides',
      host: 'wpp',
      title: '大纲讲稿 -> 创建 4 页',
      tags: ['wpp', 'ppt', 'outline', 'writeback'],
      variants: [
        {
          suffix: 'v1',
          query:
            '给我做一份4页汇报PPT（背景/问题/方案/下一步），并直接创建到当前演示文稿。' +
            '每页≤5条要点，标题清晰，风格商务。',
        },
      ],
    },
  ],
  'ppt-review': [],
  'wpp-outline': [
    {
      id: 'wpp_layout_helper_2slides',
      forceSkillId: 'wpp-outline',
      host: 'wpp',
      title: '版式+占位符填充',
      tags: ['wpp', 'layout', 'placeholder', 'writeback'],
      variants: [
        {
          suffix: 'v1',
          query:
            '创建2页PPT并优先使用占位符填充：' +
            '1) 标题页：标题“版式测试”，副标题“占位符填充”；' +
            '2) 内容页：标题“要点”，列4条要点。',
          planOverride: {
            schema_version: 'ah32.plan.v1',
            host_app: 'wpp',
            meta: { kind: 'bench_wpp_outline_override_v1' },
            actions: [
              {
                id: 'drop_default_slide',
                title: 'Remove default blank slide',
                op: 'delete_slide',
                slide_index: 1,
              },
              {
                id: 'slide_title',
                op: 'add_slide',
                position: 1,
                layout: 1,
                title: '版式测试',
                content: '占位符填充',
              },
              {
                id: 'slide_points',
                op: 'add_slide',
                position: 2,
                layout: 2,
                title: '要点',
                content: '1. 要点一\\n2. 要点二\\n3. 要点三\\n4. 要点四',
              },
            ],
          },
        },
      ],
    },
  ],
  'answer-mode': [],
  'system-plan-repair': [
    {
      id: 'wps_system_plan_repair_legacy_upsert',
      host: 'wps',
      title: 'Legacy upsert -> repair fast-path',
      tags: ['system', 'repair', 'writer'],
      variants: [
        {
          suffix: 'v1',
          query:
            '请输出一个可执行 Plan：在文末 upsert_block 写入文本 REPAIR_FASTPATH_TOKEN_V1。' +
            '要求：故意使用旧字段 upsert_block.content（不要用 actions 数组），以触发 repair fast-path 修复后再执行。',
        },
      ],
    },
  ],
  'system-block-lifecycle': [
    {
      id: 'wps_system_block_lifecycle_ops',
      host: 'wps',
      title: 'upsert/update/rollback/delete（系统回归）',
      tags: ['system', 'block', 'lifecycle', 'writer'],
      variants: [
        {
          suffix: 'v1',
          query:
            '生成可执行 Plan，按顺序执行块生命周期回归：' +
            '1) upsert_block 写入 LIFECYCLE_TOKEN_V1；' +
            '2) 再 upsert_block 更新为 LIFECYCLE_TOKEN_V2；' +
            '3) rollback_block 回滚到 V1；' +
            '4) delete_block 删除该块。\n' +
            '要求：四步都操作同一个 block_id（保持一致）。',
        },
      ],
    },
  ],
  // System suites below are chat-bench driven (macro-direct cannot express UI queue or dev mutations).
  'system-macro-queue': [],
  'system-tenant-skills': [],
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
  // NOTE: answer-mode templates are chat-bench only for now.
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
          forceSkillId: String(tpl.forceSkillId || '').trim() || undefined,
          planOverride: v.planOverride,
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
