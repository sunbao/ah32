# Review: plan-insert-image-wps-et-v1

## 结论（先留空）

- 是否按 v1 范围实施：待定
- 验收是否通过：待定

## 关键决定（后续补）

- ET 插图的默认位置策略：优先用当前选区（或 action 给的 sheet_name/cell/range）作为锚点，取 Range.Left/Top 作为坐标；拿不到就放到左上角附近
- 插图失败的降级策略：不让整次写回报错中断；改为写入“图片未插入”的可见占位文字（包含原因与路径片段，便于反馈）
- 插图成功后的 asset 清理策略：当 `path=asset://<id>` 时，插入成功后前端 best-effort 调用 `DELETE /agentic/assets/{id}`
- 可观测：前端会发 telemetry（包含走了 asset/url/data_url/local_path 哪条分支、是否走了降级）
