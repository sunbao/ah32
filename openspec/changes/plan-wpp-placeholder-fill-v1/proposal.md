# Proposal: plan-wpp-placeholder-fill-v1

## 为什么要做（人话）

做 PPT 最常见的稳定写法，是“填占位符”（标题/正文/副标题）。如果靠坐标猜：

- 容易越界/重叠（尤其是不同模板、不同分辨率）
- 很难做到“可重复执行不越写越乱”

当前系统里 `add_textbox` 已经 **best-effort** 支持 `placeholder_kind` / `placeholder_index`，但存在两个问题：

1) **语义不显式**：看 Plan 不知道“这是在填占位符”还是“在随便加文本框”
2) **失败策略不清晰**：占位符找不到时是否应该 fallback 到坐标插入？不同场景期望不同

因此需要把“填占位符”做成一个 **显式 OP**，让模型更稳定地产生可执行计划，并让宏基准能覆盖这类回归。

## 目标（v1）

1) 新增 WPP-only OP：`fill_placeholder`
2) 支持按 `placeholder_kind`（title/body/subtitle）+ `placeholder_index`（1-based）填充文本
3) 明确失败策略：strict vs best-effort fallback（必须可配置）
4) 可观测：成功/失败要记录（placeholder 不存在、TextFrame 不可写等）

## 不做什么（v1 先别做）

- 不做复杂模板适配（SmartArt、复杂母版、多级占位符路径）
- 不做“自动改版式/自动找最合适占位符”的强智能（容易误判）

## 设计方向（v1）

### OP：`fill_placeholder`（WPP-only）

语义：在当前 slide（或指定 slide）上，找到指定占位符并把其文本替换为 `text`。

建议字段：

- `text`（必填）
- `placeholder_kind`（可选）：`title|body|subtitle`
- `placeholder_index`（可选，默认 `1`）
- `slide_index`（可选，默认当前页）
- `strict`（可选，默认 `true` 或 `false` 需你确认）：找不到占位符时是否直接失败
- `fallback_to_add_textbox`（可选，默认 `false`）：当 strict=false 时，是否允许 fallback 新增文本框

## 与现有能力的关系

- `add_textbox`：仍然保留，适合“确实需要新增一个自由布局文本框”的场景。
- `fill_placeholder`：适合“标题/正文”这种模板化填充，应该成为默认优先。

## MacroBench 对应（必须对齐）

1) ChatBench
   - 文件：`ah32-ui-next/src/dev/macro-bench-chat-suites.ts`
   - 新增 story：`bidding-helper:wpp:placeholder_fill_v1`
   - Turn：要求“标题占位符写 XXX，正文占位符写 3 条要点”，并明确优先用 `fill_placeholder`
   - Asserts：`wpp_slide_text_contains`（标题与正文要点）+ `wpp_last_slide_no_overlap` + `within_bounds`

2) Bench 断言增强（建议）
   - 为了真正验证“用了占位符而不是新增 shape”，建议在 ChatBench 增加一个新断言：
     - `wpp_placeholder_text_equals(kind,index,text)` 或 `wpp_placeholder_filled(kind,index)`
   - 这样可以把“真的填了占位符”与“只是加了个文本框”区分开。

## 需要你确认的问题（开工前必须定）

1) `strict` 默认值选哪一个？（我倾向：默认 strict=true，避免偷偷 fallback 造成重叠）
2) 若 strict=false：是否允许 fallback_to_add_textbox？还是直接失败但提示用户换模板/版式？
3) `fill_placeholder` 是否允许指定 `slide_index`（推荐允许，便于多页生成）？

