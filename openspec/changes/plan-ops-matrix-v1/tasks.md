# Tasks: plan-ops-matrix-v1

## v1（本 change）交付

- [x] 汇总 `ah32.plan.v1` 当前 allowed ops（按 `wps/et/wpp` 分组）
- [x] 对每个 OP 写清楚：能做什么 / 做不到什么 / 关键字段 / 主要限制
- [x] 标注“内部 OP”（例如 `rollback_block`）与“模型默认会不会生成”的差异

## 后续维护（避免文档变成过期谣言）

- [ ] 新增/删改 OP 时，同步更新本矩阵（至少更新 4 处口径）：
  - `src/ah32/plan/schema.py`（后端允许的 ops）
  - `src/ah32/services/plan_prompts.py`（模型被教的 ops）
  - `ah32-ui-next/src/services/plan-executor.ts`（前端可执行的 ops）
  - `macrobench-acceptance-v1`（验收矩阵/回归条目）
- [ ] 对跨宿主同名 OP（如 `insert_text`）保持“语义一致/差异明确”，避免误用。

## vNext（可选，等你确认再做）

- [ ] 考虑新增 `ensure_sheet`（ET-only）来显式表达“创建工作表”并减少拼写导致的隐式建表风险
- [ ] `delete_block(et)` 支持删除 `upsert_block.sheet_name` 指定的产物 sheet（而不仅是 `BID_<suffix>`）

