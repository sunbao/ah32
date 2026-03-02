# 2026-02-27-remote-backend-gapfix-v1

这个 change 是对当前 `plan-writeback` 分支“远端后端 + 多租户 + plan-writeback”落地后的 **漏点补齐清单**（以现有系统为基础，不引入新的架构流派）。

聚焦三类 P0 漏点：

1) **Doc Snapshot 尚未满足“全量上传”**：已接入 doc snapshot，但目前仍以 `extracted_text-only` 兜底为主（无法全量/二进制、缺图片/定位），导致远端后端读原文不完整、稳定性/效果受影响。
2) **非 `/agentic/*` 路由缺少 tenancy/auth 绑定**：如 `/api/documents/*`、`/memory/*`，既不走 middleware，也存在落盘路径不 tenant-scope 的情况，存在串租/串用户风险。
3) **前端关键路径存在静默吞错/鉴权头不全**：例如 `asset://` 下载缺少 tenant/auth headers、skills catalog 拉取失败静默返回旧缓存，导致“看起来没问题但其实功能没走通”。
4) **存在“服务端 HOME 目录缓存文档正文 + 回传服务端路径”的风险端点**：这类实现违反隐私与多租户边界，应禁用或迁移到 doc snapshot（tenant-scope + turn 结束删除）。

Artifacts:
- `design.md`
- `proposal.md`
- `review.md`
- `tasks.md`
- `specs/tenancy-non-agentic/spec.md`
- `specs/frontend-auth-headers/spec.md`
