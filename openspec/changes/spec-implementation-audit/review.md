# Review: spec-implementation-audit

## Summary

本 change 用来做一件很“土但有用”的事：

- 把 `TODOLIST*`、现有代码、现有 OpenSpec changes **放在一张桌子上对账**
- 哪些已经能用、哪些只是文档写了但代码没做、哪些 change 之间口径打架：都明确写出来
- 目的只有一个：后面全部用 OpenSpec 管理，不再靠散落的 todolist 和记忆

## 当前现状（你不需要读代码也能懂）

### 1) 有几条 change “代码基本齐了，但还差验收/归档”

- `bailian-multimodal-provider-v1`：后端多模态接口与 provider 已有；缺“手工验证”确认后才能放心归档
- `remote-backend-gapfix-v1`：远端后端关键坑已补（doc snapshot / tenant headers / 不再返回服务端路径）；仍有 4.x 手工验收未跑完
- `tenant-scope-storage-and-ssrf-guard-v1`：租户隔离 + SSRF 黑名单/审计已接入；仍有 4.x 手工验收未跑完

### 2) 有几条 change “文档看起来完成了，但实际上还没真正闭环”

- `multimodal-writeback-assets-v1`：后端资产仓库（asset store）已做；但 **Writer/ET 侧还没有“插图”能力**，所以“生成图片→写回到文档”在三端不等价

### 3) 有一条 change “口径跟现在项目规则冲突”

- `client-skills-split`：文档里写的是“skills 客户端可自定义/可改脚本”，但现在项目规则已经改成“skills 归租户、后端托管，客户端不能上送/覆盖 prompt 内容”（见根目录 `AGENTS.md`）
  - 这条 change 要么重写口径，要么就应该标记为“已被新口径替代”
  - 现已处理：在该 change 的 `review.md` 中标记 superseded，不再作为当前实现方向

### 4) 有一条 change “实际代码已经做了，但 tasks 文档没更新”

- `doc-snapshot-v1-and-llm-provider-v1`：Doc Snapshot API/接入/删除策略、LLM provider strict 选择都已实现，但 tasks 以前全是未勾选
  - 已更新该 change 的 tasks/review，使其与现实一致；剩下的是手工回归项（不重载、日志不泄露正文等）

## Consistency Checks

- **Proposal ↔ Specs**: ✅ 一致
  - proposal 中定义的 2 个新能力都有对应 spec 文件
  - spec-implementation-tracker 定义了追踪机制
  - change-alignment-check 定义了对齐校验

- **Specs ↔ Design**: ✅ 一致
  - design 中的 D1-D3 决策与 specs 中的 requirement 对应

- **Design ↔ Tasks**: ✅ 一致
  - tasks 覆盖了 design 中的所有目标
  - 1.x 对应归档，2.x 对应补充实现，3.x 对应继续推进，4.x 对应新能力

- **Cross-change dependencies**: ⚠️ 需注意
  - 任务 2.x 依赖 doc-snapshot-v1-and-llm-provider-v1 的设计
  - 任务 3.x 依赖 client-skills-split 的设计

## Findings

### MUST-FIX (Blocking)

1) **F1: “回退/预览/版本块”这套体验，在 Plan 写回链路里并不等价**
   - `TODOLIST.md` 里写“preview_only/apply/apply_with_backup 已完成”，但现在主写回链路是 `ah32.plan.v1`，并没有完整的“回退/版本块”能力
   - 目前更像是：旧 JS 宏通道里有较多回退相关逻辑，而 Plan 通道只有少量（例如 Answer Mode 有 `backup` 参数）
   - 影响：如果你按 TODOLIST 预期去验收，会发现“文档回退/变更记录”不完整

2) **F2: 生成图片资产（asset://）在三端写回不一致**
   - WPP（PPT）侧已经能把 `asset://<id>` 下载并插入（best-effort）
   - Writer/ET 侧没有“插入图片”的 Plan op（因此无法说“图片写回闭环”已完成）
   - 已建立 follow-up change：`plan-insert-image-wps-et-v1`

3) **F3: Plan 写回的“回退/预览/版本块”口径与实现需要补齐**
   - 已建立 follow-up change：`plan-writeback-rollback-v1`

## 对账清单（把 TODOLIST / changes / 代码放一起看）

> 这部分是任务 `0.1` 的主体：把“哪里已经有、哪里还缺、哪里口径不一致”一次说清楚，后面就只在 OpenSpec 里收口。

### A) 根目录 `TODOLIST.md` 的关键条目

- **多文档并发 + 写回队列 + 可取消 + 状态恢复**：代码已实现，验收口径已迁入 `macrobench-acceptance-v1`（`office-manual-acceptance`）
- **MacroBench 长跑/回归（不依赖 WPS）**：代码已实现（`scripts/macro_bench.py`），回归口径已迁入 `macrobench-acceptance-v1`（`macrobench-regression`）
- **StyleSpec 参数化**：代码已实现（`src/ah32/style_spec.py` + 注入/纠错），回归口径已迁入 `macrobench-acceptance-v1`
- **动态 skills（选/用可见、预算可控）**：代码已实现（后端 `src/ah32/skills/*` + 前端 UI 展示），回归口径已迁入 `macrobench-acceptance-v1`
- **RAG 可观测（命中/注入/截断）**：代码已实现（telemetry + 可选 stream event），回归口径已迁入 `macrobench-acceptance-v1`
- **“审阅/版本与可回退（preview/apply/apply_with_backup）已完成”**：口径与现实不一致（见 F1）。需要以 `plan-writeback-rollback-v1` 补齐 Plan 写回链路的等价体验，或明确“旧 JS 宏通道才有、Plan 暂无”等价能力

### B) `TODOLIST_WRITER/ET/PPT.md` 的状态（愿景与现实的边界）

- 这些文件里 **“阶段二~五（结构理解/智能推荐/思维链/思维树/分阶段执行/持续迭代）”** 大部分是愿景规划，并未在当前代码里形成可验收闭环
- 其中一些写法（例如“把推理过程 reasoning 输出给用户看”）还会与项目规则冲突（我们现在倾向于：对用户给结果与下一步，而不是暴露推理过程）
- 结论：如果后续要删除根目录 `TODOLIST*.md`，需要先决定这些“愿景内容”放哪里：
  - 要么新建一个“roadmap 型”的 OpenSpec change 来承接（推荐：有出处、有口径、不会丢）
  - 要么明确这三份愿景文档暂时保留、不纳入本轮“删 TODOLIST”范围

### C) 现有 OpenSpec changes 的“真实未收口项”（以代码为准）

- `bailian-multimodal-provider-v1`：接口与 provider 已有；仍缺手工验收清单/跑通记录（建议把验收项收进 `macrobench-acceptance-v1`）
- `multimodal-writeback-assets-v1`：后端 asset store 已有；但 Writer/ET 缺插图能力（F2），已转入 follow-up：`plan-insert-image-wps-et-v1`
- `doc-snapshot-v1-and-llm-provider-v1`：主要代码已实现；仍缺手工回归（大文档不重载/不把正文塞进会话等）
- `remote-backend-gapfix-v1` / `tenant-scope-storage-and-ssrf-guard-v1`：核心代码已做；仍缺 4.x 手工验收跑完（且要留证据）

### D) 口径冲突（已处理）

- `client-skills-split`：已标记 superseded（以“skills 归租户、后端托管”为准）

### SHOULD (Recommended)

1) **R1: 把“差异点/漏项/冲突”集中记录成一个清单（后续逐条开 follow-up change）**
   - 目标：不靠嘴记，不靠 todolist 继续加内容；全部转成 OpenSpec changes

2) **R2: client-skills-split 的口径要处理掉（重写或作废）**
   - 建议：不要让冲突文档长期挂在 changes 里，后面会越来越乱

3) **R3: 归档前统一把“必须手工验收的条目”收口到 `macrobench-acceptance-v1`**
   - 这部分已在推进中（把各 change 的 4.x 手工验收合并进验收矩阵）

## Risks / Trade-offs

1) **风险**：继续维护 TODOLIST 会让“口径越来越乱”
   - **缓解**：等 `macrobench-acceptance-v1` 覆盖足够后，单独提交删除 `TODOLIST*.md`

2) **风险**：一些 TODOLIST 的“已完成”其实是旧实现路径（JS 宏通道）的结果
   - **缓解**：对外只认“Plan 写回链路”的能力；旧通道要么补齐等价能力，要么明确弃用

3) **风险**：多条 change 同时推进会互相影响
   - **缓解**：先把“验收矩阵 + 差异清单”定住，再一个个开 follow-up change 落地

## Decision

- **Status**: Ongoing
- **Rationale**: 这是一条“对账/收口”型 change，会随着对账推进持续更新；不追求一次写完。
