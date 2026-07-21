# Phase 4 Attendance Provider 索引迁移 Runbook

迁移标识固定为 `phase-4-attendance-provider-indexes-v1`。它是独立于 `phase-4-attendance-indexes-v1` 的只追加迁移；禁止修改已发布 Attendance 迁移清单。

## 上线前检查

1. 确认 `ATTENDANCE_DATA_ENCRYPTION_KEYS` 与 `ATTENDANCE_BLIND_INDEX_KEYS` 已由 Secret Manager 注入，且包含所有仍被历史密文/盲索引使用的只读旧密钥。
2. 对以下组合执行重复检查，任一结果非空即 No-Go：
   - 状态：`tenantId + providerCode`；
   - 员工：`tenantId + providerCode + employeeId`；
   - 外部员工：`tenantId + providerCode + externalIdBlindIndexes`；
   - 事件：`tenantId + providerCode + eventBlindIndexes`。
3. 确认 Provider 状态均为 `disabled`；迁移和应用发布不能自动开启真实补拉。
4. 构建后执行：

```bash
pnpm --filter @gaoq/erp-api build
pnpm --filter @gaoq/erp-api migrate:phase4:attendance-provider-indexes -- --dry-run
```

dry-run 不得出现 checksum 漂移、同名不同定义或唯一键冲突。

## 执行与验证

```bash
pnpm --filter @gaoq/erp-api migrate:phase4:attendance-provider-indexes
```

执行后验证三个集合索引与迁移 checksum，并使用单个沙箱租户：

1. 保持状态 `disabled` 启动 API 与 Worker，确认无 Provider 请求。
2. 完成官方权限和时区核对后激活，确认原始 Provider ID 不出现在集合可见字段、日志、Outbox 或审计元数据。
3. 人为制造第 2 批失败，确认第 1 批 Inbox 可恢复但游标不推进；恢复后重放不产生重复事实。
4. 制造未知员工、Schema 漂移和请求 ID 指纹不一致，确认均进入 `manual_review`，不会写入 Attendance。
5. 轮换盲索引密钥时，新旧指纹并存查询；完成回填和验证前不得删除 `lookup_only` 密钥。

## 回滚

先把精确租户的 Provider 状态改为 `disabled` 并停止 Worker 流量，再回滚应用。Inbox 和 Attendance 源事实均为审计证据，不得删除或改写。只有 DBA 确认索引本身阻断且已保存定义和备份时，才可按精确索引名回退本次新增索引；不得删除迁移记录伪造未执行状态。
