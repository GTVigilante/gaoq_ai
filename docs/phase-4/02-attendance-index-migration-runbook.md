# Phase 4 Attendance 索引迁移 Runbook

迁移标识固定为 `phase-4-attendance-indexes-v1`。迁移只追加索引并写入带 manifest checksum 的迁移记录；已发布清单不得原地改写。

## 上线前检查

1. 备份三个 Attendance 集合与迁移记录集合，并确认 MongoDB Replica Set 健康。
2. 注入互相独立的 `ATTENDANCE_DATA_ENCRYPTION_KEYS` 与 `ATTENDANCE_BLIND_INDEX_KEYS`；禁止把值写入仓库、镜像或命令日志。
3. 在影子数据上检查以下重复键；任一结果非空均为 No-Go：
   - 源事实：`tenantId + sourceEventBlindIndexes`；
   - 修订：`tenantId + sourceFactId`、`tenantId + approvalInstanceId`；
   - 快照：`tenantId + employeeId + month + snapshotVersion`；
   - 活动快照：同一 `tenantId + employeeId + month` 的 `status=active` 只能一条；
   - 版本链：同一 `previousSnapshotId` 只能被一个后继引用。
4. 先执行构建，再运行：

```bash
pnpm --filter @gaoq/erp-api build
pnpm --filter @gaoq/erp-api migrate:phase4:attendance-indexes -- --dry-run
```

dry-run 必须只报告计划创建或已存在且一致的索引，不得出现 checksum、同名不同定义或唯一键冲突。

## 执行与验证

维护窗口内执行：

```bash
pnpm --filter @gaoq/erp-api migrate:phase4:attendance-indexes
```

随后验证：

- 迁移记录的 ID 与 checksum 和当前构建清单一致；
- 所有唯一索引已创建，应用生产配置保持 `autoIndex=false`；
- 同一外部事件重放返回同一事实，不产生第二条；
- 首次月结产生 v1，未带审批的重开失败，带已批准 `attendance_month_reopen` 的重开产生 v2 且 v1 为 `superseded`；
- 本人 REST 与 MCP 返回同一快照哈希，且输出中没有地点、设备、外部事件 ID、原因或逐日明细。

## 回滚

业务记录是追加式证据，不得通过删记录回滚。发布失败时先回滚应用流量；只有确认索引阻断且已经保留备份和索引定义时，才由 DBA 按精确索引名回退本次新增索引。不得删除迁移记录伪造未执行状态，也不得批量把 `superseded` 改回 `active`。需要恢复月结时，走新的审批重开版本。
