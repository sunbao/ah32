# Tasks: plan-writeback-rollback-v1

## 1) 口径定下来（v1 交付范围）
- [x] 1.1 v1 范围：只做 Writer（WPS），块级写回回退 + Answer Mode 回退
- [x] 1.2 回退数据：写到本机 `localStorage`（key=`__ah32:block_backup:<doc_id>:<block_id>`），不做自动清理（后续可由运维/策略脚本定期清理）
- [x] 1.3 验收条款：补到 `macrobench-acceptance-v1`（能回退 + 失败可定位）

## 2) Writer 块级写回回退（v1 最小闭环）
- [x] 2.1 PlanExecutor：执行 `upsert_block`/`delete_block` 前自动保存旧内容（按 doc_id + block_id）
- [x] 2.2 UI：对写回产物提供“回退上一版”按钮（有备份才显示）
- [x] 2.3 回退动作：点击后恢复上一版，并给出成功/失败提示（失败原因可追踪）

## 3) Answer Mode 回退（补齐）
- [x] 3.1 确认 `answer_mode_apply.backup` 默认启用（可用 `backup:false` 显式关闭）
- [x] 3.2 Answer Mode 的回退复用同一套 UI（同一个备份 key + 同一个“回退上一版”入口）

## 4) 可观测与失败定位
- [x] 4.1 回退失败必须有原因（UI 可读提示 + 后端日志可查）
- [x] 4.2 埋点：写回/回退成功与失败事件（用于回归统计）

