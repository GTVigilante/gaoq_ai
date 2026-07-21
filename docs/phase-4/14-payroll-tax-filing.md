# 个税申报清单、独立审批与税务网关

## 责任边界

ERP 从锁定工资结果、有效劳动关系和 `Person.identityEvidenceId` 生成确定性的 `CN_IIT_WITHHOLDING_MANIFEST_V1` 内部清单。该清单是税务隔离网关的输入契约，不冒充任何地区税局官方格式；地区格式转换、证件明文解析、税局客户端和税局凭据只存在于受控税务网关权限域。

税务链路由三个独立权限域组成：ERP、Payroll Tax WORM 和税务提交网关。税务服务必须与 ERP、Treasury WORM、银行提交、银行回盘以及彼此使用不同的标准 HTTPS Origin 和独立 Bearer 凭据；URL 凭据、查询参数、fragment、重定向和非 443 端口全部失败关闭。

## 状态机与双人控制

1. `POST /payroll/periods/:id/tax-filings` 只允许拥有 `erp:payroll:tax:prepare` 的已验证用户执行。周期必须为 `locked`，活动运行、结果摘要、人数和税额必须齐全；税务制备人不得兼任工资制单人或锁定人。
2. 第一事务逐行解密工资结果，复核行摘要、劳动关系唯一性和身份凭证引用，生成规范 JSON；Mongo 只保存 AES-256-GCM 密文、控制总额和摘要，状态为 `archiving`。
3. 应用在内存中恢复规范 JSON并写入独立 WORM。回执必须绑定对象键、SHA-256、不可变性和至少十年保留期；Buffer 发送后清零。第二事务才进入 `prepared` 并发布白名单事件。
4. `POST /payroll/tax-filings/:id/approval` 是 R3 人工动作。WebAuthn 用户验证证据必须绑定可信访问令牌的租户、人员、会话和申报清单 ID；审批人必须独立于工资制单人、工资审批人、工资锁定人和税务制备人，成功后进入 `approved`。
5. `POST /payroll/tax-filings/:id/submission` 只允许拥有 `erp:payroll:tax:submit` 的受信任 `service` 或 `system_job` 执行。网关只接收 WORM 引用、内容摘要、月份和控制总额；不接收员工行、身份凭证或税务正文。
6. 提交先暂存为同版本 `submitting`，网关回执必须逐字段反向绑定请求且 `accepted=true`，随后第二事务升级版本并进入 `submitted`。网络失败保留 `submitting`，以相同版本和确定性网关幂等键恢复，绝不伪造成功。

## 数据、事件与审计

- 清单按员工稳定排序；员工、工资行和身份凭证不得重复。金额全部为安全整数分，汇总使用 `BigInt` 防溢出，允许受规则约束的负预扣税调整。
- 税务密文 AAD 固定绑定可信租户、`tax_filing`、清单 ID 和版本；响应、事件、审计、日志和 MCP 均不得出现员工行、证件、身份凭证明细、密钥材料或 WORM 对象地址。
- `payroll.tax_filing.prepared.v1`、`approved.v1`、`submitted.v1` 使用逐事件精确字段白名单，只包含月份、工资运行、控制总额、内容摘要、状态及必要证据标识。
- 三个写接口均要求 `Idempotency-Key` 和乐观版本；全部写操作记 R3 审计。申报记录按可信租户+周期唯一，提交回执按可信租户+提交 ID 唯一。

## REST 与 MCP

- REST 只读：`GET /payroll/tax-filings/:id`，Scope 为 `erp:payroll:tax:read`。
- MCP Tool：`payroll_tax_filing_get`。
- MCP Resource：`erp://payroll/tax-filings/{id}`。
- MCP Prompt：`payroll_tax_filing_review_guide`。

REST 与 MCP 复用同一个 `PayrollTaxFilingService.getStatus` 应用服务，只返回状态、版本、控制总额、摘要和证据标识。MCP 服务不直接访问 Mongo、不持有外部 Token，也不注册税务制备、强认证审批或提交 Tool；AI 只能解释和核对控制摘要。
