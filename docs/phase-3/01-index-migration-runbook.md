# Phase 3 生产索引迁移 Runbook

## 变更边界

- 招聘/eSign/组织/入职迁移标识固定为 `phase-3-indexes-v1`；eSign 发起状态机追加清单使用 `phase-3-esign-issuance-indexes-v1`，Knowledge 使用 `phase-3-knowledge-indexes-v1`，Knowledge 授权搜索追加清单使用 `phase-3-knowledge-search-indexes-v1`，Knowledge 考试编排追加清单使用 `phase-3-knowledge-exam-indexes-v1`，Care 与 Employment 终止引用使用 `phase-3-care-indexes-v1`，生日/周年关怀使用 `phase-3-care-occasion-indexes-v1`，校友授权下游清理证明使用 `phase-3-care-alumni-cleanup-indexes-v1`，招聘渠道使用 `phase-3-recruitment-channel-indexes-v1`，智能简历库使用 `phase-3-recruitment-resume-indexes-v1`，人才全周期使用 `phase-3-talent-lifecycle-indexes-v1`。已发布清单不得通过追加 Schema 改写 checksum。
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

7. eSign 发起状态机必须使用独立追加清单，禁止修改已发布
   `phase-3-indexes-v1` checksum：

   ```bash
   pnpm --filter @gaoq/erp-api migrate:phase3:esign-issuance-indexes -- --dry-run
   pnpm --filter @gaoq/erp-api migrate:phase3:esign-issuance-indexes
   ```

   执行前确认同租户 Offer 不存在重复发起意图；执行后验证请求唯一键、Offer 唯一键、
   状态调度扫描和人工处置分页索引。供应商创建结果未知的请求必须保持
   `manual_review`，不得用迁移或调度器自动重放；已保存外部回执的请求只允许补本地
   终态。

8. 执行候选申请、Offer、eSign 发起/回调、Onboarding 重试、Employment 唯一约束、培训进度源事件重放和答卷提交重放冒烟测试。

   Knowledge 考试编排必须先执行独立追加清单，再运行只读对账：

   ```bash
   pnpm --filter @gaoq/erp-api migrate:phase3:knowledge-exam-indexes -- --dry-run
   pnpm --filter @gaoq/erp-api migrate:phase3:knowledge-exam-indexes
   pnpm --filter @gaoq/erp-api reconcile:phase3:knowledge-exams
   ```

   死信只能按 [考试编排与评分运行手册](./03-knowledge-exam-orchestration-runbook.md) 经人工审批显式重放。

   Knowledge 授权搜索必须先执行独立追加清单，再按“只读审核 → 显式应用 → 对账 → 必要时重建 → 再对账”顺序运行：

   ```bash
   pnpm --filter @gaoq/erp-api migrate:phase3:knowledge-search-indexes -- --dry-run
   pnpm --filter @gaoq/erp-api migrate:phase3:knowledge-search-indexes
   pnpm --filter @gaoq/erp-api migrate:phase3:knowledge-search-reconcile
   pnpm --filter @gaoq/erp-api migrate:phase3:knowledge-search-rebuild -- --dry-run
   pnpm --filter @gaoq/erp-api migrate:phase3:knowledge-search-rebuild -- --apply
   pnpm --filter @gaoq/erp-api migrate:phase3:knowledge-search-reconcile
   ```

   对账命令只输出 `expected/completed/missing/pending/dead/stale/ready` 聚合值，不读取正文、身份或受众成员；非就绪以退出码 2 失败关闭。`--apply` 只为缺失业务键补任务并回填旧课程的 `assigned_only` 默认受众，不重放已完成任务；只有独立审批恢复死信或灾后重建时才可使用 `--force-replay`。重建按租户和课程编码选择最高仍发布修订执行 `upsert`，旧修订与已下架版本执行 `delete`。执行后必须确认三类 Knowledge 搜索指标持续采集、死信为零，并保存真实搜索集群的中文/英文分词、权限撤销、调岗、离职、下架、旧版本、超时、性能、安全和 UAT 证据；本地替身不得代替现场证据。
9. 对 Care 追加清单执行同样的 dry-run、唯一键查重和审核后运行：

   ```bash
   pnpm --filter @gaoq/erp-api migrate:phase3:care-indexes -- --dry-run
   pnpm --filter @gaoq/erp-api migrate:phase3:care-indexes
   ```

10. 验证同一劳动关系不能存在两个进行中离职案件、同一清算任务证据不可替换、Care 终止引用唯一，且 Worker 重试不会重复关闭劳动关系。

   生日/周年关怀必须使用独立追加清单，禁止把 Person 新索引追加回已发布
   `phase-3-indexes-v1`：

   ```bash
   pnpm --filter @gaoq/erp-api migrate:phase3:care-occasion-indexes -- --dry-run
   pnpm --filter @gaoq/erp-api migrate:phase3:care-occasion-indexes
   ```

   执行前检查同租户生日证明引用、员工偏好，以及“员工 + 类型 + 年度”任务自然键
   重复；执行后验证盲索引不含明文月日、待处理任务可按状态/时间扫描、Worker 锁可
   恢复且全局对账队列为空载荷。详细验收见
   [生日与入职周年关怀运行手册](./04-care-occasion-orchestration-runbook.md)。

   Care 索引迁移后先只读校验存量活动校友授权，再显式重建稳定到期任务：

   ```bash
   pnpm --filter @gaoq/erp-api migrate:phase3:care-consent-expiry-jobs -- --dry-run
   pnpm --filter @gaoq/erp-api migrate:phase3:care-consent-expiry-jobs -- --apply
   ```

   `--dry-run` 只读取 `active` 授权的租户、授权标识与到期时间并输出总数；`--apply`
   还要求 `REDIS_URL`，按 500 条批量写入稳定 JobId，不输出业务标识或连接信息。
   非法历史标识、Mongo/Redis 不可用或任一批写入失败时必须失败关闭并重跑；已存在
   JobId 由 BullMQ 幂等去重。到期业务状态仍只能由 Worker 写入，迁移工具不得直改授权。

   校友授权清理必须使用独立追加清单，禁止改变已发布
   `phase-3-care-indexes-v1` checksum：

   ```bash
   pnpm --filter @gaoq/erp-api migrate:phase3:care-alumni-cleanup-indexes -- --dry-run
   pnpm --filter @gaoq/erp-api migrate:phase3:care-alumni-cleanup-indexes
   pnpm --filter @gaoq/erp-api reconcile:phase3:care-alumni-cleanup
   ```

   执行前检查授权/版本/目的/目标/政策自然键和租户内证明摘要重复；执行后必须验证
   恢复扫描、源事件定位和部分唯一证明索引。重放与重建必须遵守
   [校友授权终止后的下游清理证明运行手册](./05-alumni-cleanup-proof-runbook.md)，
   不得修改完成证明；重建只能从权威终态授权的原版本、原目的和原终止时刻恢复
   缺失/已死源事件，再由运行时 relay 扇出。
11. 对招聘渠道追加清单执行 dry-run 和变更审核：

   ```bash
   pnpm --filter @gaoq/erp-api migrate:phase3:recruitment-channel-indexes -- --dry-run
   pnpm --filter @gaoq/erp-api migrate:phase3:recruitment-channel-indexes
   ```

12. 验证同租户同渠道只有一个绑定，同一外部事件盲指纹只入箱一次，同一外部 ID 不能映射到两个 ERP 实体；职位投递按事件/绑定唯一，申请阶段投递按申请/版本唯一。
13. 对智能简历库追加清单执行 dry-run 和变更审核：

   ```bash
   pnpm --filter @gaoq/erp-api migrate:phase3:recruitment-resume-indexes -- --dry-run
   pnpm --filter @gaoq/erp-api migrate:phase3:recruitment-resume-indexes
   ```

14. 验证同一候选人、简历证据和 Prompt 版本只生成一份分析；`tags.code/tags.status` 查询只命中租户内已确认标签，过期候选人不能新建或继续处理分析。
15. 对人才全周期服务触点追加清单执行 dry-run 和变更审核：

   ```bash
   pnpm --filter @gaoq/erp-api migrate:phase3:talent-lifecycle-indexes -- --dry-run
   pnpm --filter @gaoq/erp-api migrate:phase3:talent-lifecycle-indexes
   ```

16. 验证同租户触点标识唯一，候选人时间线按发生时间可检索，开放跟进可按状态、下一行动时间和责任人检索；确认集合、索引、Outbox、审计和日志均不含服务备注明文，并执行候选人授权过期、校友授权撤回、目的不匹配和渠道不匹配的失败关闭测试。

## 失败处理

- `PHASE3_INDEX_CONFLICT`：停止发布，比较数据库索引和当前 Schema；禁止自动删除索引。
- `PHASE3_INDEX_MIGRATION_LOCKED`：确认另一执行者状态；只有租约过期后脚本才允许接管。
- `PHASE3_INDEX_MANIFEST_CHANGED`：迁移标识对应的已执行清单被修改，必须创建新迁移版本。
- 唯一键重复：停止迁移，由数据治理流程生成合并/纠错清单并单独审批；不得在迁移脚本中删除数据。
