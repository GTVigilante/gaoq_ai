# 仓库实施完成度审计

- 审计日期：2026-07-28
- 审计对象：Phase 0–6、开放 Issue、当前堆叠 Draft PR 与 GitHub 治理配置
- 结论：应用、契约、迁移控制面、生产门禁、Helm/Kubernetes 编排和标准 MCP
  已形成仓库实施基线；真实外部联调、目标环境演练、UAT、切换与 Hypercare
  尚未完成。Phase 0 的 GitHub Project 因最小权限未授权而未配置，其余关键
  链路 90% 证据也尚未全部建立，因此所有 Phase 均不得标记生产完成。

本审计只判断“仓库是否已有可执行实现”，不把本地自测、静态校验器或模拟证据
冒充现场验收。Issue 在外部证据齐全前保持 OPEN。

## 1. 状态定义

| 状态 | 判定标准 | GitHub 表达 |
|---|---|---|
| 仓库实施已交付 | 有代码、测试、契约、运行手册或失败关闭校验器，并能从仓库路径复核 | `status:implementation-delivered` |
| 外部验收待完成 | 需要真实系统、目标基础设施、生产等价数据、业务 UAT、人工签署或持续运行证据 | `status:external-acceptance`，Issue 保持 OPEN |
| 治理阻塞 | 需要扩展账号权限或用户决策，仓库实现不能替代 | `status:blocked`，正文写明解除条件 |
| 生产完成 | 代码、CI、现场证据、签署、合并和 DoD 全部满足 | 当前没有任何 Phase 达到 |

## 2. Phase 审计

| Phase | 仓库实施证据 | 尚缺外部证据 | 结论 |
|---|---|---|---|
| 0 | `docs/phase-0/`、Issue 模板、7 个 Milestone、标签及 Draft PR 流程 | Issue #41 的 GitHub Project 需要 `project` 权限；全仓覆盖率已达到 80%，其余关键链路 90% 证据尚未全部建立 | 未满足退出条件 |
| 1 | `apps/erp-api/src/modules/auth/`、`org/`、`security/`、`integration/`，`deploy/helm/`，Phase 1 工作流 | 境内云 VPC、WAF/KMS、真实 SSO/组织下发、监控告警、备份恢复与 RPO/RTO 演练 | 实施已交付，外部验收待完成 |
| 2 | `apps/erp-api/src/modules/approval/`、审批前端、通知、迁移与 MCP 能力 | 氚云模板/历史/在途审批真实盘点迁移、三次演练和业务签署 | 实施已交付，外部验收待完成 |
| 3 | 招聘、eSign、Onboarding、Knowledge、Care、Talent Lifecycle 360 及对应 REST/事件/MCP | 真实渠道、e签宝、对象/WORM、OpenAI/搜索/评分/通知、CRM/校友平台与跨角色 UAT | 实施已交付，外部验收待完成 |
| 4 | 考勤事实、规则/排班、Provider 覆盖对账、版本化薪酬、审批、银行/税务、对账、影子周期控制面及 MCP | 真实考勤/专业算薪联调、银行/税务沙箱、两个完整影子周期、差异清零和财务签署 | 实施已交付，外部验收待完成 |
| 5 | OP、移动端、分析、迁移控制面、性能/安全/容灾/供应链/MCP/Go-No-Go 校验器 | 三轮生产等价实测、真实外部连接、DAST/ASVS、业务 UAT 和十方签署 | 实施已交付，外部验收待完成 |
| 6 | 切换、回滚、部署、平台准入、Hypercare 证据契约和受保护工作流 | 三次全量演练、生产级回滚、统一切换、四周 Hypercare 与旧系统归档批准 | 实施已交付，外部验收待完成 |

## 3. 未完成 Issue 的实施证据

下表列出此前只有外部验收标签、但仓库已经具备实施控制面的工作项。添加
`status:implementation-delivered` 只确认这些路径存在，不勾选其现场验收清单。

| Issue | 仓库实施证据 | 必须保留的外部边界 |
|---|---|---|
| #12 云平台、CI/CD、监控与灾备 | `deploy/helm/gaoq-erp/`、`deploy/helm/gaoq-platform-guardrails/`、`docs/phase-5/17-resilience-rehearsal-gate.md`、`scripts/resilience/validate-phase-5-resilience-evidence.mjs` | 真实 VPC/WAF/KMS/短期 CI 身份、观测平台、备份恢复及 RPO/RTO |
| #19 氚云审批模板迁移与 UAT | `apps/erp-api/src/modules/data-migration/`、`docs/phase-5/09-data-migration-control-plane.md`、`docs/phase-5/11-data-migration-package-runbook.md` | 真实模板、历史、在途实例、附件、三轮迁移与业务签署 |
| #31 两个薪资影子周期 | `apps/erp-api/src/modules/payroll/application/payroll-shadow.service.ts` 及对应测试、`docs/phase-5/20-readiness-verdicts.md` | 两个真实完整周期、100% 覆盖、零未解释差异、薪酬与财务签署 |
| #37 三次全量迁移演练 | `docs/phase-5/12-data-migration-rehearsal-gate.md`、`scripts/migration/validate-phase-5-migration-rehearsal-evidence.mjs`、`.github/workflows/phase-5-migration-rehearsal.yml` | 三份独立生产等价证据、8 小时窗口和四方签署 |
| #38 回滚与 Go/No-Go | `docs/phase-5/18-go-no-go-evidence-gate.md`、`scripts/release/validate-phase-5-go-no-go-evidence.mjs`、`scripts/resilience/validate-phase-5-resilience-evidence.mjs` | 生产级回滚、零 Sev1/Sev2/高危漏洞与跨职能签署 |
| #39 统一切换 | `docs/phase-6/00-unified-cutover-contract.md`、`docs/phase-6/02-production-execution-runbook.md`、`scripts/release/validate-phase-6-cutover-evidence.mjs` | 批准窗口内的真实冻结、增量迁移、连接切换、双人复核与旧系统只读 |
| #40 四周 Hypercare | `docs/phase-6/01-hypercare-archive-contract.md`、`scripts/release/validate-phase-6-hypercare-evidence.mjs`、`.github/workflows/phase-6-hypercare.yml` | 连续四周 SLO、每日真实对账、差异闭环和归档批准 |

## 4. GitHub 与 CI 边界

- GitHub 是唯一代码协作、Issue、PR 与 CI 入口；不使用 NAS、自建 Runner、虚拟机
  或本地内网作为 CI 替代品。
- 当前实现由以 Draft PR #122 为根的堆叠 PR 承载，最新 Knowledge 切片为
  Draft PR #129；合入前仍需按顺序评审、可运行 CI 与所有适用 DoD。
- GitHub Hosted Actions 当前在任何 Job 步骤开始前被账号付款或 Spending limit
  拦截。该状态既不是代码测试失败，也不是 CI 通过；相同 commit 不重复空跑。
- Issue #41 需要用户明确授权 `read:project,project` 后才能创建 Project。未获授权
  前保持阻塞，不扩大 OAuth 权限。
- Phase 3 新增 Issue #123–#126 必须归入 Phase 3 Milestone，维持“一项工作只归属
  一个 Milestone”的治理要求。

## 5. 覆盖率边界

2026-07-29 在 Node 22 与锁定依赖下执行
`pnpm --filter @gaoq/erp-api test:coverage`，401 个测试文件、6,156 项测试全部
通过。`vitest.config.ts` 已显式 `include: ['src/**/*.ts']`，因此测试未加载的
启动、Worker、Controller、迁移和适配器文件也进入分母；覆盖率为语句
92.37%（30,782/33,323）、分支 89.67%（21,099/23,528）、函数
93.23%（5,498/5,897）、行 93.56%（28,138/30,073）。全仓四维已达到 Phase 0
规定的 80% 门槛。全量命令通过
`pnpm quality:erp-api-global-coverage` 接入 `pnpm check`；禁止用默认的
“仅统计已加载文件”口径、排除生产文件、降低阈值或局部高覆盖率维持达标。

2026-07-29 Knowledge 考试运行仓储已对查询输入、可信租户、最小投影、考试/
任务引用、题型策略、状态、版本、锁、重放与时间/证据组合执行运行时闭包；尝试号
分配、插入及提交 CAS 要求活动事务，并对创建或更新结果反向绑定。Knowledge
Outbox 对课程、任务、考试运行、评分与入职证明 15 类事件实施逐类型严格白名单，
拒绝答案、标准答案、Token、未知字段和状态错配。124 项专项测试使两个生产文件
达到 95.71%/94.06%/100%/97.42%（语句/分支/函数/行），逐文件四维均不低于
90%；该证据不替代真实评分服务、事件总线和 UAT，标准 MCP 仍不新增评分或重放
写能力。

2026-07-29 Knowledge 搜索索引事务任务 Writer 已对事件 ULID、可信租户、课程
版本、内容引用、课程状态与 `upsert/delete` 操作建立运行时闭包；部门/岗位授权
集合要求安全、唯一、规范排序且有界。写入强制活动 Mongo 事务，并对数据库创建
回执中的全部索引投影、调度时间和初始状态反向绑定。47 项专项测试使目标生产文件
达到 100%/98.24%/100%/100%（语句/分支/函数/行），逐文件四维均不低于
90%；REST、事件和标准 MCP 契约不变，MCP 仍只经应用服务读取授权裁剪结果。

2026-07-29 Onboarding 事务 Outbox 已对创建、任务完成、建档开始和完成四类
事件建立完整对象与逐类型负载白名单，运行时绑定状态、任务代码、Employment
引用、规范时间、可信租户/主体和活动 Mongo 事务，并反向绑定数据库创建回执中
的事件 ULID、聚合版本、完整 CloudEvent 与调度时间。43 项专项测试达到
98.27%/96.87%/100%/100%（语句/分支/函数/行），独立四维 90% 门禁已接入
`pnpm precheck` 与 `pnpm check`。本证据不替代 Recruitment/eSign/Org
端到端回放、事件总线和 HR UAT；标准 MCP 仍仅通过应用服务提供部门裁剪只读摘要。

2026-07-29 Recruitment 事务 Outbox 已对申请、候选人、HC、职位、面试、
Offer 与简历分析 31 类事件建立完整对象与逐类型负载白名单，运行时闭合聚合、
状态、审批/投递/接受/eSign 证据链、规范时间、可信租户/主体及活动 Mongo
事务，并反向绑定数据库创建回执中的事件 ULID、聚合版本、完整 CloudEvent 与
调度时间。83 项专项测试达到 99.29%/98.43%/100%/100%
（语句/分支/函数/行），独立四维 90% 门禁已接入 `pnpm precheck` 与
`pnpm check`。本证据不替代真实渠道、日历、eSign、事件总线与招聘 UAT；
标准 MCP 仍只通过招聘应用服务提供授权裁剪能力，不直连 Outbox。

2026-07-29 OP 审批桥读取边界已在 REST 与标准 MCP 共用的应用服务中二次校验
可信 Scope，固定租户查询和最小投影，并对租户/eventId、标识、状态、版本和时间
关系做严格运行时反向绑定；终态 Relay 同步写入完成与更新时间。35 项读取专项
测试达到 100%/100%/100%/100%，结果 Relay/Delivery 70 项测试继续保持四维
100%；该证据不替代 OP 沙箱双向联调、真实身份目录与 UAT。

2026-07-29 Care 事务 Outbox 已对离职案件、校友授权、授权终止清理及生日/周年
关怀共 22 类事件建立完整对象与逐类型负载白名单，运行时绑定状态、版本、规范
时间、可信租户/主体和活动 Mongo 事务，并对创建结果反向绑定事件 ULID、聚合、
完整 CloudEvent 与调度时间。60 项专项测试达到
98.71%/91.89%/100%/100%（语句/分支/函数/行），独立四维 90% 门禁已接入
`pnpm precheck` 与 `pnpm check`。本证据不替代真实 CRM、校友平台、通知平台
和事件总线联调；标准 MCP 未新增发送、重放、证明或联系方式能力。

2026-07-28 智能简历门禁已从仅统计应用 Service 扩展到 Service、REST
Controller、BullMQ Processor、确定性 Queue JobId 与来源/OpenAI 适配器五个生产
文件。专用命令执行 7 个测试文件、76 项测试，覆盖率为语句 99.40%、分支
94.88%、函数 100%、行 99.65%，并对每个文件单独强制四维 90%；该结果属于本地
代码证据，不替代真实附件网关、OpenAI API Project 数据控制和招聘 UAT。

2026-07-28 审计追加门禁已覆盖 HMAC 链载荷规范化、Mongo 事务追加与独立 WORM
HTTPS Client 三个生产文件。专用命令执行 3 个测试文件、74 项测试，覆盖率为语句
96.91%、分支 97.48%、函数 96.66%、行 99.00%，并对每个文件单独强制四维 90%。
代码已拒绝非规范链哈希、请求摘要/签名错位、非 443/不成套 WORM 配置、超大或
时钟异常回执，并隔离事务提交后的会话清理故障；真实 WORM 回读验签仍是外部证据。

2026-07-28 审计后台执行门禁已覆盖锚定 Processor、Scheduler、固定队列契约、
队列指标 Poller、共享无重入采集器和 API/Worker 模块隔离。专用命令执行 4 个
测试文件、17 项测试，七个生产文件逐文件语句、分支、函数、行均为 100%。
任务只接受固定任务名与严格空载荷；WORM 未启用不注册调度，配置损坏或 Redis
注册失败时启动失败关闭；失败由五次指数退避和低基数 failed 队列指标观测。

租户上下文、生产运行入口与可观测性边界、审计追加与 WORM 运输、审计后台执行与队列观测、审计链锚定、审计链验证、组织主数据应用、组织主数据入口、身份授权、审批数据加密、审批仓储、
审批应用状态机、审批主体解析、审批入口控制器、审批模板领域、审批 Outbox 运行时边界、Onboarding 仓储运行时边界、Onboarding Outbox 运行时边界、Recruitment Outbox 运行时边界、
MCP 确认服务、MCP HTTP 入口、MCP 运行时、MCP Tool 应用层、OP 审批桥入站申请、OP 审批结果回传、
OP Webhook 双入口、
薪酬影子周期、薪酬运行、薪酬审批、薪酬主数据、专业算薪主数据快照、薪酬四方对账、薪酬税务申报、薪酬 L4 数据加密、资金支付、Treasury 银行提交出站边界、Treasury 银行回盘、Treasury 银行回盘入站边界、Treasury L4 数据加密、Treasury Outbox、Phase 4 REST 入口、Care 纪念日应用、Care 通知网关信任边界、Care Outbox 运行时边界、Care 离职应用、校友授权清理协调、
校友授权清理证明出口、数据迁移控制面、数据迁移打包 CLI、Knowledge 考试运行 Relay、Knowledge 搜索索引 Relay、Knowledge 考试持久化与 Outbox 边界、Knowledge 评分证据与搜索网关边界、Knowledge REST 入口控制器、Knowledge 应用服务、Knowledge 考试应用与入口、Knowledge 领域模型、Knowledge 持久化 Schema、Knowledge 考试重放 CLI、考勤应用、考勤仓储、Attendance 规则纵切、考勤供应商拉取、考勤 Provider 外部响应闭包、考勤供应商入站处理、电子签回调处理、电子签发起状态机、
招聘渠道拉取、招聘渠道入站处理、招聘渠道职位扇出、招聘渠道阶段扇出、招聘申请、招聘面试、招聘简历、招聘渠道职位投递、招聘渠道阶段回传、招聘管理、招聘面试日历可靠投递、人才全周期应用、人才全周期仓储、招聘 Offer、Care 仓储、组织仓储、招聘仓储、知识库仓储、营销 CMS、营销入口与幂等核心、营销副作用可靠投递、审批通知可靠投递、审批通知运维边界、组织主数据外部投递可靠性、组织外部身份解析边界、组织平台适配器安全边界、组织首次平台开户、身份令牌与 OAuth 授权事务、身份用户会话与签名键轮换、人员 SSO 信任边界、OAuth Client Credentials 服务身份签发、OAuth 授权控制器、WebAuthn 强认证、入职应用与入口控制器、生产执行授权服务、Phase 5 管理分析、Payroll Tax 双出口和自然人生日证明入口已建立
独立不可回退门禁：
`pnpm quality:tenant-context-coverage`、
`pnpm quality:runtime-boundary-coverage`、
`pnpm quality:audit-append-coverage`、
`pnpm quality:audit-worker-coverage`、
`pnpm quality:audit-anchor-coverage`、
`pnpm quality:audit-chain-verification-coverage`、
`pnpm quality:org-application-coverage`、
`pnpm quality:org-controller-coverage`、
`pnpm quality:authorization-coverage`、
`pnpm quality:approval-crypto-coverage`、
`pnpm quality:mcp-confirmation-coverage`、
`pnpm quality:mcp-http-entry-coverage`、
`pnpm quality:mcp-runtime-coverage`、
`pnpm quality:mcp-tool-coverage`、
`pnpm quality:op-approval-request-coverage`、
`pnpm quality:op-approval-bridge-read-coverage`、
`pnpm quality:op-approval-result-coverage`、
`pnpm quality:op-approval-egress-coverage`、
`pnpm quality:op-webhook-ingress-coverage`、
`pnpm quality:op-operating-summary-coverage`、
`pnpm quality:analytics-management-coverage` 和
`pnpm quality:payroll-shadow-coverage`、
`pnpm quality:payroll-run-coverage`、
`pnpm quality:payroll-approval-coverage`、
`pnpm quality:payroll-master-data-coverage`、
`pnpm quality:payroll-master-data-snapshot-coverage`、
`pnpm quality:payroll-reconciliation-coverage`、
`pnpm quality:payroll-tax-filing-coverage`、
`pnpm quality:payroll-tax-http-coverage`、
`pnpm quality:payroll-data-crypto-coverage`、
`pnpm quality:treasury-disbursement-coverage`、
`pnpm quality:treasury-worm-egress-coverage`、
`pnpm quality:treasury-bank-submission-egress-coverage`、
`pnpm quality:treasury-bank-return-coverage`、
`pnpm quality:treasury-bank-return-ingress-coverage`、
`pnpm quality:treasury-data-crypto-coverage`、
`pnpm quality:treasury-outbox-writer-coverage`、
`pnpm quality:phase4-entry-controllers-coverage`、
`pnpm quality:care-occasion-application-coverage`、
`pnpm quality:care-occasion-notification-boundary-coverage`、
`pnpm quality:care-outbox-boundary-coverage`、
`pnpm quality:org-care-occasion-source-coverage`、
`pnpm quality:care-application-coverage`、
`pnpm quality:care-alumni-cleanup-coverage`、
`pnpm quality:care-alumni-cleanup-egress-coverage`、
`pnpm quality:data-migration-coverage`、
`pnpm quality:data-migration-entry-coverage`、
`pnpm quality:data-migration-package-coverage`、
`pnpm quality:knowledge-exam-run-relay-coverage`、
`pnpm quality:knowledge-search-index-relay-coverage`、
`pnpm quality:knowledge-search-persistence-boundary-coverage`、
`pnpm quality:knowledge-exam-persistence-boundary-coverage`、
`pnpm quality:knowledge-gateway-boundary-coverage`、
`pnpm quality:knowledge-controller-coverage`、
`pnpm quality:knowledge-application-coverage`、
`pnpm quality:knowledge-exam-entry-coverage`、
`pnpm quality:knowledge-domain-coverage`、
`pnpm quality:knowledge-persistence-schemas-coverage`、
`pnpm quality:knowledge-exam-replay-coverage`、
`pnpm quality:attendance-application-coverage`、
`pnpm quality:attendance-repositories-coverage`、
`pnpm quality:attendance-core-coverage`、
`pnpm quality:attendance-rules-coverage`、
`pnpm quality:attendance-provider-pull-coverage`、
`pnpm quality:attendance-provider-adapter-coverage`、
`pnpm quality:attendance-provider-processor-coverage`、
`pnpm quality:esign-webhook-processor-coverage`、
`pnpm quality:esign-integration-coverage`、
`pnpm quality:esign-issuance-coverage`、
`pnpm quality:recruitment-channel-pull-coverage`、
`pnpm quality:recruitment-channel-processor-coverage`、
`pnpm quality:recruitment-channel-position-relay-coverage`、
`pnpm quality:recruitment-channel-stage-relay-coverage`、
`pnpm quality:recruitment-application-coverage`、
`pnpm quality:recruitment-outbox-boundary-coverage`、
`pnpm quality:recruitment-interview-coverage`、
`pnpm quality:recruitment-resume-coverage`、
`pnpm quality:recruitment-channel-position-delivery-coverage`、
`pnpm quality:recruitment-channel-stage-delivery-coverage`、
`pnpm quality:recruitment-channel-operations-coverage`、
`pnpm quality:recruitment-management-coverage`、
`pnpm quality:recruitment-onboarding-bridge-coverage`、
`pnpm quality:talent-lifecycle-application-coverage`、
`pnpm quality:talent-lifecycle-entry-coverage`、
`pnpm quality:talent-lifecycle-outbox-boundary-coverage`、
`pnpm quality:talent-lifecycle-sources-coverage`、
`pnpm quality:talent-lifecycle-repository-coverage`、
`pnpm quality:recruitment-offer-coverage`、
`pnpm quality:care-repositories-coverage` 和
`pnpm quality:org-repositories-coverage`、
`pnpm quality:recruitment-repositories-coverage`、
`pnpm quality:knowledge-repositories-coverage`、
`pnpm quality:marketing-cms-service-coverage`、
`pnpm quality:marketing-entry-idempotency-coverage`、
`pnpm quality:marketing-side-effect-delivery-coverage`、
`pnpm quality:approval-notification-delivery-coverage`、
`pnpm quality:approval-notification-operations-coverage`、
`pnpm quality:recruitment-calendar-delivery-coverage`、
`pnpm quality:org-delivery-reliability-coverage`、
`pnpm quality:org-external-identity-boundary-coverage`、
`pnpm quality:org-platform-adapters-coverage`、
`pnpm quality:org-provisioning-coverage`、
`pnpm quality:approval-repositories-coverage` 和
`pnpm quality:approval-outbox-boundary-coverage`、
`pnpm quality:approval-application-coverage`、
`pnpm quality:approval-actor-resolution-coverage`、
`pnpm quality:approval-controller-coverage`、
`pnpm quality:approval-template-domain-coverage`、
`pnpm quality:identity-token-entry-coverage`、
`pnpm quality:identity-session-lifecycle-coverage`、
`pnpm quality:sso-trust-boundary-coverage`、
`pnpm quality:oauth-client-credentials-coverage`、
`pnpm quality:oauth-controller-coverage`、
`pnpm quality:strong-auth-coverage`、
`pnpm quality:onboarding-application-coverage`、
`pnpm quality:onboarding-repositories-coverage`、
`pnpm quality:onboarding-outbox-boundary-coverage`、
`pnpm quality:production-execution-authorization-coverage`、
`pnpm quality:op-approval-result-operations-coverage` 和
`pnpm quality:org-person-birthday-entry-coverage`。一百二十条链路当前覆盖率基线集合为
100%/100%/100%/100%、100%/100%/100%/100%、100%/100%/100%/100%、
100%/100%/100%/100%、
97.44%/93.52%/100%/97.50%、
100%/100%/100%/100%、
100%/95.83%/100%/100%、
98.75%/96.96%/100%/100%、
98.06%/94.04%/98.64%/99.02%、
94.62%/90.76%/98.19%/95.96%、100%/100%/100%/100%、
97.55%/96.32%/100%/97.60%、
100%/97.74%/100%/100%、
100%/100%/100%/100%、
97.97%/95.67%/97.32%/98.88%、
100%/100%/100%/100%、
100%/100%/100%/100%、
100%/100%/100%/100%、
98.34%/96.13%/100%/100%、
99.34%/97.35%/100%/100%、
99.00%/97.24%/97.29%/98.84%、92.18%/90.20%/96.10%/93.18%、
100%/100%/100%/100%、
100%/100%/100%/100%、
98.21%/96.42%/100%/100%、
96.42%/96.79%/100%/98.96%、
98.88%/98.58%/100%/100%、
96.51%/94.54%/100%/98.59%、
93.88%/93.23%/96.05%/95.77%、
97.04%/96.27%/100%/97.05%、
98.26%/96.82%/100%/99.00%、
98.48%/98.67%/100%/98.46%、
100%/100%/100%/100%、
100%/96.85%/100%/100%、
99.54%/97.43%/100%/100%、
100%/99.35%/100%/100%、
93.37%/90.19%/97.97%/95.29%、
95.26%/91.55%/92.30%/95.69%、
98.06%/94.04%/100%/100%、
98.52%/98.83%/100%/100%、
100%/100%/100%/100%、
100%/100%/100%/100%、
99.16%/93.93%/98.18%/99.05%、
100%/98.85%/100%/100%、
99.35%/100%/95.45%/100%、
100%/98.85%/100%/100%、
95.93%/94.78%/93.75%/97.27%、
99.20%/99.17%/100%/99.11%、
100%/100%/100%/100%、
98.61%/97.00%/100%/99.21%、
100%/100%/100%/100%、
100%/100%/100%/100%、
98.22%/95.47%/100%/98.40%、
100%/100%/100%/100%、
100%/100%/100%/100%、
100%/100%/100%/100%、
100%/99.35%/100%/100%、
100%/100%/100%/100%、
99.30%/90.78%/100%/100%、
95.45%/92.38%/100%/97.25%、
96.52%/92.36%/100%/97.72%、
100%/94.11%/100%/100%、
99.51%/99.45%/100%/100%、
100%/96.85%/100%/100%、
100%/97.05%/100%/100%、
95.97%/94.01%/100%/96.83%、
100%/91.66%/100%/100%、100%/100%/100%/100%、
97.44%/91.32%/100%/99.53%、100%/99.43%/100%/100%、
100%/97.62%/100%/100%、
99.70%/96.85%/100%/99.68%、
99.13%/98.33%/100%/99.51%、
100%/98.30%/100%/100%、
96.09%/91.51%/100%/99.45%、
100%/100%/100%/100%、
100%/98.23%/100%/100% 和
100%/100%/100%/100%、98.27%/97.70%/96.55%/98.34%、
97.18%/95.18%/100%/97.99%、99.02%/97.69%/100%/100%、
98.61%/95.04%/100%/99.07%、
98.23%/97.43%/98.24%/98.85%、97.80%/93.10%/100%/100%、
99.59%/98.23%/100%/99.56%、97.60%/95.14%/100%/99.07%、
99.17%/95.97%/100%/99.13%、99.58%/99.20%/100%/100%、
96.96%/95.60%/100%/98.79%、99.70%/94.44%/100%/99.67%、
99.13%/98.03%/100%/99.02%、99.01%/96.70%/100%/98.87%、
98.90%/96.15%/100%/98.70%、99.35%/98.57%/100%/99.25%、
100%/97.77%/100%/100%、96.39%/96.15%/96.42%/97.59%、
100%/100%/100%/100%、
99.16%/97.79%/100%/99.76%、
92.17%/91.90%/98.00%/93.33%、
95.59%/94.44%/92.85%/96.66%、100%/100%/100%/100%、
100%/100%/100%/100%、100%/99.02%/100%/100%、
100%/100%/100%/100%、98.71%/91.89%/100%/100%、
95.71%/94.06%/100%/97.42%、100%/98.24%/100%/100%、
98.27%/96.87%/100%/100%、99.29%/98.43%/100%/100%、
100%/100%/100%/100%、100%/100%/100%/100%
（语句/分支/函数/行）；电子签十个核心文件另达到
98.11%/95.70%/99.04%/99.54%，审计追加三个核心文件另达到
96.91%/97.48%/96.66%/99.00%，审计后台七个生产文件另达到
100%/100%/100%/100%、100%/100%/100%/100%、100%/98.07%/100%/100%；一百二十项阈值均固定为 90%，
使用相互隔离的报告目录，并已接入 `pnpm check`。这只证明一百二十条关键链路达标，
不替代全仓 80% 或其余关键服务 90% 的证据。

自然人生日证明入口执行 73 项严格 ULID、强 `If-Match`、白名单幂等键、规范
日历月日、未知字段拒绝、可信服务主体、Scope、应用层运行时复核、幂等结果反向
绑定、隐私和提交后审计隔离测试。DTO、应用服务和控制器三个生产文件均达到
100%/100%/100%/100%（语句/分支/函数/行），独立逐文件四维 90% 门禁已接入
`pnpm precheck` 与 `pnpm check`。标准 MCP 不新增生日登记、盲索引解析或证明
读取能力；真实身份服务、密钥轮换和员工 UAT 仍待现场验收。

关怀跨域来源门禁执行 43 项可信主体、查询主键、租户、Employee、当前
Employment、Person、唯一开放关系、复聘历史和生日证明三元组测试，目标生产文件
达到 98.52%/98.83%/100%/100%（语句/分支/函数/行）。损坏引用整体失败关闭，
不会被误判为正常不具备资格后静默取消任务；标准 MCP 继续只读取 Care 应用服务
的本人脱敏汇总，不直连 Org 来源服务。

Care 关怀通知网关边界已覆盖 25 项严格请求、唯一渠道、运行时凭据/Key ID/
Ed25519 公钥、固定 HTTPS 根地址、最小 Header/正文、严格 JSON Content-Type、
Content-Length、16 KiB 流式限长、读取取消、Fatal UTF-8、规范 Base64、
原始字节验签、上下文/渠道/送达时间闭包和稳定错误码测试。目标生产文件达到
95.59%/94.44%/92.85%/96.66%（语句/分支/函数/行），独立逐文件四维 90%
门禁已接入 `pnpm precheck`。该证据不替代真实通知沙箱、渠道授权目录、限流、
密钥轮换和员工 UAT；标准 MCP 不新增通知发送、联系方式、正文或证据读取能力。

组织外部身份解析边界已覆盖 20 项可信调用参数、活动平台绑定最小投影、bound
身份双标识、无绑定/未就绪、受损持久化记录、钉钉访问令牌投影、外部租户反向
绑定和 `unionId → userid` 回执测试。目标生产文件四维均为 100%，独立逐文件
四维 90% 门禁已接入 `pnpm precheck`。受损记录和租户漂移在触达平台前进入稳定
业务错误，不会被降级成正常未绑定；标准 MCP 继续不开放外部身份、平台令牌、
组织投递或招聘日历写能力。真实企业租户、平台权限与限流仍待外部验收。

招聘面试日历可靠投递已覆盖 169 项标准命令校验、租户绑定目标去重、不可变事件
版本、外部身份、令牌单次刷新、平台错误分类、飞书多步部分提交、钉钉/飞书结果
不确定、过期租约隔离、事务提交后清理故障、平台成功后本地终态故障、人工批准
例外和 R2 审计测试。九个生产文件合计达到
99.16%/97.79%/100%/99.76%（语句/分支/函数/行），且逐文件四维均不低于
90%；独立门禁已同时接入 `pnpm precheck` 与 `pnpm check`。标准 MCP 继续只读，
不暴露日历写入、重试、人工处置、对账、外部事件标识或平台凭据；真实钉钉/飞书
日历沙箱、限流、权限和人工核验流程仍待现场验收。

校友授权清理证明出口已覆盖 131 项任务完整性、目标政策、独立 Origin/凭据/
Ed25519 信任根、固定协议 Header、非 200 正文隔离、Content-Type/
Content-Length、16 KiB 流式限长、读取取消、原始字节验签、Fatal UTF-8、
完整 Schema、上下文、存储引用和最低保留期测试。配置解析器、目标注册表与 HTTP
适配器三个生产文件合计达到 96.39%/96.15%/96.42%/97.59%
（语句/分支/函数/行），且逐文件四维均不低于 90%；独立门禁已由原有校友清理
总门禁接入 `pnpm check`。REST 和标准 MCP 继续只返回脱敏状态计数，不向 AI
暴露清理、重放、重建、恢复授权、证明正文或下游凭据；真实 CRM、通知、校友
平台删除/未来处理阻断、WORM、凭据轮换与业务 UAT 仍待现场验收。

Phase 5 管理分析纵切已覆盖 52 项共享契约、历史审批快照、不可变最终审批动作、
应用服务二次授权、严格 REST 查询、MCP prepare/execute、异步导出代次、确定性
JobId、租约 fencing、提交后审计隔离、产物摘要与持久化组合约束测试。七个目标
生产文件合计达到 99.59%/98.23%/100%/99.56%（语句/分支/函数/行），且逐文件
四维均不低于 90%；`phase-5-analytics-indexes-v2` 追加
`approval_actions(tenantId,resultingStatus,occurredAt)` 索引。该证据只证明代码
实现；生产 Replica Set apply/explain、OP 真实数据覆盖、容量测试和管理 UAT 仍待
现场完成。

营销副作用可靠投递已覆盖 68 项路由身份、运行时受损记录、Outbox 抢占与释放、
幂等入队、通知网关、排期发布、重试/死信、审计隔离和存储失败关闭测试。网关
成功后的送达终态写入故障不再反向登记通知失败；租约丢失不会覆盖其他 Worker
状态；通知幂等键绑定唯一 eventId。四个目标文件合计覆盖率达到
99.13%/98.33%/100%/99.51%（语句/分支/函数/行），独立四维 90% 门禁已接入
`pnpm check`。排期恢复扫描的 `kind + status + dueAt` 专用索引由
`phase-5-marketing-cms-indexes-v2` 追加迁移交付。

审批通知可靠投递门禁已覆盖 25 项运行时受损记录、双平台认领、租约竞争、平台
回执、重试/死信、结果不确定隔离和任务路由测试。平台返回成功后的本地终态故障
只记录 `state_unavailable`，不再反向登记发送失败；飞书使用通知 ULID 作为
`uuid` 安全恢复，钉钉对过期租约及不可判定响应失败关闭。六个投递目标文件合计
覆盖率达到 100%/99.03%/100%/100%（语句/分支/函数/行）。

审批通知运维边界另覆盖 77 项严格请求结构、规范分页、应用层 Scope 复核、最小
数据库投影、租户/状态/错误/时间反向绑定、对账计数、人工重试上限和提交后审计
隔离测试。`credentials_fixed`、`identity_bound`、`provider_recovered` 与
`approved_exception` 只能匹配各自错误类别，结果不确定通知仍只有完成平台对账
后的 R2 `approved_exception` 可恢复；受损投影使整页或整次处置失败关闭。Controller
与应用服务达到 100%/99.02%/100%/100%（语句/分支/函数/行），独立逐文件四维
90% 门禁已接入 `pnpm precheck` 和 `pnpm check`。死信游标查询所需
`tenantId + status + notificationId(desc) + channel` 复合索引由
`phase-2-indexes-v3` 独立追加，不复用或改写既有 v2 运行记录。
`state_unavailable`、死信告警继续由 Prometheus 规则覆盖；审批 MCP 保持标准
只读能力，不向 AI 暴露通知异常队列、对账控制面或重试写操作。

组织主数据外部投递可靠性已覆盖 73 项投递状态机、运行时受损记录、版本租约、
双平台协议、HTTP 安全边界、结果不确定隔离、人工恢复、队列载荷和每日只读对账
测试。过期 `processing` 不再直接重放：版本已提交时只补写成功，未提交时进入
`manual_review`；平台已受理后的本地提交故障只记录 `state_unavailable`，不得由
通用失败逻辑释放租约或反向登记失败。投递、恢复和对账终态均校验原租约，
`matchedCount != 1` 时失败关闭。运维 REST 另严格拒绝未知字段及非规范分页数字，
业务失败审计故障不得覆盖原始异常，提交后成功审计故障不得改变成功响应。五个
目标文件合计覆盖率达到
98.27%/97.70%/96.55%/98.34%（语句/分支/函数/行），独立四维 90% 门禁与
Prometheus 告警已接入 `pnpm check`。MCP 继续只开放复用组织应用服务的
`get_org_chart`，不向 AI 暴露平台写入、投递重试或对账控制面。

组织平台适配器安全边界已覆盖 88 项钉钉、飞书、OP 写入与快照协议测试，包括
固定目标白名单、路径和危险请求头拒绝、令牌单次刷新、确定性身份冲突恢复、
HMAC 原始字节签名、分页与对象总量上限、无 `Content-Length` 流式硬上限、稳定
HTTP/平台错误分类及敏感正文不泄露。五个目标文件合计覆盖率达到
97.18%/95.18%/100%/97.99%（语句/分支/函数/行），且每个文件四维均不低于
90%；独立门禁已接入 `pnpm check`。该证据不替代真实租户权限、限流、平台幂等
与快照对账的外部验收，MCP 仍不暴露平台写入或凭据。

组织首次平台开户已覆盖 124 项 R3 人工入口、联系方式密文/HMAC、任务运行时复核、
确定性平台 userId 回读、部门映射、已有绑定恢复、AccessProfile/ExternalIdentity/
考勤映射同事务提交、租约、退避、敏感资料擦除和提交后故障隔离测试。考勤映射
仓储另强制活动事务，按员工与外部标识盲索引双向查询唯一映射，并对最小投影、
盲索引集合、加密信封和 Mongo 写回结果执行运行时校验；停用、一对多、多对一或
跨上下文记录直接进入人工复核，不依赖唯一索引异常继续重试。损坏任务在
身份、密钥或平台调用前进入终态隔离；平台 userId、外部租户或 unionId 漂移不得
建立本地身份。成功事务后的会话清理/审计故障和失败终态后的审计故障均独立分类，
不得进入通用失败回写。八个目标生产文件合计覆盖率达到
99.02%/97.69%/100%/100%（语句/分支/函数/行），且每个文件四维均不低于
90%；独立门禁已接入 `pnpm precheck`。R3 入口永久拒绝 MCP 服务主体，标准 MCP
不注册开户、重试、凭据或平台写能力；真实钉钉/飞书沙箱、Secret 轮换和身份核验
仍待外部验收。

身份令牌与 OAuth 授权事务已覆盖 39 项 JOSE 验签、主体绑定、授权集合唯一性、
人员会话、MCP 凭据即时撤销、当前客户端回调/resource/租户/Scope 重验、PKCE、
随机碰撞、一次性原子消费和受损 Redis 记录测试。进程重启或配置收紧后旧请求
与授权码不再沿用旧授权；两个目标文件合计覆盖率达到
97.80%/93.10%/100%/100%（语句/分支/函数/行），且各自四维均不低于 90%。
独立门禁已接入 `pnpm precheck`。标准 MCP 只消费该可信身份进入应用服务，
不因 OAuth 成功获得数据库、上游 Token 或 R3 能力。

OAuth Client Credentials 服务身份签发已覆盖 22 项规范 Basic、严格 UTF-8、
官方 MCP SDK `private_key_jwt`、短时断言、`jti` 原子防重放、资源/Scope 越权、
签名与 Redis 故障以及失败审计归属测试。正文 `client_id` 不再能把认证失败记到
其他客户端；认证后的资源和 Scope 拒绝均在签名前形成稳定、最小化 R1 审计。
目标文件覆盖率达到 97.60%/95.14%/100%/99.07%（语句/分支/函数/行），独立
四维 90% 门禁已接入 `pnpm precheck`。

身份用户会话与签名键轮换已覆盖 11 个测试文件、82 项测试。浏览器 Refresh
Token 只保存摘要并绑定租户、主体、客户端、会话、family 与代次；轮换必须原子
消费前驱、创建后继并以 CAS 写回关联，重放吊销整族和服务端会话。Cookie Header
超长、重复同名 Cookie、受损持久化记录和轮换链冲突均失败关闭。JWKS 同时发布
活动公钥与最多五把历史验签公钥，严格拒绝私钥、弱 RSA、重复 `kid`/公钥材料，
支持不复用 `kid` 的两阶段轮换。刷新访问令牌签名纳入轮换事务，签名设施故障会
回滚前驱消费与后继创建；会话吊销提交后的审计故障与业务终态隔离。
十二个目标生产文件合计达到 99.17%/95.97%/100%/99.13%（语句/分支/函数/行），
逐文件四维 90% 门禁已接入 `pnpm precheck`。

人员 SSO 信任边界已覆盖 13 个测试文件、136 项测试。钉钉、飞书、OP 的
Authorization Code + PKCE 均逐层绑定 state、平台与外部租户；固定上游 HTTP
拒绝重定向、任意地址和超限响应。公开租户绑定、双外部标识映射与授权快照均从
最小投影转换为经运行时完整性校验的冻结对象，受损记录和跨租户返回在签发前失败
关闭，不再向认证服务泄漏活动 Mongoose 文档。浏览器 state Cookie 拒绝超长
Header、重复同名值、异常摘要与跨 Origin 回调，所有回调结果均清除；Redis
只对规范 state 执行 GETDEL，并稳定区分无效状态与基础设施故障。十五个目标
生产文件合计达到 99.58%/99.20%/100%/100%（语句/分支/函数/行），逐文件四维 90% 门禁已接入
`pnpm precheck`；真实企业租户权限、平台限流、生产域名和端到端 UAT 仍待外部验收。

审批主体解析已覆盖 13 项发起主体、在职状态、固定员工、租户/部门角色、部门
负责人、重复映射、人数上限和持久化污染测试。发起人 active 授权快照必须再次
绑定 ERP active/probation 员工；角色、员工和部门返回值逐项复核可信租户与查询
标识，`department_manager` 只允许引用 department 类型字段。目标生产文件达到
96.96%/95.60%/100%/98.79%（语句/分支/函数/行），独立逐文件四维 90% 门禁已
接入 `pnpm precheck`。REST、OP 和 MCP 继续复用审批应用服务，本切片未新增 AI
写能力；真实组织角色数据、历史模板和审批 UAT 仍待现场验收。

生产运行入口与可观测性边界已覆盖 11 个测试文件、40 项测试。API 存活探针不
访问依赖；就绪探针并行、有界验证 MongoDB 可写 Replica Set 主节点与 Redis
PONG，并以 in-flight 单飞阻止并发重连风暴。公开 5xx 隐藏异常正文，4xx code、
消息和详情均受规范限制；Prometheus Method/状态标签收敛到固定集合，Worker
指标入口返回标准挑战及防缓存/嗅探响应头。Redis URL 拒绝非规范协议、路径、
端口、数据库及凭据编码并支持 `rediss://`。11 个目标生产文件合计达到
99.70%/94.44%/100%/99.67%（语句/分支/函数/行），逐文件四维 90% 门禁已接入
`pnpm precheck`。本切片未新增 MCP 能力；真实 Kubernetes、主节点切换、
Redis TLS/ACL、Prometheus 抓取和告警路由仍待现场验收。

ERP→OP 审批结果出站连接边界已覆盖 49 项固定 HTTPS origin、审批结果 PUT
路径、八个签名协议 Header、重复/额外 Header、16 KiB JSON 对象请求、禁重定向、
八秒超时、Content-Length、256 KiB 流式硬上限、读取取消、严格 UTF-8/JSON、
HTTP 状态分类和 requestId 收敛测试。非 2xx 不解析或保留上游错误正文；网络、
读取、解析与取消异常不再把 cause、签名或上游响应带入连接器错误。目标生产文件
达到 99.13%/98.03%/100%/99.02%（语句/分支/函数/行），独立逐文件四维 90%
门禁由 OP 审批结果门禁接入 `pnpm check`。REST、事件与标准 MCP 仍复用审批
应用服务，本切片不新增 AI 写能力；真实 OP TLS、限流、幂等、Secret 轮换与断连
追赶仍待现场验收。

OAuth 授权控制器已覆盖 45 项预注册回调、PKCE、授权决策、授权码、
`client_credentials`、协议错误与限流测试。Basic 和 `private_key_jwt` 的
限流主体只取自认证材料，禁止请求体 `client_id` 绕过真实客户端桶；授权决策
提交后的审计故障仅记录稳定告警，不再把成功终态反向暴露为失败。覆盖率达到
96.09%/91.51%/100%/99.45%（语句/分支/函数/行），独立四维 90% 门禁已接入
`pnpm check`。

WebAuthn 强认证已覆盖 38 项可信会话、登记权限、RP/Origin/UV、凭据归属、
仪式一次性消费、计数器竞争、证据绑定和审计故障测试。登记完成阶段再次校验
`erp:identity:passkey:manage`，避免权限撤销后使用旧仪式落库新凭据；登记与撤销
提交后的审计故障只记录稳定告警，不反向暴露为业务失败。服务和入口控制器均达到
四维 100%，独立四维 90% 门禁已接入 `pnpm check`。

入职应用与入口控制器已覆盖 67 项可信租户、Scope、部门数据范围、幂等重放、
招聘来源一致性、任务证据、强 `If-Match`、R3 建档 Saga 和审计终态测试。
读取、组织分配与合同同步均在外部调用前二次授权；已完成 Saga 只接受当前至前两版
的恢复窗口；业务提交后的审计故障只记录稳定告警，不反向暴露为业务失败。合并
覆盖率达到 100%/98.23%/100%/100%（语句/分支/函数/行），独立四维 90%
门禁已接入 `pnpm check`。

Onboarding Outbox 运行时边界已覆盖 43 项四类事件负载、可信租户/主体、活动
事务、规范时间、状态组合、调用方并发篡改、数据库异常和完整创建回执反向绑定
测试。目标 Writer 达到 98.27%/96.87%/100%/100%
（语句/分支/函数/行），独立四维 90% 门禁已接入 `pnpm precheck` 与
`pnpm check`；事件名与标准 MCP 只读边界不变。

Recruitment Outbox 运行时边界已覆盖 83 项 31 类事件负载、聚合/状态、审批与
外部证据引用、可信租户/主体、活动事务、调用方并发篡改、数据库异常和完整创建
回执反向绑定测试。目标 Writer 达到 99.29%/98.43%/100%/100%
（语句/分支/函数/行），独立四维 90% 门禁已接入 `pnpm precheck` 与
`pnpm check`；事件名与标准 MCP 授权裁剪边界不变。

校友授权清理协调与执行服务已覆盖 66 项可信系统任务、事件信封与源状态绑定、
目标政策幂等、事务回调、认领竞争、退避/死信、队列恢复、证明终态和最小 MCP
摘要测试。畸形终止事件会立即释放认领并持久化稳定错误码，避免长期占锁阻塞批次；
Mongo 事务回调未执行时显式失败，清理投递只允许可信 `system_job`。两个目标文件
合计覆盖率达到 100%/99.35%/100%/100%（语句/分支/函数/行），独立四维 90%
门禁已接入 `pnpm check`。

数据迁移控制面已有 61 项幂等重放、证据分页、检查点竞争、关联映射、附件与
全域负载失败关闭测试，服务覆盖率达到 93.37%/90.19%/97.97%/95.29%
（语句/分支/函数/行），独立四维 90% 门禁已接入 `pnpm check`。

数据迁移打包 CLI 已覆盖 19 项来源包流式校验、符号链接逃逸、断点续传、附件
等待、远端响应、证据分页与控制总数测试；负数待传数、重复游标、超大页面、
非白名单远端错误码及含凭据/query/fragment 的端点均失败关闭。覆盖率达到
95.26%/91.55%/92.30%/95.69%（语句/分支/函数/行），独立四维 90% 门禁已接入
`pnpm check`。

Knowledge 考试运行 Relay 已补齐 24 项隔离网关、超时封存、自动/人工评分、
事务终态、审计隔离、退避、死信与熔断测试，服务覆盖率达到
98.06%/94.04%/100%/100%（语句/分支/函数/行），独立四维 90% 门禁已接入
`pnpm check`。

Knowledge 搜索索引 Relay 已补齐 5 项幂等回执、时间边界、参数约束、认领竞争、
指数退避与死信测试，服务覆盖率达到四维 100%，独立四维 90% 门禁已接入
`pnpm check`。

Knowledge 搜索索引事务任务 Writer 已覆盖 47 项规范发布/下架映射、可信租户、
活动事务、授权集合闭包、数据库回执反向绑定、Mongoose 文档回执、异常透传及
调用方并发篡改测试，覆盖率达到 100%/98.24%/100%/100%（语句/分支/函数/行），
逐文件四维 90% 门禁经 Knowledge 持久化组合门禁接入 `pnpm precheck` 与
`pnpm check`。标准 MCP 仍不开放索引写入、重放、任务集合或搜索凭据。

Knowledge 评分证据与搜索网关边界已覆盖 20 项严格考试请求、人工复核证据绑定、
独立 Origin/凭据/Ed25519 公钥/Key ID、规范 Base64、严格 JSON Content-Type、
Content-Length、16 KiB 流读取、异常取消、稳定错误码、授权查询及索引回执测试。
答案、Token、未知字段和人工复核策略错位在外呼前失败关闭；目标生产文件达到
92.17%/91.90%/98.00%/93.33%（语句/分支/函数/行），独立逐文件四维 90%
门禁已接入 `pnpm precheck`。REST、事件和标准 MCP 不新增评分、改分、重放或
索引写能力；真实评分/搜索沙箱、限流、密钥轮换和业务 UAT 仍待现场验收。

Knowledge REST 入口控制器已覆盖 9 项完整路由、精确 Scope、ULID、强
`If-Match`、幂等键、ETag、最小审计元数据和提交后审计隔离测试；课程发布校验
只在幂等事务的新执行分支内针对精确课程版本发生，已完成请求直接重放快照，
不再依赖外部校验器；课程与任务提交后的审计故障只作独立告警，R0 读取审计仍
失败关闭。控制器覆盖率达到四维 100%，独立四维 90% 门禁已接入 `pnpm check`。

Knowledge 应用服务已覆盖 39 项课程创建/发布/下架、任务分配/读取、员工主数据
解析、全文检索授权与索引新鲜度、集成进度幂等、任务完成和入职证明终态测试；
发布校验只在幂等事务的新执行分支内执行。覆盖率达到
99.16%/93.93%/98.18%/99.05%（语句/分支/函数/行），独立四维 90% 门禁已接入
`pnpm check`。

Knowledge 考试应用与入口已覆盖 28 项所有权、活动运行、尝试上限、完整考试策略、
提交状态与截止时间、唯一键竞争、最小响应和提交后审计隔离测试；考试开始与提交
后的审计失败只记录稳定告警，R0 读取审计仍失败关闭。两个目标文件合计覆盖率达到
100%/98.85%/100%/100%（语句/分支/函数/行），且各自均已接入独立四维 90%
门禁。

Knowledge 领域模型已覆盖 39 项课程、受众、任务、考试策略、评分、版本、租户、
时间和终态不变量；主观题与混合题缺少人工复核证据时在领域构造阶段即失败关闭，
自动评分测试事实固定为客观题。两个目标文件合计覆盖率达到
99.35%/100%/95.45%/100%（语句/分支/函数/行），且各自均已接入独立四维 90%
门禁。

Knowledge 持久化 Schema 已覆盖 22 项课程授权、可空考试配置、培训任务状态与
证据、考试运行状态机、超时、锁、受控重放及搜索索引证据组合测试；无考试课程
允许 `passingScoreBps=null`，受损任务记录在 Mongo 校验边界失败关闭。三个目标文件
合计覆盖率达到 100%/98.85%/100%/100%（语句/分支/函数/行），且各自均已
接入独立四维 90% 门禁。

Knowledge 考试重放 CLI 已覆盖 40 项证据状态推断、精确参数、重复参数、
十进制版本、数据库配置、连接关闭、稳定错误码、事务竞争、脱敏 Outbox 和受损
dead 记录失败关闭测试；重放前会验证引用链、题型、次数和超时事实。覆盖率达到
95.93%/94.78%/93.75%/97.27%（语句/分支/函数/行），独立四维 90% 门禁
已接入 `pnpm check`。

考勤仓储已覆盖 17 项可信租户、源事实/修订/月快照密文读写、盲索引、迁移证据、
会话绑定、并发冲突和失败关闭测试，目标生产文件达到四维 100%，独立四维 90%
门禁已接入 `pnpm check`。

Attendance 核心领域与 L4 加密已覆盖 99 项事实/修订/月结不变量、严格日历时间、
规则日摘要、迁移时间线、密钥轮换、盲索引命名空间、AAD、认证篡改和解码前
长度上限测试；两个生产文件合计覆盖率达到
98.23%/97.43%/98.24%/98.85%（语句/分支/函数/行），且各自四维均不低于
90%。独立门禁已接入 `pnpm precheck`，全量覆盖门禁已接入 `pnpm check`。

Attendance 规则纵切已覆盖 85 项不可变规则/排班构造、`Employment` 完整有效期、
员工级事务并发守卫、Provider 月末水位线与未决 Inbox 对账、跨天归属、REST、仓储、Schema、Outbox
最终 CloudEvent 名和失败关闭测试；八个目标文件合计覆盖率达到
98.61%/95.04%/100%/99.07%（语句/分支/函数/行），每个文件四维均不低于
90%。独立门禁已接入 `pnpm precheck`，全量覆盖门禁已接入 `pnpm check`。

考勤供应商拉取已覆盖 50 项系统任务授权、加密游标、员工分页、小批拉取、Inbox
幂等、租约竞争、载荷规范化和失败关闭测试；部分游标密文字段不再被误判为首次
同步。覆盖率达到 98.61%/97.00%/100%/99.21%（语句/分支/函数/行），独立
四维 90% 门禁已接入 `pnpm check`。

考勤 Provider 外部响应闭包已覆盖 49 项请求、响应、传输证据、Normalizer、
单次令牌刷新和 Registry 测试。请求只接受规范租户、唯一员工集合、七日日期窗口
和 IANA 时区；钉钉/飞书返回的任务员工、嵌套员工、事件 ID 与本地事实日期逐项
反向绑定原请求，重复任务/事件、记录 ID 冲突、窗口外事实、未来拉取时间和第二次
401 整批失败关闭。Normalizer/EvidenceVerifier 已提升为 v2，目标生产文件覆盖率
达到 95.21%/92.02%/100%/95.42%（语句/分支/函数/行），独立四维 90% 门禁
已接入 `pnpm check`。标准 MCP 仍不开放 Provider 拉取、Inbox、凭据、重放或
人工处置；真实平台 fixture、旧 Inbox 清空、Canary 与沙箱限流仍待现场验收。

考勤供应商入站处理已覆盖 30 项任务分派、可信系统身份、加密信封、传输证据、
标准化器版本、员工盲索引映射、检查点与租约竞争测试；业务成功、人工复核及
失败终态后的审计故障均只作独立告警。覆盖率达到四维 100%，独立四维 90%
门禁已接入 `pnpm check`。

电子签纵切已覆盖 298 项 V3 创建流程、官方免登录签署链接、请求签名、HTTPS
边界、加密信封、状态投影、证据扫描/WORM、重复与乱序回调、Webhook 三元租约
fencing、失败任务重建、审计故障隔离和唯一键竞态测试。状态投影的 20 项直接
测试另覆盖受损输入、重复未知状态、重复终态冲突、可信供应商状态保留和既有人工
复核原因保持，目标文件四维均为 100%。十个核心文件聚合覆盖率达到
98.11%/95.70%/99.04%/99.54%（语句/分支/函数/行），各文件四维
均不低于 90%，独立门禁已接入 `pnpm check`。真实 eSign 租户、实名认证、
免登签署、拒签/过期/撤销回调和 WORM 网关仍属于外部验收边界。

eSign 发起运行时门禁已覆盖 139 项可信租户、专用 Scope、持久化加密意图、Offer/
候选人引用闭包、确定性 JobId、租约、外部结果未知隔离、仅本地终结、人工重试/
绑定和 R2 审计测试，追加索引清单另有独立测试。供应商可能已提交时禁止自动重放；人工重试必须
同时具备批准例外和供应商确认未创建，人工绑定不能直接伪造成功；完成 Job 立即
删除以允许人工处置后复用确定性标识。五个目标生产文件合计达到
97.95%/94.98%/100%/98.74%（语句/分支/函数/行），逐文件四维均不低于 90%，
独立门禁已接入 `pnpm check`。标准 MCP 永久不开放发起、重试、人工处置、外部
标识或签署主体；真实 eSign 租户、实名认证、人工核验和招聘 UAT 仍待外部验收。

招聘渠道补拉边界已覆盖 85 项 Registry 装配、系统任务授权、Mongo 绑定回读闭包、
凭据命名空间、加密游标完整性/前进、精确批量与投递 Envelope、规范事件 ID/UTC
时间、批内唯一事件、纯 JSON 语义及字节/复杂度预算、Inbox 唯一键竞争、确定性
任务恢复和租约失败关闭测试。所有响应先整批校验再产生 Inbox 副作用，通过后只
传递规范深冻结副本；凭据不可用仍回写稳定失败码。两个生产文件合计覆盖率达到
98.22%/95.47%/100%/98.40%（语句/分支/函数/行），且逐文件四维均不低于
90%；既有独立门禁已扩展并接入 `pnpm check`。标准 MCP 不开放渠道补拉、游标、
原始 Inbox、凭据、证据处置或重放；真实渠道 fixture、限流、断连追赶与招聘 UAT
仍待现场验收。

招聘渠道入站处理已覆盖 47 项任务分派、可信系统身份、标准化与证据检查点、
加密外部映射、唯一键竞态、回执盲指纹、租约竞争和失败关闭测试；业务成功、
人工复核及失败终态后的审计故障均只作独立告警，不再覆盖已提交终态或原始异常。
覆盖率达到四维 100%，独立四维 90% 门禁已接入 `pnpm check`。

招聘渠道职位扇出已覆盖 22 项 Worker 参数、过期认领、草稿创建、开放/暂停/
关闭状态、活动渠道幂等扇出、事务认领竞争、退避、死信和释放租约测试；失败
释放必须仍持有原 Worker 租约。覆盖率达到四维 100%，独立四维 90% 门禁已接入
`pnpm check`。

招聘渠道阶段扇出已覆盖 28 项 Worker 参数、过期认领、创建事件跳过、内部阶段
脱敏映射、事务认领竞争、退避、死信和释放租约测试；失败释放必须仍持有原
Worker 租约。覆盖率达到四维 100%，独立四维 90% 门禁已接入 `pnpm check`。

招聘申请已覆盖 22 项候选人与申请迁移、WORM 证据不可变重放、职位与授权引用、
渠道可信入口、部门级阶段写范围、乐观锁和稳定错误契约测试；阶段推进在事务内
重新读取职位并强制部门写范围，只有 `erp:recruitment:management:write_all`
可跨部门。覆盖率达到 100%/99.35%/100%/100%（语句/分支/函数/行），独立
四维 90% 门禁已接入 `pnpm check`。

招聘面试已覆盖 19 项迁移 WORM 证据不可变重放、员工与申请引用、部门级写范围、
面试官身份映射、评价完整性、终态、日历敏感投影、乐观锁和稳定错误契约测试；
日历投影除专用 Scope 外还必须来自 `system_job`，普通用户不能借同名 Scope
读取 L3 地点和面试官列表。覆盖率达到四维 100%，独立四维 90% 门禁已接入
`pnpm check`。

招聘简历已覆盖 10 项可信附件入口、租户内读写、受控标签、人工复核、Worker
租约、非法 AI 标签和失败终态测试；分析正文入口除专用 Scope 外还必须来自
`system_job`，防止普通用户触发敏感简历解析。覆盖率达到
99.30%/90.78%/100%/100%（语句/分支/函数/行），独立四维 90% 门禁已接入
`pnpm check`。

审批模板领域已覆盖 20 项定义/表单白名单、审批人解析器、职责分离、发布/修订/
退役、迁移生命周期、快照完整性与规范化哈希测试；在线及迁移快照会再次拒绝
状态与 `retiredAt` 不一致的受损聚合。覆盖率达到
97.55%/96.32%/100%/97.60%（语句/分支/函数/行），独立四维 90% 门禁已接入
`pnpm check`。

审批入口控制器已覆盖 41 项完整 REST、精确 Scope、ULID、幂等键、强
`If-Match`、ETag、模板/委托/实例操作与审计终态测试；R0 读取审计保持失败
关闭，R1/R2 写入提交后的审计故障只作稳定告警，不反向暴露为业务失败。
覆盖率达到四维 100%，独立四维 90% 门禁已接入 `pnpm check`。

招聘渠道职位投递已覆盖 40 项强版本顺序、稳定幂等键、加密外部映射、唯一键
竞态、发布/暂停/下架、精确回执、运行时租户闭包、结果未知隔离和显式
`not_committed` 重试测试；业务终态后的审计故障只作独立告警。覆盖率达到
95.45%/92.38%/100%/97.25%（语句/分支/函数/行），独立四维 90% 门禁已接入
`pnpm check`。

招聘渠道阶段回传已覆盖 30 项强版本顺序、本地来源跳过、加密申请映射、稳定
幂等键、精确回执、运行时租户闭包、结果未知隔离和显式 `not_committed`
重试测试；业务终态后的审计故障只作独立告警。覆盖率达到
96.52%/92.36%/100%/97.72%
（语句/分支/函数/行），独立四维 90% 门禁已接入 `pnpm check`。

招聘渠道人工处置已覆盖 19 项可信租户分页、脱敏摘要、职位/阶段统一处置、
幂等重入、批准例外、供应商确认未提交、R2 审计和非法参数测试；不能伪造
外部成功，且明确不注册 MCP Tool。两个生产文件合计覆盖率达到
100%/94.11%/100%/100%，独立四维 90% 门禁已接入 `pnpm check`。

招聘渠道补拉边界已覆盖 85 项凭据命名空间、到期调度、可信系统身份、绑定回读
闭包、加密游标前进、精确响应、事件唯一性、纯 JSON 资源预算、盲索引去重、
唯一键竞态、确定性队列恢复和失败租约测试；两个生产文件合计覆盖率达到
98.22%/95.47%/100%/98.40%（语句/分支/函数/行），逐文件四维均不低于
90%，既有独立门禁已扩展并接入 `pnpm check`。

招聘管理已覆盖 70 项可信租户、部门级读写范围、HC 审批 Saga 恢复、迁移审批
证据、不可变重放、组织引用、职位状态机、门户最小投影、乐观锁和错误映射测试；
提交与审批同步在预检和事务内均强制部门写范围，已绑定审批的待审批 HC 按精确
版本幂等恢复。覆盖率达到 99.51%/99.45%/100%/100%
（语句/分支/函数/行），独立四维 90% 门禁已接入 `pnpm check`。

人才全周期应用已覆盖 17 项读写 Scope、最小 MCP 投影、全阶段推导、完整时间线、
候选人/校友联系授权、触点负责人、乐观锁与稳定错误契约测试；候选人联系授权
或保留期为非法时间时改为失败关闭，避免 `Date.parse()` 的 `NaN` 绕过。覆盖率
达到 100%/96.85%/100%/100%（语句/分支/函数/行），独立四维 90% 门禁已接入
`pnpm check`。

人才全周期仓储已覆盖 20 项可信租户、授权前非敏感投影、备注密文组合、AAD
解密、候选人时间线、会话绑定、跨租户拒绝、乐观锁和损坏密文失败关闭测试；
覆盖率达到 100%/97.05%/100%/100%（语句/分支/函数/行），独立四维 90%
门禁已接入 `pnpm check`。

人才全周期 REST 写入口已对资源 ULID、幂等键、强 `If-Match`、严格请求体和
未知字段失败关闭；业务异常记录独立 R2 失败审计，事务提交后的成功审计故障仅
稳定告警，不再把已提交终态暴露为失败。事务 Outbox 仅接受创建、完成和取消三类
动作，严格闭合触点字段、动作/状态/版本、可信租户、活动 Mongo 事务、最小
CloudEvent 与数据库回执。80 项专项测试使两个生产文件四维均达到 100%，两个
独立四维 90% 门禁已接入 `pnpm precheck` 与 `pnpm check`。事件名、REST 与
标准 MCP 契约不变；MCP 不开放触点写入、Outbox、人工处置或重放。真实事件总线、
角色映射与 HR/员工关怀/校友跨角色 UAT 仍待现场验收。

Care 离职应用已补齐 36 项可信组织主数据、审批恢复、清算证据、R3 Saga、
校友授权和异常语义测试，服务覆盖率达到 99.54%/97.43%/100%/100%
（语句/分支/函数/行），独立四维 90% 门禁已接入 `pnpm check`。

MCP HTTP 入口已覆盖 26 项固定路由、精确 Origin、`/mcp/` 尾斜杠、连接 Scope、HttpOnly
会话、R1/R2 状态、WebAuthn 仪式、显式可信用户审计和审计故障测试。公共确认
端点不建立请求租户上下文，因此确认审计必须使用浏览器会话解析出的租户、主体和
会话标识调用 `recordTrustedUser`；禁止调用依赖请求上下文的 `record`。确认状态
推进后的审计异常只记录稳定告警，不得把已生成的一次性凭据反向暴露为失败。
确认控制器、全局 Origin Guard 和 MCP 控制器合计覆盖率达到四维 100%，独立四维
90% 门禁已接入 `pnpm check`。

标准 MCP 运行时已使用官方 Client 覆盖 22 个 Prompt、47 个 Tool 与 27 个
受控 Resource 入口，并验证 Origin 白名单、参数失败关闭、最小 fallback 和
无权读取语义；覆盖率达到 97.97%/95.67%/97.32%/98.88%
（语句/分支/函数/行），独立四维 90% 门禁已接入 `pnpm check`。

MCP Tool 应用层已覆盖 43 项可信身份、Scope、只读投影、R1/R2 准备与执行、
确认重放、命令错配、非法 Resource Link、服务端幂等键和提交后审计隔离测试。
返回值在确认账本完成前校验并序列化，账本完成后的审计故障只形成稳定告警，
不释放已完成操作。覆盖率达到四维 100%，独立四维 90% 门禁已接入
`pnpm check`。

OP 审批桥入站申请已覆盖 32 项可信 Worker 上下文、载荷完整性、受控路由、
来源单据唯一桥接、租约、4xx/5xx 分类、重放、桥接冲突和提交后审计隔离测试。
审批与 Inbox 终态提交后的审计故障只形成稳定错误，不回写失败或覆盖原始错误；
外部异常码只有符合固定格式时才可持久化。覆盖率达到四维 100%，独立四维 90%
门禁已接入 `pnpm check`。

OP 审批结果回传已覆盖 70 项 Outbox 身份绑定、终态筛选、桥接版本单调性、
投递幂等冲突、事务与租约竞争、HMAC 最小载荷、响应回显、退避/死信及审计隔离
测试。Relay 必须精确绑定 CloudEvent 顶层与数据身份到 Outbox 元数据，且只用
精确旧版本乐观锁推进桥表；已有投递的任一不可变控制字段不一致即失败关闭。
成功或失败终态后的审计故障只形成稳定告警，非规范外部错误码统一收敛为固定领域
错误。两个目标文件合计覆盖率达到四维 100%，独立四维 90% 门禁已接入
`pnpm check`。

审批 Outbox 运行时边界已覆盖 49 项十五类模板、历史、实例与委托事件、严格外层
信封、逐类型 payload、可信租户、标识、正安全版本、规范 UTC 时间、摘要、迁移
状态/动作数、决策结果/终态/代理关系、转交差异、撤回唯一收件人、三十天委托和
持久化失败测试。payload 先规范复制，再由权威租户、聚合与版本字段覆盖；任何
未知字段、保留字段覆盖、表单正文或状态组合错位均以
`APPROVAL_OUTBOX_EVENT_INVALID` 在写入前失败关闭。目标生产文件覆盖率达到四维
100%，独立逐文件 90% 门禁已接入 `pnpm precheck` 与 `pnpm check`。该边界直接
保护 OP 审批终态 Relay 的输入，未新增或放宽任何 MCP Tool、Resource 或 Prompt。

OP 经营摘要与审批请求 Webhook 双入口已覆盖 125 项控制器 query 禁止、六认证
头、HMAC 原始字节、时间窗、可信 clientId 租户绑定、受控路由、防重放、Inbox
唯一键竞态、AES-256-GCM 独立密钥域/轮换/AAD/篡改、正文上限及审计故障测试。
无法归属租户的认证头仍统一拒绝；租户解析后的失败审计异常不覆盖稳定 HTTP
错误，成功入箱和排队后的审计异常也不反向暴露为失败。两个控制器、两个入口服务
和两个独立加密服务合计覆盖率达到 98.34%/96.13%/100%/100%
（语句/分支/函数/行），独立四维 90% 门禁已接入 `pnpm check`。

OP 经营摘要可靠处理链路已覆盖 114 项入箱排队、可信 Worker 上下文、任务与
租户隔离、认领栅栏、租约恢复、4xx/5xx 分类、重试耗尽、事务 Outbox、最小
REST/MCP 投影和提交后审计隔离测试。BullMQ JobId 绑定租户、Inbox 与载荷摘要，
Worker 通过任务标识、随机令牌及 15 分钟租约栅栏推进状态；同任务可立即恢复未
完成终态，其他任务只能在租约过期后接管。业务事务提交后的终态或审计异常不得
反向登记业务失败或重复执行副作用；OP 审批结果 R2 重试的决策审计同样采用提交
后隔离。五个目标生产文件合计覆盖率达到 99.34%/97.35%/100%/100%
（语句/分支/函数/行），逐文件四维 90% 门禁已接入 `pnpm check`。REST 与标准
MCP 只返回日期、修订、币种和五项经营指标，不暴露内部标识、载荷摘要或接收时间，
也不开放重试、对账和运维写能力。

Treasury Outbox 已覆盖 13 项可信租户、精确事件字段、状态、强认证方法、
文件摘要、回盘与对账最小载荷测试；覆盖率达到 98.48%/98.67%/100%/98.46%
（语句/分支/函数/行），独立四维 90% 门禁已接入 `pnpm check`。

Phase 4 考勤、薪酬和资金 REST 入口已覆盖 32 项固定路由、HTTP 方法、最小
Scope、旧算薪边界守卫、幂等键、月份格式、强认证令牌、ETag、最小审计载荷
和提交后审计隔离测试。业务事务、WORM 或银行副作用提交后的审计故障只记录
不含异常正文和业务载荷的稳定告警，不向客户端反向暴露失败；敏感读取审计仍
失败关闭。三个控制器合计四维覆盖率均为 100%，独立逐文件四维 90% 门禁已
接入 `pnpm check`；MCP 风险边界未扩大。

审计链 WORM 锚定服务已覆盖 8 项验链、链头漂移、不可变回执幂等与竞争、
批量边界和并发收敛测试，覆盖率达到四维 100%；独立四维 90% 门禁已接入
`pnpm check`。

审计链验证服务已覆盖连续序号、前向哈希、事件 HMAC、链头一致性、空链、
资源标识和 1,000 条满批分页，覆盖率达到四维 100%；独立四维 90% 门禁已接入
`pnpm check`。

组织主数据应用服务已覆盖 34 项可信租户、组织视图裁剪、岗位/职级/员工引用、
入职与迁移事实幂等、Care 离职终态、乐观锁和失败关闭测试；覆盖率达到
97.44%/93.52%/100%/97.50%（语句/分支/函数/行），独立四维 90% 门禁已接入
`pnpm check`。

组织主数据入口控制器已覆盖 31 项完整 REST、精确 Scope、ULID、幂等键、
强 `If-Match`、ETag、Care 离职边界和审计终态测试；主数据写入后的审计故障
只记录稳定告警，不反向暴露为业务失败。覆盖率达到四维 100%，独立四维 90%
门禁已接入 `pnpm check`。

薪酬主数据服务已覆盖 17 项可信连接器、审批/WORM 证据、L4 加密回读、
生效区间与版本链、员工引用、规则确定性和并发失败关闭测试；覆盖率达到
四维 100%，独立四维 90% 门禁已接入 `pnpm check`。

专业算薪主数据快照已覆盖 25 项固定路由、最小 Scope、可信服务/系统任务、
脱敏投影、200 条分页、租户绑定摘要、规范 Base64URL、精确游标字段、合法
页边界、跨租户/变更后重放拒绝和批量读取审计测试。审计只记录页计数与摘要，
不记录人员正文；审计不可用时读取失败关闭。服务与控制器合计覆盖率达到
98.21%/96.42%/100%/100%（语句/分支/函数/行），独立四维 90% 门禁已接入
`pnpm check`；该批量接口只供专业算薪服务同步，不注册为 MCP 能力。

薪酬四方对账服务已覆盖 18 项 Treasury/银行/税务证据、职责分离、差异冻结、
迁移不可变回放、周期并发和状态证据一致性测试，并修复历史 `updatedAt`
未持久化导致幂等回放失败的问题；覆盖率达到
96.42%/96.79%/100%/98.96%（语句/分支/函数/行），独立四维 90% 门禁已接入
`pnpm check`。

薪酬税务申报服务已覆盖 28 项 WORM 清单、组织身份、人员职责分离、WebAuthn、
生产授权、税局回执、迁移重放、明文销毁、乐观锁和失败关闭测试；生产授权摘要
已绑定不可变对象证据、审批人和强认证证据。覆盖率达到
98.88%/98.58%/100%/100%（语句/分支/函数/行），独立四维 90% 门禁已接入
`pnpm check`。

Payroll Tax 双出口已覆盖 131 项固定标准 HTTPS、运行时凭据、规范清单
UTF-8/JSON 根绑定、WORM 对象键/摘要/十年保留期、最小税务提交、短时生产授权、
确定性幂等、非 2xx 正文隔离、Content-Length、16 KiB 流式硬上限、读取清理和
完整回执 Schema 绑定测试。归档适配器达到四维 100%，提交适配器达到
98.14%/98.52%/100%/97.82%，共享读取器达到
100%/96.66%/100%/100%；三个文件合计为
99.35%/98.57%/100%/99.25%（语句/分支/函数/行）。独立逐文件四维 90% 门禁
由个税申报总门禁接入 `pnpm check`。REST 与标准 MCP 继续只读脱敏控制摘要，
不暴露税务正文、WORM 地址、凭据、归档或提交能力；真实税务沙箱、WORM 锁定与
保留证明、限流、Secret 轮换和生产授权域仍待现场验收。

薪酬 L4 数据加密服务已覆盖 8 项上下文/AAD、密钥轮换、严格密钥环、
IV/Tag 固定长度、规范 Base64URL、密文篡改、8 MiB 上限和失败关闭测试；
外部密文在解码前执行长度约束，非规范主密钥稳定归类为密钥环错误。覆盖率达到
96.51%/94.54%/100%/98.59%（语句/分支/函数/行），独立四维 90% 门禁已接入
`pnpm check`。

资金支付服务已覆盖 22 项锁定工资、银行账户密文、WORM 文件、WebAuthn
审批、生产授权、银行提交、迁移回放、明文销毁和并发失败关闭测试；生产授权
摘要绑定不可变对象证据、批准人与强认证证据，覆盖率达到
93.88%/93.23%/96.05%/95.77%（语句/分支/函数/行），独立四维 90% 门禁已接入
`pnpm check`。

Treasury WORM 证据出口已覆盖 98 项固定标准 HTTPS `POST /v1/objects`、运行时
独立凭据、十年至一百年保留期、租户/批次 ULID、确定性幂等、pain.001 固定
Schema、唯一 MsgId/PmtInfId、DOCTYPE/ENTITY 禁用、对象键与摘要绑定、非 2xx
正文隔离、严格 JSON Content-Type、Content-Length、16 KiB 流式硬上限、Fatal
UTF-8、读取取消与完整回执反向绑定测试。目标适配器达到
100%/97.77%/100%/100%（语句/分支/函数/行），独立逐文件四维 90% 门禁由资金
支付总门禁接入 `pnpm check`。REST 与标准 MCP 不新增归档、文件读取或资金写
能力；真实 Object Lock、法定保留证明、Secret 轮换、断连和限流仍待现场验收。

ERP→银行支付提交信任边界已覆盖 71 项固定标准 HTTPS
`/v1/submissions`、POST、固定 Header、独立凭据、sandbox/production 模式、
短时生产授权、确定性幂等、非 2xx 状态分类、Content-Length、16 KiB 流式硬
上限、读取取消、严格 UTF-8/JSON、完整回执 Schema 与原批次控制量精确绑定测试。
网络、读取、取消和释放异常不再泄漏上游 cause 或覆盖已确定结果；目标适配器达到
99.01%/96.70%/100%/98.87%（语句/分支/函数/行），独立逐文件四维 90% 门禁
由资金支付门禁接入 `pnpm check`。REST 与标准 MCP 不新增资金执行能力；真实
银行签名加密、沙箱回执、限流和生产授权域仍待现场验收。

Treasury 银行回盘服务已覆盖 37 项可信连接器、签名与恶意文件证据、密文金额、
乱序/未来时间、迁移重放、支付指令冻结、乐观锁和失败关闭测试；覆盖率达到
97.04%/96.27%/100%/97.05%（语句/分支/函数/行），独立四维 90% 门禁已接入
`pnpm check`。

Treasury 银行回盘 Inbox 入站边界已覆盖 65 项固定标准 HTTPS
`POST /v1/returns/claim`、固定 Header、独立凭据、确定性幂等、非 2xx 正文
隔离、Content-Length、4 MiB 流式硬上限、读取取消、严格 UTF-8/JSON、完整
清单 Schema 与领取对象精确绑定测试；验签失败和恶意文件等负面证据保留给应用
服务整批冻结，禁止适配器静默丢弃。目标适配器达到
98.90%/96.15%/100%/98.70%（语句/分支/函数/行），独立逐文件四维 90% 门禁
由回盘服务门禁接入 `pnpm check`。REST 与标准 MCP 不新增回盘领取、上传或处理
能力；真实银行回盘验签、恶意文件、限流和 WORM 联调仍待现场验收。

Treasury L4 数据加密服务已覆盖 10 项上下文/AAD、独立加密与盲索引密钥环、
无停机轮换、规范 Base64URL、固定 IV/Tag、外部密文预解码长度、8 MiB 上限和
失败关闭测试；非规范主密钥稳定归类为密钥环错误，持久化 Schema 同步固定真实
IV 编码长度。覆盖率达到 98.26%/96.82%/100%/99.00%（语句/分支/函数/行），
独立四维 90% 门禁已接入 `pnpm check`。

Phase 6 生产执行授权服务已覆盖 10 项发布物/主体精确绑定、HTTPS 端点、
一次性 WORM 证据、响应体上限、严格 JSON、短时窗口与上游失败关闭测试，
并将非法 URL 统一映射为稳定领域错误；覆盖率达到四维 100%，独立四维 90%
门禁已接入 `pnpm check`。

数据迁移控制面入口与附件链路已覆盖 169 项 REST 最小静态 Scope、应用服务动态
业务域授权、`sourceVersion` 规范字符、提交后审计隔离、确定性 JobId、
原租约 fencing、严格运行时载荷、固定标准 HTTPS、16 KiB 流式响应上限、Fatal
UTF-8、严格 JSON 回执，以及租户/运行/来源/附件完整反向绑定测试。业务附件服务
进一步固定严格迁移输入、最小持久化投影，并校验归属类型/用途、checksum、状态、
版本、对象证据和可用时间组合；受损记录在更新与 Outbox 前失败关闭，available
重放仅接受同一目标证据。九个目标生产文件合计覆盖率达到
99.54%/98.24%/100%/99.50%（语句/分支/函数/行），且每个文件四维均不低于
90%；独立门禁已接入 `pnpm precheck` 与 `pnpm check`。标准 MCP 继续只读并
复用迁移应用服务，不开放迁移写入、附件执行、附件对象、checksum 或上传员工
能力；真实来源系统、对象存储、恶意文件扫描、断连追赶与三次迁移演练仍待现场验收。

Talent Lifecycle 四域来源完整性已覆盖 10 项组织、招聘、入职与 Care 窄查询口
测试，逐项校验可信租户、候选人、申请、职位、阶段事件、自然人、劳动关系、员工、
离职案件和校友授权引用闭包。四个目标生产文件合计覆盖率为四维 100%，逐文件
四维 90% 门禁已接入 `pnpm check`。REST 与标准 MCP 契约不变，MCP 仍只复用
`TalentLifecycleService.getForMcp` 返回最小只读投影；真实全周期数据回放、部门
权限映射和 HR/员工关怀/校友 UAT 仍待现场验收。

Recruitment → Onboarding 桥接已覆盖 31 项受信任服务 Scope、最小入职投影、
Offer/Application/Candidate/Position 引用闭包、幂等预入职与录用终态测试；
桥接服务四维覆盖率为 100%，独立 90% 门禁已接入 `pnpm check`。`hired` 只允许
由已签署 Offer 推进，阶段事件记录 Onboarding 完成证据，Candidate Application
另存 Employment 引用，避免把业务完成证明与结果标识混用。标准 MCP 不新增该
跨域写能力；真实 eSign、代表性招聘入职回放及 HR UAT 仍待现场验收。

Onboarding 聚合与任务证明仓储已覆盖 104 项可信租户、实例/Offer/候选人查询
绑定、固定最小投影、状态/版本/时间/证明闭包、有界稳定时间线、活动事务、创建
回执和乐观锁更新结果测试。受损或错位记录在进入应用服务前整体失败关闭，聚合
插入、更新和证明追加不得在非事务会话中执行；目标仓储文件四维覆盖率为 100%，
独立 90% 门禁已接入 `pnpm precheck` 与 `pnpm check`。REST、事件与标准 MCP
契约不变，MCP 仍只复用入职应用服务返回部门裁剪摘要，不读取任务证明或执行
R3 建档；真实 eSign/Recruitment/Org 端到端回放和 HR UAT 仍待现场验收。

## 6. 架构边界

`docs/phase-4/05-payroll-core-implementation.md` 记录的月中多次变更、跨法域拆分、
补充/冲正和年度汇算是旧 ERP 算薪基线的未实现能力。根据
`docs/phase-0/07-payroll-system-boundary.md`，专业算薪系统已经成为工资唯一事实源，
ERP 默认以 `PAYROLL_SYSTEM_MODE=external` 关闭旧工资/资金 REST。因此这些能力
不是当前 ERP 仓库的遗漏；若要重新纳入，必须先以新 ADR 替代现有系统边界。

## 7. 后续执行顺序

1. 按风险优先补齐全仓和其余关键链路测试；达到章程阈值后再启用全仓不可回退
   门禁，并保留原始覆盖率报告。
2. 在不付费、不使用自建基础设施的前提下等待 GitHub Hosted Actions 免费额度或
   账号限制恢复；新 commit 只触发一次并记录原始结论。
3. 用户批准最小 Project 权限后完成 Issue #41；未批准前继续以 Milestone、标签、
   Issue 和 Draft PR 管理，不把看板缺失描述为完成。
4. 取得真实目标环境后按 Phase 1 → 5 → 6 顺序执行外部联调、迁移/性能/安全/容灾
   演练、UAT、Go/No-Go、切换与 Hypercare。
5. 每项外部证据必须绑定 commit、镜像摘要、环境、原始记录和签署；通过后再勾选
   Issue 验收项、关闭子项并按 DoD 推进 Epic。
