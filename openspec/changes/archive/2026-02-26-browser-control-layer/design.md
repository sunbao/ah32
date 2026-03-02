# Design: browser-control-layer

## Context

**背景**：
- 需要获取外部数据（政府采购网、信用中国等）
- 需要封装浏览器自动化能力供 Skill 调用

**当前状态**：
- Playwright 可在 Python 环境中安装使用
- 已有 architecture_browser_control.md 设计参考
- Skill 系统支持 Tool 调用

**约束**：

- 使用 Playwright 作为底层（服务器部署友好，原生支持无头模式）
- 支持异步操作
- 错误处理要友好

## Goals / Non-Goals

**Goals:**
- 实现 Playwright 浏览器控制层
- 提供浏览器池管理（多个 Tool 复用同一浏览器实例）
- 提供统一的错误处理和崩溃重启机制
- 支持常用的浏览器操作场景

**Non-Goals:**
- 不处理所有验证码（降级处理）
- 不做复杂的页面渲染
- 不实现所有浏览器操作（按需扩展）

## Decisions

### 决策1：技术选型

**选择**：Playwright（而非 Chrome MCP）

**理由**：
- 服务器部署友好，原生支持无头模式
- Python 生态完善，async/await 原生支持
- 浏览器池模式支持多 Tool 复用

### 决策2：浏览器池管理

**选择**：单例浏览器实例 + 引用计数

**理由**：
- 避免频繁启动浏览器开销
- 多个 Tool 可共享同一实例
- 引用计数确保安全释放

### 决策3：异常处理

**选择**：崩溃自动重启

**理由**：
- 浏览器进程可能意外退出
- 自动重启可保证服务连续性
- 记录日志供排查

### 决策4：错误处理策略

**选择**：重试 + 降级 + 错误提示

- 网络错误：重试 3 次
- 元素未找到：截图记录，返回错误
- 验证码：降级提示用户处理
- 崩溃：自动重启并重试

### 决策5：缓存机制

**选择**：内存缓存 + 文件缓存

**存储位置**：
- 运行时缓存：`storage/browser_cache/`
- 失败 trace：`storage/browser_traces/`

**key 规范**：`{url_hash}_{timestamp}`

### 决策6：会话/上下文模型

**选择**：browser → context → page 层级

- browser：浏览器进程，池化管理
- context：独立会话，支持 cookie/headers 注入
- page：单个页面，操作对象

### 决策7：可观测性

**日志字段**：
- url, selector, step, elapsed, trace_id
- 失败时自动截图，落盘到 storage/

**保留策略**：
- trace 文件保留 7 天
- 截图保留 30 天

| 风险 | 影响 | 缓解 |
|------|------|------|
| 浏览器崩溃 | 服务中断 | 自动重启 |
| 目标网站反爬 | 请求被阻 | 降低频率 |
| 页面结构变化 | 解析失败 | 预留适配 |

## Migration Plan

1. 安装 Playwright 依赖
2. 创建 browser 模块目录结构
3. 实现浏览器池管理
4. 实现基础操作封装
5. 集成到 Skill 系统
6. 测试和调优
