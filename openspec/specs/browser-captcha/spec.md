# browser-captcha Specification

## Purpose
TBD - created by archiving change browser-control-layer. Update Purpose after archive.
## Requirements
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

