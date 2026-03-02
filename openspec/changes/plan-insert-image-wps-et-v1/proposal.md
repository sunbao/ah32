# Proposal: plan-insert-image-wps-et-v1

## 为什么要做（人话）

我们已经有后端的“图片资产仓库”（asset store）：模型生成图片不会把大段 base64 塞进对话里，而是返回 `asset_id`，前端再用 `asset://<id>` 下载并插入。

现在的问题是：**这个“插入图片”在三端不一致**：

- WPP（PPT）侧已经能把 `asset://<id>` 下载并插入（best-effort）
- Writer（WPS 文档）和 ET（表格）侧没有 Plan 的“插图操作”，所以“生成图片 → 写回到文档”闭环做不完整

这会直接卡住几个业务目标：生成插图、标书/汇报里自动配图等。

## 目标（v1）

1) Plan 写回增加“插图”能力：Writer + ET 至少能插入 1 张图
2) 支持 `asset://<id>`（后端生成图的主路径）
3) 插图失败不把整次写回搞崩：失败要有可见提示/降级结果

## 不做什么（v1 先别做）

- 不做复杂的图片素材管理中心（只做“插进去”）
- 不做跨会话的永久缓存（仍然以 asset TTL 为主）

## 设计方向（先定个大概）

### 1) Plan 增加新 op（建议）

- Writer：`insert_image`（在光标处插入图片）
- ET：`insert_image`（在指定 sheet/range/cell 附近插入图片；先做最简单的默认位置）

### 2) 支持的 path 形式（最少要有）

- `asset://<id>`（后端资产）
- `data:image/...`（数据 URL，作为兜底）
- `http(s)://...`（可选，best-effort 下载再插入）
- 本地路径（best-effort；不同宿主可用性不稳定）

## 与现有 changes 的关系

- `multimodal-writeback-assets-v1`：后端资产仓库已做，但 tasks 里“前端插入 asset:// 并清理”仍未能在三端闭环；本 change 是把缺口补上
- `macrobench-acceptance-v1`：验收矩阵里会覆盖“生成图片并写回”的场景（至少在一个宿主跑通）

## 需要你确认的问题（开工前必须定）

1) v1 是否只要求 Writer 能插图？ET 插图可不可以放到 v2？
2) 插图位置：Writer 默认光标处；ET 你希望默认插到哪里（当前选区旁边/固定单元格/新 sheet）？
3) 插图失败的降级：你希望是“插一段占位文字/插一个矩形占位/还是直接报错不中断”？

