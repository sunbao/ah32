# 技能（Skills，可插拔）

把领域/行业/组织规范做成「技能」放进技能目录后，后端会在每次对话时自动加载并注入到提示词中（支持热更新，无需重启）。

面向人群：非程序员的办公人员。建议直接用 WPS 打开并编辑 `.docx` 规则文件，然后保存即可生效。

当前版本：prompt + tools（除规则文本外，也可声明可调用的 Python 工具）。

## 运行时目录（无需改代码）

默认会从用户文档目录读取（Windows 示例）：

`%USERPROFILE%\\Documents\\Ah32\\skills\\`

你只需要：新建文件夹、编辑文档、保存。

示例与说明：
- `installer/assets/user-docs/skills/`：内置技能种子包（后端启动会复制到用户目录；不会覆盖已存在目录）
- `examples/user-docs/README.md`：给办公用户的示例说明（可直接拷贝到 Documents）
- `skills/DEVELOPMENT.md`：技能设计与开发规范（Prompt + Tools）
- `skills/todolist_skills.md`：平台落地清单（10项能力对照）
- `storage/skills_vector_store/`：Skills 路由向量索引（ChromaDB 自动生成；不提交）
- `storage/memory_vector_store/`：Memory 向量索引（ChromaDB 自动生成；不提交；开发阶段不做旧路径兼容）
- `storage/telemetry/telemetry.sqlite3`：本地可观测事件（Telemetry，SQLite；不提交；Dev UI：`GET /dev/telemetry/ui`）

## 目录结构（推荐）

```
%USERPROFILE%\\Documents\\Ah32\\skills\\
  contract-review/
    skill.json
    SYSTEM.docx
```

`skill.json`（最小示例，v1）：

```json
{
  "schema_version": "ah32.skill.v1",
  "meta": {
    "id": "contract-review",
    "name": "合同审阅助手",
    "version": "0.1.0",
    "enabled": true,
    "priority": 50
  },
  "entry": { "system_prompt": "SYSTEM.docx" }
}
```

`SYSTEM.docx`：写清楚该技能的工作方式与输出约束（尽量短、可执行、可验证）。

## 工具（可选）

如果技能需要“确定性能力”（例如：解析结构化文本、生成检查清单、版式/占位映射），可以在 `skill.json.tools` 声明工具，并在 `scripts/` 目录提供同名的 `*.py` 文件。

目录示例：

```
skills/
  contract-review/
    skill.json
    SYSTEM.md
    scripts/
      clause_extractor.py
```

工具脚本约定：
- 文件名必须与工具名一致（`clause_extractor.py`）
- 文件内必须提供同名可调用函数（`def clause_extractor(...):`）
- 返回值必须是 JSON 对象（Python `dict`）

工具调用协议（LLM 输出）：
`{"name":"tool_name","arguments":{...}}`（只输出这一个 JSON 对象，不要额外前缀/解释）

Token 优化：如果工具参数里有 `doc_text`，在 Office 场景下可不传；运行时会自动使用当前文档文本注入。

工具结果协议（系统回灌给 LLM）：
- 成功：`{"result":{"data":{...}}}`
- 失败：`{"error":{"message":"..."}}`

更完整的约定与最佳实践见：`skills/DEVELOPMENT.md`。

## 简化模式（无 skill.json）

如果目录里没有 `skill.json`，但存在 `SYSTEM.docx` / `prompt.docx` / `SKILL.docx`（或 md/txt），也会被当作一个 skill 加载：
- skill_id = 文件夹名
- name = 文件夹名
- enabled = true
- priority = 0
