## Purpose

实现页面导航功能，支持 URL 访问、页面加载控制。

---

## ADDED Requirements

### Requirement: URL 导航
系统 SHALL 支持导航到指定 URL。

#### Scenario: 成功导航
- **WHEN** 调用 navigate_to 并传入有效 URL
- **THEN** 页面加载完成，返回页面标题

#### Scenario: 导航失败
- **WHEN** URL 无效或网络错误
- **THEN** 返回错误信息，包含失败原因

### Requirement: 页面加载控制
系统 SHALL 支持等待页面加载完成。

#### Scenario: 等待页面加载
- **WHEN** 设置 wait_until=networkidle
- **THEN** 等待网络请求完成

#### Scenario: 自定义等待
- **WHEN** 设置 wait_until=domcontentloaded
- **THEN** 等待 DOM 解析完成

---

## Tool Contract (v1)

### Tool: navigate_to

**Input**
- `url` (string, required)
- `wait_until` (string, optional): `load` | `domcontentloaded` | `networkidle`（默认 `networkidle`）
- `timeout_ms` (integer, optional): 默认 30000，可通过环境变量 `AH32_BROWSER_TIMEOUT_MS` 覆盖

**Output**
- 统一返回 `BrowserOperationResult`：
  - `ok` (boolean)
  - `data`：成功时包含 `title`、`final_url`
  - `error`：失败时包含 `code`、`message`（可选 `details`）
  - `meta`：`trace_id`、`elapsed_ms`、`url`、`step`，以及失败时的 `screenshot_path` / `trace_path`

**Implementation**
- `src/ah32/integrations/browser/api.py`：`open_browser_session` + `navigate_to`
