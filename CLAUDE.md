# Claude Code 行为准则（仅供开发/协作用）

说明：
- 这是给 IDE/开发代理（如 Claude Code）和团队协作使用的开发规范。
- 运行中的阿蛤助手不会读取/依赖本文件；运行时规则请见 `docs/AH32_RULES.md`（以及用户可编辑的规则文档目录）。


## 🔥 核心原则：最新优先



**只保留最新代码，不允许向后兼容**



- ❌ 禁止向后兼容性代码（不维护适配层、桥接代码、已弃用API）

- ✅ 冲突时修改现有代码，优先保证新架构完整性

- ✅ 重构要彻底，宁可一次性大改，不保留临时过渡方案



## 🚀 环境与启动



- 开发测试环境：执行 `npm run dev` 和 `wpsjs debug`

- 禁止 `npm run build`（非生产环境）

- 端口固定（前后端），端口占用先终止再启动

- 分工：Claude负责代码修改，用户负责启动测试



## 💎 质量标准



### 代码清理



- **DRY原则**：消除重复代码，创建统一辅助函数

- **KISS原则**：优先简单解决方案，避免过度工程化

- 删除无用`pass`函数、注释代码、死代码

- 单个函数不超过50行



### 前端规范



**✅ 允许**：setTimeout、超时控制、requestAnimationFrame、事件驱动



**❌ 禁止**：setInterval、定时轮询、定期状态检查



**🎯 替代**：WebSocket实时通信、手动触发刷新、Vue响应式状态



### LLM调用



- **必须有LLM**（llm_required=True）：检查llm为None并抛出异常

- **不需要LLM**（llm_required=False）：完全不使用LLM参数

- **禁止fallback模式**：明确依赖关系，不提供降级处理



### 错误处理

- **前后端禁止静默失败**：所有错误必须捕获并显示给用户
- **错误信息优化**：提供清晰、可操作的错误提示，避免技术术语
- **异常传播**：前端显示具体错误原因，后端记录详细日志
- **用户友好**：错误提示要帮助用户理解问题并知道如何解决
- **实现约束（工程层面）**：
  - 禁止 `except: pass` / `except Exception: pass` / `catch (e) {}` 这类“吞掉异常”的写法。
  - 若必须 best-effort（WPS/Office API 差异、能力探针等），也要：1) 写日志（带堆栈）；2) 在可观测数据里标注 fallback/分支；3) 对用户给出可理解的提示（必要时提示截图反馈）。
  - WPS Taskpane 启动白屏/闪断：`taskpane.html` 会把最后一次致命错误写入 localStorage `ah32_last_error` 并展示覆盖层 `ah32-fatal-error-overlay`；排障时优先让用户截图该覆盖层。


## 🧪 测试规则



- **必须使用真实LLM**进行测试，禁止MockLLM

- 从`.env`文件读取配置，使用`load_llm(settings)`创建真实LLM实例

- 测试代码分类：单元测试、功能测试、集成测试



### Session ID规范



- **核心**：session_id是多轮对话上下文关联的唯一标识

- **流程**：前端请求session_id → 缓存 → 聊天时携带session_id → 关联上下文

- **注意**：禁止无session_id请求、禁止重复生成、必须携带X-API-Key头



## 📝 WPS插件JS宏



- **核心架构**：用户需求→Agent→GenerateJsMacroCodeTool→LLM→JS宏→前端执行

- **⚠️ 重要**：WPS免费版不支持VBA，必须使用JS宏

- **执行流程**：前端检测` ```js `代码块 → JSMacroExecutor.execute(code) → 动态执行

- **API要点**：`selection.TypeText()`插入文本、`app.ActiveDocument.Save()`保存、`doc.Tables.Add()`创建表格

- **禁止**：VBA语法、硬编码响应、环境检查跳过



## 🎯 性能要求



- 优先考虑性能优化，避免不必要抽象层

- LLM调用延迟 < 5秒，缓存命中率 > 50%

- 事件驱动替代轮询，提升响应速度



---



**记住：在Ah32项目中，我们追求最新、最简洁、最高效的代码实现。**

