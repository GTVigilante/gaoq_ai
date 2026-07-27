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
- 校友联系必须有明确目的、渠道、授权版本、授予时间和不超过五年的到期时间；撤回后立即停止非必要联系，不得复用员工在职授权。

### 2.2 人才全周期与服务追踪

- Talent Lifecycle 是跨域只读投影和服务触点权威，不改写 Recruitment、Onboarding、Org、Care 的业务事实。`Candidate → Person → Employment` 引用构成人才身份主线；同一候选人的多次申请、复聘和多段劳动关系都保留在同一主线下。
- 生命周期阶段按 `离职处理中 → 在职 → 入职中 → Offer → 招聘中 → 校友 → 曾任员工 → 人才库 → 停用` 的优先级从权威状态推导，不能由浏览器或 AI 直接设置。
- 服务触点只保存受控类型、渠道、方向、结果、责任人、发生时间和下一步行动；自由备注使用 Recruitment L3 密钥域、`talent_touchpoint` AAD 加密。索引、日志、审计、Outbox 和幂等响应快照均不得包含备注明文；关闭操作必须先用候选人引用和责任人非敏感投影完成授权，再解密完整记录。
- 候选人招聘联系要求候选人仍为 `active`，且联系授权与保留期限均未过期。校友活动和复聘联系还必须存在目的匹配、渠道匹配且未过期的有效 `AlumniConsent`；撤回后只允许记录内部撤回事实，不得继续外呼。
- 关闭开放跟进要求强 `If-Match`、幂等键和责任人校验；跨责任人关闭仅允许 `erp:talent-lifecycle:touchpoint:write_all`。

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
- Worker 只从队列的租户与 Inbox ULID 建立系统身份；Normalizer 输出不合约进入人工复核，证据校验、职位映射、领域写入或回执失败则保留 Inbox 并重试。
- 通用 REST 创建申请禁止自报 `consent.source=channel`；只有具备 `erp:recruitment:channel:ingest` 的 `system_job` 可调用渠道窄接口。回执使用稳定幂等键，成功回执只保存盲指纹证明。
- EvidenceVerifier 形成的同意证据 ULID 必须先固化为 Inbox 检查点，再原样贯穿 Candidate、ConsentEvidence 与 Application；崩溃重试复用检查点，不得重复生成或由领域写入层另造“可信证据”。失败 BullMQ 确定性任务必须显式 `retry`，不能依赖重复 `add`。
- 职位开放/暂停/关闭及申请阶段变化分别由事务 Outbox 投影为独立投递轨迹。申请阶段按聚合版本顺序映射为 `screening/interview/offer/hired/rejected/withdrawn`，回执 Worker 仅用 `erp:recruitment:channel:ack` 读取来源渠道窄投影；渠道只接收阶段，不接收淘汰原因、评价、Offer 条款或证据正文。

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
- 外部事件标题固定为无候选人信息的“招聘面试”；仅在业务必要范围向日历平台发送时间、时区、地点和已验证面试官外部 ID，审计、日志和 Outbox 均不得记录地点明文。

### 4.3 e签宝

统一出站 `ESignAdapter`：`createFlow / getFlow / signUrl / downloadFile`；入站验签由独立 Webhook 边界完成。`POST /webhooks/esign` 禁止 query，对请求时间戳与 raw body 执行 HMAC-SHA256，只在验签后以唯一 appId 绑定解析租户；原文加密写 inbox 后原样返回供应商 200 契约。

内部状态为 `awaiting_signature → partial_signed → provider_completed → completed`，分支为 `rejected/expired/cancelled`。官方 action 白名单为 `SIGN_MISSON_COMPLETE` 和 `SIGN_FLOW_COMPLETE`，完成回调的 `signFlowStatus=2/3/5/7` 分别映射 `provider_completed/cancelled/expired/rejected`。未知 action 标记 Inbox `ignored`，未知状态或冲突终态设置 `reviewRequired`，均禁止自动前进或回退。

每 15 分钟补拉长期未更新流程。`provider_completed` 后仍必须下载 PDF、校验内容摘要和供应商签署结果、病毒扫描、存入不可变对象存储并写入证据账本。只有该证据交易成功后才进入 `completed` 并调用 Recruitment 应用服务标记 Offer `signed`。

- OpenAPI 只允许官方 `https://smlopenapi.esign.cn` 和 `https://openapi.esign.cn`，生产强制后者。请求按官方七段式字符串计算 Content-MD5 和 HmacSHA256；MD5 仅用于供应商协议兼容，ERP 证据统一使用 SHA-256。
- 补拉调用 `GET /v3/sign-flow/{id}/detail`；下载地址使用官方推荐的 `POST /v3/sign-flow/{id}/file-download-url`，有效期固定 300 秒；每个 PDF 再调用 `POST /v3/files/{fileId}/verify`。下载客户端禁止跳转，限定 eSign HTTPS 域名、50 MiB 上限和 `%PDF-` 魔数。
- `integration_esign_evidence` 仅保存供应商文件 ID 摘要、PDF SHA-256、大小、扫描证据、验签结果摘要、WORM 对象引用与回执；不保存 PDF、文件名、下载短链、证书或签署人原文。WORM `objectKey` 必须幂等；扫描或归档 Adapter 未装配时必须失败关闭。
- 扫描与 WORM 网关必须成套配置在独立 HTTPS 权限域。Adapter 出站前复算 PDF SHA-256，响应限制为 16 KiB 严格 JSON；扫描回执绑定摘要，WORM 回执同时绑定摘要、对象键、不可变标志和不少于十年的保留期。任一错位均不得推进 Offer `signed`。

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
| 人才全景与服务跟进 | `GET /talent-lifecycle/people`、`GET /talent-lifecycle/people/:candidateId`、服务触点创建/关闭端点 | `talent.touchpoint.created/completed/cancelled.v1` | Resource + `talent_lifecycle_get`；不注册写 Tool | R0/R2 |

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
- `RECRUITMENT_RESUME_SOURCE_ENDPOINT` 对应的独立网关必须先完成归属校验、恶意文件扫描、文本提取与直接身份信息去除，并返回 `malwareScanStatus=clean`、`piiRedacted=true` 和内容 SHA-256 base64url 摘要。正文只存在于 Worker 当前内存，不写 Mongo、审计、Outbox、日志或幂等快照。
- Worker 通过 OpenAI Responses API 调用部署指定模型，强制 `store:false` 与严格 JSON Schema；模型只能从 `RECRUITMENT_RESUME_TAG_TAXONOMY` 选择标签。生产启用前仍须完成数据处理协议、区域与保留策略评审；如组织已获批 Zero Data Retention，应在对应 API Project 启用。
- 模型禁止推断或输出姓名、联系方式、年龄、性别、民族、婚育、宗教、健康、照片和证件信息；禁止输出录用/淘汰、适配度和候选人排序。AI 只生成职业结构摘要与分类建议，不能改变申请阶段或候选人状态。
- REST 最小 Scope 分离为 `erp:recruitment:resume:analyze`、`erp:recruitment:resume:read` 与 `erp:recruitment:resume:review`。请求分析和标签复核分别强制 `Idempotency-Key`；复核还强制 `If-Match`。Worker 使用 `erp:recruitment:resume:process` 服务身份。
- 集合 `recruitment_resume_analyses` 只保存候选人/证据引用、来源摘要、非 PII 结构结果、标签决策、模型标识、失败码和保留期；不保存简历正文或联系方式。索引通过 `phase-3-recruitment-resume-indexes-v1` 独立追加迁移交付。
- 请求和复核事务分别发布 `cn.gaoq.erp.recruitment.resume_analysis.requested.v1` 与 `cn.gaoq.erp.recruitment.resume_analysis.reviewed.v1`；事件只含分析、候选人、简历证据引用、状态、版本和已确认标签计数，不含结构履历、标签明细、置信度或正文。AI 完成但尚未人工确认不发布跨域可消费事实。
- 当前代码已交付 API、BullMQ Worker、OpenAI 适配器、管理页面、受控词表与迁移；真实简历隔离网关、OpenAI API Project/Secret、ZDR 或其他获批保留策略、代表性中文/英文简历评测和招聘 UAT 仍待现场配置与验收。`RECRUITMENT_RESUME_AI_PROVIDER=disabled` 时失败关闭。

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

### 5.7 Knowledge 与 Care MCP

- Knowledge 只读 Resource/Tool 仅返回课程发布摘要和培训任务进度；不得返回内容引用、题库引用、答卷提交、评分证据或完成证据。评分、完成和 Onboarding 证明回填不注册 MCP。
- H5 本人任务目录由服务端按可信主体映射有效员工授权快照与当前任职关系，不接受客户端 employeeId、onboardingInstanceId 或 tenantId；返回字段与 Knowledge MCP 同样执行内容、题库、答卷和证据脱敏。
- Care Resource Template 固定为 `erp://care/cases/{id}`，Tool 固定为 `care_case_get`。输出仅含员工/劳动关系引用、最后工作日、计划失效时刻、清算任务状态和版本；离职原因、审批实例与所有证据引用均不进入 MCP。
- `care_offboarding_progress_guide` 必须明确禁止 AI 审批、代报清算证据、关闭劳动关系或停用身份；Care 不注册写 Tool。

### 5.8 Talent Lifecycle 360

- ERP 管理端 `/workspace/talent-lifecycle` 提供人才列表、阶段筛选、跨域时间线、开放跟进、下一步行动和服务记录；列表只搜索候选人标识、授权可见姓名及职位名称，部门数据范围继续由各权威域应用服务裁剪。没有 `read_all` 的主体只读取本人负责的服务触点，避免跨责任人备注明文泄露。
- 只读端点固定为 `GET /talent-lifecycle/people` 与 `GET /talent-lifecycle/people/:candidateId`，要求 `erp:talent-lifecycle:read`。创建触点固定为 `POST /talent-lifecycle/people/:candidateId/touchpoints`，关闭固定为 `POST /talent-lifecycle/touchpoints/:id/close`，同时要求读 Scope 与 `erp:talent-lifecycle:touchpoint:write`。
- 创建与关闭分别发布 `cn.gaoq.erp.talent.touchpoint.created.v1`、`cn.gaoq.erp.talent.touchpoint.completed.v1` 或 `cn.gaoq.erp.talent.touchpoint.cancelled.v1`。事件只含候选人引用、受控类型/渠道/结果、状态和版本，不含姓名、联系方式或备注。
- MCP Resource Template 固定为 `erp://talent-lifecycle/people/{candidateId}`，Tool 固定为 `talent_lifecycle_get`，Prompt 固定为 `talent_lifecycle_follow_up_guide`。输出仅含候选人引用、生命周期阶段、当前申请阶段、员工状态、开放跟进数、下一行动时间和更新时间。
- MCP 不提供触点创建、关闭、候选人分类、录用、入职、离职或校友联系写能力；AI 只能基于最小只读投影给出人工跟进建议。
- 当前代码已交付跨域应用服务投影、加密触点、REST、Outbox、MCP、管理页面和独立索引迁移；生产数据迁移、权限角色映射、代表性全周期数据回放及 HR/员工关怀/校友 UAT 仍待现场执行。

## 6. 发布门禁

- 跨租户、越权、授权撤回后继续处理、盲索引误合并、标准答案泄漏、未知 e签状态自动推进任一出现即 No-Go。
- 招聘渠道、日历、短信/邮件、e签宝、对象存储和病毒扫描必须在真实沙箱完成权限、限流、轮换、重试、回执和对账。
- 候选人到 Employment 的端到端链路、重复事件、乱序回调、Worker 崩溃、数据到期和实体签署证据恢复必须通过。
- 生产索引只增不删，迁移具备 dry-run、锁、清单校验和、快照恢复与执行后复验。
