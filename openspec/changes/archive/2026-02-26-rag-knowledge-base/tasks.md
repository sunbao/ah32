# Tasks: rag-knowledge-base

## 1. 数据目录确认

- [x] 1.1 确认现有目录结构（policies/ contracts/ cases/ sensitive_words/）
- [x] 1.2 验证 data/rag/ 目录可访问

## 2. 敏感词库完善

- [x] 2.1 补充地域歧视词汇
- [x] 2.2 补充排斥限制竞争词汇
- [x] 2.3 补充资质门槛违规词汇

## 3. 政策法规库完善

- [x] 3.1 补充政府采购法全文
- [x] 3.2 补充招标投标法
- [x] 3.3 补充相关实施条例

## 4. 合同模板库

- [x] 4.1 收集政府采购合同示范文本
- [x] 4.2 收集建设工程施工合同示范文本

## 5. 历史案例库

- [x] 5.1 定义案例数据结构
- [x] 5.2 收集脱敏案例

## 6. 数据入库（向量化）

> 解决：data/rag/ JSON 文件如何导入 Chroma 向量库

- [x] 6.1 实现批量导入脚本
  - 读取 data/rag/*.json 文件
  - 文档切分策略（按章节/段落）
  - 生成 metadata（source/type/category）
  - 调用 ChromaDBStore.add_documents

- [x] 6.2 实现增量更新检测
  - 基于文件 mtime 或 hash 检测变化
  - 仅重新入库新增/修改的文档

- [x] 6.3 配置 collection 和 embedding
  - collection_name 命名规范
  - embedding 模型选择

## 7. RAG 检索验证

> 注意：无需实现检索代码，复用现有 ChromaDBStore (src/ah32/knowledge/store.py)

- [x] 7.1 验证关键词检索功能
- [x] 7.2 验证向量检索功能（可选）
- [x] 7.3 验证混合检索功能

## 8. 集成测试

- [x] 8.1 检索效果测试
- [x] 8.2 性能测试

## 9. 与 policy-monitor 边界澄清

> 明确分工：policy-monitor 负责抓取存入 data/rag，本变更负责入库+检索

- [x] 9.1 确认 policy-monitor 生成的政策 JSON 格式
- [x] 9.2 定义增量入库触发机制（手动/启动时/按需）
