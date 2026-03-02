# 变更提案（草案）：前后端 skills 拆分（客户端模式）
Date: 2026-02-26
Branch baseline: `feature/plan-writeback`

## 背景 / 问题

当前 skills 主要由后端加载与路由：
- skills 文件由后端从 `installer/assets/user-docs/skills/` seed 到运行时 `skills/` 目录（该目录通常被 git 忽略）。
- 后端 `SkillRegistry` 热加载 `skill.json + SYSTEM.* + scripts/*.py` 并注入提示词。
- 后端 `ToolExecutor` 会把 `skill.json.tools` 映射到 Python 脚本并执行（同步工具通过线程池规避 asyncio 限制）。
- 前端主要用于展示“本轮选中的 skills / 实际应用的 skills”以及执行写回（Plan / JS 宏）。

你正在推进“skills 彻底拆分到客户端模式”，这会影响：
- skills 的分发位置（后端 seed vs 前端内置 / 客户端本地）
- tool 的执行位置（后端 Python vs 客户端 JS/WPS JSAPI）
- 文档上下文的获取与传输（是否仍需后端读本地文件 / doc snapshot / 全客户端）

已确认的总则（由 Owner 提供）：
1) skills 可由客户端自定义/修改/新增，且随 WPS 插件发布到客户本机。
2) 客户端 skills 的脚本不依赖 Python 环境（不能要求客户提供 Python）。
3) LLM 调用一定在后端；WPS 端只负责执行与客户端应做之事。
4) 服务器端不执行“用户可编辑的 skills 脚本”，避免安全隐患。
5) 前端执行 JS 先“口开大”：允许脚本充分使用 WPS 能力，并且允许联网（由客户自行决定）。
6) 后端强能力（Playwright/RAG/抓取/入库/多模态等）只允许由 LLM tool-call 触发；前端脚本不得直接触发这些强能力。
7) 后端强能力倾向细粒度工具拆分（便于审计、限流与可观测），而不是“一把梭”的大工具。

## 目标（v1）

### G1. skills 的“职责边界”拆分清晰
- 明确哪些属于“模型提示词/路由元数据”
- 明确哪些属于“可执行工具（tool）”
- 明确哪些属于“写回执行（Plan / 宏）”

### G2. 客户端模式下的可交付形态
- skills 在客户端可独立更新/启停（至少能配置启用集合）
- tools 在客户端可执行（与 WPS JSAPI 交互），且不吞错、可观测

### G3. 与现有后端兼容策略（过渡期）
- 不强制一次性推倒重来：允许短期内同时存在“后端 tools”和“客户端 tools”，但必须可观测并可控切换

### G4. 明确“LLM 触发客户端脚本”的协议
- 对话时前端把“击中的 skills + 客户端脚本描述/Schema”作为 `client_context` 发送后端
- 后端把“要调用的客户端脚本（script_id/tool_id）+ JSON 入参”返回前端
- 前端按后端指令触发对应脚本执行（非用户手工点选）

### G5. 后端强能力的触发门控
- 强能力仅由 LLM tool-call 触发（后端执行）
- 前端只接收结果并执行写回（包含必要的“结果拉取/资产下载”等后处理）

## 非目标（v1）

- 不引入新的格式化/校验工具链
- 不在 v1 里实现“所有历史技能全部迁移完成”

## 现状（我已确认的代码入口）

后端：
- `src/ah32/skills/registry.py`：技能加载、路由文本、manifest 校验（`ah32.skill.v1`）
- `src/ah32/skills/tool_executor.py`：执行 `scripts/*.py` 工具
- `src/ah32/skills/seed.py`：从 installer/examples seed 到运行时 `skills/`
- `src/ah32/server/main.py`：初始化 `SkillRegistry` + skills routing vector store
- `src/ah32/agents/react_agent/core.py`：初始化 skill tool executor，并在 agent 流程中使用

前端：
- `ah32-ui-next/src/stores/chat.ts`：SSE 阶段里接收/展示 skills 信息
- `ah32-ui-next/src/services/wps-bridge.ts`：宏执行、错误上报（包含 last_skills 等上下文）

## 与其它变更的关系（避免设计冲突）

- `bailian-multimodal-provider-v1`：后端白名单能力（密钥/模型选择在后端）
- `multimodal-writeback-assets-v1`：后端白名单能力（临时资产/TTL，避免在消息/Plan 里塞大 base64）
- `doc-snapshot-v1-and-llm-provider-v1`：后端白名单能力（按需上传快照，LLM 不直接拿全量 doc 文本）

本变更负责定义：客户端如何“描述并暴露可调用脚本”，以及后端如何“指令化调用客户端脚本”。

## 需要你确认的“高层口径”（先不细到接口）

1) 客户端模式的定义：skills 的“提示词规则”和“tools”是否都以客户端为准？后端是否还保留 skills 路由？
2) tools 的执行边界：哪些必须留在后端（例如 Playwright 抓取），哪些必须在客户端（WPS JSAPI 写回）？
3) skills 的分发：客户端内置（随插件发布）还是运行时拉取（可热更新）？
4) 安全：涉及密钥/调用外部服务时，是否允许客户端直连？还是一律后端代理？

已补充的关键问题（v1 必须定口径，否则实现会发散）：
5) 后端返回“要执行哪个客户端脚本 + JSON 入参”的载体是什么（SSE phase、HTTP 响应字段、还是 Plan 扩展）？
6) 客户端脚本执行结果是否需要回传后端参与后续推理（两段式：先脚本后 LLM/Plan）？
7) “强能力”工具清单与拆分粒度（细粒度到什么程度）？
