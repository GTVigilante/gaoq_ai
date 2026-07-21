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
| `TrainingAssignment` / `ExamAttempt` | Knowledge | 进度由服务端事件计算；学员接口和 MCP 永不返回标准答案 |
| `CareCase` / `AlumniConsent` | Care | 权限失效与离职日期绑定；校友联系有目的、授权、到期时间和撤回清理 |

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

统一 `ESignAdapter`：`createFlow / getFlow / signUrl / downloadFile / verifyWebhook`。Webhook 只做来源限制、签名和 ±5 分钟时间窗校验、可信企业映射租户、加密写 inbox、快速返回；异步 Worker 按 `eventId` 幂等并按外部时间应用。

内部状态为 `draft → sent → partial_signed → completed`，分支为 `rejected/expired/cancelled/unknown`。未知状态告警且不推进。每 15 分钟补拉长期未更新流程；完成 PDF 存入受控对象存储并记录 SHA-256、供应商证据引用和归档时间。

## 5. REST、事件与 MCP 同步交付

每个用例必须同时登记以下四类契约：

1. REST：强 `If-Match`、`Idempotency-Key`、稳定错误码、Scope 和字段投影。
2. 事件：CloudEvents 1.0、事务 Outbox、无个人原文、消费者幂等和版本。
3. MCP：Resource/Tool JSON Schema、风险等级、确认链、脱敏输出和客户端兼容测试。
4. 审计：动作、资源、风险、目的、授权/审批/强认证引用和结果；禁止个人原文。

首批能力：

| 用例 | REST | 事件 | MCP | 风险 |
| --- | --- | --- | --- | --- |
| 创建与提交 HC | `POST /recruitment/requisitions` 及 `/:id/submit` | `recruitment.requisition.created/submitted.v1` | `recruitment_requisition_create/submit_prepare/execute` | R1/R2 |
| 同步 HC 审批 | `POST /recruitment/requisitions/:id/sync-approval` | `recruitment.requisition.approved/rejected.v1` | 只读查询，不接受 AI 上报 outcome | R2 |
| 创建与发布职位 | `POST /recruitment/requisitions/:id/positions` 及 `POST /recruitment/positions/:id/status` | `recruitment.position.created/status_changed.v1` | `recruitment_position_create/transition_prepare/execute` | R1 |
| 创建候选人及申请 | `POST /recruitment/applications` | `recruitment.application.created.v1` | `recruitment_application_create_prepare/execute` | R1 |
| 查询候选人状态 | `GET /recruitment/applications/:id` | 无 | Resource + `recruitment_application_get` | R0 |
| 安排面试 | `POST /recruitment/applications/:id/interviews` | `recruitment.interview.scheduled.v1` | prepare/execute | R1 |
| 提交面试评价 | `POST /recruitment/interviews/:id/feedback` | `recruitment.interview.feedback_submitted.v1` | prepare/execute | R1 |
| 形成/发送 Offer | Offer 资源端点 | `recruitment.offer.*.v1` | 仅准备与查询；发送为 R2 | R2 |
| 合同完成与入职转化 | Webhook/应用命令 | `esign.flow.completed.v1`、`onboarding.completed.v1` | 只读状态，不提供终态执行 Tool | R2/R3 |

### 5.1 HC 审批模板与 Saga 契约

- Approval 必须预先发布唯一编码 `recruitment_hc` 的 R2 模板；表单字段固定为 `requisition_id`、`department_id`、`position_title`、`headcount`、`justification`。发布前必须验证部门负责人、HRBP 和财务/编制负责人解析规则。
- 提交链路使用一个客户端根幂等键派生审批创建、审批提交和招聘绑定三个幂等步骤。跨域调用不嵌套 Mongo 事务；任一步崩溃后以同一根键重试，必须回到同一审批实例。
- Recruitment 只能通过 Approval 应用服务的专用 Scope 读取 `recruitment_hc` 状态摘要，不读表单原文；仅 `approved/rejected` 终态可以驱动 HC。
- 一份 HC 对应一个业务职位，职位标题、部门和人数从 HC 锁定继承；多招聘渠道发布使用外部映射，不复制业务职位。

## 6. 发布门禁

- 跨租户、越权、授权撤回后继续处理、盲索引误合并、标准答案泄漏、未知 e签状态自动推进任一出现即 No-Go。
- 招聘渠道、日历、短信/邮件、e签宝、对象存储和病毒扫描必须在真实沙箱完成权限、限流、轮换、重试、回执和对账。
- 候选人到 Employment 的端到端链路、重复事件、乱序回调、Worker 崩溃、数据到期和实体签署证据恢复必须通过。
- 生产索引只增不删，迁移具备 dry-run、锁、清单校验和、快照恢复与执行后复验。
