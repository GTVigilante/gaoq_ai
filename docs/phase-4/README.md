# Phase 4：考勤、薪酬、薪税与发放对账

Phase 4 在 ERP 组织与劳动关系主数据之上，建立可重放的考勤月结、确定性薪资计算、审批锁定、银行/税务文件和四方对账闭环。旧系统在两个完整影子周期验收完成前仍是生产发薪事实源。

> 2026-07-27 架构边界更新：上述 Payroll/Treasury 实现作为专业算薪系统迁移基线；
> 正式工资写模型由独立专业算薪系统承载。ERP 保留统一身份、组织主数据、门户和
> 脱敏控制摘要，具体边界以 `docs/phase-0/07-payroll-system-boundary.md` 为准。
> ERP 与专业算薪的七类共享事件已统一为
> `cn.gaoq.<域>.<实体>.<动作>.v1`，并由
> `@gaoq/platform-contracts@1.0.0` 的逐类型运行时验证器和 JSON Schema
> 共同锁定；旧 `com.gaoq.*` 名称仅有一个发布迭代的显式迁移窗口。
>
> 2026-07-29 已闭合旧本人薪资单的 REST/MCP 模式边界：默认
> `PAYROLL_SYSTEM_MODE=external` 时，共享应用服务在身份映射、Mongo 和解密前
> 统一返回 410，MCP 不再绕过 REST 守卫读取 ERP 旧工资数据。legacy 路径对周期、
> 员工行、密文信封、严格解密 Schema 和确定性摘要执行运行时反向绑定，并由
> 独立逐文件四维 90% 门禁约束。专业算薪的 OAuth/MCP 真实联调仍待现场验收。

实现顺序：

1. [领域、金额、安全、集成与 MCP 强制契约](./00-payroll-attendance-contract.md)
2. [考勤原始事实、人工修订审批和不可变月结快照](./01-attendance-implementation.md)
3. [Attendance 索引迁移 Runbook](./02-attendance-index-migration-runbook.md)
4. [钉钉/飞书考勤 Provider 加密补拉与标准化](./03-attendance-provider-integration.md)
5. [Attendance Provider 独立索引迁移 Runbook](./04-attendance-provider-index-migration-runbook.md)
6. [薪酬结构、法定规则、权威输入快照与确定性运行](./05-payroll-core-implementation.md)
7. [Payroll Core 索引迁移 Runbook](./06-payroll-core-index-migration-runbook.md)
8. [财务审批与 WebAuthn 双人锁定](./07-payroll-approval-locking.md)
9. [员工本人薪资单、字段级权限与 MCP](./08-payroll-payslip-mcp.md)
10. [Treasury ISO 20022 代发与回盘冻结契约](./09-treasury-disbursement-contract.md)
11. [Treasury 密钥与索引迁移 Runbook](./10-treasury-key-index-migration-runbook.md)
12. [Treasury 银行账户版本应用契约](./11-treasury-bank-account-application.md)
13. [锁定工资到受控代发文件](./12-treasury-disbursement-materialization.md)
14. [隔离银行回盘、逐行复核与异常冻结](./13-treasury-bank-return-inbox.md)
15. [个税申报清单、独立审批与税务网关](./14-payroll-tax-filing.md)
16. [Payroll Tax 索引迁移 Runbook](./15-payroll-tax-index-migration-runbook.md)
17. [工资、代发、回盘与个税四方对账](./16-payroll-four-way-reconciliation.md)
18. [Payroll 四方对账索引迁移 Runbook](./17-payroll-reconciliation-index-migration-runbook.md)
19. [两个完整工资影子周期、差异归因与财务签署](./18-payroll-shadow-cycles.md)
20. [Payroll 影子周期索引迁移 Runbook](./19-payroll-shadow-index-migration-runbook.md)
21. [Attendance 规则、排班与覆盖证明索引迁移 Runbook](./20-attendance-rules-index-migration-runbook.md)

Treasury 银行提交出站边界已固定标准 HTTPS `POST /v1/submissions`、独立凭据、
短时生产授权、确定性幂等、16 KiB 严格 UTF-8/JSON 回执及批次控制量精确绑定。
71 项专项测试达到 99.01%/96.70%/100%/98.87%（语句/分支/函数/行），目标
生产文件逐文件四维 90% 门禁已由资金支付门禁接入 `pnpm check`；真实银行
签名加密、沙箱联调、限流和生产授权域仍待现场验收。

Treasury WORM 证据出口已固定标准 HTTPS `POST /v1/objects`、独立凭据、
十年至一百年保留期和确定性幂等域；外呼前严格绑定租户、批次 ULID、pain.001
固定 Schema、唯一 MsgId/PmtInfId、对象键与摘要，并禁用 DOCTYPE/ENTITY。
非 2xx 不读取正文；成功回执执行严格 JSON、Content-Length、16 KiB 流式硬
上限及租户/批次/对象/摘要/保留期反向绑定。98 项专项测试达到
100%/97.77%/100%/100%（语句/分支/函数/行），独立逐文件四维 90% 门禁已由
资金支付总门禁接入 `pnpm check`；真实 WORM Object Lock、保留证明、Secret
轮换、断连和限流仍待现场验收。

Treasury 银行回盘 Inbox 入站边界已固定标准 HTTPS
`POST /v1/returns/claim`、独立凭据、最小领取请求、确定性幂等、非 2xx 正文
隔离、4 MiB Content-Length/流式双重限长、严格 UTF-8/JSON 清单及领取对象精确
绑定；验签失败和恶意文件负面证据保留给应用服务整批冻结。65 项专项测试达到
98.90%/96.15%/100%/98.70%（语句/分支/函数/行），目标生产文件逐文件四维
90% 门禁已由回盘服务门禁接入 `pnpm check`；真实银行签名、恶意样本、WORM、
限流和断连联调仍待现场验收。

Payroll Tax 双出口已固定标准 HTTPS `POST /v1/objects` 与
`POST /v1/submissions`、相互隔离的运行时凭据、确定性幂等和最小税务提交；
WORM 正文在外呼前严格绑定租户、申报 ULID、对象键与摘要，production 税务提交
二次校验 30 秒至 15 分钟短时独立授权。成功回执执行 16 KiB
Content-Length/流式双重限长、严格 UTF-8/JSON、完整 Schema 与请求事实绑定，
非 2xx 不读取正文。131 项专项测试达到 99.35%/98.57%/100%/99.25%
（语句/分支/函数/行），三个生产文件逐文件四维 90% 门禁已由个税申报门禁接入
`pnpm check`；真实税务沙箱、WORM 保留证明、限流、Secret 轮换与生产授权域
仍待现场验收。

## 强制边界

- ERP Org 的 `Person / Employee / Employment` 是人员、组织归属和劳动关系唯一主数据源；考勤平台和银行不得反写组织事实。
- 金额使用整数分；比率使用整数基点或规则明确的有理数。禁止 JavaScript 浮点参与工资、税、社保、公积金或对账计算。
- 原始考勤、计算输入快照、规则版本、步骤账、审批、锁定、代发和回盘均不可静默覆盖；纠错创建新版本或关联调整批次。
- 银行账号、证件、薪资明细和税务文件为 L4；列表、事件、日志、审计和 MCP 不返回原文。
- MCP 不注册直接发薪、锁定、改规则、批量导出或上传银行回盘 Tool。本人查询为 R0，受控分析为聚合输出，处理请求最多形成待审批意图。
- 未完成两个影子周期且未解释差异不为零时，不得切换工资事实源或发起真实代发。
