# TODO: Excel(ET) Agentic 智能数据分析计划

## 背景
Excel 操作不应是简单的"点击工具栏"，而是通过 **Agentic 对话** 让 AI 理解用户的数据分析需求，自动生成 Plan 执行复杂的数据分析和呈现。

---

## 核心理念

**用户需求** → **AI 理解数据** → **AI 推荐分析方案** → **自动生成 Plan 执行** → **结果呈现**

---

## 落地现状（2026-02-20）

这份文档偏“愿景规划”。以当前代码为准：
- ✅ 已有 `ah32.plan.v1` + `host_app=et` 的可执行闭环：`create_pivot_table/sort_range/filter_range/set_*` + `insert_table/insert_chart_from_selection`。
- ✅ 前端会附带 `active_doc_text/active_et_meta/active_et_header_map`（用于 skill 工具做 deterministic 摘要/建议）；其中 ET 的 `active_doc_text` 已改为 **bounded preview**（`limit_rows/limit_cols/limit_cells/max_chars`，并在超预算时标注 `truncated_by_char_budget=true`），避免“读很多再截断”。
- ✅ `transform_range` 已落地（当前仅 `transpose`）。
- ✅ 图表能力：`insert_chart_from_selection` 支持 `sheet_name + source_range` 直接选定范围建图；并支持 `title/legend/add_trendline/show_data_labels` 等 best-effort 字段。
- ✅ 容错：若 plan 误用 `add_chart`（WPP op），服务端 normalize 会 best-effort 映射为 `insert_chart_from_selection`（ET）。

---

## 阶段一：数据理解层

### 1.1 数据结构识别

| 能力 | 描述 | 实现方式 |
|------|------|----------|
| 列类型识别 | 自动识别数值/文本/日期/百分比列 | 分析数据特征 |
| 数据质量检测 | 检测空值、异常值、重复值 | 统计校验 |
| 数据分布分析 | 自动分析数值分布、占比 | 聚合计算 |
| 时间序列检测 | 识别日期列和时间特征 | 模式匹配 |

### 1.2 数据摘要生成

- 自动生成数据概览（行数、列数、类型）
- 关键统计指标（均值、中位数、最大最小值）
- 数据质量报告

---

## 阶段二：智能分析推荐

### 2.1 分析场景识别

根据数据特征自动推荐分析类型：

| 场景 | 适用数据 | 推荐操作 |
|------|----------|----------|
| 趋势分析 | 含日期/序号的数值数据 | 折线图、趋势线 |
| 占比分析 | 分类汇总数据 | 饼图、环形图 |
| 对比分析 | 多类别数值 | 柱状图、条形图 |
| 分布分析 | 大量数值数据 | 直方图、箱线图 |
| 相关性分析 | 多列数值 | 散点图、相关系数 |
| 排名分析 | 排序数据 | 条形图、数据条 |

### 2.2 智能建议系统

通过对话理解用户意图：
- "分析销售趋势" → 时间序列分析 + 趋势图
- "看看各产品占比" → 分类汇总 + 饼图
- "对比各部门业绩" → 透视表 + 柱状图

---

## 阶段三：执行操作

### 3.1 数据处理操作（自动执行）

| 操作 | 说明 | Plan Op |
|------|------|---------|
| 数据清洗 | 去除空值、重复、异常值 | set_data_validation + 条件格式 |
| 数据转换 | 行列转置（transpose）。标准化类转换需另补原语 | transform_range |
| 数据聚合 | 按类汇总、求和、平均 | create_pivot_table |
| 数据计算 | 添加计算列、比率 | set_cell_formula |
| 排序筛选 | 多条件排序、高级筛选 | sort_range + filter_range |

### 3.2 可视化操作（自动生成）

| 操作 | 说明 | Plan Op |
|------|------|---------|
| 生成图表 | 根据数据特征选择图表类型（优先用 sheet_name + source_range 指定范围；否则先 set_selection） | insert_chart_from_selection |
| 设置图表样式 | 标题、图例、颜色 | insert_chart_from_selection（title/has_legend/legend_position） |
| 添加趋势线 | 线性/指数/多项式 | insert_chart_from_selection（add_trendline + trendline_type） |
| 数据标签 | 显示数值/百分比 | insert_chart_from_selection（show_data_labels + data_labels_show_percent） |

### 3.3 结果呈现

| 操作 | 说明 |
|------|------|
| 格式化输出 | 数字格式、颜色标注、条件格式 |
| 摘要报告 | 生成分析结论文字 |
| 建议下一步 | 推荐进一步分析方向 |

---

## 阶段四：Skill 设计

### 4.1 et-analyzer Skill

**目标**：智能分析 Excel 数据

**输入**：
- 当前选区/工作表的数据
- 用户的自然语言需求

**输出**：
- 数据分析结果
- 可执行 Plan（数据处理 + 图表生成）
- 分析结论和建议

**能力清单**：
```json
{
  "analyze_data": "分析数据结构与特征",
  "suggest_analysis": "推荐合适的分析方法",
  "generate_insight": "生成数据洞察",
  "create_visualization": "创建可视化图表",
  "create_pivot": "创建数据透视表",
  "summarize": "生成分析摘要"
}
```

### 4.2 et-visualizer Skill

**目标**：智能生成图表

**输入**：
- 数据范围
- 图表需求描述

**输出**：
- 推荐图表类型
- 可执行 Plan（创建图表 + 设置样式）

落地现状（2026-02-20）：
- ✅ 已补齐 `et-visualizer` skill（只输出可执行 Plan JSON，且收敛到当前已实现的 ET op 子集；见 `installer/assets/user-docs/skills/et-visualizer/*`）。

---

## 阶段五：典型场景

### 场景1：销售趋势分析
```
用户："帮我分析一下销售数据的趋势"

AI 理解：
- 检测到日期列和数值列
- 推荐：时间序列折线图 + 趋势线

Plan 生成：
1. sort_range（按日期排序）
2. create_pivot_table（按月汇总）
3. set_selection（选中透视结果范围）
4. insert_chart_from_selection（折线图 + 标题 + 趋势线）
```

### 场景2：业绩对比
```
用户："对比各部门上半年的业绩"

AI 理解：
- 检测到部门列和业绩列
- 推荐：部门汇总 + 柱状图对比

Plan 生成：
1. create_pivot_table（按部门汇总）
2. set_selection（选中透视结果范围）
3. insert_chart_from_selection（柱状图 + 图例）
4. set_number_format（格式化数字）
```

### 场景3：占比分析
```
用户："各产品类别销售占比是多少"

AI 理解：
- 需要计算各类别占比
- 推荐：饼图 + 百分比数据标签

Plan 生成：
1. create_pivot_table（按产品类别汇总）
2. 添加占比计算列
3. set_selection（选中透视结果范围）
4. insert_chart_from_selection（饼图 + 数据标签（百分比））
```

---

## 实现顺序

1. **et-analyzer Skill** - 数据理解 + 分析推荐
2. **数据处理增强** - transform_range 等
3. **图表高级操作** - 趋势线、数据标签、组合图
4. **et-visualizer Skill** - 独立图表生成 Skill
5. **对话集成** - 在 Plan 中集成分析结论

---

## 技术要点

1. **数据感知**：通过 WPS JSAPI 读取选区数据，AI 分析特征
2. **智能推荐**：基于数据特征和用户意图，推荐最佳分析方案
3. **自动执行**：生成完整 Plan，一次性执行数据处理 + 可视化
4. **结果解读**：分析完成后，生成文字结论供用户参考

---

## 示例 Plan 输出

```json
{
  "schema_version": "ah32.plan.v1",
  "host_app": "et",
  "meta": {
    "analysis_type": "trend",
    "insight": "销售额呈上升趋势，月均增长约15%"
  },
  "actions": [
    {
      "id": "sort_date",
      "title": "按日期排序",
      "op": "sort_range",
      "range": "A1:D100",
      "key": "A",
      "order": "asc"
    },
    {
      "id": "monthly_summary",
      "title": "按月汇总销售",
      "op": "create_pivot_table",
      "source_range": "A1:D100",
      "destination": "F1",
      "rows": ["月份"],
      "values": [{"field": "销售额", "summary": "sum"}]
    },
    {
      "id": "trend_chart",
      "title": "创建趋势图（从选区插图）",
      "op": "insert_chart_from_selection",
      "chart_type": 4,
      "title": "月度销售趋势",
      "add_trendline": true,
      "show_data_labels": false
    }
  ]
}
```

---

## 阶段五：高级智能能力（思维链/思维树/规划/迭代）

### 5.1 思维链（Chain of Thought）

让 AI 在生成 Plan 前展示推理过程：

```json
{
  "meta": {
    "reasoning": [
      "1. 数据扫描：检测到A列日期，B列销售额，共100行",
      "2. 类型识别：日期列B2-B100，数值列C2-C100，无空值",
      "3. 场景判断：用户要分析趋势，适用时间序列分析",
      "4. 方案规划：先排序 → 透视表汇总 → 折线图 → 趋势线",
      "5. 预期效果：展示月度销售变化趋势，添加趋势线预测"
    ]
  }
}
```

**实现方式**：
- 在 SYSTEM.md 中要求 AI 输出 reasoning 字段
- 前端展示推理过程供用户确认
- 用户可干预修改 Plan

### 5.2 思维树（Tree of Thought）

探索多种分析方案，选择最优：

```json
{
  "meta": {
    "alternatives": [
      {
        "方案A": "趋势分析：折线图+趋势线，展示变化趋势",
        "方案B": "对比分析：柱状图对比各月销售额",
        "方案C": "占比分析：饼图展示各月占比（不推荐，数据量多时效果差）"
      },
      "推荐方案A，趋势分析最能体现销售变化"
    ]
  }
}
```

**实现方式**：
- 要求 AI 生成 2-3 个备选分析方案
- 每个方案包含：图表类型、适用场景、预期洞察
- 用户选择后执行

### 5.3 规划能力（Planning）

复杂分析任务自动分解为多步骤：

```
用户："分析销售数据，给出全年总结报告"

分解为：
├── 阶段1：数据准备
│   ├── 清洗数据（去除空值、重复）
│   ├── 排序（按日期）
│   └── 数据校验
├── 阶段2：数据分析
│   ├── 月度汇总
│   ├── 同比分析
│   └── 环比分析
├── 阶段3：可视化
│   ├── 趋势图
│   ├── 对比图
│   └── 占比图
└── 阶段4：报告生成
    ├── 生成摘要文字
    └── 建议下一步分析
```

**实现方式**：
- Plan 支持嵌套阶段（phase/step）
- Executor 按阶段执行，支持暂停确认

### 5.4 持续迭代（Iterative Execution）

执行→检查→调整→继续：

```
执行循环：
├── Step 1: 排序数据 → 检查：排序成功 ✓
├── Step 2: 创建透视表 → 检查：汇总正确 ✓
├── Step 3: 创建折线图 → 检查：图表位置偏左 → 调整位置 → ✓
├── Step 4: 添加趋势线 → 检查：趋势线类型 → 改为指数 → ✓
└── 完成：生成摘要"销售呈上升趋势"
```

**实现方式**：
- Executor 返回每步执行结果和快照
- AI 检查结果是否达到预期
- 偏差 > 阈值时自动调整后续操作
- 支持用户干预："图表颜色不好看" → 重新生成

---

## 实现顺序

### 阶段规划

| 阶段 | 内容 | 优先级 |
|------|------|--------|
| 阶段一 | 数据理解层 | 已完成 |
| 阶段二 | 智能分析推荐 | P1 |
| 阶段三 | 执行操作 | P1 |
| 阶段四 | Skill 设计 | P1 |
| 阶段五 | 思维链/思维树/规划/迭代 | P2/P3 |

### 阶段五细分

| 阶段 | 内容 | 优先级 |
|------|------|--------|
| 5.1 | 思维链（reasoning 字段） | P2 |
| 5.2 | 思维树（alternatives 字段） | P2 |
| 5.3 | 规划能力（phase/step 嵌套） | P3 |
| 5.4 | 持续迭代（执行-检查-调整） | P3 |
