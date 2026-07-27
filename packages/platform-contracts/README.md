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

发布前必须执行：

```bash
pnpm --filter @gaoq/platform-contracts build
pnpm --filter @gaoq/platform-contracts typecheck
pnpm --filter @gaoq/platform-contracts test
```
