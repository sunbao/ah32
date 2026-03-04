## Context

当前 `/agentic/chat/stream` 的 SSE 流里，后端主要通过 `content` 事件输出“用户可见文本”。在“需要写回文档”的场景下，后端会把可执行的 `ah32.plan.v1` 以代码块/JSON 文本的形式附着在 `content` 文本里，前端再从文本里解析并交给 PlanExecutor 执行。

这套做法在早期能跑通，但当我们要做到：

- 大规模依赖 JSON plan（skills 产出更频繁、更长、更复杂）
- 写回稳定可靠（不因 Markdown/断句/截断导致解析失败）
- 能持续迭代（协议与可观测边界清晰，易调试、易回归）

“plan 混在聊天文本里”的方案会不断放大成本：解析脆弱、聊天区被 JSON 污染、记忆/RAG 容易被 plan 污染、复盘与审计口径不清。

## Goals / Non-Goals

**Goals:**

- 在 SSE 协议层把“用户可见内容（content）”与“可执行计划（plan）”分离为两个通道。
- 前端写回的触发以 `plan` 事件为唯一依据，不再依赖从聊天文本中提取 JSON 的启发式逻辑。
- 约束清晰：`content` 不得出现可执行 plan/tool JSON；plan 只走 `plan` 事件。
- 可观测与复盘：聊天记忆只存用户可读内容 + 执行摘要；执行证据走审计/遥测。

**Non-Goals:**

- 不在本 change 中升级 `ah32.plan.v1` schema（仍以现有 plan schema 为准）。
- 不在本 change 中实现复杂的“文档版本管理/多版本回退中心”（仍沿用现有写回与审计能力）。
- 不在本 change 中处理旧客户端兼容（研发阶段允许 breaking）。

## Decisions

### D1) SSE 新增 `plan` 事件（结构化计划通道）

**Decision**

- 后端在 `/agentic/chat/stream` 中新增 `event: plan`。
- `event: plan` 的 `data` payload MUST 为一个 JSON 对象，包含字段：
  - `plan`: 一个完整的 `ah32.plan.v1` JSON 对象（可直接交给 PlanExecutor）

**Rationale**

- 让 plan 成为“结构化载荷”，不再依赖文本截取与 JSON 解析启发式，显著降低失败面。
- 让 UI 更容易做“预览卡片/步骤展示/应用按钮”，避免把 JSON 暴露给用户。

**Alternatives**

- 把 plan 放到 `done` 事件里：可行，但会把 `done` 变成超大事件，并且难以区分“正常结束”与“plan 到达”。独立 `plan` 事件更清晰。

### D2) `content` 事件禁止携带 plan/tool JSON

**Decision**

- 后端 MUST NOT 在 `content` 文本中输出可执行 plan JSON 或工具 JSON。
- 如果需要给用户解释/预览，使用自然语言或“可读摘要”（而非原始 plan JSON）。

**Rationale**

- 避免污染会话 UI、避免用户误复制/误触发、避免 memory/RAG 召回 JSON 噪声。

### D3) Plan 的校验与失败策略

**Decision**

- 后端在发送 `event: plan` 前 MUST 先对 plan 做归一化 + schema 校验（等价于 `normalize_plan_payload + Plan.model_validate`）。
- 若校验失败：
  - MUST NOT 发送 `event: plan`
  - MUST 通过用户可见的 `content` 给出明确提示（说明“需要写回但 plan 不合法/未生成”，并给出 trace_id 便于定位）
  - SHOULD 通过审计/遥测记录一次“missing/invalid plan”的事件，便于回归统计

**Rationale**

- 失败要可定位、可统计；不能把“坏 plan”交给前端执行再炸。

### D4) 前端写回闸门以 `event: plan` 为准

**Decision**

- 前端的“可写回队列/应用写回”入口只接受来自 `event: plan` 的 plan payload。
- 聊天正文（`content`）中的任何 JSON/代码块均不再触发写回。

**Rationale**

- 安全边界清晰：写回只来自结构化通道；聊天文本永远当作“人话”处理。

## Risks / Trade-offs

- [实现涉及前后端同时改动] → Mitigation：用 OpenSpec 把协议、验收与任务清单写死；实现时优先“协议与闸门”再做 UI 优化。
- [复盘需要同时保存 content + plan] → Mitigation：聊天记忆只存摘要；执行证据走审计/遥测，必要时提供“导出本次 turn 的执行包（content 摘要 + plan + audit）”作为后续扩展。
- [plan payload 体积过大] → Mitigation：后端设置 plan 大小上限并在超限时明确报错；鼓励使用 `upsert_block` 幂等块降低重复输出。

## Migration Plan

1) 后端：SSE 增加 `plan` 事件 + 禁止 `content` 输出 plan/tool JSON（先打通端到端）。
2) 前端：新增 `plan` 事件消费与写回闸门（写回只认 `plan` 事件），UI 先用最小可用卡片展示。
3) 观测：补齐审计/遥测埋点（plan 到达、plan 执行、plan 缺失/无效）。
4) 回归：把“plan 分流”加入 MacroBench/手工回归清单，确保稳定性。

