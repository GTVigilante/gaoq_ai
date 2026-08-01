# 工资调整审批与 WebAuthn 锁定

本切片把已经准备的确定性工资差额接入专用 Approval 模板与 WebAuthn UV 锁定。
它只形成可执行前的不可变控制终态，不创建银行支付、员工扣回或税务更正申报。

## 专用审批契约

生产前必须发布代码为 `payroll_adjustment_approval` 的 R2 模板。表单只允许以下
只读控制字段：

- `adjustment_id`：工资调整 ULID；
- `adjustment_hash`：绑定租户、员工、期间、原结果与更正结果的调整摘要；
- `period`：原工资期间；
- `adjustment_type`：`supplement / reversal / tax_only`；
- `reason_code`：标准更正原因码。

`POST /payroll/adjustments/:id/approval` 要求
`erp:payroll:adjustment:approval:request` 与 `erp:approval:instance:submit`，只允许
已验证 `user` 提交 `expectedVersion`。应用服务从工资调整记录构造审批表单，客户端
不能提交员工、原金额、更正金额或差额。

`POST /payroll/adjustments/:id/approval-result` 只允许同时具备
`erp:payroll:adjustment:approval:sync` 的 `service / system_job` 调用。服务从
Approval 应用服务读取专用模板的 approved/rejected 可信终态、最终决策人和固定
表单摘要；模板、调整 ID、摘要、期间、类型或原因任一不匹配均失败关闭。

状态严格为：

```text
prepared → pending_approval → approved
                            ↘ cancelled（审批拒绝）
```

重算服务、人工送审人与最终审批人必须彼此独立。

## R3 强认证锁定

`POST /payroll/adjustments/:id/lock` 要求
`erp:payroll:adjustment:lock`、`expectedVersion` 和 WebAuthn 证据 ULID。

1. authentication ceremony 的 `operationId` 必须等于调整 ID；
2. 访问令牌、租户上下文、人员、登录会话和证据必须完全一致；
3. WebAuthn 必须完成 UV，且证据仍在有效期内；
4. 锁定人必须独立于重算服务、送审人与审批人；
5. 事务按 `tenantId + id + version + status` 乐观锁推进
   `approved → locked`。

事件逐字固定为
`payroll.adjustment.approval_requested`、
`payroll.adjustment.approval_applied` 和
`payroll.adjustment.locked`。CloudEvent 只发布期间、类型、原因、状态与
`adjustmentHash`；批准事件额外发布 outcome，锁定事件只额外发布
`strongAuthMethod=webauthn_uv`。事件、审计和日志不得包含员工、金额、审批人、
锁定人或强认证证据 ID。

## MCP 与未完成边界

标准 MCP 继续只复用 `PayrollAdjustmentService.getControlStatus` 返回脱敏控制
状态。AI 不注册送审、同步审批、启动强认证或锁定 Tool，也不能读取审批人、员工
或金额。

锁定不是结算。`supplement` 的 Treasury 子批次、直接或恢复全额成功回盘已由
[工资调整补发子批次](./25-payroll-adjustment-supplement-disbursement.md) 交付；
`reversal` 的员工应收与恢复凭证由
[员工应收](./27-payroll-adjustment-receivable-settlement.md)交付；税务更正清单、
WORM、WebAuthn 审批、税局回执及最终状态机由
[工资调整税务更正](./28-payroll-adjustment-tax-correction.md)交付。真实外部联调
和 UAT 仍是生产放行前置条件。
