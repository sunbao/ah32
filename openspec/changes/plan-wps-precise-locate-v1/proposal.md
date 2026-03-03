# Proposal: plan-wps-precise-locate-v1

## 为什么要做（人话）

Writer（WPS 文档）里很多写回失败/写错位置，本质不是“不会写内容”，而是“定位不够稳”：

- `set_selection` 只能 **按光标/文档起止 + 行/字符偏移**，对真实文档（段落变化、分页、表格、题号）非常脆弱。
- `insert_after_text` / `insert_before_text` 只能命中 **首次匹配**；当锚点文本重复时，无法指定“第 2 处/第 N 处”。
- 如果定位不稳，Plan 再合法也会“写到不该写的地方”，这比直接失败更糟。

因此需要把“更精确的定位”做成 **显式 OP**，让 LLM 有稳定、可控的定位手段，并让执行器记录分支与失败原因，便于排查。

## 目标（v1）

1) 新增 Writer-only（`host_app="wps"`）定位 OP（至少一个，且字段口径清晰）
2) 支持“重复锚点”的定位（能指定 occurrence）
3) 支持把定位 **限定在某个写回块（block）范围内**（可选，但建议）
4) 出问题时不吞错：失败要有可追踪日志/事件

## 不做什么（v1 先别做）

- 不做“按页码/段落 ID/修订记录”的结构化定位（复杂且宿主差异大）
- 不做通用的“文档结构解析 AST”（会引入更大性能与一致性风险）

## 设计方向（v1）

> v1 推荐先做“最小但可用”的两类定位：按文本锚点（可指定第 N 处）+ 按块边界（block_id）。

### OP A：`set_selection_by_text`（Writer-only）

语义：在当前文档（或可选的 block 范围）内，查找 `anchor_text` 的第 `occurrence` 处匹配，并把光标移动到该匹配的指定位置。

建议字段：

- `anchor_text`（必填）：要查找的文本
- `occurrence`（可选，默认 `1`）：第几处匹配（1-based）
- `position`（可选，默认 `after`）：`before|after|start|end`
- `offset_chars`（可选，默认 `0`）：在定位点基础上再偏移
- `block_id`（可选）：若提供，则只在该 `block_id` 对应范围内查找（更安全）
- `strict`（可选，默认 `true`）：找不到匹配时是否直接失败；`false` 表示 best-effort（不抛错但会记录失败事件）

失败策略（v1）：找不到匹配就 **硬失败**（避免误写）。

### OP B：`set_selection_by_block`（Writer-only）

语义：把光标定位到某个 `block_id` 产物块的边界（块内开头/块内结尾），用于后续写入/追加。

建议字段：

- `block_id`（必填）
- `position`（可选，默认 `start`）：`start|end`（表示块内起点/块内终点）
- `offset_chars`（可选，默认 `0`）
- `strict`（可选，默认 `true`）：找不到 block 时是否直接失败；`false` 表示 best-effort（不抛错但会记录失败事件）

失败策略（v1）：找不到 block marker 就硬失败（并输出可追踪日志）。

## 与现有能力的关系

- `set_selection`：保留，适合“文档很空/偏移能控”的场景。
- `insert_after_text` / `insert_before_text`：保留，适合“锚点唯一且很短”的场景；当需要第 N 处时，优先用 `set_selection_by_text`。
- `upsert_block(wps)`：仍是默认推荐写回方式；`set_selection_by_block` 用于更稳地在 block 内定位。

## MacroBench 对应（必须对齐）

> 目的：不是让宏基准“装作没问题”，而是让宏基准能稳定暴露“定位不准”的回归。

1) ChatBench（推荐，能构造重复锚点场景）
   - 文件：`ah32-ui-next/src/dev/macro-bench-chat-suites.ts`
   - 新增 story：`answer-mode:wps:precise_locate_v1`
   - Setup：清空文档，写入两段包含相同锚点 `【插入点】` 的文本
   - Turn：要求在第 1 处锚点后插入 `OK1`，第 2 处锚点后插入 `OK2`
   - Asserts：必须同时包含 `【插入点】OK1` 与 `【插入点】OK2`，且不能把两段都写到同一处

2) 生成质量回归（可选，后端不依赖 WPS）
   - 文件：`scripts/macro_bench.py`
   - 新增 1 条 case：明确要求使用 `set_selection_by_text`（occurrence=2）来定位第二处锚点并写入

## 已确认（v1）

- v1 实现两条 OP：`set_selection_by_text` + `set_selection_by_block`
- 默认 `strict=true`（避免误写）；但支持 `strict=false` 走 best-effort（用于“尽量做、找不到也别崩”的对话）
- `block_id` 是可选安全限定：提供时只在 block 内查找；不提供则全文查找
