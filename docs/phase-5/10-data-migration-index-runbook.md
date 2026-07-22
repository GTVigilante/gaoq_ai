# Phase 5 数据迁移控制面索引运行手册

迁移标识为 `phase-5-data-migration-indexes-v1`，只为 `data_migration_runs`、`data_migration_items`、`data_migration_mappings`、`data_migration_associations`、`data_migration_attachments` 追加租户前缀索引，不修改任何业务集合。

```bash
pnpm --filter @gaoq/erp-api build
pnpm --filter @gaoq/erp-api migrate:phase5:data-migration-indexes -- --dry-run
pnpm --filter @gaoq/erp-api migrate:phase5:data-migration-indexes
pnpm --filter @gaoq/erp-api migrate:phase5:data-migration-indexes -- --dry-run
```

apply 前确认 MongoDB Replica Set、备份、容量、复制延迟告警和执行窗口。必须核验：来源运行按 `tenantId + sourceSystem + sourceRunId` 唯一；条目按 `tenantId + runId + sequence` 唯一；来源映射按 `tenantId + sourceSystem + entityType + sourceRecordId` 唯一；关联证据按租户、运行、序号、关系类型与来源关联 ID 唯一；附件证据按 `tenantId + runId + sourceAttachmentId` 唯一。第二次 dry-run 必须无新增动作。

唯一冲突、复制延迟、锁等待或 API SLO 越线时立即停止。账本是迁移证据，禁止删除或改写以伪造重跑；索引回退属于独立危险变更，必须保存定义和诊断证据后另行授权。
