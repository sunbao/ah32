# Proposal: plan-et-ensure-sheet-v1

## 为什么要做（人话）

ET（表格）里，“创建工作表并在里面写表/画图”是非常高频的办公需求。

当前系统里虽然已经能在执行时 **best-effort** 地“引用一个不存在的 sheet 名就自动创建”，但这存在两个问题：

1) **语义不显式**：Plan 看起来只是在引用 `现金流!A1`，但实际会创建 sheet；排查/评审时不直观。
2) **缺少可控选项**：比如“创建后是否清空”“是否把光标切到 A1 作为后续写入起点”，只能靠隐式行为/额外动作拼起来。

因此需要把“确保工作表存在”做成一个 **显式 OP**，让 LLM 与执行器的意图对齐，同时给到最小可控参数。

## 目标（v1）

1) 新增 ET-only OP：`ensure_sheet`
2) 支持最小可控：是否激活、是否清空、是否选中 A1
3) 可观测：创建/复用 sheet 会写日志/埋点，便于定位

## 不做什么（v1 先别做）

- 不做 `rename_sheet` / `delete_sheet` 等完整的 sheet 管理套件
- 不把“引用 sheet 自动创建”的隐式行为改成严格模式（可在 v2 讨论）

## 设计方向（v1）

### 新 OP：`ensure_sheet`（ET-only）

字段：

- `sheet_name`（必填）：目标工作表名
- `activate`（可选，默认 `true`）：是否激活该 sheet
- `clear_existing`（可选，默认 `false`）：是否清空整张 sheet
- `select_a1`（可选，默认 `true`）：是否选中 A1（保证后续 `insert_table/insert_text` 有确定起点）

约束：

- 执行器会对 `sheet_name` 做兼容清洗（非法字符替换、长度裁剪到 31）
- 如果 sheet 不存在则创建；存在则复用

## 与现有能力的关系

- `upsert_block(et)` 目前会创建/复用 `BID_<suffix>` 产物 sheet 并清空整页；适合“产物页”模式。
- `ensure_sheet` 适合“业务语义 sheet”模式（例如“现金流”“汇总表”），不强制使用 `BID_` 命名。

## 已确认（v1）

- 默认值：`activate=true`、`clear_existing=false`、`select_a1=true`
- 同一份 Plan 内允许多次 `ensure_sheet`（可重复调用；是否清空由 `clear_existing` 控制）
