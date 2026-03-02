## Purpose

实现元素交互功能，支持点击、填写、悬停等操作。

---

## ADDED Requirements

### Requirement: 元素点击
系统 SHALL 支持点击页面元素。

#### Scenario: 点击按钮
- **WHEN** 调用 click_element 并传入选择器
- **THEN** 元素被点击，返回成功

### Requirement: 表单填写
系统 SHALL 支持填写表单字段。

#### Scenario: 输入文本
- **WHEN** 调用 fill_form 并传入字段和值
- **THEN** 字段被填写，返回成功

### Requirement: 元素悬停
系统 SHALL 支持悬停在元素上。

#### Scenario: 悬停显示
- **WHEN** 调用 hover_element 并传入选择器
- **THEN** 元素显示悬停效果

---

## Tool Contract (v1)

### Selector Convention

- CSS：默认（例如 `#submit`、`.btn.primary`）
- XPath：以 `xpath=` 前缀，或以 `//`/`(//` 开头
- Text：以 `text=`（或 `text:`）前缀

### Tool: click_element

**Input**
- `selector` (string, required)
- `timeout_ms` (integer, optional): 默认 30000

**Output**
- `BrowserOperationResult.data.clicked=true`

### Tool: fill_form

**Input**
- `fields` (object, required): `{selector: value}` 映射
- `timeout_ms` (integer, optional)

**Output**
- `BrowserOperationResult.data.filled=<count>`

### Tool: hover_element

**Input**
- `selector` (string, required)
- `timeout_ms` (integer, optional)

**Output**
- `BrowserOperationResult.data.hovered=true`

**Implementation**
- `src/ah32/integrations/browser/api.py`
