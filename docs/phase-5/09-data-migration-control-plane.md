# Phase 5 全量/增量迁移控制面契约

## 范围与当前能力

本切片建立可重复、可恢复、可审计的迁移控制面。当前白名单覆盖组织、审批、招聘、考勤、Payroll、Treasury 与通用业务附件完整历史链路，共二十六个独立 Scope。本地适配器已全部交付；三次真实全量演练、差异签署和实体 UAT 完成前，Issue #34 与 Phase 5 迁移门禁仍保持未完成。

目标业务数据禁止由迁移模块直接写集合。组织与劳动关系实体调用 `OrgApplicationService`，审批模板、已终结审批历史与活动审批调用 `ApprovalApplicationService`，HC 与职位调用 `RecruitmentManagementService`，候选人与申请调用 `RecruitmentApplicationService`，面试与评价调用 `RecruitmentInterviewService`，Offer 与后续申请阶段调用 `RecruitmentOfferService`，资金账户与代发批次分别调用 `TreasuryBankAccountService`、`TreasuryDisbursementService`，继续执行领域校验、引用校验、加密、盲索引、幂等、Outbox 和版本并发控制。员工更新、状态变更与开放劳动关系在一个事务内同步；既有员工离职仍必须进入 Care，迁移不得绕过清算、身份吊销与生效日控制。历史劳动关系使用独立恢复入口，不触发正常入职、离职或身份副作用，也不生成新员工。审批迁移分别只发布 `approval_template.migrated`、`approval_history.migrated` 与 `approval_instance.migrated`；招聘迁移只发布各聚合的 `.migrated` 专用事件，包括申请、面试和 Offer。所有迁移事件均不得伪装成正常创建、排期、评价、提交、决策、发送、签署、发布或退役动作，也不创建通知、外部日历、eSign、WORM 归档或银行提交任务。迁移模块只直写自己拥有的运行、条目、来源映射与证据账本。

## 来源包与确定性

- 运行声明：`sourceSystem`、来源唯一 `sourceRunId`、`full|incremental`、固定 Scope、来源总数和预期滚动校验和。空数据域允许声明总数为 0，但预期校验和必须与空滚动结果一致。
- 条目声明：连续 `sequence`、来源记录/版本、白名单实体类型、内存态 payload、payload SHA-256、显式关联来源 ID 和附件摘要清单。服务端另行计算覆盖实体类型、来源版本、关联与附件摘要的 `sourceFactHash`，用于识别“正文相同但控制事实已变化”的重放。
- `sourceVersion` 只允许 1–64 个可见 ASCII；控制字符、空格和非规范编码在进入
  校验和、账本或日志前失败关闭，DTO 与持久化 Schema 使用同一约束。
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
- `recruitment_reference` 必须在组织、员工身份、审批历史与活动审批 Scope 完成后执行，并在同一包内先导入 `recruitment.requisition` 再导入引用它的 `recruitment.position`。HC payload 只接收部门来源引用、职位名称、人数、理由、状态、版本、创建员工来源引用、时间和审批来源引用；不接收 tenantId、actorId、审批正文或附件正文。
- HC 草稿不得持有审批引用；待审批 HC 必须精确引用已迁移的运行中 `approval.instance`；已批准、已拒绝或已关闭 HC 必须精确引用 `approval.history`。引用的审批模板编码必须为 `recruitment_hc`，且终态必须与 HC 状态一致：批准/关闭对应 `approved`，拒绝对应 `rejected`。终结 HC 不得把历史审批伪装成在线实例。
- HC 创建员工来源引用先解析为 ERP employeeId，再由身份仓储解析为 actorId；草稿和待审批 HC 的创建员工身份还必须 active。非终结 HC 的部门必须 active；状态、审批引用和固定领域版本（草稿 1、待审批 2、批准/拒绝 3、关闭 4）必须一致。既有映射只允许完全相同快照重放，任何变化禁止覆盖。
- 职位 payload 只接收已迁移 HC、部门和职级来源引用、标题、地点、人数、状态、版本及生命周期时间。标题、部门与人数必须和 HC 完全一致；活动职位要求 active 部门及已批准 HC，关闭职位只允许引用已批准或已关闭 HC。领域恢复入口验证首次发布、关闭和更新时间顺序，不重放正常发布/暂停/关闭事件。
- 每条 HC 与职位必须各自唯一绑定一份治理 WORM 证据附件；payload 中附件来源 ID 和 checksum 必须与附件清单精确一致。在线招聘集合不保存附件正文或来源附件 ID，完整来源请求、审批和职位治理材料只由迁移账本及 WORM 管理。
- `recruitment_candidates` 使用独立来源包。payload 只接受当前隐私状态、姓名、E.164 手机、规范邮箱、当前授权版本/目的/时间、保留期、领域版本及一份候选人治理证据摘要；不接受简历正文、证件号码、银行卡、附件字节、tenantId、密钥或来源系统访问凭据。匿名候选人的姓名、手机和邮箱必须全部为 `null`；非匿名候选人必须有合法姓名和至少一种联系方式。
- 候选人姓名、手机和邮箱只在受控请求内存与招聘应用服务中短暂存在，随后由既有 `RecruitmentCandidateRepository` 使用 AES-256-GCM 写入身份密文，并用独立可轮换 HMAC 密钥生成电话/邮箱盲索引。迁移账本只保存 payload hash，目标 hash 只基于无 PII 摘要；Outbox、审计、幂等响应、REST 报告与 MCP 均不得包含直接身份、授权目的或保留期。
- 活动授权必须尚未到期，所有非匿名主档必须仍在保留期；已撤回授权必须具有与当前更新时间一致的撤回时间，过期但未匿名化的来源记录失败关闭。迁移来源固定登记为 `manual_import`，每条主档唯一绑定一份 checksum 精确匹配的授权/来源 WORM 证据；在线授权证据集合只保存迁移账本定位符和 checksum，不保存证明正文。
- 候选人主档为隐私快照，不接受迁移增量覆盖。相同 payload 由迁移账本识别为 duplicate；任何身份、授权、版本、时间或 WORM 证据变化必须进入人工隐私仲裁及正常领域流程。后续申请 Scope 只能引用本 Scope 已冻结的目标候选人映射。
- `recruitment_applications` 必须在候选人与职位映射完成后执行。payload 只接受候选人/职位来源引用、来源渠道、`applied → screening → interview` 及其合法淘汰/退出动作、最终阶段/版本/时间和一份完整申请档案 WORM 证据；不接收姓名、联系方式、简历、面试评价或 Offer 条款。每个来源候选人与职位引用均必须进入关联账本并解析为目标 ID。
- 本 Scope 只允许最终为 `applied|screening|interview|rejected|withdrawn`。服务在内存中调用现有 `transitionCandidateApplication` 逐动作重放并校验阶段、版本、更新时间和终态时间，然后只写最终申请聚合及单一 `recruitment.application.migrated` 事件；禁止伪造普通 `stage_changed` 日志、通知或下游动作。来源动作主体、原始申请时授权和完整历史只保留在唯一 WORM 档案。
- 活动申请必须引用仍为 active 且授权未过期的候选人，并只允许位于 open/paused 职位；在线 `consentEvidenceId` 指向候选人在切换时的有效授权证据，原申请时授权由 WORM 保真。进入 Offer 流水线的来源申请在本 Scope 只恢复至 `interview` 基线，待面试、Offer 和后续流水线 Scope 迁移后再形成最终状态，禁止在此处伪造跨聚合证据。
- 申请集合只额外保存迁移账本定位符与 checksum，不保存申请正文。相同快照可幂等重放；聚合或 WORM 证据变化禁止覆盖，必须进入人工差异处置。目标摘要、Outbox、报告、审计和 MCP 均不包含候选人直接身份。
- `recruitment_interviews` 必须在申请基线与员工映射完成后执行。每条 payload 只接受申请来源引用、轮次、方式、严格 UTC 排期、IANA 时区、创建员工与面试官来源引用、L3 地点/会议链接、按时间排序的面试官评价、最终状态/版本/时间，以及一份完整面试档案 WORM 证据；不接收候选人身份、简历、Offer 条款、tenantId、actorId、密钥或来源访问凭据。
- 面试只允许引用处于 `interview` 基线的申请。创建员工及全部面试官必须存在于 ERP 员工主数据；切换后仍为 `scheduled` 的面试官还必须为 probation/active，历史 completed/cancelled 面试允许员工已停用但不得丢失主数据映射。每位面试官最多一份评价，完成态必须齐备全部面试官评价；评价数量、终态动作与领域版本必须严格一致。
- 应用服务在内存中使用现有评价提交、完成和取消状态机重放来源事实，并核验开始/结束、提交、完成/取消、创建和更新时间线。地点/会议链接以及评价建议、评分和原文分别通过现有 AES-256-GCM 仓储加密；在线集合不保存明文字段，迁移账本、目标摘要、Outbox、报告、审计及 MCP 同样不得输出这些 L3 内容。
- 每条面试严格绑定一份 checksum 精确一致的 WORM 档案。面试聚合、全部加密评价与单一 `recruitment.interview.migrated` 事件在同一事务中写入；禁止重放普通 scheduled/feedback_submitted/completed/cancelled 事件、通知或日历下发。相同聚合、评价及证据可幂等重放，任何差异禁止覆盖并进入人工处置。
- `recruitment_offers` 必须在申请、已完成面试、员工身份及审批映射完成后执行。草稿不得引用审批；待审批 Offer 必须引用运行中的 `approval.instance`；其余状态必须引用模板编码为 `recruitment_offer` 且结果匹配的 `approval.history`，禁止把终结历史伪装成在线审批实例。
- payload 只接受目标引用的来源 ID、L4 Offer 条款、有效期/保留期、状态与版本、发送/候选人决定/eSign 的 SHA-256 摘要和时间、申请面试基线及后续阶段动作，以及一份完整 WORM 档案；不接收 tenantId、actorId、密钥、回执正文、合同正文或来源访问凭据。金额只允许 CNY 安全整数分。
- L4 条款只在受控请求内存中短暂存在，随后由既有 Offer 仓储使用 AES-256-GCM 整体加密。发送、候选人决定和 eSign 各自形成不可变摘要记录并绑定同一 WORM 档案；Offer、证据摘要及申请最终阶段在同一事务写入，禁止生成普通审批、发送、决定、签署或阶段变化日志。
- 申请必须从已迁移的 `interview` 基线在内存中复用状态机回放至 `offer_approval|offer_sent|offer_accepted|rejected|withdrawn`，并核验动作顺序、证据引用、最终版本及时间。只发布 `recruitment.offer.migrated` 与更新版本的 `recruitment.application.migrated`；相同快照可重放，Offer、申请、摘要或 WORM 任一差异均禁止覆盖。
- `attendance_source_facts` 必须在员工主数据完成后、考勤修订和月结前执行。payload 只接受员工来源引用、规范 Provider 编码、外部事件标识、事实类型、严格 UTC 发生/观测/落库时间、IANA 时区、L4 分钟影响及一份完整 WORM 档案；不接收 tenantId、目标员工 ID、设备、位置、照片、备注、来源 Token 或原始响应。
- 外部事件标识只进入独立考勤盲索引密钥域；发生时间、时区和分钟影响复用现有 AES-256-GCM 仓储。发生 ≤ 来源观测 ≤ 历史落库 ≤ 当前时间，业务日期由 IANA 时区重新计算；目标员工必须来自已解析 ERP 员工映射。
- 每条事实只发布 `attendance.source_fact.migrated`，事件、迁移账本、报告、审计和 MCP 不含外部事件标识或分钟影响。相同来源可幂等重放；事实、盲索引或 L4 WORM 任一差异均禁止覆盖。考勤修订和月结必须在后续独立 Scope 中复用这些事实，禁止本 Scope 伪造审批或关账。
- `attendance_corrections` 必须在源事实和已终结审批历史之后执行。每条记录同时引用已迁移员工、源事实和 `attendance_correction` 专用审批历史；审批必须为 approved，批准时间与审批 WORM checksum 从不可变历史核验，员工与业务日期从源事实派生，payload 不接受自报目标 ID、批准时间或业务日期。目标模型使用 `approval_instance|legacy_history` 判别引用并分别唯一约束，禁止把历史 ID 伪装成在线审批实例 ID。
- 替换分钟与原因码继续进入既有 L4 AES-256-GCM 修订仓储；修订另绑定唯一 WORM 档案。批准时间 ≤ 历史落库时间 ≤ 当前时间，同一源事实只允许一个修订，相同来源可严格重放，修订、审批摘要或 WORM 任一差异均禁止覆盖。
- 只发布 `attendance.correction.migrated`，不创建审批、待办、通知，不改写源事实，也不触发月结重开。事件、迁移账本、报告和 MCP 不输出替换分钟、原因码或审批 WORM 定位符。
- `attendance_monthly_snapshots` 必须在源事实与修订之后按员工、月份、版本升序执行。来源只声明规则版本、截止/关账时间、控制总量和版本链引用；目标服务按截止时间重新读取已迁移事实与修订并复用正式关账算法重算逐日明细、总计与 `snapshotHash`，禁止直接采信或写入来源快照正文。
- v1 不得包含前序或重开证据；v2+ 必须引用同员工同月份的 v(n-1) 目标映射、已通过 `attendance_month_reopen` 历史及其 WORM checksum，并满足重开审批完成 ≤ 关账时间。每一版另绑定唯一 WORM，激活新版本时只把直接前序标记为 superseded。
- 只发布 `attendance.month.migrated`，不伪造普通关账/重开事件。逐日明细继续使用 AES-256-GCM；迁移账本、报告、事件与 MCP 不输出逐日明细或来源控制 payload。
- `payroll_rule_packs` 必须先执行。每条规则版本引用 `payroll_rule_pack` approved 审批历史、审批 WORM checksum、法规来源摘要/引用和独立 WORM；目标重新运行确定性税率校验，按法域要求版本连续、生效区间不重叠，只发布 `payroll.rule_pack.migrated`。
- `payroll_compensation_profiles` 随后按员工、版本升序执行。员工只来自 ERP 主数据映射，审批只接受 `payroll_compensation` approved 历史；金额组件、扣缴与考勤调整策略使用 Payroll 独立 AES-256-GCM 密钥域，目标重算 `profileHash`，版本不连续、生效区间重叠、审批/WORM 或密文重放不一致均失败关闭。
- `payroll_periods` 只允许恢复 `draft|collecting` 基线。制单人必须先由来源员工映射为 ERP employeeId，再由身份仓储反查 actorId；来源不得提交 actorId。草稿的创建/更新时间必须相同，采集中周期只能通过正式领域状态机从版本 1 推到版本 2。周期不得携带运行、审批、锁定、代发或对账字段，每条周期绑定独立 WORM，只发布 `payroll.period.migrated`。
- `payroll_calculation_runs` 必须在规则、薪酬档案、考勤月结和 `collecting` 周期之后，按税年、月份、运行序号升序执行。首个运行执行 `collecting → review`，后续历史重算执行 `review → review`；固定满足 `expectedPeriodVersion = runNumber + 1`，且前一运行必须由本迁移产生、WORM 成对完整并与周期活动运行及全部摘要一致。来源只提交这些实体的来源引用、运行序号、完成时间、每员工应发/税额/实发控制金额和期间汇总，不提交目标输入快照、计算步骤、累计税状态或目标哈希。目标将全部引用解析为当前租户目标 ID，读取并验密薪酬与考勤快照，复用正式累计预扣内核逐员工重算；跨月累计只允许继承已锁定/已支付周期，或已经目标重算且运行 WORM 与周期摘要完全一致的前月迁移运行，普通在线计算不放宽。任一员工行、人数、三项汇总、规则摘要、前月/前次运行完整性或连续运行序号不一致即整笔失败，不写运行、密文或周期。
- 重算通过后，目标输入与结果继续分别使用 Payroll AES-256-GCM 密钥域保存，运行级 WORM 与历史完成时间冻结；首个运行把版本 2 `collecting` 推到版本 3 `review`，后续运行只按连续版本留在 `review` 并替换活动运行，只发布 `payroll.run.migrated`。审批、强认证锁定、代发、对账与报税必须由后续独立 Scope 恢复，禁止本 Scope 合成。
- `payroll_period_approvals` 只恢复已经终结为 approved 的历史工资审批。它必须引用 `review` 周期、`payroll_period_approval` 专用 `approval.history`、该历史的已登记 checksum 及审批员工映射；应用服务依次重放 `review → pending_approval → approved`，并继续强制制单人与审批人分离。周期以 `legacy_history` 判别引用，独立批准控制记录把审批历史、审批主体、完成时间、周期版本和迁移 WORM 冻结；不得把历史 ID 写成在线审批实例，也不得创建待办、通知或普通审批事件。草稿或运行中的工资审批不属于本 Scope，切换前必须完成、撤回，或在新系统按正式在线流程重新发起。
- `payroll_period_locks` 必须在对应批准控制完成后执行。它引用批准控制映射、独立锁定员工及经 WORM 证明的 WebAuthn UV 历史控制，核验批准时间 ≤ 锁定时间，并复用领域状态机强制锁定人独立于制单人与审批人。目标使用 `migration_lock_evidence` 判别引用，单独冻结锁定主体、时间、操作周期、认证方法和迁移 WORM；不生成或伪造在线 WebAuthn challenge/credential 记录，也不发布普通锁定事件。
- `payroll_tax_filings` 只恢复已经提交成功的个税清单与回执。它必须引用已锁定周期、活动计算运行、独立制备/审批员工、`payroll_tax_filing_approval` approved 历史及其 checksum；制备人与审批人必须彼此独立，且两者都不得兼任工资制单、审批或锁定。目标从工资计算密文和组织身份凭证重新生成确定性内部清单并使用 Payroll AES-256-GCM 加密，逐项核对员工数、应税总额和税额；迁移 WORM 冻结来源清单、强认证批准和税局回执。只发布 `payroll.tax_filing.migrated`，不调用归档/税局网关，不伪造在线 WebAuthn 证据，也不接收身份证件、税务行正文或密钥。
- 七个 Payroll Scope 均不触发普通 attest、计算完成、审批、锁定、代发或税务动作，只分别发布 `.migrated` 事件。迁移账本、报告、事件与 MCP 不输出员工级金额、规则正文、来源引用、密文或 WORM 定位符；`payroll_calculation_runs`、`payroll_period_approvals`、`payroll_period_locks` 与 `payroll_tax_filings` 固定为 L4，`payroll_periods` 固定为 L3，MCP 不提供薪资迁移写工具。
- `treasury_bank_accounts` 必须在员工和专用 `treasury_bank_account_attestation` approved 历史之后，按主体和版本升序执行。组织账户主体由可信租户派生，员工账户只接受已迁移员工映射；来源不得提交 tenantId 或目标 ownerId。每个版本核验审批 checksum 与时间线，账号明文仅在隔离请求内存中短暂存在，目标使用 Treasury AES-256-GCM 与可轮换 HMAC 盲索引保存。版本必须连续，活动账户不得绑定离职员工或与任何活动账号重复；历史撤销时间、前后版本链接和独立 L4 WORM 均冻结。只发布不含 ownerId/账号的 `treasury.bank_account.migrated`，不伪造在线 attest，不开放 MCP 写能力。
- `treasury_disbursement_batches` 必须在工资锁定、组织/员工账户和专用 `treasury_disbursement_export_approval` approved 历史之后执行。当前只接收已经提交、尚未回盘、`regular` 且批次序号为 1 的完整批次；来源存在部分成功、冻结、补发、恢复子批次或回盘链时，必须在切换前闭环或进入经批准的历史归档，禁止截断或伪造为常规已提交状态。
- 来源声明工资周期/运行、付款与员工收款账户、制备/批准员工、审批 checksum、期望工资版本、逐员工实发控制量、银行提交回执引用、制备/提交时间和唯一 L4 WORM。目标重新读取迁移锁定工资密文、核验三岗分离与 `锁定 ≤ 制备 ≤ 批准 ≤ 提交`，并验证账户在制备时点有效；来源不得提交 tenantId、actorId、支付指令 ID、目标文件 hash、账号快照或文件正文。
- 目标从可信映射与密文账户重新生成支付指令和 ISO 20022 pain.001，文件 hash 是目标重建文件摘要，不宣称等于来源银行文件摘要；来源原文件和回执仅由迁移 WORM 保真。目标恢复 submitted v4 与回执引用，只发布不含回执、账号或员工明细的 `treasury.disbursement.migrated`，不调用 WORM 或银行网关，不注册 MCP 写 Tool。
- `treasury_bank_returns` 必须在对应常规批次后执行，且当前只接收首份、全量成功、签名与恶意文件检查均已通过、无未知/重复/金额错位行的终结回盘。来源按员工声明期望金额与银行行引用，目标用员工映射定位迁移批次中的密文指令并逐行复核；任一失败行、部分成功、冻结或恢复子链均失败关闭，必须在切换前闭环或经批准归档。
- 目标以目标指令 ID 重建规范回盘清单并加密，目标 `returnHash` 只代表重建清单；来源回盘文件、签名和扫描证明由唯一 L4 WORM 保真，并通过 `migration_return_evidence` 判别，禁止伪装为在线 Inbox 回执。目标把批次从 submitted v4 恢复为 reconciling v5、支付行恢复为 succeeded，只发布不含证据定位符、银行行引用或员工明细的 `treasury.bank_return.migrated`，不调用 Inbox，不开放 MCP 写能力。
- `payroll_reconciliations` 只接收上述链路中已平衡的常规首批四方对账。来源只提交批次、银行回盘、已提交个税清单和对账员工来源引用，固定期望 v6、批次 v5、历史对账时间与唯一 L4 WORM；不接受来源差异、目标摘要、actorId、金额明细或账号。对账员工必须通过 ERP 身份映射，且不得与工资锁定人、代发制备人或导出批准人重合。
- 目标重新读取 Payroll 运行、个税清单、Treasury 指令与银行回盘，复用确定性四方对账内核；仅零差异才把周期从 locked v6 历史恢复为 reconciled v9、批次从 reconciling v5 恢复为 reconciled v6。目标 `evidenceHash` 只代表重算事实，来源对账材料由 `migration_reconciliation_evidence` WORM 独立保真。全事务只发布 `payroll.reconciliation.migrated` 与 `treasury.reconciliation.migrated`，不发布普通中间状态、不调用外部系统，不开放 MCP 迁移写工具。
- `business_attachments` 必须在全部归属实体和员工映射完成后最后执行。归属类型与用途采用一一固定白名单：审批实例/审批附件、审批历史/历史附件、候选人/简历、申请/申请附件、面试/面试附件、Offer/Offer 附件、劳动关系/劳动关系文件。payload 只接收归属来源 ID、可选上传员工来源 ID、固定用途、历史创建时间、checksum 和本条唯一附件；拒绝 tenantId、actorId、附件正文、原文件名、路径、MIME 与来源访问凭据。
- 目标应用服务只接受无未知字段的严格迁移输入并先登记 `migration_pending` 元数据，不伪造对象地址或 WORM 回执。每次读取只取最小投影，并在运行时反向校验可信租户、迁移引用、归属类型/用途、内容与迁移 checksum、状态、版本、对象证据和可用时间组合；受损记录以稳定 `BUSINESS_ATTACHMENT_MIGRATION_STATE_INVALID` 失败关闭，不得进入更新或 Outbox。
- 隔离附件网关完成拉取、checksum、恶意文件扫描与不可变归档后，Worker 才能提交严格回执并调用同一应用服务，在 Mongo 事务内把附件从 `migration_pending` v1 激活为 available v2 并发布一次 `business.attachment.migrated`，随后才能把迁移附件账本标记为 verified。available 重放只有在目标证据完全相同时才视为幂等；账本更新失败可重试且不会重复发布事件。正文、对象定位符、checksum、上传员工标识和原文件名均不得进入 Outbox 或 MCP。

`sourceFactHash` 的规范对象固定为 `sourceRecordId`、`sourceVersion`、`entityType`、`payloadHash`、按字典序排列的 `associationSourceIds`，以及按 `sourceAttachmentId` 排列且仅含 ID 与 checksum 的附件数组。滚动来源校验和初值为 `base64url(SHA-256(""))`，第 N 条为 `base64url(SHA-256(previous + "\\n" + sequence + ":" + sourceFactHash))`。来源导出程序必须使用相同算法，并固定 UTF-8、对象键字典序与数组规则。

## 权限、安全与数据质量

- 写接口的 HTTP 固定门禁只声明 `erp:migration:execute`，不能为所有 Scope 错误
  强绑组织写权限；应用服务再按运行 Scope 要求唯一目标域写 Scope。两层均只允许
  `service`/`system_job`，普通用户和 MCP 永久不能开始、推进或完成迁移。
- `payroll_reconciliations` 同时变更 Payroll 周期和 Treasury 批次，控制面开始、应用与重放均必须同时具备 `erp:payroll:migration:write` 与 `erp:treasury:migration:write`；缺少任一 Scope 即失败关闭。
- `business_attachments` 的控制面开始、应用与重放必须具备 `erp:document:migration:write`，附件 Worker 仍必须具备 `erp:migration:attachment:execute`。两者都只接受可信 `service|system_job` 身份；MCP 不注册迁移写 Tool，也不暴露附件正文 Resource。
- 租户只来自已验证服务身份；payload 不允许 tenantId，实体类型、字段和关联均走固定白名单。
- 账本不保存来源 payload、姓名、附件内容或 Token，只保存摘要、来源/目标引用、版本、状态和标准拒绝码。
- `data_migration_associations` 逐项保存关系类型、来源关联 ID、解析后的目标 ID 与 `resolved|missing` 状态；`data_migration_attachments` 逐项保存来源附件 ID、checksum、搬运状态和目标证据引用，严禁保存附件正文。
- 未知基础设施错误不允许伪装为业务拒绝或推进检查点；只有稳定的 `ORG_*` / `APPROVAL_*` / `RECRUITMENT_*` / `ATTENDANCE_*` / `PAYROLL_*` / `TREASURY_*` / `BUSINESS_ATTACHMENT_MIGRATION_*` / `DATA_MIGRATION_*` 规则错误进入拒绝账本。
- 附件证据逐项登记为 `pending`，全部来源记录处理完成后由独立 Worker 调用隔离附件网关。队列载荷只含租户、运行和派发 ULID，JobId 必须绑定三者并由
  Worker 重算；受损、扩张或错路由任务在查询数据库前失败关闭。
- Worker 认领使用 `processingStartedAt` 作为五分钟租约栅栏；成功与失败终态更新
  均精确绑定原租户、运行、条目、尝试次数和租约时间。租约丢失立即停止批次，
  不得覆盖其他 Worker 终态。状态先提交，后置审计故障只形成稳定告警，禁止把
  已归档附件或已提交的失败终态恢复为 `pending`。
- 网关自行拉取来源正文，完成 checksum 复核、恶意文件扫描与不可变归档；ERP
  只发送严格运行时校验的控制命令。成功回执必须使用
  `erp-data-migration-attachment-receipt.v1`，逐项回显租户、运行、来源系统、
  来源附件，并绑定摘要、数据分级和不低于请求值的保留期；额外字段、上下文错位、
  压缩响应、非规范 Content-Length、超过 16 KiB、非法 UTF-8/JSON 或非标准
  HTTPS 端点均失败关闭。`pending|processing` 生成 High 差异，网关拒绝生成
  Critical 差异并阻止 Phase 6。未解析关联同样生成 Critical 差异。

## REST、MCP 与审计

- `POST /api/data-migrations/runs`：创建或重放同一来源运行。
- `POST /api/data-migrations/runs/{id}/records`：严格按检查点应用一条记录。
- `POST /api/data-migrations/runs/{id}/complete`：冻结运行并生成差异结论。
- `POST /api/data-migrations/runs/{id}/attachments/transfer`：来源记录全部完成后入队搬运附件；要求可信服务身份及 `erp:migration:attachment:execute`，按 R2 审计。
- `GET /api/data-migrations/runs/{id}/report`：读取控制量报告，Scope `erp:migration:read`。
- `GET /api/data-migrations/runs/{id}/evidence`：按 `items|associations|attachments` 固定顺序分页读取完整证据账本；要求 `erp:migration:read` 与 `erp:migration:evidence:export`，每页返回 SHA-256，按 R2 审计。
- MCP Tool：`data_migration_report_get`；Resource：`erp://data-migrations/runs/{id}/report`；Prompt：`data_migration_report_review_guide`。全部只读且复用 `DataMigrationService.report`。
- MCP 只提供聚合控制量，不注册详细证据导出 Tool 或 Resource。来源/目标标识、逐条拒绝和附件 checksum 只能由受控 REST/CLI 导出，禁止向通用 AI 上下文扩散。
- R2 审计记录运行开始、每条应用/拒绝和完成；R1 审计记录报告读取。写操作业务
  状态提交后的审计故障只告警并返回已提交结果，避免客户端误判后重复执行；报告
  与详细证据读取仍保持审计失败关闭。审计与 MCP 不包含来源正文。

## Phase 6 资格

只有来源记录数与检查点一致、来源滚动校验和一致、拒绝为零、未解析关联为零、附件未决/拒绝为零时，单次运行的 `phaseSixEligible` 才能为 true。`duplicate` 是可解释控制量但不得掩盖来源数；目标滚动校验和用于演练间比对。该布尔值仅是机器门禁之一，不代替三次演练、金额对账、数据负责人签署或总体 Go/No-Go。
