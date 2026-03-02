# Proposal: remote-backend-client-skills-pack

> 口径更新（2026-02-27）：本变更不再走“客户端可改 skills + skills_pack 上送”。改为 **skills 归租户、后端托管**（`storage/tenants/<tenant_id>/skills/`），客户端只上送“技能选择信号”（可选）。研发阶段不兼容旧客户端的 `skills_pack / skills_pack_ref`。

## Why

目标部署形态是 **远端后端 + 海量客户端插件**：服务端不可能读取每个客户端的本机路径，也不能信任客户端脚本。
因此需要把“技能与数据”的权威来源收回到 **租户侧（后端存储）**，并把写回/工具执行边界定死。

## What Changes

### 1) Skills：租户托管（prompt-only）+ 客户端只上送选择信号（可选）

- skills 的权威来源：`storage/tenants/<tenant_id>/skills/`（无则 seed 内置示例 skills）
- `/agentic/skills/catalog` 按 tenant 返回技能元信息（可选携带截断后的 `prompt_text`）
- `/agentic/chat/stream` 直接拒绝 `skills_pack / skills_pack_ref`（研发阶段移除旧协议）
- 客户端可选上送：`frontend_context.client_skill_selection`（主技能/候选集/置信度），只用于路由提示

### 2) 远端文档上下文改为 Doc Snapshot 两步走

**顺序（强制）**

1. 客户端 `init_snapshot` 获取 `snapshot_id`
2. 客户端上传原文二进制（可选附件：图片、嵌入资源等）
3. 客户端 `finalize`
4. 客户端发起 chat，将 `snapshot_id` 作为“当前文档上下文”的引用

设计要点：

- **全量上传**：不截断；超限则明确拒绝并提示调整上限/分片方案
- **覆盖上一份**：同一 `(tenant_id, client_id, host_app, doc_id)` 只保留一个活动 snapshot
- **立即删除**：本轮结束/取消即删；TTL 仅 crash-safety
- **格式策略**：优先 OOXML；非 OOXML 尝试转换；失败时返回清晰的导出提示（WPS 一键另存为 docx/xlsx/pptx）

### 3) 多租户鉴权（tenant_id + api_key）

建议接口形态：

- Header：
  - `X-AH32-Tenant-Id: <tenant_id>`
  - `X-AH32-API-Key: <api_key>`
  - （可选）`X-AH32-Client-Id: <client_id>` 便于审计与问题定位

建议配置存储（keyring）：

- 本地文件（不入库）：`storage/tenants/keyring.json`
- 内容（示意）：`{ "<tenant_id>": { "api_key": "..." } }`
- 上限：最多 100 tenants（可配置）

### 4) SSRF Policy（tenant 维度）

任何后端发起的网络访问都走统一校验：

- 允许的 scheme：`http/https`（其他 scheme 直接拒绝）
- 默认策略：**全部通行**（不做 allowlist / 默认拒绝）
- 管控策略：按 tenant 加载黑名单（host / ip(cidr) / url_prefix），命中才拒绝
- 审计日志：`tenant_id`、url、tool、elapsed_ms、result、trace_id

### 5) 写回/输出分流（会话 vs 文档）

后端输出分为两类：

- **message**：用户可见的对话文本（只进会话）
- **plan**：`ah32.plan.v1`（仅给客户端执行，不落会话/文档正文）

规则：

- 非写回回合出现 plan/tool JSON → 必须被 output-guard 清理，不得泄露到用户可见文本
- skills pack 中的 `default_writeback` 只作为 UI hint，不得突破“只有 plan 才写回”的硬规则

## Impact

**后端**

- 新增 tenant auth / SSRF 黑名单与审计 / tenant-scoped skills 托管与 catalog
- 明确拒绝 `skills_pack / skills_pack_ref`（研发阶段不兼容旧协议）

**前端**

- 可选实现“主技能/候选技能”的选择信号上送（不再上送 skills_pack）
- 对话前按需完成 doc snapshot 上传；错误要上报后端并对用户友好提示

