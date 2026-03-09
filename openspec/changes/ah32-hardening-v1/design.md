## Context

AH32 由两部分组成：

- 后端 FastAPI（`src/ah32/server/main.py`）提供聊天/Plan/RAG/记忆/遥测等 API，并承担租户绑定与审计记录。
- 前端 WPS Taskpane（`ah32-ui-next/`）采集文档上下文，调用后端生成 Plan，并在 WPS 运行时执行写回（`plan-executor.ts`）。Plan 执行过程中仍会依赖本地 BID 宏运行时（`js-macro-executor.ts`）提供的确定性能力（非模型生成）。

当前实现已经具备较完整的能力面，但在“可靠性、可维护性”上存在 4 个明确痛点：

1. UTF-8/编码混乱导致源码与日志出现乱码（moyibake），影响排障与可读性，也会引入潜在的运行时解码问题。
2. 启动时通过 `netstat + taskkill` 强杀占用端口进程（默认 5123），存在误杀无关进程风险。
3. 前端关键模块单文件体量过大，且 Plan schema 前后端双份维护，长期易漂移。
4. Plan 与 JS 宏双通道并存，且部分 Plan op 依赖宏运行时预加载，增加调试复杂度与不确定性。

该 change 的目标是把上述问题收敛成一套可执行的改造方案，并通过 specs/tasks/review 形成团队共识后进入实现。

## Goals / Non-Goals

**Goals:**

- 端到端 UTF-8：源码、日志、JSON 响应、落盘文本统一编码策略；消除明显乱码内容。
- 启动安全：默认不做“破坏性自动修复”（不误杀进程），端口冲突给出明确可操作的提示；需要时允许显式开启“强制清理”。
- 可维护性提升：拆分超大前端模块；建立 plan schema 的“单一权威来源”与一致性校验点，降低前后端漂移概率。
- 执行通道收敛：Plan 为主通道；删除后端“模型宏通道 A”（`/agentic/js-macro/*`），避免主流程与模型宏耦合；保留本地 BID 宏运行时用于 Plan 的确定性写回。

**Non-Goals:**

- 不在本 change 内重做整个 Agent/技能系统或更换模型框架（LangChain 仍保留）。
- 不承诺对旧客户端兼容（研发阶段允许 breaking，但需要清晰标注与迁移策略）。

## Decisions

1. **编码策略：以 UTF-8 为唯一标准**

   - 代码与文本文件统一保存为 UTF-8（含中文注释/字符串）。
   - API JSON 响应显式带 `charset=utf-8`（后端已有 `UTF8JSONResponse`，补齐遗漏处）。
   - 落盘文本统一 `write_text(..., encoding="utf-8")`；PowerShell/控制台输出按现有约束优先 UTF-8。

   *Alternatives considered:*
   - “只在运行时 reconfigure stdout/stderr”无法解决源码本身的乱码与团队协作问题，因此不选。

2. **端口冲突：默认不杀进程；提供显式强制开关**

   - 默认行为：检测端口占用后直接报错退出，并提示如何处理（关闭占用进程/改端口/启用强制清理）。
   - 安全增强：如果端口占用且本机已有 AH32 实例在跑，优先提示“已在运行”而不是杀掉它（可通过请求 `/health` 识别）。
   - 显式开关：仅在设置 `AH32_PORT_CONFLICT_MODE=force_kill` 时才允许执行 `taskkill`；并尽量只杀“可识别为 AH32”的进程（例如 PID 文件/健康探测）。

   *Alternatives considered:*
   - “自动找空闲端口”会牵扯前端连接地址、安装器与配置约束（当前端口被固定为 5123），作为后续选项但不作为本次默认策略。

3. **Plan schema：以后端 Pydantic 为权威，增加可验证的同步产物**

   - 权威定义：继续以 `src/ah32/plan/schema.py` 为 schema 的单一权威。
   - 同步产物：新增一份可机器校验的导出（例如 `schemas/ah32.plan.v1.schema.json` 或 `schemas/ah32.plan.v1.ops.json`），由脚本从 Pydantic 导出。
   - 前端使用：前端类型与运行时 allowed-ops 逻辑以导出产物为对照，至少做到 CI/构建时能检测出“新增 op 但前端未实现”。

   *Alternatives considered:*
   - “把 TS 作为权威再生成 Python”与现有后端验证/normalize 流程冲突更大，本次不选。

4. **执行通道：Plan 为主；宏通道明确化并去除隐式依赖**

   - UI 主流程只走 Plan（生成/修复/执行），JS 宏相关接口默认不用于普通用户路径。
   - `answer_mode_apply/rollback_block` 等 op 从“依赖宏运行时”逐步迁移到 PlanExecutor 内实现，降低预加载与跨模块耦合。
   - 服务器侧 `/agentic/js-macro/*` 路由直接移除；前端不再通过网络调用模型生成/修复宏代码。

## Risks / Trade-offs

- [端口冲突体验变差（不再自动“修好”）] → 给出明确的错误信息与一键开关；能识别“已有 AH32 在跑”时提示复用。
- [schema 同步机制引入额外脚本/步骤] → 控制为最小依赖的导出脚本（Python 侧生成 JSON），前端仅消费静态文件或做轻量校验。
- [拆分大文件引入回归风险] → 保持外部导出 API 不变，按模块分层迁移并用现有 macrobench/dev 页面回归关键路径。

## Migration Plan

1. 先落地“安全不破坏”的改动（编码修复、端口策略改为不杀进程）。
2. 增加 plan schema 导出与一致性检查点（先做“检测”，再做“阻断构建”）。
3. 前端重构拆分（PlanExecutor/宏执行器/聊天 store），保持行为等价。
4. 删除“模型宏通道 A”：移除 `/agentic/js-macro/*` 端点与前端调用链；macrobench 仅用于验证本地 BID 运行时与 Plan 写回链路的一致性。
5. `answer_mode_apply/rollback_block` 等 op 逐步从“依赖宏运行时”迁移到 PlanExecutor 内实现，降低预加载与跨模块耦合。

## Open Questions

- 端口固定为 5123 的约束是否必须保留？如果允许动态端口，前端发现/握手机制如何做最小改造？
- `ah32.plan.v1` 的导出形态选 JSON Schema 还是“op 列表 + 参数约束”更合适，前端校验要做到什么程度？
