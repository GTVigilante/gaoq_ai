# Phase 3 生产索引迁移 Runbook

## 变更边界

- 招聘/eSign/组织/入职迁移标识固定为 `phase-3-indexes-v1`；Knowledge 使用 `phase-3-knowledge-indexes-v1`，Care 与 Employment 终止引用使用 `phase-3-care-indexes-v1`。已发布清单不得通过追加 Schema 改写 checksum。
- 只创建缺失索引，不删除未知索引；同名或同键异配置立即失败关闭。
- apply 使用 30 分钟数据库租约，完成后重新读取并复验全部索引。
- 唯一索引创建前必须先在影子库检查重复数据并保留快照；本脚本不会自动删除或合并业务数据。

## 执行步骤

1. 确认 Phase 1、Phase 2 索引迁移均为 `completed`，并完成 MongoDB 快照。
2. 在与生产同版本的影子库部署构建产物，执行：

   ```bash
   pnpm --filter @gaoq/erp-api migrate:phase3:indexes -- --dry-run
   ```

3. 审核输出的 `checksum`、`missing`，并对所有待建唯一索引执行重复数据查询。
4. 在变更窗口执行：

   ```bash
   pnpm --filter @gaoq/erp-api migrate:phase3:indexes
   ```

5. 要求输出 `verified` 等于清单索引总数，且 `system_migration_runs` 中对应记录为 `completed`。
6. 对 Knowledge 追加清单重复执行 dry-run、唯一键查重和变更审核后运行：

   ```bash
   pnpm --filter @gaoq/erp-api migrate:phase3:knowledge-indexes -- --dry-run
   pnpm --filter @gaoq/erp-api migrate:phase3:knowledge-indexes
   ```

7. 执行候选申请、Offer、eSign 回调、Onboarding 重试、Employment 唯一约束、培训进度源事件重放和答卷提交重放冒烟测试。
8. 对 Care 追加清单执行同样的 dry-run、唯一键查重和审核后运行：

   ```bash
   pnpm --filter @gaoq/erp-api migrate:phase3:care-indexes -- --dry-run
   pnpm --filter @gaoq/erp-api migrate:phase3:care-indexes
   ```

9. 验证同一劳动关系不能存在两个进行中离职案件、同一清算任务证据不可替换、Care 终止引用唯一，且 Worker 重试不会重复关闭劳动关系。

## 失败处理

- `PHASE3_INDEX_CONFLICT`：停止发布，比较数据库索引和当前 Schema；禁止自动删除索引。
- `PHASE3_INDEX_MIGRATION_LOCKED`：确认另一执行者状态；只有租约过期后脚本才允许接管。
- `PHASE3_INDEX_MANIFEST_CHANGED`：迁移标识对应的已执行清单被修改，必须创建新迁移版本。
- 唯一键重复：停止迁移，由数据治理流程生成合并/纠错清单并单独审批；不得在迁移脚本中删除数据。
