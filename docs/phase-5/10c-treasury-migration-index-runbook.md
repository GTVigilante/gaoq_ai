# Phase 5 Treasury 迁移证据索引运行手册

迁移标识 `phase-5-treasury-migration-indexes-v1` 永久固定资金账户迁移证据索引。后续付款批次与银行回盘必须使用新的追加迁移标识，禁止修改已经执行的 v1 manifest 或 Phase 4 Treasury 索引清单。

```bash
pnpm --filter @gaoq/erp-api build
pnpm --filter @gaoq/erp-api migrate:phase5:treasury-migration-indexes -- --dry-run
pnpm --filter @gaoq/erp-api migrate:phase5:treasury-migration-indexes
pnpm --filter @gaoq/erp-api migrate:phase5:treasury-migration-indexes -- --dry-run
```

apply 前必须完成备份、MongoDB Replica Set 健康检查、复制延迟告警、变更窗口批准，以及 `treasury_bank_accounts` 中 `tenantId + migrationEvidenceRef` 重复预检。该唯一键仅约束字符串型迁移引用，普通在线账户的 `null` 不参与。

首次 apply 成功后，第二次 dry-run 必须无新增动作。唯一冲突、checksum 漂移、复制延迟、锁等待或 API SLO 越线时立即停止；不得删除、覆盖账户密文或更改 WORM 引用来伪造通过。
