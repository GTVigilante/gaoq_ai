# Phase 1 MongoDB 索引迁移运行手册

## 1. 约束

- 生产环境保持 `autoIndex=false`，应用与 Worker 启动不得隐式修改索引。
- 迁移器以业务 Mongoose schema 为唯一声明源，只创建缺失索引，绝不调用 `syncIndexes()`、`dropIndex()` 或删除未知索引。
- 同名异键、同键异选项、清单校验和漂移均失败关闭，必须先完成数据与变更评审。
- 迁移仅输出迁移标识、模式、校验和与数量，不输出 MongoDB URI、凭据、文档内容或原始数据库错误。

## 2. 发布顺序

1. 在与生产同版本的预发环境执行 `pnpm --filter @gaoq/erp-api build`。
2. 由 CI/CD 短期身份注入 `MONGODB_URI`，先运行 `pnpm --filter @gaoq/erp-api migrate:phase1:indexes -- --dry-run`。
3. dry-run 无冲突后，在单一发布任务运行 `pnpm --filter @gaoq/erp-api migrate:phase1:indexes`。
4. 确认输出 `verified` 等于清单索引总数，并检查 `system_migration_runs/phase-1-indexes-v2` 为 `completed`。
5. 再滚动发布 API 与 Worker；不得并行启动多个迁移任务，租约只用于防误操作，不替代发布编排。

## 3. 失败处理

- `PHASE1_INDEX_MIGRATION_LOCKED`：已有迁移任务；核实发布平台任务，不得手工删租约。租约 30 分钟后才允许受控接管。
- `PHASE1_INDEX_CONFLICT`：数据库现有索引与声明不一致；停止发布，导出 `listIndexes` 的非敏感结构并走 DBA/架构评审。
- `PHASE1_INDEX_MANIFEST_CHANGED`：已发布迁移 ID 对应的声明发生变化；必须创建新版本迁移，禁止覆盖历史校验和。
- `PHASE1_INDEX_DATABASE_FAILURE`：查看数据库平台审计与受控日志；迁移器不会把原始错误写入 CI 输出或迁移记录。
- 创建过程中断可直接重跑；已创建的等价索引会被验证并跳过，未知人工索引不会被删除。

## 4. 验收证据

- 保存 dry-run 与 apply 的脱敏 JSON 输出、Git commit、CI run、执行环境、开始/完成时间和审批人。
- 在脱敏副本验证唯一索引重复数据失败路径、TTL/partialFilterExpression、重复执行幂等性和应用查询 explain。
- 当前清单覆盖审计、身份、组织、集成、Outbox、幂等和首次开户共 18 个集合、59 个声明索引；新增集合或索引必须新增迁移版本与测试。
