# Phase 5 OP 经营摘要索引迁移运行手册

## 1. 适用范围

迁移标识：`phase-5-op-operating-summary-indexes-v1`。本迁移只追加以下集合的索引，不删除、重命名或覆盖数据：

- `op_client_bindings`
- `op_operating_summary_inbox`
- `op_operating_summaries`

生产执行前必须完成备份可恢复性抽查，并确认 `MONGODB_URI` 指向正确的 Replica Set 与目标数据库。禁止在未经审批的环境执行 apply。

## 2. 构建与预检

```bash
pnpm --filter @gaoq/erp-api build
pnpm --filter @gaoq/erp-api migrate:phase5:op-operating-summary-indexes -- --dry-run
```

检查 dry-run 输出：迁移标识必须准确，所有动作必须为新增或已存在；若报告唯一索引冲突，停止迁移并先生成租户维度的数据质量差异报告，禁止手工删重。

## 3. 预发执行

```bash
pnpm --filter @gaoq/erp-api migrate:phase5:op-operating-summary-indexes
pnpm --filter @gaoq/erp-api migrate:phase5:op-operating-summary-indexes -- --dry-run
```

第二次 dry-run 必须证明幂等。随后验证：

- `clientId` 全局唯一，且绑定表不含明文 HMAC Secret；
- Inbox 具备租户前缀 eventId/nonce 摘要唯一索引；
- `expiresAt` TTL 索引存在，过期策略为绝对时间；
- 摘要具备 `{tenantId, summaryDate, revision}` 唯一索引及最新修订查询索引；
- API 与 Worker 均保持健康，队列无异常积压。

## 4. 生产执行门禁

以下条件全部满足后才可执行：

- OP 沙箱签名、重放、幂等和连续修订测试通过；
- `OP_WEBHOOK_ENCRYPTION_KEYS` 与每租户 `GAOQ_OP_HMAC_*` 已由 Secret Manager 注入且不复用；
- 变更单、执行人、复核人、监控人和维护窗口已确认；
- Mongo 备份恢复抽查、容量和索引构建资源评估已通过；
- 告警接收人与停止条件已登记。

生产命令与预发相同。执行后保存结构化输出、Mongo 索引清单与监控截图作为变更证据。

## 5. 停止与恢复

出现连接错误、复制延迟越线、锁等待异常、唯一冲突或 API/Worker SLO 恶化时立即停止后续动作。迁移工具不会自动删除索引；是否回退新增索引必须另行评审并取得明确授权。业务恢复优先采用停止 OP 推送、保留加密 Inbox 和待队列追赶，不得物理删除 Inbox、摘要或审计记录。
