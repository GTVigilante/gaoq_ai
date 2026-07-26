# 锁定工资补发、冲销与税务差额准备

本切片为已经 `locked / disbursing / reconciling / reconciled` 的活动工资行建立追加式更正记录。它只准备确定性差额，不执行银行补发、员工扣款、后续工资抵扣或税务重报。

## 权威重算链

`POST /payroll/adjustments/prepare` 只允许具备 `erp:payroll:adjustment:prepare` 的 `service / system_job` 调用，并且只接收：

- 原工资周期与原活动计算行 ID；
- 已发布规则包 ID/版本；
- 员工、薪酬档案与考勤快照 ID；
- 标准原因码。

客户端不得提交原金额、更正金额或差额。应用服务在同一 MongoDB 事务中重新读取原周期与原计算密文，校验原行属于活动锁定运行，再复用 `PayrollRunService` 解密权威档案和考勤、继承累计预扣状态并执行确定性重算。

领域内核逐项复核原结果和更正结果哈希，然后计算有符号的应发、应税、个税、实发和累计预扣差额：

- 实发差额大于零：`supplement`，仅形成正数 `payableMinor`；
- 实发差额小于零：`reversal`，仅形成正数 `receivableMinor`，禁止生成负数银行支付指令；
- 实发差额为零但税务或累计状态变化：`tax_only`；
- 输入未变化、全量差额为零、摘要被篡改、原周期未锁定或原行不属于活动运行时失败关闭。

## 数据、安全与事件

更正输入、原/新结果、考勤快照摘要及逐项差额使用 Payroll AES-256-GCM 独立密钥域保存，AAD 绑定租户、调整 ID 和版本。明文控制面只保存状态、标准原因、哈希和必要的有符号控制金额。

CloudEvent `cn.gaoq.erp.payroll.adjustment.prepared.v1` 只携带期间、类型、原因、状态和 `adjustmentHash`，不携带员工、工资行、金额或密文。受控 REST 读取为 L4；标准 MCP 仅提供 `payroll_adjustment_status_get` 脱敏控制状态，不返回员工或金额，也不提供准备、批准、锁定、收付或税务重报 Tool。

MCP 契约逐字固定为 Tool `payroll_adjustment_status_get`、Resource Template `erp://payroll/adjustments/{id}`、Prompt `payroll_adjustment_review_guide`，三者都复用 `PayrollAdjustmentService.getControlStatus`。

## 后续控制链

专用 Approval 送审、可信终态同步和独立 WebAuthn UV 锁定已经由
[工资调整审批与 WebAuthn 锁定](./24-payroll-adjustment-approval-locking.md) 交付。
补发 `supplement` 子批次、冲销应收/后续抵扣、税务更正申报和结算回写仍须在
后续切片完成；在这些收付与申报控制链交付前，不得把 locked 记录记为已补发、
已追回或已更正申报。
