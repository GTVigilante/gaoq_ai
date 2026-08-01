# @gaoq/platform-contracts

GaoQ ERP 与专业算薪系统共享的版本化契约包。

- ERP 是租户、身份、组织、员工与劳动关系的唯一主数据源。
- 专业算薪系统是薪酬规则、工资运行、工资条、薪税与发放结果的唯一事实源。
- 所有事件使用 CloudEvents 1.0，携带可信 `tenantId`、`traceId` 和 `idempotencyKey`。
- 事件名固定为 `cn.gaoq.<域>.<实体>.<动作>.v<主版本>`；运行时逐 type
  严格校验信封和 data，拒绝未知字段、数组注入、空 data 和超深对象。
- `PAYROLL_PLATFORM_EVENTS_JSON_SCHEMA` 提供同版本 JSON Schema Draft-07，
  应用、MCP、Worker 与外部专业算薪系统必须从本包引用，禁止复制后自行放宽。
- 本包只定义脱敏控制面契约，禁止加入工资明细、银行卡、证件或税务正文。
- 当前契约版本为 `1.0.0`，事件名严格使用
  `cn.gaoq.<域>.<实体>.<动作>.v<主版本>`。
- `PAYROLL_EVENT_JSON_SCHEMAS` 是应用、Worker 和外部算薪系统共同使用的逐事件
  JSON Schema；运行时必须调用 `isErpToPayrollEvent`、
  `isSafePayrollToErpEvent` 或 `isPayrollContractEvent`，禁止只依赖 TypeScript。

## v1 事件目录

| 方向 | 事件 |
| --- | --- |
| ERP → 算薪 | `cn.gaoq.erp.department.upserted.v1` |
| ERP → 算薪 | `cn.gaoq.erp.employee.upserted.v1` |
| ERP → 算薪 | `cn.gaoq.erp.employment.changed.v1` |
| 算薪 → ERP | `cn.gaoq.payroll.run.status_changed.v1` |
| 算薪 → ERP | `cn.gaoq.payroll.payslip.published.v1` |
| 算薪 → ERP | `cn.gaoq.payroll.cost_summary.published.v1` |
| 算薪 → ERP | `cn.gaoq.payroll.reconciliation.completed.v1` |

旧 `com.gaoq.*` 名称不由主验证器接受。迁移期只能通过
`migrateLegacyPayrollEvent` 显式转换；兼容入口仍执行 v1 的完整信封、精确字段、
格式、范围和脱敏校验。该名称兼容窗口只保留一个发布迭代，之后删除。

发布前必须执行：

```bash
pnpm --filter @gaoq/platform-contracts build
pnpm --filter @gaoq/platform-contracts typecheck
pnpm --filter @gaoq/platform-contracts test
```
