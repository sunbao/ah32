## Purpose

实现合同模板库，支持合同模板的存储和检索。

---

## ADDED Requirements

### Requirement: 合同模板加载
系统 SHALL 加载合同模板数据。

#### Scenario: 加载模板
- **WHEN** 调用 load_contract_templates
- **THEN** 返回合同模板列表

### Requirement: 合同模板检索
系统 SHALL 支持按类型检索合同模板。

#### Scenario: 按类型检索
- **WHEN** 输入合同类型（采购/施工/服务）
- **THEN** 返回匹配的标准合同模板

---

## Implementation Notes

- 数据文件：`data/rag/contracts/*.json`
- 向量入库：`src/ah32/knowledge/ingest.py`（`ah32-ingest ingest --only-types contract`）
