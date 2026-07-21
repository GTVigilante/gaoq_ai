# 两个完整工资影子周期、差异归因与财务签署

## 目标与事实源边界

旧工资系统在统一大切换前继续作为生产工资与真实发薪事实源。ERP 只使用受控副本执行影子计算和比较；本能力即使生成 `eligible` 资格，也不会修改事实源配置、银行连接或代发模式。

每个影子周期必须绑定一个已经锁定或完成四方对账的 ERP 工资运行，以及旧系统同一自然月份的完整导出。比较不使用金额容差，所有金额均为整数分。

## 旧系统连接契约

受信任旧系统连接器使用服务身份和 `erp:payroll:shadow:import` Scope 调用：

`POST /payroll/periods/:id/shadow-cycles`

请求必须携带 `Idempotency-Key`，并提交以下固定证据：

- `sourceSystem` 与唯一 `sourceExportId`；
- 独立 WORM 对象证据 `sourceObjectEvidenceId`；
- 连接器验签证据 `sourceSignatureEvidenceId`；
- `GAOQ_LEGACY_PAYROLL_EXPORT_V1` 规范清单摘要；
- 每人唯一的来源行标识、应发、预扣税、实发和来源结果摘要。

单次导入最多 5,000 行且 HTTP JSON 硬上限为 8 MiB；超过任一限制必须由连接器拆分为新的受控批次方案并经 ADR 评审，当前接口不会静默截断或分片合并。

连接器必须在调用 ERP 前完成来源文件验签、恶意文件扫描、WORM 留档、格式白名单转换和重复行阻断。ERP 不接收旧系统数据库凭据、签名私钥、Token、自由 Mongo 查询或动态字段映射。普通用户、浏览器和 MCP 均不能调用导入接口。

ERP 再次按固定字段顺序计算来源清单 SHA-256，并对本地工资计算密文逐行解密、验证结果摘要、重算运行摘要和控制总额。任一摘要、人数、运行、周期或总额不一致均失败关闭，不产生半份影子周期。

## 比较、密文与标准差异

比较以员工唯一标识连接两侧行，标准差异码固定为：

- `LEGACY_EMPLOYEE_MISSING`：ERP 有员工行，旧系统缺失；
- `ERP_EMPLOYEE_MISSING`：旧系统有员工行，ERP 缺失；
- `GROSS_AMOUNT_MISMATCH`：应发不一致；
- `WITHHOLDING_TAX_MISMATCH`：预扣税不一致；
- `NET_AMOUNT_MISMATCH`：实发不一致。

员工标识、旧系统行、逐项金额和差额均只保存在 Payroll AES-256-GCM 密文或独立 WORM 中。影子周期明文控制面只保存人数、总额、标准码、差异数量、绝对差异金额和摘要。人员缺失差异的绝对金额按实发差额计入；其余按对应字段差额绝对值计入。

差异明细只允许拥有 `erp:payroll:shadow:difference:read` 的已验证人员通过 ERP 受控界面读取：

`GET /payroll/shadow-cycles/:id/differences`

该 L4 接口不注册 MCP Tool 或 Resource。列表、事件、日志和普通控制摘要不得出现员工标识或逐项金额。

## 追加式归因与职责分离

差异解释通过以下 R2 接口追加，不能修改原比较记录：

`POST /payroll/shadow-cycles/:cycleId/differences/:differenceId/explanation`

标准归因码为 `LEGACY_RULE_VERSION`、`LEGACY_INPUT_CUTOFF`、`LEGACY_ROUNDING`、`LEGACY_MASTER_DATA`、`APPROVED_MANUAL_ADJUSTMENT`、`OTHER_VERIFIED`。每条差异只能有一份最终解释，必须绑定独立证据 ID 和已验证人员；签署后禁止补写解释。

双签均为 R3，并按固定顺序执行：

- 薪酬负责人调用 `POST /payroll/shadow-cycles/:id/payroll-signoff`；
- 独立财务负责人随后调用 `POST /payroll/shadow-cycles/:id/finance-signoff`。

两次签署共同要求：

1. 所有差异均已有唯一解释，未解释差异为零；零差异周期可直接进入签署。
2. 已验证人员访问令牌与当前主体一致。
3. WebAuthn UV 证据的 `operationId` 等于影子周期 ID 与签署角色的固定组合。
4. 薪酬签署人不得是旧系统导入人、工资制单人、工资锁定人或任一差异归因人；财务签署人还不得是工资审批人或薪酬签署人。
5. 财务签署必须在薪酬签署之后；签署记录、角色、解释集合摘要和强认证证据摘要不可变。

## 连续两期门禁

第二个已签署周期只能与前一个自然月的已签署周期组合。服务生成 `GAOQ_PAYROLL_TWO_CYCLE_CUTOVER_READINESS_V1` 不可变证据，绑定两个周期、两个签署证据及起止月份，状态固定为 `eligible`。

该证据只满足 Phase 4 的工资影子门禁。Phase 6 仍必须验证三次全量演练、回滚、安全、权限、外部连接、备份恢复、监控和值班，并取得跨职能 Go/No-Go 签署。任何 AI、MCP 客户端或本服务都不能把 `eligible` 解释为自动上线授权。

在 Phase 6 总体授权能力交付前，`TREASURY_BANK_SUBMISSION_MODE=production` 会由 Treasury 应用服务无条件失败关闭；影子联调只允许 `sandbox`。这避免把局部工资门禁误当成真实资金授权。

## REST、事件、审计与 MCP

脱敏只读 REST：

- `GET /payroll/shadow-cycles/:id`；
- `GET /payroll/cutover-readiness/:id`。

事件采用精确字段白名单：

- `payroll.shadow_cycle.compared.v1`；
- `payroll.shadow_difference.explained.v1`；
- `payroll.shadow_cycle.signed.v1`（分别以 `payroll_owner`、`finance_owner` 角色发布）；
- `payroll.cutover_readiness.eligible.v1`。

事件不包含员工、导入人、归因人、签署人、强认证证据 ID、来源对象地址或外部 Token。导入、归因和签署分别记 R3、R2、R3 审计；控制摘要与资格读取记 R1 审计。

MCP 仅提供只读能力，并全部复用 `PayrollShadowService`：

- Tools：`payroll_shadow_cycle_get`、`payroll_cutover_readiness_get`；
- Resources：`erp://payroll/shadow-cycles/{id}`、`erp://payroll/cutover-readiness/{id}`；
- Prompts：`payroll_shadow_cycle_review_guide`、`payroll_cutover_readiness_review_guide`。

MCP 不直接访问数据库，不读取旧系统或 WORM，不注册导入、行级差异、归因、WebAuthn 签署、真实代发或事实源切换动作。

## 验收

- 两个自然月分别完成完整员工集比较，未解释差异为零并由独立财务人员签署。
- 人数、应发、预扣税、实发、来源摘要、ERP 运行摘要和比较摘要均可重算。
- 重复周期、运行、来源导出、差异解释、签署和资格证据由租户前缀唯一索引阻断。
- 任一摘要篡改、密文篡改、职责冲突、非 WebAuthn 证据或非连续月份均为 No-Go。
- 资格生成后仍保持旧系统为事实源，直至 Phase 6 总体 Go/No-Go 明确批准。
