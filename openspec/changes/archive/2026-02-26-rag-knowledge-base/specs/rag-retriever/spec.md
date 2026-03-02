## Purpose

实现统一的 RAG 检索接口。

---

## ADDED Requirements

### Requirement: 关键词检索
系统 SHALL 支持关键词检索。

#### Scenario: 关键词搜索
- **WHEN** 输入搜索关键词
- **THEN** 返回匹配的结果列表

### Requirement: 向量检索
系统 SHALL 支持语义向量检索。

#### Scenario: 语义搜索
- **WHEN** 输入自然语言查询
- **THEN** 返回语义相似的结果

### Requirement: 混合检索
系统 SHALL 支持关键词和向量混合检索。

#### Scenario: 混合模式
- **WHEN** 启用混合检索
- **THEN** 结合关键词和向量结果返回

---

## Implementation Notes

- 向量存储：`src/ah32/knowledge/store.py`（ChromaDBStore / LocalVectorStore）
- 入库脚本：`src/ah32/knowledge/ingest.py`（`ah32-ingest ingest` / `ah32-ingest query`）
- API 检索：`src/ah32/server/rag_api.py`（`/api/rag/search`）
