# 工资调整税务更正、WORM、审批与税局受理

本切片处理 `taxCorrectionStatus=pending` 的已锁定工资调整。更正清单使用
`CN_IIT_WITHHOLDING_CORRECTION_V1`，只从调整密文中的原结果、更正结果和确定性
差额生成；客户端不能提交员工、税额或税务正文。

## 两阶段制备与 WORM

`POST /payroll/adjustments/:id/tax-corrections` 只接受 `expectedVersion`，要求已验证
人工税务人员同时具有：

- `erp:payroll:adjustment:tax_correction:prepare`；
- `erp:payroll:adjustment:tax_correction:source:read`。

制备人必须独立于调整重算、送审、审批和锁定控制链。事务内先创建
`status=archiving/version=1` 的 L4 密文记录，并把唯一清单 ID 绑定到调整；事务
提交后才向独立 Payroll Tax WORM 写正文。WORM 回执再次在事务内绑定后进入
`prepared/version=2`。外部归档失败不会把未归档清单伪记为 prepared，重试复用
内容摘要与对象键。

## 强认证审批与税局提交

- `POST /payroll/adjustment-tax-corrections/:id/approval`：
  `erp:payroll:adjustment:tax_correction:approve`，人工用户、WebAuthn UV，operation
  绑定清单 ID；审批人不得是更正制备人或原调整任一控制人员，成功后为
  `approved/version=3`。
- `POST /payroll/adjustment-tax-corrections/:id/submission`：
  `erp:payroll:adjustment:tax_correction:submit`，仅受信任税务连接器；先事务性进入
  `submitting`，再只向税务网关发送 WORM 引用、摘要、期间和控制总量。生产模式
  仍要求 Phase 6 一次性短时授权。
- 网关回执必须逐字段绑定租户、清单、期间、WORM 引用和摘要。只有
  `accepted=true` 的税局回执落库后才进入 `submitted/version=4`，并在同一事务
  推进调整 `taxCorrectionStatus=submitted`。

现金子状态仍为 `pending` 时调整保持 `locked`；现金为 `settled/not_required` 时
进入 `settled`。无需现金且无需税务动作的调整在 WebAuthn 锁定后追加 settled
状态，不留无法推进的 locked 记录。

## REST、事件与标准 MCP

- REST 读取：`GET /payroll/adjustment-tax-corrections/:id`，Scope
  `erp:payroll:adjustment:tax_correction:read`。
- CloudEvent：
  `payroll.adjustment_tax_correction.prepared/approved/submitted` 以及调整侧
  `tax_correction_prepared/tax_correction_submitted`；只含期间、摘要、状态和必要
  证据标识，不含员工、税额、正文、WORM 地址或控制人员。
- MCP Tool：`payroll_adjustment_tax_correction_status_get`。
- MCP Resource：
  `erp://payroll/adjustment-tax-corrections/{id}`。
- MCP Prompt：`payroll_adjustment_tax_correction_review_guide`。

三项 MCP 能力都复用
`PayrollAdjustmentTaxCorrectionService.getControlStatus`，只返回格式、摘要、
WORM/税局证据标识、状态和版本；不存在制备、审批或提交 Tool。

真实税局沙箱格式校验、签名/回执金样例、法定更正时限、生产授权域和薪税人员签署
仍须现场完成。本地 Adapter 与协议测试不能替代税局受理证据。
