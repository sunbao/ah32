# Ah32 / 阿蛤（AH32）- TODOLIST（MacroBench 2.0 + 多文档并发）

目标（面向真实客户使用）：
- 多文档多对话并发：同时处理多个 Writer/ET/WPP 文档，不互相卡住。
- 写回不踩踏：JS 宏写入必须绑定目标文档；避免“写到当前激活文档”造成误写。
- 宏基准测试长期保留并升级：对话驱动（chat-mode）+ 宏直出（macro-mode），无人值守可跑 1-2 天。

原则（非常重要）：
- 测试驱动主代码改造：bench 只提交场景/对话/断言/指标采集；不要在 bench 里“修补”掩盖主流程问题。
- 并发对话 ≠ 并发写回：对话可并行，写回默认串行（全局互斥），否则 WPS ActiveDocument/Selection 会踩踏。
- 可观测：任何降级/失败必须在 UI 或后端日志中可见，且能定位到 sessionId + 文档 + 宏代码/错误。
- 分层分逻辑：开发/测试/观测必须与核心业务隔离，避免搅在一起增加维护与 AI 读取难度。

---

## P0 - 仓库分层与隔离（开发 vs 跑测/用例 vs 观测 vs 核心业务）

目标：把“核心业务逻辑”与“开发/跑测/观测/用例”彻底拆开；即使未来 bench/观测代码不公开，也不影响核心可维护性。

- [x] 目录与命名约定（写进仓库规范，且按约定执行）
  - 核心业务：仅放在 `src/ah32/`、`ah32-ui-next/src/`（不含 dev/bench）
  - 前端跑测/调试：`ah32-ui-next/src/dev/`、`ah32-ui-next/src/components/dev/`（默认不进入生产入口/默认关闭）
  - 后端跑测/调试：新增 `src/ah32/dev/`（dev-only API、bench runner、debug helpers）
  - 观测：核心接口 `src/ah32/telemetry/`；私有 sink/上报实现放 `src/ah32/_internal/telemetry_sinks/`（可不公开）
- [x] 开关隔离（防止 dev/bench 逻辑混入主链路）
  - 后端：`AH32_ENABLE_DEV_ROUTES`（默认 false）
  - 前端：`VITE_ENABLE_DEV_UI`（默认 false），MacroBench/Debug 面板只在开关开启时出现
- [x] 测试与用例分层策略（按是否开源拆）
  - 公开（可选）：保留最小单测（例如协议/解析/预算/路由）与运行说明
  - 私有（可不公开）：MacroBench 用例库、观测面板/脚本、长跑数据集（建议统一放 `qa/` 或 `private/`；是否加入 `.gitignore` 由你最后统一决定，当前先不改忽略规则）
  - `tests/` 与 `docs/` 可调整：目标是“可读、可控、可隔离”，而不是固定目录名
- [x] 命名规范（让人一眼看出“非核心”）
  - 文件：`*_dev.*` / `*_bench.*` / `*_debug.*`
  - API：`/dev/*`、`/bench/*` 前缀（核心 API 禁止使用这些前缀）
  - 观测事件：统一 `telemetry.emit('event_name', payload)`（event schema 在核心，sink 可私有）

---

## P0 - 多文档并发对话 + 安全写回（主线）

### 1) 前端：并发对话（按 sessionId 分桶）
- [x] 把 chat 请求状态从“全局单例”改为“按 sessionId 分桶（Map）”
  - isSending / AbortController / streamPhase / streamElapsedMs / lastTokenUsage 等全部 session-scoped
  - 同时允许多个 session SSE 并行（不同文档互不阻塞）
  - 修复：切换文档后仍显示“思考中/取消按钮/无法发送”（原因：全局状态污染；已改为 session runtime）
- [x] 文档切换时立即加载该文档的历史（不再被 isSending 阻塞）
  - 现状：`syncSessionToActiveDocument()` 在 isSending=true 时直接 return，导致切文档不加载历史
  - 目标：切文档只切“当前显示 bucket”，后台可继续流式更新另一个 bucket
- [x] UI 表达：每个文档/会话独立展示状态
  - 至少：空闲 / 生成中 / 等待写回队列 / 写回中 / 写回成功 / 写回失败（可点击看简要原因）

### 2) 前端：写回执行队列（全局互斥 + 每文档队列）
- [x] 引入 MacroJob 队列
  - Job 至少包含：targetDocId/docKey、hostApp、blockId、code、createdAt、sourceMessageId
  - 规则：全局同一时刻只允许执行 1 个宏；但多个文档可以排队
- [x] 执行前强制激活目标文档（按 docId 优先）
  - activate 失败：直接 fail job（原因：文档已关闭/不可激活），继续下一条
- [x] 取消/停止：支持取消“某个会话的对话流” + 取消“某个文档队列中未执行的 job”
- [x] 文档身份稳定化（docKey 设计）
  - 现状：`docKey = fullPath || id || name`，未保存文档可能 name 冲突
  - 目标：优先使用 hostApp + docId；无 docId 时用 (hostApp + fullPath)；最后才 fallback name，并增加去重后缀

### 3) 统一“宏产物 id / 状态”协议（UI 与 bench 一致）
- [x] blockId 统一：优先读取 `// @ah32:blockId=...`，其次再用 messageId 派生
- [x] 执行状态持久化：success/error + message + finalCode（用于重载后恢复 UI）
- [x] 宏卡片文案：执行完显示“执行成功/执行失败”（不要一直显示“准备自动执行/正在处理”）

### 4) 回归验证（并发真实场景）
- [ ] 同时打开 2 个 Writer + 1 个 ET + 1 个 WPP：
  - A/B 文档同时发起对话，均可流式返回
  - 写回任务进入各自队列，按全局互斥执行
  - 保证不写错文档（每条 job 都绑定 docId/docKey）

### 5) “答题/写回”类宏的宿主兼容性（今晚就会踩）
- [x] 禁止在宏里使用不稳定的提示 API（例如 `app.Alert(...)`）
  - 现状：日志已出现 `app.Alert is not a function` 导致宏整体失败
  - 目标：宏结尾提示改成安全降级（console log / 仅在存在函数时调用 / 或统一用 BID.notify 之类的封装）
  - 同步改动点：
    - prompts：明确“不要用 app.Alert/MessageBox 等宿主不稳定 API”
    - executor：可选做一次“自动降级改写”（检测到 app.Alert 就包一层 guard）
---

## P0 - MacroBench 2.0（对话驱动 + 故事线 + 审美 + 指标）

已具备（不重复拆 TODO）：
- [x] chat-mode：bench 能自动跑（队列/续跑/失败继续下一条）
- [x] SSE done 兜底：避免“无 done 导致前端不 flush”
- [x] 关闭自然语言快捷指令误拦截（bench 发送 disableShortcuts）
- [x] TaskPane 稳定性：降低 watcher 频率/避免频繁 ComputeStatistics

需要继续加强：
- [x] 6 大业务场景（财务/法务/招投标/会议纪要/制度排版/风险台账）每个增加“风格/排版/美感”强约束 turns
- [x] 断言/评分体系增强（不仅“宏执行成功”，还要“结果像样”）
  - Writer：标题层级/表格边框/表头加粗/对齐/字体字号/段前段后
  - ET：数字格式/条件格式/冻结窗格/汇总页/图表标题与配色
  - WPP：主题色/版式/对齐/留白/字号层级/不重叠
- [x] 长跑观测：每轮输出“成功率/修复次数/95 分位耗时/失败原因 TopN”，并可导出 JSON

---

## P1 - “落地工具能力”优先（比修 bench 更重要）

### 1) Writer：答题/填空/在原文结构里写回（Answer Mode）
- [x] “在已有试卷/题干中精准定位并写回答案”
  - 目标：不是生成新模板，而是在原文题号/括号/横线/答题区精确填充
  - 需要能力：
    - 题号/占位符定位策略（题号、括号、下划线、固定提示语等）
    - 写回幂等（重复执行不越写越乱）
    - 错误可解释（找不到题号/结构变化时给出可修复诊断）

### 2) ET：多表汇总/透视到首页 Sheet
- [x] 多 Sheet 汇总到“首页/总览”（deterministic）
  - 明细 -> 汇总 -> 图表（财务/招投标常见）
  - 若 Pivot API 不稳定：用 JS 计算 groupby + sum/count/avg，再输出结果表

### 3) WPP：排版从“能放上去”升级为“像样”
- [x] Theme/Layout Engine（主题色 + 版式 + 字号体系）
  - 标题页/两栏/图文/结论/风险页等固定网格
  - 自动对齐与等距分布；文本过长策略（缩放/换行/截断）

---

## P2 - StyleSpec 参数化（支持第三方扩展）
- [x] 统一 StyleSpec（Writer/ET/WPP）字典：可选项 + 默认值 + 降级策略
  - Writer：tableStyle/border/headingLevels/font/spacing
  - ET：numberFormat/conditionalFormat/chartStyle/freezePanes
  - WPP：theme/palette/layout/typography
- [x] bench stories 强制携带 styleSpec（让风格可回归）

---

## P1 - 六大内置 Skills：动态选择 + 可执行边界 + 可观测（先规划，后落地）

目标：让 6 套内置 skills 不只是“提示词注入”，而是成为可控、可回归、可扩展的能力调度层（同时不牺牲安全与稳定性）。

- [x] skill.json 能力描述增强（6 套都补齐）
  - tags / intents / triggers / examples / markers / output_schema / max_chars / styleSpecHints
  - 每套至少 3 条真实例子（来自 MacroBench story）
- [x] SkillRouter（后端）：基于输入 + 宿主(wps/et/wpp) + 文档类型 + 历史上下文，选择 0..N 个 skills
  - 规则：priority + 互斥（避免“财务+法务”一起塞爆）+ 总字符预算（超限按 priority 截断）
  - 开关：`enable_dynamic_skills`（可随时关闭回退到静态/无 skills）
- [x] 注入策略：选中 skills 只作为 system 约束注入（不改用户输入）
  - 记录注入长度、最终 system 摘要（便于复盘）
- [x] 可观测：每轮记录
  - 命中哪些 skills + 命中原因（trigger/intents）+ 注入长度 + 选中顺序 + 被截断项
- [x] 前端展示：聊天界面显示“本轮启用的 skills”（可折叠）
- [x] MacroBench 覆盖：6 场景强制断言
  - 断言：本轮命中正确 skill（至少 1 个）+ 风格字段落地（styleSpec 影响到宏输出）

---

## P2 - 审阅/版本与可回退（优先级靠后，但对白领可用很关键）

目标：在法务/制度/招投标等场景，提供“可追溯、可回退、可审阅”的交付体验；同时兼容不同 WPS 版本/宿主差异。

- [x] 版本块机制（不依赖 WPS 审阅 API）
  - 每次写回保留“上一版/本版”或生成“变更记录”小节（时间/摘要/影响范围/对应 blockId）
  - 幂等：重复执行不会越改越乱；可一键回退到上一版
- [x] 写回模式开关（前端/后端一致）
  - `preview_only` / `apply` / `apply_with_backup`（默认 apply_with_backup）
- [x] 合同/制度类默认“对照表交付”，再可选一键应用
  - 原文要点 / 建议改写 / 理由 / 风险等级 / 是否应用
- [x] 审阅能力探测（可选增强，best-effort）
  - 支持则：开启修订 + 插入批注/变更
  - 不支持则：自动降级到“版本块 + 变更记录/对照表”
- [x] MacroBench 回归：新增 asserts
  - 至少验证：变更记录存在 / 可回退点存在 / 不覆盖题干原文（答题类）

---

## P1 - RAG 命中率 & 响应速度（白领可用硬门槛：对不对 + 等不等）

目标：先“量化可观测”，再“小步优化”；避免为了快而丢准确，或为了命中而把上下文塞爆导致更慢更跑偏。

- [x] 可观测（先量化，P0/P1 都能用）
  - 每轮记录：是否触发检索、命中条数、topK 分数分布、最终注入字符数、是否被截断
  - 每轮记录：LLM 首包耗时 / 总耗时 / tokens(若可得) / 是否重试
  - 前端（可选 debug 面板）：显示本轮“RAG 命中摘要 + 耗时分解 + 选用模型/温度”
- [x] RAG 命中率提升（不大改业务逻辑）
  - query 改写/分解：把长问题拆成 1-3 个可检索子 query（招投标/制度优先）
  - 文档内优先：当前打开文档/同 docKey 的记忆优先于全库（减少跑偏）
  - 注入策略：只注入 TopN + 摘要化（避免把上下文塞爆）
  - 预算与截断：为 rules/skills/RAG/memory/历史设定预算；超限时按 priority 保留（系统/当前文档/高分RAG/高优先级skills 优先）
- [x] 响应变快（不降质量优先）
  - prompt 瘦身：system/rules/skills/RAG 统一做预算控制（按 priority 截断）
  - 模型分工：宏生成/修复走快模型；分析/总结走慢模型（可配置、可观测）
  - 流式体验：阶段/进度/可取消；即使总耗时不变，也让用户“先看到在干活”
- [x] 温度策略：按任务类型/阶段路由（可控，不漂）
  - 执行型（宏/plan/AnswerMode/填表定位）：temperature 0.0~0.2
  - 结构化产出（审阅对照表/摘要）：temperature 0.2~0.4
  - 创作探索（PPT文案/版式探索）：temperature 0.6~0.9（仅在用户要求“多方案/更有创意”时启用）
  - 记录并展示：每轮输出“本轮选用温度/模型/路由原因”

---

## P1 - 基础约束（为并发/长跑做地基：可复现、可观测、可降级）

- [x] 统一 RunContext（三元绑定：文档 + 会话 + 任务/产物）
  - 定义并贯穿：`docId/docKey` + `sessionId` + `taskId` + `blockId` + `hostApp`
  - 任何日志/观测/bench 结果都必须带 RunContext（便于聚合、复盘与复现）
- [x] 可观测事件模型 v1（前后端统一口径）
  - 每条事件必须携带 RunContext（建议字段：run_id/mode/host_app/doc_id/doc_key/session_id/story_id/turn_id/case_id/message_id/block_id/client_id/ts）
  - 事件建议（可扩展，不要求一次做完）：
    - chat：turn_start / stream_phase / turn_done（含 first_token_ms、chat_ms、token_usage、retry_count、error）
    - rag：retrieve（triggered/hits/topk 分数分布/injected_chars/truncated/query_rewrites）
    - skills：selected（skill_ids/strategy/injected_chars）
    - macro：queue_enqueued / exec_start / exec_done（exec_ms/attempts/repairs_used/error_type）
    - bench：assert_eval_done（score/failures_top）
    - client：health（taskpane_reload/sse_disconnect/last_error）
- [x] Telemetry Sink：SQLite（本地/远程同口径，可延时写入）
  - 采集：`telemetry.emit()` 进内存队列；后台批量 flush（延时 1-5s 或 N 条），不阻塞对话/写回
  - 存储：SQLite WAL + 索引（ts、run_id、host_app、doc_key、session_id、block_id）
  - 保留：短期 TTL（默认 7 天，可配）；定时清理（不要求长期保存）
  - 部署形态区分（不靠客户端“猜”，靠后端 sink 配置）
    - 客户端策略：永远只把事件上报给当前 `apiBase`（同一套接口）
      - `client_id`：客户端首次启动生成并持久化（localStorage），每条事件必带
      - 上报接口（建议）：`POST /telemetry/events`（body=event list，允许 batch）
      - 客户端无需知道“单机/远程”，只要知道它在用哪个后端（apiBase）
    - 后端配置（建议 .env）：
      - `TELEMETRY_MODE=local|remote|both`（local=仅落本机 sqlite；remote=仅转发；both=落库+转发）
      - `TELEMETRY_SQLITE_PATH=storage/telemetry/telemetry.sqlite3`
      - `TELEMETRY_RETENTION_DAYS=7`（短期保留，满足复盘/聚合即可）
      - `TELEMETRY_FLUSH_INTERVAL_MS=1000`、`TELEMETRY_BATCH_SIZE=200`（延时写入，降低开销）
      - `TELEMETRY_REMOTE_ENDPOINT=`（可选：远程汇聚服务地址）
    - 能力查询（可选）：`GET /telemetry/capabilities` 返回当前 mode/retention/sinks，便于前端显示当前观测模式
  - 展示：
    - WPS TaskPane：看客户端视角（当前 host/doc/session/block 的实时状态与最近错误）
    - Web：看全局视角（按 host_app -> doc -> session -> block 聚合，跑测全貌）
  - 部署：
    - 私有化：本机 sqlite 文件即可
    - 远程：服务端 sqlite（并发不高 OK）；未来高并发可替换为 Postgres/ClickHouse（sink 可插拔，不改埋点口径）
- [x] 失败复现材料自动固化（每次失败必须可复现）
  - 自动保存：用户输入、注入的 rules/skills 摘要、选用模型/温度、RAG 摘要、finalCode、错误与 frontend_hint、目标文档身份
  - 目标：看到一条失败记录即可离线复盘，不依赖“当时 UI 状态”
- [x] 写回安全默认策略（避免误写/覆盖）
  - 默认 `apply_with_backup`；覆盖/替换类操作要 preview-only 或二次确认
  - 写回必须绑定目标文档；激活失败直接 fail job 并记录原因
- [x] 宿主能力探测与降级矩阵（WPS 版本差异必踩）
  - 对 wps/et/wpp 做 capability probe（有哪些 API 可用）
  - 建立“不可用 -> 替代方案”矩阵（避免修复循环随机）
- [x] 并发下资源治理（防卡死/闪断）
  - 前端：宏执行全局互斥锁 + 每文档队列；重载/断连后可恢复队列状态
  - 后端：并发上限、超时、取消传播；避免长跑连接积压导致 ConnectionReset

---

## P3 - 每轮改动后的回归（必做）
- [ ] WPS 真环境：Writer/ET/WPP 各至少跑 1 次（每轮迭代都要跑）
  - 生成 -> 执行 -> 失败自动修复 -> 成功（或给出明确失败原因）
  - 发起 -> 取消 -> 继续
  - 手工清单：`qa/checklists/wps-regression.md`

---

## 协作节奏（我们后续沟通的固定格式）

每一轮（建议 30-90 分钟一个循环）固定输出四样东西，避免“只感觉不落地”：
- Bench 结果：成功率/失败 TopN（含 sessionId + doc + blockId）
- 诊断材料：失败用例的宏代码（finalCode）+ 错误（含 frontend_hint）
- 主代码改动：只改 1-3 个最能提升成功率/体验的点（不要为了让 bench 过而改 bench）
- 回归验证：最小回归（至少跑 1 个 Writer + 1 个 ET/WPP）

---

## P0/P1 - ah32.plan.v1（ET/WPP/WPS）落地路线图（对齐当前代码现状）

说明：
- `TODOLIST_ET.md` / `TODOLIST_PPT.md` / `TODOLIST_WRITER.md` 是“愿景规划”（偏场景与能力清单）。
- 本节把三份规划对齐到“当前代码已经能执行/还不能执行什么”，并给出按依赖顺序可落地的开发路线图（照着做就能逐步交付）。

### 0) Ground Truth（当前已落地）

- [x] Plan Schema：`schema_version=ah32.plan.v1` + `host_app` 严格 gate（`src/ah32/plan/schema.py`）
- [x] Plan Normalizer：`normalize_plan_payload()`（LLM 输出的 plan 自动做 key/op 纠正、类型收敛与降噪；含 ET 的 `sheet_name+cell/range`、WPP 坐标/数值字段 best-effort 归一与 `add_image` 占位降级）（`src/ah32/plan/normalize.py`）
- [x] Plan Executor：前端 `PlanExecutor` 已支持按宿主分发执行（`ah32-ui-next/src/services/plan-executor.ts`）
- [x] Active Doc Text 注入（用于“数据理解/审阅类 skill tools”）：前端会在 `host_app=et` 时附带 `frontend_context.active_doc_text`（来源：`extractDocumentTextById()`；含 `#sheet/#used_range/#selection/#read_range` 元信息）+ `frontend_context.active_et_meta`（结构化元信息）+ `frontend_context.active_et_header_map`（表头映射），后端工具侧自动注入 `doc_text`（`ah32-ui-next/src/services/api.ts` + `ah32-ui-next/src/services/wps-bridge.ts` + `src/ah32/services/docx_extract.py`）
- [x] WPP（PPT）新增动作：`add_slide/add_textbox/add_image/add_chart/add_table/...` 已在 schema + executor 落地（`src/ah32/plan/schema.py` + `ah32-ui-next/src/services/plan-executor.ts`）
- [x] WPP 占位符填充（P1 省踩坑）：`add_textbox` 支持 `placeholder_kind/placeholder_type/placeholder_index`（优先填占位符；失败自动降级为坐标放置）（`src/ah32/plan/schema.py` + `ah32-ui-next/src/services/plan-executor.ts`）
- [x] WPP 内置 skill（Plan 直出）：
  - `wpp-outline`：只输出可执行 Plan JSON（`installer/assets/user-docs/skills/wpp-outline/*`）
  - `ppt-outline`：双模式（默认文字；用户明确要求创建 PPT 时输出 Plan JSON）（`installer/assets/user-docs/skills/ppt-outline/*`）
  - `ppt-creator`：只输出可执行 Plan JSON（`installer/assets/user-docs/skills/ppt-creator/*`）
- [x] ET（Excel）可执行 op（当前上限）：`create_pivot_table/sort_range/filter_range/set_*` + `insert_table/insert_chart_from_selection`（`src/ah32/plan/schema.py` + `ah32-ui-next/src/services/plan-executor.ts`）
- [x] Writer（WPS）可执行 op（当前上限）：`set_selection/insert_* / set_text_style/set_paragraph_format/apply_text_style_to_matches / set_writer_table_style / answer_mode_apply / upsert_block/delete_block`（`src/ah32/plan/schema.py` + `ah32-ui-next/src/services/plan-executor.ts`）

### 1) 能力矩阵（按宿主；✅=已实现/可执行，⏳=可用但能力不足，❌=未实现）

| 宿主 | 当前“可执行闭环” | 主要缺口（影响落地） |
|---|---|---|
| Writer（wps） | ✅ 块级写回（upsert_block）+ 定位插入（insert_after/before）+ 基本文字样式（set_text_style）+ 块内段落格式（set_paragraph_format，可用 block_id 限定到 upsert_block 内）+ 小范围批量匹配样式（apply_text_style_to_matches，可用 block_id 限定到 upsert_block 内）+ 块内表格样式（set_writer_table_style，可用 block_id/选区限定） | ❌ 全文级结构/样式遍历（标题层级识别/批量统一） |
| ET（excel） | ✅ 基础分析落地到新 sheet（upsert_block）+ 透视表/排序筛选/公式/格式 + `transform_range(transpose)` | ⏳ 已补 `set_selection(et)` + `active_doc_text` 注入（带 `used_range/selection` 元信息）但仍缺“结构化读数 API”（避免 LLM 猜 range）；⏳ 图表增强已通过 `insert_chart_from_selection` 字段覆盖（趋势线/数据标签 best-effort），但仍缺“从 range 直接建图并布局”的独立 op |
| WPP（ppt） | ✅ 创建幻灯片 + 文本框/图片/表格/形状 + 主题/切换/动画（best-effort） | ⏳ 图表 data 写入为 best-effort（失败会降级为“仅插入对象”）；⏳ 图片路径/资源管理策略（本地路径可用性不稳定）；⏳ 坐标放置仍然脆弱（优先用占位符填充） |

### 2) 对齐三份规划：哪些可以“现在就做”，哪些必须先补地基

#### 2.1 `TODOLIST_WRITER.md`（Writer）

- [x] 现有可执行动作清单（见 `src/ah32/plan/schema.py` wps 分支）
- [x] 修正规划中的 op 映射（P0）
  - [x] “表格美化”在 Writer 应使用 `set_writer_table_style`（该 op 仅对 Writer 生效；并且建议限定到 `block_id` 或当前选区，避免全篇乱改）
- [x] 新增内置 skills（P1：先落地能跑的版本）
  - [x] `doc-formatter`：默认产出 `upsert_block` 在文末生成“排版规范+模板块”（`installer/assets/user-docs/skills/doc-formatter/*`）
  - [x] `doc-editor`：默认“对照表交付”，用 `upsert_block` 生成“修订稿块”（`installer/assets/user-docs/skills/doc-editor/*`）
  - [x] `doc-analyzer`：输出结构报告（`installer/assets/user-docs/skills/doc-analyzer/*`）
- [x] 若要实现“全篇自动排版”，先补 Plan 原语（P2）
  - [x] `apply_paragraph_style`（一次性 deterministic 遍历：在 selection 或 block_id 范围内批量应用字体+段落格式）
  - [x] `normalize_headings`（一次性 deterministic 遍历：识别 heading 并按 level 统一样式；支持 selection/block_id 限定）
  - [x] Writer 表格样式：`set_writer_table_style`（已落地：仅建议用于 `block_id` 或当前选区，保守执行）

#### 2.2 `TODOLIST_ET.md`（ET）

- [x] 已实现：透视表/排序筛选/公式/格式/插表/从选区插图（见 `src/ah32/plan/schema.py` et 分支 + `ah32-ui-next/src/services/plan-executor.ts`）
- [x] 规划与现状不一致项（P0：先改规划，避免“写出来执行不了”）
  - [x] `transform_range`（已落地：当前实现 `transpose`；`src/ah32/plan/schema.py` + `ah32-ui-next/src/services/plan-executor.ts`）
  - [x] `add_chart`（ET 不应使用该 op；服务端 normalize 会把 `et:add_chart` best-effort 映射为 `insert_chart_from_selection`）
  - [x] `set_chart_style/add_trendline/set_chart_data_labels`（不做独立 op：已收敛到 `insert_chart_from_selection` 的字段，执行侧 best-effort）
- [x] 先补“范围/选区地基”（P0 → P1，强依赖）
  - [x] ET 定位类 op：`set_selection` 扩展到 ET（按 `A1` 或 `A1:D10` 选择范围；`sheet_name + cell/range`）（`src/ah32/plan/schema.py` + `ah32-ui-next/src/services/plan-executor.ts`）
  - [x] ET 范围元信息：`active_et_meta` 已提供 `sheet_name/used_range_a1/selection_a1`（减少 LLM 猜 range；`ah32-ui-next/src/services/wps-bridge.ts`）
  - [x] ET 结构化读数 API（P1）：已提供 `wpsBridge.readEtRangeById(docId, {sheet_name, range_a1, maxRows/maxCols/maxCells}) -> values[][]`，且 `active_doc_text` 的 ET 预览改为使用该 bounded read（带 `limit_cells/max_chars/truncated_by_char_budget` 元信息；`ah32-ui-next/src/services/wps-bridge.ts` + `ah32-ui-next/src/services/api.ts`）
- [x] 再补“图表最小闭环”（P1）
  - [x] `insert_chart_from_selection`：支持 `title/legend` + `add_trendline/show_data_labels`（best-effort；`src/ah32/plan/schema.py` + `ah32-ui-next/src/services/plan-executor.ts`）
  - [x] `add_chart_et`（不单独做 op：ET 的 `insert_chart_from_selection` 已支持 `sheet_name + source_range` 直接选定范围并建图）
- [x] 最后做“智能分析推荐”（P1/P2）
- [x] `et-analyzer` skill：声明 `capabilities.active_doc_text=true`，用 `data_parser/anomaly_detector` 做 deterministic 摘要（`installer/assets/user-docs/skills/et-analyzer/*`）
  - [x] `et-visualizer` skill：把“推荐图表”收敛到已支持的 chart op 子集（`installer/assets/user-docs/skills/et-visualizer/*`）

#### 2.3 `TODOLIST_PPT.md`（WPP）

- [x] WPP 基础建稿闭环已具备（创建页 + 内容填充 + 样式 best-effort）
- [x] `ppt-outline` 已支持“用户明确要求时输出 Plan”（双模式），`ppt-creator` 已提供“一键创建”入口
- [x] 规划的“图表 data 直写”（P1，best-effort）
  - [x] `add_chart`：补 ChartData 写入；失败时降级为“仅插入图表对象”（`ah32-ui-next/src/services/plan-executor.ts`）
- [x] 图片资源策略（P1）
  - [x] 执行侧容错：`add_image` 插入失败时自动降级为“占位形状”，保证 Plan 可继续执行（`ah32-ui-next/src/services/plan-executor.ts`）
  - [x] URL best-effort：当 `add_image.path` 为 `http(s)://...` 且 `AddPicture` 失败时，前端会尝试“同步下载图片字节 -> 写入剪贴板 -> 在 Slide 粘贴”为图片（失败再继续降级为占位形状；`ah32-ui-next/src/services/plan-executor.ts`）
  - [x] 资源库（Plan 级）：支持 `meta.resources.images=[{id,data_url}]` + `add_image.path="res:<id>"` 复用资源（减少路径/重复下载翻车；`ah32-ui-next/src/services/plan-executor.ts`）
  - [x] 下载生命周期（Plan 内）：对同一 URL 进行 best-effort 复用缓存（避免重复下载/重复粘贴；`ah32-ui-next/src/services/plan-executor.ts`）
- [x] 版式/占位（P1）
  - [x] `wpp-outline` tools 已有 `recommend_layout/get_placeholder_map`（脚本已存在）
  - [x] 把占位映射用于 `add_textbox` 自动放置：未显式给占位/坐标时，执行侧会优先填充空的 title/body 占位符，并在坐标兜底时尽量用占位框尺寸（`ah32-ui-next/src/services/plan-executor.ts`）

### 3) 推荐开发顺序（按依赖；做完一项就能交付一个可用闭环）

1. Writer：补 `doc-formatter/doc-editor/doc-analyzer`（先“块级交付”，不做全篇遍历）
2. ET：补“选区/UsedRange 结构化读取 API”（让 Plan 不再靠猜 range）
3. ET：补最小图表闭环（`add_chart_et`：从明确 range 创建图表）
4. WPP：补图片资源策略 + 占位映射落地（避免路径/坐标拍脑袋）
5. 三宿主统一：把能力探测/降级（capability_matrix）覆盖到关键 op，并在 UI 可见
