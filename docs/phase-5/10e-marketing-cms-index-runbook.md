# Marketing CMS 与副作用 Outbox 索引运行手册

迁移标识固定为 `phase-5-marketing-cms-indexes-v1`，覆盖内容、版本、线索、媒体、
AI 草稿和 `marketing_side_effect_outbox` 六个集合。只追加缺失索引；同名或同键
异配置必须失败关闭，脚本不得删除、重命名或重建未知生产索引。

执行前必须完成 MongoDB Replica Set 快照，确认没有活动 DDL，并对内容 slug、
版本号、线索/媒体标识及副作用幂等键执行重复值查询。先在生产等价影子库执行：

```bash
pnpm --filter @gaoq/erp-api migrate:phase5:marketing-cms-indexes -- --dry-run
```

审核 `checksum`、`missing` 和所有唯一索引查重证据后，才可在批准窗口执行：

```bash
pnpm --filter @gaoq/erp-api migrate:phase5:marketing-cms-indexes
```

验收必须证明：

- 同租户、站点、语言、内容类型和 slug 唯一；
- 内容 revision 不可重复，线索盲索引和媒体对象引用只在租户内检索；
- 同一租户、种类、聚合、版本和渠道只有一条副作用事实；
- `status + nextAttemptAt + createdAt` 可稳定扫描待投递和过期锁；
- 模拟数据库提交后 Redis 不可用，业务与 Outbox 同时存在，恢复后只形成一个
  稳定 Job ID；通知网关收到相同幂等键时不重复发送；
- 模拟网关或发布事务连续失败，确认 `deliveryAttempts` 达到上限后进入 `dead`
  并触发受控错误码告警；排期撤回确认同一事务进入 `cancelled`；
- 删除一条已投递但未执行的 Redis 延迟任务，确认周期扫描只从数据库
  `dispatched` Outbox 重建并最终进入 `delivered`；
- 跨租户人工重放返回拒绝，只有 `dead` 记录可恢复为 `pending`。

若发现重复数据、迁移锁占用或清单 checksum 变化，立即停止。数据修复必须形成
独立审批清单，不得在迁移脚本内删除或合并记录。
