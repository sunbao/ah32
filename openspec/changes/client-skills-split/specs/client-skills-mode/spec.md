# Spec：客户端 skills 模式（v1）

## Purpose

定义“客户端 skills 模式”的边界与最低保证，确保：
- LLM 只在后端运行
- 后端不执行用户可编辑脚本
- 客户端脚本（JS）可由用户自定义，并由后端指令化触发

---

## ADDED Requirements

### Requirement: 执行边界（Owner 总则）
系统 MUST 满足：
- LLM MUST 仅在后端运行。
- 后端 MUST NOT 执行用户可编辑的 skills 脚本（客户端 JS）。
- 客户端脚本 MUST 使用 JS 实现，且 MUST NOT 依赖 Python 环境。

#### Scenario: 后端不执行用户脚本
- **WHEN** 用户在客户端修改/新增一个 skills 脚本
- **THEN** 后端 MUST 不加载/不执行该脚本源码，仅接收其“描述/Schema（catalog）”

### Requirement: 客户端脚本目录（catalog）上报
客户端 MUST 在对话请求中上报本轮可用的客户端工具目录（catalog），用于让后端 LLM 选择“要触发哪个脚本”。

catalog SHOULD 包含：
- `skill_id`
- `version`
- `client_tools[]`：
  - `tool_id`（稳定 id，推荐 `${skill_id}.${name}`）
  - `name`
  - `description`
  - `script_id`（映射到客户端本机 JS 模块入口）
  - `parameters_schema`（JSON Schema）
  - `result_schema`（JSON Schema，可选）

#### Scenario: 上报 catalog
- **WHEN** 前端发送一次对话请求
- **THEN** 请求 MUST 附带本轮“击中的 skills”及其 `client_tools` 描述（catalog）

### Requirement: 后端下发客户端调用指令（call）且必须可校验
后端 MUST 只允许调用“catalog 中声明的 tool_id/script_id”，不得生成任意脚本源码下发。

后端下发 `client_tool_calls[]` SHOULD 包含：
- `call_id`（幂等/回传关联）
- `tool_id` / `script_id`
- `arguments`（JSON，需通过 parameters_schema 校验）
- `timeout_ms`（可选）

#### Scenario: 禁止调用未声明工具
- **WHEN** LLM 试图调用一个不在 catalog 中的 `tool_id/script_id`
- **THEN** 后端 MUST 拒绝该调用并记录可观测信息（skill_id/tool_id/原因）

### Requirement: 客户端执行与回传结果（两段式可选）
当启用“两段式”时，客户端 MUST 回传 `client_tool_results[]`：
- `call_id`
- `ok` / `error`
- `result`（JSON，建议通过 result_schema 校验）
- `execution_ms`

系统 MUST 对回传结果设置大小上限（避免大 JSON 导致 taskpane 不稳定）。

#### Scenario: 回传结果过大
- **WHEN** 客户端脚本返回的 `result` 超过大小上限
- **THEN** 客户端 MUST 截断或返回错误，并把原因记录到日志/上报

### Requirement: 不吞错（客户端）
客户端脚本执行失败时，客户端 MUST：
- 对用户：MUST 给出友好提示（发生了什么/影响是什么/下一步怎么做）
- 对开发：MUST 写入前端日志并上报后端（可复用 `/agentic/error/report`）

#### Scenario: 执行失败必须可追踪
- **WHEN** 客户端脚本抛出异常或超时
- **THEN** 前端 MUST 上报包含 `skill_id/tool_id/call_id` 的错误信息

### Requirement: 可观测性
系统 MUST 能区分并记录：
- 本轮选中的 skills
- 本轮实际应用的 skills
- 实际执行的客户端 tools（若有）
- fallback 分支（若有）

#### Scenario: 展示本轮执行信息
- **WHEN** 一轮对话完成
- **THEN** UI/日志 MUST 能看到本轮 skills/tool 的 selected/applied/executed 概览

### Requirement: 迁移兼容（过渡期白名单）
允许过渡期“后端白名单 tools”与“客户端 tools”并存，但系统 MUST 提供：
- 明确开关
- 后端白名单（仅内置能力，非用户脚本）
- 默认路径明确（避免隐性切换）

#### Scenario: 非白名单后端 tool 被拦截
- **WHEN** LLM 试图调用不在后端白名单内的后端工具
- **THEN** 后端 MUST 拒绝并记录原因

### Requirement: 强能力仅由 LLM tool-call 触发
系统 MUST 将以下类别能力视为“强能力”（示例：Playwright/抓取、RAG 写入/查询、入库、资源密集型处理、多模态生成/理解等），并满足：
- 强能力 MUST 仅由后端 LLM 的 tool-call 决策触发并在后端执行。
- 前端脚本 MUST NOT 直接触发强能力执行（即不允许绕过 LLM 意图门控直接调用强能力入口）。
- 前端 MAY 拉取强能力的执行结果（例如通过 asset_id 下载内容）用于写回，但不得引入新的强能力副作用。

#### Scenario: 前端试图绕过 LLM 触发强能力
- **WHEN** 前端脚本直接调用强能力执行入口（绕过 LLM tool-call）
- **THEN** 后端 MUST 拒绝该请求并记录可观测信息（client_id/session_id/原因）
