# 年度工资代扣、税表与税局评估核对

本切片建立员工维度的年度工资代扣核对，但不把 ERP 包装成个人所得税申报客户端。税局年度评估是外部权威输入；ERP 不自行推断员工其他单位收入、劳务报酬、特许权使用费、专项扣除或家庭税务选择。

## 权威来源

`POST /payroll/annual-reconciliations/prepare` 只允许具备 `erp:payroll:annual:prepare` 的 `service / system_job` 调用。请求只包含员工 ID、税年，以及可选的税局评估 ID、证据 ID、已评估税额和来源摘要。

应用服务按税年读取该员工全部活动锁定工资：

1. 解密每月不可变输入和结果，并重新执行确定性工资内核；
2. 校验首笔累计状态为零，后续 `cumulativeBefore` 与上一期 `cumulativeAfter` 逐字段连续；
3. 解密每月 `submitted` 个税内部清单，核对员工行、计算行 ID、结果哈希与当月代扣；
4. 核对全年工资代扣合计、已提交税表合计与年末累计税额；
5. 若存在带证据摘要的税局年度评估，仅计算“评估税额 - 工资已扣税”的应补/应退提示。

状态定义：

- `awaiting_assessment`：工资和税表守恒，尚无税局年度评估；
- `assessment_matched`：税局评估与工资已扣税逐分一致；
- `requires_employee_settlement`：存在应补或应退，仅提示员工走官方渠道；
- `frozen`：月度申报或年度合计不守恒，禁止继续。

## 安全、事件与 MCP

逐月输入/结果、税表行、税局评估和应补/应退金额全部为 L4，只保存在 Payroll AES-256-GCM 密文。明文控制面保存员工引用、税年、期间数量、状态、版本和 `evidenceHash`，不保存税额。

CloudEvent `cn.gaoq.erp.payroll.annual_reconciliation.prepared.v1` 只携带税年、期间数量、状态和摘要，不包含员工、工资、税额或税局证据标识。REST 读取要求 L4 权限；标准 MCP 仅提供 `payroll_annual_reconciliation_status_get` 脱敏控制状态，不返回员工或税额，也不提供任何申报/收付 Tool。

MCP 契约逐字固定为 Tool `payroll_annual_reconciliation_status_get`、Resource Template `erp://payroll/annual-reconciliations/{id}`、Prompt `payroll_annual_reconciliation_review_guide`，三者都复用 `PayrollAnnualReconciliationService.getControlStatus`。

## 未完成边界

真实税局年度评估适配器、签名/回执校验、员工官方办理跳转、税务更正申报及现场金样例尚未交付。代码自测不能替代税局沙箱与薪税人员签署。
