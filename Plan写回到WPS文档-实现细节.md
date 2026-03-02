# Plan JSON 写回到 WPS 文档：关键机制与实现细节（中文说明）

> 这份文档讲的是：本项目如何把“模型输出的一段 JSON（Plan）”稳定、可重复地写回到 WPS 文档里（而不是把一堆文字直接贴进文档）。
>
> 关键词：**Plan JSON（ah32.plan.v1）**、**写回队列**、**upsert_block 幂等块**、**书签/标记定位**、**失败可修复（repair）**。

---

## 1. 一句话概括：我们到底在做什么

用户在聊天里说“把这段内容写进文档/改格式/插表格/插图”等需求时：

1) **后端 LLM 负责产出一个严格的 Plan JSON**（`schema_version="ah32.plan.v1"`）。  
2) **前端（WPS 插件）负责执行这个 Plan**，调用 WPS 的对象模型去改文档。  

所以“写回”不是后端改文档，也不是把结果文本复制粘贴；而是 **“JSON → 一系列确定的文档操作”**。

---

## 2. Plan JSON 是什么（为什么不用“直接输出宏代码”）

### 2.1 Plan JSON 的定位

Plan JSON 是“可执行的操作清单”，核心字段：

- `schema_version`: 固定为 `ah32.plan.v1`
- `host_app`: 当前宿主（`wps`/`et`/`wpp`）
- `actions`: 操作数组（每个 action 有 `id/title/op` + 具体参数）

后端定义（Pydantic 严格校验）：
- `src/ah32/plan/schema.py`

### 2.2 后端为什么要严格校验 + 归一化

模型输出经常会出现“字段名写错/多包一层 params/用 steps 代替 actions”等情况。  
后端会先做 **归一化** 再做 **严格校验**，避免前端收到“看起来像 Plan、其实执行不了”的东西：

- 归一化：`src/ah32/plan/normalize.py`（`normalize_plan_payload()`）
- 校验：`src/ah32/plan/schema.py`（`Plan.model_validate(...)`）

典型例子：`upsert_block` 如果没写 `actions`，归一化会把一些常见“错误写法”（如 `content` / `inserts`）尽量转成 `actions`，否则直接判为 invalid。

---

## 3. 写回触发：Plan 从哪来、怎么被前端“识别出来”

前端接收后端 SSE 流，最终会得到一条 assistant message（文本）。  
然后前端会在这条文本里 **找 Plan JSON**：

- 从 ```json / ```plan / ```ah32-plan... 这类代码块里找
- 也会尝试“从整段文本里截取一段平衡的大括号 JSON”
- 只接受 `schema_version === "ah32.plan.v1"` 的对象

实现位置（Plan 解析器）：
- `ah32-ui-next/src/stores/chat.ts:2346` 起（`parsePlanCandidate()` 等）

另外，后端可以在 SSE 的 `done` 包里附带 `want_writeback`/`wantWriteback`，前端据此决定是否自动入队执行：
- `ah32-ui-next/src/stores/chat.ts:4065` 起

---

## 4. 真正“渲染到文档”的关键：upsert_block（幂等写回）

### 4.1 为什么必须有 upsert_block

写回最怕两件事：

1) 断线/重试/重复点击导致 **重复插入**（文档越写越多）  
2) 模型输出不是“定位+替换”，而是“再插一次”导致 **不可控**

所以系统强烈倾向：把写回内容放在一个“可定位的块”里，执行时是：

- **块不存在 → 创建块 → 写入**
- **块已存在 → 清空块内部 → 重新写入**

这就是 `op="upsert_block"` 的意义：**可重复执行也不会重复堆内容**。

后端归一化也会尽量把“写回正文”引导进 upsert_block：
- `src/ah32/core/prompts.py:239` 附近的系统提示就明确要求“优先用 upsert_block 保证幂等”

### 4.2 前端如何定位一个 block（书签优先，标记兜底）

前端执行 upsert_block 时，会给块做两种“定位锚点”：

1) **书签（Bookmark）**：更可靠  
2) **文本标记（START/END tag）**：作为兜底  

标记长这样（肉眼可见但会被格式化得很小、很淡）：

- `[[AH32:<block_id>:START]]`
- `[[AH32:<block_id>:END]]`

相关实现：
- 标记生成：`ah32-ui-next/src/services/plan-executor.ts:2272`（`tag()`）
- 书签名：`ah32-ui-next/src/services/plan-executor.ts:2276`（`bookmarkName()`）
- upsert_block 主逻辑：`ah32-ui-next/src/services/plan-executor.ts:3143`（`upsertBlock()`）

为什么不用“隐藏文字”来当标记：部分 WPS 版本对 hidden text 的 `Find()` 不稳定，会导致“标记找不到 → 幂等失效”。  
因此 `formatMarkerRange()` 明确写了：不要用 `Font.Hidden`，而是用更稳的做法（字号=1、颜色淡化等）。

### 4.3 光标冻结（freeze_cursor）：避免写回时光标乱跑

upsert_block 默认会尽量把“写回前的光标位置”保存起来，写完后恢复，避免：

- 写回过程中 Selection 移动导致后续 action 位置漂移
- 下次重试落点不一致

字段：`freeze_cursor`（默认 true）  
实现：`ah32-ui-next/src/services/plan-executor.ts:3167` 附近

### 4.4 备份与回滚（给测试/容错留后路）

写回在“更新已有 block”时，会先把 block 原内容做 best-effort 备份到本地（localStorage），以便回滚：

- 备份：`ah32-ui-next/src/services/plan-executor.ts:3308`（`saveBlockBackupBestEffort()` 等）
- 回写块文本（用于回滚）：`ah32-ui-next/src/services/plan-executor.ts:3118`（`setBlockTextBestEffort()`）

> 这是“写回行为的可逆性”基础设施：即使某次 plan 写坏了，也能回到上一次的块内容。

---

## 5. Action 到 WPS 的落地：PlanExecutor 是执行引擎

### 5.1 执行引擎的位置

- `ah32-ui-next/src/services/plan-executor.ts`（核心执行器）

它的工作是：

1) 校验/规范化 plan（前端也做一层防御）
2) 按 action 顺序执行
3) 每步都产出执行状态，供 UI 显示与日志上报

### 5.2 常见 action（你关心的“写进文档里”的操作）

下面这些是“最终会在 WPS 文档/表格/幻灯片里看到变化”的动作（并非完整列表）：

- `upsert_block`：写回的核心幂等块（建议所有“长内容写回”都用它包起来）
- `insert_text` / `insert_before_text` / `insert_after_text`：插入文字
- `insert_table`：插入表格（可选带数据）
- `insert_image`：插图（支持 `asset://...`、`data:image/...`、`http(s)://...` 等）
- `set_text_style` / `set_paragraph_format` / `apply_paragraph_style`：样式与段落格式
- `delete_block` / `rollback_block`：删块/回滚块（用于修正与反复试）
- `answer_mode_apply`：走 “Answer Mode” 的特殊写回（依赖宏运行时 `BID.answerModeApply`）

后端 schema 定义（字段范围/限制）：
- `src/ah32/plan/schema.py`

前端执行（WPS/ET/WPP 三端各有分支）：
- `ah32-ui-next/src/services/plan-executor.ts`

---

## 6. “写回失败了怎么办”：repair（让模型改 JSON，不是让用户手改）

当 PlanExecutor 执行失败时（比如模型给了一个不支持的 op，或参数不合法）：

前端可以把：

- 原 plan
- 错误类型/错误信息
- 第几次尝试（attempt）

发回后端，请后端让模型“修一版 Plan JSON 再试一次”：

- 前端调用：`ah32-ui-next/src/services/plan-client.ts:72`（`repairPlan()`）
- 后端接口：`src/ah32/server/agentic_chat_api.py:463`（`/agentic/plan/repair`）

---

## 7. 防止“Plan JSON 污染对话/知识库”：记忆系统会做降噪

Plan JSON 属于执行载荷，不应该进入长期记忆（否则会污染 RAG/Memory）。  
后端在写记忆时会检测 assistant 响应是否是 Plan，并把它**摘要化**再存，而不是存整段 JSON：

- `src/ah32/memory/manager.py:292` 起（`_maybe_parse_plan_response()` / `_summarize_plan_for_memory()`）

---

## 8. 你在验收时可以抓什么“证据点”

为了让你测试/定位更快，建议按下面这些“可观测点”验收：

1) assistant 消息里确实出现了 `schema_version: "ah32.plan.v1"` 的 JSON  
2) 前端能识别出 plan（writeback 队列有入队记录，不会提示 “no_plan_block”）  
3) 文档里出现/更新了对应的块（同一个 `block_id` 重跑不会重复插入）  
4) 报错时能看到：错误信息 + trace_id + tenant_id（便于后端查日志）  

---

## 9. 代码入口索引（方便你快速点开看）

- Plan schema（后端严格定义）：`src/ah32/plan/schema.py`
- Plan 归一化（后端容错清洗）：`src/ah32/plan/normalize.py`
- Plan 生成/修复接口（后端）：`src/ah32/server/agentic_chat_api.py`
- Plan 解析与入队（前端）：`ah32-ui-next/src/stores/chat.ts`
- Plan 执行引擎（前端写回）：`ah32-ui-next/src/services/plan-executor.ts`
- 触发 generate/repair（前端）：`ah32-ui-next/src/services/plan-client.ts`

