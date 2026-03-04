# Review: plan-sse-split-v1

## Summary

- 本 change 解决的问题：把 `ah32.plan.v1` 混在聊天文本里导致的“解析脆弱、污染对话、难以持续迭代”的长期痛点。
- 方案：在 `/agentic/chat/stream` 的 SSE 协议中引入独立 `event: plan` 通道，`content` 只做人话；前端写回只认 `plan` 事件。

## Consistency Checks

- Proposal ↔ Specs
  - Proposal 声明 BREAKING：plan 从 content 分流到独立通道；Specs 增加了对应 MUST/场景，匹配。
- Specs ↔ Design
  - Design 明确了事件类型、校验策略、失败策略与闸门；Specs 有对应 requirement/场景，匹配。
- Design ↔ Tasks
  - Tasks 覆盖后端产出 plan 事件、前端消费 plan 事件、禁止 content 混入 plan、以及 memory/audit 口径，匹配。
- Cross-change dependencies
  - 与 `remote-backend-client-skills-pack` 的“写回规则严格：只有 ah32.plan.v1 才允许写回”方向一致；本 change 是协议层收口与强化。

## Findings

### MUST-FIX (Blocking)

- (none)

### SHOULD (Recommended)

- 明确 plan 的大小上限与错误提示口径（避免超大 plan 导致 SSE/前端卡死）
- 为 `plan` 事件增加更强的关联信息（例如 turn/run_id），便于前端绑定到具体消息与审计回放

## Risks / Trade-offs

- 协议改动会要求前后端同版本协作 → 用 change 的任务清单与回归矩阵保障落地。
- 复盘时需要同时保存“人话摘要 + plan + 执行证据” → 建议逐步完善审计导出能力，但不必把 raw plan 写入记忆/RAG。

## Decision

- Status: Approved
- Rationale: 变更边界清晰、收益明确（稳定性与可迭代性），且通过“分流 + 校验 + 闸门”把失败面与安全边界显著收敛。

