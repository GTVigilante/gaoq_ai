# 仓库实施完成度审计

- 审计日期：2026-07-27
- 审计对象：Phase 0–6、开放 Issue、Draft PR #122 与 GitHub 治理配置
- 结论：应用、契约、迁移控制面、生产门禁、Helm/Kubernetes 编排和标准 MCP
  已形成仓库实施基线；真实外部联调、目标环境演练、UAT、切换与 Hypercare
  尚未完成。Phase 0 的 GitHub Project 因最小权限未授权而未配置，全仓覆盖率
  也尚未达到强制门槛，因此所有 Phase 均不得标记生产完成。

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
| 0 | `docs/phase-0/`、Issue 模板、7 个 Milestone、标签及 Draft PR 流程 | Issue #41 的 GitHub Project 需要 `project` 权限；全仓覆盖率未达到 80%，其余关键链路 90% 证据尚未全部建立 | 未满足退出条件 |
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

2026-07-27 在 Node 22 与锁定依赖下执行
`pnpm --filter @gaoq/erp-api test:coverage`，321 个测试文件、1,829 项测试全部
通过；覆盖率为语句 80.14%、分支 72.01%、函数 82.33%、行 82.72%。分支仍低于
Phase 0 规定的全系统 80% 门槛，必须作为实施缺口继续处理，禁止
通过排除生产文件、降低阈值或只报告局部高覆盖率来宣称达标。

租户上下文、身份授权、审批数据加密、审批仓储、审批应用状态机、MCP 确认、
薪酬影子周期、薪酬运行、薪酬审批、Care 纪念日应用、Care 离职应用、
数据迁移控制面、Knowledge 考试运行 Relay、Knowledge 搜索索引 Relay、考勤应用、
招聘 Offer、Care 仓储、组织仓储、招聘仓储、知识库仓储和营销 CMS 服务已建立
独立不可回退门禁：
`pnpm quality:tenant-context-coverage`、
`pnpm quality:authorization-coverage`、
`pnpm quality:approval-crypto-coverage`、
`pnpm quality:mcp-confirmation-coverage` 和
`pnpm quality:payroll-shadow-coverage`、
`pnpm quality:payroll-run-coverage`、
`pnpm quality:payroll-approval-coverage`、
`pnpm quality:care-occasion-application-coverage`、
`pnpm quality:care-application-coverage`、
`pnpm quality:data-migration-coverage`、
`pnpm quality:knowledge-exam-run-relay-coverage`、
`pnpm quality:knowledge-search-index-relay-coverage`、
`pnpm quality:attendance-application-coverage`、
`pnpm quality:recruitment-offer-coverage`、
`pnpm quality:care-repositories-coverage` 和
`pnpm quality:org-repositories-coverage`、
`pnpm quality:recruitment-repositories-coverage`、
`pnpm quality:knowledge-repositories-coverage`、
`pnpm quality:marketing-cms-service-coverage`、
`pnpm quality:approval-repositories-coverage` 和
`pnpm quality:approval-application-coverage`。二十一条链路当前覆盖率分别为
100%/100%/100%/100%、100%/95.83%/100%/100%、
98.75%/96.96%/100%/100%、
98.06%/94.04%/98.64%/99.02%、
94.62%/90.76%/98.19%/95.96%、100%/97.74%/100%/100%、
99.00%/97.24%/97.29%/98.84%、92.18%/90.20%/96.10%/93.18%、
100%/100%/100%/100%、
100%/96.85%/100%/100%、
99.54%/97.43%/100%/100%、
93.37%/90.19%/97.97%/95.29%、
98.06%/94.04%/100%/100%、
100%/100%/100%/100%、
99.20%/99.17%/100%/99.11%、
95.97%/94.01%/100%/96.83%、
100%/91.66%/100%/100%、100%/100%/100%/100%、
97.44%/91.32%/100%/99.53%、100%/99.43%/100%/100% 和
100%/97.27%/100%/100%（语句/分支/函数/行）；二十一项阈值均固定为 90%，
使用相互隔离的报告目录，并已接入 `pnpm check`。这只证明二十一条关键链路达标，
不替代全仓 80% 或其余关键服务 90% 的证据。

数据迁移控制面已有 61 项幂等重放、证据分页、检查点竞争、关联映射、附件与
全域负载失败关闭测试，服务覆盖率达到 93.37%/90.19%/97.97%/95.29%
（语句/分支/函数/行），独立四维 90% 门禁已接入 `pnpm check`。

Knowledge 考试运行 Relay 已补齐 24 项隔离网关、超时封存、自动/人工评分、
事务终态、审计隔离、退避、死信与熔断测试，服务覆盖率达到
98.06%/94.04%/100%/100%（语句/分支/函数/行），独立四维 90% 门禁已接入
`pnpm check`。

Knowledge 搜索索引 Relay 已补齐 5 项幂等回执、时间边界、参数约束、认领竞争、
指数退避与死信测试，服务覆盖率达到四维 100%，独立四维 90% 门禁已接入
`pnpm check`。

Care 离职应用已补齐 36 项可信组织主数据、审批恢复、清算证据、R3 Saga、
校友授权和异常语义测试，服务覆盖率达到 99.54%/97.43%/100%/100%
（语句/分支/函数/行），独立四维 90% 门禁已接入 `pnpm check`。

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
