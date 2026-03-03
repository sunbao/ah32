# Review: plan-et-ensure-sheet-v1

## 结论

- 是否采纳：是（v1 只做 ET-only `ensure_sheet`）
- 是否需要升级 schema_version：否（仍然是 `ah32.plan.v1`，新增 op 由客户端能力决定；研发阶段可同步升级）

## v1 默认值（建议）

- `activate=true`
- `clear_existing=false`
- `select_a1=true`

## 风险提示

- 新 OP 会提升“显式性”，但不会自动禁止隐式建 sheet；如果要避免拼写导致的误建表，需要在 v2 讨论 strict 模式/能力协商。

