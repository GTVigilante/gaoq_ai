# Treasury 银行账户版本应用契约

## 入口与信任边界

- `POST /treasury/bank-accounts/attest` 只接受拥有 `erp:treasury:account:attest` 的 `service` 或 `system_job` 主体；普通用户即使持有同名 Scope 也被拒绝。
- 请求必须带 `Idempotency-Key` 和外部审批证据 ULID。员工账户必须引用 ERP 中未终止的员工；组织付款账户的 ownerId 必须等于可信租户 ID，禁止客户端选择其他租户。
- 该入口风险等级为 R3，但它只落地已审批结果，不替代审批流程。MCP 不注册账户登记、查询、解密、导出或变更工具。
- `PAYROLL_SYSTEM_MODE=external` 时，在线登记与迁移导入均在读取审批、员工、
  Mongo、盲索引或加密服务前返回
  `PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM`。REST Guard 与应用服务复用同一个
  `LegacyPayrollBoundaryService`；Worker、迁移或内部调用不得绕过。

## 审批与事务闭包

- 在线登记只接受 `treasury_bank_account_attestation` 模板的 `approved` 完成
  实例。最终 `approved` 决定时间必须等于实例完成时间，且审批表单的
  `owner_type`、`owner_id`、`account_name`、`account`、`clearing_code` 和
  `currency` 必须逐项等于规范化后的登记内容。
- Treasury 只通过 `ApprovalApplicationService` 在调用方同一 Mongo Session
  内取得冻结最小投影；不直接读取审批集合，也不接受客户端声明审批终态或审批人。
- 在线登记和历史迁移都要求活动 Mongo 事务。既有账户、活动重复记录、最新版本、
  加密信封、盲索引集合和数据库创建回执在继续副作用前执行运行时反向绑定；损坏
  投影、版本上溢、CAS 冲突和不闭合回执失败关闭。
- 历史迁移仅接受可信 `service|system_job` 的
  `erp:migration:execute + erp:treasury:migration:write`，并绑定专用历史审批、
  证据摘要、规范历史 UTC 时间、连续版本及不可变迁移附件引用。目标重放必须解密
  后逐字段等于原始迁移事实，禁止覆盖。

## 数据最小化

- 户名经 NFKC 规范化并拒绝控制/双向格式字符；账号、清算行号和币种严格白名单。
- 户名、账号、清算行号和币种整体进入 Treasury 独立 AES-256-GCM 密文；AAD 绑定租户、账户 ID 和版本。
- 精确防重只使用 Treasury 独立 HMAC 盲索引。数据库、响应、Outbox、审计和日志均不得出现账号、户名、盲索引、密文或稳定明文摘要。
- 同一租户的活动账号不得绑定两个主体；同一主体的新版本在同一事务中撤销旧活动版本，再创建新版本并保留替代引用。
- 加密服务返回的 Key ID、IV、AuthTag、密文编码和长度，以及 1–8 个互异盲索引
  均在落库前二次校验；持久化返回必须逐字段等于待写记录后才允许发布 Outbox。

## 契约输出

- REST 仅返回账户 ID、ownerType、ownerId、版本和活动状态。
- 事件 `cn.gaoq.erp.treasury.bank_account.attested.v1` 只允许 ownerType、ownerId、version、status 四个数据字段，Writer 运行时执行精确白名单校验。
- 审计事件 `treasury.bank_account.attest` 只记录上述非账户元数据，风险等级 R3。
- 74 项资金账户专项测试达到
  94.55%/93.56%/100%/96.12%（语句/分支/函数/行），目标生产文件逐文件
  四维 90% 门禁由 `pnpm quality:treasury-bank-account-coverage` 接入资金支付
  总门禁和 `pnpm check`。审批应用服务门禁继续四维不低于 90%，共享模式边界
  服务与 Guard 四维 100%。
- 本证据只关闭银行账户纵向切片的仓库实现缺口，不替代专业算薪、真实银行、
  历史审批数据、Mongo Replica Set 迁移演练和财务 UAT。
