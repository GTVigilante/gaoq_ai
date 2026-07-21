# 员工本人薪资单与 MCP

薪资单是已锁定活动运行的不可变视图，不创建可漂移的第二套工资明细。REST 与 MCP 均调用 `PayrollPayslipService`，不直接查询数据库或解密服务。

## 发布与完整性

- 只有 `locked / disbursing / reconciling / reconciled` 周期视为已发布；draft、collecting、review、pending_approval 和 approved 均返回“尚未发布”。
- 当前主体必须是 user，并由已验证 actor 通过 Access Profile 反查 ERP employeeId；接口不接受 employeeId 或 tenantId。
- 输入与结果分别通过独立 Payroll AES-256-GCM 密钥域解密，AAD 绑定租户、资源类型、记录 ID 与版本。
- 读取时重新执行确定性工资内核，并同时复核员工、月份、活动运行、`inputHash`、`resultHash`；任一不一致失败关闭。
- 输出不包含员工标识、累计税历史、审批证据、薪酬档案 ID、考勤快照 ID 或加密元数据。

## 字段权限

- `erp:payroll:sheet:read_self`：只允许读取当前已验证员工本人的已发布薪资单。
- 管理者、HR、财务没有隐式穿透本人边界；跨员工读取必须在未来独立用例中定义字段白名单、目的限制和审批，不复用本接口。
- REST 与 MCP 读取均记 R1 审计，只记录月份和完整性摘要，不复制工资金额到审计或日志。

## MCP 契约

- Tool：`payroll_payslip_get_self`
- Resource：`erp://payroll/payslips/{period}/me`
- Prompt：`payroll_payslip_review_guide`

MCP 可以解释本人工资构成，但不得比较或推断他人薪酬，也不得触发重算、审批、锁定、导出、代发或对账。
