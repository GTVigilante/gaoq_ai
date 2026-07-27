# 仓库实施完成度审计

- 审计日期：2026-07-27
- 审计对象：Phase 0–6、开放 Issue、Draft PR #122 与 GitHub 治理配置
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
| 0 | `docs/phase-0/`、Issue 模板、7 个 Milestone、标签及 Draft PR 流程 | Issue #41 的 GitHub Project 需要 `project` 权限；全仓覆盖率以 114 个分支余量达到 80%，其余关键链路 90% 证据尚未全部建立 | 未满足退出条件 |
| 1 | `apps/erp-api/src/modules/auth/`、`org/`、`security/`、`integration/`，`deploy/helm/`，Phase 1 工作流 | 境内云 VPC、WAF/KMS、真实 SSO/组织下发、监控告警、备份恢复与 RPO/RTO 演练 | 实施已交付，外部验收待完成 |
| 2 | `apps/erp-api/src/modules/approval/`、审批前端、通知、迁移与 MCP 能力 | 氚云模板/历史/在途审批真实盘点迁移、三次演练和业务签署 | 实施已交付，外部验收待完成 |
| 3 | 招聘、eSign、Onboarding、Knowledge、Care、Talent Lifecycle 360 及对应 REST/事件/MCP | 真实渠道、e签宝、对象/WORM、OpenAI/搜索/评分/通知、CRM/校友平台与跨角色 UAT | 实施已交付，外部验收待完成 |
| 4 | 考勤、版本化薪酬、审批、银行/税务、对账、影子周期控制面及 MCP | 专业算薪真实联调、银行/税务沙箱、两个完整影子周期、差异清零和财务签署 | 实施已交付，外部验收待完成 |
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
- Draft PR #122 承载当前实现；合入前仍需评审、可运行 CI 与所有适用 DoD。
- GitHub Hosted Actions 当前在任何 Job 步骤开始前被账号付款或 Spending limit
  拦截。该状态既不是代码测试失败，也不是 CI 通过；相同 commit 不重复空跑。
- Issue #41 需要用户明确授权 `read:project,project` 后才能创建 Project。未获授权
  前保持阻塞，不扩大 OAuth 权限。
- Phase 3 新增 Issue #123–#126 必须归入 Phase 3 Milestone，维持“一项工作只归属
  一个 Milestone”的治理要求。

## 5. 覆盖率边界

2026-07-28 在 Node 22 与锁定依赖下执行
`pnpm --filter @gaoq/erp-api test:coverage`，323 个测试文件、2,546 项测试全部
通过；覆盖率为语句
86.01%（23,612/27,452）、分支 80.58%（15,590/19,345）、函数
88.12%（4,328/4,911）、行 87.86%（21,633/24,621）。全仓四维已达到 Phase 0
规定的 80% 门槛，分支高于最低值 114 个；必须保留专项 90% 门禁并继续增加
安全余量，禁止通过排除生产文件、降低阈值或只报告局部高覆盖率维持达标。

租户上下文、审计链锚定、审计链验证、组织主数据应用、组织主数据入口、身份授权、审批数据加密、审批仓储、
审批应用状态机、审批模板领域、
MCP 确认、MCP 运行时、
薪酬影子周期、薪酬运行、薪酬审批、薪酬主数据、薪酬四方对账、薪酬税务申报、薪酬 L4 数据加密、资金支付、Treasury 银行回盘、Treasury L4 数据加密、Treasury Outbox、Care 纪念日应用、Care 离职应用、校友授权清理协调、
数据迁移控制面、数据迁移打包 CLI、Knowledge 考试运行 Relay、Knowledge 搜索索引 Relay、考勤应用、考勤仓储、考勤供应商拉取、考勤供应商入站处理、电子签回调处理、
招聘渠道拉取、招聘渠道入站处理、招聘渠道职位扇出、招聘渠道阶段扇出、招聘申请、招聘面试、招聘简历、招聘渠道职位投递、招聘渠道阶段回传、招聘管理、人才全周期应用、人才全周期仓储、招聘 Offer、Care 仓储、组织仓储、招聘仓储、知识库仓储、营销 CMS、OAuth 授权控制器、WebAuthn 强认证、入职应用与入口控制器和生产执行授权服务已建立
独立不可回退门禁：
`pnpm quality:tenant-context-coverage`、
`pnpm quality:audit-anchor-coverage`、
`pnpm quality:audit-chain-verification-coverage`、
`pnpm quality:org-application-coverage`、
`pnpm quality:org-controller-coverage`、
`pnpm quality:authorization-coverage`、
`pnpm quality:approval-crypto-coverage`、
`pnpm quality:mcp-confirmation-coverage`、
`pnpm quality:mcp-runtime-coverage` 和
`pnpm quality:payroll-shadow-coverage`、
`pnpm quality:payroll-run-coverage`、
`pnpm quality:payroll-approval-coverage`、
`pnpm quality:payroll-master-data-coverage`、
`pnpm quality:payroll-reconciliation-coverage`、
`pnpm quality:payroll-tax-filing-coverage`、
`pnpm quality:payroll-data-crypto-coverage`、
`pnpm quality:treasury-disbursement-coverage`、
`pnpm quality:treasury-bank-return-coverage`、
`pnpm quality:treasury-data-crypto-coverage`、
`pnpm quality:treasury-outbox-writer-coverage`、
`pnpm quality:care-occasion-application-coverage`、
`pnpm quality:care-application-coverage`、
`pnpm quality:care-alumni-cleanup-coverage`、
`pnpm quality:data-migration-coverage`、
`pnpm quality:data-migration-package-coverage`、
`pnpm quality:knowledge-exam-run-relay-coverage`、
`pnpm quality:knowledge-search-index-relay-coverage`、
`pnpm quality:attendance-application-coverage`、
`pnpm quality:attendance-repositories-coverage`、
`pnpm quality:attendance-provider-pull-coverage`、
`pnpm quality:attendance-provider-processor-coverage`、
`pnpm quality:esign-webhook-processor-coverage`、
`pnpm quality:recruitment-channel-pull-coverage`、
`pnpm quality:recruitment-channel-processor-coverage`、
`pnpm quality:recruitment-channel-position-relay-coverage`、
`pnpm quality:recruitment-channel-stage-relay-coverage`、
`pnpm quality:recruitment-application-coverage`、
`pnpm quality:recruitment-interview-coverage`、
`pnpm quality:recruitment-resume-coverage`、
`pnpm quality:recruitment-channel-position-delivery-coverage`、
`pnpm quality:recruitment-channel-stage-delivery-coverage`、
`pnpm quality:recruitment-management-coverage`、
`pnpm quality:talent-lifecycle-application-coverage`、
`pnpm quality:talent-lifecycle-repository-coverage`、
`pnpm quality:recruitment-offer-coverage`、
`pnpm quality:care-repositories-coverage` 和
`pnpm quality:org-repositories-coverage`、
`pnpm quality:recruitment-repositories-coverage`、
`pnpm quality:knowledge-repositories-coverage`、
`pnpm quality:marketing-cms-service-coverage`、
`pnpm quality:approval-repositories-coverage` 和
`pnpm quality:approval-application-coverage`、
`pnpm quality:approval-template-domain-coverage`、
`pnpm quality:oauth-controller-coverage`、
`pnpm quality:strong-auth-coverage`、
`pnpm quality:onboarding-application-coverage`、
`pnpm quality:production-execution-authorization-coverage`。五十六条链路当前覆盖率分别为
100%/100%/100%/100%、100%/100%/100%/100%、
100%/100%/100%/100%、
97.44%/93.52%/100%/97.50%、
100%/100%/100%/100%、
100%/95.83%/100%/100%、
98.75%/96.96%/100%/100%、
98.06%/94.04%/98.64%/99.02%、
94.62%/90.76%/98.19%/95.96%、97.55%/96.32%/100%/97.60%、
100%/97.74%/100%/100%、
97.97%/95.67%/97.32%/98.88%、
99.00%/97.24%/97.29%/98.84%、92.18%/90.20%/96.10%/93.18%、
100%/100%/100%/100%、
100%/100%/100%/100%、
96.42%/96.79%/100%/98.96%、
98.88%/98.58%/100%/100%、
96.51%/94.54%/100%/98.59%、
93.88%/93.23%/96.05%/95.77%、
97.04%/96.27%/100%/97.05%、
98.26%/96.82%/100%/99.00%、
98.48%/98.67%/100%/98.46%、
100%/96.85%/100%/100%、
99.54%/97.43%/100%/100%、
100%/99.35%/100%/100%、
93.37%/90.19%/97.97%/95.29%、
95.26%/91.55%/92.30%/95.69%、
98.06%/94.04%/100%/100%、
100%/100%/100%/100%、
99.20%/99.17%/100%/99.11%、
100%/100%/100%/100%、
98.61%/97.00%/100%/99.21%、
100%/100%/100%/100%、
100%/100%/100%/100%、
100%/96.25%/100%/100%、
100%/100%/100%/100%、
100%/100%/100%/100%、
100%/100%/100%/100%、
100%/99.35%/100%/100%、
100%/100%/100%/100%、
99.30%/90.78%/100%/100%、
100%/97.46%/100%/100%、
100%/96.00%/100%/100%、
99.51%/99.45%/100%/100%、
100%/96.85%/100%/100%、
100%/97.05%/100%/100%、
95.97%/94.01%/100%/96.83%、
100%/91.66%/100%/100%、100%/100%/100%/100%、
97.44%/91.32%/100%/99.53%、100%/99.43%/100%/100%、
100%/97.27%/100%/100%、
96.09%/91.51%/100%/99.45%、
100%/100%/100%/100%、
100%/98.23%/100%/100% 和
100%/100%/100%/100%（语句/分支/函数/行）；五十六项阈值均固定为 90%，
使用相互隔离的报告目录，并已接入 `pnpm check`。这只证明五十六条关键链路达标，
不替代全仓 80% 或其余关键服务 90% 的证据。

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

考勤仓储已覆盖 17 项可信租户、源事实/修订/月快照密文读写、盲索引、迁移证据、
会话绑定、并发冲突和失败关闭测试，目标生产文件达到四维 100%，独立四维 90%
门禁已接入 `pnpm check`。

考勤供应商拉取已覆盖 50 项系统任务授权、加密游标、员工分页、小批拉取、Inbox
幂等、租约竞争、载荷规范化和失败关闭测试；部分游标密文字段不再被误判为首次
同步。覆盖率达到 98.61%/97.00%/100%/99.21%（语句/分支/函数/行），独立
四维 90% 门禁已接入 `pnpm check`。

考勤供应商入站处理已覆盖 30 项任务分派、可信系统身份、加密信封、传输证据、
标准化器版本、员工盲索引映射、检查点与租约竞争测试；业务成功、人工复核及
失败终态后的审计故障均只作独立告警。覆盖率达到四维 100%，独立四维 90%
门禁已接入 `pnpm check`。

电子签回调处理已覆盖 25 项任务分派、可信归档身份、加密信封、乱序事件、
流程乐观锁、证据归档队列和 Inbox 租约竞争测试；处理中任务仅在租约过期后
才能重领，流程投影后的审计故障不再误写业务失败。覆盖率达到四维 100%，
独立四维 90% 门禁已接入 `pnpm check`。

招聘渠道拉取已覆盖 34 项系统任务授权、凭据命名空间、加密游标完整性、渠道响应
上限、Inbox 唯一键竞争、确定性任务恢复和租约失败关闭测试；凭据不可用也会回写
稳定失败码。覆盖率达到 100%/96.25%/100%/100%（语句/分支/函数/行），独立
四维 90% 门禁已接入 `pnpm check`。

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

招聘渠道职位投递已覆盖 33 项强版本顺序、稳定幂等键、加密外部映射、唯一键
竞态、发布/暂停/下架、回执盲指纹、租约竞争、重试/死信和失败关闭测试；业务
终态提交后的审计故障只作独立告警，不再误写业务失败。覆盖率达到
100%/97.46%/100%/100%（语句/分支/函数/行），独立四维 90% 门禁已接入
`pnpm check`。

招聘渠道阶段回传已覆盖 23 项强版本顺序、本地来源跳过、加密申请映射、稳定
幂等键、非法回执、回执盲指纹、租约竞争、重试/死信和失败关闭测试；业务终态
提交后的审计故障只作独立告警。覆盖率达到 100%/96.00%/100%/100%
（语句/分支/函数/行），独立四维 90% 门禁已接入 `pnpm check`。

招聘渠道拉取已覆盖 34 项凭据命名空间、到期调度、可信系统身份、加密游标、
投递协议边界、盲索引去重、唯一键竞态、确定性队列恢复和失败租约测试；部分
游标密文字段不再被误判为首次拉取。覆盖率达到 100%/96.25%/100%/100%
（语句/分支/函数/行），独立四维 90% 门禁已接入 `pnpm check`。

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

Care 离职应用已补齐 36 项可信组织主数据、审批恢复、清算证据、R3 Saga、
校友授权和异常语义测试，服务覆盖率达到 99.54%/97.43%/100%/100%
（语句/分支/函数/行），独立四维 90% 门禁已接入 `pnpm check`。

标准 MCP 运行时已使用官方 Client 覆盖 22 个 Prompt、47 个 Tool 与 27 个
受控 Resource 入口，并验证 Origin 白名单、参数失败关闭、最小 fallback 和
无权读取语义；覆盖率达到 97.97%/95.67%/97.32%/98.88%
（语句/分支/函数/行），独立四维 90% 门禁已接入 `pnpm check`。

Treasury Outbox 已覆盖 13 项可信租户、精确事件字段、状态、强认证方法、
文件摘要、回盘与对账最小载荷测试；覆盖率达到 98.48%/98.67%/100%/98.46%
（语句/分支/函数/行），独立四维 90% 门禁已接入 `pnpm check`。

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

Treasury 银行回盘服务已覆盖 37 项可信连接器、签名与恶意文件证据、密文金额、
乱序/未来时间、迁移重放、支付指令冻结、乐观锁和失败关闭测试；覆盖率达到
97.04%/96.27%/100%/97.05%（语句/分支/函数/行），独立四维 90% 门禁已接入
`pnpm check`。

Treasury L4 数据加密服务已覆盖 10 项上下文/AAD、独立加密与盲索引密钥环、
无停机轮换、规范 Base64URL、固定 IV/Tag、外部密文预解码长度、8 MiB 上限和
失败关闭测试；非规范主密钥稳定归类为密钥环错误，持久化 Schema 同步固定真实
IV 编码长度。覆盖率达到 98.26%/96.82%/100%/99.00%（语句/分支/函数/行），
独立四维 90% 门禁已接入 `pnpm check`。

Phase 6 生产执行授权服务已覆盖 10 项发布物/主体精确绑定、HTTPS 端点、
一次性 WORM 证据、响应体上限、严格 JSON、短时窗口与上游失败关闭测试，
并将非法 URL 统一映射为稳定领域错误；覆盖率达到四维 100%，独立四维 90%
门禁已接入 `pnpm check`。

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
