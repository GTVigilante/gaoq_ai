# Phase 5 业务附件迁移索引运行手册

迁移标识为 `phase-5-business-attachment-migration-indexes-v1`，只为新集合 `business_attachments` 建立租户前缀索引，不修改迁移账本、已有业务集合或 WORM 对象。manifest v1 执行后永久固定，后续变更必须追加新版本。

```bash
pnpm --filter @gaoq/erp-api build
pnpm --filter @gaoq/erp-api migrate:phase5:business-attachment-migration-indexes -- --dry-run
pnpm --filter @gaoq/erp-api migrate:phase5:business-attachment-migration-indexes
pnpm --filter @gaoq/erp-api migrate:phase5:business-attachment-migration-indexes -- --dry-run
```

apply 前必须完成备份、MongoDB Replica Set 健康检查、复制延迟告警与变更窗口批准。预检 `tenantId + id` 和 `tenantId + migrationEvidenceRef` 零重复；归属查询使用 `tenantId + ownerType + ownerId + businessCreatedAt`，激活恢复使用 `tenantId + status + updatedAt`。第二次 dry-run 必须无新增动作；冲突、复制延迟或 SLO 越线时立即停止，禁止删除或改写附件/WORM 记录伪造通过。
