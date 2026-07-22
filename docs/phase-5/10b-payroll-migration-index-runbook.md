# Phase 5 Payroll 迁移证据索引运行手册

三个追加迁移必须依次执行。`phase-5-payroll-migration-indexes-v1` 永久固定规则、薪酬、周期和计算运行四类实体；`phase-5-payroll-control-indexes-v2` 另行加入批准与锁定控制证据；`phase-5-payroll-tax-migration-indexes-v3` 只加入个税清单迁移证据。禁止修改任一已执行 manifest 或 Phase 4 Payroll 索引清单。

```bash
pnpm --filter @gaoq/erp-api build
pnpm --filter @gaoq/erp-api migrate:phase5:payroll-migration-indexes -- --dry-run
pnpm --filter @gaoq/erp-api migrate:phase5:payroll-migration-indexes
pnpm --filter @gaoq/erp-api migrate:phase5:payroll-migration-indexes -- --dry-run
pnpm --filter @gaoq/erp-api migrate:phase5:payroll-control-indexes -- --dry-run
pnpm --filter @gaoq/erp-api migrate:phase5:payroll-control-indexes
pnpm --filter @gaoq/erp-api migrate:phase5:payroll-control-indexes -- --dry-run
pnpm --filter @gaoq/erp-api migrate:phase5:payroll-tax-migration-indexes -- --dry-run
pnpm --filter @gaoq/erp-api migrate:phase5:payroll-tax-migration-indexes
pnpm --filter @gaoq/erp-api migrate:phase5:payroll-tax-migration-indexes -- --dry-run
```

执行顺序固定在对应数据 Scope 之前。apply 前必须完成备份、MongoDB Replica Set 健康检查、重复证据引用预检、复制延迟告警和变更窗口批准。七个必须核验的唯一键为：

- `payroll_rule_packs`: `tenantId + migrationEvidenceRef`；
- `payroll_compensation_profiles`: `tenantId + migrationEvidenceRef`；
- `payroll_periods`: `tenantId + migrationEvidenceRef`；
- `payroll_calculation_runs`: `tenantId + migrationEvidenceRef`；
- `payroll_period_approval_evidence`: `tenantId + migrationEvidenceRef`；
- `payroll_period_lock_evidence`: `tenantId + migrationEvidenceRef`；
- `payroll_tax_filings`: `tenantId + migrationEvidenceRef`。

规则、薪酬、周期、运行和税务清单的五个索引使用 `migrationEvidenceRef` 为字符串的 partial filter，普通在线记录的 `null` 不参与唯一约束；审批与锁定证据只用于迁移，WORM 引用始终必填并直接唯一。第二次 dry-run 必须无新增动作；唯一冲突、复制延迟、锁等待或 API SLO 越线时立即停止，不得删除或改写业务/WORM 记录来伪造通过。
