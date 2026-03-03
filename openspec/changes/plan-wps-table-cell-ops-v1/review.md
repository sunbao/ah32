# Review: plan-wps-table-cell-ops-v1

## 结论

- 是否采纳：是（v1 提供 `set_table_cell_text`，支持 block/document/selection 三种 scope + strict/best-effort）
- 是否需要升级 schema_version：否（仍为 `ah32.plan.v1`）

## 风险提示

- 如果允许全局 `table_index`，很容易误改用户原表；建议 v1 默认要求 `block_id` 限定范围。
- 单元格操作是“精细写回”，必须覆盖 MacroBench，否则很难保证没回归。
