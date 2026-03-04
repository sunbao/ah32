## Why

当前 `ah32.plan.v1` 的传输方式是：把 **给人看的聊天文本** 与 **给机器执行的 Plan JSON** 混在同一段 assistant 文本里流式返回，前端再从文本里“扒出”Plan 并执行。

当我们要做到“所有技能都用 JSON plan，且稳定可靠、可持续迭代”时，这种混输会带来长期痛点：Plan 容易被 Markdown/解释文本/截断/代码块等干扰导致解析失败；同时 Plan JSON 也会污染对话与记忆/RAG，降低可观测与复盘质量。

## What Changes

- **BREAKING**：`/agentic/chat/stream` 将 `ah32.plan.v1` 从“聊天 content 文本”中分流出来，通过 SSE **独立 plan 事件/字段**传输；前端不再从聊天文本中解析 Plan。
- 聊天 `content` 事件仅承载“给用户看的内容”（说明、预览、结论）；不得再夹带可执行 Plan JSON 或工具 JSON。
- `plan` 事件承载“给客户端执行的 Plan”（严格 `schema_version="ah32.plan.v1"`，可直接交给 PlanExecutor 执行或进入写回队列）。
- 可观测与复盘口径调整：Plan 不进入用户可见聊天正文与长期记忆；写回证据通过审计/遥测记录（如 ops 列表、block_id、success、trace_id/run_id）。

## Capabilities

### New Capabilities

- `agentic-chat-stream-plan-channel`: 定义“chat content 与可执行 plan 分流”的 SSE 协议与客户端行为（plan 事件、写回闸门、落盘/审计口径）。

### Modified Capabilities

（无）

## Impact

- **Backend（FastAPI / SSE）**：需要在 `/agentic/chat/stream` 的事件协议中新增 `plan` 事件/字段，并保证 `content` 不再包含 plan；同时需要让生成 Plan 的链路直接产出结构化 plan，而不是拼进文本。
- **Frontend（WPS 插件）**：SSE 消费端需要接收 `plan` 事件并渲染为“可预览/可应用写回”的 UI 数据；写回触发严格以 `plan` 事件为准，不再依赖文本解析启发式。
- **Memory / RAG / Audit / Telemetry**：需要明确落盘边界：聊天记忆只存人话摘要与执行结果摘要；Plan 的执行证据走审计/遥测链路，避免污染检索。

