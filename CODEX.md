# 项目工程规范

## 系统现状与目标技术栈

- Phase 0–6 的规范、NestJS 模块化单体、Next.js App Router、MongoDB
  Replica Set 契约、Redis/BullMQ Worker、迁移控制面、Helm/Kubernetes
  编排和标准 MCP 服务代码已经交付。
- 代码交付不等于生产完成。真实外部系统联调、三次全量迁移、性能、安全、
  容灾、业务 UAT、Go/No-Go、统一切换和四周 Hypercare 仍以现场证据为准。
- ERP 是组织与员工唯一主数据源；多租户从可信身份上下文强制；REST、事件、
  MCP 和 Worker 必须复用应用服务。
- 2026-07-27 已冻结独立专业算薪边界：ERP 负责统一身份与组织主数据，专业算薪
  负责工资唯一事实源；`PAYROLL_SYSTEM_MODE=external` 关闭 ERP 旧工资/资金 REST。
- 2026-07-27 已将 ERP 与专业算薪共享契约提升至
  `@gaoq/platform-contracts@1.0.0`：七类事件统一为
  `cn.gaoq.<域>.<实体>.<动作>.v1`，完整信封和逐类型负载严格校验，并同步导出
  JSON Schema；旧 `com.gaoq.*` 名称只保留一个迭代的显式严格迁移入口。
- 强制规范入口为 `docs/phase-0/README.md`；阶段交付与未验收边界分别见
  `docs/phase-1/README.md` 至 `docs/phase-6/README.md`。
- 2026-07-27 已在本机专用 MongoDB Replica Set 与 Redis 上完成 API、Worker、
  Web、OAuth Client Credentials、官方 MCP SDK、CORS、队列和指标端点联调；
  该结果属于本地运行验证，不替代现场验收。
- 2026-07-27 已交付 `/careers` 招聘门户、ERP 开放职位最小投影、候选人联系人
  投递 BFF、可信入口验证、精确 Origin 和共享 Redis 失败关闭限流；生产服务身份、
  边缘代理注入、简历原件扫描/对象存储仍待现场配置与验收。
- 2026-07-27 已交付智能简历库：隔离网关脱敏读取契约、OpenAI 严格结构化输出、
  受控分类标签、BullMQ Worker、人工确认与标签检索、ERP 管理页面及独立索引迁移；
  真实附件网关、OpenAI Secret/数据保留控制、代表性简历评测与招聘 UAT 待现场验收。
- 2026-07-27 已交付 Talent Lifecycle 360：以候选人身份为主线实时组装招聘、入职、
  任职、离职与校友状态，提供加密服务触点、授权门禁、Outbox、只读 MCP 和管理页面；
  生产索引、角色映射、历史数据回放及 HR/员工关怀/校友 UAT 待现场执行。
- 2026-07-27 已交付 Knowledge 可靠考试编排：版本化题型/时限/次数/评分与通过
  策略，独立签名评分网关，超时自动提交、人工复核、Mongo 权威状态机、Worker
  退避/死信/熔断、事务 Outbox、SLA 指标、追加索引、只读对账、显式重放及本人
  只读 MCP；ERP 与 MCP 均不接收题目、答案或标准答案。真实评分沙箱、代表题集、
  性能、安全及培训 UAT 仍待外部验收。
- 2026-07-27 已交付本人授权知识全文检索：可信任职及部门/岗位裁剪、应用服务二次
  授权、独立签名搜索网关、事务索引任务、重试/死信、新鲜度指标、追加迁移、只读
  对账、全量重建及标准 MCP；真实搜索集群性能、安全、撤权收敛与业务 UAT 待现场验收。
- 2026-07-27 已补齐校友授权自动到期：创建时使用可信租户与授权标识生成稳定
  BullMQ 延迟任务，到期 Worker 仅持有内部 expire Scope，发布脱敏事件并写审计；
  存量活动授权提供默认 dry-run、显式 apply 的稳定 JobId 批量重建工具，且不向
  REST 或 MCP 暴露执行能力。
- 2026-07-27 已交付生日与入职周年关怀编排：Person 生日月日只形成独立密钥域
  HMAC 盲索引，Care 通过窄应用服务读取在职事实；本人偏好/全局退订、租户时区、
  闰日与复聘策略、静默时段、受控模板、事务 Outbox、稳定 BullMQ 任务、签名通知
  回执、锁恢复/退避/死信/显式重放、追加迁移、低基数指标及标准只读 MCP 已落地。
  真实通知沙箱、渠道授权映射、代表性时区数据与员工 UAT 仍待现场验收。
- 2026-07-27 已交付校友授权终止后的下游清理证明闭环：撤回与到期共用可靠
  状态机，按独立目标/凭据/Ed25519 信任根验证不可变证明，具备策略版本幂等、
  Worker 锁恢复/退避/死信、只读对账、审批重放、缺失任务重建、追加索引、
  低基数指标、REST 与标准只读 MCP。真实 CRM、通知、校友平台删除和未来处理
  阻断、WORM 保留、故障演练及业务 UAT 仍待现场验收。
- 2026-07-27 已交付双语营销官网、ERP 工作台 CMS、事务 Outbox、通知幂等、
  严格生产 HTTPS/CSP、安全头、独立镜像与加密预约线索入口；对象存储、真实通知、
  验证码、AI 网关和正式域名仍待现场配置与验收。
- 2026-07-27 已补齐 Website 生产失败关闭构建、安全响应头、精确 CORS/验证码
  协议、独立非 root 镜像与供应链扫描，以及 Deployment、Service、Ingress、
  NetworkPolicy、HPA、PDB、探针和构建/运行配置边界静态门禁；真实域名、证书、
  WAF、验证码和对象存储仍需目标环境证据。
- 2026-07-27 已补齐营销副作用 `dispatched → delivered|dead|cancelled` 终态、
  送达尝试计数、最终失败告警、撤销排期事务取消、跨租户队列路由拒绝及从数据库
  Outbox 重建丢失延迟任务；真实邮件/飞书幂等与故障恢复仍待目标环境演练。
- 用户已明确不使用 NAS、自建 Runner 或虚拟机，后续 CI/CD 只采用 GitHub 官方
  托管 Runner。现有 Phase 5/6 self-hosted 手工验收定义在迁移完成前视为停用，
  不得接入 NAS；仓库当前为 Private，Hosted Actions 在任何步骤执行前被账户付款
  或 Spending limit 拦截。在免费额度恢复或用户明确批准公开仓库前，外部门禁
  保持未执行，不得记为代码测试失败或门禁通过。
- 2026-07-27 已完成开放 Issue 与 Phase 0–6 仓库实施证据审计，并正式定义
  `status:implementation-delivered` 与 `status:external-acceptance` 的并存规则；
  新增 Phase 3 Issue 已归入唯一 Milestone。GitHub Project 仍由 Issue #41 跟踪，
  因当前令牌缺少最小 `project` 权限而保持阻塞；详见
  `docs/implementation-completion-audit.md`。
- 2026-07-27 ERP API 全量覆盖率基线为语句 78.29%、分支 70.32%、函数
  80.63%、行 80.96%，语句与分支尚未达到全仓四维 80% 强制门槛。租户上下文、身份授权、
  审批数据加密、审批仓储、审批应用状态机、MCP 确认、薪酬影子周期、薪酬运行、
  薪酬审批、考勤应用、招聘 Offer、Care 仓储、组织仓储、招聘仓储、知识库仓储和营销
  CMS 服务已建立十六项 90% 门禁，当前分别为
  100%/100%/100%/100%、100%/95.83%/100%/100%、
  98.75%/96.96%/100%/100%、
  98.06%/94.04%/98.64%/99.02%、
  94.62%/90.76%/98.19%/95.96%、100%/97.74%/100%/100%、
  99.00%/97.24%/97.29%/98.84%、92.18%/90.20%/96.10%/93.18%、
  100%/100%/100%/100%、
  99.20%/99.17%/100%/99.11%、
  95.97%/94.01%/100%/96.83%、
  100%/91.66%/100%/100%、100%/100%/100%/100%、
  97.44%/91.32%/100%/99.53%、100%/99.43%/100%/100% 和
  100%/97.27%/100%/100%
  （语句/分支/函数/行），并接入 `pnpm check`。后续轮次必须继续补齐全仓及
  其余关键链路，禁止以排除生产文件或降低阈值宣称完成。
- 数据迁移控制面新增 53 项幂等、证据分页、检查点竞争、关联、附件与负载验证测试，
  服务覆盖率提升至 88.23%/84.58%/97.97%/91.11%（语句/分支/函数/行）；
  因语句与分支尚未达到 90%，当前仅作为覆盖率增量，不建立或宣称关键链路门禁。

## 目录约定

- `apps/erp-api/`：NestJS API、领域模块、集成适配器、Worker 与迁移代码。
- `apps/erp-web/`：Next.js 管理工作台、移动工作台、OAuth 与 MCP 确认页面。
- `apps/website/`：Next.js 中英文官网、SEO、CMS 已发布内容读取与预约转化页面。
- `packages/`：共享类型与安全工具。
- `deploy/`：生产 Helm Chart、Kubernetes 平台护栏与可观测性基线。
- `scripts/`：安全、迁移、MCP、容量、韧性、发布和现场证据验证器。
- `docs/phase-0/`：企业架构、领域数据、集成、MCP、安全质量与 GitHub 治理规范。
- `docs/marketing-cms.md`：双语官网、CMS、媒体、AI、线索与现场配置交付边界。
- `wordpress backup/`：历史备份，明确排除，不得纳入 Git、扫描或应用构建。

## 代码与安全规范

- 回复、代码注释、文档注释、迁移说明和 Git commit message 必须使用中文。
- TypeScript 使用 ESM 与 async/await，禁止 `var`。
- 禁止硬编码密码、密钥、Token、银行账号、电子签密钥和生产环境标识。
- 禁止信任客户端租户标识；动态字段、排序和查询必须经过白名单映射。
- MCP 禁止直接访问数据库、透传上游 Token 或注册 R3 操作。

## 验证命令

```bash
pnpm install --frozen-lockfile
pnpm audit
pnpm check
NEXT_PUBLIC_WEBSITE_ORIGIN=https://www.example.invalid \
NEXT_PUBLIC_ERP_API_ORIGIN=https://erp.example.invalid \
NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_ORIGIN=https://captcha.example.invalid \
NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_URL=https://captcha.example.invalid/widget \
pnpm build
```

`pnpm check` 覆盖 Lint、TypeCheck、单元/集成/协议测试、文档、安全、镜像、
Kubernetes、MCP、迁移、容量、韧性、发布和 Phase 6 证据门禁自测。本地自测
不能替代目标环境中的真实联调、生产等价演练或人工签署。两个 Web 应用的生产
构建必须显式提供公开 HTTPS Origin；`.invalid` 仅用于不发布产物的工程构建门禁。

需要本地基础设施的真实 MCP 握手使用：

```bash
pnpm --filter @gaoq/erp-api smoke:mcp:live
pnpm --filter @gaoq/erp-api smoke:worker:live
```

脚本仅在内存生成临时密钥，使用独立测试数据库与 Redis DB，结束时关闭其创建的
API 或 Worker 子进程。

## Codex 执行规范

- Codex 执行入口为 `.codex/AGENTS.md`，完整项目规范以 `AGENTS.md` 为准。
- Codex 默认直接执行，不要求调用指定外部代理；只读任务禁止写计划文件。
- 大型盘点必须拆成小范围任务，并输出文件路径、调用方向和实现建议。
- 所有实现结果必须经过复核和验证，未经检查不得合并。
