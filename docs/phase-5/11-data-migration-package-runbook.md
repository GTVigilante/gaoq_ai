# Phase 5 数据迁移来源包运行手册

## 固定格式

每个来源包是一个独立目录，只允许两个文件：`manifest.json` 与 `records.ndjson`。`manifest.json` 固定字段如下：

```json
{
  "formatVersion": 1,
  "sourceSystem": "legacy-hr",
  "sourceRunId": "full-20260722-001",
  "mode": "full",
  "scope": "org_reference",
  "expectedSourceCount": 1,
  "expectedSourceChecksum": "base64url-sha256"
}
```

`records.ndjson` 每行是一条完整 JSON 记录，字段与迁移记录 REST 契约一致。禁止空行、额外字段和超过 8 MiB 的单行；该上限与 API JSON 入口一致。序号必须从 1 连续递增。来源生成器必须先计算 payload 摘要，再按控制面契约计算 `sourceFactHash` 与滚动校验和。来源包不得纳入 Git，必须位于受控迁移工作区并执行保留期与销毁策略。

当前 Scope 的执行顺序固定为 `org_reference` → `org_workforce` → 身份开户核对 → `org_employment` → 三个审批 Scope → 五个招聘 Scope → `attendance_source_facts` → `attendance_corrections` → `attendance_monthly_snapshots` → `payroll_rule_packs` → `payroll_compensation_profiles` → `payroll_periods` → `payroll_calculation_runs` → `payroll_period_approvals` → `payroll_period_locks` → `payroll_tax_filings` → `treasury_bank_accounts` → `treasury_disbursement_batches` → `treasury_bank_returns` → `payroll_reconciliations` → `business_attachments`。每个 Scope 使用独立来源包、`sourceRunId`、控制总数和签署证据。薪资规则、薪酬档案、资金账户和代发导出必须引用各自专用的 approved 审批历史；薪酬档案按法域/员工及版本排序，资金账户按主体及版本排序。审批实例及各业务实体必须为每条记录提供一份 checksum 精确一致的 WORM 证据附件。禁止把多个 Scope 混入同一包。

`payroll_reconciliations` 必须紧接 `treasury_bank_returns` 执行；`business_attachments` 在全部归属实体和员工映射完成后最后执行。两者都使用独立来源包、`sourceRunId` 和签署证据，禁止与其他 Scope 合包。

`recruitment_candidates` 包含 L3 直接身份，必须在受控迁移工作区静态加密，读权限只授予迁移服务与双人复核角色，apply 完成后按批准保留期销毁。CLI、服务日志和证据导出不得输出 payload；候选人明文不得进入命令行参数、Git、工单、聊天或 MCP 上下文。

`recruitment_interviews` 包含 L3 面试地点、会议链接和评价原文，执行与销毁要求等同候选人包。每条记录必须预检申请/员工引用、唯一面试官与唯一评价人、严格时间顺序、`version = 1 + 评价数 + 终态动作数`、完成态评价齐备，以及唯一 WORM 附件；日志、迁移报告、审计、工单和 MCP 不得输出 L3 payload。

`recruitment_offers` 包含 L4 薪酬、福利和工作地点条款，来源包必须使用独立密钥静态加密，解密只发生在隔离迁移执行区；日志、错误、迁移账本、证据导出、工单和 MCP 均不得输出条款。每条记录必须预检申请/已完成面试/创建员工/审批引用、Offer 状态与版本、发送/决定/eSign 摘要链、申请后续阶段回放，以及唯一 WORM 附件。目标端只保存 AES-256-GCM 条款密文、不可变摘要和 WORM 引用，不生成普通审批、投递、候选人决定、签署或申请阶段副作用。

`attendance_source_facts` 包含 L4 发生时间、时区和分钟影响。包内外部事件标识仅用于生成目标盲索引，不得进入日志、账本、证据导出、工单或 MCP。每条记录必须预检员工映射、严格历史时间线、IANA 时区、分钟上限及唯一 WORM 附件；目标端只写加密事实和 `attendance.source_fact.migrated`，不触发 Provider 回执、考勤修订或月结。

`attendance_corrections` 包含 L4 替换分钟和原因码。每条记录必须引用已迁移员工、源事实和 `attendance_correction` approved 历史，并提交该审批历史已登记的 WORM checksum 与独立修订 WORM；批准时间从审批历史派生，员工和业务日期从源事实派生。目标端只写加密修订和 `attendance.correction.migrated`，不创建审批、通知或月结重开。

`attendance_monthly_snapshots` 必须按员工、月份、版本升序排列。来源只提交规则版本、严格 UTC 截止/关账时间、四项分钟控制总量、事实/修订计数、前序与重开审批来源引用及独立 WORM；不得提交目标逐日明细或目标哈希。目标端重新查询截止时间内的事实和修订、重算并核对控制总量，v2+ 精确校验直接前序和 `attendance_month_reopen` approved 历史后才激活新版本。

`payroll_rule_packs` 只提交固定税率结构、法规来源摘要/引用、版本、生效区间、`payroll_rule_pack` approved 历史及 WORM；目标重新执行确定性计算内核的规则校验。`payroll_compensation_profiles` 包含 L4 金额与扣缴策略，来源包必须独立加密；目标只保存 AES-256-GCM 密文和控制摘要，并核验员工映射、`payroll_compensation` approved 历史、连续版本、不重叠区间和唯一 WORM。

`payroll_periods` 只提交月份、`draft|collecting`、制单员工来源引用、创建/更新时间和唯一 WORM。不得提交目标 actorId、运行摘要、审批、锁定、支付或对账状态。`payroll_calculation_runs` 必须按税年、月份、运行序号升序，且 `expectedPeriodVersion = runNumber + 1`；每条记录引用一个已迁移周期、一个生效规则包，以及每位员工对应的已迁移员工、薪酬档案和 active 考勤月结。运行 1 把周期从 collecting 推到 review；运行 2+ 只有在前次迁移运行的 WORM、活动引用和控制摘要全部一致时才允许 review 重算。来源提交员工行应发/税额/实发及期间控制汇总，目标重新计算并逐项核对；前月尚未迁移锁定时，只能继承运行 WORM 与周期摘要一致的目标重算结果。该包包含 L4 工资控制金额，必须在隔离区静态加密；不得包含目标哈希、计算步骤、累计税状态、银行卡、身份证件或密钥。单条最多 5,000 名员工、20,000 个去重来源关联，并受 API 8 MiB 请求上限约束；容量演练必须覆盖最大实际工资人数。

`payroll_period_approvals` 只提交已迁移周期、`payroll_period_approval` approved 历史、审批历史 checksum、审批员工来源引用、期望周期版本和独立批准控制 WORM。`expectedPeriodVersion` 必须精确指向 review 周期；目标恢复后版本增加 2。`payroll_period_locks` 随后提交周期、前述批准控制来源引用、独立锁定员工、严格 UTC 锁定时间、固定 `webauthn_uv` 方法和独立锁定 WORM；目标恢复后版本增加 1。两个包均为 L4，必须严格保持制单、审批、锁定三人分离；禁止提交 actorId、在线审批实例、WebAuthn credential/challenge、银行卡、金额或认证正文。进行中的历史工资审批禁止进入这两个终态包，必须在切换前清理或上线后按在线审批重新发起。

`payroll_tax_filings` 只提交已锁定周期、活动计算运行、税务制备/审批员工、`payroll_tax_filing_approval` approved 历史及 checksum、员工数/应税总额/税额控制量、税局提交回执标识、提交时间和唯一 WORM。该包为 L4；目标端从既有工资计算密文和组织身份凭证重新生成并加密内部清单，控制量完全一致后才恢复 submitted v4。不得提交税务行、身份证件、actorId、在线 WebAuthn 记录、对象正文、来源凭据或目标 contentHash；迁移不得调用归档或税局网关。

`treasury_bank_accounts` 为 L4，必须按主体与版本升序提交账户类型、员工来源引用（组织账户为 `null`）、户名、账号、清算行号、币种、版本/状态、`treasury_bank_account_attestation` approved 历史及 checksum、创建/撤销时间和唯一 WORM。来源包必须在隔离区静态加密，账号不得进入日志、命令行、账本、事件、工单或 MCP。目标端从可信租户派生组织主体，将员工来源映射为 ERP ID，重新生成盲索引并加密保存；只恢复历史事实，不调用账户连接器或伪造在线鉴证。

`treasury_disbursement_batches` 为 L4，只接收已提交且尚未回盘的常规首批。每条记录提交工资周期/运行、组织付款账户、制备与导出批准员工、`treasury_disbursement_export_approval` approved 历史及 checksum、执行日、逐员工收款账户与期望实发控制量、行数/总额、银行提交回执引用、制备/提交时间和唯一 WORM。目标重新读取锁定工资、核验三岗分离和账户历史有效期，以目标 ID/密文账户确定性重建支付指令及 pain.001；目标 `fileHash` 是重建文件摘要，来源银行文件由 WORM 独立保真。不得提交账号明文快照、目标文件 hash、文件正文、actorId 或租户。迁移不调用 WORM/银行网关。任何已回盘、部分成功、冻结、补发或恢复链必须先闭环或经批准归档，不得进入本 Scope。

`treasury_bank_returns` 为 L4，只接收前述常规批次的首份全量成功回盘。每条记录提交批次来源引用、批次 v4、银行提交回执引用、逐员工期望金额与唯一银行行引用、行数/总额、严格 UTC 接收时间和唯一 WORM。目标按员工映射定位密文指令，重建加密回盘清单和目标摘要，并将批次恢复为 reconciling v5；不调用 Inbox。失败行、未知/重复/金额错位、签名/扫描失败、冻结、部分成功、补发或恢复链禁止进入本 Scope。

`payroll_reconciliations` 为 L4，只接收前述锁定工资、已提交个税、常规代发批次和全量成功回盘形成的已平衡四方对账。每条记录仅提交四个来源引用、周期 v6/批次 v5、严格 UTC 对账时间与唯一 WORM；目标重算人数、工资/个税/代发/回盘金额、引用和摘要。对账员工须映射到有效 ERP 身份，与锁定/制备/导出批准三岗分离。任一差异、非常规首批、非迁移链路、时间倒置或证据不一致均失败关闭；不调用银行、税局、WORM 或 MCP 写工具。

`business_attachments` 为 L4。归属/用途固定为审批实例/审批附件、审批历史/历史附件、候选人/简历、申请/申请附件、面试/面试附件、Offer/Offer 附件、劳动关系/劳动关系文件；每条记录只提交归属来源 ID、可选上传员工来源 ID、用途、严格 UTC 历史创建时间、checksum 与唯一附件。禁止提交附件正文、原文件名、MIME、来源路径、对象地址、tenantId、actorId 或来源凭据。目标先登记不可用元数据，隔离网关完成拉取、checksum、恶意文件扫描与 WORM 归档后，再由应用服务事务性激活并发布专用迁移事件；未解析归属/员工、回执缺失或校验不一致均阻断 Scope 完成。

## 离线预检

```bash
pnpm --filter @gaoq/erp-api build
pnpm --filter @gaoq/erp-api migration:package -- validate /secure/path/to/package
```

预检会完整流式读取 NDJSON，核对 JSON 结构、连续序号、来源记录唯一性、payload SHA-256、Scope、总数与滚动校验和。任何失败都发生在调用 ERP 之前；输出只包含 Scope、来源运行 ID、记录数和校验和，不输出 payload、姓名或附件内容。

## 应用与断点续传

```bash
export ERP_API_BASE_URL=https://erp.example.com/api
export ERP_MIGRATION_TOKEN=从受控密钥系统短期签发的服务令牌
pnpm --filter @gaoq/erp-api migration:package -- apply /secure/path/to/package
unset ERP_MIGRATION_TOKEN
```

令牌必须绑定可信租户、`service|system_job` 身份以及 `erp:migration:execute`、当前目标域写权限（组织沿用 `erp:org:master:write`；审批、招聘、考勤、薪资和资金使用各自 `*:migration:write` Scope）、`erp:migration:attachment:execute` Scope。工具不接受命令行 Token，避免进入 shell history；除 `localhost`/`127.0.0.1` 外只允许 HTTPS。每次 apply 都先完整预检，然后幂等创建来源运行；服务端返回的 checkpoint 决定续传起点，已确认序号不会再次发送。全部记录处理后请求附件搬运并轮询聚合报告，未决附件归零后才调用 complete；默认等待 1800 秒，可通过 `ERP_MIGRATION_ATTACHMENT_WAIT_SECONDS` 设置 10–86400 秒。

`payroll_reconciliations` 令牌必须同时授予 `erp:payroll:migration:write` 和 `erp:treasury:migration:write`；只具备其中一项时，创建运行和 apply 都必须拒绝。

`business_attachments` 令牌必须额外授予 `erp:document:migration:write`；附件搬运仍单独校验 `erp:migration:attachment:execute`，禁止由普通用户或 MCP 代理代执行。

## 操作门禁

- 生产 apply 前必须完成来源包双人校验、恶意文件扫描、备份、变更单和演练编号登记。
- 任何 `rejected`、未解析关联、未决/拒绝附件、来源总数或校验和差异都禁止进入 Phase 6。
- 工具不会替代领域校验，也不会直接连接 MongoDB；所有目标写入仍由 REST 进入应用服务。
- 网络超时或进程中断后使用同一来源包重跑 apply；禁止修改原包后复用 `sourceRunId`。
- 当前实现会在预检期间维护来源记录 ID 集合；超大数据包必须按已批准 Scope 和容量演练结果拆分，不得绕过服务端总控制量。

附件网关通过 `DATA_MIGRATION_ATTACHMENT_GATEWAY_ENDPOINT` 与 `DATA_MIGRATION_ATTACHMENT_GATEWAY_BEARER_TOKEN` 成套配置，必须位于 ERP 授权域之外的标准 HTTPS 权限域。网关负责来源凭据、正文拉取、扫描与 WORM 归档；ERP 只发送来源标识、预期 checksum、由服务端 Scope 固定映射的 `L3|L4` 分级和不少于 2555 天的保留期。`recruitment_offers`、三个考勤 Scope、`payroll_compensation_profiles`、`payroll_calculation_runs`、`payroll_period_approvals`、`payroll_period_locks`、`payroll_tax_filings`、`payroll_reconciliations`、`business_attachments`、三个 Treasury Scope 强制为 L4；`payroll_rule_packs` 与 `payroll_periods` 为 L3。来源包和客户端不能提交或降低分级。

成功响应固定为无压缩、最大 16 KiB 的严格 JSON 对象：
`schemaVersion=erp-data-migration-attachment-receipt.v1`，并逐项返回
`tenantId`、`runId`、`sourceSystem`、`sourceAttachmentId`、
`targetEvidenceId`、`malwareScanEvidenceId`、`checksum`、
`immutable=true`、`malwareClean=true`、`retentionDays` 和
`classification`。前四项与请求上下文、checksum、分级必须完全一致，回执保留期
不得低于请求；任何额外字段、上下文错位、非 JSON、非法 UTF-8、非规范或超限
Content-Length 均视为无效回执。非 2xx 只按状态码分类，不读取上游正文。

## 完整差异证据导出

```bash
export ERP_API_BASE_URL=https://erp.example.com/api
export ERP_MIGRATION_TOKEN=从受控密钥系统短期签发的证据导出令牌
pnpm --filter @gaoq/erp-api migration:package -- evidence 01J8ZQK7V0A2M4N6P8R0T2W4F1 > migration-evidence.ndjson
unset ERP_MIGRATION_TOKEN
```

证据令牌必须额外具备 `erp:migration:evidence:export`，且运行必须已经 `completed|failed` 冻结。证据 NDJSON 每行固定携带 `formatVersion: 1`；工具先写入聚合 report，再依次分页写入 items、associations、attachments，逐页验证服务端 `pageChecksum`；三类明细总数必须与 report 控制量完全一致，最后一行 seal 才保存三类记录数、总记录数和整份内容的滚动 `artifactChecksum`。证据不含 payload、姓名、附件正文、tenantId、Token 或时间戳，但来源与目标标识仍按 L2 处理，产物必须加密保存、限制访问并登记销毁时间。

任何页面 checksum 错误、游标异常、网络失败或非 JSON 响应都会终止导出且不生成可信完成结论。只有存在 seal 且重新计算结果一致的文件才能进入迁移签署材料；MCP 不提供此详细导出能力。

三次全量演练完成后，必须按[数据迁移三次演练证据门禁](./12-data-migration-rehearsal-gate.md)比较三份独立证据。比较命令只接受恰好三个文件，并强制逐份验封、零差异和目标事实一致；它不代替真实环境演练及四方签署。
