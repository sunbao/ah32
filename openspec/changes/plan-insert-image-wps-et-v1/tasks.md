# Tasks: plan-insert-image-wps-et-v1

## 1) Plan schema + normalize

- [x] 1.1 在 `ah32.plan.v1` 增加 `insert_image` action（Writer/ET 可用；WPP 保持现有 `add_image`）
- [x] 1.2 Plan normalize：把常见的“字段写错/类型不对”纠正为可执行形态

## 2) 前端执行（Writer/ET）

- [x] 2.1 Writer：执行 `insert_image`（支持 `asset://` 下载后插入）
- [x] 2.2 ET：执行 `insert_image`（先实现一个最小可用的位置策略）
- [x] 2.3 失败降级：插图失败时给出可见占位 + 提示原因（不要整次写回直接崩）

## 3) 资产清理与观测

- [x] 3.1 插入成功后 best-effort 删除 asset（避免临时资产堆积）
- [x] 3.2 埋点：记录插图走了哪个分支（asset/data_url/url/local_path）以及是否降级

## 4) 联动收口

- [x] 4.1 `multimodal-writeback-assets-v1` 的 tasks（2.2/2.3/3.1）按实际补齐并准备归档
- [x] 4.2 把验收场景补进 `macrobench-acceptance-v1`（生成图片并写回到 Writer/ET）
