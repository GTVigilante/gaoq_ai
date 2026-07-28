# Phase 3 领域与集成契约

## 1. 聚合与权威

| 聚合/记录 | 权威模块 | 关键不变量 |
| --- | --- | --- |
| `RecruitmentRequisition` | Recruitment | HC 数量为正整数；审批通过前不能发布职位 |
| `RecruitmentPosition` | Recruitment | 只允许 `draft → open ↔ paused → closed`；关闭后不接受新申请 |
| `Candidate` | Recruitment | 不绑定职位；L3 身份数据加密；手机/邮箱用独立 HMAC 盲索引去重 |
| `CandidateApplication` | Recruitment | 一次应聘事实只属于一个候选人和一个职位；所有阶段变化追加事件并用乐观锁保护 |
| `Interview` / `InterviewFeedback` | Recruitment | 面试官来自有效 ERP 员工；本人只能提交自己的评价；标准答案式聚合评分不覆盖原评价 |
| `Offer` | Recruitment | 条款为 L4；审批、发送、接受、签署引用分别留证；金额使用整数分 |
| `ESignFlow` / `ESignEvidence` | Integration | ERP 状态机权威；回调先验签入 inbox；完成 PDF 哈希与证据不可普通删除 |
| `OnboardingInstance` | Onboarding | 由已接受 Offer 幂等创建；任务、材料、签署与培训均是引用，不复制权威数据 |
| `Person` / `Employee` / `Employment` | Org | 自然人、组织视图、劳动关系严格分层；由组织应用服务事务化建立 |
| `TrainingAssignment` / `ExamAttempt` | Knowledge | 进度由服务端事件计算；学员接口和 MCP 永不返回标准答案 |
| `CareCase` / `AlumniConsent` | Care | 权限失效与离职日期绑定；校友联系有目的、授权、到期时间和撤回清理 |
| `CareOccasionPreference` / `CareOccasionTask` | Care | 员工本人明确选择；生日/周年按租户策略规划；通知只接受签名终态回执 |
| `TalentLifecycleProjection` / `TalentTouchpoint` | Talent Lifecycle | `candidateId` 是招聘起点；全景只经各域应用服务实时组装，不复制候选人身份、离职原因或证据；服务备注加密且责任人来自可信身份 |

## 2. 招聘状态机

申请主链：

```text
applied → screening → interview → offer_approval → offer_sent
   │          │            │             │              │
   └──────────┴────────────┴─────────────┴──────────────┼→ rejected
                                                       ├→ withdrawn
                                                       ↓
                                                offer_accepted
                                                       ↓
                                                  preboarding
                                                       ↓
                                                    hired
```

- 禁止任意回退；重新评估必须创建显式的新面试轮次或新申请，不能改写历史。
- `rejected/withdrawn/hired` 为终态。人才库是带目的、授权和到期时间的候选人关系，不伪装成申请阶段。
- 进入 `offer_approval` 必须已有完成的面试；进入 `offer_sent` 必须关联已通过的审批实例；进入 `preboarding` 必须有候选人接受证据；进入 `hired` 必须由 Onboarding 完成门禁驱动。
- Onboarding 完成时只调用组织域应用服务；服务在同一事务建立 `Person`、`Employee`、`Employment`，Onboarding 不得直接写组织集合。
- `Person` 只保存候选人来源与身份核验证据引用，不复制身份证、联系方式或材料原文；工号由组织域按租户年度序列原子分配。
- 招聘职位只表达招聘需求，不能当作正式组织岗位；入职完成前必须显式核验 `orgPositionId`、部门和职级引用。
- 劳动关系生效日是严格 `YYYY-MM-DD` 的业务日期，不得转换成 UTC 时间点后再推导日期。
- 入职任务证据为追加写且不可替换；合同归档、身份核验、必修培训只接受对应受信任系统证明，人工接口不得自报完成。
- Knowledge 进度入口只接受具备 `erp:integration:knowledge:progress` 的受信任服务身份，提交绝对进度、唯一源事件和发生时间；不接受客户端增量累加。考试评分、任务完成和入职证明回填使用独立 Scope，且不注册 MCP 写工具。
- 完成采用可重入 Saga：`ready → provisioning → Org 建档 → completed → Recruitment hired`；每一步使用派生幂等键，任何中断均可续跑。

Offer 子状态机：

```text
draft → pending_approval → approved → sending → sent → accepted → signed
             │                         │       │       │
             └→ rejected              └───────┴───────┴→ expired/cancelled/declined
```

- `sending` 仅代表已形成受保护发送意图；只有 Integration 的可信投递回执才能进入 `sent`，不得把 HTTP 202 或 Outbox 入队当作已送达。
- 接受/拒绝必须由已验证候选人门户会话形成不可变证据；管理端和 MCP 不提供自报接受接口。`signed` 只接受 eSign 验签、租户映射、文件哈希与证据归档均完成后的内部命令。

### 2.1 Care 离职状态机

```text
draft → pending_approval → approved → clearing → ready → scheduled → executing → completed
                    └──────────────────────────────────────────────────────────→ cancelled
```

- Care 是离职清算和生效时刻的编排权威；Org 通用员工状态接口禁止直接进入 `terminated`。只有具备 `erp:care:employment:terminate` 的 Worker 窄接口可在同一 Mongo 事务关闭 `Employment`、终止 `Employee`、停用授权与外部身份并吊销会话/刷新令牌。非离职的转正、在职与停职迁移必须在同一事务同步当前 `Employee` 和开放 `Employment`，不得留下两套在职状态。
- 最后工作日使用严格 `YYYY-MM-DD`；`accessDisableAt` 使用规范 UTC 时刻，并必须映射到租户 IANA 时区内的同一最后工作日。未到该时刻不得提前执行。
- 交接接受、资产清退、财务清算、数据保留确认分别使用独立可信 Scope 和不可替换证据；证据及校友授权必须由生产 Adapter 校验，Adapter 未装配或无法确认时失败关闭。全部清算完成后才能排期。人工 REST 和 MCP 均不暴露 R3 执行能力。
- 执行采用 `scheduled → executing → Org terminate → completed` 可恢复 Saga。队列任务按租户与案件唯一，重试读取最新版本；Org 以案件、执行证据和业务日期三元组校验重放。
- 校友联系必须有明确目的、渠道、授权版本、授予时间和不超过五年的到期时间；撤回后立即停止非必要联系，不得复用员工在职授权。授权创建后按可信租户和授权标识生成稳定的 BullMQ 延迟任务，到期由只持有 `erp:care:alumni:consent:expire` 的 Worker 转为 `expired` 并发布 `care.alumni_consent.expired`；任务数据、事件和审计均不得包含自然人标识或授权证据标识。延迟任务失败按同一 JobId 重试；运行时 Worker 禁止跨租户全库扫描，存量任务只能由受控迁移命令在 dry-run 审核后显式重建。

### 2.2 生日与入职周年关怀

- `Person` 生日继续按 L4 管理：身份服务专用入口只提交 `MM-DD` 与证明引用，在内存中用独立 `ORG_PERSON_BIRTHDAY_BLIND_INDEX_KEYS` 密钥环生成最多五个 HMAC 轮换指纹；组织集合、索引、事件、审计和响应均不保存生日明文。Care 只能经 `OrgCareOccasionSourceService` 窄口解析在职员工、当前/历史 Employment 与月日；窄口只接受同租户 `service/system_job` 与内部 Scope，并二次闭合校验 Employee 查询主键、当前 Employment、Person、唯一开放关系、全部复聘历史和生日证明三元组。普通用户即使获得同名 Scope、任一租户或引用错位、历史损坏、证明与盲索引不成套或密钥环无法解析时均失败关闭。
- 本人 REST 固定为 `GET/POST/PUT /care/occasion-preferences/me` 与 `POST /care/occasion-preferences/me/unsubscribe`；员工、租户和当前劳动关系只从 Access Profile 与权威组织事实解析。未创建偏好时默认不启用任何关怀，所有写入强制 `Idempotency-Key`，更新/退订另强制 `If-Match`；全局退订同事务关闭两类关怀、清空渠道并取消全部待发送任务。
- 租户策略只从 `CARE_OCCASION_POLICIES_JSON` 控制面读取，必须显式版本化 IANA 时区、发送本地时间、静默时段、闰日口径、复聘周年口径、受控模板和最大重试次数。发送时间落入静默时段、策略缺失、主数据摘要变化、模板变化、已离职、已退订或类型关闭均失败关闭。
- MongoDB 是偏好与投递任务唯一事实源；同租户、员工、关怀类型和发生年度唯一。BullMQ 投递任务只携带可信租户与任务 ID，周期对账任务为空载荷；不得携带生日、联系方式、通知正文、模板内容或证据。Worker 抢占锁 15 分钟后可恢复，稳定幂等键覆盖“外部已送达但本地事务失败”，达到策略上限进入 `dead`，只能由运维 Scope 显式重放。
- 外部通知端点固定为 `/v1/employee-care/dispatch`。ERP 外呼前以严格 Schema 校验可信租户、任务、员工、关怀类型、目的 `employee_care`、模板编码、策略版本、计划时刻、唯一偏好渠道、源摘要和稳定幂等键，只发送这些最小控制字段与控制摘要；未知字段、联系方式、正文、访问 Token 或模板内容在网络调用前失败关闭。网关负责最新渠道授权、地址解析和正文渲染。请求正文最大 128 KiB，回执只接受无压缩严格 JSON、规范 Content-Length、16 KiB 流式上限和 Fatal UTF-8，并以规范 Ed25519 SPKI DER 公钥对原始字节验签；未配置、非标准 HTTPS、凭据/Key ID/公钥、签名、上下文、渠道、读取、长度、编码或送达时间错配均取消正文并以稳定错误码失败关闭。
- 事件固定为 `care.occasion.preference_updated/unsubscribed/scheduled/delivered/cancelled/dead/replayed` v1 CloudEvent，只含目的、类型、状态、策略版本、尝试次数、受控拒绝码或重放原因码；不含员工、生日、具体联系方式、通知正文或送达证据。审计同样只记录开关、类型、状态、版本与计数。
- 指标固定为 `gaoq_care_occasion_transition_total{operation,outcome}`、`gaoq_care_occasion_dispatch_duration_seconds{outcome}`、`gaoq_care_occasion_backlog{status}` 和 `gaoq_care_occasion_oldest_age_seconds{status}`，禁止使用租户、员工、任务或渠道地址标签。
- `pnpm quality:org-care-occasion-source-coverage` 对关怀跨域来源服务逐文件强制语句、分支、函数和行覆盖率均不低于 90%。标准 MCP 继续只复用 Care 应用服务的本人脱敏汇总，不得直接调用该来源窄口，也不得暴露生日、盲索引、Employee/Employment/Person 引用或新增关怀写能力。

### 2.3 校友授权终止后的下游清理

- `care.alumni_consent.withdrawn|expired` v1 Outbox 是唯一触发源；协调器必须重读
  当前授权终态，并按服务端登记目标原子创建任务。自然键和幂等键必须包含授权、
  授权版本、目的、目标和政策版本，重复或乱序事件不得重复产生外部副作用。
- `CARE_ALUMNI_CLEANUP_TARGETS_JSON` 只能由 Secret Manager 注入。每个目标必须
  使用独立标准 HTTPS Origin、Bearer Token 和 Ed25519 信任根，禁止跨目标复用。
- 外部端点固定为 `/v1/alumni-consent-cleanups/execute`。回执必须绑定控制摘要和
  政策版本，声明未来处理已阻断，并使用 `immutable_worm|append_only_ledger`；
  签名、摘要、上下文、存储类别或至少七年保留期不匹配时失败关闭。
- MongoDB 是任务事实源，BullMQ 只携带可信租户和任务 ID。任务支持锁恢复、指数
  退避、dead、审批重放和只读对账；灾后重建只从权威终态授权恢复缺失/已死的原始
  终止 Outbox，仍由运行时 relay 唯一扇出任务。
- REST 固定为 `GET /care/alumni-consents/:id/cleanup-status`；事件固定为
  `care.alumni_cleanup.scheduled/completed/dead/replayed` v1 CloudEvent。标准
  MCP 固定为 `care_alumni_cleanup_status_get`、
  `erp://care/alumni-consents/{id}/cleanup` 和
  `care_alumni_cleanup_status_guide`，只返回脱敏终态与计数，不开放清理或恢复。
- 详细运行、SLO、告警、保留与 UAT 见
  [校友授权终止后的下游清理证明运行手册](./05-alumni-cleanup-proof-runbook.md)。

### 2.4 人才全周期与服务追踪

- Talent Lifecycle 是跨域只读投影和服务触点权威，不改写 Recruitment、Onboarding、Org、Care 的业务事实。`Candidate → Person → Employment` 引用构成人才身份主线；同一候选人的多次申请、复聘和多段劳动关系都保留在同一主线下。
- 生命周期阶段按 `离职处理中 → 在职 → 入职中 → Offer → 招聘中 → 校友 → 曾任员工 → 人才库 → 停用` 的优先级从权威状态推导，不能由浏览器或 AI 直接设置。
- 服务触点只保存受控类型、渠道、方向、结果、责任人、发生时间和下一步行动；自由备注使用 Recruitment L3 密钥域、`talent_touchpoint` AAD 加密。索引、日志、审计、Outbox 和幂等响应快照均不得包含备注明文；关闭操作必须先用候选人引用和责任人非敏感投影完成授权，再解密完整记录。
- 候选人招聘联系要求候选人仍为 `active`，且联系授权与保留期限均未过期。校友活动和复聘联系还必须存在目的匹配、渠道匹配且未过期的有效 `AlumniConsent`；撤回后只允许记录内部撤回事实，不得继续外呼。
- 关闭开放跟进要求强 `If-Match`、幂等键和责任人校验；跨责任人关闭仅允许 `erp:talent-lifecycle:touchpoint:write_all`。
- REST 写入口必须在调用应用服务前严格校验资源 ULID、白名单幂等键、强
  `If-Match` 和无未知字段的请求体。业务失败与事务提交后的审计故障必须分开：
  前者记录 R2 失败审计，后者只记录稳定告警，禁止把已提交终态改写或暴露为失败。
- 触点 Outbox 必须与触点写入共用活动 Mongo 事务，逐项闭合可信租户、动作、
  状态、版本、规范时间与数据库创建回执。CloudEvent 只允许候选人引用、聚合
  引用/版本、受控类型/渠道/结果、状态和行动时间；备注、负责人、方向、姓名、
  联系方式和上游凭据一律不得进入事件。
- Recruitment、Onboarding、Org 与 Care 的窄查询口必须在应用边界二次校验可信
  租户、候选人、申请、职位、阶段事件、自然人、劳动关系、员工、离职案件和校友
  授权引用闭包；仓储查询条件不能替代返回记录校验。任一跨租户或引用错位必须
  整体失败关闭，禁止拼成部分可信全景后再交给 REST 或 MCP。

## 3. 身份、隐私与保留

- 候选人收集时必须保存授权版本、目的、来源、时间和到期时间；没有授权或授权已撤回时禁止创建新处理活动。
- 姓名、手机号、邮箱、简历、面试评价为 L3；Offer 条款、合同、身份证、银行卡为 L4。
- L3/L4 密文使用 AES-256-GCM；AAD 至少绑定租户、资源类型和资源 ID。精确去重仅查询规范化 HMAC 盲索引，禁止索引明文或随机密文。
- 列表、通知、日志、事件和 MCP 默认只返回脱敏标识。解密必须声明目的并通过 Scope、角色、数据范围和字段权限。
- 保留期由租户政策和法务依据确定，记录必须有 `retentionExpiresAt`；到期任务先冻结处理，再匿名化或密钥销毁，并保存不含个人原文的执行证明。
- 授权撤回不删除依法必须保留的签署和审计证据，但立即停止人才库、营销和非必要处理。

## 4. 外部连接

### 4.1 招聘渠道

`RecruitmentChannelAdapter` 仅提供 `publishPosition / closePosition / pullApplications / acknowledgeStage`。原始投递先写加密 inbox，病毒扫描后的附件进入对象存储；标准化、指纹去重和领域写入由 Worker 调用 Recruitment 应用服务完成。

外部职位、投递和候选人标识统一进入 `integration_external_mappings`；领域集合不保存供应商 Token 或供应商状态枚举。渠道失败可补拉、重放和对账，不能改变已有 ERP 阶段。

- 每个渠道必须同时装配传输 Adapter、带版本 Normalizer 和 EvidenceVerifier；缺失任意一项即在启动或调用时失败关闭。
- 渠道绑定只保存 `GAOQ_RECRUITMENT_CHANNEL_*` 受控凭据引用；补拉游标、原始投递和外部标识使用不同 AAD 的 AES-256-GCM 密文。去重和查找使用可轮换 HMAC 盲指纹，禁止存储可枚举的明文 SHA-256。
- 补拉前必须复核 Mongo 回读绑定与可信租户、绑定 ULID、活动状态、渠道装配及
  Secret 引用闭合。渠道批量结果和每条投递 Envelope 只接受精确普通对象；事件
  ID 使用规范直接标识，`occurredAt` 使用毫秒精度 UTC，重复事件、未来漂移或
  多余字段均在任何 Inbox 写入前整批失败。
- 原始投递只接受可规范往返的纯 JSON 对象：禁止存取器、Symbol、危险键、非有限
  数值、负零、自定义原型、稀疏数组和 NFKC 漂移。单条明文不超过 512 KiB，
  单批不超过 4 MiB，深度不超过 16、节点不超过 20,000、数组不超过 1,000 项、
  对象不超过 256 键；通过后使用规范深冻结副本加密入箱。
- `hasMore=true` 必须返回已前进的可见 ASCII 游标；缺失或等于当前游标会失败
  关闭，禁止形成一秒级空转热循环。游标仍只以独立 AAD 密文保存。
- Worker 只从队列的租户与 Inbox ULID 建立系统身份；Normalizer 输出不合约进入人工复核，证据校验、职位映射、领域写入或回执失败则保留 Inbox 并重试。
- 通用 REST 创建申请禁止自报 `consent.source=channel`；只有具备 `erp:recruitment:channel:ingest` 的 `system_job` 可调用渠道窄接口。回执使用稳定幂等键，成功回执只保存盲指纹证明。
- EvidenceVerifier 形成的同意证据 ULID 必须先固化为 Inbox 检查点，再原样贯穿 Candidate、ConsentEvidence 与 Application；崩溃重试复用检查点，不得重复生成或由领域写入层另造“可信证据”。失败 BullMQ 确定性任务必须显式 `retry`，不能依赖重复 `add`。
- 职位开放/暂停/关闭及申请阶段变化分别由事务 Outbox 投影为独立投递轨迹。申请阶段按聚合版本顺序映射为 `screening/interview/offer/hired/rejected/withdrawn`，回执 Worker 仅用 `erp:recruitment:channel:ack` 读取来源渠道窄投影；渠道只接收阶段，不接收淘汰原因、评价、Offer 条款或证据正文。
- 标准 MCP 只读取 Recruitment 应用服务的最小脱敏投影，不注册渠道补拉、游标、
  原始 Inbox、凭据、EvidenceVerifier 处置或重放 Tool。

### 4.2 日历与通知

面试和入职日程由 ERP 发出不可变业务标识，经日历适配器创建外部事件；外部编辑只作为回执，不覆盖 ERP 时间与参与人。消息正文不含简历、评价、Offer 条款或签署文件，只发送受保护链接。

- 排期必须携带候选申请强 `If-Match`，仅 `interview` 阶段可新建轮次；面试官标识必须逐一解析为 ERP 当前 `probation/active` 员工。
- 访问令牌的 `actorId` 必须经有效 AccessProfile 映射为 `employeeId`，禁止直接将 actor 标识当作面试官标识。
- 每位面试官每轮只能追加一份评价；推荐、分数和备注作为单一 L3 载荷整体加密。评价、取消和完成共用面试版本锁，防止取消后并发写入评价。
- 日历投递由事务 Outbox 触发；事件只含面试标识和时间摘要，Integration Worker 通过专用最小 Scope 读取加密地点投影。日历失败只进入重试/人工介入，不回滚 ERP 排期。
- 日历投递必须同时存在有效 `OrgPlatformBinding`（凭据引用）与 `RecruitmentCalendarBinding`（可写日历）；绑定只能由受控运维面变更，业务 API 和客户端不得提交外部日历 ID。
- Relay 创建投递轨迹时固化 `externalCalendarId`，后续即使租户切换默认日历，重试、更新和取消仍只操作原目标日历；轨迹禁止保存地点、参与人、Token 或候选人资料。
- 钉钉使用 Calendar 1.0 的 `x-client-token` 原子创建/更新日程与参与人；飞书使用 Calendar v4 `idempotency_key` 创建日程，并通过参与人接口补齐 `user_id`。两个适配器都只能通过统一令牌服务取短期访问令牌，401 最多刷新一次。
- Worker 任务分为 `relay:calendar`、`deliver:calendar:dingtalk` 和 `deliver:calendar:feishu`；平台限流、网络错误和外部身份尚未就绪按指数退避重试，业务错误、冲突或耗尽重试进入人工介入，不反写 Recruitment 状态。
- Worker 只能自动认领 `pending`。超过五分钟仍为 `processing` 的记录代表平台结果不确定，必须转入 `manual_review`，禁止仅凭锁超时自动重放；平台成功后的本地终态或审计故障必须与普通失败隔离，禁止将已提交副作用回写为失败。
- 不可变事件版本必须与当前 Recruitment 投影精确核对：投影版本更新则旧任务以 `superseded` 结束，投影版本落后或身份事实损坏则人工复核，禁止用旧幂等键把当前排期写入平台。
- 飞书“创建事件后添加参与人”等多步写入一旦出现部分提交，必须保存经校验的外部事件标识并标记结果不确定；钉钉/飞书成功响应中的事件标识、请求标识和全部标准命令必须在适配器边界重新验证。
- `GET /integrations/recruitment-calendar-deliveries` 只返回租户内脱敏终态摘要，`limit` 只接受规范十进制 `1..100`；`POST /integrations/recruitment-calendar-deliveries/:eventId/:channel/resolutions` 以 `Idempotency-Key` 和 R2 审计执行 `retry` 或 `accept_succeeded`，严格拒绝未知正文、Token、平台回执或状态覆盖字段。结果不确定类记录只有完成平台核验后的 `approved_exception` 才可处置。业务失败后的审计故障不得覆盖原始异常，处置事务已提交后的审计故障不得改变成功响应。
- 标准 MCP 只保留 `recruitment_interview_get` 等应用服务只读能力；永久不注册日历创建、更新、取消、重试、人工处置、对账、外部事件标识或平台凭据能力。
- 外部事件标题固定为无候选人信息的“招聘面试”；仅在业务必要范围向日历平台发送时间、时区、地点和已验证面试官外部 ID，审计、日志和 Outbox 均不得记录地点明文。

### 4.3 e签宝

统一出站 `ESignAdapter`：`createFlow / getFlow / signUrl / listSignedFiles /
downloadSignedFile / verifySignedFile`；入站验签由独立 Webhook 边界完成。
`POST /webhooks/esign` 禁止 query，对请求时间戳与 raw body 执行 HMAC-SHA256，
只在验签后以唯一 appId 绑定解析租户；原文加密写 inbox 后原样返回供应商
200 契约。

内部状态为 `awaiting_signature → partial_signed → provider_completed → completed`，分支为 `rejected/expired/cancelled`。官方 action 白名单为 `SIGN_MISSON_COMPLETE` 和 `SIGN_FLOW_COMPLETE`，完成回调的 `signFlowStatus=2/3/5/7` 分别映射 `provider_completed/cancelled/expired/rejected`。未知 action 标记 Inbox `ignored`，未知状态或冲突终态设置 `reviewRequired`，均禁止自动前进或回退。投影前必须严格校验当前状态、供应商状态和 `reviewRequired/reviewCode` 成套关系；终态收到未知或冲突状态时保留已有可信供应商状态，本地 `completed` 收到正常完成回执时不得清空既有复核原因。`changed` 必须比较完整下一投影，重复未知状态或终态冲突不得再次增版。

每 15 分钟补拉长期未更新流程。`provider_completed` 后仍必须下载 PDF、校验内容摘要和供应商签署结果、病毒扫描、存入不可变对象存储并写入证据账本。只有该证据交易成功后才进入 `completed` 并调用 Recruitment 应用服务标记 Offer `signed`。

- OpenAPI 只允许官方 `https://smlopenapi.esign.cn` 和 `https://openapi.esign.cn`，生产强制后者。请求按官方七段式字符串计算 Content-MD5 和 HmacSHA256；MD5 仅用于供应商协议兼容，ERP 证据统一使用 SHA-256。
- 创建流程固定调用 `POST /v3/sign-flow/create-by-file`，使用受控供应商文件 ID、
  个人账号、姓名、到期时间和有界签署坐标；强制自动启动、签署后自动结束和身份
  一致校验。免登录链接固定调用
  `POST /v3/sign-flow/{signFlowId}/sign-url`，只接受官方 eSign HTTPS 页面，
  禁止任意跳转、用户信息、凭据和非标准端口。
- ERP 用户发起签署必须先通过 `POST /integrations/esign/issuance-requests`
  持久化意图，再由 `issue:esign:flow` Worker 执行。请求强制
  `Idempotency-Key`、`erp:integration:esign:initiate` Scope 和 R2 审计；Mongo
  记录只保存加密供应商文件标识、Offer/版本及调度控制字段，不保存签署主体、
  Offer 条款、签署链接或 Token。
- 发起意图状态为
  `pending → processing → local_finalize → succeeded`，异常终态为
  `manual_review/dead`。供应商结果未知时不得自动重放；已有加密外部 flowId 时
  只能补本地 `ESignFlow` 登记。过期租约无回执转人工核验，有回执转
  `local_finalize`。
- `GET /integrations/esign/issuance-requests?status=manual_review|dead` 只返回
  本租户脱敏摘要；`POST
  /integrations/esign/issuance-requests/:requestId/resolutions` 只允许专用运维
  Scope、幂等键和 R2 审计。重新外呼要求 `approved_exception` 与供应商确认
  未创建；人工绑定要求供应商确认 flowId 与原请求一致，且不得直接写成功终态。
- eSign 发起、重试、人工处置、供应商文件、外部 flowId 和签署主体永久不注册
  MCP Tool、Resource 或 Prompt。标准 MCP 只能复用应用服务读取既有脱敏业务
  状态，不能调用本状态机或供应商适配器。
- 补拉调用 `GET /v3/sign-flow/{id}/detail`；下载地址使用官方推荐的 `POST /v3/sign-flow/{id}/file-download-url`，有效期固定 300 秒；每个 PDF 再调用 `POST /v3/files/{fileId}/verify`。下载客户端禁止跳转，限定 eSign HTTPS 域名、50 MiB 上限和 `%PDF-` 魔数。
- `integration_esign_evidence` 仅保存供应商文件 ID 摘要、PDF SHA-256、大小、扫描证据、验签结果摘要、WORM 对象引用与回执；不保存 PDF、文件名、下载短链、证书或签署人原文。WORM `objectKey` 必须幂等；扫描或归档 Adapter 未装配时必须失败关闭。
- 扫描与 WORM 网关必须成套配置在独立 HTTPS 权限域。Adapter 出站前复算 PDF SHA-256，响应限制为 16 KiB 严格 JSON；扫描回执绑定摘要，WORM 回执同时绑定摘要、对象键、不可变标志和不少于十年的保留期。任一错位均不得推进 Offer `signed`。
- Webhook 任务 ID 绑定租户、Inbox 与事件摘要；认领租约同时绑定随机令牌、任务
  ID 和尝试次数，旧 Worker 不能关闭新 Worker 的处理记录。证据任务耗尽后删除
  失败 Job，长期停留 `provider_completed` 的流程由十五分钟对账重新投递；重复
  文件描述符在下载和 WORM 写入前即拒绝。
- 流程投影、证据投递、Offer/Flow 终态已提交后的审计异常只作独立安全告警；
  业务失败审计本身异常也不得中止整批对账。此规则不降低审计要求，值班人员仍须
  按告警补录或恢复审计基础设施。

## 5. REST、事件与 MCP 同步交付

每个用例必须同时登记以下四类契约：

1. REST：强 `If-Match`、`Idempotency-Key`、稳定错误码、Scope 和字段投影。
2. 事件：CloudEvents 1.0、事务 Outbox、无个人原文、消费者幂等和版本。
3. MCP：Resource/Tool JSON Schema、风险等级、确认链、脱敏输出和客户端兼容测试。
4. 审计：动作、资源、风险、目的、授权/审批/强认证引用和结果；禁止个人原文。

首批能力：

| 用例 | REST | 事件 | MCP | 风险 |
| --- | --- | --- | --- | --- |
| 创建与提交 HC | `POST /recruitment/requisitions` 及 `/:id/submit` | `recruitment.requisition.created/submitted.v1` | 查询 + `recruitment_requisition_submit_prepare/execute`；创建待加密草稿引用 | R1/R2 |
| 同步 HC 审批 | `POST /recruitment/requisitions/:id/sync-approval` | `recruitment.requisition.approved/rejected.v1` | 只读查询，不接受 AI 上报 outcome | R2 |
| 创建与发布职位 | `POST /recruitment/requisitions/:id/positions` 及 `POST /recruitment/positions/:id/status` | `recruitment.position.created/status_changed.v1` | 查询 + `recruitment_position_transition_prepare/execute`；创建待安全草稿 | R1 |
| 创建候选人及申请 | `POST /recruitment/applications` | `recruitment.application.created.v1` | 查询；创建待 L3 加密草稿引用 | R1 |
| 查询候选人状态 | `GET /recruitment/applications/:id` | 无 | Resource + `recruitment_application_get` | R0 |
| 安排面试 | `POST /recruitment/applications/:id/interviews` | `recruitment.interview.scheduled.v1` | 查询；安排待 L3 加密草稿引用 | R1 |
| 提交面试评价 | `POST /recruitment/interviews/:id/feedback` | `recruitment.interview.feedback_submitted.v1` | 查询；评价写入不向 AI 开放 | R1 |
| 形成/发送 Offer | Offer 资源端点 | `recruitment.offer.*.v1` | 脱敏查询 + `recruitment_offer_send_prepare/execute` | R2 |
| 简历解析与标签复核 | `POST /recruitment/resume-library/candidates/:candidateId/analyses`、`GET /recruitment/resume-library/analyses`、`POST /recruitment/resume-library/analyses/:id/review` | `recruitment.resume_analysis.requested/reviewed.v1` | 不注册 MCP；模型仅在 Worker 内生成建议 | R1/R2 |
| 人才全景与服务跟进 | `GET /talent-lifecycle/people`、`GET /talent-lifecycle/people/:candidateId`、服务触点创建/关闭端点 | `cn.gaoq.erp.talent.touchpoint.created.v1`、`cn.gaoq.erp.talent.touchpoint.completed.v1`、`cn.gaoq.erp.talent.touchpoint.cancelled.v1` | Resource + `talent_lifecycle_get`；不注册写 Tool | R0/R2 |

### 5.1 招聘门户

- Web 在 `/careers` 提供公开招聘门户，视觉沿用 GaoQ-OS 深蓝、青色品牌体系；CMS 仍只负责品牌内容，不得成为职位状态或候选人事实源。
- 浏览器只调用同源 `/api/careers/*` BFF。BFF 使用独立 Client Credentials，并按请求分别申请 `erp:recruitment:portal:read` 或 `erp:recruitment:application:create` 最小 Scope；服务令牌和客户端 Secret 不得进入浏览器产物。
- BFF 到 ERP 在集群内只允许 `http://<service>.<namespace>.svc.cluster.local:3001` 完整服务域名，或经受控 HTTPS API Origin；OAuth `resource` 仍须与 ERP 注册值逐字一致。NetworkPolicy 只放行 Web Pod 到 API Pod 的 3001 端口。
- ERP `GET /recruitment/portal/positions` 只返回 `open` 职位的 `id/title/department/location/headcount/publishedAt` 公开投影，不返回租户、HC、职级或内部状态引用。
- 门户投递复用 `POST /recruitment/applications`。BFF 固定 `sourceChannel=portal` 和授权版本、目的及期限；租户只来自服务令牌，浏览器不得上报租户、渠道或授权期限。
- 候选人姓名、手机、邮箱继续由 Recruitment 独立密钥域加密并以盲索引去重；公开响应只返回申请标识。Web 精确校验 `CAREERS_PUBLIC_ORIGIN`，生产入口必须先删除客户端同名头，再注入 `x-gaoq-edge-verification` 与 `CAREERS_CLIENT_IP_HEADER` 指定的受控来源地址头；禁止信任 `x-forwarded-for` 链。
- 招聘投递限流使用 `CAREERS_RATE_LIMIT_REDIS_URL` 对来源地址 SHA-256 摘要执行十分钟共享窗口，多副本与重启状态一致；Redis、入口验证 Secret 或来源地址不可用时失败关闭。OAuth Token 请求、只读请求和带 `Idempotency-Key` 的写请求分别使用 3/5/8 秒上限；只读与幂等写最多重试一次，非幂等写禁止重试。
- 当前门户建立候选人档案与职位申请；简历附件上传仍须经“病毒扫描 → 对象存储 → `candidate_resume` 附件登记”证据链交付，未完成该网关前不得把联系人投递描述为已上传简历原件。
| 合同完成与入职转化 | Webhook/应用命令 | `esign.flow.completed.v1`、`onboarding.completed.v1` | 只读状态，不提供终态执行 Tool | R2/R3 |

### 5.2 智能简历库

- ERP 管理端 `/workspace/recruitment` 展示候选人简历分析状态、去标识化结构履历、AI 建议标签及置信度；招聘人员可确认、驳回或从受控词表补充标签。只有 `confirmed` 标签进入正式人才检索，`suggested` 不驱动自动化。
- 分析请求只接受候选人 ULID 与不可解释 `resumeEvidenceId`。租户来自已验证身份；应用服务还会校验候选人处于 `active`、授权未过期且未到保留期限。证据 ID 必须由隔离网关再次校验候选人归属，禁止客户端 URL、对象路径或下载 Token。
- 招聘渠道 EvidenceVerifier 返回非空 `resumeSnapshotId` 后，渠道 Worker 自动以稳定幂等键创建分析任务；没有简历证据时不创建。门户或人工上传后续也必须复用同一受信任证据窄入口，不能由浏览器伪造“已扫描”状态。
- `RECRUITMENT_RESUME_SOURCE_ENDPOINT` 对应的独立网关必须先完成归属校验、恶意文件扫描、文本提取与直接身份信息去除，并逐字回显可信 `tenantId`、`candidateId`、`resumeEvidenceId`，返回 `malwareScanStatus=clean`、`piiRedacted=true` 和内容 SHA-256 base64url 摘要。ERP 只连接无用户信息、查询和片段的 HTTPS 443 端点，禁止重定向；响应必须是 256 KiB 内的 UTF-8 `application/json`。正文经 NFKC 后再次检查直接身份信息，只存在于 Worker 当前内存，不写 Mongo、审计、Outbox、日志或幂等快照。
- Worker 通过 OpenAI Responses API 调用部署指定模型，强制 `store:false`、`max_output_tokens`、严格 JSON Schema 与基于租户/候选人不可逆摘要的 `safety_identifier`；不得把原始 ERP 标识放入该字段。响应必须是单一 `completed` `output_text`，拒答、未完成、多输出、超大或非 JSON 响应全部失败关闭，本地仍以 Zod、NFKC 后直接标识检查和受控词表二次验证。模型只能从 `RECRUITMENT_RESUME_TAG_TAXONOMY` 选择标签。`store:false` 不等于零保留承诺；生产启用前仍须完成数据处理协议、区域、滥用监控与应用状态保留策略评审，如组织已获批 Zero Data Retention，应在对应 API Project 启用并保存外部验收证据。
- 模型禁止推断或输出姓名、联系方式、年龄、性别、民族、婚育、宗教、健康、照片和证件信息；禁止输出录用/淘汰、适配度和候选人排序。AI 只生成职业结构摘要与分类建议，不能改变申请阶段或候选人状态。
- REST 最小 Scope 分离为 `erp:recruitment:resume:analyze`、`erp:recruitment:resume:read` 与 `erp:recruitment:resume:review`。请求分析和标签复核分别强制 `Idempotency-Key`；复核还强制 `If-Match`。Worker 使用 `erp:recruitment:resume:process` 服务身份。
- BullMQ JobId 使用可信租户与分析 ID 的 SHA-256 base64url 确定性摘要，既实现同一任务去重，也避免跨租户碰撞和业务标识外露；Processor 在进入租户上下文前验证作业名、严格载荷和 JobId。`queued` 及未耗尽五次尝试的 `failed` 分析可恢复入队，处理认领与完成/失败均绑定 `status + version` 租约；租约丢失时禁止覆盖新终态或重放外部模型调用。
- 集合 `recruitment_resume_analyses` 只保存候选人/证据引用、来源摘要、非 PII 结构结果、标签决策、模型标识、失败码和保留期；不保存简历正文或联系方式。索引通过 `phase-3-recruitment-resume-indexes-v1` 独立追加迁移交付。
- 请求和复核事务分别发布 `cn.gaoq.erp.recruitment.resume_analysis.requested.v1` 与 `cn.gaoq.erp.recruitment.resume_analysis.reviewed.v1`；事件只含分析、候选人、简历证据引用、状态、版本和已确认标签计数，不含结构履历、标签明细、置信度或正文。AI 完成但尚未人工确认不发布跨域可消费事实。
- 当前代码已交付 API、BullMQ Worker、来源/OpenAI 适配器、管理页面、受控词表与迁移；Service、REST Controller、Processor、Queue 和两类外部适配器均建立逐文件四维 90% 不可回退门禁。真实简历隔离网关、OpenAI API Project/Secret、ZDR 或其他获批保留策略、代表性中文/英文简历评测和招聘 UAT 仍待现场配置与验收。`RECRUITMENT_RESUME_AI_PROVIDER=disabled` 时失败关闭。

### 5.3 HC 审批模板与 Saga 契约

- Approval 必须预先发布唯一编码 `recruitment_hc` 的 R2 模板；表单字段固定为 `requisition_id`、`department_id`、`position_title`、`headcount`、`justification`。发布前必须验证部门负责人、HRBP 和财务/编制负责人解析规则。
- 提交链路使用一个客户端根幂等键派生审批创建、审批提交和招聘绑定三个幂等步骤。跨域调用不嵌套 Mongo 事务；任一步崩溃后以同一根键重试，必须回到同一审批实例。
- Recruitment 只能通过 Approval 应用服务的专用 Scope 读取 `recruitment_hc` 状态摘要，不读表单原文；仅 `approved/rejected` 终态可以驱动 HC。
- 一份 HC 对应一个业务职位，职位标题、部门和人数从 HC 锁定继承；多招聘渠道发布使用外部映射，不复制业务职位。

### 5.4 Offer 审批、发送与证据契约

- 管理端端点固定为 `POST /recruitment/applications/:applicationId/offers`、`GET /recruitment/offers/:id`、`POST /recruitment/offers/:id/submit`、`POST /recruitment/offers/:id/sync-approval` 和 `POST /recruitment/offers/:id/send`。所有写接口强制 `Idempotency-Key` 与强 `If-Match`；发送返回 202 和 `sending`，不接收客户端提交的投递证据。
- Approval 必须预先发布唯一编码 `recruitment_offer` 的 R2 模板。字段固定为 `offer_id`、`application_id`、`department_id`、`currency`、`monthly_base_salary_minor`、`salary_months`、`annual_variable_target_minor`、`signing_bonus_minor`、`proposed_start_date`、`probation_months`、`employment_type`、`work_location`、`benefits_summary`。薪酬、地点和福利字段按 L4 配置；审批实例正文加密，Recruitment 只从专用状态接口读取终态摘要。
- 当前财务值对象只启用 ISO 4217 `CNY`；金额字段均为非负安全整数分，月基本工资必须大于零。扩展其他币种前必须同时补充最小货币单位、舍入、汇率权威源和财务对账规则，不能只放宽三字母正则。
- Offer 条款使用 Recruitment L4 密钥域 AES-256-GCM 整体加密，AAD 绑定租户、`offer_terms` 和 Offer ID。数据库、列表、REST 响应、审计、Outbox、日志及 MCP 均不得保存或返回条款原文。
- 创建 Offer 必须以申请强版本引用该申请已完成面试；提交审批在同一 Recruitment 事务内将申请推进到 `offer_approval`。审批拒绝将申请推进到 `rejected`；可信投递证据将申请推进到 `offer_sent`；候选人接受/拒绝分别推进到 `offer_accepted`/`withdrawn`。
- 审批创建、审批提交和 Offer 绑定由客户端根幂等键派生三个不同幂等键；通用幂等层只保存请求 SHA-256 与脱敏响应，不保存 L4 请求正文。投递、候选人决定和 eSign 完成仅通过应用服务的专用内部 Scope 调用，不注册普通管理端 REST。
- 投递与候选人决定写入 `recruitment_offer_evidence` 不可变账本。调用方只能提交 SHA-256 base64url 回执摘要、外部事实时间及必要内部引用；证据 ID 由 Recruitment 生成，客户端不得自报。每个 Offer 最多一条投递证据和一条候选人决定证据，摘要在租户内不可复用；候选人决定还必须匹配 Offer 的 `candidateId` 并引用门户认证证据。

### 5.5 Recruitment MCP 首批能力

- Resource Templates：`erp://recruitment/applications/{id}` 与 `erp://recruitment/offers/{id}`。Tools：`recruitment_application_get`、`recruitment_requisition_get`、`recruitment_position_get`、`recruitment_interview_get`、`recruitment_offer_get`，全部为 R0 脱敏查询并复用 Recruitment 应用服务与部门数据范围。
- 写工具只交付无 L3/L4 正文的 `recruitment_requisition_submit_prepare/execute`（R2）、`recruitment_position_transition_prepare/execute`（R1）和 `recruitment_offer_send_prepare/execute`（R2）。确认账本只固化业务 ULID、预期版本和目标状态；执行幂等键由 `operationId` 派生。
- Offer 发送 execute 只形成 `sending` 意图，不形成 `sent` 事实；AI 不得调用投递回写、候选人接受/拒绝、eSign 完成或入职终态方法。
- 候选人创建、面试安排/评价和 Offer 条款创建含 L3/L4 原文。在服务端加密草稿引用机制交付前不注册对应 MCP 写工具，禁止为追求能力数量把原文写入 `mcp_operation_confirmations.commandJson`。

### 5.6 Onboarding MCP 首批能力

- Resource Template 固定为 `erp://onboarding/instances/{id}`，只读 Tool 固定为 `onboarding_get`；两者复用 Onboarding 应用服务、OAuth 身份、租户边界、部门数据范围和审计。
- 输出仅含任务 `pending/completed` 状态、组织引用、拟入职业务日期、聚合状态、Employment 引用与版本；不得返回合同、身份材料、培训内容或各任务证据标识。
- `onboarding_progress_guide` 明确提示 AI 不得索取证据原文、代报任务完成或执行劳动关系建档。完成建档属于 R3，永不注册 MCP Tool。
- 在材料证据注册表、Identity/Knowledge 可信证明接口和相应消费者验收完成前，不注册入职任务写 Tool；不能让 AI 用任意字符串伪造证据引用。
- Recruitment → Onboarding 只通过窄应用服务桥交互。创建预入职实例要求 Offer
  已接受且具备候选人接受证据；推进 `hired` 还必须要求 Offer 已签署并具备签署
  证据，禁止仅凭 `accepted` 状态形成劳动关系终态。
- 桥接服务必须复核返回 Offer、申请、候选人和职位的可信租户、查询主键，以及
  Offer → Application → Candidate/Position/Interview/Acceptance Evidence 完整
  引用闭包；任一错位整体失败关闭并进入人工复核，不能只信任仓储查询条件。
- `preboarding` 阶段事件的证据引用固定为 Onboarding 实例；`hired` 阶段事件的
  证据引用固定为 Onboarding 完成证据，Employment ID 作为独立结果引用保存。
  完成证据与劳动关系标识不得混用。
- 读取和推进分别只接受受信任服务 Scope
  `erp:onboarding:recruitment:read` 与
  `erp:onboarding:recruitment:advance`。该跨域写路径不注册标准 MCP Tool；
  `pnpm quality:recruitment-onboarding-bridge-coverage` 对桥接服务逐文件强制
  语句、分支、函数和行四维 90%。
- Onboarding 仓储使用固定最小投影反向绑定可信租户、实例/Offer/候选人查询
  主键、任务证明、状态、版本和时间闭包；候选人时间线最多返回 100 条，并验证
  稳定顺序和唯一标识。聚合与证明写入必须使用活动 Mongo 事务，创建及更新回执
  须反向绑定不可变引用和目标终态；`pnpm quality:onboarding-repositories-coverage`
  对该边界逐文件强制语句、分支、函数和行四维 90%。

### 5.7 Knowledge 与 Care MCP

- Knowledge 只读 Resource/Tool 仅返回课程发布摘要和培训任务进度；不得返回内容引用、题库引用、答卷提交、评分证据或完成证据。评分、完成和 Onboarding 证明回填不注册 MCP。
- Knowledge 内容校验与考试编排通过独立 HTTPS 证据网关：部署必须成套注入 `KNOWLEDGE_EVIDENCE_GATEWAY_ENDPOINT`、独立 Bearer Token、Ed25519 SPKI DER base64 公钥与签名 Key ID。内容校验端点固定为 `/v1/courses/verify`；最终成绩只允许经后述 `/v1/exam-runs/*` 状态机形成，不保留同步评分旁路。请求先经严格 Schema 拒绝未知字段，只含可信租户、课程/任务/运行/提交引用与摘要；`Idempotency-Key` 必须绑定固定 path 与严格解析后的完整请求 JSON，人工复核状态查询还必须绑定 `reviewEvidenceId`。主观题或混合题的 `/finalize` 只能返回 `pending_review`；`/status` 的待复核或已评分回执必须回显同一 `reviewEvidenceId`，客观题直接评分则必须显式返回 `reviewEvidenceId:null`。HTTP 请求正文最大 128 KiB；回执使用严格 16 KiB JSON、每次 5 秒超时，只有网络异常或 502/503/504 可用同一幂等键重试一次。HTTP 200 回执头必须携带 `x-knowledge-evidence-key-id` 与 `x-knowledge-evidence-signature`，签名原文固定为 `knowledge-evidence-receipt-v1\n<keyId>\n<rawBodySha256Base64url>`；响应只接受无压缩或 `identity` 编码，Content-Type、Content-Length、Fatal UTF-8、规范 Base64、Key ID、公钥类型、原始响应正文签名或请求字段任一不匹配均失败关闭，异常响应正文必须取消且不得进入日志。答卷、题库、标准答案、上游 Token 和任意下载地址不得进入 ERP 请求、响应、日志或 MCP。
- 本人全文检索 REST 固定为 `GET /knowledge/search?query=<text>&cursor=<opaque>&limit=<1..20>`，Scope 固定为 `erp:knowledge:search`。主体、租户、员工、有效任职、部门和岗位只从已验证身份、Access Profile、Employee 与 Employment 解析；客户端不得提交这些授权字段。查询 NFKC 规范化后仅允许 2–128 个中英文、数字、空格和 `._-`，禁止搜索 DSL、动态字段、排序与过滤。已过期分配不授权；任职受众在同一维度内 OR、部门与岗位维度间 AND。搜索网关返回后，应用服务仍按当前已发布最高修订、允许课程 ID 与修订号逐项失败关闭，审计只记录数量、上限和是否有下一页，不记录查询或片段。
- 搜索网关必须成套注入 `KNOWLEDGE_SEARCH_GATEWAY_ENDPOINT`、独立 Bearer Token、独立 Ed25519 SPKI DER base64 公钥与 Key ID；Adapter 每次调用均二次校验标准 HTTPS 根地址、可见 ASCII 凭据、规范公钥和 Key ID，Origin、服务身份、公钥及 Key ID 不得与评分网关复用。端点固定为 `/v1/search`、`/v1/indexes/courses/upsert` 与 `/v1/indexes/courses/delete`。请求经严格 Schema、NFKC 查询白名单、唯一授权集合和受众组合校验，只含可信授权投影、允许课程版本集合、授权摘要、受控查询或内容引用；正文、对象路径、下载 Token、用户 Token 和上游凭据禁止发送。回执头固定为 `x-knowledge-search-key-id` 与 `x-knowledge-search-signature`，签名原文固定为 `knowledge-search-receipt-v1\n<keyId>\n<rawBodySha256Base64url>`；请求最大 128 KiB，回执严格 16 KiB，Content-Type/Content-Length/流读取/Fatal UTF-8 任一异常均以稳定错误码失败关闭并尽力取消正文，每次请求 5 秒、同一幂等键最多重试一次。结果片段最长 512 字符，禁止控制字符和 `<>&`，偏移高亮必须有序、不重叠且位于片段内；部分结果标志只能为 `false`。
- 课程发布和下架分别发布 `cn.gaoq.erp.knowledge.course.published.v1` 与 `cn.gaoq.erp.knowledge.course.retired.v1`，并在同一 Mongo 事务向 `knowledge_search_index_tasks` 写入 `upsert/delete` 任务；事件和任务只含课程业务键、修订、版本、内容引用与受众投影，不含正文或成员列表。Mongo 是待处理事实源，BullMQ 只按固定空载荷每 60 秒唤醒 Worker；任务按 eventId 和课程版本/操作双重幂等，最多 8 次指数退避，死信不得自动伪装成功。
- 指标固定为 `gaoq_knowledge_search_index_delivery_total{operation,outcome}`、`gaoq_knowledge_search_index_convergence_seconds{operation}` 与 `gaoq_knowledge_search_index_last_success_timestamp_seconds{operation}`，禁止使用租户、员工或课程标签。追加索引、只读对账和显式重建命令见 [Phase 3 生产索引迁移 Runbook](./01-index-migration-runbook.md)；每门课程只有最高仍发布修订重建为 `upsert`，旧修订和已下架版本重建为 `delete`。
- 标准 MCP Tool 固定为 `knowledge_search`，Resource Template 固定为 `erp://knowledge/search/{query}`，Prompt 固定为 `knowledge_search_guide`；三者复用 `KnowledgeApplicationService.searchMyKnowledge`，固定 R0、相同 Scope、上限与游标，不直接访问 Mongo 或搜索网关，不接受 tenantId、employeeId、部门、岗位或权限投影。
- 课程考试策略随版本不可变地保存 `questionMode/timeLimitMinutes/maxAttempts/gradingPolicyVersion/passingRule/gradingSlaMinutes/manualReviewSlaMinutes`；主观题与混合题强制人工复核。可靠写路径固定为 `POST /knowledge/assignments/:id/exam-runs` 与 `POST /knowledge/exam-runs/:id/submit`，只读路径固定为 `GET /knowledge/exam-runs/:id`；写入必须分别校验 `Idempotency-Key` 及强 `If-Match`，客户端成绩、题目和答案一律拒绝。
- 考试评分网关追加固定端点 `/v1/exam-runs/start`、`/v1/exam-runs/timeout`、`/v1/exam-runs/finalize`、`/v1/exam-runs/status`。Mongo 考试运行是唯一事实源，BullMQ 只空载荷唤醒；到时由受信网关形成超时提交，最多 8 次退避后死信，连续 5 次失败熔断 30 秒。最终尝试、运行终态和 Outbox 事件必须同事务形成；审计提交后故障不得回写业务失败。
- 考试运行事件固定为 `requested/started/submitted/timed_out/review_pending/graded/dead/replayed` 八类 v1 CloudEvent，事件禁止携带题库、会话、提交、试题集或评分证据引用；`replayed` 只额外携带受控原因码。标准只读 MCP 固定为 `knowledge_exam_run_get`、`erp://knowledge/exam-runs/{id}` 与 `knowledge_exam_run_status_guide`，复用应用服务并校验本人有效任职；AI 不开放开始、提交、评分、人工复核或重放。
- H5 本人任务目录由服务端按可信主体映射有效员工授权快照与当前任职关系，不接受客户端 employeeId、onboardingInstanceId 或 tenantId；返回字段与 Knowledge MCP 同样执行内容、题库、答卷和证据脱敏。
- Care Resource Template 固定为 `erp://care/cases/{id}`，Tool 固定为 `care_case_get`。输出仅含员工/劳动关系引用、最后工作日、计划失效时刻、清算任务状态和版本；离职原因、审批实例与所有证据引用均不进入 MCP。校友授权到期执行属于 Worker 内部能力，不注册 REST 或 MCP Tool。
- `care_offboarding_progress_guide` 必须明确禁止 AI 审批、代报清算证据、关闭劳动关系或停用身份；Care 不注册写 Tool。
- 关怀只读 MCP 固定为 Tool `care_occasion_summary_get_self`、Resource Template `erp://care/occasions/mine` 和 Prompt `care_occasion_summary_guide`；只返回本人偏好开关与 pending/delivered/dead 计数，不返回生日、具体计划日期、员工标识、联系方式、模板、正文或送达证据。AI 不注册偏好修改、退订、渠道授权、发送、对账或重放 Tool。

### 5.8 Talent Lifecycle 360

- ERP 管理端 `/workspace/talent-lifecycle` 提供人才列表、阶段筛选、跨域时间线、开放跟进、下一步行动和服务记录；列表只搜索候选人标识、授权可见姓名及职位名称，部门数据范围继续由各权威域应用服务裁剪。没有 `read_all` 的主体只读取本人负责的服务触点，避免跨责任人备注明文泄露。
- 只读端点固定为 `GET /talent-lifecycle/people` 与 `GET /talent-lifecycle/people/:candidateId`，要求 `erp:talent-lifecycle:read`。创建触点固定为 `POST /talent-lifecycle/people/:candidateId/touchpoints`，关闭固定为 `POST /talent-lifecycle/touchpoints/:id/close`，同时要求读 Scope 与 `erp:talent-lifecycle:touchpoint:write`。
- 创建与关闭分别发布 `cn.gaoq.erp.talent.touchpoint.created.v1`、`cn.gaoq.erp.talent.touchpoint.completed.v1` 或 `cn.gaoq.erp.talent.touchpoint.cancelled.v1`。事件只含候选人/聚合引用、版本、受控类型/渠道/结果、状态、发生时间和下一行动时间，不含姓名、联系方式、备注、负责人或方向。
- MCP Resource Template 固定为 `erp://talent-lifecycle/people/{candidateId}`，Tool 固定为 `talent_lifecycle_get`，Prompt 固定为 `talent_lifecycle_follow_up_guide`。输出仅含候选人引用、生命周期阶段、当前申请阶段、员工状态、开放跟进数、下一行动时间和更新时间。
- MCP 不提供触点创建、关闭、候选人分类、录用、入职、离职或校友联系写能力；AI 只能基于最小只读投影给出人工跟进建议。
- 四域来源完整性由 `pnpm quality:talent-lifecycle-sources-coverage` 独立门禁覆盖，
  四个生产查询口逐文件语句、分支、函数和行均不得低于 90%；MCP 继续只复用
  `TalentLifecycleService.getForMcp`，不得直接调用四域仓储或绕过引用闭包校验。
- REST 写入口和事务 Outbox 分别由
  `pnpm quality:talent-lifecycle-entry-coverage` 与
  `pnpm quality:talent-lifecycle-outbox-boundary-coverage` 独立门禁覆盖，两个
  生产文件逐文件语句、分支、函数和行均不得低于 90%；标准 MCP 不因此新增
  触点写入、Outbox、重放或人工处置 Tool。
- 当前代码已交付跨域应用服务投影、加密触点、REST、Outbox、MCP、管理页面和独立索引迁移；生产数据迁移、权限角色映射、代表性全周期数据回放及 HR/员工关怀/校友 UAT 仍待现场执行。

## 6. 发布门禁

- 跨租户、越权、授权撤回后继续处理、盲索引误合并、知识证据回执错位、标准答案泄漏、未知 e签状态自动推进任一出现即 No-Go。
- 招聘渠道、日历、短信/邮件、e签宝、对象存储和病毒扫描必须在真实沙箱完成权限、限流、轮换、重试、回执和对账。
- 候选人到 Employment 的端到端链路、重复事件、乱序回调、Worker 崩溃、数据到期和实体签署证据恢复必须通过。
- 生产索引只增不删，迁移具备 dry-run、锁、清单校验和、快照恢复与执行后复验。
