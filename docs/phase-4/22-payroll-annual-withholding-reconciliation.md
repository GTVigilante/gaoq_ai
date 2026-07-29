# 年度工资代扣、税表与税局评估核对

本切片建立员工维度的年度工资代扣核对，但不把 ERP 包装成个人所得税申报客户端。税局年度评估是外部权威输入；ERP 不自行推断员工其他单位收入、劳务报酬、特许权使用费、专项扣除或家庭税务选择。

默认 `PAYROLL_SYSTEM_MODE=external` 时，制备与控制摘要读取在扫描工资期、输入、
计算行或税表集合前返回 `PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM`。标准 MCP
读取控制摘要也只复用该应用服务，不直连年度记录。

## 权威来源

`POST /payroll/annual-reconciliations/prepare` 只允许具备
`erp:payroll:annual:prepare` 的 `service / system_job` 调用。请求严格只包含
员工 ID 与税年，生成 `awaiting_assessment` 基线；客户端不得提交税局评估 ID、
证据、税额或来源摘要。

具备 `erp:payroll:annual:assessment:resolve` 的受信任 `service / system_job`
可调用 `POST /payroll/annual-reconciliations/resolve-assessment`。应用先通过隔离
税务网关的 `/v1/annual-assessments/resolve` 读取官方评估并验证 Ed25519 回执，
再以网关返回的受信任评估生成追加版本。网关回执必须严格反向绑定租户、员工、
税年、请求 `controlDigest`、评估证据及五分钟签发窗口；标识复用、额外字段、
错误签名、过期或上下文漂移一律失败关闭。

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

逐月输入/结果、税表行、税局评估和应补/应退金额全部为 L4，只保存在 Payroll
AES-256-GCM 密文。明文控制面保存员工引用、税年、期间数量、状态、版本和
`evidenceHash`，不保存税额。通用幂等账本只保存年度记录 ID、版本与
`evidenceHash`，重放必须重新读取并验证密文；不得把完整年度响应或税额复制进
幂等记录。

`requires_employee_settlement` 状态下，具备
`erp:payroll:annual:settlement:self` 的活动员工本人可调用
`POST /payroll/annual-reconciliations/{id}/settlement-link`。服务从可信身份映射
员工，不接受 `employeeId`，并要求年度记录属于本人、密文与控制字段一致。税务
网关 `/v1/annual-settlement-links` 只接收记录 ID、税年和 `evidenceHash` 等最小
控制字段；返回链接必须经过 Ed25519 验签、绑定请求摘要、仅指向
`PAYROLL_TAX_OFFICIAL_PORTAL_ORIGIN`，且有效期大于 30 秒、不超过 5 分钟。
HTTP 响应固定 `Cache-Control: no-store` 与 `Pragma: no-cache`；审计不记录带
一次性令牌的 URL，ERP 不提交表单、不代扣或代退税款。

运行配置必须成套注入 `PAYROLL_TAX_GATEWAY_SIGNING_KEY_ID`、
`PAYROLL_TAX_GATEWAY_SIGNING_PUBLIC_KEY_BASE64` 和
`PAYROLL_TAX_OFFICIAL_PORTAL_ORIGIN`；公钥仅接受规范 Ed25519 SPKI DER
base64。回执签名输入为
`gaoq-payroll-annual-receipt-v1\n<key-id>\n<raw-response-body-sha256-base64url>`；
响应体按 16 KiB 上限读取并以严格 UTF-8/JSON 解析，禁止压缩响应。

CloudEvent `cn.gaoq.erp.payroll.annual_reconciliation.prepared.v1` 只携带税年、期间数量、状态和摘要，不包含员工、工资、税额或税局证据标识。REST 读取要求 L4 权限；标准 MCP 仅提供 `payroll_annual_reconciliation_status_get` 脱敏控制状态，不返回员工或税额，也不提供任何申报/收付 Tool。

MCP 契约逐字固定为 Tool `payroll_annual_reconciliation_status_get`、Resource Template `erp://payroll/annual-reconciliations/{id}`、Prompt `payroll_annual_reconciliation_review_guide`，三者都复用 `PayrollAnnualReconciliationService.getControlStatus`。

## 外部验收边界

工资调整税务更正申报已由
[工资调整税务更正](./28-payroll-adjustment-tax-correction.md)交付。年度评估
HTTP 适配器、签名回执校验和员工官方办理跳转的仓库实现已交付；真实税局沙箱
凭据、官方端点、密钥轮换、断连恢复、代表性金样例及薪税人员签署尚未验收。
官方个人综合所得申报始终由法定申报主体在外部税务系统办理，代码自测不能替代
现场证据。
