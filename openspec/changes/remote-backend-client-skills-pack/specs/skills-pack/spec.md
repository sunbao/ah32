# Spec: tenant-managed skills (v1)

## Purpose

定义“远端后端 + 海量客户端插件”形态下，skills 的权威来源与最小契约：

- skills **由后端按租户托管**：`storage/tenants/<tenant_id>/skills/`
- skills **仅用于 prompt 注入与路由提示**（prompt-only）
- 后端 **不执行** 任何来自 skills 的脚本/代码
- 客户端 **不上传/覆盖** skills 的 prompt 内容；客户端只上送“技能选择信号”（可选）

## Requirements

### R1: Skills 是 prompt-only（必须）

- 后端 MUST 只把 skills 当作提示词/规则注入（prompt-only）。
- 后端 MUST NOT 从 skills 派生/执行任何脚本、宏或外部工具调用。
- 后端工具执行 MUST 仅限后端内置 allowlist（强能力只允许后端 LLM tool-call 触发）。

### R2: Skills 的权威来源在后端租户存储（必须）

- 后端 MUST 从 `storage/tenants/<tenant_id>/skills/` 加载 skills。
- 若租户 skills 目录为空，后端 MUST seed 一套内置示例 skills（非破坏式）。
- 后端 MUST NOT 读取客户端本机路径来加载 skills（远端后端场景下不可行）。

### R3: 禁止客户端上送 skills 内容（必须）

- `/agentic/chat/stream` MUST 拒绝 `skills_pack` / `skills_pack_ref`（研发阶段直接移除/拒绝）。
- 任何“客户端可改 skills 并上送”的机制 MUST NOT 生效（避免一致性与投毒风险）。

### R4: Skills Catalog（必须）

- 后端 MUST 提供 `/agentic/skills/catalog`，返回租户 skills 的轻量元信息（用于前端路由/展示）。
- 该接口 MUST 为 prompt-only：不得执行技能脚本/工具。
- 可选：允许携带 `prompt_text`（截断/上限），用于调试或后端辅助路由。

### R5: 客户端技能选择信号（可选但推荐）

客户端 MAY 在 `frontend_context.client_skill_selection` 上送“本轮技能选择信号”，例如：

- `primary_skill_id`：本轮主技能 id（若前端已选定）
- `candidates`：候选 `skill_id` + 置信度（用于后端辅助路由）
- `host_app`：`wps|et|wpp`（用于技能 hosts 过滤）

后端对该信号的处理 MUST：

- 只影响“路由/注入哪几个 skills”；不得突破工具 allowlist 与写回规则。
- 记录最小审计字段（例如 chosen_skill_id、candidates_count、trace_id），不得记录文档内容。

### R6: 大小限制（必须）

系统 MUST 对 skills 注入施加上限（至少包括）：

- 单租户 skills 总字符数上限（加载时裁剪/拒绝）
- 单技能 `prompt_text` 字符数上限（加载时裁剪/拒绝）

## Scenarios

### S1: 新租户首次访问

- GIVEN `storage/tenants/<tenant_id>/skills/` 为空
- WHEN 调用 `/agentic/skills/catalog`
- THEN 后端 seed 内置示例 skills，并返回 catalog（仅元信息）

### S2: 前端只上送技能选择信号

- GIVEN 前端已根据 UI 或启发式选择主技能
- WHEN 发送对话请求（不包含 skills_pack），并包含 `frontend_context.client_skill_selection.primary_skill_id`
- THEN 后端使用该 `skill_id` 优先路由/注入（若该技能在租户 skills 中存在且 enabled）
