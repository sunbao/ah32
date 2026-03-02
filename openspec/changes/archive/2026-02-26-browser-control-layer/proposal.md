# Proposal: browser-control-layer

## Why

BidAgent 需要获取外部数据（政策信息、企业信用、招标公告等），但缺乏统一的浏览器自动化能力。现有的 Chrome MCP 工具使用复杂，需要封装成统一的浏览器控制层，供上层 Skill 调用。

## What Changes

1. **新增浏览器控制层模块**
   - 封装 Playwright 操作为简单易用的 Tool（替代底层 Chrome MCP 的复杂度）
   - 提供统一的错误处理和重试机制

2. **新增基础操作能力**
   - 页面导航 (navigate)
   - 元素交互 (click, fill, hover)
   - 数据提取 (extract, snapshot)
   - 等待机制 (wait_for)

3. **新增高级操作能力**
   - 验证码处理 (captcha)
   - 数据缓存 (cache)
   - 会话管理 (session)

4. **集成到 Skill 系统**
   - 提供统一的 Tool 接口
   - 支持 Skill 声明式调用

## Capabilities

### New Capabilities

- `browser-navigator`: 页面导航 - URL 访问、页面加载、导航控制
- `browser-interactor`: 元素交互 - 点击、填写、悬停、拖拽
- `browser-extractor`: 数据提取 - 结构化数据抽取、页面快照
- `browser-waiter`: 等待机制 - 元素等待、文本等待、条件等待
- `browser-captcha`: 验证码处理 - 图形验证码、滑块验证码
- `browser-cache`: 数据缓存 - 抓取结果缓存、过期管理

### Modified Capabilities

- 无

## Impact

- **新增文件**:
  - `src/ah32/integrations/browser/` - 浏览器控制模块（Playwright 实现）
  - 复用现有 Skill Tool 机制

- **技术选型**:
  - 使用 Playwright（而非 Chrome MCP）
  - 服务器部署，原生支持无头模式
  - 浏览器池管理：多个 Tool 复用同一浏览器实例
  - 异常处理：浏览器崩溃自动重启

- **依赖**:
  - Playwright (Python)
  - Python 异步执行环境

- **被依赖**:
  - `rag-knowledge-base` - 依赖此模块抓取政策数据
  - `policy-monitor` - 依赖此模块监控政策更新
