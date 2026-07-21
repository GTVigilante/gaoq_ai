# Phase 5 OP 审批桥契约

## 1. 范围与权威边界

本切片实现 `OP 来源单据 → ERP CanonicalApproval → 审批终态回推 OP`。ERP 是审批模板、审批路径、组织人员、权限与审计的唯一权威；OP 只能提交来源单据和表单值，不得指定模板、审批人、租户、结果或流程版本。审批创建与提交必须复用 `ApprovalApplicationService`，MCP 和集成 Worker 均不得直接写审批集合。

## 2. 入站契约

端点：`POST /webhooks/op/approvals`，成功统一返回 `202 Accepted`。请求不得携带 query；正文上限 1 MiB，Content-Type 为 JSON。认证头沿用 OP 入站 HMAC v1：

- `x-gaoq-op-client-id`、13 位毫秒时间戳、随机 nonce、外部 eventId、`hmac-sha256` 与十六进制签名；
- 签名原文为 `timestamp + "\n" + nonce + "\n" + eventId + "\n" + rawBody`；
- 时间戳窗口 ±5 分钟，nonce 在 Redis 保留 24 小时；Redis 不可用时失败关闭；
- 租户只能由验签后的 `clientId → tenantId` 绑定解析，禁止信任 URL、query、header 或 body 中的租户值；
- 相同 eventId 与相同载荷按幂等重试接受，不同载荷返回冲突；所有结果写 R2 审计。

固定事件为 `approval.requested` / `schemaVersion=1.0`，只允许：

```json
{
  "schemaVersion": "1.0",
  "type": "approval.requested",
  "occurredAt": "2026-07-22T08:00:00.000+08:00",
  "data": {
    "sourceDocumentType": "purchase_order",
    "sourceDocumentId": "po-001",
    "initiatorEmployeeId": "employee-001",
    "title": "采购申请",
    "formData": { "amount": 12345 }
  }
}
```

表单最多 100 个字段；字段名固定格式，值仅允许安全有限数值、布尔、null、限长文本及最多 200 个标量的数组，禁止嵌套对象和 Mongo 操作符。`sourceDocumentType` 通过 `op_approval_routes` 选择已发布 ERP 模板和独立回推身份。原始正文使用 `OP_APPROVAL_WEBHOOK_ENCRYPTION_KEYS` 独立密钥域的 AES-256-GCM 加密写入 90 天 TTL Inbox，不得复用经营摘要密钥；长期桥表只保存来源标识、审批实例、状态、版本和载荷摘要。

## 3. ERP 审批与结果事件

Worker 使用 `system_job` 身份及唯一 Scope `erp:approval:op:ingest`：先以 Inbox ULID 预占来源单据唯一桥接，再按 ERP 员工主数据解析发起主体，最后以同一确定性 ULID 原子创建并提交审批，同时写审批动作、通知和 Outbox。该顺序阻止相同来源单据的并发不同 eventId 创建重复审批，并支持崩溃后按原 eventId 恢复。不存在或停用员工、未发布模板、非法表单均拒绝。外部 eventId、来源单据和审批实例均有租户前缀唯一约束。

结果 relay 只消费 CanonicalApproval 的终态 Outbox：

- `cn.gaoq.erp.approval_instance.decided.v1`，仅 `approved/rejected`；
- `cn.gaoq.erp.approval_instance.withdrawn.v1`；
- 非 OP 来源审批不会创建 OP 投递；非终态事件只完成本消费者的处理；
- 结果投递以审批 Outbox eventId 为幂等键，最多自动尝试 6 次，采用 1 秒至 30 分钟的 ±20% 抖动退避。

## 4. ERP → OP 回推契约

固定端点：`PUT /erp/v1/approval-results/{externalEventId}`。目标根地址必须是无用户信息、query、fragment 和非 443 端口的 HTTPS origin；禁止重定向，超时 8 秒，响应上限 256 KiB。审批结果使用独立 `GAOQ_OP_APPROVAL_OUTBOUND_*` 凭据，不得复用入站、组织下发或 SSO Secret。

签名原文为：

```text
timestamp\nnonce\nPUT\npath\nexternalTenantId\nidempotencyKey\nSHA256_BASE64URL(body)
```

正文只含 `externalEventId/sourceDocumentType/sourceDocumentId/approvalInstanceId/approvalVersion/result/occurredAt`，禁止发送表单、审批意见、人员隐私或密钥。OP 必须用幂等键去重，并精确回显外部 eventId、审批实例和版本。409/412 进入人工复核；408/425/429/5xx 与网络错误可自动重试；其他 4xx 进入人工复核。外呼成功落库后，即使审计设施失败也不得把投递改回失败或重复外呼。

## 5. REST、MCP、Scope 与审计

| 能力 | 接口 | Scope | 风险/约束 |
|---|---|---|---|
| 查询桥接状态 | `GET /op/approval-bridges/{externalEventId}` | `erp:op:approval_bridge:read` | R0；无表单 |
| 查询异常投递 | `GET /op/approval-result-deliveries?status=manual_review\|dead` | `erp:op:approval_result:read` | R0；固定投影与游标 |
| 人工重试 | `POST /op/approval-result-deliveries/{eventId}/retries` | `erp:op:approval_result:operate` | R2；必须 Idempotency-Key 和原因码 |
| MCP 查询 | Tool `op_approval_bridge_get` / Resource `erp://op/approval-bridges/{externalEventId}` | `erp:op:approval_bridge:read` | 只读、幂等、复用应用服务 |
| MCP 引导 | Prompt `op_approval_bridge_review_guide` | 同上 | 禁止决策、重试、回推和读取正文 |

必须审计：验签成败、审批创建提交成败、结果外呼成败、人工重试成败和桥接查询。审计元数据只允许控制标识、状态、版本和失败码。

## 6. SLO、监控与退出门禁

- Webhook p95 < 300ms，仅负责验证、加密入箱和入队；可用性目标 99.9%。
- 正常队列下审批创建提交 p95 < 5s；终态结果首次回推 p95 < 10s。
- 告警：验签失败突增、Redis 防重放不可用、Inbox 最老积压 > 5 分钟、Outbox/投递最老积压 > 5 分钟、dead/manual_review > 0、审计后提交失败。
- 验收必须覆盖跨租户隔离、客户端伪造 tenantId、签名/时间戳/nonce、同事件异载荷、Worker 崩溃恢复、模板停用、员工停用、审批终态重复事件、OP 超时/限流/4xx/5xx/超大响应、人工重试幂等和 MCP 无正文泄漏。
- 上线前完成追加式索引 dry-run、OP 沙箱双向联调、Secret Manager 注入、容量评估、备份恢复抽查、断连追赶演练和审计抽查。未满足时不得宣称生产验收完成。
