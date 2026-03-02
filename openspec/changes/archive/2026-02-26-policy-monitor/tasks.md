# Tasks: policy-monitor

## 1. 基础设施搭建

- [x] 1.1 创建缓存管理模块 `policy_cache.py`
  - 读取/写入缓存文件
  - 检查缓存时效（默认24小时，可配置 `force_refresh` 跳过）
  - 更新时间戳
  - **缓存位置**：`storage/policy_cache/`（运行时数据，非仓库）

- [x] 1.2 定义政策数据 JSON Schema
  - 字段：policy_name, issued_by, issue_date, document_number, source_url, key_points, category, keywords

## 2. Playwright 抓取实现

> 依赖 browser-control-layer 实现后调用

- [x] 2.1 实现政策列表页抓取
  - 访问 ccgp.gov.cn/zcfg/mof
  - 解析最新政策标题、日期、文号

- [x] 2.2 实现政策详情页抓取
  - 访问政策详情页 URL
  - 提取政策正文内容

- [x] 2.3 实现增量检测
  - 对比已有政策列表
  - 识别新增政策

## 3. 数据存储

- [x] 3.1 实现政策 JSON 文件存储
  - 命名规则：基于 document_number（文号）或 source_url hash
  - 例如：`{文号}.json` 或 `{hash(url)}.json`
  - 保存到 `data/rag/policies/`
  - 避免特殊字符（空格/斜杠/冒号）

## 4. Skill 集成

- [x] 4.1 修改 bidding-helper/skill.json
  - 新增 `check_policy_update` / `get_latest_policies` tool
  - 定义输入参数

- [x] 4.2 实现 skill tool 脚本
  - `check_policy_update.py` - 检查更新
  - `get_latest_policies.py` - 获取最新政策

## 5. 重大信息标记

- [x] 5.1 实现关键词识别逻辑
  - 修订/草案 → 🔥
  - 专项整治 → 🔥

- [x] 5.2 实现标记输出
  - 在返回结果中标记重大政策

## 7. 测试与调优

- [x] 7.1 单元测试
  - 缓存模块测试
  - 解析逻辑测试

- [x] 7.2 集成测试
  - 端到端抓取测试
  - Skill 调用测试

- [x] 7.3 异常处理
  - 网络失败处理
  - 页面结构变化适配

## 8. 与 rag-knowledge-base 边界

> 明确分工：policy-monitor 负责抓取存入 data/rag，本变更不负责检索

- [x] 8.1 确认生成的政策 JSON 格式符合 rag-knowledge-base 入库要求
- [x] 8.2 移除 policy-rag 相关任务（检索由 rag-knowledge-base 负责）
