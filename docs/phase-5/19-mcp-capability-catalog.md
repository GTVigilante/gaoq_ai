# Phase 5 MCP 完整能力目录与联调门禁

- 文档编号：phase-5/19
- 状态：远程 Streamable HTTP 与本地 stdio 运行入口、能力目录门禁已交付；
  三类客户端与外部沙箱真实联调待执行

## 运行基线

生产远程 MCP Server 已实现 `2025-11-25`、Streamable HTTP、OAuth 2.1 Resource
Server、结构化输出、Resources、Resource Templates、Prompts 和 Tools。同一
`McpRuntimeService` 还提供本地 stdio 入口，供同机 AI 客户端、开发和 Inspector
使用；两个 transport 共用相同能力注册、应用服务与可信身份转换，不维护私有
Tool 分支。业务 Tool 只依赖应用服务；禁止访问 Model、Repository、MongoDB、
供应商 SDK 或透传上游 Token。租户只能由验证后的 OAuth 身份解析，任何 Tool
参数或 stdio 消息中的租户标识都不可信。

四个静态 Resource 分别提供服务说明、审批待办、已发布审批模板目录和本人委托目录。`erp://approval/templates/published` 只返回表单字段白名单；`erp://approval/delegations/mine` 只返回限期授权最小投影。两者均复用审批应用服务，不返回租户、权限快照、流程节点、审批人解析器、发布审批人或任何表单值；敏感审批正文不得进入 MCP 明文确认命令，持续授权关系不得注册 AI 写 Tool。

确定性目录直接从 `McpRuntimeService` 的 47 个真实 `registerTool` 注册点解析，不维护第二份容易漂移的手工清单：R0 23 个、R1 16 个、R2 8 个、R3 0 个。门禁验证中文标题/说明、输入与输出 Schema、幂等与副作用注解、R1/R2 封闭世界、prepare 不产生破坏性效果，以及应用服务边界。

```bash
pnpm --silent mcp:catalog:print > /secure/mcp/gaoq-mcp-catalog.json
```

输出按源码注册顺序规范化并生成 `catalogHash`。任何 Tool 增删、标题/Schema/注解或风险分级变化都会改变目录摘要并要求重新完成安全评审和客户端联调。

## 能力分层

- R0：身份权限、组织、审批只读、招聘/入职/知识/Care 摘要、本人授权知识检索、本人考勤、工资周期、OP 经营与审批桥。
- R1：本人薪资及工资/税务/对账/影子控制摘要、管理/迁移摘要、营销副作用可靠性状态、普通审批提交撤回、本人考勤修订、职位状态变更；写入必须 prepare/execute 与显式确认。
- R2：审批决策、受控分析导出、HC 提交、Offer 发送意图；必须强认证、独立审批约束或职责分离。
- R3：发薪、税务提交、故障注入、恢复、Go/No-Go、权限提升、审计删除均不注册 Tool。

## 三类标准客户端

上线前使用交互式用户 Agent、机器服务 Agent、只读审计 Agent 分别验证初始化协商、OAuth 发现、PKCE 或 Client Credentials、资源指示、Scope、分页、结构化内容、Tool Error、超时、取消、幂等重放、确认过期和审计。每类客户端必须读取同一 `catalogHash`；不按厂商名称做私有兼容分支，任何符合协议与授权标准的 AI 均可接入。

本地 stdio 启动入口为 `apps/erp-api/dist/mcp-stdio-main.js`，要求秘密管理器注入
短时 JWT 形态的 `MCP_STDIO_ACCESS_TOKEN`。启动预检和每条消息均复用
`AccessTokenVerifier`，要求 `erp:mcp:server:connect`，即时撤销或过期即关闭
连接。stdout 只传输 JSON-RPC，错误只向 stderr 输出稳定码。官方 TypeScript
Client 已经通过真实 stdio 字节流完成初始化，并发现同一套 47 Tool、Resource
与 22 Prompt；通用配置、构建和 Inspector 命令见
[stdio 客户端接入手册](./20-mcp-stdio-client-onboarding.md)。该自动化证据不把
任何厂商客户端标记为已验收。

仓库门禁 `pnpm quality:mcp-http-entry-coverage` 覆盖 `/mcp` 与 `/mcp/` 的认证前
Origin 拒绝、控制器二次 Origin 校验、连接 Scope、浏览器确认 Cookie 会话、
R1/R2 状态、WebAuthn 仪式与显式可信用户审计。公共确认端点不得依赖 Bearer 请求
租户上下文；业务拒绝或确认状态推进后的审计异常均不得改变原始决定。三个入口
目标文件语句、分支、函数和行均不得低于 90%，当前 26 项测试达到四维 100%。

仓库门禁 `pnpm quality:mcp-stdio-coverage` 覆盖环境变量白名单、连接 Scope、
启动预检、逐消息重新验签、消息顺序、撤销/过期失败关闭、稳定错误、重复关闭以及
官方 Client 的真实字节流协商与能力发现。进程运行器另覆盖应用动态加载前预检、
输入结束、信号竞态、迟到资源、stderr 故障与按对象身份幂等清理。认证
transport、启动边界和进程运行器三个关键生产文件逐文件四维均不得低于 90%。

## 跨系统联调

OP、钉钉、飞书、e签宝、银行、税务、附件和 WORM 只通过应用服务与 Adapter 被 MCP 间接读取或发起受控意图。真实沙箱联调必须证明外部超时/重复/乱序不会绕过确认、租户、幂等、Outbox/Inbox、对账与审计；MCP 服务自身不得持有或返回供应商 Token。银行、税务、真实签署和资金动作只验证沙箱/受控替身，禁止生产副作用。

专业算薪主数据快照保持
`GET /integrations/payroll/v1/master-data/snapshots` 专用服务身份边界。MCP 不注册
批量部门、员工或劳动关系快照 Resource/Tool；AI 只能使用目录中已有的脱敏控制
摘要能力，不能把 MCP 变成跨系统主数据导出通道。

业务附件迁移固定为 L4，不注册正文、对象定位符、checksum 的迁移 Tool 或 Resource。AI 只能读取聚合迁移报告；未来若增加领域附件状态能力，也必须复用应用服务并返回无正文、无对象地址、无上传人员标识的最小安全投影。

工具自测和本目录不等于联调完成。最终 `integration-mcp` verdict 必须绑定 commit、API/Worker/ERP Web/Website 四类镜像、`catalogHash`、三类客户端原始协议记录、八类外部沙箱证据、跨租户拒绝、审计和安全签署，随后才能进入[跨职能 Go/No-Go 门禁](./18-go-no-go-evidence-gate.md)。

`.github/workflows/phase-5-mcp-integration.yml` 只允许 `main` 手工启动，绑定 Required Reviewers 保护的 `phase-5-mcp-integration` Environment 和同名隔离单次 Runner 标签。Environment 配置固定环境名及 API/Worker/ERP Web/Website 镜像 SHA-256；现场摘要文件固定为 `/var/lib/gaoq/mcp/phase-5-mcp-integration.json`。工作流把证据与当前 commit、镜像和实时解析的 `catalogHash` 精确绑定，只上传脱敏 verdict，不上传 OAuth Token、协议正文、业务数据或供应商凭据。

证据必须覆盖三类客户端各至少 10 次 Tool 调用、全部 47 个 Tool 的一致目录、至少 4 个 Resource、24 个 Resource Template、22 个 Prompt；OP、钉钉、飞书、e签宝、银行、税务、附件、WORM 各至少 10 次沙箱请求。跨租户和无效 Scope 各至少 30 次并全部拒绝，过期确认至少 10 次并全部拒绝；丢失、重复业务效果、未对账、租户错配、Token 暴露、生产副作用和 R3 Tool 均为零。MCP、集成、安全和 QA 四方在联调结束后独立签署。

```bash
pnpm mcp:integration:validate-evidence -- /secure/mcp/phase-5-mcp-integration.json
```
