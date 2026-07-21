# Payroll 四方对账索引迁移 Runbook

迁移标识：`phase-4-payroll-reconciliation-indexes-v1`。迁移只追加 `payroll_reconciliations` 索引，不删除或改写既有 Payroll/Treasury 索引。

## 前置检查

1. 确认 MongoDB 为 Replica Set，并备份集合统计、现有索引和迁移登记。
2. 确认目标环境不存在同租户下重复的 `periodId`、`payrollRunId` 或 `batchId` 对账快照。
3. 仅通过隔离运维身份注入 `MONGODB_URI`；连接串和凭据不得写入仓库、脚本参数或日志。

## 执行

```bash
pnpm --filter @gaoq/erp-api build
pnpm --filter @gaoq/erp-api migrate:phase4:payroll-reconciliation-indexes -- --dry-run
pnpm --filter @gaoq/erp-api migrate:phase4:payroll-reconciliation-indexes
```

Dry-run 必须显示所有唯一索引以 `tenantId` 开头，并至少包含：

- `tenantId + id` 唯一；
- `tenantId + periodId` 唯一；
- `tenantId + payrollRunId` 唯一；
- `tenantId + batchId` 唯一；
- `tenantId + status + createdAt` 查询索引。

## 验证与回退

- 再次 dry-run 必须无待建索引；在非生产租户验证周期、运行、批次防重和跨租户隔离。
- 若唯一索引因历史重复数据失败，立即停止发布并保留诊断证据；不得删除约束或伪造迁移登记。
- 代码回退时保留追加索引。删索引属于独立高风险变更，必须另行审批和演练。
