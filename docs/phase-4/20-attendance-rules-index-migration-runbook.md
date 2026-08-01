# Phase 4 Attendance 规则索引迁移 Runbook

迁移标识固定为 `phase-4-attendance-rules-indexes-v2`。本迁移只为
`attendance_shift_rules`、`attendance_shift_assignments`、
`attendance_shift_assignment_guards` 和 `attendance_provider_coverages`
追加索引，并写入带 manifest checksum 的迁移
记录；不得修改已发布的 `phase-4-attendance-indexes-v1`。

## 上线前检查

1. 备份四个目标集合与迁移记录集合，确认 MongoDB Replica Set 健康、维护窗口和
   回滚负责人已经批准。
2. 对影子数据执行以下检查，任一冲突均为 No-Go：
   - 规则 `tenantId + id` 不重复；
   - 规则 `tenantId + rulesetVersion + shiftCode` 不重复；
   - 排班 `tenantId + employeeId + effectiveFrom` 不重复且有效区间不重叠；
   - 排班并发守卫 `tenantId + employeeId` 唯一；
   - 覆盖证明的租户、员工、Provider、月份、状态、映射与截止时间组合不重复；
   - 每个排班完整落在唯一 `Employment` 和引用规则的有效区间内。
3. 确认生产配置保持 `autoIndex=false`，并先执行：

```bash
pnpm --filter @gaoq/erp-api build
pnpm --filter @gaoq/erp-api migrate:phase4:attendance-rules-indexes -- --dry-run
```

dry-run 必须只报告计划创建或已存在且定义一致的索引；checksum 不一致、同名不同
定义、唯一键冲突或数据库不可用均为 No-Go。

## 执行与验证

维护窗口内执行：

```bash
pnpm --filter @gaoq/erp-api migrate:phase4:attendance-rules-indexes
```

随后验证：

- 迁移记录 ID、manifest checksum 与当前构建一致；
- 四个集合的索引与 Schema 清单逐项一致；
- 重复规则、重叠起始日排班和重复覆盖证明被唯一索引拒绝；
- 规则与排班登记都要求可信租户、专用 Scope 和 `Idempotency-Key`；
- Provider 覆盖对账在不足月末水位、未决 Inbox、映射分页未完成或零活动映射时
  失败关闭；
- 同一月结输入可重放出相同逐日摘要与快照哈希，跨天签退只归属受控夜班前日；
- REST、事件、日志、审计和 MCP 均不出现游标、外部员工 ID、打卡原文或治理证据
  正文。

## 回滚

业务记录和迁移证据均为追加式，不得删除记录、覆盖有效期或伪造迁移未执行。
发布失败时先回滚应用流量。只有确认新增索引本身阻断且已经保留备份与精确索引
定义时，才由 DBA 删除本迁移新增的精确索引；迁移记录保留并追加处置证据。需要
更正班次或排班时登记新规则或新有效区间，不修改历史记录。
