# Phase 5 业务附件迁移索引运行手册

迁移标识为 `phase-5-business-attachment-migration-indexes-v1`，只为新集合 `business_attachments` 建立租户前缀索引，不修改迁移账本、已有业务集合或 WORM 对象。manifest v1 执行后永久固定，后续变更必须追加新版本。

```bash
pnpm --filter @gaoq/erp-api build
pnpm --filter @gaoq/erp-api migrate:phase5:business-attachment-migration-indexes -- --dry-run
pnpm --filter @gaoq/erp-api migrate:phase5:business-attachment-migration-indexes
pnpm --filter @gaoq/erp-api migrate:phase5:business-attachment-migration-indexes -- --dry-run
```

apply 前必须完成备份、MongoDB Replica Set 健康检查、复制延迟告警与变更窗口批准。预检 `tenantId + id` 和 `tenantId + migrationEvidenceRef` 零重复；归属查询使用 `tenantId + ownerType + ownerId + businessCreatedAt`，激活恢复使用 `tenantId + status + updatedAt`。第二次 dry-run 必须无新增动作；冲突、复制延迟或 SLO 越线时立即停止，禁止删除或改写附件/WORM 记录伪造通过。

代码发布前执行：

```bash
pnpm quality:data-migration-entry-coverage
```

门禁固定覆盖业务附件服务的 37 项严格输入、最小投影、可信租户与迁移引用反向
绑定、checksum、状态/版本/对象证据组合、事务 CAS 和 Outbox 测试；整个数据迁移
入口与附件链路共 169 项测试、九个生产文件，合计覆盖率不得低于当前
99.54%/98.24%/100%/99.50%（语句/分支/函数/行），且任一目标文件四维低于
90% 即失败。

现场 apply 前还必须只读核对：`migration_pending` 仅为 v1 且无对象证据和
`availableAt`；`available` 仅为 v2 且同时存在对象证据和 `availableAt`；内容
checksum 与迁移引用 checksum 一致；租户、归属类型/用途和迁移引用不存在错绑。
任一无效组合都必须停止迁移并保留原始记录及审计证据，不得通过手工改状态、
补对象定位符或伪造 WORM 回执绕过。
