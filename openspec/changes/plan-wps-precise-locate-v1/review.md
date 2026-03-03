# Review: plan-wps-precise-locate-v1

## 结论

- 是否采纳：是（v1 提供 `set_selection_by_text` + `set_selection_by_block`，并支持 strict/best-effort）
- 是否需要升级 schema_version：否（仍为 `ah32.plan.v1`，新增 OP 以“客户端能力”决定是否可执行）

## 风险提示

- 精准定位属于“高风险写回能力”：找错位置比直接失败更糟，所以 v1 更倾向“找不到就失败 + 留日志”。
- 若允许不带 `block_id` 全文搜索，容易误命中重复文本；建议 v1 支持但不鼓励，MacroBench 需覆盖该风险。
