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

`records.ndjson` 每行是一条完整 JSON 记录，字段与迁移记录 REST 契约一致。禁止空行、额外字段和超过 10 MiB 的单行；序号必须从 1 连续递增。来源生成器必须先计算 payload 摘要，再按控制面契约计算 `sourceFactHash` 与滚动校验和。来源包不得纳入 Git，必须位于受控迁移工作区并执行保留期与销毁策略。

当前 Scope 的执行顺序固定为 `org_reference` → `org_workforce` → 身份开户核对 → `org_employment` → `approval_templates` → `approval_history` → `approval_active_instances` → `recruitment_reference` → `recruitment_candidates` → `recruitment_applications` → `recruitment_interviews` → `recruitment_offers` → `attendance_source_facts` → `attendance_corrections`。每个 Scope 使用独立来源包、`sourceRunId`、控制总数和签署证据；劳动关系、审批模板、两类审批实例、招聘参考、面试、Offer 与考勤包内的员工来源引用必须能在同一 `sourceSystem` 的员工映射中解析，审批责任员工、历史发起员工、HC 创建员工、草稿所有者、运行态当前待办人与 Offer 创建员工还必须已绑定 ERP 身份，草稿所有者和运行态当前待办人必须为 active。审批实例必须同时引用已经迁移的来源模板记录；HC 必须引用已迁移部门和与状态一致的活动审批/终结历史，职位必须引用包内更早导入的 HC、已迁移部门与职级；申请必须引用已迁移候选人和职位；面试必须引用已迁移申请、创建员工和全部面试官；Offer 必须引用已迁移申请、该申请已完成面试、创建员工及与状态匹配的运行中审批或终结历史；考勤事实必须引用已迁移员工；考勤修订必须同时引用已迁移员工、源事实和已通过专用审批历史。审批实例及各业务实体必须为每条记录提供一份 checksum 精确一致的 WORM 证据附件。禁止把多个 Scope 混入同一包。

`recruitment_candidates` 包含 L3 直接身份，必须在受控迁移工作区静态加密，读权限只授予迁移服务与双人复核角色，apply 完成后按批准保留期销毁。CLI、服务日志和证据导出不得输出 payload；候选人明文不得进入命令行参数、Git、工单、聊天或 MCP 上下文。

`recruitment_interviews` 包含 L3 面试地点、会议链接和评价原文，执行与销毁要求等同候选人包。每条记录必须预检申请/员工引用、唯一面试官与唯一评价人、严格时间顺序、`version = 1 + 评价数 + 终态动作数`、完成态评价齐备，以及唯一 WORM 附件；日志、迁移报告、审计、工单和 MCP 不得输出 L3 payload。

`recruitment_offers` 包含 L4 薪酬、福利和工作地点条款，来源包必须使用独立密钥静态加密，解密只发生在隔离迁移执行区；日志、错误、迁移账本、证据导出、工单和 MCP 均不得输出条款。每条记录必须预检申请/已完成面试/创建员工/审批引用、Offer 状态与版本、发送/决定/eSign 摘要链、申请后续阶段回放，以及唯一 WORM 附件。目标端只保存 AES-256-GCM 条款密文、不可变摘要和 WORM 引用，不生成普通审批、投递、候选人决定、签署或申请阶段副作用。

`attendance_source_facts` 包含 L4 发生时间、时区和分钟影响。包内外部事件标识仅用于生成目标盲索引，不得进入日志、账本、证据导出、工单或 MCP。每条记录必须预检员工映射、严格历史时间线、IANA 时区、分钟上限及唯一 WORM 附件；目标端只写加密事实和 `attendance.source_fact.migrated`，不触发 Provider 回执、考勤修订或月结。

`attendance_corrections` 包含 L4 替换分钟和原因码。每条记录必须引用已迁移员工、源事实和 `attendance_correction` approved 历史，并提交该审批历史已登记的 WORM checksum 与独立修订 WORM；批准时间从审批历史派生，员工和业务日期从源事实派生。目标端只写加密修订和 `attendance.correction.migrated`，不创建审批、通知或月结重开。

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

令牌必须绑定可信租户、`service|system_job` 身份以及 `erp:migration:execute`、当前目标域写权限（组织三个 Scope 为 `erp:org:master:write`，审批模板及两类审批实例为 `erp:approval:migration:write`，招聘参考、候选人、申请、面试与 Offer Scope 为 `erp:recruitment:migration:write`，考勤 Scope 为 `erp:attendance:migration:write`）、`erp:migration:attachment:execute` Scope。工具不接受命令行 Token，避免进入 shell history；除 `localhost`/`127.0.0.1` 外只允许 HTTPS。每次 apply 都先完整预检，然后幂等创建来源运行；服务端返回的 checkpoint 决定续传起点，已确认序号不会再次发送。全部记录处理后请求附件搬运并轮询聚合报告，未决附件归零后才调用 complete；默认等待 1800 秒，可通过 `ERP_MIGRATION_ATTACHMENT_WAIT_SECONDS` 设置 10–86400 秒。

## 操作门禁

- 生产 apply 前必须完成来源包双人校验、恶意文件扫描、备份、变更单和演练编号登记。
- 任何 `rejected`、未解析关联、未决/拒绝附件、来源总数或校验和差异都禁止进入 Phase 6。
- 工具不会替代领域校验，也不会直接连接 MongoDB；所有目标写入仍由 REST 进入应用服务。
- 网络超时或进程中断后使用同一来源包重跑 apply；禁止修改原包后复用 `sourceRunId`。
- 当前实现会在预检期间维护来源记录 ID 集合；超大数据包必须按已批准 Scope 和容量演练结果拆分，不得绕过服务端总控制量。

附件网关通过 `DATA_MIGRATION_ATTACHMENT_GATEWAY_ENDPOINT` 与 `DATA_MIGRATION_ATTACHMENT_GATEWAY_BEARER_TOKEN` 成套配置，必须位于 ERP 授权域之外的标准 HTTPS 权限域。网关负责来源凭据、正文拉取、扫描与 WORM 归档；ERP 只发送来源标识、预期 checksum、由服务端 Scope 固定映射的 `L3|L4` 分级和不少于 2555 天的保留期。当前 `recruitment_offers`、`attendance_source_facts` 与 `attendance_corrections` 强制为 L4，其余已启用 Scope 为 L3；来源包和客户端不能提交或降低分级。网关回执必须原样确认分级，否则失败关闭。任何正文、来源 Token 或文件字节均不得进入 BullMQ Job、ERP 日志或迁移账本。

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
