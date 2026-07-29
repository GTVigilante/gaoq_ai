# 工资调整补发子批次与现金结算回写

本切片把 `type=supplement / status=locked / cashSettlementStatus=pending` 的正向
工资调整接入既有 Treasury WORM、ISO 20022、独立导出批准、银行提交和隔离回盘
链。它不复用普通工资运行重新计算金额，也不允许客户端选择员工、金额或账户。
默认 `PAYROLL_SYSTEM_MODE=external` 时，本服务在读取工资调整、原代发批次、
账户、支付指令或调用 WORM 前返回 `PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM`。

## 服务端权威来源

`POST /treasury/payroll-adjustments/:id/supplement` 只接受
`expectedAdjustmentVersion` 与 `requestedExecutionDate`，要求已验证 `user` 同时具备：

- `erp:treasury:adjustment:prepare`；
- `erp:treasury:adjustment:source:read`。

Treasury 通过 `PayrollAdjustmentService.getLockedSupplementSource` 读取内部来源。该
方法不注册 REST、事件或 MCP，只在可信租户上下文返回：

- 调整 ID、摘要、版本和原工资周期/运行/行引用；
- 唯一员工与正数 `payableMinor`；
- 更正结果摘要；
- 调整控制链人员标识，仅用于职责分离。

补发制备人不得是调整重算、送审、审批或锁定人员。

## 子批次与账户约束

服务只允许原常规代发已经提交银行后创建补发：

1. 找到相同工资周期与运行的原 `purpose=regular` 批次；
2. 解密并复核原批次付款账户快照；
3. 要求原付款账户仍为当前活动组织账户且内容未变；
4. 读取员工当前唯一活动收款账户；
5. 创建 `purpose=supplement`、单行、正金额子批次；
6. `parentBatchId` 绑定原批次，`adjustmentSourceId / adjustmentSourceHash` 绑定调整；
7. `tenantId + adjustmentSourceId` 唯一索引阻止并发或换幂等键重复补发；
8. 支付指令使用 `purposeCode=PAYROLL_ADJUSTMENT`，随后复用既有 WORM 物化、
   WebAuthn 导出批准、生产授权、银行网关和 Return Inbox。

CloudEvent `treasury.disbursement.adjustment_supplement_requested` 只发布调整 ID、
父批次、工资周期/运行、行数、控制总额和状态，不发布员工、账户、支付指令或人员
身份。

## 终态回盘与调整状态

直接补发子批次只有在签名、恶意文件、行身份、金额和总额全部通过且唯一支付行
成功时，才在同一 MongoDB 事务内调用
`PayrollAdjustmentService.recordSupplementBankReturn`：

- 保存 `cashSettlementReferenceType=treasury_batch`；
- 绑定补发批次与终态回盘 ID；
- 推进 `cashSettlementStatus=pending → settled`；
- 写 `payroll.adjustment.cash_settled` 最小事件。

如果该调整仍需要税务更正，整体 `status` 保持 `locked`；只有现金和税务两侧均
终结后才允许进入 `settled`。冻结或失败回盘不回写现金结算，必须进入既有恢复
子批次控制链。恢复子批次全额成功后，服务最多向上解析 16 层来源链；只有解析到
唯一 `supplement` 根、单行与金额全部一致时，才以恢复批次和本次回盘证据结算原
调整。循环、断链、过深或普通工资恢复均不能误写调整。

标准 MCP 的调整入口仍只有 `payroll_adjustment_status_get`，返回
`cashSettlementStatus / taxCorrectionStatus`，不返回员工、金额、批次或回盘证据，
也不注册制备、批准、提交或回盘 Tool。

## 外部验收边界

负向调整应收见[员工应收与恢复凭证](./27-payroll-adjustment-receivable-settlement.md)，
税务更正见[工资调整税务更正](./28-payroll-adjustment-tax-correction.md)。代码、
协议和 WORM 适配器自测已交付，但不能替代真实银行沙箱、税局沙箱、薪税/财务
UAT 与职责分离人员签署。
