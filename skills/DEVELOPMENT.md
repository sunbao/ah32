# Skills 设计与开发规范（Prompt + Tools）

本项目的 Skills 目标是：**可热插拔、可热更新、少 token、可确定性执行**。技能既可以只提供规则文本（Prompt-only），也可以额外声明可调用的 Python 工具（Prompt + Tools）。

落地清单（实现/待办对照）：`skills/todolist_skills.md`。

---

## 1. 目录契约

每个 skill 是一个文件夹：

```
skills/<skill-id>/
  skill.json                # 推荐（v1 manifest）
  SYSTEM.md|SYSTEM.txt|...   # 推荐（system prompt / 业务规则）
  scripts/                  # 可选（工具）
    <tool_name>.py
```

- `<skill-id>` 必须稳定（用于路由、日志、UI 展示）。
- Skills 目录支持热更新：保存文件后，下一次请求会自动生效（无需重启）。

---

## 2. Manifest（skill.json）契约

`skill.json` 使用 `ah32.skill.v1`（见 `schemas/ah32.skill.v1.schema.json`）。

关键字段：
- `schema_version`: 固定 `"ah32.skill.v1"`
- `meta.id` / `meta.name` / `meta.version` / `meta.priority`
- `entry.system_prompt`：指向 SYSTEM 提示词文件（md/txt/docx 均可）
- `routing.*`：用于自动命中/路由（hosts/tags/triggers/examples 等）
- `output.*`：输出契约（例如必须产出 `ah32.plan.v1`）
- `tools`：工具声明（见下）

### 路由机制（精准加载）
- 路由文本使用 `Skill.routing_text()`（id/name/group/description/tags/triggers/examples/output_schema/style hints），**不是**整份 `SYSTEM.*` prompt（更省 token、更稳）。
- 后端会将 `routing_text` 的 embeddings 持久化到 ChromaDB：`storage/skills_vector_store/`（collection=`make_collection_name("skills", embedding_model, embedding_dim)`），避免重启后重复 embedding。
- 选择技能时：先做硬过滤（host/group/enabled），再做向量 TopK + 词法 rerank；向量不可用则自动回退到纯词法匹配。
- 开发阶段规则：向量库目录不做向后兼容，始终以最新规范为准（例如 Memory 向量库固定使用 `storage/memory_vector_store/`）；如调整目录/collection/embedding_model，请手动清理旧的 `storage/*_vector_store/`。

### tools 声明（强约束）

- **`skill.json.tools` 是对外“唯一权威来源”**：运行时只会向模型暴露 `tools` 中声明的工具名。
- 每个工具建议使用“全量声明”对象形式：
  - `name`：工具名
  - `description`：一句话描述（尽量短）
  - `parameters`：参数 JSON Schema（只保留必要字段）

---

## 3. 工具脚本（scripts/）契约

工具脚本必须满足：
- 文件路径：`scripts/<tool_name>.py`
- 文件内必须提供同名可调用函数：`def <tool_name>(**kwargs) -> dict:`
- 返回值必须是 **JSON 对象**（Python `dict`）
- 禁止吞错：出现异常应抛出或记录（后端会捕获并写日志）

运行时会做最小参数校验（基于 `skill.json.tools[].parameters` 的 `required`/`type`）。

---

## 4. 工具调用协议（LLM 输出，强约束）

为减少 token 与歧义，统一只允许单条 JSON 对象：

```json
{"name":"tool_name","arguments":{...}}
```

规则：
- 只输出这一个 JSON（不要 Markdown、不要代码围栏、不要 `TOOL_CALL:` 前缀）
- 必须使用 `name`/`arguments`（不使用 `tool_calls` 数组）
- `arguments` 必须是对象（JSON object）
- **Token 优化**：当工具参数包含 `doc_text` 且你处于 Office 宿主（有“当前文档内容”上下文）时，可省略 `doc_text`；运行时会自动注入当前文档文本（避免重复占用 token）。

兼容性：运行时仍**兼容**旧格式 `{"action":"...","input":...}`，但新技能与文档请只使用新协议。

---

## 5. 工具结果协议（系统回灌给 LLM）

工具执行结果会以一条消息回灌（前缀用于稳定识别）：

```
TOOL_RESULT: <json>
```

其中 `<json>` 为精简 JSON：
- 成功：`{"result":{"data":{...}}}`
- 失败：`{"error":{"message":"..."}}`

---

## 6. 命名与冲突规则（可热插拔的前提）

- **工具名应视为 API**：一旦对外发布/交付，尽量不要改名。
- 同一轮对话中，如果被选中的多个 skills 存在同名工具，运行时会返回 **ambiguous** 错误并拒绝执行（避免“随机调用错工具”）。
- 建议命名策略：
  - 优先短且语义明确（减少 token）
  - 若未来可能冲突，建议加前缀：`<skill_id>_<verb>`（例如 `exam_parse_questions`）

---

## 7. Token 优化建议（强烈推荐）

- `SYSTEM.*`：只写“做什么/怎么做/输出约束”，避免大段样例。
- `tools[].description`：一句话即可（建议 ≤120 字符）。
- `tools[].parameters`：仅保留必须字段；避免长枚举/重复描述。
- 工具返回：只返回模型后续推理所必需字段，避免回传大段原文（必要时返回定位信息）。

---

## 8. 推荐开发流程（最小闭环）

1) 写 `SYSTEM.md|txt`（输出契约先定死）
2) 写 `skill.json`（路由 + tools 声明）
3) 在 `scripts/` 写同名工具（返回 dict）
4) 启动后端：`python -m ah32.server.main`
5) 用一次真实对话验证：
   - 是否命中 skill
   - 是否能按协议触发工具
   - 是否能根据 `TOOL_RESULT` 继续完成最终输出（Plan JSON / 业务输出）

---

## 9. 可观测（Telemetry）

目标：让“bench / 写回失败 / skill 路由偏差”等问题**可复盘、可过滤、可聚合**。

- 默认开启本地落盘：`storage/telemetry/telemetry.sqlite3`（可通过 `TELEMETRY_MODE=off` 或 `AH32_TELEMETRY_MODE=off` 关闭）。
- 前端批量上报：`POST /telemetry/events`；后端也会补充 emit 关键事件（chat/skills/rag/error_report 等）。
- Dev 查询（需要 `AH32_ENABLE_DEV_ROUTES=true`）：
  - UI：`GET /dev/telemetry/ui`
  - API：`GET /dev/telemetry/events?limit=200&event_name=chat.turn_done&session_id=...`
- 命令行（无需开 dev routes）：`python scripts/query_telemetry.py --limit 200 --event chat.turn_done`
- 常用事件名（非穷举）：
  - `chat.turn_start` / `chat.llm_call` / `chat.turn_done`
  - `skills.selected` / `skills.applied`
  - `rag.retrieve`
  - `macro.exec_start` / `macro.exec_done` / `macro.error_report`

---

## 10. 基准测试（MacroBench / PlanBench）

目标：把“模型输出质量 / 修复次数 / 延迟 / 写回成功率”变成可回归的指标。

- 前端（需要 `VITE_ENABLE_DEV_UI=true`）：
  - 任务窗格右上角“系统状态”面板 → MacroBench（开发）→ 选择场景/模式跑测
  - 当前 MacroBench 以 **Plan JSON（ah32.plan.v1）** 为唯一执行载体（不再基准测试 LLM 直出 JS 宏代码）
- 后端/命令行（无需 WPS）：
  - `scripts/macro_bench.py`：调用 `/agentic/js-plan/vibe-coding/stream` 做 plan 生成回归（校验“能否产出有效 plan”）
  - `scripts/macro_bench_30.py`：30 case 的快速成功率/延迟回归（同样基于 plan 输出）
