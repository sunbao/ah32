# Review: rag-knowledge-base

## Summary

- 目标：统一 `data/rag/` 目录结构与数据格式，沉淀敏感词/政策/合同/案例等核心语料，并提供关键词/向量/混合检索能力。
- 路线：声明“复用现有 `ChromaDBStore`，无需新增代码模块”，主要通过补充数据文件达成。

## Consistency Checks

- Proposal ↔ Specs：capabilities（多个 *-lib + rag-retriever）均有对应 specs 文件，但整体较抽象。
- Specs ↔ Design：design 强调复用 `ChromaDBStore`；specs 中出现 `load_*` 这类函数名，未与现有代码接口对齐（更像概念接口）。
- Design ↔ Tasks：tasks 偏向“补充数据 + 验证检索”，但对“如何把 data/rag/ 数据入库（embedding/索引）”没有任务拆解。
- Cross-change：`policy-monitor` 计划生成政策 JSON；需要明确这些文件是否作为本知识库的输入源，以及更新后如何增量入库。

## Findings

### MUST-FIX (Blocking)

- **入库/索引路径未定义**：当前后端检索依赖向量库（Chroma），但仓库中尚未看到将 `data/rag/**` 自动导入/增量更新到向量库的机制。若只“添加数据文件”而不入库，`rag-retriever` 的向量检索能力无法落地。需要补齐：
  - 触发方式（启动时一次性导入？按需导入？手动命令？）
  - 文档切分策略、metadata（source/type/category）、去重与更新检测
  - collection_name/embedding 维度迁移策略（避免切换模型导致 Chroma 报错）

- **能力/接口需与现有代码对齐**：specs 里 `load_policies/load_cases/...` 目前不是现有公开接口（现有更多是 `ChromaDBStore.add_documents/similarity_search/search_by_keywords/...`）。建议将 specs 改为“对外 tool/API 契约”，并明确由哪些服务/skill 暴露。

### SHOULD (Recommended)

- **检索结果格式**：在 `rag-retriever` spec 中定义返回结构（content/snippet、source、score、metadata），以及混合检索的排序策略（权重/阈值）。
- **数据质量与脱敏**：案例库明确脱敏规则；政策/合同建议保留来源与版本信息，便于追溯。
- **与 policy-monitor 的边界**：建议由 `policy-monitor` 负责抓取更新、由本变更负责“入库与检索”，避免重复实现 `policy-rag`。

## Risks / Trade-offs

- 数据膨胀与性能：需要限流、批量入库、增量更新与缓存策略，否则 embedding 会成为瓶颈。

## Decision

- Status: Approved
- Rationale: 已补齐 `data/rag/` → Chroma 的入库/增量更新脚本（`ah32-ingest`），并对齐轻量加载接口（`rag_library`），知识库与检索闭环可落地。
