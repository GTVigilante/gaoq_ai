# Phase 5 全量/增量迁移控制面契约

## 范围与当前能力

本切片建立可重复、可恢复、可审计的迁移控制面。当前白名单包含 `org_reference`（部门、岗位、职级）、`org_workforce`（员工）、`org_employment`（劳动关系）、`approval_templates`（审批模板版本）、`approval_history`（已终结审批历史）与 `approval_active_instances`（无文件草稿/运行中实例）六个独立 Scope；招聘、考勤、薪资与业务附件实体仍需在同一账本协议上按域追加，完成前 Issue #34 与 Phase 5 迁移门禁保持未完成。

目标业务数据禁止由迁移模块直接写集合。组织与劳动关系实体调用 `OrgApplicationService`，审批模板、已终结审批历史与活动审批调用 `ApprovalApplicationService`，继续执行领域校验、引用校验、幂等、Outbox 和版本并发控制。员工更新、状态变更与开放劳动关系在一个事务内同步；既有员工离职仍必须进入 Care，迁移不得绕过清算、身份吊销与生效日控制。历史劳动关系使用独立恢复入口，不触发正常入职、离职或身份副作用，也不生成新员工。审批迁移分别只发布 `approval_template.migrated`、`approval_history.migrated` 与 `approval_instance.migrated`，不伪装成正常创建、提交、决策、发布或退役动作，也不创建通知。迁移模块只直写自己拥有的运行、条目、来源映射与证据账本。

## 来源包与确定性

- 运行声明：`sourceSystem`、来源唯一 `sourceRunId`、`full|incremental`、固定 Scope、来源总数和预期滚动校验和。空数据域允许声明总数为 0，但预期校验和必须与空滚动结果一致。
- 条目声明：连续 `sequence`、来源记录/版本、白名单实体类型、内存态 payload、payload SHA-256、显式关联来源 ID 和附件摘要清单。服务端另行计算覆盖实体类型、来源版本、关联与附件摘要的 `sourceFactHash`，用于识别“正文相同但控制事实已变化”的重放。
- 服务端先对规范 JSON 重算 payload SHA-256；不匹配立即拒绝请求且不推进检查点。
- 检查点只能逐条推进；同一运行/序号重复提交必须绑定同一来源记录和摘要。中断发生在领域写入、映射或条目之间时，领域幂等键和 `lastRunId + lastSequence` 可恢复原结果，不重复创建目标。
- 相同来源记录和相同摘要跨运行识别为 `duplicate`；摘要变化按目标版本执行增量更新。
- `org_workforce` 的员工 payload 只接受固定字段：工号、显示名、状态、部门/主部门/岗位/职级来源引用。服务端把来源引用解析为当前租户的 ERP ID；主部门必须属于部门集合，引用缺失、重复或跨 Scope 均拒绝。
- `org_employment` 必须在对应 `org_workforce` 运行成功后执行。payload 只接受员工来源引用、自然人来源引用、身份核验/入职完成/Offer/签署证据引用、劳动关系状态和起止日期，以及离职时的 Care/执行/终止证据引用。员工引用必须解析为当前租户既有 ERP 员工；开放关系必须与员工状态一致且不能夹带终止字段，已离职关系必须对应 `terminated` 员工并同时具备结束日期与三类终止证据。迁移不接收身份证号、联系方式、合同正文或附件字节。
- 劳动关系一经恢复即作为历史事实冻结；同一来源记录的相同摘要可安全重放，变更后的快照不得覆盖既有劳动关系，必须进入人工差异处置与经批准的领域修复流程。
- `approval_templates` 必须在员工及其身份开户完成后执行，并按同一模板编码的修订号从 1 连续导入。payload 只接受模板编码/名称/风险等级/修订/状态、完整定义、责任员工来源引用与生命周期时间；应用服务先把责任员工映射解析为 ERP employeeId，再由身份仓储解析为 actorId，禁止来源系统直接注入 actorId。定义中的固定审批人，以及员工/部门字段条件中的来源引用，也必须逐项进入关联账本并转换成 ERP 主数据 ID。找不到身份、固定审批人或条件引用，修订断层、定义不合法或既有版本不同均失败关闭。
- 已发布或退役模板必须声明 `governanceEvidenceSourceAttachmentId`，且该标识必须精确存在于本条附件清单；草稿必须为 `null`。治理证据由附件网关校验摘要、扫描并进入 WORM，用于补足历史编辑/独立审批/发布记录；模板集合不保存证明正文。模板版本恢复后不可由后续来源快照覆盖。
- `approval_history` 只接收已通过、已拒绝或已撤回的终结事实；必须引用已迁移且非草稿的模板版本、已迁移员工及其 ERP 身份，并精确绑定一份历史证据附件。来源模板映射得到的目标模板 ID 必须与编码/修订查询结果一致。在线集合只保存目标模板 ID/编码/修订、发起员工、结果、完成/归档时间、迁移账本附件定位符与 checksum；标题、表单、意见、动作链和附件正文只进入 WORM。相同证据可幂等重放，任何字段变化均禁止覆盖。
- 历史证据附件必须是本条唯一附件，payload 的 `historyEvidenceChecksum` 必须与附件清单 checksum 完全一致。目标定位符固定为 `erp://data-migrations/runs/{runId}/attachments/{sourceAttachmentId}`，它指向受控迁移账本而不是伪造目标文件 ID；只有附件 Worker 取得目标 WORM 回执且运行报告零未决时才能完成 Scope。
- 草稿或运行中审批不属于 `approval_history`，只允许进入 `approval_active_instances`。payload 必须声明目标模板来源引用、发起员工、表单、表单主数据引用字段、提交时节点/审批人快照、按时间排序的提交/决策/转交/加签动作，以及最终状态、版本、当前节点、当前待办、提交/更新时间控制事实。迁移服务把所有员工/部门来源引用解析为 ERP 主数据，应用服务再把动作主体转换为 ERP actor，并使用现有领域状态机逐动作重放；最终控制事实任一不一致即整笔回滚。
- 活动审批仅允许最终为 `draft|running`。草稿所有者和运行态当前待办人必须仍为 active 身份；已处理历史主体允许停用但必须保留身份映射。所有实例写入、追加动作与单一 `approval_instance.migrated` Outbox 在同一事务完成，禁止发送正常提交/决策事件或通知。幂等响应只保存无表单摘要，避免解密表单进入幂等集合。
- 带非空 `file_reference` 的活动审批必须在切换前排空或经批准重建；在附件 Worker 产生目标证据 ID 之前，禁止把来源附件 ID 写入在线表单。每条活动审批仍必须唯一绑定一份完整状态/动作 WORM 证据，checksum 与附件清单精确一致。

`sourceFactHash` 的规范对象固定为 `sourceRecordId`、`sourceVersion`、`entityType`、`payloadHash`、按字典序排列的 `associationSourceIds`，以及按 `sourceAttachmentId` 排列且仅含 ID 与 checksum 的附件数组。滚动来源校验和初值为 `base64url(SHA-256(""))`，第 N 条为 `base64url(SHA-256(previous + "\\n" + sequence + ":" + sourceFactHash))`。来源导出程序必须使用相同算法，并固定 UTF-8、对象键字典序与数组规则。

## 权限、安全与数据质量

- 写接口只允许具有 `erp:migration:execute` 与目标域写 Scope 的 `service`/`system_job`；普通用户和 MCP 永久不能开始、推进或完成迁移。
- 租户只来自已验证服务身份；payload 不允许 tenantId，实体类型、字段和关联均走固定白名单。
- 账本不保存来源 payload、姓名、附件内容或 Token，只保存摘要、来源/目标引用、版本、状态和标准拒绝码。
- `data_migration_associations` 逐项保存关系类型、来源关联 ID、解析后的目标 ID 与 `resolved|missing` 状态；`data_migration_attachments` 逐项保存来源附件 ID、checksum、搬运状态和目标证据引用，严禁保存附件正文。
- 未知基础设施错误不允许伪装为业务拒绝或推进检查点；只有稳定的 `ORG_*` / `APPROVAL_*` / `DATA_MIGRATION_*` 规则错误进入拒绝账本。
- 附件证据逐项登记为 `pending`，全部来源记录处理完成后由独立 Worker 调用隔离附件网关。网关自行拉取来源正文，完成 checksum 复核、恶意文件扫描与不可变归档；ERP 进程只接收严格绑定摘要的回执。`pending|processing` 生成 High 差异，网关拒绝生成 Critical 差异并阻止 Phase 6。未解析关联同样生成 Critical 差异。

## REST、MCP 与审计

- `POST /api/data-migrations/runs`：创建或重放同一来源运行。
- `POST /api/data-migrations/runs/{id}/records`：严格按检查点应用一条记录。
- `POST /api/data-migrations/runs/{id}/complete`：冻结运行并生成差异结论。
- `POST /api/data-migrations/runs/{id}/attachments/transfer`：来源记录全部完成后入队搬运附件；要求可信服务身份及 `erp:migration:attachment:execute`，按 R2 审计。
- `GET /api/data-migrations/runs/{id}/report`：读取控制量报告，Scope `erp:migration:read`。
- `GET /api/data-migrations/runs/{id}/evidence`：按 `items|associations|attachments` 固定顺序分页读取完整证据账本；要求 `erp:migration:read` 与 `erp:migration:evidence:export`，每页返回 SHA-256，按 R2 审计。
- MCP Tool：`data_migration_report_get`；Resource：`erp://data-migrations/runs/{id}/report`；Prompt：`data_migration_report_review_guide`。全部只读且复用 `DataMigrationService.report`。
- MCP 只提供聚合控制量，不注册详细证据导出 Tool 或 Resource。来源/目标标识、逐条拒绝和附件 checksum 只能由受控 REST/CLI 导出，禁止向通用 AI 上下文扩散。
- R2 审计记录运行开始、每条应用/拒绝和完成；R1 审计记录报告读取。审计与 MCP 不包含来源正文。

## Phase 6 资格

只有来源记录数与检查点一致、来源滚动校验和一致、拒绝为零、未解析关联为零、附件未决/拒绝为零时，单次运行的 `phaseSixEligible` 才能为 true。`duplicate` 是可解释控制量但不得掩盖来源数；目标滚动校验和用于演练间比对。该布尔值仅是机器门禁之一，不代替三次演练、金额对账、数据负责人签署或总体 Go/No-Go。
