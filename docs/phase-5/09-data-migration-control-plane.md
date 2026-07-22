# Phase 5 全量/增量迁移控制面契约

## 范围与当前能力

本切片建立可重复、可恢复、可审计的迁移控制面。首批白名单为组织参考主数据：部门、岗位、职级；员工、劳动关系、审批、招聘、考勤、薪资、附件实体将在同一账本协议上按域追加，完成前 Issue #34 与 Phase 5 迁移门禁保持未完成。

目标业务数据禁止由迁移模块直接写集合。`org.department`、`org.position`、`org.job_level` 的创建与增量更新均调用 `OrgApplicationService`，继续执行领域校验、引用校验、幂等、Outbox 和版本并发控制。迁移模块只直写自己拥有的运行、条目和来源映射账本。

## 来源包与确定性

- 运行声明：`sourceSystem`、来源唯一 `sourceRunId`、`full|incremental`、固定 Scope、来源总数和预期滚动校验和。
- 条目声明：连续 `sequence`、来源记录/版本、白名单实体类型、内存态 payload、payload SHA-256、显式关联来源 ID 和附件摘要清单。服务端另行计算覆盖实体类型、来源版本、关联与附件摘要的 `sourceFactHash`，用于识别“正文相同但控制事实已变化”的重放。
- 服务端先对规范 JSON 重算 payload SHA-256；不匹配立即拒绝请求且不推进检查点。
- 检查点只能逐条推进；同一运行/序号重复提交必须绑定同一来源记录和摘要。中断发生在领域写入、映射或条目之间时，领域幂等键和 `lastRunId + lastSequence` 可恢复原结果，不重复创建目标。
- 相同来源记录和相同摘要跨运行识别为 `duplicate`；摘要变化按目标版本执行增量更新。

`sourceFactHash` 的规范对象固定为 `sourceRecordId`、`sourceVersion`、`entityType`、`payloadHash`、按字典序排列的 `associationSourceIds`，以及按 `sourceAttachmentId` 排列且仅含 ID 与 checksum 的附件数组。滚动来源校验和初值为 `base64url(SHA-256(""))`，第 N 条为 `base64url(SHA-256(previous + "\\n" + sequence + ":" + sourceFactHash))`。来源导出程序必须使用相同算法，并固定 UTF-8、对象键字典序与数组规则。

## 权限、安全与数据质量

- 写接口只允许具有 `erp:migration:execute` 与目标域写 Scope 的 `service`/`system_job`；普通用户和 MCP 永久不能开始、推进或完成迁移。
- 租户只来自已验证服务身份；payload 不允许 tenantId，实体类型、字段和关联均走固定白名单。
- 账本不保存来源 payload、姓名、附件内容或 Token，只保存摘要、来源/目标引用、版本、状态和标准拒绝码。
- `data_migration_associations` 逐项保存关系类型、来源关联 ID、解析后的目标 ID 与 `resolved|missing` 状态；`data_migration_attachments` 逐项保存来源附件 ID、checksum、搬运状态和目标证据引用，严禁保存附件正文。
- 未知基础设施错误不允许伪装为业务拒绝或推进检查点；只有稳定的 `ORG_*` / `DATA_MIGRATION_*` 规则错误进入拒绝账本。
- 当前附件证据逐项登记为 `pending`，但尚未配置搬运适配器；每个未决附件均生成 High 差异并阻止 Phase 6 资格，禁止假报成功。未解析关联生成 Critical 差异。

## REST、MCP 与审计

- `POST /api/data-migrations/runs`：创建或重放同一来源运行。
- `POST /api/data-migrations/runs/{id}/records`：严格按检查点应用一条记录。
- `POST /api/data-migrations/runs/{id}/complete`：冻结运行并生成差异结论。
- `GET /api/data-migrations/runs/{id}/report`：读取控制量报告，Scope `erp:migration:read`。
- MCP Tool：`data_migration_report_get`；Resource：`erp://data-migrations/runs/{id}/report`；Prompt：`data_migration_report_review_guide`。全部只读且复用 `DataMigrationService.report`。
- R2 审计记录运行开始、每条应用/拒绝和完成；R1 审计记录报告读取。审计与 MCP 不包含来源正文。

## Phase 6 资格

只有来源记录数与检查点一致、来源滚动校验和一致、拒绝为零、未解析关联为零、附件未决/拒绝为零时，单次运行的 `phaseSixEligible` 才能为 true。`duplicate` 是可解释控制量但不得掩盖来源数；目标滚动校验和用于演练间比对。该布尔值仅是机器门禁之一，不代替三次演练、金额对账、数据负责人签署或总体 Go/No-Go。
