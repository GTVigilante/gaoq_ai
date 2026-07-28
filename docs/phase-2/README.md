# Phase 2：审批引擎与 AI 受控操作

## 交付状态

Phase 2 当前已交付审批模板、受限条件 DSL、模板快照、实例状态机、会签/或签、委托、转交、加签、撤回、归档、乐观锁、加密持久化、REST 工作台、可靠事件、双平台通知、MCP R0/R1 能力，以及基于 WebAuthn 用户验证的 R2 确认链。

尚未满足生产验收的项目：

1. WebAuthn 代码、浏览器登记/断言页面和 R2 证据绑定已经交付，但尚未使用目标域名、目标浏览器和实体认证器完成兼容与恢复演练。
2. 钉钉、飞书真实租户沙箱的消息发送、权限范围、限流、令牌轮换和回执格式尚未完成联调。
3. 生产 MongoDB Replica Set、Redis/BullMQ、WORM 审计和告警规则尚未在目标环境执行演练。

因此本阶段代码可进入集成环境，不得标记为生产完成。

## 架构边界

- ERP 组织与员工是审批人解析的唯一主数据源；平台身份只用于 SSO 和消息投递。
- REST、MCP 和 Worker 复用 `ApprovalApplicationService`；MCP 与通知适配器不得直接读写审批聚合。
- 租户只能来自验签令牌或 HttpOnly ERP 会话；任何业务参数中的租户标识均无效。
- 表单使用 AES-256-GCM 和租户/实例/定义摘要 AAD；通知、Outbox、MCP 确认和幂等快照不得包含表单正文。
- 审批写入、动作日志、Outbox 和通知意图位于同一 Mongo 事务；平台发送在独立 Worker 中执行。
- 审批 Outbox 不是类型断言边界：十五类模板、历史、实例与委托事件必须逐类型
  执行严格运行时白名单，绑定可信租户、聚合、版本和规范时间，拒绝未知字段、
  payload 保留字段覆盖、表单正文及状态组合错位。规范事件是 OP 审批终态 Relay
  的唯一输入；49 项专项测试与逐文件四维 90% 门禁已接入 `pnpm precheck` 和
  `pnpm check`。
- 通知 Worker 对数据库事实执行运行时白名单校验，认领与释放绑定通知、Worker 和
  原尝试次数。飞书以通知 ULID 作为平台去重键，可安全重领过期租约；钉钉直连
  发送没有已验收的请求幂等保证，过期执行租约或不可判定响应必须进入
  `APPROVAL_NOTIFICATION_DELIVERY_INDETERMINATE` 死信，禁止自动重发。
- 平台已经返回成功后，本地 `sent` 终态写入失败只记录
  `state_unavailable` 并保持原执行租约，禁止通用失败处理把成功发送改写为重试或
  死信。结果不确定的钉钉通知只有在平台对账后，才可用 R2
  `approved_exception` 原因执行幂等人工恢复。
- R1 使用 `prepare → ERP 页面确认 → execute`；R2 使用与操作、租户、主体、浏览器会话绑定的一次性 WebAuthn challenge，要求认证器 UV 成功和独立审批人；R3 不注册工具。
- Passkey 登记、清单和撤销要求 `erp:identity:passkey:manage`，生产 `WEB_ORIGIN` 必须为 HTTPS；服务端仅保存公钥、计数器、传输方式和备份状态。

## 上线门禁

按顺序执行：

1. 阅读并执行 [索引迁移手册](./01-index-migration-runbook.md)。
2. 完成 [UAT 与安全验收](./02-uat-security-acceptance.md)，保留证据链接。
3. 部署并验证 [SLO 与告警](./03-observability-slo-runbook.md)。
4. 完成 [平台与 MCP 兼容矩阵](./04-platform-mcp-compatibility.md)。
5. 按 [PC 工作台契约](./05-web-console-contract.md) 验证浏览器会话、版本控制、风险边界与四类契约一致性。
6. 按 [审批主体解析与组织主数据完整性运行手册](./06-approval-actor-resolution-runbook.md)
   验证发起员工在职状态、授权映射、部门字段类型、单节点人数上限，以及
   REST、OP、MCP 对同一应用服务的复用。
7. R2 实体认证器兼容、真实平台沙箱和 Sev1/Sev2 演练全部通过后，方可提交生产变更审批。
