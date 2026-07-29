# 仓库实施完成度审计

- 审计日期：2026-07-30
- 审计对象：Phase 0–6、开放 Issue、当前堆叠 Draft PR 与 GitHub 治理配置
- 结论：应用、契约、迁移控制面、生产门禁、Helm/Kubernetes 编排和标准 MCP
  已形成仓库实施基线；真实外部联调、目标环境演练、UAT、切换与 Hypercare
  尚未完成。全量 80% 与专项生产文件逐文件 90% 仓库门禁已经建立；Phase 0
  的 GitHub Project 因最小权限未授权而未配置，GitHub Hosted Actions 及
  架构/安全/业务签署尚无有效证据，因此所有 Phase 均不得标记生产完成。

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
| 0 | `docs/phase-0/`、Issue 模板、7 个 Milestone、标签、Draft PR、只读治理自动化、全量四维 80% 与 336 个生产文件逐文件四维 90% 门禁 | Issue #41 的 GitHub Project 需要 `project` 权限；Hosted Actions 真实执行及架构/安全/业务签署尚未取得 | 仓库实施已交付，外部/治理验收待完成 |
| 1 | `apps/erp-api/src/modules/auth/`、`org/`、`security/`、`integration/`，`deploy/helm/`，Phase 1 工作流 | 境内云 VPC、WAF/KMS、真实 SSO/组织下发、监控告警、备份恢复与 RPO/RTO 演练 | 实施已交付，外部验收待完成 |
| 2 | `apps/erp-api/src/modules/approval/`、审批前端、通知、迁移与 MCP 能力 | 氚云模板/历史/在途审批真实盘点迁移、三次演练和业务签署 | 实施已交付，外部验收待完成 |
| 3 | 招聘、eSign、Onboarding、Knowledge、Care、Talent Lifecycle 360 及对应 REST/事件/MCP | 真实渠道、e签宝、对象/WORM、OpenAI/搜索/评分/通知、CRM/校友平台与跨角色 UAT | 实施已交付，外部验收待完成 |
| 4 | 考勤事实、规则/排班、Provider 覆盖对账、版本化薪酬、审批、银行/税务、对账、影子周期控制面及 MCP | 真实考勤/专业算薪联调、银行/税务沙箱、两个完整影子周期、差异清零和财务签署 | 实施已交付，外部验收待完成 |
| 5 | OP、移动端、分析、迁移控制面、性能/安全/容灾/供应链/MCP、DAST/ASVS 四方、13 角色 Readiness 逐 Gate 独立 Ed25519 签名及十方 Go-No-Go 签名校验器 | 三轮生产等价实测、真实外部连接、DAST/ASVS、业务 UAT、真实角色密钥与签署 | 实施已交付，外部验收待完成 |
| 6 | 切换、回滚、部署、平台准入六方、统一切换五方及 Hypercare 归档三方独立 Ed25519 签名证据契约和受保护工作流 | 三次全量演练、生产级回滚、真实平台/切换/归档角色密钥与签署、统一切换、四周 Hypercare 与旧系统归档 | 实施已交付，外部验收待完成 |

## 3. 未完成 Issue 的实施证据

下表列出此前只有外部验收标签、但仓库已经具备实施控制面的工作项。添加
`status:implementation-delivered` 只确认这些路径存在，不勾选其现场验收清单。

| Issue | 仓库实施证据 | 必须保留的外部边界 |
|---|---|---|
| #12 云平台、CI/CD、监控与灾备 | `deploy/helm/gaoq-erp/`、`deploy/helm/gaoq-platform-guardrails/`、`scripts/release/validate-phase-6-platform-intake.mjs`、`docs/phase-5/17-resilience-rehearsal-gate.md`、`scripts/resilience/validate-phase-5-resilience-evidence.mjs` | 真实 VPC/WAF/KMS/短期 CI 身份、平台准入六方角色密钥与签署、观测平台、备份恢复及 RPO/RTO |
| #19 氚云审批模板迁移与 UAT | `apps/erp-api/src/modules/data-migration/`、`docs/phase-5/09-data-migration-control-plane.md`、`docs/phase-5/11-data-migration-package-runbook.md` | 真实模板、历史、在途实例、附件、三轮迁移与业务签署 |
| #31 两个薪资影子周期 | `apps/erp-api/src/modules/payroll/application/payroll-shadow.service.ts` 及对应测试、`docs/phase-5/20-readiness-verdicts.md` | 两个真实完整周期、100% 覆盖、零未解释差异、薪酬与财务签署 |
| #35 性能、安全、容灾与供应链 | `scripts/performance/validate-phase-5-capacity.mjs`、`.github/workflows/phase-5-performance.yml`、`scripts/security/validate-phase-5-dast-evidence.mjs`、`.github/workflows/phase-5-dast.yml`、`.github/workflows/phase-5-dast-evidence.yml`、`scripts/resilience/validate-phase-5-resilience-evidence.mjs`；容量 v2 要求三方逐次独立 Ed25519 签名，DAST/ASVS v2 要求四方独立签名，两者均绑定受信 keyset | 三次真实容量实测、生产等价 DAST/ASVS、真实职责密钥和签署、容灾现场演练及 WORM 原始证据 |
| #36 完整 MCP 目录与 AI 客户端兼容 | `docs/phase-5/19-mcp-capability-catalog.md`、`scripts/mcp/validate-phase-5-mcp-integration-evidence.mjs`、`.github/workflows/phase-5-mcp-integration.yml`；v3 联调证据要求四方独立 Ed25519 签名并绑定受信 keyset | Claude、Kimi、Cursor、Inspector 正式 Token 与授权业务调用、九类真实沙箱、专业算薪联调、真实职责密钥和四方签署 |
| #37 三次全量迁移演练 | `docs/phase-5/12-data-migration-rehearsal-gate.md`、`scripts/migration/validate-phase-5-migration-rehearsal-evidence.mjs`、`.github/workflows/phase-5-migration-rehearsal.yml`；v2 聚合证据要求四方独立 Ed25519 签名并绑定受信 keyset | 三份独立生产等价证据、8 小时窗口、真实职责密钥和四方签署 |
| #38 回滚与 Go/No-Go | `docs/phase-5/18-go-no-go-evidence-gate.md`、`scripts/release/validate-phase-5-go-no-go-evidence.mjs`、`scripts/resilience/validate-phase-5-resilience-evidence.mjs` | 生产级回滚、零 Sev1/Sev2/高危漏洞与跨职能签署 |
| #39 统一切换 | `docs/phase-6/00-unified-cutover-contract.md`、`docs/phase-6/02-production-execution-runbook.md`、`scripts/release/validate-phase-6-cutover-evidence.mjs` | 批准窗口内的真实冻结、增量迁移、连接切换、双人复核、旧系统只读、五方真实角色密钥与签署 |
| #40 四周 Hypercare | `docs/phase-6/01-hypercare-archive-contract.md`、`scripts/release/validate-phase-6-hypercare-evidence.mjs`、`.github/workflows/phase-6-hypercare.yml` | 连续四周 SLO、每日真实对账、差异闭环、三方真实角色密钥与归档批准 |

## 4. GitHub 与 CI 边界

- GitHub 是唯一代码协作、Issue、PR 与 CI 入口；不使用 NAS、自建 Runner、虚拟机
  或本地内网作为 CI 替代品。
- 当前实现由以 Draft PR #122 为根的堆叠 PR 承载，最新 Knowledge 切片为
  Draft PR #129；合入前仍需按顺序评审、可运行 CI 与所有适用 DoD。
- GitHub Hosted Actions 当前在任何 Job 步骤开始前被账号付款或 Spending limit
  拦截。该状态既不是代码测试失败，也不是 CI 通过；相同 commit 不重复空跑。
- Issue #41 需要用户明确授权 `read:project,project` 后才能创建 Project。未获授权
  前保持阻塞，不扩大 OAuth 权限。
- 2026-07-29 已对实时 GitHub 元数据完成一次性收敛：67 个历史 PR 补齐唯一
  Milestone，37 个历史 PR 补齐至少一个真实 Issue 关联，Issue #12 补齐明确的
  “当前阻塞/解除方式”。`scripts/github/validate-repository-governance.mjs`
  随后只读验收 7 个 Milestone、50 个 Issue 和 79 个 PR 全部通过。
- `.github/workflows/github-governance.yml` 已把上述规则转成最小只读权限门禁，
  23 个负向自测覆盖标签、状态、Epic 子项、PR Ready 前 CR、真实 Issue 关联、
  验证证据和来源分支；Hosted Actions 尚未分配 Runner，仍不得记为远端通过。

## 5. 覆盖率边界

2026-07-29 在 Node 22 与锁定依赖下执行
`pnpm --filter @gaoq/erp-api test:coverage`，436 个测试文件、7,140 项测试全部
通过。`vitest.config.ts` 已显式 `include: ['src/**/*.ts']`，因此测试未加载的
启动、Worker、Controller、迁移和适配器文件也进入分母；覆盖率为语句
93.18%、分支 91.01%、函数 93.25%、行 94.20%。全仓四维已达到 Phase 0
规定的 80% 门槛。全量命令通过
`pnpm quality:erp-api-global-coverage` 接入 `pnpm check`；禁止用默认的
“仅统计已加载文件”口径、排除生产文件、降低阈值或局部高覆盖率维持达标。

同日完整 `pnpm check`、显式公开 HTTPS Origin 的全工作区 `pnpm build` 与
`pnpm audit --audit-level high` 均通过，依赖审计未发现已知漏洞。该本地证据
只证明当前提交候选的工程门禁可重复执行，不替代 GitHub Hosted Actions、
目标环境联调、生产等价演练或人工签署。

`scripts/validate-critical-coverage-policy.mjs` 进一步从 `precheck/check` 递归
解析 134 个可达 ERP API 专项脚本，展开全部 `--coverage.include` glob，并要求
336 个目标生产文件与 `vitest.config.ts` 的显式逐文件四维 90% 阈值一一闭合。
租户、Identity、Approval、Payroll、Treasury 与 MCP 六类章程关键域按统一排除
规则形成 128 个权威生产文件；未来新增关键文件若未进入专项脚本会立即失败。
校验器同时拒绝缺失文件、未匹配 glob、重复属性、低阈值、只有阈值没有专项、
只有专项没有阈值、关键域分类遗漏及未接入 `precheck`，并以六类负向自测证明
失败关闭。本轮据此补齐 34 个此前仅受全量报告约束的关键文件，以及租户上下文
Service、招聘渠道人工运维 Service/Controller 三个组合报告下的单文件缺口。
由此关闭的是仓库质量策略缺口；GitHub CI 真实执行和 Phase 0 人工签署仍属于
独立验收条件。

2026-07-29 标准 MCP 已新增本地 stdio 入口。入口与远程 `/mcp` 共用运行时能力
注册和访问令牌验证器；短时 Token 必须具有 `erp:mcp:server:connect`，启动前
预检且每条消息重新验签，撤销、会话失效、过期或 Scope 缺失均立即关闭连接。
stdout 只允许 JSON-RPC。28 项专项测试覆盖传输失败关闭和真实字节流协议协商，
官方 TypeScript Client 已发现 50 个 Tool、4 个静态 Resource、27 个 Resource
Template 与 25 个 Prompt；
`pnpm quality:mcp-stdio-coverage` 已接入 `precheck/check`，三个目标生产文件
逐文件四维均不低于 90%。该仓库证据不替代 Claude、Kimi、Cursor、Inspector
实体客户端、远程 OAuth 或外部系统联调。

同日 stdio 进程入口已抽成独立失败关闭运行器，环境预检严格先于应用模块动态
加载，输入结束、信号、连接错误及启动中迟到的应用/协议资源共用按对象身份幂等
的清理状态机。自动化测试发现并关闭了应用加载与信号并发时重复关闭 Nest 上下文
的竞态；稳定码写入和资源关闭异常只提升失败退出状态，不泄漏内部详情。扩展后的
28 项专项测试覆盖三个目标生产文件，语句/分支/函数/行合计达到
99.25%/95.74%/96.42%/100%，逐文件四维均不低于 90%。由此关闭的是仓库入口
生命周期缺口，不替代 Inspector 授权读写与其他厂商客户端完整验收。

同日已使用 Kimi Code CLI 0.28.1 的正式 ACP 客户端层取得首个厂商实体目录
证据。`scripts/mcp/validate-kimi-mcp-client.mjs` 通过
`initialize → session/new → /mcp` 启动只读目录夹具，Kimi 经 stdio 报告
`gaoq-erp: connected (stdio, 50 tools)`；探针不调用模型、不执行业务 Tool，
并把结果绑定当前 `catalogHash`。这只证明 Kimi 当前版本可启动标准入口并发现
50 个 Tool，不证明真实短时 Token、Resource/Prompt、R0/R1/R2、撤销/重连或
业务 UAT；Issue #36 和 Kimi 整体仍保持外部验收状态。

同日完整 MCP 目录门禁已从仅覆盖 Tool 升级为实时解析 50 个 Tool、4 个静态
Resource、27 个 Resource Template 和 25 个 Prompt，并把四类目录与忽略注释/
格式差异的运行时语义摘要共同纳入 `catalogHash`。锁定在独立工具工作区的官方
MCP Inspector CLI 2.0.0 已通过正式 CLI 层依次执行四个 list 方法，逐项匹配
50/4/27/25；探针未读取 Resource、未渲染 Prompt、未调用业务 Tool/模型/数据库
或外部系统。Phase 5 MCP 联调与总 Go/No-Go 验证器现均精确绑定完整目录，
陈旧哈希、遗漏 Resource Template 或只满足数量下限都会失败。该仓库实体证据
不替代正式 Token、授权读写、远程 OAuth、撤销/重连、安全复核或业务 UAT，
Inspector 整体仍保持外部验收状态。

同日已关闭 GitHub-only 规范与 Phase 5/6 旧 self-hosted 运行手册之间的冲突。
全部 workflow 现均使用 GitHub Hosted `ubuntu-latest`；Phase 5 验收、
Phase 6 Cutover/Hypercare 及生产 Plan/Apply 通过 workflow/policy 专用
`id-token: write` 获取单次 GitHub OIDC 身份。通用下载器复核仓库 ID、`main`
commit、workflow、policy、audience 与 Hosted Runner claims，并对 HTTPS
脱敏输入执行无重定向、媒体类型、大小、响应 Header 摘要及实际字节摘要校验。
Kubernetes kubeconfig 不含静态凭据，ExecCredential 插件只接受最长 15 分钟
Token；Plan/Apply 使用不同 workflow、audience 与 RBAC Group。生产 Apply 还
验证变更负责人和 SRE 使用不同批准密钥形成的两份外部 Ed25519 签名、批准
keyset 以及独立 Plan 产物。四个入口的
专项负向自测已接入根 `test/check`，Phase 5/6 工作流静态门禁会拒绝
self-hosted 标签、本地挂载、长期 Secret 与未固定工具链。该仓库实现不证明企业
证据/凭据代理、外部签名服务、目标集群 OIDC 信任或 Hosted Actions 已可用；
当前账户仍在 Runner 分配前被计费状态阻塞，生产验收保持 No-Go。

2026-07-30 七类 Readiness 原始证据已从元数据式角色记录升级为
`gaoq.phase5.readiness.v2`。架构、变更、工程、财务、HR、法务、平台、隐私、
产品、QA、安全、SRE 和支持 13 个角色分别使用唯一 Ed25519 公钥；同一角色跨
Gate 保持同一主体和角色密钥，不同角色不得复用主体、公钥、证据或签名。每份
签名逐 Gate 覆盖完整量化证据、环境、commit、四镜像、部署清单、签署元数据和
完整 keyset；受保护工作流通过 `READINESS_SIGNER_KEYSET_SHA256` 绑定生产批准
角色/keyId 集合。负向自测覆盖伪签、签后篡改、角色换钥、公钥复用、主体复用/
漂移及 keyset 漂移。该仓库证据不替代真实人员身份、IAM/KMS 私钥授权、WORM
原始材料和现场签署。

2026-07-29 本人薪资单边界已下沉到 REST 与标准 MCP 共用的应用服务；
`PAYROLL_SYSTEM_MODE=external` 在读取身份画像、Mongo 或 L4 密文前稳定失败
关闭，MCP 返回 `PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM` 并写 R1 拒绝审计。
兼容模式严格反向绑定可信主体、员工画像、期间、运行和结果快照，校验密文信封、
解密 Schema、确定性重算与摘要，只返回冻结最小投影。66 项专项测试使目标服务
达到 100%/100%/100%/100%，独立逐文件四维 90% 门禁已接入 `pnpm precheck`
与 `pnpm check`；MCP Tool/Runtime 门禁继续高于 90%。真实专业算薪必须自行
提供以用户 OAuth 身份解析 `employee_id` 的 MCP/Resource Server；ERP 不使用
服务 Token 加客户端 `employeeId` 代查，也不透传上游 Token。真实联调、密钥
轮换和员工 UAT 仍待外部验收。

2026-07-29 共享旧系统边界已由 REST Guard、本人薪资单和 Treasury 银行账户
在线登记/历史迁移复用。资金账户纵向切片先校验可信身份与 Scope，再在
`PAYROLL_SYSTEM_MODE=external` 时于审批、员工、Mongo、盲索引和加密前失败
关闭；兼容路径绑定专用通过审批的最终决定与 L4 表单、活动事务、历史证据、
连续版本、数据库投影/创建回执和加密信封。74 项专项测试使目标生产文件达到
94.55%/93.56%/100%/96.12%，独立逐文件四维 90% 门禁已接入资金支付总门禁和
`pnpm check`；共享边界服务与 Guard 四维 100%，审批应用服务门禁保持
94.66%/90.67%/97.41%/95.91%。标准 MCP 不新增银行账户登记、查询、解密或
迁移能力。本证据不替代专业算薪、银行、真实历史审批、Replica Set 迁移演练和
财务 UAT。

2026-07-29 共享旧系统边界已扩展到全部 Treasury 应用服务。代发在线提交、迁移
导入、批准、制备及内部物化续跑，回盘在线/迁移导入，失败恢复和 Treasury 四方
对账在线/迁移入口均先校验可信主体及最小 Scope，再在强认证、生产授权、
Payroll 端口、Mongo、加密、WORM、银行网关或 Inbox 前失败关闭。银行账户、
代发、回盘、恢复和对账专项分别为 74、23、38、16、11 项，目标服务覆盖率依次
达到 94.55%/93.56%/100%/96.12%、94.05%/93.04%/96.10%/95.91%、
97.08%/96.27%/100%/97.10%、94.61%/94.59%/96%/97.24% 和
93.75%/94.57%/100%/96.33%，独立逐文件四维 90% 门禁均接入 `pnpm check`。
该仓库证据不替代真实外部联调、迁移演练和财务 UAT。

2026-07-29 全部旧 Payroll 应用服务已复用共享系统模式边界。算薪运行、审批、
主数据、税务、Payroll 对账和影子周期共 31 个公开入口均先完成可信主体、最小
Scope 及必要的主体绑定，再在输入解释、幂等、强认证、Mongo、加密、WORM、
税务网关或跨域读取前失败关闭；REST/MCP 只读、迁移、Worker 间接调用和
Treasury 内部读取不能依赖上层授权绕过。六组专项共 157 项测试通过，目标服务
覆盖率分别为 92.36%/90.20%/96.10%/93.37%、100%/100%/100%/100%、
100%/100%/100%/100%、98.90%/98.58%/100%/100%、
96.58%/96.82%/100%/99% 和 99.03%/97.24%/97.29%/98.88%
（语句/分支/函数/行），独立四维 90% 门禁均通过。该证据只关闭旧 ERP
应用服务旁路，不替代专业算薪资源服务器、真实事件/迁移联调、银行/税务、
影子周期或财务 UAT。

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
招聘渠道拉取、招聘渠道入站处理、招聘渠道职位扇出、招聘渠道阶段扇出、招聘申请、招聘面试、招聘简历、招聘渠道职位投递、招聘渠道阶段回传、招聘管理、招聘面试日历可靠投递、人才全周期应用、人才全周期仓储、招聘 Offer、招聘 Offer REST/DTO/领域入口、Care 仓储、组织仓储、招聘仓储、知识库仓储、营销 CMS、营销入口与幂等核心、营销副作用可靠投递、审批通知可靠投递、审批通知运维边界、组织主数据外部投递可靠性、组织外部身份解析边界、组织平台适配器安全边界、组织首次平台开户、身份令牌与 OAuth 授权事务、身份用户会话与签名键轮换、人员 SSO 信任边界、OAuth Client Credentials 服务身份签发、OAuth 授权控制器、WebAuthn 强认证、入职应用与入口控制器、生产执行授权服务、Phase 5 管理分析、Payroll Tax 双出口和自然人生日证明入口已建立
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
`pnpm quality:payroll-payslip-coverage`、
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
`pnpm quality:recruitment-management-entry-coverage`、
`pnpm quality:recruitment-interview-entry-coverage`、
`pnpm quality:recruitment-onboarding-bridge-coverage`、
`pnpm quality:talent-lifecycle-application-coverage`、
`pnpm quality:talent-lifecycle-entry-coverage`、
`pnpm quality:talent-lifecycle-outbox-boundary-coverage`、
`pnpm quality:talent-lifecycle-sources-coverage`、
`pnpm quality:talent-lifecycle-repository-coverage`、
`pnpm quality:recruitment-offer-coverage`、
`pnpm quality:recruitment-offer-entry-coverage`、
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
`pnpm quality:org-person-birthday-entry-coverage`。上述关键链路当前覆盖率基线集合为
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
99.59%/94.85%/98.21%/99.53%、
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
95.97%/94.05%/100%/96.84%、100%/100%/100%/100%、
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
100%/100%/100%/100%、100%/100%/100%/100%、100%/98.07%/100%/100%、
100%/100%/100%/100%；上述阈值均固定为 90%，
使用相互隔离的报告目录，并已接入 `pnpm check`。这只证明上述关键链路达标，
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

营销官网公开边界另覆盖 30 项 Website 契约、CMS 客户端与缓存失效测试，以及
63 项营销服务和 97 项营销入口测试。公开列表只返回最多 500 项最小摘要，详情
反向绑定路径维度；Website 严格验证成功信封和有界纯 JSON，验证码同时绑定
Origin 与实际 iframe Window，线索结果未知时保留原请求和幂等键。发布事件同时
失效列表与详情标签，畸形失效 Secret 失败关闭；事件正文执行 16 KiB 流式硬
上限、Fatal UTF-8 和精确 Schema。三个 Website 目标文件合计达到
98.68%/97.19%/100%/98.54%（语句/分支/函数/行），营销服务达到
97.38%/93.70%/97.77%/96.99%，营销入口达到
99.76%/97.72%/100%/99.74%，且目标文件逐文件四维均不低于 90%。新门禁
`pnpm quality:website-public-contract-coverage` 已接入 `precheck/check`；
标准 MCP 继续只读并复用营销应用服务。真实 WAF、验证码、正式域名、浏览器故障
注入和营销 UAT 仍待外部验收。

Phase 5 MCP 联调证据已升级为 `gaoq.phase5.integration-mcp.v3`，不再允许只凭
ERP 自身 `catalogHash` 和八类适配器拼出完整 MCP 结论。新门禁同时绑定独立
专业算薪的 HTTPS resource、独立授权服务器、发布镜像、平台契约 `1.0.0`、
七类共享事件契约摘要、完整 MCP 目录摘要、四 Tool/两 Resource Template/两
Prompt、三类标准客户端、跨 resource Token/错误租户拒绝与至少 70 次事件回放；
专业算薪也作为第九类外部沙箱进入零丢失、零重复、零 Token 暴露判定，并进入
`gaoq.phase5.resilience.v4` 的两小时断连、自动追赶和对账门禁；韧性证据另绑定
独立专业算薪 Resource、授权服务器、镜像、目录和事件契约。最终 Go/No-Go
同步验证同一组事实，受保护工作流从 Repository
Variables 精确绑定非敏感预期值。该变更只补齐仓库发布门禁；真实专业算薪
OAuth/MCP、事件回放、断连恢复、密钥轮换、影子周期和员工/财务 UAT 仍待现场执行。

v3 进一步关闭集成、MCP、QA 和安全四方批准只校验角色、证据 ID 和时间，无法
验证职责主体或完整联调结果的可信根缺口。四方分别使用独立 Ed25519 公钥；
keyId 等于 SPKI DER 摘要，完整角色/keyId 集合与受保护工作流的 Repository
Variable 摘要绑定。共同批准 payload 覆盖环境、commit、四类 ERP 镜像、完整
ERP MCP 目录、三类客户端、九类外部沙箱、专业算薪资源/授权服务器/镜像/目录/
事件契约、授权拒绝、安全结论、工件摘要及四方批准元数据；每份签名再绑定共同
摘要、角色、keyId 与签署时间。伪签名、角色换钥、主体/证据/意见/公钥复用、
签后篡改、超时签署和 keyset 漂移均失败关闭。仓库自测只生成临时密钥；真实
人员身份、IAM/KMS/HSM 角色绑定、现场联调、签署和 WORM 原始证据仍待验收。

容灾证据 v4 同时关闭七方演练批准只校验角色、证据 ID、意见摘要和时间、无法
验证签署主体与完整演练结果的可信根缺口。业务连续性、数据、集成、平台、QA、
安全和 SRE 分别使用独立 Ed25519 公钥；keyId 等于 SPKI DER 摘要，完整
角色/keyId 集合还与受保护工作流的 Repository Variable 摘要绑定。共同批准
payload 覆盖环境、commit、五类镜像、专业算薪 Resource/授权服务器/目录/
事件契约、RPO/RTO、恢复/回滚、八域与消息对账、九类外部连接、安全断言、
产物摘要及七方批准元数据；每份签名再绑定共同摘要、
角色、keyId 与签署时间。伪签名、角色换钥、主体或公钥复用、签后篡改、超时
签署和 keyset 漂移均失败关闭。仓库自测只生成临时密钥；真实人员身份、
IAM/KMS 角色绑定、现场签署和 WORM 原始证据仍待外部验收。

2026-07-30 容灾 v4 已补齐确定性契约导出：
`pnpm resilience:print-contract` 固定八个业务域、九类外部连接、七个签署
角色、四项恢复目标、Ed25519 编码和校验器/工作流组合摘要，Phase 5 语义门禁
会实际执行该输出。运行手册同步补入独立专业算薪双向断连、OAuth Resource、
四类只读能力、七类共享事件回放与 ERP 旧工资事实源隔离，避免实现要求九类而
现场清单只列八类。MCP 联调证据对畸形 JSON 现返回稳定失败码。该修复只闭合
仓库契约生产与错误分类，不替代真实恢复环境、专业算薪沙箱、现场签署或 WORM
原始证据。

三次全量迁移演练聚合证据已升级为
`gaoq.phase5.migration-rehearsal.v2`，关闭架构、业务、数据和安全四方签署只
校验角色、证据 ID 与时间、无法验证职责主体及完整三轮结果的缺口。四方分别
使用独立 Ed25519 公钥；keyId 等于 SPKI DER 摘要，完整角色/keyId 集合与
受保护工作流的 Repository Variable 摘要绑定。共同批准 payload 覆盖环境、
commit、四类镜像、部署清单、来源快照和来源包、三轮运行、二十六个 Scope、
三类故障演练、安全结论及四方批准元数据；每份签名再绑定共同摘要、角色、keyId
与签署时间。伪签名、角色换钥、主体或公钥复用、签后篡改、超时签署和 keyset
漂移均失败关闭。仓库自测只生成临时密钥；真实人员身份、IAM/KMS 角色绑定、
三次生产等价演练、现场签署和 WORM 原始证据仍待外部验收。

最终 Go/No-Go 输入证据现为 `gaoq.phase5.go-no-go.v3`，关闭十方批准只
校验角色、证据 ID 和意见摘要格式、却不验证批准角色密钥的缺口。架构、数据、财务、
HR、法务、产品、项目发起人、QA、安全和 SRE 必须各使用不同 Ed25519 公钥；
keyId 精确等于 SPKI DER 摘要，十方角色/keyId 规范集合还须与受保护工作流的
Repository Variable 摘要一致。每份签名绑定最终决策 payload 摘要及自身角色、
决定、证据 ID、意见摘要和签署时间；最终 payload 覆盖发布 commit、镜像、环境、
十二门禁、全部量化验收、十一类外部集成、ERP/专业算薪 MCP、运行保障、决定与
窗口，并强制容灾汇总的专业算薪 Resource、授权服务器、镜像、目录与事件契约
逐字段匹配 MCP 联调结论。合法范围内数值的签后篡改、伪造签名、复用公钥、
角色错配、跨环境替身拼接或 keyset 漂移均由负向自测拒绝；Phase 6 Plan/Apply
重新绑定同一 keyset。仓库没有保存私钥，
真实密钥托管、人员身份与角色密钥绑定、十方签署和 WORM 归档仍属于外部验收。

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

校友授权清理协调与执行服务已覆盖 67 项可信系统任务、事件信封与源状态绑定、
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
失败关闭。控制器覆盖率达到四维 100%，独立四维 90% 门禁已直接接入
`pnpm check`。

Knowledge 应用服务已覆盖 41 项课程创建/发布/下架、任务分配/读取、员工主数据
解析、全文检索授权与索引新鲜度、集成进度幂等、任务完成和入职证明终态测试；
发布校验只在幂等事务的新执行分支内执行；Mongo 自动重试相同课程快照时复用
校验结果，重试读取到不同版本或内容引用时必须重新校验并拒绝旧版本写入。覆盖率
达到 99.59%/94.85%/98.21%/99.53%（语句/分支/函数/行），独立四维 90%
门禁已直接接入 `pnpm check`。

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

标准 MCP 运行时已使用官方 Client 覆盖 25 个 Prompt、50 个 Tool 与 31 个
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

审批 Outbox 运行时边界已覆盖 51 项十七类模板、历史、实例与委托事件、严格外层
信封、逐类型 payload、可信租户、标识、正安全版本、规范 UTC 时间、摘要、迁移
状态/动作数、决策结果/终态/代理关系、转交差异、撤回唯一收件人、三十天委托和
持久化失败测试。payload 先规范复制，再由权威租户、聚合与版本字段覆盖；任何
未知字段、保留字段覆盖、表单正文或状态组合错位均以
`APPROVAL_OUTBOX_EVENT_INVALID` 在写入前失败关闭。目标生产文件覆盖率达到四维
100%，独立逐文件 90% 门禁已接入 `pnpm precheck` 与 `pnpm check`。该边界直接
保护 OP 审批终态 Relay 的输入，未新增或放宽任何 MCP Tool、Resource 或 Prompt。

审批模板与实例草稿修订已补齐应用层、REST 和 PC 模板设计器入口。两个 `PUT`
入口都绑定可信租户与主体、强 `If-Match` 和请求摘要幂等；模板编码/修订、实例
模板快照及所有已发布或已提交事实保持不可变。更新与严格最小披露 Outbox 同事务，
定义和表单正文不进入事件、审计或幂等响应；标准 MCP 不新增草稿写 Tool，
应用、控制器与 Outbox 共 154 项专项测试通过，三个目标生产边界覆盖率分别为
95.19%/91.06%/97.61%/96.18%、100%/100%/100%/100% 和
100%/100%/100%/100%（语句/分支/函数/行）；Web 49 项与 MCP 确定性目录
自检继续通过。真实 Mongo 并发/回滚、PC/H5 响应丢失和代表性流程 UAT 仍待
现场验收。

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

Recruitment Offer REST、DTO 与领域入口已覆盖 165 项严格 ULID、强 ETag、
白名单幂等键、精确/空正文、L4 条款对象、规范毫秒级 UTC、真实日历日期、安全
版本、单调时间和提交后审计隔离测试，Controller、DTO 与领域三个目标生产文件
四维均为 100%。应用服务另有 27 项测试，覆盖率达到
95.97%/94.05%/100%/96.84%（语句/分支/函数/行）。独立逐文件四维 90%
门禁 `pnpm quality:recruitment-offer-entry-coverage` 已接入 `pnpm precheck`、
`pnpm check` 与全局覆盖链。REST、事件和标准 MCP 契约不变，MCP 继续只复用
脱敏应用服务，不开放审批、投递、候选人决定、签署或 L4 条款能力；真实 Approval、
eSign、招聘渠道回放及 HR UAT 仍待现场验收。

HC→审批→职位管理入口已覆盖 97 项严格 ULID、白名单幂等键、不会上溢的强
ETag、精确 DTO/空正文、运行时状态枚举、安全版本、单调时间、迁移快照和审计
终态隔离测试。Controller 与 DTO 合计四维 100%；职位领域为
100%/97.26%/100%/100%，HC 领域为 92.30%/90.16%/100%/95%，共享运行时
校验四维 100%，五个目标文件逐文件四维均不低于 90%。应用服务既有 70 项测试
保持 99.51%/99.45%/100%/100%。独立门禁
`pnpm quality:recruitment-management-entry-coverage` 已接入 `pnpm precheck`、
`pnpm check` 与全局覆盖链。REST、事件和标准 MCP 契约不变；MCP 仅复用应用
服务执行 HC 提交 R2 与职位迁移 R1，不保存 L3 原文、不直连数据库，也不接受
AI 上报审批终态。真实 Approval、组织主数据、招聘渠道回放及 HR UAT 仍待现场
验收。

面试排期、评价、完成与取消入口已覆盖 139 项严格 ULID、白名单幂等键、不会
上溢的强 ETag、精确 DTO/空正文、规范毫秒级 UTC、真实 IANA 时区、运行时状态、
面试官证据、安全版本、单调时间、精确迁移评价对象和提交后审计隔离测试。
Controller 与 DTO 的 73 项测试四维 100%；领域 66 项测试达到
98.74%/98.64%/100%/100%。应用服务既有 19 项测试保持四维 100%，四个目标
生产文件逐文件四维均不低于 90%。独立门禁
`pnpm quality:recruitment-interview-entry-coverage` 已接入 `pnpm precheck`、
`pnpm check` 与全局覆盖链。REST、事件和标准 MCP 契约不变；MCP 仅复用应用
服务返回脱敏面试摘要，不开放排期、评价、完成、取消、日历处置、外部标识或 L3
原文。真实钉钉/飞书沙箱、代表性时区数据、招聘经理流程及 HR UAT 仍待现场验收。

## 6. 架构边界

月中多次变更、跨法域自然日拆分、工资调整收付与税务结算闭环、年度工资代扣/
税表/税局评估核对现均已作为旧 ERP 的迁移与兼容基线交付，并具备独立应用服务、
REST/事件/MCP 边界、追加式迁移和逐文件四维 90% 门禁。官方个人综合所得申报
不属于 ERP 自动执行范围，必须由法定申报主体在外部税务系统办理并回传受控证据。

根据 `docs/phase-0/07-payroll-system-boundary.md`，独立专业算薪系统是工资唯一
生产事实源；ERP 默认以 `PAYROLL_SYSTEM_MODE=external` 在应用服务层关闭旧
Payroll/Treasury 在线、MCP、Worker、迁移和内部调用旁路。因此“代码已交付”
只证明迁移/兼容闭环存在，不表示 ERP 可以恢复生产发薪。若要改变事实源边界，
必须先以新 ADR 替代现有架构决策，并重新执行两个影子周期、银行/税务联调、
回滚演练、财务 UAT 与签署。

## 7. 后续执行顺序

1. 复核专业算薪资源服务器、共享事件、迁移连接器及运维 Worker 的真实部署契约，
   在目标环境取得 OAuth 主体映射、断连恢复、密钥轮换和历史回放原始证据；不得
   用旧 ERP 应用服务的本地失败关闭测试替代外部联调。
2. 在不付费、不使用自建基础设施的前提下等待 GitHub Hosted Actions 免费额度或
   账号限制恢复；新 commit 只触发一次并记录原始结论。
3. 用户批准最小 Project 权限后完成 Issue #41；未批准前继续以 Milestone、标签、
   Issue 和 Draft PR 管理，不把看板缺失描述为完成。
4. 取得真实目标环境后按 Phase 1 → 5 → 6 顺序执行外部联调、迁移/性能/安全/容灾
   演练、UAT、Go/No-Go、切换与 Hypercare。
5. 每项外部证据必须绑定 commit、镜像摘要、环境、原始记录和签署；通过后再勾选
   Issue 验收项、关闭子项并按 DoD 推进 Epic。
