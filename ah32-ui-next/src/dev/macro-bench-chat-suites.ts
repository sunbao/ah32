import { MACRO_BENCH_SUITES, type MacroBenchHost, type MacroBenchPreset, type MacroBenchSuiteId } from './macro-bench-suites'

// Chat-driven bench definitions:
// - Keep this file "data-first": real user-like prompts, deterministic sample data, style requirements.
// - Avoid embedding workaround logic here; bench should expose issues, not hide them.

export type ChatBenchAction =
  | { type: 'ensure_bench_document'; title?: string }
  | { type: 'activate_bench_document' }
  | { type: 'create_document_alias'; alias: string; title?: string }
  | { type: 'activate_document_alias'; alias: string }
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
  // Macro queue coverage (no chat; runs through store macro queue to catch cross-doc issues).
  | { type: 'enqueue_macro_queue_job'; jobAlias: string; docAlias: string; blockId: string; plan: Record<string, any> }
  | { type: 'wait_macro_queue_job'; jobAlias: string; timeoutMs?: number }
  // Dev-only tenant skills mutations (requires backend: AH32_ENABLE_DEV_ROUTES=true).
  | { type: 'dev_skills_patch_meta'; tenantId?: string; skillId: string; enabled?: boolean; priority?: number; name?: string }
  | { type: 'dev_skills_assert_primary_by_priority'; tenantId?: string; allowSkillIds: string[]; expectedPrimarySkillId: string }
  | { type: 'dev_skills_assert_meta'; tenantId?: string; skillId: string; enabled?: boolean; minPriority?: number; maxPriority?: number; nameContains?: string }

export type ChatBenchAssert =
  // Assert on assistant chat output (text-mode turns).
  | { type: 'assistant_text_contains'; text: string; points?: number }
  | { type: 'assistant_text_not_contains'; text: string; points?: number }
  | { type: 'assistant_text_matches'; pattern: string; flags?: string; points?: number }
  // Assert on document/runtime state (plan-mode turns).
  | { type: 'writer_table_exists'; minRows?: number; minCols?: number; points?: number }
  | { type: 'writer_table_header_bold'; points?: number }
  | { type: 'writer_text_contains'; text: string; points?: number }
  | { type: 'writer_text_not_contains'; text: string; points?: number }
  | { type: 'writer_heading_at_least'; level: 1 | 2 | 3; min?: number; points?: number }
  | { type: 'writer_shapes_at_least'; min: number; points?: number }
  | { type: 'writer_block_backup_exists'; blockId?: string; points?: number }
  | { type: 'skills_selected_includes'; skillId: string; points?: number }
  | { type: 'skills_selected_excludes'; skillId: string; points?: number }
  // Backward-compatible (older benches); prefer selected_* for plan SSE split.
  | { type: 'skills_applied_includes'; skillId: string; points?: number }
  | { type: 'repairs_used_at_least'; min: number; points?: number }
  | { type: 'et_sheet_exists'; name: string; points?: number }
  | { type: 'et_chart_exists'; min?: number; points?: number }
  | { type: 'et_chart_has_title'; points?: number }
  | { type: 'et_freeze_panes_enabled'; points?: number }
  | { type: 'et_cell_number_format_not_general'; a1: string; points?: number }
  | { type: 'et_range_conditional_formats_at_least'; a1: string; min: number; points?: number }
  | { type: 'wpp_slide_count_at_least'; min: number; points?: number }
  | { type: 'wpp_last_slide_shapes_at_least'; min: number; points?: number }
  | { type: 'wpp_slide_text_contains'; text: string; points?: number }
  | { type: 'wpp_placeholder_text_contains'; kind: 'title' | 'body' | 'subtitle'; text: string; index?: number; points?: number }
  | { type: 'wpp_last_slide_within_bounds'; margin?: number; points?: number }
  | { type: 'wpp_last_slide_no_overlap'; points?: number }

export type ChatBenchTurn = {
  id: string
  name: string
  // What the user "types" into the chat box.
  query: string
  // Runner-only: skip chat+plan execution, only run actions+asserts.
  // Useful for deterministic system coverage (e.g. macro queue / dev-only fixtures).
  localOnly?: boolean
  // What we expect from the assistant:
  // - plan: must output Plan JSON (then we execute + assert on document state)
  // - text: must output normal text (assert on assistant content; do NOT execute)
  // - either: accept either text or plan
  expectedOutput?: 'plan' | 'text' | 'either'
  // Optional structured style constraints for this turn.
  // The runner will pass this into backend `frontend_context.style_spec`.
  styleSpec?: Record<string, any>
  // Deterministic skill coverage: force backend primary skill for this turn.
  // Runner will pass it as `frontend_context.client_skill_selection`.
  forceSkillId?: string
  // Deterministic system coverage: bypass chat and execute this plan directly.
  // Useful for executor-only ops (rollback/delete) and deterministic repair fast-path.
  planOverride?: Record<string, any>
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
    id: storyId('system-plan-repair', 'wps', 'plan_repair_fast_path_v1'),
    suiteId: 'system-plan-repair',
    host: 'wps',
    name: 'Plan 修复：legacy upsert_block(content) -> actions（fast-path）',
    description: '用确定性的 schema 噪音触发 exec_failed，再由 /agentic/plan/repair 的 fast-path 归一化并修复。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-Plan修复' }, { type: 'clear_document' }, { type: 'set_cursor', pos: 'start' }],
    turns: [
      {
        id: 't1_repair',
        name: '执行 legacy plan（应触发 repair 并成功）',
        artifactId: 'bench_system_plan_repair_v1',
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wps',
          meta: { kind: 'bench_system_plan_repair' },
          actions: [
            {
              id: 'u1',
              title: 'Legacy upsert (content)',
              op: 'upsert_block',
              anchor: 'end',
              // Intentionally legacy field: executor rejects it, repair fast-path converts to actions[].
              content: 'REPAIR_FASTPATH_TOKEN_V1',
            },
          ],
        },
        asserts: [
          { type: 'repairs_used_at_least', min: 1, points: 2 },
          { type: 'writer_text_contains', text: 'REPAIR_FASTPATH_TOKEN_V1' },
        ],
        query: '[override]',
      },
    ],
  },

  {
    id: storyId('system-block-lifecycle', 'wps', 'block_lifecycle_v1'),
    suiteId: 'system-block-lifecycle',
    host: 'wps',
    name: '块生命周期：upsert -> update -> rollback -> delete（Writer）',
    description: '覆盖 delete_block/rollback_block 的可执行回归（不依赖模型输出）。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-块生命周期' }, { type: 'clear_document' }, { type: 'set_cursor', pos: 'start' }],
    turns: [
      {
        id: 't1_upsert_v1',
        name: '写入 V1',
        artifactId: 'bench_system_block_lifecycle_v1',
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wps',
          meta: { kind: 'bench_system_block_lifecycle' },
          actions: [
            {
              id: 'u1',
              title: 'Upsert block V1',
              op: 'upsert_block',
              block_id: 'WILL_BE_OVERRIDDEN',
              anchor: 'end',
              actions: [{ id: 't1', title: 'Insert text', op: 'insert_text', text: 'LIFECYCLE_TOKEN_V1' }],
            },
          ],
        },
        asserts: [
          { type: 'writer_text_contains', text: 'LIFECYCLE_TOKEN_V1' },
          { type: 'writer_text_not_contains', text: 'LIFECYCLE_TOKEN_V2' },
        ],
        query: '[override]',
      },
      {
        id: 't2_upsert_v2',
        name: '更新为 V2（应产生备份）',
        artifactId: 'bench_system_block_lifecycle_v1',
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wps',
          meta: { kind: 'bench_system_block_lifecycle' },
          actions: [
            {
              id: 'u2',
              title: 'Upsert block V2',
              op: 'upsert_block',
              block_id: 'WILL_BE_OVERRIDDEN',
              anchor: 'end',
              actions: [{ id: 't2', title: 'Insert text', op: 'insert_text', text: 'LIFECYCLE_TOKEN_V2' }],
            },
          ],
        },
        asserts: [
          { type: 'writer_text_contains', text: 'LIFECYCLE_TOKEN_V2' },
          { type: 'writer_text_not_contains', text: 'LIFECYCLE_TOKEN_V1' },
          { type: 'writer_block_backup_exists' },
        ],
        query: '[override]',
      },
      {
        id: 't3_rollback',
        name: '回滚到 V1',
        artifactId: 'bench_system_block_lifecycle_v1',
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wps',
          meta: { kind: 'bench_system_block_lifecycle' },
          actions: [{ id: 'rb1', title: 'Rollback block', op: 'rollback_block', block_id: 'WILL_BE_OVERRIDDEN' }],
        },
        asserts: [
          { type: 'writer_text_contains', text: 'LIFECYCLE_TOKEN_V1' },
          { type: 'writer_text_not_contains', text: 'LIFECYCLE_TOKEN_V2' },
        ],
        query: '[override]',
      },
      {
        id: 't4_delete',
        name: '删除块',
        artifactId: 'bench_system_block_lifecycle_v1',
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wps',
          meta: { kind: 'bench_system_block_lifecycle' },
          actions: [{ id: 'del1', title: 'Delete block', op: 'delete_block', block_id: 'WILL_BE_OVERRIDDEN' }],
        },
        asserts: [
          { type: 'writer_text_not_contains', text: 'LIFECYCLE_TOKEN_V1' },
          { type: 'writer_text_not_contains', text: 'LIFECYCLE_TOKEN_V2' },
        ],
        query: '[override]',
      },
    ],
  },

  {
    id: storyId('system-macro-queue', 'wps', 'cross_doc_writeback_v1'),
    suiteId: 'system-macro-queue',
    host: 'wps',
    name: '宏队列：跨文档排队写回不串写（Writer）',
    description: '覆盖宏队列按 docContext 严格激活目标文档执行：两个文档连续入队，确保不写错文档。',
    setupActions: [
      { type: 'create_document_alias', alias: 'A', title: 'Bench-Queue-A' },
      { type: 'clear_document' },
      { type: 'set_cursor', pos: 'start' },
      { type: 'insert_text', text: 'DOC_A_BASELINE', newline: true },
      { type: 'create_document_alias', alias: 'B', title: 'Bench-Queue-B' },
      { type: 'clear_document' },
      { type: 'set_cursor', pos: 'start' },
      { type: 'insert_text', text: 'DOC_B_BASELINE', newline: true },
    ],
    turns: [
      {
        id: 't1_enqueue_and_wait',
        name: '连续入队两份写回并等待执行完成',
        query: '[local]',
        localOnly: true,
        actionsBeforeSend: [
          {
            type: 'enqueue_macro_queue_job',
            jobAlias: 'jobA',
            docAlias: 'A',
            blockId: 'bench_macro_queue_A_v1',
            plan: {
              schema_version: 'ah32.plan.v1',
              host_app: 'wps',
              meta: { kind: 'bench_system_macro_queue' },
              actions: [
                {
                  id: 'u1',
                  title: 'Upsert A',
                  op: 'upsert_block',
                  block_id: 'bench_macro_queue_A_v1',
                  anchor: 'end',
                  actions: [{ id: 't1', title: 'Insert text', op: 'insert_text', text: 'MACRO_QUEUE_DOC_A_TOKEN_V1' }],
                },
              ],
            },
          },
          {
            type: 'enqueue_macro_queue_job',
            jobAlias: 'jobB',
            docAlias: 'B',
            blockId: 'bench_macro_queue_B_v1',
            plan: {
              schema_version: 'ah32.plan.v1',
              host_app: 'wps',
              meta: { kind: 'bench_system_macro_queue' },
              actions: [
                {
                  id: 'u1',
                  title: 'Upsert B',
                  op: 'upsert_block',
                  block_id: 'bench_macro_queue_B_v1',
                  anchor: 'end',
                  actions: [{ id: 't1', title: 'Insert text', op: 'insert_text', text: 'MACRO_QUEUE_DOC_B_TOKEN_V1' }],
                },
              ],
            },
          },
          { type: 'wait_macro_queue_job', jobAlias: 'jobA', timeoutMs: 45000 },
          { type: 'wait_macro_queue_job', jobAlias: 'jobB', timeoutMs: 45000 },
        ],
      },
      {
        id: 't2_assert_doc_a',
        name: '核对文档 A 只包含 A token',
        query: '[local]',
        localOnly: true,
        actionsBeforeSend: [{ type: 'activate_document_alias', alias: 'A' }],
        asserts: [
          { type: 'writer_text_contains', text: 'DOC_A_BASELINE' },
          { type: 'writer_text_contains', text: 'MACRO_QUEUE_DOC_A_TOKEN_V1' },
          { type: 'writer_text_not_contains', text: 'MACRO_QUEUE_DOC_B_TOKEN_V1' },
        ],
      },
      {
        id: 't3_assert_doc_b',
        name: '核对文档 B 只包含 B token',
        query: '[local]',
        localOnly: true,
        actionsBeforeSend: [{ type: 'activate_document_alias', alias: 'B' }],
        asserts: [
          { type: 'writer_text_contains', text: 'DOC_B_BASELINE' },
          { type: 'writer_text_contains', text: 'MACRO_QUEUE_DOC_B_TOKEN_V1' },
          { type: 'writer_text_not_contains', text: 'MACRO_QUEUE_DOC_A_TOKEN_V1' },
        ],
      },
    ],
  },

  {
    id: storyId('system-tenant-skills', 'wps', 'tenant_skills_dynamic_v1'),
    suiteId: 'system-tenant-skills',
    host: 'wps',
    name: '租户 Skills：禁用/启用/优先级冲突（dev-only）',
    description: '通过 /dev/skills/* 固定可回归地验证：禁用后不参与候选；优先级作为冲突时的确定性裁决。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-TenantSkills' }],
    turns: [
      {
        id: 't1_disable_doc_analyzer',
        name: '禁用 doc-analyzer',
        query: '[local]',
        localOnly: true,
        actionsBeforeSend: [
          { type: 'dev_skills_patch_meta', skillId: 'doc-analyzer', enabled: false },
          { type: 'dev_skills_assert_meta', skillId: 'doc-analyzer', enabled: false },
        ],
      },
      {
        id: 't2_enable_doc_analyzer',
        name: '启用 doc-analyzer（恢复）',
        query: '[local]',
        localOnly: true,
        actionsBeforeSend: [
          { type: 'dev_skills_patch_meta', skillId: 'doc-analyzer', enabled: true },
          { type: 'dev_skills_assert_meta', skillId: 'doc-analyzer', enabled: true },
        ],
      },
      {
        id: 't3_set_priority_finance_wins',
        name: '设置冲突优先级：finance-audit 赢',
        query: '[local]',
        localOnly: true,
        actionsBeforeSend: [
          { type: 'dev_skills_patch_meta', skillId: 'finance-audit', priority: 80 },
          { type: 'dev_skills_patch_meta', skillId: 'contract-review', priority: 10 },
          {
            type: 'dev_skills_assert_primary_by_priority',
            allowSkillIds: ['finance-audit', 'contract-review'],
            expectedPrimarySkillId: 'finance-audit',
          },
        ],
      },
      {
        id: 't4_restore_priority_contract_wins',
        name: '恢复默认优先级：contract-review 赢（恢复）',
        query: '[local]',
        localOnly: true,
        actionsBeforeSend: [
          // Restore defaults from installer built-ins (stable baseline).
          { type: 'dev_skills_patch_meta', skillId: 'finance-audit', priority: 30 },
          { type: 'dev_skills_patch_meta', skillId: 'contract-review', priority: 50 },
          {
            type: 'dev_skills_assert_primary_by_priority',
            allowSkillIds: ['finance-audit', 'contract-review'],
            expectedPrimarySkillId: 'contract-review',
          },
        ],
      },
    ],
  },

  {
    id: storyId('doc-analyzer', 'wps', 'doc_analyzer_v1'),
    suiteId: 'doc-analyzer',
    host: 'wps',
    name: '文档结构分析：结构报告块（Writer）',
    description: '覆盖 doc-analyzer（Plan-only）的 end-to-end 写回与执行。',
    setupActions: [
      { type: 'ensure_bench_document', title: 'Bench-文档结构分析' },
      { type: 'clear_document' },
      { type: 'set_cursor', pos: 'start' },
      {
        type: 'insert_text',
        text:
          '项目管理制度（草案）\n' +
          '1 目的\n' +
          '1.1 适用范围\n' +
          '二、职责\n' +
          '(1) 项目经理：……\n' +
          '3. 流程\n' +
          '3.1 立项\n' +
          '3.1.1 评审\n' +
          '附录A：术语\n',
      },
    ],
    turns: [
      {
        id: 't1_analyze',
        name: '生成结构报告块',
        artifactId: 'bench_doc_analyzer_report',
        forceSkillId: 'doc-analyzer',
        asserts: [
          { type: 'skills_selected_includes', skillId: 'doc-analyzer', points: 2 },
          { type: 'writer_text_contains', text: '结构大纲' },
          { type: 'writer_text_contains', text: '缺口清单' },
          { type: 'writer_text_contains', text: '自检清单' },
        ],
        query:
          '分析当前文档结构完整性与一致性问题，输出“结构报告块”（写到文末，幂等，可重复执行不重复插入）：\n' +
          '- 给出结构大纲；\n' +
          '- 缺口清单（P0/P1/P2）；\n' +
          '- 一致性问题（术语/编号/引用）；\n' +
          '- 建议整改顺序；\n' +
          '- 自检清单。\n' +
          '只输出可执行 Plan JSON。',
      },
    ],
  },

  {
    id: storyId('doc-editor', 'wps', 'doc_editor_v1'),
    suiteId: 'doc-editor',
    host: 'wps',
    name: '文档改写：对照表+修订稿块（Writer）',
    description: '覆盖 doc-editor（Plan-only）的对照表交付方式（不改原文）。',
    setupActions: [
      { type: 'ensure_bench_document', title: 'Bench-文档改写' },
      { type: 'clear_document' },
      { type: 'set_cursor', pos: 'start' },
      {
        type: 'insert_text',
        text:
          '【原文】\n' +
          '我们这个方案很牛，肯定能搞定。可能会有点风险，但问题不大。\n' +
          '交付时间看情况，资源也要再协调一下。\n',
      },
    ],
    turns: [
      {
        id: 't1_rewrite',
        name: '输出对照表+修订稿块',
        artifactId: 'bench_doc_editor_delivery',
        forceSkillId: 'doc-editor',
        asserts: [
          { type: 'skills_selected_includes', skillId: 'doc-editor', points: 2 },
          { type: 'writer_text_contains', text: '改写范围' },
          { type: 'writer_text_contains', text: '修订稿' },
        ],
        query:
          '请把上面的原文改写成“正式商务沟通”风格，但不要改动原文正文。\n' +
          '交付方式：在文末用可执行 Plan 写回一个交付块，包含：\n' +
          '1) 改写范围与假设（待确认项）；\n' +
          '2) 对照表（原文要点/建议改写/理由/风险/是否应用）；\n' +
          '3) 修订稿（可直接复制替换）。\n' +
          '只输出可执行 Plan JSON。',
      },
    ],
  },

  {
    id: storyId('doc-formatter', 'wps', 'doc_formatter_v1'),
    suiteId: 'doc-formatter',
    host: 'wps',
    name: '文档排版：规范+问题清单+模板块（Writer）',
    description: '覆盖 doc-formatter（Plan-only）的块级交付与幂等写回。',
    setupActions: [
      { type: 'ensure_bench_document', title: 'Bench-文档排版' },
      { type: 'clear_document' },
      { type: 'set_cursor', pos: 'start' },
      {
        type: 'insert_text',
        text:
          '制度文本（草案）\n' +
          '第一章 总则\n' +
          '1.1适用范围\n' +
          '第二章 术语\n' +
          '3.1 名词解释\n' +
          '（一）职责分工\n',
      },
    ],
    turns: [
      {
        id: 't1_format',
        name: '输出排版交付块',
        artifactId: 'bench_doc_formatter_delivery',
        forceSkillId: 'doc-formatter',
        asserts: [
          { type: 'skills_selected_includes', skillId: 'doc-formatter', points: 2 },
          { type: 'writer_text_contains', text: '排版规范' },
          { type: 'writer_text_contains', text: '自检清单' },
        ],
        query:
          '对当前文档给出“制度排版”交付块（写到文末，幂等，不要改动原文正文）：\n' +
          '- 排版规范（标题层级/字号/行距/编号规则）；\n' +
          '- 常见问题清单（按严重度）；\n' +
          '- 可直接替换的模板段落（范围/术语定义/职责/修订记录）；\n' +
          '- 自检清单。\n' +
          '只输出可执行 Plan JSON。',
      },
    ],
  },

  {
    id: storyId('exam-answering', 'wps', 'exam_answering_v1'),
    suiteId: 'exam-answering',
    host: 'wps',
    name: '试题答题：答案与解析写回（Writer）',
    description: '覆盖 exam-answering（Plan-only）：不改题干，文末追加答案与解析。',
    setupActions: [
      { type: 'ensure_bench_document', title: 'Bench-试题答题' },
      { type: 'clear_document' },
      { type: 'set_cursor', pos: 'start' },
      {
        type: 'insert_text',
        text:
          '《综合测试》\n' +
          '1. 选择题：下列选项中属于哺乳动物的是（ ）\n' +
          'A. 海豚  B. 鲨鱼  C. 海龟  D. 章鱼\n' +
          '2. 填空题：我国首都是______。\n' +
          '3. 阅读题：请概括“可持续发展”的两点核心内涵。\n',
      },
    ],
    turns: [
      {
        id: 't1_answer',
        name: '生成《答案与解析》',
        artifactId: 'bench_exam_answering_delivery',
        forceSkillId: 'exam-answering',
        asserts: [
          { type: 'skills_selected_includes', skillId: 'exam-answering', points: 2 },
          { type: 'writer_text_contains', text: '答案与解析' },
          { type: 'writer_text_contains', text: '1.' },
          { type: 'writer_text_contains', text: '2.' },
          { type: 'writer_text_contains', text: '3.' },
        ],
        query:
          '请替我完成本套试题：不要改动题干；在文档末尾生成《答案与解析》，按题号输出。\n' +
          '选择题只写选项字母；填空题只写填空内容；阅读题给要点式答案。\n' +
          '只输出可执行 Plan JSON。',
      },
    ],
  },

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
          { type: 'ui_click_send' },
        ],
        asserts: [
          { type: 'skills_selected_includes', skillId: 'finance-audit', points: 2 },
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
          { type: 'skills_selected_includes', skillId: 'contract-review', points: 2 },
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
          { type: 'skills_selected_includes', skillId: 'bidding-helper', points: 2 },
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
          { type: 'skills_selected_includes', skillId: 'meeting-minutes', points: 2 },
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
          { type: 'skills_selected_includes', skillId: 'policy-format', points: 2 },
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
          { type: 'skills_selected_includes', skillId: 'risk-register', points: 2 },
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
        forceSkillId: 'answer-mode',
        actionsBeforeSend: [
          { type: 'clear_document' },
          { type: 'insert_text', text: '试题（示例）' },
          { type: 'insert_text', text: '1. 公司现金流量表属于财务报表。（ ）' },
          { type: 'insert_text', text: '2. 甲方应在（____）日内付款。' },
          { type: 'insert_text', text: '3. 合同争议解决方式：（____）仲裁。' },
        ],
        asserts: [
          { type: 'skills_selected_includes', skillId: 'answer-mode', points: 2 },
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

  {
    id: storyId('answer-mode', 'wps', 'precise_locate_v1'),
    suiteId: 'answer-mode',
    host: 'wps',
    name: '精准定位：重复锚点 occurrence（Writer）',
    description: '构造两个相同锚点，要求分别在第1/第2处后插入不同文本，验证定位能力不会写错位置。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-精准定位' }, { type: 'set_cursor', pos: 'start' }],
    turns: [
      {
        id: 't1_locate',
        name: '第N处锚点定位写入',
        artifactId: 'bench_precise_locate_v1',
        forceSkillId: 'answer-mode',
        actionsBeforeSend: [
          { type: 'clear_document' },
          { type: 'insert_text', text: '段落A：这里是A【插入点】' },
          { type: 'insert_text', text: '段落B：这里是B【插入点】' },
        ],
        asserts: [
          { type: 'skills_selected_includes', skillId: 'answer-mode', points: 2 },
          { type: 'writer_text_contains', text: '段落A：这里是A【插入点】OK1' },
          { type: 'writer_text_contains', text: '段落B：这里是B【插入点】OK2' },
        ],
        query:
          '请在第1处“【插入点】”后插入文本 OK1；在第2处“【插入点】”后插入文本 OK2。\n' +
          '要求：只能在对应位置插入，不要把 OK2 插到第1处；优先使用 set_selection_by_text（occurrence=1/2）实现。',
      },
    ],
  },

  {
    id: storyId('meeting-minutes', 'wps', 'table_cell_edit_v1'),
    suiteId: 'meeting-minutes',
    host: 'wps',
    name: '表格改单元格：不新增表格（Writer）',
    description: '先插入表格，再只改指定单元格内容，验证 set_table_cell_text 能力。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-表格改单元格' }, { type: 'set_cursor', pos: 'start' }],
    turns: [
      {
        id: 't1_make_table',
        name: '插入表格（含待改单元格）',
        artifactId: 'bench_table_cell_edit_v1',
        actionsBeforeSend: [{ type: 'clear_document' }],
        asserts: [
          { type: 'writer_table_exists', minRows: 3, minCols: 3 },
          { type: 'writer_text_contains', text: '待改_CELL_22' },
        ],
        query:
          '在当前光标处插入一个 3 行 3 列表格。\n' +
          '表头：列1=事项，列2=负责人，列3=状态。\n' +
          '第2行第2列写入“待改_CELL_22”，其他单元格写简短示例值。',
      },
      {
        id: 't2_edit_cell',
        name: '只改单元格（不新增表格）',
        artifactId: 'bench_table_cell_edit_v1',
        asserts: [
          { type: 'writer_text_contains', text: '已改_CELL_22' },
          { type: 'writer_text_not_contains', text: '待改_CELL_22' },
        ],
        query:
          '请把上面那张表格的第2行第2列从“待改_CELL_22”改成“已改_CELL_22”。\n' +
          '要求：不要新增/重复插入表格；优先使用 set_table_cell_text。',
      },
    ],
  },

  // ----------------------- Writer (text-only) -----------------------
  {
    id: storyId('finance-audit', 'wps', 'audit_text_only_v1'),
    suiteId: 'finance-audit',
    host: 'wps',
    name: '财务审计：只在对话交付（Writer）',
    description: '不写回文档，验证文本交付结构与标题齐全。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-财务审计-文本' }, { type: 'set_cursor', pos: 'start' }],
    turns: [
      {
        id: 't1_text_delivery',
        name: '异常/差异清单（不写回）',
        expectedOutput: 'text',
        actionsBeforeSend: [
          { type: 'clear_document' },
          { type: 'insert_text', text: '财务明细（示例，TSV）' },
          { type: 'insert_text', text: '月份\\t收入\\t费用\\t现金流' },
          { type: 'insert_text', text: '1月\\t120\\t80\\t15' },
          { type: 'insert_text', text: '2月\\t130\\t95\\t-12' },
          { type: 'insert_text', text: '3月\\t90\\t88\\t5' },
          { type: 'insert_text', text: '4月\\t160\\t110\\t18' },
        ],
        asserts: [
          { type: 'skills_selected_includes', skillId: 'finance-audit', points: 2 },
          { type: 'assistant_text_contains', text: '范围与口径' },
          { type: 'assistant_text_contains', text: '关键发现摘要' },
          { type: 'assistant_text_contains', text: '异常/差异清单表' },
          { type: 'assistant_text_contains', text: '待办' },
          { type: 'assistant_text_contains', text: '自检' },
          { type: 'assistant_text_not_contains', text: 'ah32.plan.v1' },
        ],
        query:
          '基于当前文档的财务明细，做异常/差异分析。\n' +
          '要求：只在对话中输出，不要写回文档，也不要输出 Plan JSON。\n' +
          '输出必须包含：1) 范围与口径；2) 关键发现摘要；3) 异常/差异清单表（现象-可能原因-佐证-核验步骤）；4) 待办清单；5) 自检清单。',
      },
    ],
  },

  {
    id: storyId('contract-review', 'wps', 'contract_text_only_v1'),
    suiteId: 'contract-review',
    host: 'wps',
    name: '法务合同：只在对话交付（Writer）',
    description: '不写回，验证风险清单表/需确认问题/待办结构齐全。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-合同审阅-文本' }, { type: 'set_cursor', pos: 'start' }],
    turns: [
      {
        id: 't1_contract_text',
        name: '合同风险清单（不写回）',
        expectedOutput: 'text',
        actionsBeforeSend: [
          { type: 'clear_document' },
          { type: 'insert_text', text: '合同条款（节选）' },
          { type: 'insert_text', text: '1. 付款：甲方应在验收后 90 日内付款；逾期不承担任何违约责任。' },
          { type: 'insert_text', text: '2. 责任：乙方对任何间接损失承担无限责任。' },
          { type: 'insert_text', text: '3. 变更：甲方可单方变更范围与交付物，乙方须无条件配合。' },
          { type: 'insert_text', text: '4. 争议：争议提交甲方所在地仲裁委员会仲裁。' },
        ],
        asserts: [
          { type: 'skills_selected_includes', skillId: 'contract-review', points: 2 },
          { type: 'assistant_text_contains', text: '执行摘要' },
          { type: 'assistant_text_contains', text: '风险清单表' },
          { type: 'assistant_text_contains', text: '需确认问题' },
          { type: 'assistant_text_contains', text: '待办' },
          { type: 'assistant_text_contains', text: '自检清单' },
          { type: 'assistant_text_not_contains', text: 'ah32.plan.v1' },
        ],
        query:
          '基于当前文档的合同条款节选，做一次合同风险审阅。\n' +
          '要求：只在对话中输出，不要写回文档，也不要输出 Plan JSON。\n' +
          '输出必须包含：1) 执行摘要；2) 风险清单表（条款定位+原文摘录+风险等级+建议修改文本）；3) 需确认问题；4) 待办（Owner/优先级/DDL）；5) 自检清单。',
      },
    ],
  },

  {
    id: storyId('bidding-helper', 'wps', 'bidding_text_only_v1'),
    suiteId: 'bidding-helper',
    host: 'wps',
    name: '招投标：只在对话输出矩阵（Writer）',
    description: '不写回，验证符合性/偏离矩阵与澄清问题清单结构。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-招投标-文本' }, { type: 'set_cursor', pos: 'start' }],
    turns: [
      {
        id: 't1_matrix_text',
        name: '符合性/偏离矩阵（不写回）',
        expectedOutput: 'text',
        actionsBeforeSend: [
          { type: 'clear_document' },
          { type: 'insert_text', text: '招标文件（节选）' },
          { type: 'insert_text', text: '1. 资质要求：提供 ISO9001 证书（必须）。' },
          { type: 'insert_text', text: '2. 业绩要求：近三年类似项目不少于 2 个（必须）。' },
          { type: 'insert_text', text: '3. 交付周期：合同签订后 30 天内完成上线。' },
          { type: 'insert_text', text: '4. 售后：7*24 支持，故障 2 小时响应。' },
          { type: 'insert_text', text: '5. 评分：技术 60 分，商务 40 分；技术里含“演示效果”10分。' },
        ],
        asserts: [
          { type: 'skills_selected_includes', skillId: 'bidding-helper', points: 2 },
          { type: 'assistant_text_contains', text: '执行摘要' },
          { type: 'assistant_text_contains', text: '符合性/偏离矩阵' },
          { type: 'assistant_text_contains', text: '澄清问题清单' },
          { type: 'assistant_text_contains', text: '风险与建议' },
          { type: 'assistant_text_contains', text: '自检清单' },
          { type: 'assistant_text_not_contains', text: 'ah32.plan.v1' },
        ],
        query:
          '根据当前文档的招标要求，输出符合性/偏离矩阵，并列出需要澄清的问题。\n' +
          '要求：只在对话中输出，不要写回文档，也不要输出 Plan JSON。\n' +
          '输出必须包含并使用以下标题：1) 执行摘要；2) 符合性/偏离矩阵（含证据定位）；3) 澄清问题清单（含章节定位）；4) 风险与建议（含Owner/DDL）；5) 自检清单。',
      },
    ],
  },

  {
    id: storyId('meeting-minutes', 'wps', 'meeting_text_only_v1'),
    suiteId: 'meeting-minutes',
    host: 'wps',
    name: '会议纪要：只在对话整理（Writer）',
    description: '不写回，验证“结论/决议/待办/未决”拆解是否齐全。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-会议纪要-文本' }, { type: 'set_cursor', pos: 'start' }],
    turns: [
      {
        id: 't1_minutes_text',
        name: '输出会议纪要（不写回）',
        expectedOutput: 'text',
        actionsBeforeSend: [
          { type: 'clear_document' },
          { type: 'insert_text', text: '会议记录（节选）' },
          { type: 'insert_text', text: '时间：2026-03-01 10:00-10:30' },
          { type: 'insert_text', text: '参会：张三(产品)、李四(研发)、王五(测试)' },
          { type: 'insert_text', text: '张三：本周必须完成登录改造，否则影响验收。' },
          { type: 'insert_text', text: '李四：接口改动较大，预计需要2天联调。' },
          { type: 'insert_text', text: '王五：需要补充回归用例，尤其是写回规则。' },
          { type: 'insert_text', text: '决议：先做“租户鉴权+skills后端托管”，下周三前出版本。' },
          { type: 'insert_text', text: '待办：李四-周五前完成后端改造；王五-周五前补齐宏基准用例。' },
          { type: 'insert_text', text: '未决：前端断线重载的根因仍需定位。' },
        ],
        asserts: [
          { type: 'skills_selected_includes', skillId: 'meeting-minutes', points: 2 },
          { type: 'assistant_text_contains', text: '结论摘要' },
          { type: 'assistant_text_contains', text: '决议清单' },
          { type: 'assistant_text_contains', text: '待办表' },
          { type: 'assistant_text_contains', text: '风险与未决' },
          { type: 'assistant_text_contains', text: '自检清单' },
          { type: 'assistant_text_not_contains', text: 'ah32.plan.v1' },
        ],
        query:
          '把当前文档的会议记录整理成一份会议纪要。\n' +
          '要求：只在对话中输出，不要写回文档，也不要输出 Plan JSON。\n' +
          '输出必须包含：基本信息/结论摘要/决议清单/待办表(Owner/DDL/状态)/风险与未决/自检清单。',
      },
    ],
  },

  {
    id: storyId('policy-format', 'wps', 'policy_text_only_v1'),
    suiteId: 'policy-format',
    host: 'wps',
    name: '制度排版：只在对话交付规范（Writer）',
    description: '不写回，验证编号层级/术语一致性/模板段落与检查清单齐全。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-制度排版-文本' }, { type: 'set_cursor', pos: 'start' }],
    turns: [
      {
        id: 't1_policy_text',
        name: '结构与编号规范（不写回）',
        expectedOutput: 'text',
        actionsBeforeSend: [
          { type: 'clear_document' },
          { type: 'insert_text', text: '《采购管理办法（草案）》' },
          { type: 'insert_text', text: '一、目标：规范采购。' },
          { type: 'insert_text', text: '1 范围：适用于公司全部采购。' },
          { type: 'insert_text', text: '1.1 采购定义：以下简称“采购”。' },
          { type: 'insert_text', text: '2职责：' },
          { type: 'insert_text', text: '(1) 采购部：负责寻源；(二) 使用部门：提出需求（编号混乱）。' },
          { type: 'insert_text', text: '流程：需求->审批->下单->验收->付款（缺少留痕与追责说明）。' },
        ],
        asserts: [
          { type: 'skills_selected_includes', skillId: 'policy-format', points: 2 },
          { type: 'assistant_text_contains', text: '结构与编号规范' },
          { type: 'assistant_text_contains', text: '建议章节结构' },
          { type: 'assistant_text_contains', text: '术语/一致性/合规问题清单' },
          { type: 'assistant_text_contains', text: '关键段落模板' },
          { type: 'assistant_text_contains', text: '自检清单' },
          { type: 'assistant_text_not_contains', text: 'ah32.plan.v1' },
        ],
        query:
          '请根据当前制度草案，输出“排版与结构交付”。\n' +
          '要求：只在对话中输出，不要写回文档，也不要输出 Plan JSON。\n' +
          '输出必须包含：1) 结构与编号规范；2) 建议章节结构；3) 术语/一致性/合规问题清单（证据定位+可替换文本）；4) 关键段落模板；5) 自检清单。',
      },
    ],
  },

  {
    id: storyId('risk-register', 'wps', 'risk_text_only_v1'),
    suiteId: 'risk-register',
    host: 'wps',
    name: '风险台账：只在对话交付（Writer）',
    description: '不写回，验证风险登记表字段与口径是否齐全。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-风险台账-文本' }, { type: 'set_cursor', pos: 'start' }],
    turns: [
      {
        id: 't1_risk_text',
        name: '风险登记表（不写回）',
        expectedOutput: 'text',
        actionsBeforeSend: [
          { type: 'clear_document' },
          { type: 'insert_text', text: '风险点（原始素材）' },
          { type: 'insert_text', text: '- 接口鉴权改造可能导致旧客户端不可用' },
          { type: 'insert_text', text: '- 宏基准跑测导致 Taskpane 重载，影响体验' },
          { type: 'insert_text', text: '- 政策抓取依赖浏览器，可能被验证码拦截' },
          { type: 'insert_text', text: '- 文档快照过大，上传耗时长，可能超时' },
        ],
        asserts: [
          { type: 'skills_selected_includes', skillId: 'risk-register', points: 2 },
          { type: 'assistant_text_contains', text: '风险登记表' },
          { type: 'assistant_text_contains', text: '风险等级口径' },
          { type: 'assistant_text_contains', text: '自检清单' },
          { type: 'assistant_text_not_contains', text: 'ah32.plan.v1' },
        ],
        query:
          '把当前文档的风险点整理成“风险台账交付”：必须包含风险登记表、风险等级口径、Top 风险摘要与建议、自检清单。\n' +
          '要求：只在对话中输出，不要写回文档，也不要输出 Plan JSON。',
      },
    ],
  },

  // ----------------------- Writer (plan/writeback) -----------------------
  {
    id: storyId('doc-analyzer', 'wps', 'doc_analyzer_v2'),
    suiteId: 'doc-analyzer',
    host: 'wps',
    name: '文档结构分析：结构报告块写回（Writer）',
    description: '构造编号/术语问题，验证 doc-analyzer 只输出可执行 Plan JSON 并写回块。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-文档结构分析' }, { type: 'set_cursor', pos: 'start' }],
    turns: [
      {
        id: 't1_analyze',
        name: '结构报告+问题清单（写回块）',
        artifactId: 'bench_doc_analyzer_report',
        forceSkillId: 'doc-analyzer',
        asserts: [
          { type: 'writer_text_contains', text: '结构大纲' },
          { type: 'writer_text_contains', text: '缺口清单' },
          { type: 'writer_block_backup_exists' },
        ],
        actionsBeforeSend: [
          { type: 'insert_text', text: '《项目方案（草案）》' },
          { type: 'insert_text', text: '1 背景' },
          { type: 'insert_text', text: '1.1 现状：目前存在性能瓶颈。' },
          { type: 'insert_text', text: '2 目标：降低响应时间、提升稳定性。' },
          { type: 'insert_text', text: '4 方案：采用分层架构。（注意：缺少第3章）' },
          { type: 'insert_text', text: '4.1 技术路线：服务拆分。' },
          { type: 'insert_text', text: '术语：SLA/服务等级协议/Service Level Agreement 混用。' },
        ],
        query:
          '分析这份文档结构是否完整，输出问题清单并写回一个报告块（文末 upsert_block）。\n' +
          '要求：只输出可执行 Plan JSON（schema_version="ah32.plan.v1", host_app="wps"），不要输出任何额外文字。',
      },
    ],
  },

  {
    id: storyId('doc-editor', 'wps', 'doc_editor_v2'),
    suiteId: 'doc-editor',
    host: 'wps',
    name: '文档改写：对照表+修订稿块（Writer）',
    description: '验证 doc-editor 的对照表交付与幂等写回。',
    setupActions: [
      { type: 'ensure_bench_document', title: 'Bench-文档改写' },
      { type: 'set_cursor', pos: 'start' },
    ],
    turns: [
      {
        id: 't1_rewrite',
        name: '改写并写回对照表+修订稿',
        artifactId: 'bench_doc_editor_delivery',
        forceSkillId: 'doc-editor',
        asserts: [
          { type: 'skills_selected_includes', skillId: 'doc-editor', points: 2 },
          { type: 'writer_text_contains', text: '改写范围' },
          { type: 'writer_text_contains', text: '修订稿' },
          { type: 'writer_block_backup_exists' },
        ],
        actionsBeforeSend: [
          { type: 'insert_text', text: '原文：我们公司很厉害，这个项目肯定能做好，尽快上线。' },
          { type: 'insert_text', text: '要求：语气正式，面向客户汇报。' },
        ],
        query:
          '请把上面的原文改写成“正式商务沟通、面向客户汇报”风格，但不要直接改原文正文。\n' +
          '交付方式：把文末已有交付块幂等更新为同一个块；若该块不存在则创建。块内容必须包含：\n' +
          '1) 改写范围与假设；\n' +
          '2) 对照表（原文要点/建议改写/理由/风险等级/是否应用）；\n' +
          '3) 修订稿（可直接复制替换）。\n' +
          '只输出可执行 Plan JSON（schema_version="ah32.plan.v1", host_app="wps"），不要输出任何额外文字。',
      },
    ],
  },

  {
    id: storyId('doc-formatter', 'wps', 'doc_formatter_v2'),
    suiteId: 'doc-formatter',
    host: 'wps',
    name: '文档排版：排版规范块（Writer）',
    description: '验证 doc-formatter 输出排版规范/检查清单块（不做全篇改样式）。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-文档排版' }, { type: 'set_cursor', pos: 'start' }],
    turns: [
      {
        id: 't1_rules',
        name: '生成排版规范+检查清单块',
        artifactId: 'bench_doc_formatter_delivery',
        forceSkillId: 'doc-formatter',
        asserts: [
          { type: 'skills_selected_includes', skillId: 'doc-formatter', points: 2 },
          { type: 'writer_text_contains', text: '排版规范' },
          { type: 'writer_text_contains', text: '检查清单' },
          { type: 'writer_block_backup_exists' },
        ],
        actionsBeforeSend: [
          { type: 'insert_text', text: '标题：项目周报' },
          { type: 'insert_text', text: '一、进展' },
          { type: 'insert_text', text: '1) 已完成：接口联调' },
          { type: 'insert_text', text: '2) 风险：测试不足' },
          { type: 'insert_text', text: '二. 下周计划（编号风格不一致）' },
          { type: 'insert_text', text: '备注：本文档没有目录，标题层级也不统一。' },
        ],
        query:
          '基于本文档内容，生成“排版规范/检查清单/模板段落”块并写回文末（upsert_block）。\n' +
          '要求：不要尝试全篇改样式，只做块级交付；标题至少包含“排版规范”“检查清单”“模板段落”；只输出可执行 Plan JSON（schema_version="ah32.plan.v1", host_app="wps"）。',
      },
    ],
  },

  {
    id: storyId('exam-answering', 'wps', 'exam_answering_v2'),
    suiteId: 'exam-answering',
    host: 'wps',
    name: '试题答题：答案与解析写回（Writer）',
    description: '不改题干，在文末追加《答案与解析》块（幂等写回）。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-试题答题' }, { type: 'set_cursor', pos: 'start' }],
    turns: [
      {
        id: 't1_answer',
        name: '生成答案与解析（写回文末）',
        artifactId: 'bench_exam_answering_delivery',
        asserts: [
          { type: 'writer_text_contains', text: '答案与解析' },
          { type: 'writer_text_contains', text: '1.' },
          { type: 'writer_block_backup_exists' },
        ],
        actionsBeforeSend: [
          { type: 'insert_text', text: '试题（示例）' },
          { type: 'insert_text', text: '1. 选择题：地球是圆的。（ ）A.对 B.错' },
          { type: 'insert_text', text: '2. 填空题：我国首都是______。' },
          { type: 'insert_text', text: '3. 简答题：用不超过50字概括“坚持”的含义。' },
        ],
        query:
          '请替我完成本套试题：不要改动题干；在文档末尾生成《答案与解析》，按题号输出。\n' +
          '要求：只输出可执行 Plan JSON（schema_version="ah32.plan.v1", host_app="wps"），不要输出任何额外文字。',
      },
    ],
  },

  // ----------------------- ET (spreadsheets) -----------------------
  {
    id: storyId('et-analyzer', 'et', 'et_analyzer_v1'),
    suiteId: 'et-analyzer',
    host: 'et',
    name: 'ET 数据分析：透视+排序+格式化（ET）',
    description: '覆盖 et-analyzer（Plan-only）的分析落地与执行成功。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-ET分析' }, { type: 'clear_document' }],
    turns: [
      {
        id: 't1_analyze',
        name: '生成分析结果（透视）',
        artifactId: 'bench_et_analyzer_delivery',
        forceSkillId: 'et-analyzer',
        asserts: [{ type: 'skills_selected_includes', skillId: 'et-analyzer', points: 2 }],
        query:
          '在当前工作表创建一份示例“销售明细”（至少20行，字段：日期/部门/产品/金额），并做一次分析：\n' +
          '1) 生成一个“分析结果总览”sheet（用 upsert_block），包含数据概览、异常摘要、待确认项；\n' +
          '2) 生成透视表：按部门汇总金额；\n' +
          '3) 金额列设置为非 General 的数字格式。\n' +
          '只输出可执行 Plan JSON。',
      },
    ],
  },

  {
    id: storyId('et-visualizer', 'et', 'et_visualizer_v1'),
    suiteId: 'et-visualizer',
    host: 'et',
    name: 'ET 可视化：做图+标题（ET）',
    description: '覆盖 et-visualizer（Plan-only）的做图落地与执行。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-ET可视化' }, { type: 'clear_document' }],
    turns: [
      {
        id: 't1_chart',
        name: '生成折线图（带标题）',
        artifactId: 'bench_et_visualizer_delivery',
        forceSkillId: 'et-visualizer',
        asserts: [
          { type: 'skills_selected_includes', skillId: 'et-visualizer', points: 2 },
          { type: 'et_chart_exists', min: 1 },
          { type: 'et_chart_has_title' },
        ],
        query:
          '在当前工作表生成示例数据：月份(1-6) 与 净现金流(-12/5/18/10/22/15)，并生成折线图。\n' +
          '要求：图表标题写“净现金流趋势”。\n' +
          '只输出可执行 Plan JSON。',
      },
    ],
  },

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

  {
    id: storyId('et-analyzer', 'et', 'et_analyzer_v2'),
    suiteId: 'et-analyzer',
    host: 'et',
    name: 'ET数据分析：明细->透视->图表（ET）',
    description: '覆盖 et-analyzer：生成明细数据，做透视汇总并出图。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-ET分析' }],
    turns: [
      {
        id: 't1_seed',
        name: '写入销售明细表（含冻结首行）',
        artifactId: 'bench_et_analyzer_seed',
        styleSpec: STYLE_SPECS.et_kpi_v1,
        asserts: [{ type: 'et_freeze_panes_enabled' }],
        query:
          '在Sheet1的A1生成销售明细表：月份/部门/金额。填8行示例（1-4月*两个部门），金额为数字。\n' +
          '要求：冻结首行；金额列设置为¥金额格式（如可行）。\n' +
          '输出可执行 Plan JSON（schema_version="ah32.plan.v1", host_app="et"）。',
      },
      {
        id: 't2_pivot',
        name: '透视汇总到“汇总”并插入柱状图',
        artifactId: 'bench_et_analyzer_pivot',
        styleSpec: STYLE_SPECS.et_kpi_v1,
        asserts: [{ type: 'et_sheet_exists', name: '汇总' }, { type: 'et_chart_exists', min: 1 }],
        query:
          '基于上面的销售明细表，生成透视汇总到新工作表“汇总”：按部门汇总金额，并插入柱状图。\n' +
          '要求：汇总表表头加粗；图表标题“部门金额汇总”。\n' +
          '输出可执行 Plan JSON（schema_version="ah32.plan.v1", host_app="et"）。',
      },
    ],
  },

  {
    id: storyId('et-visualizer', 'et', 'et_visualizer_v2'),
    suiteId: 'et-visualizer',
    host: 'et',
    name: 'ET可视化：占比饼图->趋势折线（ET）',
    description: '覆盖 et-visualizer：结构占比与趋势图表。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-ET可视化' }],
    turns: [
      {
        id: 't1_pie',
        name: '费用结构饼图（占比%）',
        artifactId: 'bench_et_visualizer_pie',
        styleSpec: STYLE_SPECS.et_kpi_v1,
        asserts: [{ type: 'et_chart_exists', min: 1 }],
        query:
          '在A1生成费用结构表：类别/金额，填5行示例，并插入饼图显示占比（显示百分比）。\n' +
          '要求：图表标题“费用结构”。\n' +
          '输出可执行 Plan JSON（schema_version="ah32.plan.v1", host_app="et"）。',
      },
      {
        id: 't2_trend',
        name: '销售趋势折线图',
        artifactId: 'bench_et_visualizer_trend',
        styleSpec: STYLE_SPECS.et_kpi_v1,
        asserts: [{ type: 'et_chart_exists', min: 1 }],
        query:
          '在旁边再生成月份趋势数据：月份(1-6)/销售额，填6行示例，并插入折线图。\n' +
          '要求：图表标题“销售趋势”。\n' +
          '输出可执行 Plan JSON（schema_version="ah32.plan.v1", host_app="et"）。',
      },
    ],
  },

  // ----------------------- WPP (presentations) -----------------------
  {
    id: storyId('ppt-creator', 'wpp', 'ppt_creator_v1'),
    suiteId: 'ppt-creator',
    host: 'wpp',
    name: 'PPT 一键创建：直接生成幻灯片（WPP）',
    description: '覆盖 ppt-creator（Plan-only）直接创建 PPT 的链路。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-PPT创建' }, { type: 'clear_document' }],
    turns: [
      {
        id: 't1_create',
        name: '创建 3 页 PPT',
        artifactId: 'bench_ppt_creator_delivery',
        forceSkillId: 'ppt-creator',
        asserts: [
          { type: 'skills_selected_includes', skillId: 'ppt-creator', points: 2 },
          { type: 'wpp_slide_count_at_least', min: 3 },
          { type: 'wpp_placeholder_text_contains', kind: 'title', text: '项目汇报' },
        ],
        query:
          '一键创建 3 页 PPT（直接创建到 WPS PPT 里，输出可执行 Plan）：\n' +
          '1) 封面：标题“项目汇报”，副标题“内部使用”；\n' +
          '2) 目录：列 4 个要点；\n' +
          '3) 结论：列 3 条结论与下一步。\n' +
          '只输出可执行 Plan JSON。',
      },
    ],
  },

  {
    id: storyId('ppt-outline', 'wpp', 'ppt_outline_v1'),
    suiteId: 'ppt-outline',
    host: 'wpp',
    name: 'PPT 大纲讲稿：显式要求创建（WPP）',
    description: '覆盖 ppt-outline：当用户明确要求创建 PPT 时输出 Plan 并落地。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-PPT大纲' }, { type: 'clear_document' }],
    turns: [
      {
        id: 't1_outline_create',
        name: '逐页大纲 + 创建 PPT（Plan）',
        artifactId: 'bench_ppt_outline_delivery',
        forceSkillId: 'ppt-outline',
        asserts: [
          { type: 'skills_selected_includes', skillId: 'ppt-outline', points: 2 },
          { type: 'wpp_slide_count_at_least', min: 4 },
        ],
        query:
          '给我做一份 4 页汇报 PPT（逐页大纲与讲稿的风格），并且直接创建到 WPS PPT：请输出可执行 Plan。\n' +
          '结构建议：背景/问题/方案/下一步。每页 ≤ 5 条要点。\n' +
          '只输出可执行 Plan JSON。',
      },
    ],
  },

  {
    id: storyId('wpp-outline', 'wpp', 'wpp_outline_v1'),
    suiteId: 'wpp-outline',
    host: 'wpp',
    name: 'WPP 版式：版式+占位符填充（WPP）',
    description: '覆盖 wpp-outline（Plan-only）：版式相关 Plan 生成与执行。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-WPP版式' }, { type: 'clear_document' }],
    turns: [
      {
        id: 't1_layout',
        name: '创建 2 页并填充占位符',
        artifactId: 'bench_wpp_outline_delivery',
        forceSkillId: 'wpp-outline',
        asserts: [
          { type: 'skills_selected_includes', skillId: 'wpp-outline', points: 2 },
          { type: 'wpp_slide_count_at_least', min: 2 },
          { type: 'wpp_placeholder_text_contains', kind: 'title', text: '版式测试' },
        ],
        query:
          '创建 2 页 PPT，并尽量使用占位符填充（标题/正文），同时设置合适版式：\n' +
          '1) 标题页：标题“版式测试”，副标题“占位符填充”；\n' +
          '2) 内容页：标题“要点”，列 4 条要点。\n' +
          '只输出可执行 Plan JSON。',
      },
    ],
  },

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
    id: storyId('bidding-helper', 'wpp', 'placeholder_fill_v1'),
    suiteId: 'bidding-helper',
    host: 'wpp',
    name: '占位符填充：标题/正文（WPP）',
    description: '优先填占位符（标题/正文），减少坐标猜测导致的重叠/越界。',
    setupActions: [
      { type: 'ensure_bench_document', title: 'Bench-WPP占位符' },
      { type: 'ensure_slide', index: 1 },
      { type: 'select_slide', index: 1 },
    ],
    turns: [
      {
        id: 't1_fill',
        name: '填充标题与正文占位符',
        artifactId: 'bench_wpp_placeholder_fill_v1',
        styleSpec: STYLE_SPECS.wpp_bid_deck_v1,
        asserts: [
          { type: 'wpp_slide_count_at_least', min: 1 },
          { type: 'wpp_placeholder_text_contains', kind: 'title', text: '占位符标题_TEST' },
          { type: 'wpp_placeholder_text_contains', kind: 'body', text: '要点1' },
          { type: 'wpp_last_slide_within_bounds', margin: 4 },
          { type: 'wpp_last_slide_no_overlap' },
        ],
        query:
          '请在第1页完成占位符填充：\n' +
          '- 标题占位符写入“占位符标题_TEST”；\n' +
          '- 正文占位符写 3 条要点：要点1/要点2/要点3。\n' +
          '要求：优先使用 fill_placeholder（strict=true），不要用坐标去猜位置。',
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

  {
    id: storyId('ppt-outline', 'wpp', 'ppt_outline_mixed_v1'),
    suiteId: 'ppt-outline',
    host: 'wpp',
    name: 'PPT大纲：纯文字->自动创建（WPP）',
    description: '先做纯文字交付，再触发自动模式创建PPT（Plan）。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-PPT大纲' }],
    turns: [
      {
        id: 't1_text_outline',
        name: '逐页大纲+讲稿（不创建）',
        expectedOutput: 'text',
        asserts: [
          { type: 'skills_selected_includes', skillId: 'ppt-outline', points: 2 },
          { type: 'assistant_text_contains', text: '目标与受众' },
          { type: 'assistant_text_contains', text: '叙事主线' },
          { type: 'assistant_text_contains', text: '逐页大纲表' },
          { type: 'assistant_text_contains', text: '讲稿' },
          { type: 'assistant_text_contains', text: '主题与版式建议' },
          { type: 'assistant_text_contains', text: '自检清单' },
          { type: 'assistant_text_not_contains', text: 'ah32.plan.v1' },
        ],
        query:
          '给我做一份10页的汇报PPT大纲，并写逐页讲稿（每页1分钟）。\n' +
          '材料（节选）：我们要做“招投标助手”，目标用户是采购与投标团队；核心卖点是合规检查、政策更新、写回Plan稳定。\n' +
          '要求：只在对话中输出，不要创建/生成PPT，不要输出 Plan JSON。',
      },
      {
        id: 't2_auto_create',
        name: '自动创建PPT（Plan写回）',
        artifactId: 'bench_ppt_outline_auto_v1',
        styleSpec: STYLE_SPECS.wpp_bid_deck_v1,
        asserts: [
          { type: 'wpp_slide_count_at_least', min: 6 },
          { type: 'wpp_last_slide_shapes_at_least', min: 2 },
          { type: 'wpp_slide_text_contains', text: '结论' },
          { type: 'wpp_last_slide_within_bounds', margin: 4 },
          { type: 'wpp_last_slide_no_overlap' },
        ],
        query:
          '把下面材料直接生成一份6页PPT并自动创建（最后一页标题必须包含“结论”）。\n' +
          '材料：产品发布汇报，主题“招投标助手”，结构：背景/痛点/方案/优势/落地/结论。\n' +
          '要求：只输出可执行 Plan JSON（schema_version="ah32.plan.v1", host_app="wpp"）。',
      },
    ],
  },

  {
    id: storyId('ppt-review', 'wpp', 'ppt_review_text_v1'),
    suiteId: 'ppt-review',
    host: 'wpp',
    name: 'PPT审稿：只在对话输出问题清单（WPP）',
    description: '验证 ppt-review 的结构化审稿交付，不输出 Plan JSON。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-PPT审稿' }],
    turns: [
      {
        id: 't1_review_text',
        name: '审稿输出（不写回）',
        expectedOutput: 'text',
        asserts: [
          { type: 'skills_selected_includes', skillId: 'ppt-review', points: 2 },
          { type: 'assistant_text_contains', text: '问题概览' },
          { type: 'assistant_text_contains', text: '逐页问题清单' },
          { type: 'assistant_text_contains', text: '版式与一致性规范' },
          { type: 'assistant_text_contains', text: '材料缺口清单' },
          { type: 'assistant_text_contains', text: '自检清单' },
          { type: 'assistant_text_not_contains', text: 'ah32.plan.v1' },
        ],
        query:
          '帮我审一下这份PPT（按下面逐页文本），指出逻辑漏洞、信息缺口和排版问题，并给可直接替换的修改建议。\n' +
          '逐页：\n' +
          '1) 标题：项目介绍；要点：我们很强。\n' +
          '2) 标题：方案；要点：方案A、方案B（无数据支撑）。\n' +
          '3) 标题：结论；要点：请批准预算。\n' +
          '要求：只在对话中输出，不要写回，也不要输出 Plan JSON。',
      },
    ],
  },

  {
    id: storyId('ppt-creator', 'wpp', 'ppt_creator_v2'),
    suiteId: 'ppt-creator',
    host: 'wpp',
    name: 'PPT一键创建：6页自动生成（WPP）',
    description: '覆盖 ppt-creator：只输出 Plan JSON 并创建幻灯片。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-PPT一键创建' }],
    turns: [
      {
        id: 't1_create',
        name: '创建6页PPT（Plan）',
        artifactId: 'bench_ppt_creator_v1',
        styleSpec: STYLE_SPECS.wpp_bid_deck_v1,
        asserts: [
          { type: 'wpp_slide_count_at_least', min: 6 },
          { type: 'wpp_last_slide_shapes_at_least', min: 2 },
          { type: 'wpp_last_slide_within_bounds', margin: 4 },
          { type: 'wpp_last_slide_no_overlap' },
        ],
        query:
          '根据这段材料，一键生成一份6页PPT并自动创建（最后一页写“结论与下一步”）。\n' +
          '材料：主题“产品发布”，要点：背景/问题/方案/优势/交付/结论。\n' +
          '要求：只输出可执行 Plan JSON（schema_version="ah32.plan.v1", host_app="wpp"）。',
      },
    ],
  },

  {
    id: storyId('wpp-outline', 'wpp', 'wpp_outline_v2'),
    suiteId: 'wpp-outline',
    host: 'wpp',
    name: 'WPP版式助手：标题页/目录页/两栏页（WPP）',
    description: '覆盖 wpp-outline：版式选择与占位写入。',
    setupActions: [{ type: 'ensure_bench_document', title: 'Bench-WPP版式助手' }],
    turns: [
      {
        id: 't1_layout',
        name: '创建3页并填入示例文本（Plan）',
        artifactId: 'bench_wpp_outline_v1',
        styleSpec: STYLE_SPECS.wpp_bid_deck_v1,
        asserts: [
          { type: 'wpp_slide_count_at_least', min: 3 },
          { type: 'wpp_last_slide_shapes_at_least', min: 3 },
          { type: 'wpp_slide_text_contains', text: '两栏' },
          { type: 'wpp_last_slide_within_bounds', margin: 4 },
          { type: 'wpp_last_slide_no_overlap' },
        ],
        query:
          '创建3页PPT：标题页/目录页/两栏内容页；选择合适版式并填入示例文本（两栏页标题包含“两栏”）。\n' +
          '要求：只输出可执行 Plan JSON（schema_version="ah32.plan.v1", host_app="wpp"）。',
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
      ? (MACRO_BENCH_SUITES.map(s => s.id) as MacroBenchSuiteId[])
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
