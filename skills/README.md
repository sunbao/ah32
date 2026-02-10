# 技能（Skills，可插拔）

把领域/行业/组织规范做成「技能」放进技能目录后，后端会在每次对话时自动加载并注入到提示词中（支持热更新，无需重启）。

面向人群：非程序员的办公人员。建议直接用 WPS 打开并编辑 `.docx` 规则文件，然后保存即可生效。

当前版本：prompt-only（只注入规则文本；后续可以扩展为注册工具）。

## 默认目录（无需改代码）

默认会从用户文档目录读取（Windows 示例）：

`%USERPROFILE%\\Documents\\Ah32\\skills\\`

你只需要：新建文件夹、编辑文档、保存。

配套文档（更详细、含例子）：`docs/规则与技能（给办公用户）.md`

## 目录结构（推荐）

```
skills/
  contract-review/
    skill.json
    SYSTEM.docx
```

`skill.json`（最小示例）：

```json
{
  "id": "contract-review",
  "name": "合同审阅助手",
  "version": "0.1.0",
  "enabled": true,
  "priority": 50,
  "entry": {
    "system_prompt": "SYSTEM.docx"
  }
}
```

`SYSTEM.docx`：写清楚该技能的工作方式与输出约束（尽量短、可执行、可验证）。

## 简化模式（无 skill.json）

如果目录里没有 `skill.json`，但存在 `SYSTEM.docx` / `prompt.docx` / `SKILL.docx`（或 md/txt），也会被当作一个 skill 加载：
- skill_id = 文件夹名
- name = 文件夹名
- enabled = true
- priority = 0
