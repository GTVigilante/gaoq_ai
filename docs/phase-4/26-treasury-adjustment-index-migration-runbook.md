# Treasury 工资调整来源索引迁移 Runbook

迁移标识：`phase-4-treasury-adjustment-indexes-v1`。

本迁移只追加：

```text
treasury_disbursement_batches:
  tenantId + adjustmentSourceId
  unique + partial(adjustmentSourceId is string)
```

它不删除、不重命名、不重建既有 Treasury 索引，也不写银行账户、支付指令或历史
批次。唯一索引是补发防重控制，不能用应用层先查后写替代。

执行顺序：

```bash
pnpm --filter @gaoq/erp-api build
pnpm --filter @gaoq/erp-api migrate:phase4:treasury-adjustment-indexes -- --dry-run
pnpm --filter @gaoq/erp-api migrate:phase4:treasury-adjustment-indexes
```

生产执行前必须确认：

1. MongoDB 使用 Replica Set，且连接串指向目标租户共享集群；
2. 迁移身份只具备索引管理所需最小权限；
3. dry-run 只显示上述一个唯一部分索引；
4. 目标集合不存在重复非空 `adjustmentSourceId`；
5. 变更窗口、备份、监控和回退负责人已签署。

发现重复来源时必须冻结对应调整与批次并调查，禁止通过删除、改写来源 ID 或取消
唯一约束完成迁移。回退仅允许按已批准变更单删除本次新增索引；删除索引会失去并发
防重能力，因此应用必须同时停止补发制备入口。
