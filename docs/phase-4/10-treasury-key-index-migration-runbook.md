# Treasury 密钥与索引迁移 Runbook

## 前置条件

1. 由 Secret Manager 注入互相独立的 `TREASURY_DATA_ENCRYPTION_KEYS` 与 `TREASURY_BLIND_INDEX_KEYS`；禁止在仓库、镜像、命令参数或日志中出现密钥值。
2. 加密环恰有一个 `active`，旧数据密钥只标记 `decrypt_only`；盲索引旧密钥只标记 `lookup_only`，待后台重建完成后才能移除。
3. 确认 MongoDB 为 Replica Set，完成备份恢复演练并取得变更窗口批准。

## 执行

```bash
pnpm --filter @gaoq/erp-api build
pnpm --filter @gaoq/erp-api migrate:phase4:treasury-indexes -- --dry-run
pnpm --filter @gaoq/erp-api migrate:phase4:treasury-indexes
```

迁移只追加账户、支付指令、代发批次和回盘集合的索引；不会删除、重命名或覆盖现有索引。若发现同租户重复账号盲索引、重复工资运行批次序号或重复回盘摘要，迁移必须失败并转人工清理，禁止自动选择保留记录。

## 验证与回滚

- 核对所有唯一索引首字段均为 `tenantId`，并验证跨租户同账号不冲突、同租户重复账号失败。
- 抽样文档不得存在 `account`、`accountName`、`creditorAccount`、`amountMinor` 或银行文件正文等员工级明文字段。
- 该迁移为追加式。回滚应用版本时保留索引；只有经变更审批并证明旧版本不写冲突数据后，才可单独安排索引移除窗口。
