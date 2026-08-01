# Payroll 影子周期索引迁移 Runbook

迁移标识：`phase-4-payroll-shadow-indexes-v1`。迁移只追加影子周期、差异、解释、签署和可切换资格索引，不删除或改写现有 Payroll 数据。

## 前置检查

1. 确认 MongoDB 为 Replica Set，已备份集合统计、索引清单和迁移登记。
2. 确认同租户不存在重复的周期、工资运行、来源导出、差异解释、周期签署或资格结束月份。
3. 确认 Payroll 数据密钥环可解密抽样影子密文，但禁止在迁移日志中输出明文。
4. 仅由隔离运维身份注入 `MONGODB_URI`；连接串、密钥和 Token 不得写入命令历史、仓库或日志。

## 执行

```bash
pnpm --filter @gaoq/erp-api build
pnpm --filter @gaoq/erp-api migrate:phase4:payroll-shadow-indexes -- --dry-run
pnpm --filter @gaoq/erp-api migrate:phase4:payroll-shadow-indexes
```

Dry-run 必须显示全部唯一索引以 `tenantId` 开头，并至少覆盖：

- 影子周期：`id`、`periodId`、`payrollRunId`、`sourceSystem + sourceExportId` 唯一；
- 差异：`id`、`cycleId + evidenceHash` 唯一；
- 解释：`id`、`differenceId` 唯一；
- 签署：`id`、`cycleId + role`、`period + role` 唯一；
- 资格：`id`、`secondCycleId`、`endPeriod` 唯一。

## 验证

- 再次 dry-run 无待建索引。
- 在非生产租户验证跨租户同业务 ID 可共存，同租户重复写入被唯一约束拒绝。
- 验证零差异周期可签署，有未解释差异的周期失败关闭；相邻两月生成资格，跨月断档不生成。
- 验证只读 MCP 不返回员工标识、逐项金额、解释证据或人员身份。

## 失败与回退

- 历史重复导致建索引失败时立即停止发布，保留重复键和迁移输出证据；不得删除约束、改写历史证据或伪造迁移登记。
- 应用代码可以回退，追加索引继续保留。删除索引属于独立高风险变更，必须另开变更、审批并演练。
- 迁移成功不等于完成两个真实薪资周期；真实周期证据和独立财务签署仍必须按月取得。
