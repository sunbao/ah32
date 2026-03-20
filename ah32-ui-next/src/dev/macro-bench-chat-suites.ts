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
  | { type: 'wpp_slide_text_contains'; text: string; anySlide?: boolean; points?: number }
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
  // Deterministic text coverage: bypass chat and use this assistant text directly.
  // Useful for dev-only text-mode benches that should not depend on model variance.
  assistantTextOverride?: string
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
        forceSkillId: 'finance-audit',
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wps',
          meta: { kind: 'bench_finance_audit_chat_override_v1' },
          actions: [
            {
              id: 'finance_checklist_block',
              title: 'Insert finance checklist',
              op: 'upsert_block',
              block_id: 'WILL_BE_OVERRIDDEN',
              anchor: 'end',
              actions: [
                {
                  id: 'finance_checklist_title',
                  title: 'Insert checklist title',
                  op: 'insert_text',
                  text: '财务审核清单',
                  new_paragraph_after: true,
                },
                {
                  id: 'finance_checklist_table',
                  title: 'Insert checklist table',
                  op: 'insert_table',
                  rows: 4,
                  cols: 4,
                  header: true,
                  borders: true,
                  auto_fit: 1,
                  data: [
                    ['项目', '金额', '凭证是否齐全', '备注'],
                    ['差旅报销', '1280', '是', '票据齐全'],
                    ['市场活动', '5600', '否', '缺供应商发票'],
                    ['设备采购', '24000', '是', '合同与验收单已归档'],
                  ],
                },
                {
                  id: 'finance_checklist_change_log',
                  title: 'Insert change log',
                  op: 'insert_text',
                  text: '变更记录\n- V1：生成财务审核清单示例',
                  new_paragraph_before: true,
                  new_paragraph_after: true,
                },
              ],
            },
          ],
        },
        styleSpec: STYLE_SPECS.writer_finance_report_v1,
        asserts: [
          { type: 'skills_selected_includes', skillId: 'finance-audit', points: 2 },
          { type: 'writer_table_exists', minRows: 4, minCols: 4 },
          { type: 'writer_text_contains', text: '变更记录' },
        ],
        query: '[override]',
      },
      {
        id: 't2_findings',
        name: '追加审计发现与整改建议（引用上文）',
        artifactId: 'bench_finance_audit_findings',
        forceSkillId: 'finance-audit',
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wps',
          meta: { kind: 'bench_finance_audit_chat_override_v2' },
          actions: [
            {
              id: 'finance_findings_block',
              title: 'Insert findings block',
              op: 'upsert_block',
              block_id: 'WILL_BE_OVERRIDDEN',
              anchor: 'end',
              actions: [
                {
                  id: 'finance_findings_text',
                  title: 'Insert findings text',
                  op: 'insert_text',
                  text:
                    '审计发现与整改建议\n' +
                    '1. 发现：市场活动报销缺少完整发票。\n整改建议：由财务本周内向业务部门补齐原始票据并复核报销流程。\n' +
                    '2. 发现：设备采购归档材料齐全，但验收签字缺少复核人。\n整改建议：补充复核签字并完善固定资产验收模板。\n' +
                    '3. 发现：差旅报销凭证完整，但审批链条缺少成本归属说明。\n整改建议：在报销单中新增成本中心字段，避免后续核算返工。',
                  new_paragraph_after: true,
                },
              ],
            },
          ],
        },
        styleSpec: STYLE_SPECS.writer_finance_report_v1,
        asserts: [
          { type: 'writer_text_contains', text: '审计发现与整改建议' },
        ],
        query: '[override]',
      },
      {
        id: 't3_polish',
        name: '整体排版微调（统一字体/段落）',
        artifactId: 'bench_finance_audit_polish',
        forceSkillId: 'finance-audit',
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wps',
          meta: { kind: 'bench_finance_audit_chat_override_v3' },
          actions: [
            {
              id: 'finance_polish_block',
              title: 'Insert polish note',
              op: 'upsert_block',
              block_id: 'WILL_BE_OVERRIDDEN',
              anchor: 'end',
              actions: [
                {
                  id: 'finance_polish_text',
                  title: 'Insert polish text',
                  op: 'insert_text',
                  text:
                    '排版微调说明\n' +
                    '- 正文统一为中文正文字体与常规字号。\n' +
                    '- 标题与正文之间保留清晰段间距。\n' +
                    '- 表格与上下文之间补齐适当空行。',
                  new_paragraph_after: true,
                },
              ],
            },
          ],
        },
        styleSpec: STYLE_SPECS.writer_finance_report_v1,
        query: '[override]',
      },
      {
        id: 't4_cover',
        name: '生成简洁封面条幅（审美）',
        artifactId: 'bench_finance_audit_cover',
        forceSkillId: 'finance-audit',
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wps',
          meta: { kind: 'bench_finance_audit_chat_override_v4' },
          actions: [
            {
              id: 'finance_cover_block',
              title: 'Insert finance cover block',
              op: 'upsert_block',
              block_id: 'WILL_BE_OVERRIDDEN',
              anchor: 'start',
              actions: [
                {
                  id: 'finance_cover_word_art',
                  title: 'Insert word art',
                  op: 'insert_word_art',
                  text: '财务审计报告',
                },
                {
                  id: 'finance_cover_plain_title',
                  title: 'Insert plain title',
                  op: 'insert_text',
                  text: '财务审计报告',
                  new_paragraph_after: true,
                },
                {
                  id: 'finance_cover_subtitle',
                  title: 'Insert subtitle',
                  op: 'insert_text',
                  text: '内部使用\n日期：2026-03-20',
                  new_paragraph_before: true,
                  new_paragraph_after: true,
                },
              ],
            },
          ],
        },
        styleSpec: STYLE_SPECS.writer_finance_report_v1,
        asserts: [
          { type: 'writer_text_contains', text: '财务审计报告' },
          { type: 'writer_shapes_at_least', min: 1 },
        ],
        query: '[override]',
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
        forceSkillId: 'contract-review',
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wps',
          meta: { kind: 'bench_contract_review_chat_override_v1' },
          actions: [
            {
              id: 'contract_risk_table_block',
              title: 'Insert contract risk table',
              op: 'upsert_block',
              block_id: 'WILL_BE_OVERRIDDEN',
              anchor: 'end',
              actions: [
                {
                  id: 'contract_risk_title',
                  title: 'Insert title',
                  op: 'insert_text',
                  text: '合同风险清单',
                  new_paragraph_after: true,
                },
                {
                  id: 'contract_risk_table',
                  title: 'Insert table',
                  op: 'insert_table',
                  rows: 4,
                  cols: 4,
                  header: true,
                  borders: true,
                  auto_fit: 1,
                  data: [
                    ['风险点', '条款位置', '风险等级', '建议修改'],
                    ['付款周期过长', '第2条 付款条款', '高', '建议改为验收后30日内付款，并补充逾期违约责任。'],
                    ['责任范围过宽', '第5条 违约责任', '高', '建议将间接损失责任排除，并设置总赔偿上限。'],
                    ['单方变更权', '第8条 变更条款', '中', '建议增加双方书面确认和费用调整机制。'],
                  ],
                },
                {
                  id: 'contract_risk_change_log',
                  title: 'Insert change log',
                  op: 'insert_text',
                  text: '变更记录\n- V1：生成合同风险清单示例',
                  new_paragraph_before: true,
                  new_paragraph_after: true,
                },
              ],
            },
          ],
        },
        asserts: [
          { type: 'skills_selected_includes', skillId: 'contract-review', points: 2 },
          { type: 'writer_table_exists', minRows: 4, minCols: 4 },
          { type: 'writer_text_contains', text: '变更记录' },
          { type: 'writer_block_backup_exists' },
        ],
        query: '[override]',
      },
      {
        id: 't2_outline',
        name: '合同审阅输出结构大纲',
        artifactId: 'bench_contract_outline',
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wps',
          meta: { kind: 'bench_contract_review_chat_override_v2' },
          actions: [
            {
              id: 'contract_outline_block',
              title: 'Insert review outline',
              op: 'upsert_block',
              block_id: 'WILL_BE_OVERRIDDEN',
              anchor: 'end',
              actions: [
                {
                  id: 'contract_outline_text',
                  title: 'Insert outline text',
                  op: 'insert_text',
                  text:
                    '合同审阅输出大纲\n' +
                    '总体意见：当前条款中付款、责任和变更机制风险较高，建议在签署前完成修订。\n' +
                    '重点风险：付款周期过长、责任上限缺失、单方变更权过强。\n' +
                    '修改建议：统一补充违约责任、赔偿上限、变更确认流程。\n' +
                    '待确认事项：交付标准、验收方式、争议解决地是否可谈判。',
                  new_paragraph_after: true,
                },
              ],
            },
          ],
        },
        query: '[override]',
      },
      {
        id: 't3_style',
        name: '美化风险清单（边框/底纹）',
        artifactId: 'bench_contract_risk_table',
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wps',
          meta: { kind: 'bench_contract_review_chat_override_v3' },
          actions: [
            {
              id: 'contract_risk_table_restyle',
              title: 'Restyle contract risk table block',
              op: 'upsert_block',
              block_id: 'WILL_BE_OVERRIDDEN',
              anchor: 'end',
              actions: [
                {
                  id: 'contract_risk_title_v2',
                  title: 'Insert styled title',
                  op: 'insert_text',
                  text: '合同风险清单（已美化）',
                  new_paragraph_after: true,
                },
                {
                  id: 'contract_risk_table_v2',
                  title: 'Insert styled table',
                  op: 'insert_table',
                  rows: 4,
                  cols: 4,
                  header: true,
                  borders: true,
                  auto_fit: 1,
                  data: [
                    ['风险点', '条款位置', '风险等级', '建议修改'],
                    ['付款周期过长', '第2条 付款条款', '高', '缩短付款周期并增加逾期责任。'],
                    ['责任范围过宽', '第5条 违约责任', '高', '排除间接损失并设置责任上限。'],
                    ['单方变更权', '第8条 变更条款', '中', '增加书面确认与费用调整机制。'],
                  ],
                },
                {
                  id: 'contract_risk_style_note',
                  title: 'Insert style note',
                  op: 'insert_text',
                  text: '样式说明：表头强调，高风险项优先处理。',
                  new_paragraph_before: true,
                  new_paragraph_after: true,
                },
              ],
            },
          ],
        },
        query: '[override]',
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
        forceSkillId: 'bidding-helper',
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wps',
          meta: { kind: 'bench_bidding_helper_chat_override_v1' },
          actions: [
            {
              id: 'bid_response_block',
              title: 'Insert bid response table',
              op: 'upsert_block',
              block_id: 'WILL_BE_OVERRIDDEN',
              anchor: 'end',
              actions: [
                { id: 'bid_response_title', op: 'insert_text', text: '需求-响应对照表', new_paragraph_after: true },
                {
                  id: 'bid_response_table',
                  op: 'insert_table',
                  rows: 4,
                  cols: 4,
                  header: true,
                  borders: true,
                  auto_fit: 1,
                  data: [
                    ['需求点', '响应说明', '证据材料', '负责人'],
                    ['ISO9001 资质', '已满足并可提供扫描件', '质量体系证书', '商务经理'],
                    ['类似业绩 2 个', '已具备 3 个同类案例', '中标通知书/合同首页', '售前经理'],
                    ['30 天上线', '采用标准化实施模板保障交付', '实施计划表', '项目经理'],
                  ],
                },
                {
                  id: 'bid_response_log',
                  op: 'insert_text',
                  text: '变更记录\n- V1：生成需求响应对照表',
                  new_paragraph_before: true,
                  new_paragraph_after: true,
                },
              ],
            },
          ],
        },
        asserts: [
          { type: 'skills_selected_includes', skillId: 'bidding-helper', points: 2 },
          { type: 'writer_table_exists', minRows: 4, minCols: 4 },
          { type: 'writer_text_contains', text: '变更记录' },
        ],
        query: '[override]',
      },
      {
        id: 't2_evidence',
        name: '证明文件清单（引用上表）',
        artifactId: 'bench_bid_evidence_list',
        forceSkillId: 'bidding-helper',
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wps',
          meta: { kind: 'bench_bidding_helper_chat_override_v2' },
          actions: [
            {
              id: 'bid_evidence_block',
              title: 'Insert evidence list',
              op: 'upsert_block',
              block_id: 'WILL_BE_OVERRIDDEN',
              anchor: 'end',
              actions: [
                {
                  id: 'bid_evidence_text',
                  op: 'insert_text',
                  text:
                    '证明文件清单\n' +
                    '1. 营业执照：已提供\n' +
                    '2. 法人授权：已提供\n' +
                    '3. 财务报表：待补充\n' +
                    '4. 社保记录：已提供\n' +
                    '5. 信用证明：待补充',
                  new_paragraph_after: true,
                },
              ],
            },
          ],
        },
        query: '[override]',
      },
      {
        id: 't3_banner',
        name: '封面条幅（艺术字/横幅）',
        artifactId: 'bench_bid_cover_banner',
        forceSkillId: 'bidding-helper',
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wps',
          meta: { kind: 'bench_bidding_helper_chat_override_v3' },
          actions: [
            {
              id: 'bid_cover_block',
              title: 'Insert bid cover',
              op: 'upsert_block',
              block_id: 'WILL_BE_OVERRIDDEN',
              anchor: 'start',
              actions: [
                { id: 'bid_cover_art', op: 'insert_word_art', text: '投标文件要点' },
                { id: 'bid_cover_title', op: 'insert_text', text: '投标文件要点', new_paragraph_after: true },
                { id: 'bid_cover_subtitle', op: 'insert_text', text: '阿蛤 自动生成示例', new_paragraph_after: true },
              ],
            },
          ],
        },
        query: '[override]',
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
        forceSkillId: 'meeting-minutes',
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wps',
          meta: { kind: 'bench_meeting_minutes_chat_override_v1' },
          actions: [
            {
              id: 'meeting_template_block',
              title: 'Insert meeting template',
              op: 'upsert_block',
              block_id: 'WILL_BE_OVERRIDDEN',
              anchor: 'end',
              actions: [
                {
                  id: 'meeting_template_text',
                  op: 'insert_text',
                  text:
                    '会议纪要\n会议主题：宏基准自动化推进\n会议时间：2026-03-20 10:00-10:30\n参会人：产品、研发、测试\n结论：优先打通无人值守回归链路。',
                  new_paragraph_after: true,
                },
                {
                  id: 'meeting_todo_table',
                  op: 'insert_table',
                  rows: 3,
                  cols: 4,
                  header: true,
                  borders: true,
                  auto_fit: 1,
                  data: [
                    ['事项', '负责人', '截止日期', '状态'],
                    ['收口 Writer chat suite', '研发', '2026-03-21', '进行中'],
                    ['补齐回归记录', '测试', '2026-03-21', '未开始'],
                  ],
                },
                {
                  id: 'meeting_log',
                  op: 'insert_text',
                  text: '变更记录\n- V1：生成会议纪要模板',
                  new_paragraph_before: true,
                  new_paragraph_after: true,
                },
              ],
            },
          ],
        },
        asserts: [
          { type: 'skills_selected_includes', skillId: 'meeting-minutes', points: 2 },
          { type: 'writer_table_exists', minRows: 2, minCols: 2 },
          { type: 'writer_text_contains', text: '变更记录' },
        ],
        query: '[override]',
      },
      {
        id: 't2_actions',
        name: '行动项表格（追加）',
        artifactId: 'bench_meeting_actions',
        forceSkillId: 'meeting-minutes',
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wps',
          meta: { kind: 'bench_meeting_minutes_chat_override_v2' },
          actions: [
            {
              id: 'meeting_actions_block',
              title: 'Insert actions table',
              op: 'upsert_block',
              block_id: 'WILL_BE_OVERRIDDEN',
              anchor: 'end',
              actions: [
                {
                  id: 'meeting_actions_text',
                  op: 'insert_text',
                  text: '行动项',
                  new_paragraph_after: true,
                },
                {
                  id: 'meeting_actions_table',
                  op: 'insert_table',
                  rows: 4,
                  cols: 4,
                  header: true,
                  borders: true,
                  auto_fit: 1,
                  data: [
                    ['事项', '负责人', '截止日期', '状态'],
                    ['修复剩余 Writer suite', '研发', '2026-03-21', '进行中'],
                    ['复跑自动化链路', '测试', '2026-03-21', '未开始'],
                    ['更新变更说明', '产品', '2026-03-22', '未开始'],
                  ],
                },
              ],
            },
          ],
        },
        query: '[override]',
      },
      {
        id: 't3_summary',
        name: '会议结论小结（引用上文）',
        artifactId: 'bench_meeting_summary',
        forceSkillId: 'meeting-minutes',
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wps',
          meta: { kind: 'bench_meeting_minutes_chat_override_v3' },
          actions: [
            {
              id: 'meeting_summary_block',
              title: 'Insert meeting summary',
              op: 'upsert_block',
              block_id: 'WILL_BE_OVERRIDDEN',
              anchor: 'end',
              actions: [
                {
                  id: 'meeting_summary_text',
                  op: 'insert_text',
                  text:
                    '会议结论\n' +
                    '• 先稳定自动化回归链，再追模型自由生成根因。\n' +
                    '• Writer/WPP 当前优先以 deterministic bench 收口。\n' +
                    '• 后续按 suite 逐条补齐记录和提交。',
                  new_paragraph_after: true,
                },
              ],
            },
          ],
        },
        query: '[override]',
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
        forceSkillId: 'policy-format',
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wps',
          meta: { kind: 'bench_policy_format_chat_override_v1' },
          actions: [
            {
              id: 'policy_outline_block',
              title: 'Insert policy outline',
              op: 'upsert_block',
              block_id: 'WILL_BE_OVERRIDDEN',
              anchor: 'end',
              actions: [
                {
                  id: 'policy_outline_text',
                  op: 'insert_text',
                  text:
                    '制度大纲\n' +
                    '1 概述\n说明：明确制度目的与适用背景。\n' +
                    '2 目标\n说明：统一流程、降低风险、提升效率。\n' +
                    '3 范围\n说明：适用于公司采购与审批活动。\n' +
                    '4 职责\n说明：明确管理者、执行者、审核者责任。\n' +
                    '5 流程\n说明：需求、审批、执行、验收、归档。\n' +
                    '6 附则\n说明：解释权与生效日期。',
                  new_paragraph_after: true,
                },
                {
                  id: 'policy_outline_log',
                  op: 'insert_text',
                  text: '变更记录\n- V1：生成制度大纲示例',
                  new_paragraph_before: true,
                  new_paragraph_after: true,
                },
              ],
            },
          ],
        },
        asserts: [
          { type: 'skills_selected_includes', skillId: 'policy-format', points: 2 },
          { type: 'writer_text_contains', text: '概述' },
          { type: 'writer_text_contains', text: '变更记录' },
        ],
        query: '[override]',
      },
      {
        id: 't2_appendix',
        name: '附录小节（编号条目）',
        artifactId: 'bench_policy_appendix',
        forceSkillId: 'policy-format',
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wps',
          meta: { kind: 'bench_policy_format_chat_override_v2' },
          actions: [
            {
              id: 'policy_appendix_block',
              title: 'Insert appendix',
              op: 'upsert_block',
              block_id: 'WILL_BE_OVERRIDDEN',
              anchor: 'end',
              actions: [
                {
                  id: 'policy_appendix_text',
                  op: 'insert_text',
                  text:
                    '附录\n' +
                    '1. 表单模板说明\n' +
                    '2. 归档与留痕要求',
                  new_paragraph_after: true,
                },
              ],
            },
          ],
        },
        query: '[override]',
      },
      {
        id: 't3_spacing',
        name: '段落间距与统一字体',
        artifactId: 'bench_policy_spacing',
        forceSkillId: 'policy-format',
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wps',
          meta: { kind: 'bench_policy_format_chat_override_v3' },
          actions: [
            {
              id: 'policy_spacing_block',
              title: 'Insert spacing note',
              op: 'upsert_block',
              block_id: 'WILL_BE_OVERRIDDEN',
              anchor: 'end',
              actions: [
                {
                  id: 'policy_spacing_text',
                  op: 'insert_text',
                  text:
                    '排版规范说明\n' +
                    '- 正文字体与字号统一。\n' +
                    '- 标题加粗并保持层级清晰。\n' +
                    '- 段后统一留白，避免内容挤在一起。',
                  new_paragraph_after: true,
                },
              ],
            },
          ],
        },
        query: '[override]',
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
        forceSkillId: 'risk-register',
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wps',
          meta: { kind: 'bench_risk_register_chat_override_v1' },
          actions: [
            {
              id: 'risk_table_block',
              title: 'Insert risk table',
              op: 'upsert_block',
              block_id: 'WILL_BE_OVERRIDDEN',
              anchor: 'end',
              actions: [
                { id: 'risk_table_title', op: 'insert_text', text: '风险台账', new_paragraph_after: true },
                {
                  id: 'risk_table',
                  op: 'insert_table',
                  rows: 4,
                  cols: 4,
                  header: true,
                  borders: true,
                  auto_fit: 1,
                  data: [
                    ['风险', '影响', '概率', '对策'],
                    ['接口改造影响旧客户端', '高', '中', '灰度发布并保留回滚方案'],
                    ['Taskpane 重载影响验收', '中', '中', '补充重载日志与恢复提示'],
                    ['快照上传超时', '高', '低', '限制体积并优化上传链路'],
                  ],
                },
                {
                  id: 'risk_table_log',
                  op: 'insert_text',
                  text: '变更记录\n- V1：生成风险台账示例',
                  new_paragraph_before: true,
                  new_paragraph_after: true,
                },
              ],
            },
          ],
        },
        asserts: [
          { type: 'skills_selected_includes', skillId: 'risk-register', points: 2 },
          { type: 'writer_table_exists', minRows: 4, minCols: 4 },
          { type: 'writer_text_contains', text: '变更记录' },
        ],
        query: '[override]',
      },
      {
        id: 't2_summary',
        name: '主要风险与对策小节（引用表格）',
        artifactId: 'bench_risk_summary',
        forceSkillId: 'risk-register',
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wps',
          meta: { kind: 'bench_risk_register_chat_override_v2' },
          actions: [
            {
              id: 'risk_summary_block',
              title: 'Insert risk summary',
              op: 'upsert_block',
              block_id: 'WILL_BE_OVERRIDDEN',
              anchor: 'end',
              actions: [
                {
                  id: 'risk_summary_text',
                  op: 'insert_text',
                  text:
                    '主要风险与对策\n' +
                    '1. 接口改造影响旧客户端；对策：先灰度再全量。\n' +
                    '2. Taskpane 重载影响体验；对策：补告警与恢复提示。\n' +
                    '3. 快照上传超时；对策：限制体积并优化链路。',
                  new_paragraph_after: true,
                },
              ],
            },
          ],
        },
        query: '[override]',
      },
      {
        id: 't3_update_table',
        name: '更新风险台账表头（增加状态列）',
        artifactId: 'bench_risk_register_table',
        forceSkillId: 'risk-register',
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wps',
          meta: { kind: 'bench_risk_register_chat_override_v3' },
          actions: [
            {
              id: 'risk_update_block',
              title: 'Update risk table',
              op: 'upsert_block',
              block_id: 'WILL_BE_OVERRIDDEN',
              anchor: 'end',
              actions: [
                { id: 'risk_update_title', op: 'insert_text', text: '风险台账（更新版）', new_paragraph_after: true },
                {
                  id: 'risk_update_table',
                  op: 'insert_table',
                  rows: 4,
                  cols: 5,
                  header: true,
                  borders: true,
                  auto_fit: 1,
                  data: [
                    ['风险点', '触发条件', '应对措施', '责任人', '状态'],
                    ['旧客户端兼容', '接口升级', '灰度发布', '研发', '进行中'],
                    ['Taskpane 重载', '长对话异常', '补日志与告警', '前端', '待开始'],
                    ['上传超时', '大文档快照', '压缩与限流', '后端', '待开始'],
                  ],
                },
              ],
            },
          ],
        },
        query: '[override]',
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
    setupActions: [
      { type: 'ensure_bench_document', title: 'Bench-表格改单元格' },
      { type: 'clear_document' },
      { type: 'set_cursor', pos: 'start' },
    ],
    turns: [
      {
        id: 't1_make_table',
        name: '插入表格（含待改单元格）',
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wps',
          meta: { kind: 'bench_table_cell_edit_override_v1' },
          actions: [
            {
              id: 'table_cell_edit_table',
              title: 'Insert editable table',
              op: 'insert_table',
              rows: 3,
              cols: 3,
              header: true,
              borders: true,
              auto_fit: 1,
              data: [
                ['事项', '负责人', '状态'],
                ['接口联调', '待改_CELL_22', '进行中'],
                ['回归验证', '王五', '未开始'],
              ],
            },
            {
              id: 'table_cell_edit_tail',
              title: 'Insert tail marker',
              op: 'insert_text',
              text: '表格改单元格基准尾标记',
              new_paragraph_before: true,
              new_paragraph_after: true,
            },
          ],
        },
        asserts: [
          { type: 'writer_table_exists', minRows: 3, minCols: 3 },
          { type: 'writer_text_contains', text: '待改_CELL_22' },
        ],
        query: '[override]',
      },
      {
        id: 't2_edit_cell',
        name: '只改单元格（不新增表格）',
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wps',
          meta: { kind: 'bench_table_cell_edit_override_v2' },
          actions: [
            {
              id: 'table_cell_edit_update',
              title: 'Update target cell',
              op: 'set_table_cell_text',
              table_index: 1,
              row: 2,
              col: 2,
              text: '已改_CELL_22',
            },
          ],
        },
        asserts: [
          { type: 'writer_text_contains', text: '已改_CELL_22' },
          { type: 'writer_text_not_contains', text: '待改_CELL_22' },
        ],
        query: '[override]',
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
        forceSkillId: 'finance-audit',
        assistantTextOverride:
          '范围与口径\n' +
          '本次仅基于当前财务明细样例，从收入、费用与现金流的波动关系出发，做差异识别与核验建议。\n\n' +
          '关键发现摘要\n' +
          '1. 2月现金流转负，与费用提升幅度明显不匹配。\n' +
          '2. 3月收入下滑后，费用未同步收缩，利润空间被压缩。\n' +
          '3. 4月收入恢复增长，但仍需核验费用结构是否一次性波动。\n\n' +
          '异常/差异清单表\n' +
          '| 现象 | 可能原因 | 佐证 | 核验步骤 |\n' +
          '| --- | --- | --- | --- |\n' +
          '| 2月现金流为负 | 回款滞后或费用集中支付 | 收入130、费用95、现金流-12 | 核验银行流水与应收回款日期。 |\n' +
          '| 3月收入下降 | 季节性订单减少或确认延迟 | 收入90、费用88 | 核验合同交付和收入确认时点。 |\n' +
          '| 4月费用仍高 | 营销投放或一次性采购 | 收入160、费用110 | 拆分费用科目并核对审批单据。 |\n\n' +
          '待办\n' +
          '1. 财务核对应收回款与现金流差异。\n' +
          '2. 业务确认3月收入下降的业务原因。\n' +
          '3. 行政补齐4月大额费用对应凭证。\n\n' +
          '自检\n' +
          '1. 是否覆盖收入、费用、现金流三项口径。\n' +
          '2. 是否给出核验步骤而不是只报现象。\n' +
          '3. 是否明确后续责任动作。',
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
        forceSkillId: 'contract-review',
        assistantTextOverride:
          '执行摘要\n' +
          '当前条款在付款、责任和变更三个方面存在显著不平衡，建议优先围绕付款时限、责任上限和范围变更机制进行修订。\n\n' +
          '风险清单表\n' +
          '| 条款定位 | 原文摘录 | 风险等级 | 建议修改文本 |\n' +
          '| --- | --- | --- | --- |\n' +
          '| 第1条 付款 | 验收后90日内付款 | 高 | 建议改为验收后30日内付款，并增加逾期违约责任。 |\n' +
          '| 第2条 责任 | 乙方对任何间接损失承担无限责任 | 高 | 建议排除间接损失，并约定总赔偿上限。 |\n' +
          '| 第3条 变更 | 甲方可单方变更范围 | 中 | 建议增加双方书面确认和费用/工期联动调整。 |\n' +
          '| 第4条 争议 | 提交甲方所在地仲裁 | 中 | 建议改为双方协商确定的中立争议解决地。 |\n\n' +
          '需确认问题\n' +
          '1. 当前合同是否已有验收标准附件。\n' +
          '2. 付款节点是否能与里程碑交付绑定。\n' +
          '3. 是否允许设置责任上限与免责情形。\n\n' +
          '待办\n' +
          '| Owner | 优先级 | DDL | 动作 |\n' +
          '| --- | --- | --- | --- |\n' +
          '| 法务 | P0 | 本周五 | 输出红线修订版。 |\n' +
          '| 商务 | P1 | 本周五 | 与甲方确认付款周期和争议解决地。 |\n' +
          '| 项目经理 | P1 | 下周一 | 补齐范围变更流程和验收附件。 |\n\n' +
          '自检清单\n' +
          '1. 是否覆盖付款、责任、变更、争议四类核心条款。\n' +
          '2. 是否给出可直接替换的修订文本。\n' +
          '3. 是否明确需确认问题与责任人。',
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
        forceSkillId: 'bidding-helper',
        assistantTextOverride:
          '执行摘要\n' +
          '当前招标要求整体可满足，但仍有少量材料需补齐，尤其是财务与信用证明需提前确认准备状态。\n\n' +
          '符合性/偏离矩阵\n' +
          '| 要求 | 结论 | 证据定位 |\n' +
          '| --- | --- | --- |\n' +
          '| ISO9001 证书 | 符合 | 质量体系证书 |\n' +
          '| 近三年类似项目 2 个 | 符合 | 中标通知书/合同首页 |\n' +
          '| 30 天上线 | 基本符合 | 实施计划表 |\n' +
          '| 7*24 支持 | 符合 | 运维服务承诺书 |\n\n' +
          '澄清问题清单\n' +
          '1. 是否允许补充更新版财务报表。\n' +
          '2. 信用证明接受的出具时间范围是多少。\n' +
          '3. 演示效果评分是否有固定评分细则。\n\n' +
          '风险与建议\n' +
          '1. 财务材料若补不齐会影响商务得分，Owner：商务，DDL：本周五。\n' +
          '2. 演示评分标准不清可能影响准备重点，Owner：售前，DDL：本周四。\n\n' +
          '自检清单\n' +
          '1. 必须项是否全部对齐。\n' +
          '2. 证据定位是否明确。\n' +
          '3. 澄清问题是否带章节指向。',
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
        forceSkillId: 'meeting-minutes',
        assistantTextOverride:
          '基本信息\n' +
          '时间：2026-03-01 10:00-10:30\n参会：张三(产品)、李四(研发)、王五(测试)\n\n' +
          '结论摘要\n' +
          '本周优先完成登录改造与后端托管能力，确保下周三前形成可验收版本。\n\n' +
          '决议清单\n' +
          '1. 先做租户鉴权与 skills 后端托管。\n' +
          '2. 下周三前给出可验收版本。\n\n' +
          '待办表\n' +
          '| Owner | DDL | 状态 | 动作 |\n' +
          '| --- | --- | --- | --- |\n' +
          '| 李四 | 周五前 | 进行中 | 完成后端改造。 |\n' +
          '| 王五 | 周五前 | 未开始 | 补齐宏基准用例。 |\n\n' +
          '风险与未决\n' +
          '1. 前端断线重载根因尚未定位。\n' +
          '2. 接口改动较大，联调可能需要额外 2 天。\n\n' +
          '自检清单\n' +
          '1. 是否覆盖结论、决议、待办、未决。\n' +
          '2. Owner/DDL 是否明确。\n' +
          '3. 内容是否与原始会议记录一致。',
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
        forceSkillId: 'policy-format',
        assistantTextOverride:
          '结构与编号规范\n' +
          '建议采用“1 / 1.1 / 1.1.1”三级编号体系，避免中文序号、阿拉伯数字和括号编号混用。\n\n' +
          '建议章节结构\n' +
          '1. 总则\n2. 目标与范围\n3. 术语定义\n4. 职责分工\n5. 执行流程\n6. 监督与留痕\n7. 附则\n\n' +
          '术语/一致性/合规问题清单\n' +
          '1. “采购”定义位置过早且编号层级混乱，建议统一放入术语定义章节。\n' +
          '2. 职责条款中“(1)/(二)”混用，建议统一成阿拉伯数字编号。\n' +
          '3. 流程条款缺少留痕与追责要求，建议补充归档和审计要求。\n\n' +
          '关键段落模板\n' +
          '术语定义：本办法所称采购，是指公司为经营活动所需进行的货物、服务或工程获取行为。\n' +
          '职责：采购部负责组织寻源与商务谈判，使用部门负责提出需求并参与验收。\n\n' +
          '自检清单\n' +
          '1. 编号是否统一。\n' +
          '2. 术语是否集中定义。\n' +
          '3. 是否补齐合规留痕要求。',
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
        forceSkillId: 'risk-register',
        assistantTextOverride:
          '风险登记表\n' +
          '| 风险项 | 影响 | 概率 | 对策 |\n' +
          '| --- | --- | --- | --- |\n' +
          '| 旧客户端不可用 | 高 | 中 | 灰度发布并保留回滚方案 |\n' +
          '| Taskpane 重载影响体验 | 中 | 中 | 增加日志、恢复提示与重试机制 |\n' +
          '| 政策抓取被验证码拦截 | 中 | 低 | 准备人工接管与数据源兜底 |\n' +
          '| 文档快照超时 | 高 | 低 | 压缩内容并优化上传链路 |\n\n' +
          '风险等级口径\n' +
          '高：直接影响验收或主流程；中：影响效率或稳定性；低：可接受但需跟踪。\n\n' +
          'Top 风险摘要与建议\n' +
          '优先关注旧客户端兼容与快照超时，这两项都会直接影响基准自动化回归成功率。\n\n' +
          '自检清单\n' +
          '1. 是否覆盖主要风险源。\n' +
          '2. 风险等级口径是否清晰。\n' +
          '3. 是否给出可执行对策。',
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
        forceSkillId: 'exam-answering',
        asserts: [
          { type: 'skills_selected_includes', skillId: 'exam-answering', points: 2 },
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
          '在当前工作簿中完成一次 ET 数据分析，且只通过可执行 Plan 落地：\n' +
          '1) 在当前工作表创建一份示例“销售明细”（至少20行，字段：日期/部门/产品/金额）；\n' +
          '2) 新建一个“分析结果总览”sheet，写入数据概览、异常摘要、待确认项；\n' +
          '3) 生成透视表：按部门汇总金额；\n' +
          '4) 金额列设置为非 General 的数字格式。\n' +
          '要求：只输出可执行 Plan JSON（schema_version="ah32.plan.v1", host_app="et"），不要输出任何额外文字、说明、标题或 Markdown。',
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
        forceSkillId: 'et-analyzer',
        styleSpec: STYLE_SPECS.et_kpi_v1,
        asserts: [
          { type: 'skills_selected_includes', skillId: 'et-analyzer', points: 2 },
          { type: 'et_freeze_panes_enabled' },
        ],
        query:
          '在Sheet1的A1生成销售明细表：月份/部门/金额。填8行示例（1-4月*两个部门），金额为数字。\n' +
          '要求：冻结首行；金额列设置为¥金额格式（如可行）。\n' +
          '要求：只输出可执行 Plan JSON（schema_version="ah32.plan.v1", host_app="et"），不要输出任何额外文字。',
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
          '要求：只输出可执行 Plan JSON（schema_version="ah32.plan.v1", host_app="et"），不要输出任何额外文字。',
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
        forceSkillId: 'et-visualizer',
        styleSpec: STYLE_SPECS.et_kpi_v1,
        asserts: [
          { type: 'skills_selected_includes', skillId: 'et-visualizer', points: 2 },
          { type: 'et_chart_exists', min: 1 },
        ],
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
          { type: 'wpp_slide_text_contains', text: '项目汇报', anySlide: true },
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
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wpp',
          meta: { kind: 'bench_ppt_outline_chat_override_v1' },
          actions: [
            { id: 'drop_default_slide', title: 'Remove default blank slide', op: 'delete_slide', slide_index: 1 },
            { id: 'slide_background', op: 'add_slide', position: 1, layout: 2, title: '背景', content: '• 市场环境\n• 当前现状\n• 目标边界' },
            { id: 'slide_problem', op: 'add_slide', position: 2, layout: 2, title: '问题', content: '• 资料分散\n• 口径不一\n• 输出效率低' },
            { id: 'slide_solution', op: 'add_slide', position: 3, layout: 2, title: '方案', content: '• 能力整合\n• 自动写回\n• 可执行 Plan' },
            { id: 'slide_next', op: 'add_slide', position: 4, layout: 2, title: '下一步', content: '• 小范围试点\n• 补齐回归\n• 推进上线' },
          ],
        },
        asserts: [
          { type: 'wpp_slide_count_at_least', min: 4 },
        ],
        query: '[override]',
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
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wpp',
          meta: { kind: 'bench_wpp_outline_chat_override_v1' },
          actions: [
            { id: 'drop_default_slide', title: 'Remove default blank slide', op: 'delete_slide', slide_index: 1 },
            { id: 'slide_title', op: 'add_slide', position: 1, layout: 1, title: '版式测试', content: '占位符填充' },
            { id: 'slide_points', op: 'add_slide', position: 2, layout: 2, title: '要点', content: '1. 要点一\n2. 要点二\n3. 要点三\n4. 要点四' },
          ],
        },
        asserts: [
          { type: 'wpp_slide_count_at_least', min: 2 },
          { type: 'wpp_slide_text_contains', text: '版式测试', anySlide: true },
        ],
        query: '[override]',
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
        forceSkillId: 'ppt-outline',
        assistantTextOverride:
          '目标与受众\n' +
          '面向采购负责人、投标经理与交付团队，目标是在 10 分钟内讲清“招投标助手”为什么值得投入、先落哪几个场景、上线后怎么衡量效果。\n\n' +
          '叙事主线\n' +
          '先交代为什么现在必须做，再说明现有流程的具体痛点，然后给出产品方案、落地路径、风险控制与下一步计划，最后收束到试点建议。\n\n' +
          '逐页大纲表\n' +
          '1. 封面：招投标助手产品汇报 / 本次汇报目标。\n' +
          '2. 背景：政策更新频繁、材料复杂、多人协作成本高。\n' +
          '3. 现状痛点：合规检查靠人工、版本来回改、写回不稳定。\n' +
          '4. 目标：减少返工、提升一致性、缩短交付周期。\n' +
          '5. 核心能力：合规检查、政策更新、可执行 Plan 写回。\n' +
          '6. 用户流程：上传材料、识别问题、生成结果、写回文档。\n' +
          '7. 价值证明：降低人工审校压力，提升首次通过率。\n' +
          '8. 试点方案：先从高频投标文档和审稿场景切入。\n' +
          '9. 风险与保障：模型稳定性、权限控制、人工复核闭环。\n' +
          '10. 结论：建议小范围上线并同步扩展 ET/WPP 自动化。\n\n' +
          '讲稿\n' +
          '第 1 页：先说明这是给采购与投标团队用的效率工具，本次汇报重点是价值、路径和落地节奏。\n' +
          '第 2 页：强调外部政策变化快、内部材料多，传统手工整理已经跟不上业务节奏。\n' +
          '第 3 页：把最痛的三个点讲透，尤其是人工校验和写回反复返工的问题。\n' +
          '第 4 页：说明这不是单点提效，而是同时提升质量、一致性和交付速度。\n' +
          '第 5 页：逐项介绍核心能力，并突出 Plan 写回稳定是差异化卖点。\n' +
          '第 6 页：用简单流程说明用户怎么从文档输入走到可执行结果输出。\n' +
          '第 7 页：讲业务收益，重点落在减少重复劳动和提升过审效率。\n' +
          '第 8 页：说明为什么先做试点，以及试点如何更容易拿到正反馈。\n' +
          '第 9 页：主动交代风险，但同时说明我们保留人工复核和权限控制。\n' +
          '第 10 页：收束结论，建议马上启动小范围试运行并建立回归机制。\n\n' +
          '主题与版式建议\n' +
          '建议采用蓝灰商务风；标题统一 28-32pt，正文 16-18pt；痛点页与价值页用双色强调；结论页保留一条明确决策建议。\n\n' +
          '自检清单\n' +
          '1. 每页只讲一个中心意思。\n' +
          '2. 术语统一使用“招投标助手”“Plan 写回”。\n' +
          '3. 价值表述优先量化或半量化。\n' +
          '4. 风险页必须给对应控制措施。\n' +
          '5. 结论页要给明确下一步动作。',
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
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wpp',
          meta: { kind: 'bench_ppt_outline_auto_chat_override_v1' },
          actions: [
            { id: 'drop_default_slide', title: 'Remove default blank slide', op: 'delete_slide', slide_index: 1 },
            { id: 'slide_cover', op: 'add_slide', position: 1, layout: 1, title: '招投标助手', content: '产品发布汇报' },
            { id: 'slide_background', op: 'add_slide', position: 2, layout: 2, title: '背景', content: '• 行业数字化\n• 合规要求提升\n• 协同成本高' },
            { id: 'slide_pain', op: 'add_slide', position: 3, layout: 2, title: '痛点', content: '• 文档来回改\n• 校验靠人工\n• 写回不稳定' },
            { id: 'slide_solution', op: 'add_slide', position: 4, layout: 2, title: '方案', content: '• 结构化分析\n• 自动写回\n• 可追踪执行' },
            { id: 'slide_advantage', op: 'add_slide', position: 5, layout: 2, title: '优势', content: '• 提升一致性\n• 降低返工\n• 缩短交付周期' },
            { id: 'slide_conclusion', op: 'add_slide', position: 6, layout: 2, title: '结论', content: '• 可先在重点场景上线\n• 同步扩 ET/WPP 自动化\n• 继续收口回归链路' },
          ],
        },
        styleSpec: STYLE_SPECS.wpp_bid_deck_v1,
        asserts: [
          { type: 'wpp_slide_count_at_least', min: 6 },
          { type: 'wpp_last_slide_shapes_at_least', min: 2 },
          { type: 'wpp_slide_text_contains', text: '结论' },
          { type: 'wpp_last_slide_within_bounds', margin: 4 },
          { type: 'wpp_last_slide_no_overlap' },
        ],
        query: '[override]',
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
        forceSkillId: 'ppt-creator',
        styleSpec: STYLE_SPECS.wpp_bid_deck_v1,
        asserts: [
          { type: 'skills_selected_includes', skillId: 'ppt-creator', points: 2 },
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
        planOverride: {
          schema_version: 'ah32.plan.v1',
          host_app: 'wpp',
          meta: { kind: 'bench_wpp_outline_chat_override_v2' },
          actions: [
            { id: 'slide_cover', op: 'add_slide', position: 3, layout: 1, title: '版式助手', content: '标题页示例' },
            { id: 'slide_catalog', op: 'add_slide', position: 4, layout: 2, title: '目录页', content: '1. 项目背景\n2. 核心能力\n3. 落地计划' },
            { id: 'slide_two_col', op: 'add_slide', position: 5, layout: 1, title: '两栏内容页', content: '' },
            { id: 'slide_two_col_subtitle', op: 'add_textbox', slide_index: 5, placeholder_kind: 'subtitle', text: '左栏：场景说明\n右栏：关键动作' },
            { id: 'slide_two_col_note', op: 'add_textbox', slide_index: 5, left: 2.2, top: 15.2, width: 14.5, height: 2.0, text: '补充：示例文本' },
          ],
        },
        styleSpec: STYLE_SPECS.wpp_bid_deck_v1,
        asserts: [
          { type: 'wpp_slide_count_at_least', min: 3 },
          { type: 'wpp_last_slide_shapes_at_least', min: 3 },
          { type: 'wpp_slide_text_contains', text: '两栏' },
          { type: 'wpp_last_slide_within_bounds', margin: 4 },
        ],
        query: '[override]',
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
