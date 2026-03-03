# Tasks: plan-wps-table-cell-ops-v1

## 1) 协议/口径

- [x] 定义 `set_table_cell_text` 字段与约束（row/col/text）
- [x] 定义“定位范围”策略（block_id vs 光标所在表 vs 全局索引）
- [x] 更新 `plan-ops-matrix-v1`：补充新 OP 行 + 风险边界

## 2) 后端（schema/prompt/normalize）

- [x] `src/ah32/plan/schema.py`：新增 Action schema + allowed ops（wps）
- [x] `src/ah32/services/plan_prompts.py`：提示词写清“只改单元格，不要插新表”的约束
- [x] `src/ah32/plan/normalize.py`：支持字段别名（如 `tableIndex -> table_index`）

## 3) 前端（PlanExecutor）

- [x] `ah32-ui-next/src/services/plan-executor.ts`：实现 `set_table_cell_text`
- [x] 失败要抛错 + 上报（禁止静默）；成功要写埋点（表/行/列）

## 4) 宏基准（对应上）

- [x] `ah32-ui-next/src/dev/macro-bench-chat-suites.ts`：新增 `table_cell_edit_v1` 两轮 story（先建表，再改单元格）
- [x] （可选）`scripts/macro_bench.py`：新增生成-only case，检查 op 分布里是否出现 `set_table_cell_text`
