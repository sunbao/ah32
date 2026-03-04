## 1. 协议与口径

- [ ] 1.1 明确 SSE `event: plan` payload 结构（`{ plan: <ah32.plan.v1> }`）并在后端实现中固化
- [ ] 1.2 明确“content 禁止 plan/tool JSON”的 output-guard 规则与落点（以 `/agentic/chat/stream` 为准）

## 2. 后端（FastAPI / SSE）

- [ ] 2.1 在 `src/ah32/agents/react_agent/core.py` 增加 `type="plan"` 的流式事件产出（从“拼进 content”改为独立事件）
- [ ] 2.2 在 `src/ah32/server/agentic_chat_api.py` 确保 `event: plan` 不被 chunking/过滤逻辑破坏（一次事件发送完整 JSON）
- [ ] 2.3 在发送 plan 前增加归一化 + schema 校验；校验失败时只输出用户可见错误提示（不发送 plan）
- [ ] 2.4 调整 memory 持久化逻辑：对话记忆只存用户可读内容 + 执行摘要（不存 raw plan JSON）

## 3. 前端（WPS 插件 / Taskpane）

- [ ] 3.1 在 `ah32-ui-next/src/stores/chat.ts` 增加 `case 'plan'` 的 SSE 事件处理：把 `data.plan` 绑定到本轮 assistant 消息的可执行计划列表
- [ ] 3.2 移除/停用“从聊天文本解析 plan JSON”的写回触发链路（仍可保留纯展示用的代码块渲染，但不再用于写回）
- [ ] 3.3 写回闸门：写回队列只接受 `event: plan` 的 plan；`content` 里的 JSON 不得触发写回
- [ ] 3.4 UI 最小可用：展示 plan 卡片（含 host_app/ops 概览/错误提示）与“应用写回”按钮

## 4. 可观测与验收

- [ ] 4.1 复用/补齐 `/agentic/audit/record`：记录 plan 到达、plan 执行结果、missing/invalid plan
- [ ] 4.2 增加手工回归清单：同一请求多次重跑不重复插入（依赖 `upsert_block` 幂等）
- [ ] 4.3 MacroBench（如有）：新增/更新用例，验证 `content` 不包含 plan JSON 且 `plan` 事件存在

