# 个税申报清单、独立审批与税务网关

> Phase 4 安全门禁：`PAYROLL_TAX_GATEWAY_MODE` 默认并必须保持 `sandbox`。沙箱请求与回执必须双向绑定 `submissionMode=sandbox`，外部网关必须使用税务沙箱租户与沙箱凭据。Phase 6 的 `production` 模式仍要求独立授权域逐清单绑定租户、摘要、版本、发布 commit 和部署清单，并由税务网关回显授权 WORM 证据；缺少任一项时应用服务与 HTTP Adapter 双重失败关闭。两个工资影子周期资格本身不足以授权真实申报。

> `PayrollTaxFilingService` 的历史申报导入、只读、制备、审批和提交均在完成可信
> 主体/Scope 与令牌主体绑定后调用共享 `LegacyPayrollBoundaryService`。
> 默认 `PAYROLL_SYSTEM_MODE=external` 时，在输入解释、幂等、强认证、Mongo、
> 加密、WORM、production 授权和税务网关前失败关闭；MCP 只读不能绕过。

## 责任边界

ERP 从锁定工资结果、有效劳动关系和 `Person.identityEvidenceId` 生成确定性的 `CN_IIT_WITHHOLDING_MANIFEST_V1` 内部清单。该清单是税务隔离网关的输入契约，不冒充任何地区税局官方格式；地区格式转换、证件明文解析、税局客户端和税局凭据只存在于受控税务网关权限域。

税务链路由三个独立权限域组成：ERP、Payroll Tax WORM 和税务提交网关。税务服务必须与 ERP、Treasury WORM、银行提交、银行回盘以及彼此使用不同的标准 HTTPS Origin 和独立 Bearer 凭据；URL 凭据、查询参数、fragment、重定向和非 443 端口全部失败关闭。

## 外部传输协议

- Payroll Tax WORM 固定使用 `POST /v1/objects`。请求正文只能是 8 MiB 内的
  `CN_IIT_WITHHOLDING_MANIFEST_V1` 规范 JSON；适配器在外呼前使用 fatal UTF-8
  与 JSON 解码重新绑定可信租户、申报 ULID、对象键和 SHA-256，不接受只匹配
  字符串前缀的“伪清单”。Header 固定声明 L4、`payroll_tax_filing` 保留策略、
  至少十年保留期、对象键、摘要、长度和确定性幂等键。
- 税务提交网关固定使用 `POST /v1/submissions`，正文不超过 4 KiB，只包含可信
  租户、申报 ULID、月份、WORM 引用、内容摘要、人数和控制总额。sandbox 禁止
  夹带 production 授权；production 授权标识与证据标识必须独立，剩余有效期必须
  大于 30 秒且不超过 15 分钟，并绑定发布 commit 和部署清单摘要。
- 两个出口都在运行时二次校验 32–512 字节可见 ASCII 独立凭据和精确路径，禁止
  调用方覆盖方法、路径或 Header。非 2xx 只按状态码失败关闭，禁止读取或保留
  上游错误正文。成功回执只接受规范 JSON Content-Type，先检查规范
  Content-Length，再执行 16 KiB 实际流式硬上限和 fatal UTF-8/JSON 解码；
  读取、取消和 releaseLock 异常只能收敛为本域稳定错误码。
- WORM 回执必须逐字段绑定对象键、摘要、不可变性与请求保留期；税务回执必须逐字段
  绑定原租户、申报、月份、对象、摘要、控制总额和提交模式。production 还必须
  回显同一授权、发布 commit 和部署清单摘要；提交标识与证据标识不得相同。

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

## 自动化证据与外部验收

`pnpm quality:payroll-tax-filing-coverage` 会先验证 29 项申报应用服务测试，再执行
`pnpm quality:payroll-tax-http-coverage` 的 131 项 WORM/税务网关协议测试。三个
HTTP 生产文件合计覆盖率为 99.35%/98.57%/100%/99.25%
（语句/分支/函数/行），归档适配器四维 100%，提交适配器为
98.14%/98.52%/100%/97.82%，共享读取器为 100%/96.66%/100%/100%；
三个文件均由逐文件四维 90% 门禁保护并已接入 `pnpm check`。
申报应用服务达到 98.90%/98.58%/100%/100%，其独立四维 90% 门禁同时通过。

这些自动化证据只证明仓库实现。真实税务沙箱租户、WORM Object Lock/法定保留与
回读证明、网关签名/限流、Secret 轮换、断连恢复、production 独立授权域和税务
业务 UAT 仍必须在目标环境留存证据，禁止用本地模拟回执替代。
