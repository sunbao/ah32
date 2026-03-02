# Tasks: remote-backend-client-skills-pack

> 口径更新（2026-02-27）：skills 不再走“客户端可改 + skills_pack 上送”。改为后端按 `tenant_id` 托管租户 skills（`storage/tenants/<tenant_id>/skills/`），客户端只上送技能选择信号（`frontend_context.client_skill_selection`）。研发阶段不兼容旧客户端。

## 0. 基线与兼容

- [x] 研发阶段不兼容旧客户端（skills_pack / skills_pack_ref 直接移除/拒绝）
- [x] 所有新增配置均提供默认值与清晰日志（禁止吞错）

## 1. Tenant Auth（100 tenants）

- [x] 定义 `tenant_id` + `api_key` 的请求头/鉴权策略
- [x] 实现 keyring（本地文件/环境变量）加载与热更新（可选）
- [x] 引入 tenant 上限（默认 100，可配置）
- [x] 对所有需要鉴权的 API 加入统一鉴权（返回明确错误与 trace_id）

## 2. SSRF Policy（tenant 维度）

- [x] 定义 blacklist 结构（host/ip(cidr)/url_prefix）与默认通行策略（http/https 默认允许；命中黑名单才拒绝）
- [x] 将 SSRF 校验接入所有“后端主动访问 URL”的入口（浏览器抓取、URL 入库、下载等）
- [x] 为每次访问记录审计日志（tenant_id、url、tool、elapsed_ms、trace_id）

## 3. Tenant Skills（server-managed）

- [x] 定义 tenant skills root：`storage/tenants/<tenant_id>/skills/`（无则自动 seed 内置 skills）
- [x] 后端按 tenant 加载 `SkillRegistry`（prompt-only）并用于对话注入/路由
- [x] `/agentic/skills/catalog` 按 tenant 返回技能元信息（可选携带 prompt_text）
- [x] `/agentic/chat/stream` 不再接受/处理 `skills_pack` / `skills_pack_ref`（请求 extra=forbid）
- [x] 前端不再上送 `skills_pack`（只上送 `frontend_context.client_skill_selection`）
- [ ] 租户管理员上传/下载/启停 skills（后续）

## 4. Doc Snapshot 两步走（远端后端）

- [ ] 客户端：对话前 `init → upload → finalize`，对话中只引用 `snapshot_id`
- [ ] 后端：确保 turn 完成/取消时删除 snapshot；TTL 仅 crash-safety
- [ ] 格式策略：优先 OOXML；非 OOXML 转换失败要给出明确导出提示

## 5. 写回/输出分流

- [ ] 后端严格区分 message vs plan 输出通道（plan 不进入用户可见文本）
- [ ] 只有 `ah32.plan.v1` 才允许触发写回；其他内容全部进入会话
- [ ] 确认 output-guard 覆盖“plan/tool JSON 泄露”的兜底场景，并对命中进行日志记录（可选）

## 6. 手工验证清单（建议）

- [ ] 未携带 `X-AH32-Tenant-Id` → 走 `default_tenant_id`（体验用户无需显式租户）
- [ ] 默认租户（public/体验）：不登录/不注册、无 JWT、无 api_key、无 `X-AH32-User-Id` 也可用（`user_id` 自动回落 `anon`）
- [ ] 非默认租户：未携带 `X-AH32-User-Id` 且无 JWT sub → 400
- [ ] `enable_auth=true` 且不满足鉴权策略 → 401（错误信息可行动，含 trace_id）
- [ ] tenant A 的 blacklist 不影响 tenant B（隔离）
- [ ] 租户 skills 覆盖/升级（增删改）立即生效；后端只依赖 `storage/tenants/<tenant_id>/skills/`
- [ ] 任意技能尝试诱导执行“客户端脚本/外部工具” → 后端拒绝并留痕
- [ ] 非写回回合不产生 plan；产生 plan 时不会出现在会话/文档正文里
- [ ] 前端重载/断线 → 本轮 turn 取消，doc snapshot 被删除（或 TTL 兜底删除）

