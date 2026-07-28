# Treasury 代发与回盘领域契约

本契约固化银行连接不可绕过的确定性文件、职责边界与状态机。应用持久化、独立密钥域、WORM、银行提交 Adapter 和回盘 Inbox 均已按该契约落地；完成影子周期、失败子批次和四方对账前仍不得生成生产文件。

## ISO 20022 pain.001

- 首发格式固定为 `ISO20022_PAIN_001_001_03`，币种只允许 CNY。
- 金额输入为安全整数分，使用 `bigint` 汇总，再格式化为两位小数；禁止浮点计算。
- 行按 `instructionId` 确定性排序，输出 UTF-8 XML 和 SHA-256 base64url 摘要。
- 强制校验 1..5000 行、正金额、账号格式、清算行号、指令唯一和批次内收款账号唯一。
- 人名/户名进行 NFKC 规范化，拒绝控制与双向格式字符，所有 XML 内容强制转义。
- 生成器会在内存中短暂接触账号；应用层必须立即加密或提交受控网关，禁止日志、事件、审计和 Mongo 明文字段。

## 代发状态机

```text
materializing → prepared → exported → submitting → submitted → reconciling
                                                        └────→ frozen
```

- 工资锁定人、代发制备人、导出批准人三方分离。
- `exported` 必须关联近期强认证与受控对象证据；`submitted` 只接受可信银行连接器回执。
- 银行回盘含恶意文件、签名失败、未知行、重复行、逐行金额错位、行数不守恒、金额不守恒或部分成功均进入 `frozen`。
- 全部成功也只能进入 `reconciling`，不得绕过个税与总账证据直接标记 `reconciled`。
- 冻结批次不得修改或重传原文件；补发/扣回必须创建引用原批次的新子批次并重新履行控制链。

## 当前实现与后续门禁

银行账号独立 AES-GCM/HMAC 盲索引、锁定工资到确定性文件、WORM、WebAuthn 三人分离批准、可信银行提交、隔离回盘 Inbox、恶意文件证据、ERP 逐行复核、乱序失败关闭、强认证失败行恢复子批次、税务申报和四方对账已经落地。冻结父批次永不原地解冻。生产连接前仍必须完成：银行/税务网关具体签名加密配置与联调，以及两个完整影子周期。MCP 只读取脱敏控制摘要，永不执行资金或税务动作。

`TREASURY_BANK_SUBMISSION_MODE` 默认且在 Phase 4 必须保持 `sandbox`。sandbox 请求与受理回执必须双向绑定并回显 `submissionMode=sandbox`，外部银行网关必须使用银行沙箱租户与沙箱凭据。Phase 6 的 `production` 模式仍要求独立授权域逐批次绑定租户、摘要、版本、发布 commit 和部署清单，并由银行网关回显授权 WORM 证据；缺少任一项时应用服务与 HTTP Adapter 双重失败关闭。仅有两个工资影子周期 `eligible` 证据不足以打开真实银行提交。

资金 WORM 适配器只允许标准 HTTPS `POST /v1/objects`，运行时复核独立凭据、
十年至一百年保留期、可信租户、批次 ULID 和确定性幂等域。pain.001 外呼前必须
完整绑定固定 Schema、唯一 MsgId/PmtInfId、对象键与摘要，并拒绝
DOCTYPE/ENTITY。非 2xx 不读取正文；成功回执执行严格 JSON、Content-Length、
16 KiB 流式上限及租户/批次/对象/摘要/保留期反向绑定。98 项专项测试达到
100%/97.77%/100%/100%（语句/分支/函数/行），独立门禁已接入资金支付总门禁。
MCP 不得归档、读取或返回资金文件与 WORM 地址。

银行提交适配器只允许标准 HTTPS `POST /v1/submissions`，端点不得包含用户信息、
query、fragment、非 443 端口或其他路径；Authorization、Accept、Cache-Control、
Content-Type、Content-Length 与 Idempotency-Key 均由适配器固定生成，业务输入、
REST、事件或 MCP 不得覆盖。请求只含 WORM 对象引用、Base64URL 文件摘要、行数、
整数分控制总额及受控模式；production 额外携带一次性短时授权引用、发布 commit
和部署清单摘要，禁止银行账号、文件正文或银行凭据进入请求。

非 2xx 只按 HTTP 状态码分类且禁止读取响应正文。成功回执声明长度与实际流式
读取均不得超过 16 KiB，必须为严格 UTF-8 和 `application/json` 或
`application/*+json`，并通过严格 Schema；批次、WORM 引用、文件摘要、行数、
总额、模式及 production 授权回显任一不一致均失败关闭。读取、取消和释放异常
不得携带上游 cause 或覆盖已确定结果。

仓库门禁 `pnpm quality:treasury-bank-submission-egress-coverage` 以 71 项测试覆盖
上述边界，目标生产文件达到 99.01%/96.70%/100%/98.87%
（语句/分支/函数/行），逐文件四维均不得低于 90%，并由资金支付门禁在
`pnpm check` 中联动执行。标准 MCP 继续只读脱敏控制摘要，禁止注册发薪、银行
提交、文件导出或生产授权 Tool。

回盘 Inbox 适配器只允许标准 HTTPS `POST /v1/returns/claim`，端点不得包含
用户信息、query、fragment、非 443 端口或其他路径；Authorization、Accept、
Cache-Control、Content-Type、Content-Length 与 Idempotency-Key 均由适配器
固定生成。请求只含可信租户、ULID 批次和银行提交 ID，禁止账户、员工、金额、
文件正文、Inbox 凭据或调用方 Header 进入请求。

非 2xx 回盘响应只按状态码分类且禁止读取正文。成功清单声明长度与实际流式读取
均不得超过 4 MiB，必须为严格 UTF-8 和 `application/json` 或
`application/*+json`，通过完整严格 Schema 并精确绑定领取租户、批次和银行
提交 ID；读取、取消或释放异常不得携带上游 cause 或覆盖稳定结果。验签失败、
恶意文件等负面证据必须原样进入应用服务的整批冻结状态机，不得由适配器丢弃。

仓库门禁 `pnpm quality:treasury-bank-return-ingress-coverage` 以 65 项测试覆盖
上述边界，目标生产文件达到 98.90%/96.15%/100%/98.70%
（语句/分支/函数/行），逐文件四维均不得低于 90%，并由银行回盘服务门禁在
`pnpm check` 中联动执行。标准 MCP 禁止领取、上传或处理银行回盘正文。
