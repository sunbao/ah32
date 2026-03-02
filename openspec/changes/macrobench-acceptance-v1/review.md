# Review: macrobench-acceptance-v1

## 结论（收口口径）

- 根目录 `TODOLIST*.md`：已删除（以 OpenSpec 的 specs/tasks/review 作为唯一口径）
- 若后续验收发现遗漏：不再把需求写回 TODOLIST，而是直接补到 OpenSpec（新增 follow-up change）

## 删除原因（大白话）

- TODOLIST 属于“临时清单”，不在 OpenSpec 流程里，容易出现“看着勾了，但代码口径/验收口径不一致”
- 现在验收矩阵已经把“必须每轮跑”的场景收进来了，所以把根目录 TODOLIST 删掉，避免后续继续分叉

## 映射关系（摘要）

## 已核对：代码里确实存在的“硬能力”（来自 TODOLIST.md 的 Ground Truth）

> 这部分不是“看文档打勾”，而是我去代码里确认了对应文件/函数确实存在（至于跑出来稳不稳，仍然以你手工验收为准）。

- Plan 的格式校验（只认 `ah32.plan.v1` + 宿主 gate）：`src/ah32/plan/schema.py`
- Plan 的纠错/归一（把模型输出尽量修成可执行形态）：`src/ah32/plan/normalize.py`（`normalize_plan_payload()`）
- 前端写回执行器（按宿主分发执行）：`ah32-ui-next/src/services/plan-executor.ts`
- ET 的文档/表格摘要注入（active_doc_text/active_et_meta/header_map）：`ah32-ui-next/src/services/api.ts`、`ah32-ui-next/src/services/wps-bridge.ts`
- Writer 的可执行排版原语（段落/表格/批量样式/答题写回）：`src/ah32/plan/schema.py`（wps allowed ops）+ `ah32-ui-next/src/services/plan-executor.ts`（对应 op 分支）
- ET 的透视/排序/筛选/公式/图表等：同上（et allowed ops + executor）
- WPP 的新增动作（加页/文本框/图片/表格/形状/主题/动画等）：同上（wpp allowed ops + executor）
- WPP 图片插入的“失败不阻塞”策略：`ah32-ui-next/src/services/plan-executor.ts`（插图失败会降级为占位形状）
- Telemetry（事件上报/能力查询）：`src/ah32/server/telemetry_api.py` + `src/ah32/telemetry/service.py` + 前端上报 `ah32-ui-next/src/services/telemetry.ts`
- MacroBench（不依赖 WPS 的生成质量回归脚本）：`scripts/macro_bench.py`
- StyleSpec（风格参数接收与纠错）：`src/ah32/style_spec.py` + `src/ah32/server/agentic_chat_api.py`（会 normalize 后注入提示）
- 动态技能路由（开关/上限/选择）：`src/ah32/skills/router.py` + `src/ah32/config.py`（enable_dynamic_skills/top_k/budget）+ UI 展示 `ah32-ui-next/src/components/chat/ChatPanel.vue`
- RAG 可观测（命中摘要/telemetry）：`src/ah32/agents/react_agent/core.py`（rag.retrieve telemetry + 可选 rag stream event）

### 1) `TODOLIST.md`

- 迁移状态：部分已迁移
- 特别注意两条“每轮必跑/并发”的未完成项：
  - 同时打开 2 Writer + 1 ET + 1 WPP 并发不串台
  - Writer/ET/WPP 真环境各至少跑 1 次（每轮迭代都要跑）

### 2) `TODOLIST_WRITER.md`

- 迁移状态：已迁入（只迁“可验收的那部分”，愿景不作为验收条款）
- 已迁入验收矩阵：
  - Writer 排版（样式/段落/表格的可见变化 + 不乱写 + 失败可定位）
  - Writer 润色（插入/替换结果可见 + 不写内部内容）

### 3) `TODOLIST_ET.md`

- 迁移状态：已迁入（只迁“可验收的那部分”，愿景不作为验收条款）
- 已迁入验收矩阵：
  - ET 典型分析闭环（趋势/对比/占比三选一：排序/汇总/出图至少出一个结果）

### 4) `TODOLIST_PPT.md`

- 迁移状态：已迁入（只迁“可验收的那部分”，愿景不作为验收条款）
- 已迁入验收矩阵：
  - WPP 典型生成（多页结构化 PPT；失败也要给可见结果与原因）

## 映射表（先从高优先级开始，后续补全）

| 原清单 | 条目/场景（人话） | 迁入位置 |
|---|---|---|
| TODOLIST.md | 同时打开 2 Writer + 1 ET + 1 WPP 并发不串台 | `office-manual-acceptance` → Requirement: 多文档并发不串台 |
| TODOLIST.md | Writer/ET/WPP 真环境每轮各跑 1 次 | `office-manual-acceptance` → Requirement: 每轮至少各跑一次（真环境） |
| TODOLIST.md | 切换文档不阻塞（A 生成时切到 B 仍能加载历史并继续聊） | `office-manual-acceptance` → Requirement/Scenario: 切换文档不“卡住/串会话” |
| TODOLIST.md | 写回队列全局互斥 + 每文档排队 + 可取消 + 状态可见 | `office-manual-acceptance` → Requirement/Scenario: 写回队列要可控 |
| TODOLIST.md | blockId/写回状态可恢复（重载后能看到成功/失败） | `office-manual-acceptance` → Requirement: 写回队列要可控（状态可见） |
| TODOLIST.md | Writer 答题/填空写回（在原题干结构里填答案，且幂等） | `office-manual-acceptance` → Scenario: Writer 答题/填空写回 |
| TODOLIST.md | MacroBench：不依赖 WPS 的生成质量回归（统计成功率/耗时/失败原因） | `macrobench-regression` → Requirement: 有一键“生成质量回归” |
| TODOLIST.md | 观测：telemetry 事件上报 + capabilities 查询 | `macrobench-regression` → Requirement: 能把关键事件记录下来 |
| TODOLIST.md | 技能可见：前端显示“本轮命中的 skills（选/用）” | `macrobench-regression` → Requirement: 能看到“本轮命中的技能” |
| TODOLIST.md | styleSpec 参数化（回归用例强制携带风格参数） | `macrobench-regression` → Requirement: 回归用例要带“风格参数” |
| TODOLIST.md | 动态技能选择开关 + 注入预算（避免技能乱入/塞爆） | `macrobench-regression` → Requirement: 动态技能选择可开可关 |
| TODOLIST.md | RAG 命中可观测（命中多少/来源大概是什么/是否截断） | `macrobench-regression` → Requirement: RAG 命中情况要能看 |
| TODOLIST_WRITER.md | 文档排版 | `office-manual-acceptance` → Writer 排版 |
| TODOLIST_WRITER.md | 内容润色 | `office-manual-acceptance` → Writer 润色 |
| TODOLIST_ET.md | 销售趋势/业绩对比/占比分析 | `office-manual-acceptance` → ET 典型分析 |
| TODOLIST_PPT.md | 产品介绍/项目汇报 PPT | `office-manual-acceptance` → WPP 典型生成 |
| TODOLIST.md | 仓库分层隔离（dev/bench/debug 不混入主链路）+ 开关隔离 | `macrobench-acceptance-v1/design.md` → 收口规则（并在根目录 `AGENTS.md` 固化） |
| TODOLIST.md | Telemetry：关键事件可观测（不吞错、带上下文） | `macrobench-regression` → Requirement: 能把关键事件记录下来 |
| TODOLIST.md | RAG：命中/注入/截断可观测 | `macrobench-regression` → Requirement: RAG 命中情况要能看 |
| TODOLIST.md | “审阅/版本与可回退（preview/apply/apply_with_backup）” | **未等价迁入**：已转为 follow-up change `plan-writeback-rollback-v1`（Plan 写回要补齐等价体验，或明确弃用旧口径） |
| TODOLIST_WRITER/ET/PPT.md | 阶段二~五（结构理解/智能推荐/思维链/分阶段执行/持续迭代） | **未迁入验收**：属于愿景规划。若要删除根目录 `TODOLIST*.md`，需先决定由哪个 OpenSpec roadmap change 承接或明确保留 |

## 遗留问题与 follow-up（不在本 change 顺手改代码）

- 已补齐（代码已落地）：
  - `plan-writeback-rollback-v1`：Plan 写回“回退上一版”（块级回退 + Answer Mode 回退）
  - `plan-insert-image-wps-et-v1`：Writer/ET 支持 `insert_image`（asset:// → 插图）
- 仍需你手工跑完并留证据（验收矩阵里已写清楚怎么跑）：
  - `remote-backend-gapfix-v1` 的 4.x：tenant 隔离 / 10 轮不重载 / 失败可定位
  - `tenant-scope-storage-and-ssrf-guard-v1` 的 4.x：串租 / RAG 隔离 / SSRF 黑名单+审计
- 愿景类内容：
  - Writer/ET/WPP 的“结构理解/智能推荐/思维链/分阶段迭代”等：不作为本轮验收项；后续若要做，需要单独开 roadmap change 承接

## 已合并的手工验收项（从其他 change 收进来）

- `remote-backend-gapfix-v1`: 已迁入 `office-manual-acceptance`（tenant 隔离/10 轮不重载/可定位失败）
- `tenant-scope-storage-and-ssrf-guard-v1`: 已迁入 `office-manual-acceptance`（串租/RAG 隔离/SSRF 黑名单+审计）

## 发现的问题（需要另开 change 的那种）

> 这里记录“验收时发现确实缺功能/不合理”的点，但不在本 change 里顺手改代码；会单独开 follow-up change。

- `TODOLIST.md` 的 “审阅/版本与可回退（preview_only/apply/apply_with_backup）” 这一块：目前主要存在于旧的 JS 宏执行通道（例如 `ah32-ui-next/src/services/js-macro-executor.ts`），而 `ah32.plan.v1` 的 Plan 写回链路里并没有同等的“整块回退/版本块”能力（目前 Writer 的 `answer_mode_apply` 支持 `backup`，但这只是其中一条能力）。如果你希望 Plan 写回也有“回退/变更记录”的产品体验，需要单独开一个 follow-up change 来补齐。
