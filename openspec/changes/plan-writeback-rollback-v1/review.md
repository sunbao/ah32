# Review: plan-writeback-rollback-v1

## 结论
- 是否按 v1 范围实施：是（Writer 块级写回回退 + Answer Mode 回退）
- 验收是否通过：待跑 `macrobench-acceptance-v1` 的“Writer 写回回退”场景

## 关键决定（v1）
- 备份存储：本机 `localStorage`，key=`__ah32:block_backup:<doc_id>:<block_id>`，`doc_id` 优先用 `doc.FullName`，否则用 `doc.Name`
- 备份时机：`PlanExecutor` 执行 `upsert_block`/`delete_block` 前保存旧内容（best-effort）
- 回退入口：UI 的“回退上一版”按钮（仅在检测到备份时显示）
- 回退动作：enqueue `Plan.rollback_block(block_id)`；执行时优先调用 `BID.rollbackBlock`（覆盖 Answer Mode 备份），无 BID 时用 `localStorage.text` 兜底恢复
- 清理策略：不做自动清理（后续可由运维/策略脚本定期清理体验数据）

