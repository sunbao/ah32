# Tasks: plan-wps-precise-locate-v1

## 1) 协议/口径

- [x] 定义 OP 列表（v1 至少 `set_selection_by_text`；可选 `set_selection_by_block`）
- [x] 定义字段、默认值、失败策略（找不到就硬失败 vs best-effort）
- [x] 更新 `plan-ops-matrix-v1`：补充新 OP 行 + “做不到/限制”

## 2) 后端（schema/prompt/normalize）

- [x] `src/ah32/plan/schema.py`：新增 Action schema + allowed ops（wps）
- [x] `src/ah32/services/plan_prompts.py`：allowed ops 增加 + 写清字段约束（occurrence/position/block_id）
- [x] `src/ah32/plan/normalize.py`：支持别名（例如 `setSelectionByText -> set_selection_by_text`）

## 3) 前端（PlanExecutor）

- [x] `ah32-ui-next/src/services/plan-executor.ts`：实现 OP 执行（Find 第 N 次 + 选区移动）
- [x] 可观测：记录命中/未命中、occurrence、是否在 block 内查找等（禁止静默吞错）

## 4) 宏基准（对应上）

- [x] `ah32-ui-next/src/dev/macro-bench-chat-suites.ts`：新增 `answer-mode:wps:precise_locate_v1` story（重复锚点定位）
- [x] （可选）`scripts/macro_bench.py`：新增 1 条生成-only 用例，统计是否输出新 OP
