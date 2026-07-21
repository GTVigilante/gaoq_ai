# 锁定工资到受控代发文件

## 模块边界

- Treasury 不直接读取 Payroll 集合或使用 Payroll 密钥。内部只读端口 `getLockedDisbursementSource` 仅对拥有 `erp:treasury:disbursement:prepare` 的上下文开放。
- Payroll 端口要求周期状态严格为 `locked`，并逐行验证 AES-GCM 密文、员工结果摘要，再复核运行级结果摘要、员工数和实发总额；任一不一致均不输出员工实发数据。
- `POST /treasury/disbursements` 只允许已验证人员执行，代发制备人不得是工资锁定人。请求只接受工资周期、预期版本、组织付款账户引用和执行日期，不接受客户端金额或员工行。

## 两阶段幂等编排

1. 第一事务创建 `materializing` 批次，分别冻结全量工资摘要与正实发行摘要，并冻结组织付款账户快照和所有正实发员工的账户/金额密文快照；零实发行不进入银行文件，也不破坏全量工资到银行文件子集的完整性证明。
2. 事务完成后，应用从密文快照确定性重建 pain.001，复核员工结果聚合摘要、行数和控制总额，再通过独立 HTTPS Adapter 写入 WORM。
3. WORM 回执必须同时证明对象键、SHA-256、不可变性和至少十年保留期。第二个幂等事务收到有效回执后，才将批次和支付指令转为 `prepared`。
4. 若进程或 WORM 在两阶段之间失败，数据库保留 `materializing`，重试复用同一批次、确定性文件和对象键；不得伪造 `prepared` 或生成另一批付款。

## 数据、安全与契约

- 组织/员工户名、账号、清算行号、员工实发金额和工资结果引用整体使用 Treasury AES-256-GCM；Mongo、响应、Outbox、审计和日志不得出现明文。
- WORM 文件仅在进程内存及 HTTPS 请求体中出现；发送完成后清零 Buffer，禁止写临时文件。
- 物化事件只有 `treasury.disbursement.materialization_requested.v1` 与 `treasury.disbursement.prepared.v1`，Writer 精确限制为批次汇总、文件摘要和 WORM 证据字段。
- REST 只返回批次 ID、工资引用、状态、版本、行数、总额、文件摘要和对象证据。该接口不导出文件、不提交银行；MCP 不注册制备、文件读取或资金写工具。

## 导出批准

- `POST /treasury/disbursements/:id/export-approval` 是 R3 人工动作，只接受拥有 `erp:treasury:disbursement:approve` 的已验证用户；WebAuthn 证据必须绑定当前访问令牌的租户、人员、会话及批次 ID。
- 批次必须为 `prepared` 且同时具有文件摘要、WORM 证据和对象引用。批准人必须与工资锁定人、代发制备人不同，乐观版本命中后才转为 `exported`。
- 事件只公开批次汇总、WORM 证据引用和 `webauthn_uv` 方法；不得公开批准人、凭据或强认证证据详情。批准不返回文件内容，也不等于提交银行。

## 银行提交

- `POST /treasury/disbursements/:id/submission` 只允许拥有 `erp:treasury:disbursement:submit` 的受信任 `service` 或 `system_job` 调用；普通用户即使持有同名 Scope 也被拒绝，MCP 永不注册。
- 独立银行网关只接收批次 ID、WORM 对象引用、文件摘要、行数与控制总额；ERP 不回读或重传银行文件，银行凭据仅存在于网关权限域。
- 网关以确定性幂等键提交。回执必须为 `accepted=true`，并反向绑定批次、对象引用、摘要、行数与总额；错批、错文件、未受理、超大或非 JSON 回执全部失败关闭。
- 有效回执之后，第二阶段事务才以乐观版本把批次及全部支付指令转为 `submitted`，同时保存提交 ID、证据 ID 和白名单事件。网关失败或回执非法只保留可恢复的 `submitting` 暂存状态，绝不伪造 `submitted`。
