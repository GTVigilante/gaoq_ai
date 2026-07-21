# Phase 4：考勤、薪酬、薪税与发放对账

Phase 4 在 ERP 组织与劳动关系主数据之上，建立可重放的考勤月结、确定性薪资计算、审批锁定、银行/税务文件和四方对账闭环。旧系统在两个完整影子周期验收完成前仍是生产发薪事实源。

实现顺序：

1. [领域、金额、安全、集成与 MCP 强制契约](./00-payroll-attendance-contract.md)
2. [考勤原始事实、人工修订审批和不可变月结快照](./01-attendance-implementation.md)
3. [Attendance 索引迁移 Runbook](./02-attendance-index-migration-runbook.md)
4. [钉钉/飞书考勤 Provider 加密补拉与标准化](./03-attendance-provider-integration.md)
5. [Attendance Provider 独立索引迁移 Runbook](./04-attendance-provider-index-migration-runbook.md)
6. [薪酬结构、法定规则、权威输入快照与确定性运行](./05-payroll-core-implementation.md)
7. [Payroll Core 索引迁移 Runbook](./06-payroll-core-index-migration-runbook.md)
8. [财务审批与 WebAuthn 双人锁定](./07-payroll-approval-locking.md)
9. [员工本人薪资单、字段级权限与 MCP](./08-payroll-payslip-mcp.md)
10. [Treasury ISO 20022 代发与回盘冻结契约](./09-treasury-disbursement-contract.md)
11. [Treasury 密钥与索引迁移 Runbook](./10-treasury-key-index-migration-runbook.md)
12. [Treasury 银行账户版本应用契约](./11-treasury-bank-account-application.md)
13. [锁定工资到受控代发文件](./12-treasury-disbursement-materialization.md)
14. [隔离银行回盘、逐行复核与异常冻结](./13-treasury-bank-return-inbox.md)
15. [个税申报清单、独立审批与税务网关](./14-payroll-tax-filing.md)
16. [Payroll Tax 索引迁移 Runbook](./15-payroll-tax-index-migration-runbook.md)
17. 应发/代发/回盘/个税四方对账
18. 两个完整薪资周期影子计算、差异归因与财务签署

## 强制边界

- ERP Org 的 `Person / Employee / Employment` 是人员、组织归属和劳动关系唯一主数据源；考勤平台和银行不得反写组织事实。
- 金额使用整数分；比率使用整数基点或规则明确的有理数。禁止 JavaScript 浮点参与工资、税、社保、公积金或对账计算。
- 原始考勤、计算输入快照、规则版本、步骤账、审批、锁定、代发和回盘均不可静默覆盖；纠错创建新版本或关联调整批次。
- 银行账号、证件、薪资明细和税务文件为 L4；列表、事件、日志、审计和 MCP 不返回原文。
- MCP 不注册直接发薪、锁定、改规则、批量导出或上传银行回盘 Tool。本人查询为 R0，受控分析为聚合输出，处理请求最多形成待审批意图。
- 未完成两个影子周期且未解释差异不为零时，不得切换工资事实源或发起真实代发。
