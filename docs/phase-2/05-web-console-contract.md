# Phase 2 PC 工作台契约

## 交付范围

本工作台提供企业 SSO 入口、审批发起、待办、详情与追加式动作时间线、R1 审批决策、版本化表单设计、独立发布复核、组织主数据浏览与创建、身份授权快照、Passkey 入口和当前会话吊销。PC 与 H5 均从待办卡片进入详情并在第三步前完成 R1 决策。

移动审批发起、转交、加签、委托与真实设备无障碍 UAT 仍属于后续验收范围，不因 PC 发起页面交付而视为完成。

## 浏览器会话

- SSO 的 `state`、PKCE、租户绑定和回调校验由 API 生成，前端只提交租户公开标识和受限返回路径。
- 刷新令牌仅存于 `HttpOnly` Cookie；短期访问令牌仅存于页面内存，不写入 LocalStorage、SessionStorage、URL、日志或服务端渲染输出。
- 受保护请求通过统一客户端附加 Bearer 令牌；首次 `401` 清空内存并刷新一次，第二次失败直接返回，不形成无限重试。
- 页面不得接收、缓存、展示或推导 `tenantId`。角色、Scope 和部门数据范围只使用服务端已验签结果。
- API 响应必须符合统一 `code/message/data/traceId/timestamp` 信封；错误界面只展示安全消息和 `traceId`。

## 写操作与风险控制

- 所有组织、审批和模板写请求必须带一次性 `Idempotency-Key`。
- PC 发起先创建草稿、再以草稿强版本和独立幂等键提交。创建成功但提交失败时必须保留草稿标识和原提交幂等键，只允许重试提交，禁止静默重复创建实例。
- 审批决策和模板发布必须带强 `If-Match`，并发版本冲突不得自动覆盖。
- R1 待办允许在 PC 工作台确认后提交；R2 待办在普通工作台中只读，必须转入绑定操作摘要、主体、租户和浏览器会话的 WebAuthn 受控确认流程。
- 模板创建与发布分成独立面板；服务端继续强制创建人不能发布自己的草稿。
- ERP 是组织与员工唯一主数据源。工作台不直接调用钉钉、飞书或 OP；下游分发由事务 Outbox、队列和平台适配器执行。

## REST、事件、MCP 与审计一致性

| 页面能力 | REST 应用服务 | 事件/集成 | MCP | 审计 |
| --- | --- | --- | --- | --- |
| 已发布模板目录与审批发起 | `GET /api/approvals/templates/published`、实例创建/提交均复用 `ApprovalApplicationService` | 创建与提交分别通过事务 Outbox；外部平台只消费事件 | `erp://approval/templates/published` Resource 读取相同最小投影；既有 R1 Tool 仅提交已存在草稿 | `approval.template.catalog.read`、`approval.instance.create/submit` |
| 审批待办、详情与时间线 | `ApprovalApplicationService` | 无副作用；时间线读取追加日志投影 | `approval_get_inbox`、`approval_get`、`approval_timeline_get` | REST 时间线和 MCP Tool 分别记录 R0 读取审计 |
| R1 审批决策 | `ApprovalApplicationService` | 动作、Outbox、通知意图同事务 | 复用审批 R1 prepare/execute | `approval.instance.decide` |
| 模板草稿与发布 | `ApprovalApplicationService` | 发布事件进入 Outbox | 业务能力不由前端旁路 | `approval.template.create/publish` |
| 组织浏览与创建 | `OrgApplicationService` | 组织版本事件进入 Outbox，下发钉钉/飞书/OP | 复用组织 R0/R1 工具 | `org.department.create`、`org.employee.create` |
| 身份摘要与会话吊销 | 可信身份上下文与 `TokenGrantService` | 吊销不依赖外部平台成功 | OAuth/MCP 继续使用同一 Scope 模型 | `identity.profile.read`、`identity.session.revoke` |

MCP 不得调用页面、读取浏览器令牌或直接访问数据库。页面新增呈现能力不得改变 MCP 风险分级，R3 始终不注册工具。

已发布模板目录最多返回 200 个模板、每个模板最多 100 个字段，只包含模板标识、编码、名称、修订、风险级别、定义摘要、字段白名单和版本；不得返回 `tenantId`、流程节点、审批人解析器或发布审批人。MCP Resource 与 REST 使用同一应用服务投影。当前 MCP 确认记录不承载审批表单正文，避免 L3/L4 表单值进入明文命令；AI 可读取结构并辅助用户填写，但实例草稿必须由 ERP UI 创建，之后才可用既有 prepare/execute 提交。

审批时间线以 `aggregateVersion` 升序读取，最多返回 500 条动作。仓储查询强制可信租户和实例标识；应用服务先执行与详情相同的实例读取授权。REST 与 MCP 仅返回动作标识、版本、类型、参与主体标识、结果和时间，不返回 `tenantId`、表单正文、Mongo 内部标识或平台凭据。

## 验证与生产门禁

仓库门禁包括 ESLint、TypeScript、Vitest、Next.js 生产构建、API 全量测试及既有安全/MCP/发布自测。这些结果只证明代码与门禁一致，不替代以下生产证据：

- 目标域名、浏览器和实体认证器的 WebAuthn UAT；
- 钉钉、飞书真实沙箱 SSO、消息、限流和令牌轮换联调；
- PC/H5 无障碍、真实用户三步操作和关键分辨率验收；
- 生产 Replica Set、Redis/BullMQ、WORM 审计、可观测性和回滚演练。
