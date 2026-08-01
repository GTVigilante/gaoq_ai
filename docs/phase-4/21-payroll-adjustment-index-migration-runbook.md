# Payroll Adjustment 索引迁移 Runbook

迁移标识固定为 `phase-4-payroll-adjustment-indexes-v1`。这是新增集合的独立追加迁移，不修改已经发布的 Payroll Core、Tax、Reconciliation 或 Shadow manifest。

## 前置检查

1. MongoDB 必须为 Replica Set，应用生产配置保持 `autoIndex=false`。
2. `PAYROLL_DATA_ENCRYPTION_KEYS` 由 Secret Manager 注入；禁止在 dry-run、日志或证据包中输出密钥和工资明细。
3. 确认 `payroll_adjustments` 不存在同租户、同原工资行、同调整编号的重复记录。

## 执行

```bash
pnpm --filter @gaoq/erp-api migrate:phase4:payroll-adjustment-indexes -- --dry-run
pnpm --filter @gaoq/erp-api migrate:phase4:payroll-adjustment-indexes
```

必须审批 dry-run manifest 和 checksum 后方可 apply。迁移账本 checksum 不一致、索引冲突或连接非目标 Replica Set 时失败关闭。

## 验收与回退

- 唯一键必须为 `tenantId + id` 以及 `tenantId + originalCalculationLineId + adjustmentNumber`；
- `tenantId + period + status` 必须支持审批和结算工作队列；
- 用两个隔离租户验证相同来源引用互不冲突，同租户重复编号被拒绝；
- 删除索引或调整记录属于破坏性操作，不在本 Runbook 自动执行，必须另行审批。
