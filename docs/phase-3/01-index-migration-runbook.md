# Phase 3 生产索引迁移 Runbook

## 变更边界

- 招聘/eSign/组织/入职迁移标识固定为 `phase-3-indexes-v1`；Knowledge 使用 `phase-3-knowledge-indexes-v1`，Care 与 Employment 终止引用使用 `phase-3-care-indexes-v1`，招聘渠道使用 `phase-3-recruitment-channel-indexes-v1`，智能简历库使用 `phase-3-recruitment-resume-indexes-v1`，人才全周期使用 `phase-3-talent-lifecycle-indexes-v1`。已发布清单不得通过追加 Schema 改写 checksum。
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

   Care 索引迁移后先只读校验存量活动校友授权，再显式重建稳定到期任务：

   ```bash
   pnpm --filter @gaoq/erp-api migrate:phase3:care-consent-expiry-jobs -- --dry-run
   pnpm --filter @gaoq/erp-api migrate:phase3:care-consent-expiry-jobs -- --apply
   ```

   `--dry-run` 只读取 `active` 授权的租户、授权标识与到期时间并输出总数；`--apply`
   还要求 `REDIS_URL`，按 500 条批量写入稳定 JobId，不输出业务标识或连接信息。
   非法历史标识、Mongo/Redis 不可用或任一批写入失败时必须失败关闭并重跑；已存在
   JobId 由 BullMQ 幂等去重。到期业务状态仍只能由 Worker 写入，迁移工具不得直改授权。
10. 对招聘渠道追加清单执行 dry-run 和变更审核：

   ```bash
   pnpm --filter @gaoq/erp-api migrate:phase3:recruitment-channel-indexes -- --dry-run
   pnpm --filter @gaoq/erp-api migrate:phase3:recruitment-channel-indexes
   ```

11. 验证同租户同渠道只有一个绑定，同一外部事件盲指纹只入箱一次，同一外部 ID 不能映射到两个 ERP 实体；职位投递按事件/绑定唯一，申请阶段投递按申请/版本唯一。
12. 对智能简历库追加清单执行 dry-run 和变更审核：

   ```bash
   pnpm --filter @gaoq/erp-api migrate:phase3:recruitment-resume-indexes -- --dry-run
   pnpm --filter @gaoq/erp-api migrate:phase3:recruitment-resume-indexes
   ```

13. 验证同一候选人、简历证据和 Prompt 版本只生成一份分析；`tags.code/tags.status` 查询只命中租户内已确认标签，过期候选人不能新建或继续处理分析。
14. 对人才全周期服务触点追加清单执行 dry-run 和变更审核：

   ```bash
   pnpm --filter @gaoq/erp-api migrate:phase3:talent-lifecycle-indexes -- --dry-run
   pnpm --filter @gaoq/erp-api migrate:phase3:talent-lifecycle-indexes
   ```

15. 验证同租户触点标识唯一，候选人时间线按发生时间可检索，开放跟进可按状态、下一行动时间和责任人检索；确认集合、索引、Outbox、审计和日志均不含服务备注明文，并执行候选人授权过期、校友授权撤回、目的不匹配和渠道不匹配的失败关闭测试。

## 失败处理

- `PHASE3_INDEX_CONFLICT`：停止发布，比较数据库索引和当前 Schema；禁止自动删除索引。
- `PHASE3_INDEX_MIGRATION_LOCKED`：确认另一执行者状态；只有租约过期后脚本才允许接管。
- `PHASE3_INDEX_MANIFEST_CHANGED`：迁移标识对应的已执行清单被修改，必须创建新迁移版本。
- 唯一键重复：停止迁移，由数据治理流程生成合并/纠错清单并单独审批；不得在迁移脚本中删除数据。
