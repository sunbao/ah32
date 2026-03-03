# Proposal: plan-wps-table-cell-ops-v1

## 为什么要做（人话）

Writer 场景里，用户经常给的是“已有文档/已有表格”，需求是：

- “把表格第 X 行第 Y 列的值改掉”
- “把某个单元格补齐（金额/日期/勾选）”

但当前 Plan 能力里：

- `insert_table` 只能新建表格，或在光标处插入一张新表
- 没有“定位到某张表、某个单元格并替换文本”的显式 OP

结果是模型只能通过“再插一张表/在表格外写解释文字”来绕，宏基准很容易出现：

- 旧表没改（用户目标失败）
- 新表重复插入（污染文档）

因此需要新增“表格单元格级”OP，让写回变得 **可控、可验收**。

## 目标（v1）

1) 新增 Writer-only OP：至少 `set_table_cell_text`
2) 能在不新增表格的前提下，替换指定单元格内容
3) 支持最小范围限定（推荐：block_id 内；或光标所在表）
4) 失败要有明确错误与日志（禁止静默吞错）

## 不做什么（v1 先别做）

- 不做合并/拆分单元格、复杂表头、跨表引用等高级表格编辑
- 不做“自动识别哪张表才是用户要改的那张”的智能推断（容易误改）

## 设计方向（v1）

### OP：`set_table_cell_text`（Writer-only）

语义：定位到目标表格中的某个单元格，并把该单元格的文本替换为 `text`。

建议字段：

- `row`（必填，1-based）
- `col`（必填，1-based）
- `text`（必填）
- `table_index`（可选，默认 `1`）：目标表格索引（在当前 scope 内 1-based）
- `block_id`（可选）：若提供，则只在该 block 内找表（安全优先）
- `strict`（可选，默认 `true`）：找不到表/单元格时是否直接失败；`false` 为 best-effort（不抛错但会记录失败事件）

定位范围（v1 支持全部，按字段决定）：

- **block scope（安全优先）**：提供 `block_id` 时，只在 block 内找表（`table_index` 是 block 内索引）
- **document scope**：不提供 `block_id` 但提供 `table_index` 时，使用 `doc.Tables[table_index]`（全局索引）
- **selection scope**：两者都不提供时，默认使用“光标/选区所在的表格”（或选区内第 `table_index` 张表）

失败策略（v1）：找不到表/单元格就硬失败，并输出“找不到的原因”（表不存在/索引越界/行列越界）。

## MacroBench 对应（必须对齐）

> 目的：暴露“用户说改单元格，但系统只会插新表”的回归。

- 文件：`ah32-ui-next/src/dev/macro-bench-chat-suites.ts`
- 新增 story：`meeting-minutes:wps:table_cell_edit_v1`（或放到 `answer-mode` suite）
- Turn 1：让模型插入一张表，指定某个单元格写入占位符文本（例如 `待改`）
- Turn 2：要求只改该单元格为 `已改`，且“不新增表格”
- Asserts：`writer_text_not_contains: 待改` + `writer_text_contains: 已改`

（可选）`scripts/macro_bench.py` 增加生成-only case：明确要求输出 `set_table_cell_text`。

## 已确认（v1）

- 定位范围三种都支持（block/document/selection），由 `block_id`/`table_index` 是否提供决定
- 单元格内容 v1 只做“替换整格”（追加/前插留到后续）
