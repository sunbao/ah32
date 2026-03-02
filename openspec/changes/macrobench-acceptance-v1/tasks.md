# Tasks: macrobench-acceptance-v1

## 1) 建立统一验收口径（先把“怎么验收”写清楚）

- [x] 1.1 补齐 design（收口规则、删 TODOLIST 条件、证据口径）
- [x] 1.2 补齐 specs：`office-manual-acceptance` + `macrobench-regression`
- [x] 1.3 在 specs 里补“证据模板”（成功/失败各需要哪些信息）

## 2) 把 TODOLIST 收口进 OpenSpec（逐条对账）

> 目标：把 `TODOLIST*.md` 里“必须每轮跑/必须保证”的部分，全部迁移进 OpenSpec 的验收矩阵里。

- [x] 2.1 迁移 `TODOLIST.md` 的“每轮必跑”两条到验收矩阵：
  - 同时打开 2 Writer + 1 ET + 1 WPP 并发不串台
  - Writer/ET/WPP 真环境各至少跑 1 次（每轮迭代都要跑）
- [x] 2.2 梳理 `TODOLIST_WRITER.md` 的“已落地能力”与“愿景项”，把“可验收的条目”补进矩阵
- [x] 2.3 梳理 `TODOLIST_ET.md` 同上
- [x] 2.4 梳理 `TODOLIST_PPT.md` 同上
- [x] 2.5 形成一份映射表（TODOLIST 条目 → 对应 spec/场景），写到 `review.md`
  - 备注：映射表已补齐到“核心条目 + 明确的未迁入/需 follow-up 条目”（例如 Plan 回退/版本块、愿景规划的承接方式）
- [x] 2.6 梳理 `TODOLIST.md` 的 P0 主线细项（并发/切文档/写回队列/取消/状态恢复），把“可验收的条目”补进矩阵并写入映射表
- [x] 2.7 梳理 `TODOLIST.md` 的 MacroBench/观测/技能可见性条目，把“可验收的条目”补进回归规范并写入映射表
- [x] 2.8 梳理 `TODOLIST.md` 的 StyleSpec 条目，把“可验收的条目”补进回归规范并写入映射表
- [x] 2.9 梳理 `TODOLIST.md` 的动态 skills 条目，把“可验收的条目”补进回归规范并写入映射表
- [x] 2.10 梳理 `TODOLIST.md` 的 RAG 可观测条目，把“可验收的条目”补进回归规范并写入映射表

## 3) 把现有 changes 的手工验收项合并进矩阵（避免分散）

- [x] 3.1 把 `remote-backend-gapfix-v1` 的手工验收 4.x 收进 `office-manual-acceptance`
- [x] 3.2 把 `tenant-scope-storage-and-ssrf-guard-v1` 的手工验收 4.x 收进 `office-manual-acceptance`
- [x] 3.3 其他 change 若有“手工验收项”，也统一迁入（发现就补）
  - 已补：`bailian-multimodal-provider-v1`（多模态生成图片避免大 payload）与 `doc-snapshot-v1-and-llm-provider-v1`（10 轮不重载包含 snapshot 路径）

## 4) 收口完成后的收尾动作

- [ ] 4.1 你确认“验收矩阵覆盖够了”（至少覆盖每轮必跑项）
- [x] 4.2 单独提交删除根目录 `TODOLIST*.md`
- [x] 4.3 在 `review.md` 记录：删除原因、映射关系、遗留问题与后续 follow-up change 列表
