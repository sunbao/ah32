## Purpose

实现数据提取功能，支持从页面中抽取结构化数据。

---

## ADDED Requirements

### Requirement: 快照提取
系统 SHALL 支持获取页面快照。

#### Scenario: 获取文本快照
- **WHEN** 调用 take_snapshot
- **THEN** 返回页面文本内容

### Requirement: 结构化数据提取
系统 SHALL 支持根据 schema 提取数据。

#### Scenario: 提取表格数据
- **WHEN** 传入表格选择器和列名映射
- **THEN** 返回结构化数组数据

---

## Tool Contract (v1)

### Tool: take_snapshot

**Input**
- 无（在当前 page 上执行）

**Output**
- 成功：`ok=true`，`data.text=<body文本>`

### Tool: extract_data

**Input**
- `schema` (object): `{field: selector}` 映射
- `timeout_ms` (integer, optional)

**Output**
- 成功：`ok=true`，`data.fields` 为结构化字段对象

### Tool: extract_table

**Input**
- `table_selector` (string)
- `columns` (object): `{field: col_index|selector}`（col_index 为 0-based）
- `timeout_ms` (integer, optional)

**Output**
- 成功：`ok=true`，`data.rows` 为数组

**Implementation**
- `src/ah32/integrations/browser/api.py`
