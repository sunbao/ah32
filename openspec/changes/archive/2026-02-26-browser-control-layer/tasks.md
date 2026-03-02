# Tasks: browser-control-layer

## 1. 环境准备

- [x] 1.1 安装 Playwright 依赖
- [x] 1.2 验证 Playwright 可用性

## 2. 模块结构搭建

- [x] 2.1 创建 browser 控制模块目录 `src/ah32/integrations/browser/`
- [x] 2.2 定义基础数据结构和接口

## 3. 浏览器池管理

- [x] 3.1 实现浏览器单例模式
- [x] 3.2 实现引用计数机制
- [x] 3.3 实现浏览器安全释放

## 4. 导航功能实现

- [x] 4.1 实现 navigate_to 函数
- [x] 4.2 实现页面加载控制

## 5. 交互功能实现

- [x] 5.1 实现 click_element 函数
- [x] 5.2 实现 fill_form 函数
- [x] 5.3 实现 hover_element 函数

## 6. 数据提取实现

- [x] 6.1 实现 take_snapshot 函数
- [x] 6.2 实现 extract_data 函数

## 7. 等待机制实现

- [x] 7.1 实现 wait_for_element 函数
- [x] 7.2 实现 wait_for_text 函数

## 8. 验证码处理

- [x] 8.1 实现 detect_captcha 函数
- [x] 8.2 实现降级处理逻辑

## 9. 崩溃重启机制

- [x] 9.1 实现浏览器健康检查
- [x] 9.2 实现崩溃自动重启
- [x] 9.3 实现异常日志记录

## 10. 缓存机制

- [x] 10.1 实现内存缓存
- [x] 10.2 实现文件缓存持久化
- [x] 10.3 定义缓存 key 规范、TTL、存储目录（storage/browser_cache/）

## 11. 会话/上下文管理

- [x] 11.1 定义 browser/context/page 生命周期
- [x] 11.2 支持并发隔离
- [x] 11.3 支持 cookie/headers 注入

## 12. 可观测性

- [x] 12.1 定义日志字段（url, selector, step, elapsed, trace_id）
- [x] 12.2 定义失败时截图/trace 落盘位置（storage/browser_traces/）
- [x] 12.3 定义日志保留策略

## 13. 接口契约完善

- [x] 13.1 定义每个 tool 的输入/输出 schema
- [x] 13.2 定义 timeout 默认值
- [x] 13.3 定义 selector 约定（CSS/XPath/text）
- [x] 13.4 定义重试语义（哪些错误重试、幂等性）

## 14. 验证码降级处理

- [x] 14.1 定义降级处理路径
- [x] 14.2 支持外部注入已登录会话
- [x] 14.3 返回错误 + 截图供人工处理

## 15. 集成测试

- [x] 15.1 端到端抓取测试
- [x] 15.2 错误处理测试
- [x] 15.3 浏览器池复用测试
- [x] 15.4 会话隔离测试
