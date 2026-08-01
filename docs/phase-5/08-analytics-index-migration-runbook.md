# Phase 5 管理分析索引迁移运行手册

迁移标识为 `phase-5-analytics-indexes-v2`。它在 v1 基础上为追加式
`approval_actions` 补充 `tenantId + resultingStatus + occurredAt` 固定查询索引，
继续为 `approval_instances`、`recruitment_applications`、
`knowledge_training_assignments` 和 `analytics_management_exports` 汇总声明式索引；
不删除、改名、覆盖数据或创建个人敏感字段索引。v2 使用新的迁移标识，不能覆盖
已经执行过的 v1 证据。

## 执行步骤

```bash
pnpm --filter @gaoq/erp-api build
pnpm --filter @gaoq/erp-api migrate:phase5:analytics-indexes -- --dry-run
pnpm --filter @gaoq/erp-api migrate:phase5:analytics-indexes
pnpm --filter @gaoq/erp-api migrate:phase5:analytics-indexes -- --dry-run
```

生产 apply 前必须确认 `MONGODB_URI` 指向目标 Replica Set，完成可恢复备份抽查、
容量评估、索引构建窗口审批，并登记执行人、复核人、监控人和停止条件。重点检查：

- 历史进行中审批按 `tenantId + submittedAt/completedAt` 查询；
- 最终审批结果按 `tenantId + resultingStatus + occurredAt` 查询
  `approval_actions`，不能回退到已归档实例的当前 status；
- 招聘按 `tenantId + stage + endedAt`、培训按
  `tenantId + mandatory + status` 查询；
- 导出记录按 `tenantId + id` 唯一，TTL 使用 `expiresAt` 绝对过期，并可按
  `status + processingStartedAt` 发现陈旧租约；Worker 的 generation、JobId 和
  token fencing 由应用层原子过滤保证。

第二次 dry-run 必须无新增动作，以证明幂等。生产 explain、构建时长、复制延迟
和执行记录属于目标环境证据，本地 manifest 测试不能替代。

出现唯一冲突、复制延迟越线、锁等待异常或 API SLO 恶化时，立即停止后续动作并保存执行记录、查询计划和监控快照。迁移程序不会自动删索引；索引回退属于独立危险变更，必须经过容量、查询回退和变更评审后另行授权。
