# Phase 5 管理驾驶舱与受控分析导出契约

## 1. 目标与使用场景

首切片服务管理层、HR 与运营负责人每日查看经营和组织健康度，周会复核趋势与异常。驾驶舱只呈现组织级固定聚合，不提供个人排名、个体绩效推断、候选人明细、工资金额或审批正文。所有指标来自 ERP 权威集合或已验签入库的 OP 日摘要，不使用前端模拟数据。

当前没有经批准的年度目标与历史基线来源，因此首版不展示目标达成率、红黄绿阈值或因果结论。目标值必须在后续版本由有版本、责任人、生效期和审计记录的目标主数据提供。

## 2. KPI 口径

口径日 `asOf` 使用 `YYYY-MM-DD`，时区固定 `Asia/Shanghai`。30 日窗口包含口径日，共 30 个自然日；交易型指标实时查询，OP 与薪资显示各自最新覆盖日期。

| 领域 | 指标 | 固定定义 | 权威来源 |
| --- | --- | --- | --- |
| 组织 | 在职、试用、停职人数 | 截至查询时点按员工状态计数 | `org_employees` |
| 审批 | 进行中 | 状态为 `running` | `approval_instances` |
| 审批 | 超 48 小时 | 历史口径日按日终、当日按查询时点，`running` 且提交时间早于 48 小时界线 | `approval_instances` |
| 审批 | 30 日完成量 | 窗口内状态为 `approved` 或 `rejected` 且有完成时间 | `approval_instances` |
| 审批 | 通过率 | 窗口内通过量 ÷ 完成量，整数基点；分母为零返回 `null` | `approval_instances` |
| 招聘 | 开放职位/HC | 状态为 `open` 的职位数及其 `headcount` 总和 | `recruitment_positions` |
| 招聘 | 活跃申请 | `active=true` 的申请数 | `recruitment_applications` |
| 招聘 | 30 日入职 | 窗口内阶段为 `hired` 且有结束时间 | `recruitment_applications` |
| 学习 | 必修/完成/过期 | `mandatory=true`，分别按全部、`completed`、`expired` 计数 | `knowledge_training_assignments` |
| 学习 | 必修完成率 | 已完成必修 ÷ 全部必修，整数基点；分母为零返回 `null` | `knowledge_training_assignments` |
| 薪资 | 最新周期状态 | 不晚于口径月的最新周期、状态与覆盖人数，不返回任何金额 | `payroll_periods` |
| 经营 | 最新日摘要 | 不晚于口径日的最高修订版 GMV、订单数与退款额 | `op_operating_summaries` |

## 3. 接口与 AI 对接

- REST：`GET /api/analytics/management-dashboard?asOf=YYYY-MM-DD`
- Scope：`erp:analytics:management:read`
- 审计：`analytics.management_dashboard.read`，R1，只记录口径日与来源数量。
- MCP Tool：`management_dashboard_get`，R1、只读、幂等、封闭世界，直接复用 `ManagementDashboardService`。
- MCP Resource：`erp://analytics/management-dashboard/{asOf}`。
- MCP Prompt：`management_dashboard_review_guide`，要求先核对时间窗与覆盖日期，不推断个人表现或因果。
- MCP 导出：`management_dashboard_export_prepare` 固化口径并生成 R2 确认单；`management_dashboard_export_execute` 只消费经 Passkey 确认的一次性凭据，返回 `erp://analytics/exports/{id}` Resource Link。

REST 与 MCP 输出使用同一应用服务和同一固定口径。调用方不得传 tenantId、字段名、Mongo 条件、排序或任意聚合表达式；租户只能来自服务端已验证身份。

## 4. 数据分级、展示与新鲜度

- 输出整体为 L2 内部管理数据；薪资明细、候选人 PII、员工姓名/工号、审批标题/表单/意见属于禁止输出字段。
- `generatedAt` 是计算时点；`freshness.transactional=live` 表示交易集合实时聚合；`operatingSummaryDate` 与 `payrollPeriod` 明示非实时来源覆盖范围。
- 空分母比例返回 `null`，前端显示“暂无基数”；缺少 OP 或薪资覆盖时返回 `null`，不得填零。
- 页面必须具备加载、空值、未授权、异常和重试状态，不展示服务端原始错误。

## 5. 受控导出边界

分析导出属于 R2，采用“准备 → Passkey 人工确认 → 异步生成 → 有时效资源链接”的状态机：固定字段、固定口径日、固定 JSON 格式、一次性幂等键、服务端可信租户和全链路审计。BullMQ Worker 生成 `management-dashboard-export.v1` 聚合产物及 SHA-256 内容摘要；任务具有重试与五分钟执行租约，Worker 崩溃后可接管陈旧租约。资源按可信租户、发起人及 `erp:analytics:management:export` Scope 再次鉴权，24 小时绝对过期，不在 URI 中放置 Token、tenantId 或个人字段。首版前端不直接暴露导出按钮，AI 必须使用上述标准 MCP 两阶段工具。

## 6. 性能、索引与验收

- API 目标：正常租户数据规模下 P95 ≤ 2 秒、P99 ≤ 5 秒；失败必须关闭，禁止返回部分旧缓存冒充完整结果。
- 固定查询使用租户前缀索引；新增索引按 [管理分析索引迁移运行手册](./08-analytics-index-migration-runbook.md) 追加上线并核对 explain。
- 验收包括：跨租户隔离、非法日期、零分母、缺数据、新鲜度、字段泄漏、官方 MCP Client 发现/调用、375px/768px/桌面可用性、键盘与读屏、性能预算和审计证据。
- OP 沙箱数据覆盖、生产规模压测与管理层指标签字完成前，本切片保持“内部预验收”，不得宣称生产验收完成。
