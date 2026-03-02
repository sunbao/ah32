## Purpose

实现等待机制，支持元素和文本的等待。

---

## ADDED Requirements

### Requirement: 等待元素
系统 SHALL 等待元素出现。

#### Scenario: 元素出现
- **WHEN** 调用 wait_for_element 并设置超时
- **THEN** 元素出现时返回成功

#### Scenario: 超时
- **WHEN** 元素在超时时间内未出现
- **THEN** 返回超时错误

### Requirement: 等待文本
系统 SHALL 等待文本出现。

#### Scenario: 文本出现
- **WHEN** 调用 wait_for_text 并设置超时
- **THEN** 文本出现时返回成功

---

## Tool Contract (v1)

### Tool: wait_for_element

**Input**
- `selector` (string, required)
- `timeout_ms` (integer, optional)

**Output**
- 成功：`ok=true`，`data.found=true`
- 超时：`ok=false`，`error.code=E_WAIT_TIMEOUT`，并尽量返回 `meta.screenshot_path`/`meta.trace_path`

### Tool: wait_for_text

**Input**
- `text` (string, required)
- `timeout_ms` (integer, optional)

**Output**
- 成功：`ok=true`，`data.found=true`
- 超时：`ok=false`，`error.code=E_WAIT_TIMEOUT`

**Implementation**
- `src/ah32/integrations/browser/api.py`
