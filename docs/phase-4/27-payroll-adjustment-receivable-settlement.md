# 负向工资调整员工应收与恢复凭证

本切片把 `type=reversal / status=locked / cashSettlementStatus=pending` 的负向工资
差额转为唯一员工应收。它绝不生成负数银行指令，也不允许客户端重新指定员工或
应收金额。
默认 `PAYROLL_SYSTEM_MODE=external` 时，建账、恢复和读取在访问调整来源、
应收/恢复集合、加密服务或 Outbox 前返回
`PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM`。

## 权威来源与职责分离

`POST /payroll/adjustments/:id/receivable` 只接受 `expectedVersion`，要求已验证
人工用户同时具有：

- `erp:payroll:adjustment:receivable:open`；
- `erp:payroll:adjustment:receivable:source:read`。

服务在同一 MongoDB 事务内完整解密并验证调整摘要，且要求建立人独立于调整重算、
送审、审批和锁定人员。员工身份只写入 `adjustment_receivable` 独立 AES-256-GCM
密文；明文控制面保存调整摘要、原始金额、未收余额、状态和版本。

`tenantId + adjustmentId` 唯一索引保证一个调整只能形成一个应收。建立成功后，
调整只绑定 `cashSettlementReferenceType=receivable` 和应收 ID，现金子状态仍为
`pending`。

## 追加式恢复

`POST /payroll/adjustment-receivables/:id/recoveries` 仅接受拥有
`erp:payroll:adjustment:receivable:settle` 的受信任 `service/system_job`。支持：

- `bank_repayment`：银行回款终态引用和独立证据；
- `authorized_payroll_deduction`：除通用结算 Scope 外，还要求
  `erp:payroll:adjustment:receivable:deduction:settle`，并必须提交独立法定授权
  证据。

每笔恢复写入不可变 `payroll_adjustment_receivable_recoveries`，来源引用与证据
分别唯一；金额必须为正数整数分且不能超过当前余额；时间不能早于建账或超出五分钟
未来时钟偏差。部分恢复只减少余额。余额归零时才：

1. 将应收置为 `settled`；
2. 把最后一笔恢复记录作为现金结算证据；
3. 推进调整 `cashSettlementStatus=settled`；
4. 若税务更正仍为 `pending`，整体保持 `locked`，否则进入 `settled`。

## 契约与安全边界

- REST 读取：`GET /payroll/adjustment-receivables/:id`，Scope
  `erp:payroll:adjustment:receivable:read`，属于 L4 受控界面。
- CloudEvent：`payroll.receivable.opened`、
  `payroll.receivable.recovery_recorded` 和最终
  `payroll.adjustment.cash_settled`；事件不含员工、金额、恢复来源或授权正文。
- 标准 MCP 不注册员工应收 Tool/Resource，因为余额和员工链路属于 L4；AI 只能
  通过 `payroll_adjustment_status_get` 看到整体现金子状态。
- 工资抵扣记录只是受信任工资运行的已执行终态，不是本服务自行从未来工资中扣款。
  未取得适用法域的授权、限额、工资运行和员工通知证据时必须失败关闭。

本地测试不能替代银行回款沙箱、法定授权模板评审、工资运行金样例和员工争议处理
UAT。
