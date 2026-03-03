# Tasks: plan-et-ensure-sheet-v1

## 1) 协议/口径

- [x] 定义 `ensure_sheet` OP（ET-only）字段与默认值
- [x] 更新能力矩阵 `plan-ops-matrix-v1`（新增 ensure_sheet 行 + 更新缺口说明）

## 2) 后端（schema/prompt/normalize）

- [x] `src/ah32/plan/schema.py`：新增 `EnsureSheetAction` 并加入 ET allowed ops
- [x] `src/ah32/services/plan_prompts.py`：ET allowed ops 增加 `ensure_sheet`，并在提示词里写明关键字段
- [x] `src/ah32/plan/normalize.py`：支持 `ensureSheet -> ensure_sheet`，支持 `selectA1 -> select_a1` 等字段别名

## 3) 前端（PlanExecutor）

- [x] `ah32-ui-next/src/services/plan-executor.ts`：实现 `ensure_sheet` 执行（create/reuse + activate + clear + select A1）
- [x] 埋点/日志：输出 created/reused、最终 sheetName（清洗后）信息

## 4) 验收（研发期）

- [ ] 宏基准新增 1 条最小用例（可选）：`ensure_sheet("现金流") + insert_table(A1...)`
