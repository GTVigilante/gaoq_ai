# Phase 5 OP 审批桥索引迁移运行手册

迁移标识为 `phase-5-op-approval-indexes-v1`，只为 `op_approval_routes`、`op_approval_request_inbox`、`op_approval_bridges`、`op_approval_result_deliveries` 追加索引，不删除、改名或覆盖数据。

## 执行步骤

```bash
pnpm --filter @gaoq/erp-api build
pnpm --filter @gaoq/erp-api migrate:phase5:op-approval-indexes -- --dry-run
pnpm --filter @gaoq/erp-api migrate:phase5:op-approval-indexes
pnpm --filter @gaoq/erp-api migrate:phase5:op-approval-indexes -- --dry-run
```

生产 apply 前必须确认 `MONGODB_URI` 指向目标 Replica Set，`OP_APPROVAL_WEBHOOK_ENCRYPTION_KEYS`、各 `GAOQ_OP_HMAC_*` 与 `GAOQ_OP_APPROVAL_OUTBOUND_*` 已由 Secret Manager 分域注入且互不复用，完成可恢复备份抽查、唯一键数据质量扫描、容量与索引构建影响评估，并登记执行人、复核人、监控人和停止条件。第二次 dry-run 必须无新增动作，以证明幂等。

重点核验：路由按租户/入站客户端/来源类型唯一；Inbox eventId 幂等且存在 90 天绝对 TTL；桥接的外部 eventId、来源单据与审批实例在租户内唯一；审批结果按 Outbox eventId 和审批版本唯一；异常投递可按租户、状态和 eventId 分页检索。

若发生唯一冲突、复制延迟越线、锁等待异常或 API/Worker SLO 恶化，立即停止后续动作并保留证据。迁移程序不自动删索引；回退新增索引属于独立危险变更，必须另行评审和授权。业务恢复优先暂停 OP 推送并保留 Inbox、Outbox、投递和审计记录。
