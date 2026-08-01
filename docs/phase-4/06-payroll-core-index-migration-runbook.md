# Payroll Core 索引迁移 Runbook

迁移标识固定为 `phase-4-payroll-core-indexes-v1`，只追加规则包、薪酬版本、周期、运行、输入快照和结果行索引；不得修改已发布的考勤迁移。

## 前置检查

1. MongoDB 必须是 Replica Set，备份与恢复演练有效；应用仍保持旧工资系统为生产事实源。
2. 由 Secret Manager 注入独立 `PAYROLL_DATA_ENCRYPTION_KEYS`，仓库、镜像、日志和命令行不得出现密钥值。
3. 确认目标集合不存在跨租户重复键、同周期重复、同员工版本重复、同法域版本重复或同运行员工重复数据。

## 执行

构建后先运行：

```bash
pnpm --filter @gaoq/erp-api migrate:phase4:payroll-core-indexes -- --dry-run
```

审批 dry-run manifest 与 checksum 后执行：

```bash
pnpm --filter @gaoq/erp-api migrate:phase4:payroll-core-indexes
```

迁移账本 checksum 不一致必须失败关闭，不得原地覆盖历史迁移记录。

## 验收与回退

- 验收六个集合均有 `tenantId` 前缀唯一键，并确认 API `autoIndex=false` 的生产设置未改变。
- 用隔离租户验证周期、规则、薪酬版本、运行序号及员工输入/结果行的重复写入均被拒绝。
- 索引创建失败时停止 Payroll Core 上线并保留旧工资系统；删除已建唯一索引属于破坏性操作，必须另行审批，本 Runbook 不自动执行。
