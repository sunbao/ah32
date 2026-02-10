import type { MacroBenchHost, MacroBenchPreset, MacroBenchSuiteId } from './macro-bench-suites'

// Chat-driven bench definitions:
// - Keep this file "data-first": real user-like prompts, deterministic sample data, style requirements.
// - Avoid embedding workaround logic here; bench should expose issues, not hide them.

export type ChatBenchAction =
  | { type: 'ensure_bench_document'; title?: string }
  | { type: 'activate_bench_document' }
  | { type: 'require_host'; host: MacroBenchHost }
  // Optional: runner can attempt to drive the actual ChatPanel UI (type + click).
  | { type: 'ui_fill_input'; text: string }
  | { type: 'ui_click_send' }
  // Mutate the "typed" query before sending.
  | { type: 'prepend_query'; text: string }
  | { type: 'append_query'; text: string; newline?: boolean }
  // Insert an @ reference hint (RAG priority signal) into the query.
  | { type: 'insert_at_reference'; text: string }
  // Attach backend rule files for this turn (server reads these paths).
  | { type: 'attach_rule_files'; paths: string[] }
  | { type: 'set_cursor'; pos: 'start' | 'end' }
  | { type: 'select_all' }
  | { type: 'clear_document' }
  | { type: 'insert_text'; text: string; newline?: boolean }
  // Writer helpers
  | { type: 'find_text'; text: string }
  // UI helpers (dev toggles etc.)
  | { type: 'toggle_show_thoughts'; value: boolean }
  // ET helpers
  | { type: 'ensure_sheet'; name: string }
  | { type: 'activate_sheet'; name: string }
  | { type: 'select_range'; a1: string }
  // WPP helpers
  | { type: 'ensure_slide'; index: number }
  | { type: 'select_slide'; index: number }
  | { type: 'sleep'; ms: number }

export type ChatBenchAssert =
  | { type: 'writer_table_exists'; minRows?: number; minCols?: number; points?: number }
  | { type: 'writer_table_header_bold'; points?: number }
  | { type: 'writer_text_contains'; text: string; points?: number }
  | { type: 'writer_text_not_contains'; text: string; points?: number }
  | { type: 'writer_heading_at_least'; level: 1 | 2 | 3; min?: number; points?: number }
  | { type: 'writer_shapes_at_least'; min: number; points?: number }
  | { type: 'writer_block_backup_exists'; blockId?: string; points?: number }
  | { type: 'et_sheet_exists'; name: string; points?: number }
  | { type: 'et_chart_exists'; min?: number; points?: number }
  | { type: 'et_chart_has_title'; points?: number }
  | { type: 'et_freeze_panes_enabled'; points?: number }
  | { type: 'et_cell_number_format_not_general'; a1: string; points?: number }
  | { type: 'et_range_conditional_formats_at_least'; a1: string; min: number; points?: number }
  | { type: 'wpp_slide_count_at_least'; min: number; points?: number }
  | { type: 'wpp_last_slide_shapes_at_least'; min: number; points?: number }
  | { type: 'wpp_slide_text_contains'; text: string; points?: number }
  | { type: 'wpp_last_slide_within_bounds'; margin?: number; points?: number }
  | { type: 'wpp_last_slide_no_overlap'; points?: number }

export type ChatBenchTurn = {
  id: string
  name: string
  // What the user "types" into the chat box.
  query: string
  // Optional structured style constraints for this turn.
  // The runner will pass this into backend `frontend_context.style_spec`.
  styleSpec?: Record<string, any>
  // Stable artifact id for macro execution (runner injects it as // @ah32:blockId=...).
  artifactId?: string
  actionsBeforeSend?: ChatBenchAction[]
  actionsAfterExec?: ChatBenchAction[]
  asserts?: ChatBenchAssert[]
  // Optional tags for filtering/reporting.
  tags?: string[]
}

export type ChatBenchStory = {
  id: string
  suiteId: MacroBenchSuiteId
  host: MacroBenchHost
  name: string
  description: string
  // Optional actions that run once before the first turn (e.g., create a fresh bench document).
  setupActions?: ChatBenchAction[]
  turns: ChatBenchTurn[]
  tags?: string[]
}

const storyId = (suiteId: MacroBenchSuiteId, host: MacroBenchHost, slug: string) => `${suiteId}:${host}:${slug}`

const STYLE_SPECS: Record<string, any> = {
  writer_finance_report_v1: {
    schema: 'ah32.styleSpec.v1',
    name: 'writer_finance_report_v1',
    palette: { primary: '#2563eb', accent: '#f59e0b', muted: '#94a3b8' },
    font: {
      body: { name: '宋体', size: 12 },
      title: { name: '黑体', size: 18, bold: true },
      subtitle: { name: '黑体', size: 14, bold: true }
    },
    writer: {
      paragraph: { titleSpacing: { beforePt: 12, afterPt: 6 }, bodySpacing: { beforePt: 0, afterPt: 3 } },
      table: { header: { bold: true, fill: '#f1f5f9' }, borders: { outer: 'thick', inner: 'thin' } }
    }
  },
  et_kpi_v1: {
    schema: 'ah32.styleSpec.v1',
    name: 'et_kpi_v1',
    palette: { primary: '#2563eb', accent: '#10b981', danger: '#ef4444' },
    font: { body: { name: 'Segoe UI', size: 11 }, title: { name: 'Segoe UI', size: 14, bold: true } },
    et: {
      sheet: { freeze: { row: 1 }, columnWidth: { autoFit: true } },
      numberFormat: { money: '¥#,##0.00', percent: '0.00%', date: 'yyyy-mm-dd' },
      chart: { theme: 'office', palette: ['#2563eb', '#10b981', '#f59e0b', '#ef4444'] }
    }
  },
  wpp_bid_deck_v1: {
    schema: 'ah32.styleSpec.v1',
    name: 'wpp_bid_deck_v1',
    palette: { primary: '#2563eb', accent: '#f59e0b', muted: '#94a3b8' },
    wpp: {
      slide: { title: { size: 28, bold: true }, body: { size: 16 } },
      layout: { grid: { columns: 2, gutter: 24 } },
      shape: { emphasisBox: { fill: '#2563eb', textColor: '#ffffff' } }
    }
  }
}

// Minimal-but-real stories (3-5 turns) for each suite/host.
// Preset handling is applied by buildChatBenchStories() by truncating turns.
const STORIES: ChatBenchStory[] = [
  // ----------------------- Writer (wps) -----------------------
  {
    id: storyId('finance-audit', 'wps', 'audit_story_v1'),
    suiteId: 'finance-audit',
    host: 'wps',
    name: '财务审计：清单->发现->整改（Writer）',
    description: '从清单表格开始，追加审计发现与整改建议，并做一次格式美化（测试连续对话+排版）。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-财务审计' }, { type: 'set_cursor', pos: 'start' }],
    turns: [
      {
        id: 't1_checklist',
        name: '插入财务审核清单（含样式）',
        artifactId: 'bench_finance_audit_checklist',
        styleSpec: STYLE_SPECS.writer_finance_report_v1,
        actionsBeforeSend: [
          { type: 'attach_rule_files', paths: ['docs/AH32_RULES.md'] },
          { type: 'ui_click_send' },
        ],
        asserts: [
          { type: 'writer_table_exists', minRows: 4, minCols: 4 },
          { type: 'writer_table_header_bold' },
          { type: 'writer_text_contains', text: '变更记录' },
          { type: 'writer_block_backup_exists' },
        ],
        query:
          '在当前光标处插入“财务审核清单”表格：项目/金额/凭证是否齐全/备注。写3行示例。\n' +
          '样式要求：表头加粗+浅灰底色；表格外边框加粗、内边框细线；金额列右对齐。',
      },
      {
        id: 't2_findings',
        name: '追加审计发现与整改建议（引用上文）',
        artifactId: 'bench_finance_audit_findings',
        styleSpec: STYLE_SPECS.writer_finance_report_v1,
        actionsBeforeSend: [{ type: 'insert_at_reference', text: '当前文档' }],
        asserts: [
          { type: 'writer_text_contains', text: '审计发现与整改建议' },
          { type: 'writer_heading_at_least', level: 1, min: 1 },
        ],
        query:
          '在文档末尾追加“审计发现与整改建议”小节：\n' +
          '1) 标题用一级标题；\n' +
          '2) 列3条“发现”（要能对应上面清单里的典型问题）；\n' +
          '3) 每条发现后面紧跟一条“整改建议”。\n' +
          '要求：编号列表，条理清晰，措辞正式。',
      },
      {
        id: 't3_polish',
        name: '整体排版微调（统一字体/段落）',
        artifactId: 'bench_finance_audit_polish',
        styleSpec: STYLE_SPECS.writer_finance_report_v1,
        query:
          '请对本文档做一次“财务审计报告”风格的排版微调（不改变原内容含义）：\n' +
          '- 正文统一为宋体/12号（或等效中文正文字体/字号）；\n' +
          '- 一级标题加粗并与正文留出段前段后间距；\n' +
          '- 表格与上下文之间留出适当空行。\n' +
          '只做必要的格式调整，保证可重复执行不会越改越乱。',
      },
      {
        id: 't4_cover',
        name: '生成简洁封面条幅（审美）',
        artifactId: 'bench_finance_audit_cover',
        styleSpec: STYLE_SPECS.writer_finance_report_v1,
        asserts: [
          { type: 'writer_text_contains', text: '财务审计报告' },
          { type: 'writer_shapes_at_least', min: 1 },
        ],
        query:
          '在文档开头插入一个简洁的封面条幅：标题“财务审计报告”，副标题写“内部使用”，并在右下角写日期（今天）。\n' +
          '样式要求：标题醒目、副标题较小；整体保持商务风格，不要花哨。',
      },
    ],
  },

  {
    id: storyId('contract-review', 'wps', 'contract_story_v1'),
    suiteId: 'contract-review',
    host: 'wps',
    name: '法务合同：风险清单->审阅大纲->表格美化（Writer）',
    description: '测试法务场景下的表格/大纲生成与美化。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-合同审阅' }, { type: 'set_cursor', pos: 'start' }],
    turns: [
      {
        id: 't1_risk_table',
        name: '合同风险清单表格',
        artifactId: 'bench_contract_risk_table',
        asserts: [
          { type: 'writer_table_exists', minRows: 4, minCols: 4 },
          { type: 'writer_table_header_bold' },
          { type: 'writer_text_contains', text: '变更记录' },
          { type: 'writer_block_backup_exists' },
        ],
        query:
          '在当前光标处插入一张“合同风险清单”表格：风险点/条款位置/风险等级/建议修改。填入3行示例。\n' +
          '样式要求：表头黑体加粗；风险等级列用“高/中/低”。',
      },
      {
        id: 't2_outline',
        name: '合同审阅输出结构大纲',
        artifactId: 'bench_contract_outline',
        query: '在表格下方插入一个合同审阅输出大纲：总体意见/重点风险/修改建议/待确认事项；每项一行说明。标题用二级标题。',
      },
      {
        id: 't3_style',
        name: '美化风险清单（边框/底纹）',
        artifactId: 'bench_contract_risk_table',
        query:
          '请将上面的“合同风险清单”表格做一次美化（不新增数据）：\n' +
          '- 表头深色底+白字；\n' +
          '- 每行交替底纹；\n' +
          '- 风险等级为“高”的行用浅红底色提示。\n' +
          '要求：重复执行仍保持一致效果。',
      },
    ],
  },

  {
    id: storyId('bidding-helper', 'wps', 'bid_story_v1'),
    suiteId: 'bidding-helper',
    host: 'wps',
    name: '招投标：需求响应->证据材料->封面条幅（Writer）',
    description: '测试投标场景下的对照表、证据清单与封面美观度。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-招投标' }, { type: 'set_cursor', pos: 'start' }],
    turns: [
      {
        id: 't1_resp_table',
        name: '需求-响应对照表',
        artifactId: 'bench_bid_response_table',
        asserts: [
          { type: 'writer_table_exists', minRows: 4, minCols: 4 },
          { type: 'writer_table_header_bold' },
          { type: 'writer_text_contains', text: '变更记录' },
          { type: 'writer_block_backup_exists' },
        ],
        query:
          '在光标处插入“需求-响应对照表”表格：需求点/响应说明/证据材料/负责人。写3行示例。\n' +
          '样式要求：表头加粗；列宽合理（需求点/响应说明两列更宽）。',
      },
      {
        id: 't2_evidence',
        name: '证明文件清单（引用上表）',
        artifactId: 'bench_bid_evidence_list',
        query:
          '在文档末尾插入“证明文件清单”小节：营业执照/法人授权/财务/社保/信用；每项一行。\n' +
          '要求：每项后写“已提供/待补充”的占位状态。',
      },
      {
        id: 't3_banner',
        name: '封面条幅（艺术字/横幅）',
        artifactId: 'bench_bid_cover_banner',
        query:
          '在文档最开头插入一个封面条幅：艺术字标题“投标文件要点”，下方写一句副标题“阿蛤 自动生成示例”。\n' +
          '要求：标题居中、醒目，但不要使用表情符号。',
      },
    ],
  },

  {
    id: storyId('meeting-minutes', 'wps', 'meeting_story_v1'),
    suiteId: 'meeting-minutes',
    host: 'wps',
    name: '会议纪要：模板->行动项->结论（Writer）',
    description: '测试模板、行动项表格与结论小结，强调格式与可读性。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-会议纪要' }, { type: 'set_cursor', pos: 'start' }],
    turns: [
      {
        id: 't1_template',
        name: '会议纪要模板（含待办表格）',
        artifactId: 'bench_meeting_minutes',
        asserts: [
          { type: 'writer_table_exists', minRows: 2, minCols: 2 },
          { type: 'writer_text_contains', text: '变更记录' },
          { type: 'writer_block_backup_exists' },
        ],
        query:
          '在文档写入会议纪要模板：会议主题/时间/参会人/结论/待办(表格)。\n' +
          '样式要求：标题用二级标题；待办表格表头加粗并带边框。',
      },
      {
        id: 't2_actions',
        name: '行动项表格（追加）',
        artifactId: 'bench_meeting_actions',
        query:
          '在文档末尾追加“行动项”表格：事项/负责人/截止日期/状态，写3行示例。\n' +
          '要求：截止日期格式为 YYYY-MM-DD；状态用“未开始/进行中/已完成”。',
      },
      {
        id: 't3_summary',
        name: '会议结论小结（引用上文）',
        artifactId: 'bench_meeting_summary',
        query:
          '插入“会议结论”标题，并列出3条要点（要能与上面的行动项呼应）。\n' +
          '要求：要点用项目符号。',
      },
    ],
  },

  {
    id: storyId('policy-format', 'wps', 'policy_story_v1'),
    suiteId: 'policy-format',
    host: 'wps',
    name: '制度排版：大纲->附录->统一样式（Writer）',
    description: '测试标题层级与制度类文档排版一致性。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-制度排版' }, { type: 'set_cursor', pos: 'start' }],
    turns: [
      {
        id: 't1_outline',
        name: '制度大纲与标题层级',
        artifactId: 'bench_policy_outline',
        asserts: [
          { type: 'writer_text_contains', text: '概述' },
          { type: 'writer_text_contains', text: '变更记录' },
          { type: 'writer_block_backup_exists' },
        ],
        query:
          '在光标处插入一个三级标题大纲：1概述/2目标/3范围/4职责/5流程/6附则；每个下面一行说明。\n' +
          '要求：一级/二级/三级标题样式区分明显（字号逐级递减）。',
      },
      {
        id: 't2_appendix',
        name: '附录小节（编号条目）',
        artifactId: 'bench_policy_appendix',
        query: '在文档末尾追加“附录”小节：标题“附录”，下方插入2条编号条目。要求编号为 1、2。',
      },
      {
        id: 't3_spacing',
        name: '段落间距与统一字体',
        artifactId: 'bench_policy_spacing',
        query:
          '请统一全文排版：\n' +
          '- 正文统一宋体/12号（或等效）；\n' +
          '- 标题加粗；\n' +
          '- 每段段后 6 磅（或等效），避免段落挤在一起。\n' +
          '要求：重复执行不累积变更。',
      },
    ],
  },

  {
    id: storyId('risk-register', 'wps', 'risk_story_v1'),
    suiteId: 'risk-register',
    host: 'wps',
    name: '风险台账：表格->总结->更新表头（Writer）',
    description: '测试表格与段落结合，以及对已有产物的更新能力。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-风险台账' }, { type: 'set_cursor', pos: 'start' }],
    turns: [
      {
        id: 't1_table',
        name: '风险台账表格',
        artifactId: 'bench_risk_register_table',
        asserts: [
          { type: 'writer_table_exists', minRows: 4, minCols: 4 },
          { type: 'writer_table_header_bold' },
          { type: 'writer_text_contains', text: '变更记录' },
          { type: 'writer_block_backup_exists' },
        ],
        query:
          '插入一个小型风险台账表格：风险/影响/概率/对策。填3行。\n' +
          '样式要求：表头加粗；影响与概率列居中；表格带边框。',
      },
      {
        id: 't2_summary',
        name: '主要风险与对策小节（引用表格）',
        artifactId: 'bench_risk_summary',
        query: '在文档末尾插入“主要风险与对策”小节：标题+3条风险+对策。要求条目化、简洁。',
      },
      {
        id: 't3_update_table',
        name: '更新风险台账表头（增加状态列）',
        artifactId: 'bench_risk_register_table',
        query:
          '请把上面的风险台账表格升级为：风险点/触发条件/应对措施/责任人/状态，填3行示例。\n' +
          '要求：仍保持表格样式一致（边框/表头加粗）。',
      },
    ],
  },

  {
    id: storyId('answer-mode', 'wps', 'answer_mode_story_v1'),
    suiteId: 'answer-mode',
    host: 'wps',
    name: '答题写回：题号->括号/下划线->不改题干（Writer）',
    description: '测试 Answer Mode 写回：按题号定位占位符填答案，且不覆盖题干原文。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-答题写回' }, { type: 'set_cursor', pos: 'start' }],
    turns: [
      {
        id: 't1_answer',
        name: '按题号填答案（不改题干）',
        artifactId: 'bench_answer_mode_v1',
        actionsBeforeSend: [
          { type: 'clear_document' },
          { type: 'insert_text', text: '试题（示例）' },
          { type: 'insert_text', text: '1. 公司现金流量表属于财务报表。（ ）' },
          { type: 'insert_text', text: '2. 甲方应在（____）日内付款。' },
          { type: 'insert_text', text: '3. 合同争议解决方式：（____）仲裁。' },
        ],
        asserts: [
          { type: 'writer_text_contains', text: '公司现金流量表属于财务报表' },
          { type: 'writer_text_contains', text: '深圳' },
          { type: 'writer_text_not_contains', text: '____' },
          { type: 'writer_block_backup_exists' },
        ],
        query:
          '把第1-3题答案填到括号/下划线处：1. 对 2. 30 3. 深圳。\n' +
          '要求：只填占位符，不要改题干正文；若找不到题号或占位符要报错。',
      },
    ],
  },

  // ----------------------- ET (spreadsheets) -----------------------
  {
    id: storyId('finance-audit', 'et', 'finance_sheet_v1'),
    suiteId: 'finance-audit',
    host: 'et',
    name: '财务审计：预算->差异->趋势图（ET）',
    description: '预算表+差异计算+折线图，测试格式化与图表。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-财务ET' }],
    turns: [
      {
        id: 't1_budget',
        name: '预算 vs 实际（含差异）',
        artifactId: 'bench_et_budget',
        styleSpec: STYLE_SPECS.et_kpi_v1,
        asserts: [
          { type: 'et_freeze_panes_enabled' },
          { type: 'et_cell_number_format_not_general', a1: 'B2' },
          { type: 'et_range_conditional_formats_at_least', a1: 'D2:D5', min: 1 },
        ],
        query:
          '在A1写预算表：类别/预算/实际/差异，填4行示例，并计算差异。\n' +
          '样式要求：表头加粗；预算/实际/差异列为两位小数金额；冻结首行；差异为负数时用条件格式显示为红色或浅红底色。',
      },
      {
        id: 't2_summary',
        name: '部门费用汇总（环比%）',
        artifactId: 'bench_et_dept_summary',
        styleSpec: STYLE_SPECS.et_kpi_v1,
        query:
          '在旁边生成一张“部门费用汇总”表：部门/本月费用/上月费用/环比%，填3行并计算环比%。\n' +
          '样式要求：环比%显示百分比格式（保留1位小数）。',
      },
      {
        id: 't3_chart',
        name: '现金流趋势折线图',
        artifactId: 'bench_et_cashflow',
        styleSpec: STYLE_SPECS.et_kpi_v1,
        actionsBeforeSend: [{ type: 'ensure_sheet', name: '现金流' }, { type: 'activate_sheet', name: '现金流' }],
        asserts: [
          { type: 'et_sheet_exists', name: '现金流' },
          { type: 'et_chart_exists', min: 1 },
          { type: 'et_chart_has_title' },
        ],
        query: '创建工作表“现金流”，写入月份(1-6)与净现金流(-12/5/18/10/22/15)，并生成折线图。要求图表有标题。',
      },
      {
        id: 't4_multi_sheet_overview',
        name: '多表汇总到总览（groupby+sum）',
        artifactId: 'bench_et_multi_sheet_overview',
        styleSpec: STYLE_SPECS.et_kpi_v1,
        asserts: [
          { type: 'et_sheet_exists', name: '总览' },
          { type: 'et_freeze_panes_enabled' },
        ],
        query:
          '创建两张明细表：sheet“明细1”和“明细2”，每张都写入表头“部门/费用”，各写3行示例数据（部门可重复）。\n' +
          '然后把两张明细表按“部门”汇总到sheet“总览”（每部门费用合计+记录数），并冻结总览首行。\n' +
          '要求：优先使用 BID.summarizeSheetsToOverview({overviewSheet:\"总览\", sourceSheets:[\"明细1\",\"明细2\"], groupBy:\"部门\", sumCols:[\"费用\"]})。',
      },
    ],
  },

  {
    id: storyId('contract-review', 'et', 'clause_matrix_v1'),
    suiteId: 'contract-review',
    host: 'et',
    name: '合同审阅：条款矩阵->风险评分（ET）',
    description: '条款对照+风险评分，测试表格结构与公式。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-合同ET' }],
    turns: [
      {
        id: 't1_matrix',
        name: '条款对照表',
        artifactId: 'bench_et_clause_matrix',
        query: '生成“条款对照表”：条款标题/原文要点/风险说明/建议改写，填4行示例。',
      },
      {
        id: 't2_scoring',
        name: '风险评分表（乘积得分）',
        artifactId: 'bench_et_risk_score',
        query: '生成风险评分表：风险/影响(1-5)/概率(1-5)/得分(乘积)/对策，填4行并计算得分。',
      },
    ],
  },

  {
    id: storyId('bidding-helper', 'et', 'bid_sheet_v1'),
    suiteId: 'bidding-helper',
    host: 'et',
    name: '招投标：自查清单->里程碑（ET）',
    description: '投标文件自查清单与里程碑，测试日期与状态字段。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-投标ET' }],
    turns: [
      {
        id: 't1_checklist',
        name: '投标文件自查清单',
        artifactId: 'bench_et_bid_checklist',
        query: '生成“投标文件自查清单”表：章节/是否齐全/风险/备注，写5行示例。',
      },
      {
        id: 't2_milestones',
        name: '里程碑计划',
        artifactId: 'bench_et_milestones',
        query: '生成“投标里程碑”表：里程碑/开始日期/截止日期/负责人/状态，写4行示例。日期格式为 YYYY-MM-DD。',
      },
    ],
  },

  {
    id: storyId('meeting-minutes', 'et', 'actions_tracker_v1'),
    suiteId: 'meeting-minutes',
    host: 'et',
    name: '会议纪要：行动项跟踪表（ET）',
    description: '把会议行动项变成可跟踪表格，测试数据验证与格式。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-会议ET' }],
    turns: [
      {
        id: 't1_actions',
        name: '行动项跟踪表',
        artifactId: 'bench_et_actions',
        query:
          '在A1生成“行动项跟踪表”：事项/负责人/截止日期/状态/备注，填6行示例。\n' +
          '样式要求：截止日期列为日期格式；状态用下拉候选（如可行）：未开始/进行中/已完成。',
      },
    ],
  },

  {
    id: storyId('policy-format', 'et', 'policy_check_v1'),
    suiteId: 'policy-format',
    host: 'et',
    name: '制度排版：条款检查清单（ET）',
    description: '用表格对制度条款进行格式检查，测试条件格式。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-制度ET' }],
    turns: [
      {
        id: 't1_policy_check',
        name: '制度条款检查清单',
        artifactId: 'bench_et_policy_check',
        query:
          '生成“制度条款检查清单”表：条款/是否有标题/是否有编号/是否有日期/备注，填5行示例。\n' +
          '样式要求：表头加粗；对“否”的单元格用浅红底色提示（如可行）。',
      },
    ],
  },

  {
    id: storyId('risk-register', 'et', 'risk_register_v1'),
    suiteId: 'risk-register',
    host: 'et',
    name: '风险台账：评分->优先级（ET）',
    description: '风险台账表+评分+优先级，测试公式与排序。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-风险ET' }],
    turns: [
      {
        id: 't1_risk_table',
        name: '风险评分台账（含得分）',
        artifactId: 'bench_et_risk_register',
        styleSpec: STYLE_SPECS.et_kpi_v1,
        query:
          '生成风险台账：风险点/影响(1-5)/概率(1-5)/得分(乘积)/优先级/对策，填6行示例并计算得分。\n' +
          '要求：按得分从高到低排序（如可行）。',
      },
      {
        id: 't2_format',
        name: '高风险高亮（条件格式）',
        artifactId: 'bench_et_risk_register_format',
        styleSpec: STYLE_SPECS.et_kpi_v1,
        query:
          '对上面的风险台账做条件格式：得分>=16 的整行用浅红底色，高风险字样醒目；得分<=6 用浅绿底色。\n' +
          '要求：不新增重复表格，只对现有表做格式化。',
      },
      {
        id: 't3_chart',
        name: '风险得分柱状图',
        artifactId: 'bench_et_risk_chart',
        styleSpec: STYLE_SPECS.et_kpi_v1,
        asserts: [{ type: 'et_chart_exists', min: 1 }],
        query:
          '基于上面的风险台账，生成一个柱状图：横轴为风险点，纵轴为得分。\n' +
          '要求：图表标题“风险得分”，配色与表格风格一致。',
      },
    ],
  },

  // ----------------------- WPP (presentations) -----------------------
  {
    id: storyId('finance-audit', 'wpp', 'finance_deck_v1'),
    suiteId: 'finance-audit',
    host: 'wpp',
    name: '财务汇报：KPI->结构->结论（WPP）',
    description: '三页小型财务汇报，测试主题一致性与字号层级。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-财务WPP' }],
    turns: [
      {
        id: 't1_kpi',
        name: '财务KPI页',
        artifactId: 'bench_wpp_fin_kpi',
        styleSpec: STYLE_SPECS.wpp_bid_deck_v1,
        asserts: [
          { type: 'wpp_slide_count_at_least', min: 1 },
          { type: 'wpp_last_slide_shapes_at_least', min: 2 },
          { type: 'wpp_slide_text_contains', text: '毛利率 32%' },
          { type: 'wpp_last_slide_within_bounds', margin: 4 },
          { type: 'wpp_last_slide_no_overlap' },
        ],
        query:
          '生成1页财务KPI：大字“毛利率 32%”，下方两条说明。\n' +
          '样式要求：标题居中；大字醒目；整体配色偏蓝灰商务风。',
      },
      {
        id: 't2_structure',
        name: '费用结构页',
        artifactId: 'bench_wpp_fin_structure',
        styleSpec: STYLE_SPECS.wpp_bid_deck_v1,
        asserts: [
          { type: 'wpp_slide_count_at_least', min: 2 },
          { type: 'wpp_last_slide_shapes_at_least', min: 2 },
          { type: 'wpp_slide_text_contains', text: '费用结构' },
          { type: 'wpp_last_slide_within_bounds', margin: 4 },
          { type: 'wpp_last_slide_no_overlap' },
        ],
        query:
          '生成1页费用结构：标题“费用结构”，列出3项费用占比（示例数据）。\n' +
          '样式要求：三条要点用图标/圆点区分（如可行），版式整齐。',
      },
      {
        id: 't3_summary',
        name: '财务结论页',
        artifactId: 'bench_wpp_fin_summary',
        styleSpec: STYLE_SPECS.wpp_bid_deck_v1,
        asserts: [
          { type: 'wpp_slide_count_at_least', min: 3 },
          { type: 'wpp_last_slide_shapes_at_least', min: 2 },
          { type: 'wpp_slide_text_contains', text: '财务结论' },
          { type: 'wpp_last_slide_within_bounds', margin: 4 },
          { type: 'wpp_last_slide_no_overlap' },
        ],
        query:
          '生成1页结论：标题“财务结论”，列3条结论与1条建议。\n' +
          '样式要求：结论用加粗短句，建议用较小字号放在底部。',
      },
      {
        id: 't4_layout_two_col',
        name: '两栏图文页（对齐/分布）',
        artifactId: 'bench_wpp_fin_two_col',
        styleSpec: STYLE_SPECS.wpp_bid_deck_v1,
        asserts: [
          { type: 'wpp_slide_count_at_least', min: 4 },
          { type: 'wpp_last_slide_shapes_at_least', min: 4 },
          { type: 'wpp_slide_text_contains', text: '结构优化' },
          { type: 'wpp_last_slide_within_bounds', margin: 4 },
          { type: 'wpp_last_slide_no_overlap' },
        ],
        query:
          '再生成1页“两栏图文”版式：左侧为3条要点（带小图标/圆点），右侧放一个示意图形（用形状代替即可）。\n' +
          '要求：左右对齐、间距一致、元素分布均匀；配色与上一页一致；标题为“结构优化”。',
      },
    ],
  },

  {
    id: storyId('contract-review', 'wpp', 'contract_deck_v1'),
    suiteId: 'contract-review',
    host: 'wpp',
    name: '合同风险：风险->对策（WPP）',
    description: '合同风险要点页，测试列表与强调。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-合同WPP' }],
    turns: [
      {
        id: 't1_risk',
        name: '合同风险要点页',
        artifactId: 'bench_wpp_contract_risk',
        styleSpec: STYLE_SPECS.wpp_bid_deck_v1,
        asserts: [
          { type: 'wpp_slide_count_at_least', min: 1 },
          { type: 'wpp_last_slide_shapes_at_least', min: 2 },
          { type: 'wpp_slide_text_contains', text: '合同风险要点' },
          { type: 'wpp_last_slide_within_bounds', margin: 4 },
          { type: 'wpp_last_slide_no_overlap' },
        ],
        query:
          '生成1页合同风险：标题“合同风险要点”，列3条风险及应对建议。\n' +
          '样式要求：每条风险用“风险：… / 对策：…”两行结构；风险关键词加粗或用醒目颜色。',
      },
      {
        id: 't2_mitigation',
        name: '风险缓释方案页（承接上一页）',
        artifactId: 'bench_wpp_contract_mitigation',
        styleSpec: STYLE_SPECS.wpp_bid_deck_v1,
        asserts: [
          { type: 'wpp_slide_count_at_least', min: 2 },
          { type: 'wpp_last_slide_shapes_at_least', min: 2 },
          { type: 'wpp_slide_text_contains', text: '风险缓释方案' },
          { type: 'wpp_last_slide_within_bounds', margin: 4 },
          { type: 'wpp_last_slide_no_overlap' },
        ],
        query:
          '再生成1页“风险缓释方案”：承接上一页风险，给出3条可执行的缓释措施，并给出责任人与时间。\n' +
          '样式要求：使用表格或对齐的三列结构（措施/责任人/时间），整体商务风格。',
      },
    ],
  },

  {
    id: storyId('bidding-helper', 'wpp', 'bid_deck_v1'),
    suiteId: 'bidding-helper',
    host: 'wpp',
    name: '投标汇报：议程->优势（WPP）',
    description: '投标汇报议程页，测试商务风格与信息层级。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-投标WPP' }],
    turns: [
      {
        id: 't1_agenda',
        name: '投标汇报议程页',
        artifactId: 'bench_wpp_bid_agenda',
        styleSpec: STYLE_SPECS.wpp_bid_deck_v1,
        asserts: [
          { type: 'wpp_slide_count_at_least', min: 1 },
          { type: 'wpp_last_slide_shapes_at_least', min: 2 },
          { type: 'wpp_slide_text_contains', text: '投标汇报议程' },
          { type: 'wpp_last_slide_within_bounds', margin: 4 },
          { type: 'wpp_last_slide_no_overlap' },
        ],
        query:
          '生成1页议程：标题“投标汇报议程”，列出4个要点：背景/方案/优势/交付。\n' +
          '样式要求：标题大号；要点用两列排版（如可行）。',
      },
      {
        id: 't2_adv',
        name: '核心优势页（强调组件）',
        artifactId: 'bench_wpp_bid_advantages',
        styleSpec: STYLE_SPECS.wpp_bid_deck_v1,
        asserts: [
          { type: 'wpp_slide_count_at_least', min: 2 },
          { type: 'wpp_last_slide_shapes_at_least', min: 2 },
          { type: 'wpp_slide_text_contains', text: '核心优势' },
          { type: 'wpp_last_slide_within_bounds', margin: 4 },
          { type: 'wpp_last_slide_no_overlap' },
        ],
        query:
          '再生成1页“核心优势”：列3条优势，每条包含“优势点 + 佐证一句话”。\n' +
          '样式要求：每条优势用一个强调色的卡片/文本框突出，三条对齐一致。',
      },
      {
        id: 't3_timeline',
        name: '交付里程碑页（时间线）',
        artifactId: 'bench_wpp_bid_timeline',
        styleSpec: STYLE_SPECS.wpp_bid_deck_v1,
        asserts: [
          { type: 'wpp_slide_count_at_least', min: 3 },
          { type: 'wpp_last_slide_shapes_at_least', min: 2 },
          { type: 'wpp_slide_text_contains', text: '交付里程碑' },
          { type: 'wpp_last_slide_within_bounds', margin: 4 },
          { type: 'wpp_last_slide_no_overlap' },
        ],
        query:
          '再生成1页“交付里程碑”：用4个阶段（启动/设计/实施/验收）做一条简洁时间线。\n' +
          '样式要求：时间线对齐整齐，配色一致，标题大号。',
      },
    ],
  },

  {
    id: storyId('meeting-minutes', 'wpp', 'meeting_deck_v1'),
    suiteId: 'meeting-minutes',
    host: 'wpp',
    name: '会议纪要汇报：结论/待办/风险（WPP）',
    description: '会议纪要汇报页，测试摘要表达与对齐。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-会议WPP' }],
    turns: [
      {
        id: 't1_meeting',
        name: '会议纪要汇报页',
        artifactId: 'bench_wpp_meeting',
        styleSpec: STYLE_SPECS.wpp_bid_deck_v1,
        asserts: [
          { type: 'wpp_slide_count_at_least', min: 1 },
          { type: 'wpp_last_slide_shapes_at_least', min: 2 },
          { type: 'wpp_slide_text_contains', text: '会议纪要' },
          { type: 'wpp_last_slide_within_bounds', margin: 4 },
          { type: 'wpp_last_slide_no_overlap' },
        ],
        query:
          '生成1页会议纪要汇报：标题“会议纪要”，三条要点：结论/待办/风险。\n' +
          '样式要求：三条要点对齐一致；关键字加粗。',
      },
      {
        id: 't2_todos',
        name: '待办清单页（负责人/截止）',
        artifactId: 'bench_wpp_meeting_todos',
        styleSpec: STYLE_SPECS.wpp_bid_deck_v1,
        asserts: [
          { type: 'wpp_slide_count_at_least', min: 2 },
          { type: 'wpp_last_slide_shapes_at_least', min: 2 },
          { type: 'wpp_slide_text_contains', text: '待办清单' },
          { type: 'wpp_last_slide_within_bounds', margin: 4 },
          { type: 'wpp_last_slide_no_overlap' },
        ],
        query:
          '再生成1页“待办清单”：列3条待办，每条包含负责人和截止日期。\n' +
          '样式要求：用表格或对齐三列（事项/负责人/截止），对齐整齐。',
      },
    ],
  },

  {
    id: storyId('policy-format', 'wpp', 'policy_deck_v1'),
    suiteId: 'policy-format',
    host: 'wpp',
    name: '制度解读：要点+落地建议（WPP）',
    description: '制度要点页，测试结构化表达。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-制度WPP' }],
    turns: [
      {
        id: 't1_policy',
        name: '制度要点页',
        artifactId: 'bench_wpp_policy',
        styleSpec: STYLE_SPECS.wpp_bid_deck_v1,
        asserts: [
          { type: 'wpp_slide_count_at_least', min: 1 },
          { type: 'wpp_last_slide_shapes_at_least', min: 2 },
          { type: 'wpp_slide_text_contains', text: '制度要点' },
          { type: 'wpp_last_slide_within_bounds', margin: 4 },
          { type: 'wpp_last_slide_no_overlap' },
        ],
        query:
          '生成1页制度解读：标题“制度要点”，列出3条要点与一句落地建议。\n' +
          '样式要求：建议用强调色的文本框突出（如可行）。',
      },
      {
        id: 't2_actions',
        name: '落地动作页（分角色）',
        artifactId: 'bench_wpp_policy_actions',
        styleSpec: STYLE_SPECS.wpp_bid_deck_v1,
        asserts: [
          { type: 'wpp_slide_count_at_least', min: 2 },
          { type: 'wpp_last_slide_shapes_at_least', min: 2 },
          { type: 'wpp_slide_text_contains', text: '落地动作' },
          { type: 'wpp_last_slide_within_bounds', margin: 4 },
          { type: 'wpp_last_slide_no_overlap' },
        ],
        query:
          '再生成1页“落地动作”：按角色（管理者/执行者/审计）分别给出1条动作建议。\n' +
          '样式要求：三块对齐的卡片布局，配色统一。',
      },
    ],
  },

  {
    id: storyId('risk-register', 'wpp', 'risk_deck_v1'),
    suiteId: 'risk-register',
    host: 'wpp',
    name: '风险：主要风险页（WPP）',
    description: '风险页，测试列表与对策。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-风险WPP' }],
    turns: [
      {
        id: 't1_risk',
        name: '主要风险页',
        artifactId: 'bench_wpp_risk',
        asserts: [
          { type: 'wpp_slide_count_at_least', min: 1 },
          { type: 'wpp_last_slide_shapes_at_least', min: 2 },
          { type: 'wpp_slide_text_contains', text: '主要风险' },
          { type: 'wpp_last_slide_within_bounds', margin: 4 },
          { type: 'wpp_last_slide_no_overlap' },
        ],
        query:
          '生成1页风险：标题“主要风险”，列3条风险及对策。\n' +
          '样式要求：风险用红色强调、对策用绿色或蓝色强调（如可行）。',
      },
    ],
  },
]

export const buildChatBenchStories = (args: {
  host: MacroBenchHost
  suiteId?: MacroBenchSuiteId | 'all'
  preset?: MacroBenchPreset
}): ChatBenchStory[] => {
  const host = args.host
  const suiteId = args.suiteId || 'all'
  const preset = args.preset || 'standard'

  // Bench requires StyleSpec for regression of aesthetics. Default when a turn omitted it.
  const defaultStyleSpec = (() => {
    if (host === 'et') return STYLE_SPECS.et_kpi_v1
    if (host === 'wpp') return STYLE_SPECS.wpp_bid_deck_v1
    return STYLE_SPECS.writer_finance_report_v1
  })()

  const suiteIds: MacroBenchSuiteId[] =
    suiteId === 'all'
      ? ([
          'finance-audit',
          'contract-review',
          'bidding-helper',
          'meeting-minutes',
          'policy-format',
          'risk-register',
          'answer-mode',
        ] as MacroBenchSuiteId[])
      : ([suiteId] as MacroBenchSuiteId[])

  // Turn caps per story; keep deterministic but scale with preset.
  const maxTurns =
    preset === 'quick' ? 2 : (preset === 'standard' ? 4 : 10)

  const out: ChatBenchStory[] = []
  for (const sid of suiteIds) {
    const candidates = STORIES
      .filter(s => s.host === host && s.suiteId === sid)
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
    for (const story of candidates) {
      out.push({
        ...story,
        turns: story.turns.slice(0, Math.max(1, maxTurns)).map(t => ({
          ...t,
          styleSpec: (t as any).styleSpec || defaultStyleSpec,
        })),
      })
    }
  }
  return out
}
