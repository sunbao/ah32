# Review: policy-monitor

## Summary

- 目标：在“手动触发”前提下，通过缓存时效（默认 24h，可配置）实现政策资讯的增量获取与结构化存储，并提供重大信息标记与（可选）RAG 检索。
- 依赖：抓取能力复用 `browser-control-layer`（Playwright）。

## Consistency Checks

- Proposal ↔ Specs：capabilities（policy-monitor / policy-rag / sensitive-words）均已生成对应 specs 文件。
- Specs ↔ Design：设计强调“手动触发 + TTL 检查 + 文件缓存”，与 `policy-monitor` spec 的缓存检查要求一致；抓取实现已与 `browser-control-layer` 对齐。
- Design ↔ Tasks：tasks 覆盖缓存模块、抓取列表/详情、增量检测、存储、重大标记、skill 集成与（可选）RAG。
- Cross-change：与 `rag-knowledge-base` 的政策库/敏感词库边界存在潜在重叠，需要澄清职责划分。

## Findings

### MUST-FIX (Blocking)

- **缓存文件位置与可控性**：tasks 指向 `data/rag/.policy_cache.json`。建议明确该文件是“运行时缓存”（应落到 `storage/`）还是“可提交数据”（应落到 `data/`）。否则容易出现误提交/环境污染。
- **文件命名规则需要安全化**：`{policy_name}_{year}.json` 在真实标题下可能包含空格/斜杠/特殊字符；需要定义 slug/哈希/来源ID（例如基于 source_url 或文号）来保证跨平台可写。
- **能力边界去重**：本变更包含 `sensitive-words` 与 `policy-rag`，而 `rag-knowledge-base` 同时规划了 `sensitive-words-lib`/`policy-lib`/`rag-retriever`。需要明确“policy-monitor 负责抓取与更新、rag-knowledge-base 负责检索/索引”的分工，否则后续会出现重复实现与数据源不一致。

### SHOULD (Recommended)

- **对外返回结构**：建议在 `policy-monitor` spec 中补齐 tool 的输入/输出 schema（last_updated、items[] 字段、is_major 标记、source_url、error/fallback 信息）。
- **强制刷新**：建议支持 `force_refresh=true` 绕过 TTL，便于排障与演示。
- **失败降级**：明确抓取失败时的行为（返回缓存 + 明确提示 + 记录日志/截图），避免“看似成功但数据未更新”。

## Risks / Trade-offs

- 网站结构变化导致解析失败：需要可观测性与快速修复路径（selector 统一管理、失败样本保存）。
- 数据来源合规/版权：建议在存储中保留来源链接与抓取时间，避免“无来源复制”风险。

## Decision

- Status: Approved
- Rationale: 已明确运行时缓存落盘到 `storage/policy_cache/`、政策文件命名采用文号/URL hash，且检索/入库职责归属 `rag-knowledge-base`，可进入实现与联调。
