# Payroll Annual Reconciliation 索引迁移 Runbook

迁移标识固定为 `phase-4-payroll-annual-indexes-v1`。该迁移只追加 `payroll_annual_reconciliations`，不得修改其他 Phase 4 manifest。

## 执行

在 MongoDB Replica Set、备份恢复证据和 Payroll 独立密钥环有效后运行：

```bash
pnpm --filter @gaoq/erp-api migrate:phase4:payroll-annual-indexes -- --dry-run
pnpm --filter @gaoq/erp-api migrate:phase4:payroll-annual-indexes
```

必须先审批 dry-run manifest 与 checksum。参数异常、目标连接异常、迁移账本摘要漂移或重复唯一键均失败关闭。

## 验收

- `tenantId + id` 唯一；
- `tenantId + employeeId + taxYear + version` 唯一，允许外部评估到达后追加新版本；
- `tenantId + taxYear + status` 支持年度冻结和待办理队列；
- 抽样验证明文记录不包含工资、税额、税表行或评估正文；
- 删除索引或核对记录属于破坏性操作，必须另行审批。
