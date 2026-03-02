## Purpose

实现验证码处理功能，支持检测和处理常见验证码。

---

## ADDED Requirements

### Requirement: 验证码检测
系统 SHALL 检测页面是否存在验证码。

#### Scenario: 无验证码
- **WHEN** 页面无验证码
- **THEN** 返回正常流程继续

#### Scenario: 有验证码
- **WHEN** 检测到验证码
- **THEN** 返回降级处理提示

### Requirement: 验证码处理
系统 SHALL 提供验证码处理建议。

#### Scenario: 滑块验证码
- **WHEN** 检测到滑块验证码
- **THEN** 提示需要人工处理

#### Scenario: 图形验证码
- **WHEN** 检测到图形验证码
- **THEN** 提示需要人工处理

---

## Tool Contract (v1)

### Tool: detect_captcha

**Input**
- 无（在当前 page 上检测）

**Output**
- 成功：`ok=true`，`data.detected` (boolean) + `data.kind`（`slider`/`image`/`unknown`）
- 失败：`ok=false`，`error.code=E_CAPTCHA_DETECT_FAILED`

### Degrade Path

- 若 `detected=true`，上层调用方 SHOULD：
  - 返回可读错误（提示“需要人工处理”）
  - 携带失败截图/trace 的落盘路径（`storage/browser_traces/`）
  - 支持外部注入 cookie/headers 以复用已登录会话

**Implementation**
- `src/ah32/integrations/browser/api.py`
