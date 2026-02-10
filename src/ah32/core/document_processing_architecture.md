# Ah32 增强文档处理架构设计

## 架构概述

基于LangChain + Unstructured + ChromaDB的完整文档处理架构，实现渐进式迁移。

## 核心组件

### 1. 文档加载器层次
```
Ah32DocumentLoader (统一接口)
    ├── SimpleLoader (原生实现) - .md/.txt
    ├── LangChainLoader - 复杂格式
    └── UnstructuredLoader - 高级解析
```

### 2. 文档分割器
```
Ah32TextSplitter
    ├── SimpleSplitter - 简单分割
    ├── LangChainSplitter - 智能分割
    └── HybridSplitter - 混合策略
```

### 3. 向量存储适配器
```
ChromaDBAdapter (适配Ah32现有接口)
    ├── LangChainChromaAdapter
    └── NativeChromaAdapter
```

## 文件结构

```
src/ah32/
├── core/
│   ├── __init__.py
│   ├── document_loader.py        # 统一文档加载器
│   ├── text_splitter.py         # 智能文档分割器
│   └── vector_store_adapter.py   # 向量存储适配器
├── services/
│   └── enhanced_at_handler.py     # 增强@引用处理器
├── knowledge/
│   ├── enhanced_store.py         # 增强向量存储
│   └── enhanced_embeddings.py    # 嵌入模型管理
└── config/
    └── document_config.py        # 文档处理配置
```

## 技术栈

- **LangChain**: 0.1.0+
- **Unstructured**: 0.12.0+
- **ChromaDB**: 0.4.18+
- **Sentence-Transformers**: 2.2.2+

## 向后兼容性

- ✅ 保持现有@引用API不变
- ✅ 保持ChromaDB存储格式
- ✅ 保持会话隔离机制
- ✅ 保持三层记忆架构

## 性能目标

- 文档加载速度: < 2秒 (1MB文件)
- 文档分割速度: < 500ms (1000字符)
- 向量入库速度: < 1秒 (100块)
- 内存使用: < 512MB (处理过程中)
