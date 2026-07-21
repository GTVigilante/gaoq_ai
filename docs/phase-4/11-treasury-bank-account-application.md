# Treasury 银行账户版本应用契约

## 入口与信任边界

- `POST /treasury/bank-accounts/attest` 只接受拥有 `erp:treasury:account:attest` 的 `service` 或 `system_job` 主体；普通用户即使持有同名 Scope 也被拒绝。
- 请求必须带 `Idempotency-Key` 和外部审批证据 ULID。员工账户必须引用 ERP 中未终止的员工；组织付款账户的 ownerId 必须等于可信租户 ID，禁止客户端选择其他租户。
- 该入口风险等级为 R3，但它只落地已审批结果，不替代审批流程。MCP 不注册账户登记、查询、解密、导出或变更工具。

## 数据最小化

- 户名经 NFKC 规范化并拒绝控制/双向格式字符；账号、清算行号和币种严格白名单。
- 户名、账号、清算行号和币种整体进入 Treasury 独立 AES-256-GCM 密文；AAD 绑定租户、账户 ID 和版本。
- 精确防重只使用 Treasury 独立 HMAC 盲索引。数据库、响应、Outbox、审计和日志均不得出现账号、户名、盲索引、密文或稳定明文摘要。
- 同一租户的活动账号不得绑定两个主体；同一主体的新版本在同一事务中撤销旧活动版本，再创建新版本并保留替代引用。

## 契约输出

- REST 仅返回账户 ID、ownerType、ownerId、版本和活动状态。
- 事件 `cn.gaoq.erp.treasury.bank_account.attested.v1` 只允许 ownerType、ownerId、version、status 四个数据字段，Writer 运行时执行精确白名单校验。
- 审计事件 `treasury.bank_account.attest` 只记录上述非账户元数据，风险等级 R3。
