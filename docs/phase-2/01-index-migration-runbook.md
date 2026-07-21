# Phase 2 索引迁移手册

## 范围

迁移脚本覆盖以下集合：

- `approval_templates`
- `approval_instances`
- `approval_actions`
- `approval_delegations`
- `approval_notification_deliveries`
- `mcp_operation_confirmations`
- `identity_webauthn_credentials`
- `identity_webauthn_ceremonies`

脚本只创建缺失索引，不删除或重建未知索引。同名异键、同键异配置、迁移清单校验和漂移均失败关闭。

## 前置检查

1. 目标必须是 MongoDB Replica Set，已验证多数派写关注和事务能力。
2. 为目标数据库创建可恢复快照，并记录快照 ID、时间和恢复演练证据。
3. 检查 `system_migration_locks` 中不存在未过期的 `phase-2-indexes-v1:lock`。
4. 检查唯一索引字段是否存在重复数据；发现重复必须转人工清理，禁止让脚本覆盖。
5. 使用与生产构建完全相同的镜像运行迁移，禁止本机源码直连生产。

## 执行

构建后先执行只读检查：

```bash
pnpm --filter @gaoq/erp-api build
pnpm --filter @gaoq/erp-api migrate:phase2:indexes -- --dry-run
```

dry-run 输出必须满足：

- `migrationId` 为 `phase-2-indexes-v1`；
- `checksum` 与变更单记录一致；
- `missing` 数量与预期一致；
- 无 `PHASE2_INDEX_CONFLICT`。

在维护窗口执行：

```bash
pnpm --filter @gaoq/erp-api migrate:phase2:indexes
```

执行完成后再次 dry-run，必须得到 `missing: 0`。同时检查 `system_migration_runs` 中状态为 `completed`，集合数、索引数和清单一致。

## 失败处理

- `PHASE2_INDEX_MIGRATION_LOCKED`：确认另一实例状态，不得手工删除未过期租约。
- `PHASE2_INDEX_CONFLICT`：停止发布，导出实际索引定义并走 DBA 评审；脚本不会自动删除冲突索引。
- `PHASE2_INDEX_MANIFEST_CHANGED`：构建物与已审批清单不一致，重新走变更审批。
- `PHASE2_INDEX_VERIFY_FAILED`：停止 API/Worker 扩容，保存数据库和迁移日志，按 Sev2 处理。
- 唯一索引创建失败：停止迁移，定位重复业务记录；禁止以非唯一索引替代。

回退以应用版本回退和数据库快照恢复为主。索引删除属于破坏性操作，必须单独审批，不包含在本脚本中。
