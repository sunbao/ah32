# Tasks: client-skills-split

## 1. 定义目标架构

- [x] 1.1 确认客户端模式口径（模型 A/B/C）：以 B 为主（前端先选主技能；低置信度时后端在候选集内再判）
- [ ] 1.2 列出需要迁移的 skills 分组（纯提示词 / 纯写回 / 需要外部抓取）

## 2. 协议与数据结构

- [ ] 2.1 明确 skill manifest 的来源与版本策略
- [ ] 2.2 定义客户端 `client_skills_catalog`（client_tools 的描述/参数/结果 schema）
- [ ] 2.3 定义后端下发 `client_tool_calls` 与客户端回传 `client_tool_results`（是否两段式）
  - 明确：强能力仅由后端 LLM tool-call 触发；前端不得绕过触发

## 3. 最小可用迁移（PoC）

- [ ] 3.1 选 1 个简单 skill 做客户端执行 PoC（无外部网络依赖）
- [ ] 3.2 UI/日志可观测：显示“选中/应用/执行分支/失败原因”
- [ ] 3.3 PoC：LLM 只能点名 catalog 中的 tool_id/script_id（禁止生成任意脚本源码下发）

## 4. 迁移计划

- [ ] 4.1 制定逐步迁移顺序与回滚开关
- [ ] 4.2 安全评审：密钥与外部调用边界

## 5. 现有 Python tools 迁移

- [x] 5.0 后端移除执行 `skill.json.tools` 的 `scripts/*.py` 路径，并停止向 LLM 暴露这些 tools
- [x] 5.1 盘点当前内置 skills 的 `skill.json.tools`（scripts/*.py）清单与复用度
- [x] 5.2 将“强能力公共能力”提炼到后端白名单工具（Python，非 skills 目录脚本；细粒度拆分）
- [ ] 5.3 其余“技能特有能力”改写为客户端 JS tool，并补齐描述与参数/结果 schema（允许联网与 WPS 能力）
