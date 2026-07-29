# 工资调整结算索引迁移 Runbook

迁移标识：`phase-4-payroll-adjustment-settlement-indexes-v1`。

本迁移只从应用 Schema 生成并追加以下三类集合索引：

```text
payroll_adjustment_receivables
payroll_adjustment_receivable_recoveries
payroll_adjustment_tax_corrections
```

关键唯一约束包括：

- `tenantId + adjustmentId`：一个负向调整只能建立一个应收；
- `tenantId + receivableId + sourceReferenceId`：同一外部恢复来源不得重复分配；
- `tenantId + sourceEvidenceId`：恢复证据不得跨应收复用；
- `tenantId + adjustmentId`：一个调整只能建立一个税务更正清单。

所有索引首字段均为可信 `tenantId`。迁移不读取 L4 密文、不修改余额、税额、状态或
外部证据。

执行顺序：

```bash
pnpm --filter @gaoq/erp-api build
pnpm --filter @gaoq/erp-api migrate:phase4:payroll-adjustment-settlement-indexes -- --dry-run
pnpm --filter @gaoq/erp-api migrate:phase4:payroll-adjustment-settlement-indexes
```

生产执行前必须：

1. 使用 MongoDB Replica Set 和最小索引管理权限；
2. 将 dry-run 清单与本文件和目标 commit 绑定；
3. 确认三个集合不存在重复调整、来源或证据；
4. 记录备份、变更窗口、容量、慢查询监控与回退负责人；
5. 在应用写入口启用前完成 apply，并保存脱敏迁移证据。

发现重复时必须冻结相关调整与结算链调查，禁止删除恢复凭证、改写外部证据 ID、
合并余额或取消唯一约束。删除索引会失去并发防重能力；回退时必须同步关闭对应
写入口。
