# 项目工程规范

## 系统现状与目标技术栈

- Phase 0–6 的规范、NestJS 模块化单体、Next.js App Router、MongoDB
  Replica Set 契约、Redis/BullMQ Worker、迁移控制面、Helm/Kubernetes
  编排和标准 MCP 服务代码已经交付。
- 代码交付不等于生产完成。真实外部系统联调、三次全量迁移、性能、安全、
  容灾、业务 UAT、Go/No-Go、统一切换和四周 Hypercare 仍以现场证据为准。
- ERP 是组织与员工唯一主数据源；多租户从可信身份上下文强制；REST、事件、
  MCP 和 Worker 必须复用应用服务。
- 强制规范入口为 `docs/phase-0/README.md`；阶段交付与未验收边界分别见
  `docs/phase-1/README.md` 至 `docs/phase-6/README.md`。
- 2026-07-27 已在本机专用 MongoDB Replica Set 与 Redis 上完成 API、Worker、
  Web、OAuth Client Credentials、官方 MCP SDK、CORS、队列和指标端点联调；
  该结果属于本地运行验证，不替代现场验收。
- 2026-07-27 已补齐 Phase 4 Attendance 的 Employment 有效期、版本化日班次、
  跨日归属、Provider 提交水位/Inbox 对账与月结摘要哈希；真实 Provider 沙箱
  和生产 Replica Set 上的 v2 索引 apply 仍待现场证据。
- 2026-07-27 已补齐 Phase 4 Payroll 月中薪酬与跨法域自然日 HALF_UP 分摊：
  工资运行只接收精确档案引用，校验整月无缺口/无重叠，把档案版本、法域和分摊
  边界冻结进 L4 输入快照；不同考勤费率缺少逐日归属时失败关闭。
- 2026-07-27 已交付锁定工资补发/冲销的确定性差额准备、专用 Approval 审批和
  独立 WebAuthn UV 锁定：客户端不提交金额，重算、送审、审批与锁定职责分离，
  事件不含人员或金额。正向调整现可从原代发批次创建唯一单行 Treasury 补发子批次，
  并在直接或恢复全额成功回盘时事务性回写现金结算；负向调整建立唯一员工应收，
  支持追加式银行回款或带法定授权证据的工资抵扣；税务更正采用独立密文、WORM、
  WebAuthn 审批和税局提交，现金与税务均终结后才进入 settled。
- 2026-07-27 已交付员工年度工资代扣、已提交税表与带证据税局评估核对；仅给出
  应补/应退提示，不代替官方个人综合所得申报或自动收付。真实税局评估适配器、
  官方个人综合所得办理与现场金样例仍未完成。
- GitHub PR #103、#109、#111 与 #113 的 Hosted Actions 当前在任何步骤执行前被账户
  付款或 Spending limit 拦截；代表 Job 的 Runner 与 Steps 均为空。这是外部门禁
  未执行，不得记为代码测试失败或门禁通过；按零付费约束不使用 NAS、自建 Runner
  或虚拟机绕过。

## 目录约定

- `apps/erp-api/`：NestJS API、领域模块、集成适配器、Worker 与迁移代码。
- `apps/erp-web/`：Next.js 管理工作台、移动工作台、OAuth 与 MCP 确认页面。
- `packages/`：共享类型与安全工具。
- `deploy/`：生产 Helm Chart、Kubernetes 平台护栏与可观测性基线。
- `scripts/`：安全、迁移、MCP、容量、韧性、发布和现场证据验证器。
- `docs/phase-0/`：企业架构、领域数据、集成、MCP、安全质量与 GitHub 治理规范。
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
NEXT_PUBLIC_ERP_API_ORIGIN=https://erp.example.invalid pnpm build
```

`pnpm check` 覆盖 Lint、TypeCheck、单元/集成/协议测试、文档、安全、镜像、
Kubernetes、MCP、迁移、容量、韧性、发布和 Phase 6 证据门禁自测。本地自测
不能替代目标环境中的真实联调、生产等价演练或人工签署。Web 生产构建必须显式
提供公开 HTTPS API 根 Origin；`.invalid` 仅用于不发布产物的工程构建门禁。

需要本地基础设施的真实 MCP 握手使用：

```bash
pnpm --filter @gaoq/erp-api smoke:mcp:live
pnpm --filter @gaoq/erp-api smoke:worker:live
```

脚本仅在内存生成临时密钥，使用独立测试数据库与 Redis DB，结束时关闭其创建的
API 或 Worker 子进程。

## Codex / Kimi 协作

- Codex 执行入口为 `.codex/AGENTS.md`，完整项目规范以 `AGENTS.md` 为准。
- Kimi 派活必须说明只读或允许修改的边界；只读任务禁止写计划文件。
- 大型盘点必须拆成小范围任务，并要求输出文件路径、调用方向和实现建议。
- Kimi 返回后必须先做 `[OK]` / `[CR]` 复核，未经 CR 不得合并。
