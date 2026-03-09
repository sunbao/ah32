## Why

当前 AH32 的核心链路是“前端采集上下文 -> 后端调用 LLM 生成可执行写回 -> 前端在 WPS 内执行”。但代码层面存在 4 类明显短板：乱码/编码混乱、启动时误杀进程风险、核心文件过大导致维护成本高、以及 Plan 与 JS 宏双通道并存带来的复杂度与不确定性。现在不收敛，会直接拖慢迭代并放大线上排障成本。

## What Changes

- 统一 UTF-8：修复后端/前端源码与日志输出的乱码，保证 JSON/文本文件写入与响应头的编码一致。
- 启动端口处理“非破坏性”：移除或默认关闭自动 `taskkill` 清理端口逻辑，改为可配置、可诊断、不会误杀无关进程的策略。
- 降低维护成本：拆分超大前端模块（Plan 执行器、宏执行器、聊天 store 等），并把 `ah32.plan.v1` 的定义收敛为单一权威来源，避免前后端 schema 漂移。
- 简化执行通道：明确 Plan 为主通道；删除后端“模型宏通道 A”（`/agentic/js-macro/*`）与前端对应调用链；保留本地 BID 宏运行时为 Plan 提供确定性写回能力，并减少隐式耦合。

## Capabilities

### New Capabilities

- `utf8-io-hardening`: 端到端 UTF-8 编码一致性（源码、日志、API 响应、落盘文本）。
- `safe-startup-port-handling`: 启动端口冲突处理的安全策略（不误杀、可配置、可诊断）。
- `writeback-architecture-hardening`: 写回执行架构收敛（Plan 单通道优先、宏通道显式化、schema 单一来源）。

### Modified Capabilities

<!-- none -->

## Impact

- 后端：`src/ah32/server/main.py`（启动/编码/端口冲突策略/错误响应）、`src/ah32/server/agentic_chat_api.py`，以及少量 `/api/*` 路由的编码/流式响应细节。
- 前端：`ah32-ui-next/src/services/plan-executor.ts`、`ah32-ui-next/src/services/js-macro-executor.ts`、`ah32-ui-next/src/stores/chat.ts`、`ah32-ui-next/src/services/api.ts`、`ah32-ui-next/src/services/wps-bridge.ts`。
- 构建与开发：可能新增最小化的 schema 同步校验脚本/检查点（不引入新的前端格式化工具链）。
