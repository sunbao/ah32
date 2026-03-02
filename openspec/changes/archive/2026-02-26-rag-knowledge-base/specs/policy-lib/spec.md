## Purpose

实现政策法规库，支持政策数据的存储和检索。

---

## ADDED Requirements

### Requirement: 政策数据加载
系统 SHALL 加载政策数据。

#### Scenario: 加载政策
- **WHEN** 调用 load_policies
- **THEN** 返回政策列表

### Requirement: 政策检索
系统 SHALL 支持按条件检索政策。

#### Scenario: 按关键词检索
- **WHEN** 输入关键词
- **THEN** 返回匹配的政策列表

#### Scenario: 按时间检索
- **WHEN** 输入时间范围
- **THEN** 返回该范围内的政策

---

## Implementation Notes

- 数据文件：`data/rag/policies/*.json`
- 轻量加载：`src/ah32/knowledge/rag_library.py`（`load_policies`）
- 向量入库：`src/ah32/knowledge/ingest.py`（`ah32-ingest ingest`）
