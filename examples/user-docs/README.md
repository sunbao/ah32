# 用户可编辑文件示例（可直接拷贝到 Documents）

这些文件面向“办公人员/文案人员”：用 WPS 打开 `.docx`，编辑保存即可生效。

推荐拷贝到（Windows）：
- `%USERPROFILE%\\Documents\\Ah32\\`

目录内容：
- `规则.docx` / `rules.docx`：全局规则文件（每次对话自动加载）
- `skills/`：示例 Skills（每个文件夹一个技能）
- `更多示例/`：第二套更贴近真实办公流程的模板（规则 + 样例文档）

示例 Skills：
- `skills/contract-review/`：合同审阅助手
- `skills/bidding-helper/`：招投标助手
- `skills/finance-audit/`：财务审计助手
- `skills/meeting-minutes/`：会议纪要助手
- `skills/policy-format/`：制度/规范排版助手
- `skills/risk-register/`：风险台账助手

注意：
- 你可以直接编辑 `SYSTEM.docx` 的内容；保存后无需重启就会热加载。
- 如果一个技能目录里没有 `skill.json` 也能生效（简化模式）。
