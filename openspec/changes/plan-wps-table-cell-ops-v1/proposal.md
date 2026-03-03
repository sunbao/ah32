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

定位范围（v1 两种策略，需你拍板）：

- A. **安全优先**：`block_id` + `table_index?`（默认 1）——只允许修改某个写回块内的表格
- B. **易用优先**：`table_index`（全局 doc.Tables 的索引）或“光标所在表”——更灵活但风险更高

失败策略（v1）：找不到表/单元格就硬失败，并输出“找不到的原因”（表不存在/索引越界/行列越界）。

## MacroBench 对应（必须对齐）

> 目的：暴露“用户说改单元格，但系统只会插新表”的回归。

- 文件：`ah32-ui-next/src/dev/macro-bench-chat-suites.ts`
- 新增 story：`meeting-minutes:wps:table_cell_edit_v1`（或放到 `answer-mode` suite）
- Turn 1：让模型插入一张表，指定某个单元格写入占位符文本（例如 `待改`）
- Turn 2：要求只改该单元格为 `已改`，且“不新增表格”
- Asserts：`writer_text_not_contains: 待改` + `writer_text_contains: 已改`

（可选）`scripts/macro_bench.py` 增加生成-only case：明确要求输出 `set_table_cell_text`。

## 需要你确认的问题（开工前必须定）

1) v1 的定位范围选 A 还是 B？（我倾向：A 安全优先，避免误改用户原表）
2) `table_index` 是否需要进入 v1？如果需要，是“block 内索引”还是“全局索引”？
3) 单元格内容是“替换整格”还是“追加/前插”？（我倾向：只做替换，追加可用文本 OP 自己实现）

