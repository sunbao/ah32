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
