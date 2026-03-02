## Purpose

实现历史案例库，支持过往案例的存储和检索。

---

## ADDED Requirements

### Requirement: 案例数据加载
系统 SHALL 加载历史案例数据。

#### Scenario: 加载案例
- **WHEN** 调用 load_cases
- **THEN** 返回案例列表

### Requirement: 案例检索
系统 SHALL 支持按条件检索案例。

#### Scenario: 按类型检索
- **WHEN** 输入案例类型
- **THEN** 返回匹配的案例列表

---

## Implementation Notes

- 数据文件：`data/rag/cases/*.json`
- 向量入库：`src/ah32/knowledge/ingest.py`（`ah32-ingest ingest --only-types case`）
