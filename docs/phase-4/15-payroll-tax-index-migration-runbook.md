# Payroll Tax 索引迁移 Runbook

迁移标识：`phase-4-payroll-tax-indexes-v1`。该迁移仅追加 `payroll_tax_filings` 索引，不修改 Phase 4 Payroll Core 已发布清单。

## 前置检查

1. 确认 MongoDB 为 Replica Set，应用构建产物与目标提交一致。
2. 备份当前索引清单和集合统计；确认没有同一租户+工资周期的重复申报记录，也没有同一租户+税务提交 ID 的重复非空记录。
3. 在隔离运维身份中注入 `MONGODB_URI`；禁止把连接串、密钥或外部服务 Token 写入命令历史、文档和仓库。

## 执行

```bash
pnpm --filter @gaoq/erp-api build
pnpm --filter @gaoq/erp-api migrate:phase4:payroll-tax-indexes -- --dry-run
pnpm --filter @gaoq/erp-api migrate:phase4:payroll-tax-indexes
```

Dry-run 必须显示以下索引且每个唯一索引以 `tenantId` 开头：

- `tenantId + id` 唯一；
- `tenantId + periodId` 唯一；
- `tenantId + status + createdAt` 查询索引；
- `tenantId + taxSubmissionId` 非空部分唯一。

## 验证与回退

- 再次执行 dry-run 应无待建索引；检查迁移登记与数据库索引一致。
- 在非生产租户验证同周期防重、提交回执防重、状态查询和跨租户隔离。
- 本迁移不自动删除索引。若索引创建因历史重复数据失败，停止发布、保留失败证据并先修复数据；不得临时移除唯一约束或手工改写迁移登记。
- 如新代码需回退，索引保持不动；任何删索引操作必须单独变更、评审和审批。
