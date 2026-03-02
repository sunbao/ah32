# Review（草案）：client-skills-split

## 状态（先说结论）

这条 change 的原始口径是“skills 客户端可自定义/可改脚本”。但项目当前口径已调整为：

- skills 的权威来源在后端租户存储（`storage/tenants/<tenant_id>/skills/`）
- 客户端不得上送/覆盖 skills 的 prompt 内容

因此：**本 change 当前口径已与项目规则冲突，暂停继续实现**。后续要做 skills/协议相关工作，应以：

- `remote-backend-client-skills-pack`（已更新为“skills 归租户、后端托管”的口径）
- 以及根目录 `AGENTS.md` 的研发阶段规则

为准。

## 验收清单

- [ ] skills 的来源/版本/启停在客户端模式下可解释、可回滚
- [ ] tools 执行不吞错：用户可见友好提示 + 开发可见日志/上报
- [ ] 每次 fallback 都能记录“用了哪个分支、为什么”
- [ ] 迁移过程中不会破坏现有 `ah32.plan.v1` 写回闭环
- [ ] 后端仅调用客户端 catalog 中声明的 tool_id/script_id（不下发任意脚本源码）
- [ ] 强能力（Playwright/RAG/抓取/入库/多模态）仅允许后端 LLM tool-call 触发；前端脚本绕过触发会被后端拒绝并可追踪
