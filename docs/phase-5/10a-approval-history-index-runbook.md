# Phase 5 旧审批历史索引运行手册

迁移标识为 `phase-5-approval-history-indexes-v1`，只为新集合 `approval_legacy_histories` 追加索引，不修改 Phase 2 已执行清单或在线审批实例。该集合只保存终结历史的最小检索字段与 WORM 迁移证据引用，不保存标题、表单、意见或动作正文。

```bash
pnpm --filter @gaoq/erp-api build
pnpm --filter @gaoq/erp-api migrate:phase5:approval-history-indexes -- --dry-run
pnpm --filter @gaoq/erp-api migrate:phase5:approval-history-indexes
pnpm --filter @gaoq/erp-api migrate:phase5:approval-history-indexes -- --dry-run
```

apply 前确认 MongoDB Replica Set、备份、容量、复制延迟告警和执行窗口。必须核验：`tenantId + id` 唯一；`tenantId + migrationEvidenceRef` 唯一，保证一份来源证据不能生成两条历史；`tenantId + templateCode + completedAt` 支撑受控历史检索。第二次 dry-run 必须无新增动作。

唯一冲突表示既有不可变事实或证据复用，禁止删除记录后重跑。复制延迟、锁等待或 API SLO 越线时立即停止；索引回退属于独立危险变更，必须另行授权。
