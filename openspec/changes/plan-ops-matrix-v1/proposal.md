# Proposal: plan-ops-matrix-v1

## 为什么要做（人话）

现在系统的“写回/执行”是 **Plan JSON**（`ah32.plan.v1`）驱动的。大家在研发阶段最容易踩的坑，不是“模型不会写答案”，而是：

- **不知道有哪些 OP**（模型能不能生成？前端能不能执行？后端会不会校验拦截？）
- **同一个 OP 在不同宿主含义不一样**（`wps`/`et`/`wpp`）
- **做不到的边界没说清楚**（于是看起来“写了 Plan”但执行失败或写到错误位置）

所以需要一份“OP 计划表/能力矩阵”，把 **能做什么 / 做不到什么 / 关键字段 / 主要限制** 讲清楚，作为：

1) Prompt/Schema/Executor 的对齐基线（避免再出现 `insert_table not allowed for et` 这类系统性问题）
2) 宏基准/验收用例的解释依据（失败到底算业务错还是平台错）
3) 后续要不要升级 schema（新增 OP）的决策输入

## 范围（v1）

- 只整理当前仓库内 **已支持的 `ah32.plan.v1` OP**（以及少量“内部 OP”）。
- 不引入新 schema_version；不改行为（本 change 只做文档/口径）。
- “模型掌握的 OP”：以后端提示词 `src/ah32/services/plan_prompts.py` 列出的 allowed ops 为准；同时标出 schema/执行器存在但默认不引导模型生成的 OP。

## OP 计划表（矩阵）

说明：

- **硬失败**：字段缺失/对象模型不支持会直接抛错，Plan 终止。
- **Best-effort**：会尝试多条路径/分支；可能降级，但会尽量完成并留下日志/埋点。
- “主要实现”是为了方便你去定位，不是让你记代码。

### 0) 通用块语义（跨宿主最重要的口径）

| OP | 支持宿主 | 能做什么（核心语义） | 做不到/限制（v1） |
|---|---|---|---|
| `upsert_block` | `wps`/`et`/`wpp` | **生成一个可重复执行的“产物区域”**：重复运行会覆盖同一块（尽量幂等）。 | 不是“精确 diff 合并”；是“覆盖式写回”。Writer 里 marker/书签找不到会降级导致幂等变弱；ET/WPP 会清空整个产物容器（sheet/slide）。 |
| `delete_block` | `wps`/`et`/`wpp` | 删除/清空某个 `block_id` 的产物区域。 | ET 目前按 `BID_<block_id>` 推导 sheet 名删除，若你用 `upsert_block.sheet_name` 自定义了名字，`delete_block` 不一定删得到（需要后续补齐）。 |
| `rollback_block`（内部） | `wps` | 回退某个 `block_id` 的“上一版”（备份在本地）。 | 仅 Writer；依赖本地备份存在；不是多版本管理；模型默认不生成（prompt 未列出）。 |

### 1) `host_app="wps"`（Writer）OP 列表

| OP | 能做什么 | 关键字段（常用） | 做不到/限制（v1） |
|---|---|---|---|
| `set_selection` | 移动光标/选区（按锚点+偏移）。 | `anchor`(`cursor/start_of_document/end_of_document`), `offset_lines`, `offset_chars` | 不能“按标题/页码/书签名”精准定位；对复杂文档定位稳定性有限。 |
| `insert_text` | 在当前选区插入文本（可前后换行）。 | `text`, `new_paragraph_before/after` | 只能插纯文本；不负责样式（需再用样式类 OP）；如果选区非插入点，可能覆盖选中内容。 |
| `insert_after_text` | 找到 `anchor_text`（首次匹配）后插入文本。 | `anchor_text`, `text` | 多处重复文本时不可控（默认命中第一处）；匹配失败会硬失败。 |
| `insert_before_text` | 同上，但插入到锚点前。 | `anchor_text`, `text` | 同上。 |
| `insert_table` | 在光标处插入表格并可填充单元格。 | `rows`, `cols`, `data?`, `borders?`, `style?`, `header?`, `auto_fit?` | 不支持合并单元格/复杂表头；样式能力有限且 best-effort。 |
| `insert_chart_from_selection` | 插入一个图表对象，并可设置标题/图例（部分能力 best-effort）。 | `chart_type?`, `width?`, `height?`, `title?` | **不会把当前选区当作数据源绑定**（基本是“插个空图表”）；更适合 WPS/Writer 的“占位图”。 |
| `insert_word_art` | 插入艺术字。 | `text`, `preset?`, `font?`, `size?` | 位置/版式控制有限；不保证锚定到某段落。 |
| `insert_image` | 插入图片（支持 `asset://<id>`、URL、本地路径，必要时降级为占位文本）。 | `path`, `width?`, `height?` | 大图/网络失败会降级；不做 base64 直塞（prompt 禁止）。 |
| `set_text_style` | 对当前选区设置字体样式。 | `font?`, `size?`, `bold?`, `italic?`, `color?` | 只能对“选区”生效；对复杂对象（表格/形状）兼容性不一。 |
| `set_paragraph_format` | 段落格式（对齐/行距/段前后等）。 | `alignment?`, `line_spacing?`, `space_before?`, `space_after?`, `block_id?` | 必须至少给一个字段；不等同于“套用完整 Word 样式”。 |
| `apply_paragraph_style` | 批量套样式（在选区/块内最多 N 段）。 | `apply_to_selection?`, `max_paragraphs?`, 样式字段 | 对长文档可能慢；best-effort；不保证完全不改坏排版。 |
| `normalize_headings` | 尝试把标题层级规范化（best-effort）。 | `apply_to_selection?`, `max_paragraphs?`, `levels?` | 依赖启发式；不可逆且容易“改多/改少”。 |
| `apply_text_style_to_matches` | 查找文本并批量改样式（可限制范围和命中数）。 | `find_text`, `max_matches?`, `case_sensitive?`, `whole_word?`, `block_id?` | 不是正则；对跨段/跨表结构匹配有限。 |
| `set_writer_table_style` | 批量设置表格样式/边框/表头（可按 `block_id` 限定）。 | `style_name?`, `borders?`, `header?`, `max_tables?`, `block_id?` | best-effort；不同 WPS 版本对象模型差异大。 |
| `answer_mode_apply` | 触发“答题模式”写回（由前端 BID runtime 执行）。 | `answers[]`, `block_id?`, `search_window_chars?`, `backup?`, `strict?` | **强依赖** 前端加载了 `BID.answerModeApply`；否则硬失败；这不是纯 Plan 能力。 |

### 2) `host_app="et"`（表格）OP 列表

| OP | 能做什么 | 关键字段（常用） | 做不到/限制（v1） |
|---|---|---|---|
| `set_selection` | 选中某个 sheet + 单元格/区域；找不到 sheet 会自动创建（平台兜底）。 | `sheet_name?`, `cell?`/`range?`, `anchor?` | 不支持“命名区域”等高级定位（除非本身是 A1 地址）；对受保护工作簿可能失败。 |
| `insert_text` | 写一个单元格/区域的值（字符串）。 | `text` | 不是富文本；不自动拆分成多行多列；不负责格式（需再用格式类 OP）。 |
| `insert_table` | 在当前选区起点写一个矩形区域的值（`Value2` 优先，失败则逐格写），并做少量格式（表头加粗/边框/自适应列宽/Style）。 | `rows`, `cols`, `data?`, `header?`, `borders?`, `auto_fit?`, `style?` | 不是 Excel “结构化表（ListObject）”；不会自动创建筛选按钮/总计行等；格式能力有限。 |
| `insert_chart_from_selection` | 根据选区或 `source_range` 建图（折线/柱状等取决于 `chart_type`），可设置标题/图例。 | `chart_type?`, `source_range?`, `sheet_name?`, `width?`, `height?`, `title?` | 图表类型/常量在不同版本可能不一致；复杂样式（配色/轴格式）不在 v1 覆盖范围。 |
| `insert_image` | 在 sheet 上插入图片（支持 `asset://`/URL/本地路径；失败会写占位文本到单元格）。 | `path`, `width?`, `height?`, `sheet_name?`, `cell?`/`range?` | 图片插入依赖对象模型（`Shapes.AddPicture`）；网络/权限失败会降级。 |
| `set_cell_formula` | 给某个单元格设置公式（尽量写 `Cell.Formula`，不行就写 Value）。 | `cell`, `formula` | 只面向单元格，不面向整块范围；不负责计算链/刷新；公式兼容性取决于宿主。 |
| `set_number_format` | 设置区域数字格式。 | `range`, `number_format` | 依赖 `NumberFormat/NumberFormatLocal`；格式字符串兼容性可能因区域设置不同而差异。 |
| `set_conditional_format` | 设置条件格式（best-effort）。 | `range`, 规则字段 | 条件格式类型覆盖不全；复杂公式/多条件组合不保证。 |
| `set_data_validation` | 设置数据验证（下拉/范围/公式等，best-effort）。 | `range`, `validation_type`, `formula1` | 不保证所有验证类型都能在所有版本成功；失败会抛错。 |
| `sort_range` | 对区域排序。 | `range`, `key`, `order?`, `has_header?` | 多关键字排序、复杂自定义序列不在 v1 范围。 |
| `filter_range` | 对区域做自动筛选（best-effort）。 | `range`, `field`, `criteria1`, `operator?` | 高级筛选/多条件组合支持有限。 |
| `transform_range` | 转置（transpose）范围到目标位置（优先复制粘贴转置，不行则小范围手动转置）。 | `source_range`, `destination`, `clear_existing?` | 目前只支持 transpose；大范围 fallback 有上限。 |
| `create_pivot_table` | 从源区域创建数据透视表（可指定行/列/值/筛选字段）。 | `source_range`, `destination`, `rows[]`, `values[]`, `columns[]?`, `filters[]?` | 数据透视表 API 差异大；某些宿主会失败；复杂布局/样式不覆盖。 |
| `upsert_block` | 以 `block_id` 为名创建/复用一张产物 sheet（默认 `BID_<suffix>`），清空后执行子 actions（相当于“写到一张专用 sheet 里”）。 | `block_id`, `actions[]`, `sheet_name?` | 会清空整张产物 sheet；不是“局部覆盖”；`delete_block` 当前只按 `BID_<suffix>` 删除（自定义 sheet_name 需后续补齐）。 |
| `delete_block` | 删除 `BID_<suffix>` 产物 sheet。 | `block_id` | 不删除自定义 `sheet_name`（见上）。 |

### 3) `host_app="wpp"`（演示）OP 列表

| OP | 能做什么 | 关键字段（常用） | 做不到/限制（v1） |
|---|---|---|---|
| `insert_text` | 在当前页插入一个默认文本框。 | `text` | 不保证落在占位符里；精确布局需要用 `add_textbox`。 |
| `insert_word_art` | 插入艺术字。 | `text`, `preset?`, `font?`, `size?` | 位置/版式 best-effort。 |
| `set_slide_background` | 设置当前页/全局背景（按 `apply_to_all`）。 | `fill_color?`, `apply_to_all?` | 复杂背景（图片/渐变）不覆盖。 |
| `set_slide_text_style` | 设置当前页/全局文本样式（best-effort）。 | `font?`, `size?`, `color?`, `apply_to_all?` | 只覆盖部分文本对象；不保证每个占位符都改到。 |
| `set_slide_theme` | 切主题（best-effort）。 | 主题字段 | 主题名/常量依赖宿主。 |
| `set_slide_layout` | 切版式（best-effort）。 | `layout?`, `apply_to_all?` | 版式常量依赖宿主；切换可能影响已有内容布局。 |
| `set_shape_style` | 改形状样式（best-effort）。 | `fill_color?`, `line_color?`, `text_color?`, `apply_to_all?` | 需要能定位到 shape（通常靠 selection 或遍历）；复杂样式不覆盖。 |
| `set_table_style` | 改表格样式（best-effort）。 | `style_name?`, `banded_rows?`, `apply_to_all?` | 依赖对象模型；不保证所有版本可用。 |
| `add_slide` | 新增幻灯片（可指定位置/版式）。 | `position?`, `layout?` | 布局/版式常量不统一。 |
| `add_textbox` | 新增文本框（支持坐标/占位符优先）。 | `text`, `left/top/width/height?`, `placeholder_kind?` | 坐标单位/渲染有差异；占位符不存在会 fallback。 |
| `add_image` | 新增图片（支持 `asset://`/URL/本地路径）。 | `path`, `left/top/width/height?` | 网络/权限失败会失败或降级。 |
| `add_chart` | 新增图表（best-effort）。 | `chart_type?`, `data?` | 图表数据结构/常量差异大，复杂图表不覆盖。 |
| `add_table` | 新增表格并填充数据。 | `rows`, `cols`, `data?` | 合并单元格/复杂样式不覆盖。 |
| `add_shape` | 新增形状（矩形/箭头等）。 | `shape_type?`, 坐标字段 | 形状类型常量不统一。 |
| `delete_slide` | 删除某页。 | `slide_index?` | 索引变化需要谨慎；不存在会失败/忽略。 |
| `duplicate_slide` | 复制某页。 | `slide_index?` | 同上。 |
| `reorder_slides` | 调整顺序。 | `from_index`, `to_index` | 依赖宿主对象模型。 |
| `set_slide_transition` | 设置切换效果（best-effort）。 | 过渡字段 | 常量差异大。 |
| `add_animation` | 添加动画（best-effort）。 | 动画字段 | 常量差异大。 |
| `set_animation_timing` | 调整动画时序（best-effort）。 | timing 字段 | 依赖宿主。 |
| `add_hyperlink` | 给文本/形状加链接（best-effort）。 | `url`, 目标字段 | 定位对象能力有限。 |
| `set_presentation_props` | 设置演示文稿属性（best-effort）。 | props 字段 | 覆盖面有限。 |
| `upsert_block` | 用 `block_id` 绑定一张“产物页”（slide tag），重复执行会清空并重建该页内容。 | `block_id`, `actions[]` | 幂等是“按页覆盖”；不是合并；复杂跨页产物需要多个 block。 |
| `delete_block` | 删除 `block_id` 对应的产物页。 | `block_id` | 只对按 tag 标记的页生效。 |

## 重点缺口（v1 明确“做不到”，避免误会）

1) 没有“显式 create/ensure_sheet”的 OP（目前由平台兜底：引用 sheet 名时缺失则创建）。
2) 没有“精确定位写回”（例如 Writer 按段落 ID/页码；ET 按命名区域；WPP 按占位符路径）。
3) 没有“复杂格式能力”全覆盖（合并单元格、复杂图表样式、全文样式模板、修订等）。
4) `answer_mode_apply` 不是纯 Plan：它是“Plan 调用前端 BID runtime”，所以它的稳定性受前端加载/版本影响。

