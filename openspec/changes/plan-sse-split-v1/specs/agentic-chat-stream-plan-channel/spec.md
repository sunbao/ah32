## ADDED Requirements

### Requirement: Plan MUST be delivered via a dedicated SSE event

系统在 `/agentic/chat/stream` 的 SSE 流中，若本轮产生可执行的 `ah32.plan.v1`，则系统 MUST 通过 `event: plan` 单独传输 plan（不得夹带在 `content` 文本中）。

`event: plan` 的 `data` payload MUST 是一个 JSON 对象，且 MUST 包含字段：

- `plan`: 一个完整的 `ah32.plan.v1` JSON 对象（包含 `schema_version="ah32.plan.v1"` 与正确的 `host_app`）

#### Scenario: Writeback turn emits a plan event
- **WHEN** 用户发起一个需要写回文档/表格/幻灯的请求
- **THEN** SSE 流 MUST 至少包含一次 `event: plan`，其 `data.plan` 为合法的 `ah32.plan.v1`

### Requirement: Chat content MUST NOT contain executable plan/tool JSON

系统的 `event: content` 仅用于承载用户可见文本（解释、预览摘要、结论）。系统 MUST NOT 在任何 `content` 事件中输出可执行 Plan JSON 或工具调用/工具结果的原始 JSON。

#### Scenario: Content remains human-readable during writeback
- **WHEN** 本轮同时产生 `content` 与 `plan`
- **THEN** 所有 `content` 事件 MUST 保持为用户可读文本，且不包含可执行的 `ah32.plan.v1` JSON

### Requirement: Plan MUST be validated before being emitted

系统在发送 `event: plan` 前 MUST 对 `data.plan` 做归一化与 schema 校验；任何校验失败的 plan MUST NOT 被发送给客户端。

#### Scenario: Invalid plan is not emitted
- **WHEN** 系统生成的 plan 无法通过 `ah32.plan.v1` 校验
- **THEN** SSE 流 MUST NOT 出现 `event: plan`

### Requirement: Client writeback MUST be gated by plan event only

客户端（WPS 插件）对文档/表格/幻灯的“自动化写回执行” MUST 仅以 `event: plan` 的 `data.plan` 为输入；客户端 MUST NOT 从聊天 `content` 文本中提取 JSON 来触发写回。

#### Scenario: Content JSON does not trigger writeback
- **WHEN** `content` 文本中出现类似 JSON 的文本片段
- **THEN** 客户端 MUST NOT 将其识别为可执行 plan，也 MUST NOT 触发写回执行

### Requirement: Memory/RAG MUST NOT be polluted by raw plan JSON

系统的长期记忆与 RAG 索引 MUST NOT 存储原始 `ah32.plan.v1` JSON；系统 SHOULD 存储用户可读摘要与执行摘要（例如 ops 列表、block_id、success、trace_id/run_id）。

#### Scenario: Only summaries are stored
- **WHEN** 一轮写回执行完成并进入记忆/索引流程
- **THEN** 存储内容 MUST 不包含原始 `ah32.plan.v1` JSON，仅包含摘要信息

