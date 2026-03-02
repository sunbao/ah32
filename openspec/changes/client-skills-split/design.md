# 设计（草案）：前后端 skills 拆分（客户端模式）

## 核心原则

- 不吞错：客户端/后端都必须记录执行分支与 fallback，并能上报后端（已有 `/agentic/error/report` 机制可复用）。
- 可观测：每个 skill 的“被选中/被应用/触发了哪些工具/走了哪个分支”要能在日志和 UI 中看到。
- 渐进迁移：允许短期“双栈”并存，但必须可配置开关、默认路径明确。

已确认约束：
- LLM 在后端；客户端只执行
- 客户端 scripts=JS（不依赖 Python 环境）
- 后端不执行用户可编辑脚本（只保留后端白名单能力）
- 前端脚本允许充分使用 WPS 能力并允许联网（先口开大）
- 后端强能力（Playwright/RAG/抓取/入库/多模态等）仅允许由 LLM tool-call 触发
- 后端强能力倾向细粒度拆分（便于审计/限流/可观测）

## 候选拆分模型（待选）

### 模型 A：后端路由 + 客户端执行
- 后端仍负责：skills 选择、提示词注入（仅规则，不执行工具）
- 客户端负责：所有 tool 与写回执行

### 模型 B：客户端路由 + 客户端执行
- 客户端负责：skills 选择与提示词（或“路由提示”）组装
- 后端只接收：已选 skills 的最小信息（skill_id 列表 + 规则版本）

### 模型 C：混合（过渡期）
- 对某些 skills：客户端执行
- 对某些 skills：仍走后端 Python 工具（需要明确白名单与审计）

## 需要落地的接口面（v1）

- skills 清单与版本：客户端如何得知哪些技能可用、版本号是什么
- tool 调用协议：LLM 的“工具调用”如何转成客户端可执行动作（Plan 或客户端 tool 调度）
- 回传：工具结果如何回到 LLM（如果还需要工具循环）

## 推荐协议（v1，基于 Owner 口径）

### 1) 客户端向后端提交“可用脚本目录”（catalog）

客户端在每轮对话请求中，提供：
- 本轮击中的 skills（skill_id 列表）
- 每个 skill 暴露的“客户端脚本/工具”描述（名称、用途、参数 JSON Schema、结果 JSON Schema、script_id）

目标：让后端 LLM 能“点名”一个已有脚本，而不是生成任意 JS。

### 2) 后端向客户端下发“脚本调用指令”

后端在 SSE/响应中下发结构化指令：
- `script_id` / `tool_name`
- `arguments`（JSON，必须通过参数 schema 校验）
- `call_id`（用于回传与幂等）

### 3) 客户端执行并回传结果（可选两段式）

两种模式：
- 单段式：LLM 直接输出最终内容/Plan；客户端脚本只负责执行（不参与推理回传）
- 两段式：LLM 先下发脚本调用；前端执行后把结果回传后端；后端再让 LLM 产出最终内容/Plan

Owner 当前描述更接近“两段式”（由 LLM 指定触发哪个脚本）。

## 与后端白名单能力的关系

客户端脚本可以：
- 直接使用 WPS JSAPI 做写回/读状态
- 直接访问外网（Owner 允许；不做权限模型/拦截）
- 调用后端“弱接口”（例如 chat/plan 执行/错误上报等）

后端白名单能力的调用决策：
- 仅由 LLM 基于意图决定并执行（后端 tool-call）

因此：客户端脚本不得直接触发后端强能力（Playwright/RAG/抓取/入库/多模态）。客户端最多做“结果拉取”（例如 asset 下载）与写回执行。

两段式（推荐）：
1) 后端先完成 LLM tool-call（强能力在后端执行）
2) 后端再下发 `client_tool_calls`（让前端做 WPS 写回/本地处理）
3) 若需要，前端回传 `client_tool_results` 后，后端再让 LLM 产出最终内容/Plan（可选）

## 后端强能力工具清单（已落地 v1）

- 网页抓取（HTTP）：`web_fetch`（纯 HTTP(S) 抓取 + 文本抽取）
- 网页抓取（动态站）：`browser_snapshot`（Playwright 打开页面并抓取 body 文本）
- RAG 只读查询：`rag_search` / `rag_stats` / `rag_list_documents`
- RAG 写入（仅 URL 文本入库）：`rag_ingest_url`（抓取 URL → upsert 到向量库）
- 多模态图片生成：`mm_generate_image`（生成图片 → `asset://<id>`）

## 后端强能力的“细粒度”拆分原则（v1）

- 每个强能力工具必须：
  - 目的单一、输入输出 schema 清晰
  - 强制可观测字段（trace_id / elapsed_ms / code / failure_reason）
  - 可限流/可配额（按 client_id/session_id/tool_name）
- 避免“一把梭”工具把抓取+清洗+入库+检索全绑死在一次调用里。
