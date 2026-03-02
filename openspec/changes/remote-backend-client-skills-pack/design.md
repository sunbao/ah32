# Design: remote-backend-client-skills-pack

## Context

目标部署形态：

- **后端在远端云服务**（域名稳定）
- **客户端是 WPS 插件**（成千上万实例）
- **Skills 属于租户（组织）资产**：由后端在 `storage/tenants/<tenant_id>/skills/` 托管；租户管理员可统一升级/覆盖；个人不允许改动技能内容（研发阶段直接不兼容旧客户端的 skills_pack 机制）

当前系统能力与冲突点：

- 后端当前支持从 `settings.skills_dir` 热加载/seed 内置 skills（更适合“后端本地部署/技能由服务端管理”的形态）
- 远端后端场景下，skills 不应依赖“读取客户端本机路径”，必须转为“后端按租户托管”的统一来源
- 系统已经具备 **doc snapshot** 的“二进制原文上传 + 短期存储 + 及时删除”底座，可用于“远端后端读取用户当前打开文档”

强约束（项目规则）：

- **后端禁止执行客户端 skill 中的脚本/代码**（防攻击面）；后端只允许执行自身内置 allowlist 工具
- **写回规则严格**：只有用于 WPS 执行的 `ah32.plan.v1` 才允许写回文档；普通聊天文本只写入会话；任何后端内部 JSON/工具 JSON 不得出现在会话或文档中
- **多租户**：`tenant_id` 为组织级固定标识；每个 tenant 绑定一个 `api_key`；先支持 100 tenants（逻辑先通）
- **SSRF 防护**：任何“后端主动访问 URL/浏览器抓取/下载”的能力必须按 tenant 管控并落盘审计（按当前总则：默认允许，黑名单拒绝）

## Goals / Non-Goals

**Goals**

1) 明确并落地 “远端后端 + 客户端 skills” 的边界与契约：
   - skills 的权威来源在后端租户存储（prompt-only）
   - 客户端只上送“技能选择信号”（可选），用于路由提示
2) 在远端后端形态下，保持写回安全与可观测：
   - 只允许 `ah32.plan.v1` 触发写回
   - 失败可追踪：异常不吞错，必须有日志/trace_id
3) 引入多租户鉴权与 SSRF 防护（tenant 维度可配置/可审计）

**Non-Goals**

- 不把任何“抓取什么/什么时候抓取/业务策略”写死在 core（这些属于 skill 的业务层）
- 不实现完整的 skill 市场/分发平台；本变更先落地“租户目录覆盖/seed”，后续再补租户管理员上传/下载/管理能力
- 不在本变更中承诺文档解析的全部能力（图片定位、题目定位等）；只定义“原文上传+后端处理”的链路约束

## Decisions (Final)

### 1) Skills 交付形态：Tenant-managed Skills（prompt-only）

**Decision**

- 后端按 `tenant_id` 从 `storage/tenants/<tenant_id>/skills/` 加载 skills（prompt-only），并注入到该租户的对话中
- 客户端不再携带 `skills_pack` / `skills_pack_ref`（研发阶段直接移除/拒绝），只上送“技能选择信号”
  - 例如：`frontend_context.client_skill_selection`（前端确定主技能/候选集/置信度；后端据此在租户 skills 内路由/强制选择）
- 若租户目录为空，后端自动 seed 一套内置示例 skills（非破坏式）

**Why**

- skills 更符合“租户统一发布”的运维与协作方式；个人改动会导致升级与一致性难题
- 远端后端无法读取客户端路径；以租户目录托管可天然支持云端/局域网等前后端分离部署

### 2) 工具执行边界：后端只执行内置 allowlist tools

**Decision**

- 后端拒绝执行任何来自技能描述（skills）的脚本/代码
- 后端工具集合为“内置 allowlist”，skills 只能提供“业务规则/输出契约/触发词”等提示

**Why**

- 远端后端执行客户端脚本属于 RCE/越权高风险
- 保持后端安全边界清晰：架构层提供抓取/入库/写回等公共能力，业务触发与参数选择由 skill 决定

### 3) 写回裁决：只允许 Plan JSON 写回文档

**Decision**

- 默认输出写入会话（chat）
- 只有当模型输出 **可执行** `ah32.plan.v1`（供 WPS 客户端执行）时，才允许触发写回文档
- 任何内部 JSON（工具调用 JSON、plan JSON 在非写回回合等）不得泄露到会话或文档

**Why**

- 防止“把对话内容写进文档/把文档内容回显到对话/把后端 JSON 暴露给用户”的混乱与安全问题
- 与当前系统输出守卫（output-guard）方向一致：plan/tool JSON 属于内部协议，不是用户可见文本

### 4) 多租户鉴权：tenant_id + api_key（先 100 tenants）

**Decision**

- `tenant_id` 由服务端/运维分配（组织级固定 id）
- 每个 tenant 绑定一个 `api_key`；请求需同时携带并校验
- 初期仅支持最多 100 tenants（先跑通流程）

### 5) SSRF 防护：按 tenant 管控与审计（黑名单）

**Decision（按你最新口径）**

- 任何后端发起的网络访问（URL 抓取、浏览器访问、下载等）都必须经过统一 SSRF guard：
  - **默认允许** `http/https`（不做 allowlist / 默认拒绝）
  - **黑名单拒绝**：按 tenant 加载 blacklist 规则（host / ip(cidr) / url_prefix）
  - DNS 解析用于 blacklist 命中与审计记录（不是用于“默认拒绝内网/本机”）
  - redirect 逐跳校验：每一跳都应用相同规则
  - 全量落审计日志并带 `tenant_id`、`trace_id`、目的 URL、decision/reason

### 6) 远端文档上下文：Doc Snapshot 两步走（原文上传→对话引用）

**Decision**

- 客户端先调用 doc snapshot 上传接口把**原文二进制**传到后端（每次覆盖上一份）
- 对话接口只引用 `snapshot_id`（避免在 chat JSON 中塞入超大 payload）
- snapshot 生命周期：本轮结束或取消即删除；TTL 仅作为 crash-safety
- 解析优先 OOXML（`.docx/.xlsx/.pptx`）；非 OOXML 由后端尝试转换；失败时返回明确提示与可执行导出建议

## Risks / Trade-offs

- **带宽/开销增加**：每轮上传原文（或频繁上传）成本高；但这是正确性优先的选择；后续可在传输层做优化（增量/压缩/断点续传），不在本变更范围。
- **skills prompt 注入风险**：skills 是不可信文本；必须保证核心安全约束始终生效（输出守卫、工具 allowlist、写回裁决）。
- **多租户配置复杂度**：需要可运维的 keyring/allowlist 管理与审计；初期限制 100 tenants 降低复杂度。

## Migration Plan

1) 引入 tenant auth + SSRF policy（先最小可用：keyring + blacklist + 审计日志）。
2) 技能托管迁移：后端按 `tenant_id` 仅从 `storage/tenants/<tenant_id>/skills/` 加载 skills（空则 seed 内置）。
3) 客户端接入：不再上送 skills_pack；可选上送 `frontend_context.client_skill_selection`；对话前按需上传 doc snapshot。
4) 灰度：研发阶段不兼容旧客户端；以“前后端同版本协同”为准。

