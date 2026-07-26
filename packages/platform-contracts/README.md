# @gaoq/platform-contracts

GaoQ ERP 与专业算薪系统共享的版本化契约包。

- ERP 是租户、身份、组织、员工与劳动关系的唯一主数据源。
- 专业算薪系统是薪酬规则、工资运行、工资条、薪税与发放结果的唯一事实源。
- 所有事件使用 CloudEvents 1.0，携带可信 `tenantId`、`traceId` 和 `idempotencyKey`。
- 本包只定义脱敏控制面契约，禁止加入工资明细、银行卡、证件或税务正文。

发布前必须执行：

```bash
pnpm --filter @gaoq/platform-contracts build
pnpm --filter @gaoq/platform-contracts typecheck
pnpm --filter @gaoq/platform-contracts test
```
