# Review: browser-control-layer

## Summary

- 目标明确：为 BidAgent/Skill 提供统一的浏览器自动化控制层，屏蔽底层复杂度，提升可复用性与稳定性。
- 技术路线一致：以 Playwright 为底层实现，强调无头部署、异步调用、错误处理与重试/降级。

## Consistency Checks

- Proposal ↔ Specs：proposal 列出的 6 个 capability 均已在 `specs/*/spec.md` 落地；命名一致（kebab-case）。
- Specs ↔ Design：design 选择 Playwright、浏览器池、崩溃重启与降级策略，与 specs 的能力边界大体一致。
- Design ↔ Tasks：tasks 覆盖安装、模块结构、浏览器池、导航/交互/提取/等待、验证码降级、崩溃重启、缓存与测试。
- Cross-change：`policy-monitor`/`rag-knowledge-base` 明确依赖本变更，依赖方向合理。

## Findings

### MUST-FIX (Blocking)

- (none)

### SHOULD (Recommended)

- **接口契约更具体**：在 specs 中补齐每个 tool 的输入/输出（返回字段、错误码、截图/快照格式）、timeout 默认值、selector 约定（CSS/XPath/text）与重试语义（哪些错误重试、幂等性）。
- **会话/上下文模型**：明确 session 的概念（browser/context/page 生命周期、并发隔离、cookie/headers 注入、是否允许复用同一 context），避免后续 `policy-monitor` 需求反推导致破坏性改动。
- **可观测性**：定义最小日志字段（url、selector、step、elapsed、trace_id），失败时产出截图/trace 的落盘位置与保留策略（建议落到 `storage/` 而非仓库目录）。
- **缓存边界**：`browser-cache` 建议明确 key 规范、TTL、持久化目录与上限（size/entry），并说明是否用于“抓取结果”还是“会话状态”。
- **验证码降级路径**：当前设计为“提示人工处理”，建议补齐在无人值守服务端的处理方式（例如：返回错误 + 截图 + 允许外部注入 cookie/已登录会话）。

## Risks / Trade-offs

- 反爬/封禁风险：需要速率限制、UA/代理策略与失败退避；否则高频抓取会影响稳定性。
- 资源泄漏风险：浏览器池/页面未关闭会导致内存增长；需要强制超时回收与健康检查。

## Decision

- Status: Approved
- Rationale: 结构完整、依赖关系清晰；建议在进入实现前把“tool 契约/会话模型/可观测性”补齐为更可测试的 specs。

