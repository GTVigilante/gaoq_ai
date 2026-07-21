# Phase 4 考勤与薪酬强制契约

## 1. 权威模型与聚合

| 聚合/记录 | 权威模块 | 不变量 |
| --- | --- | --- |
| `AttendanceSourceEvent` | Attendance | 供应商原始事实加密、追加写；租户/平台/外部事件盲指纹唯一 |
| `AttendanceDay` | Attendance | 由原始事实和有效修订投影；业务日期绑定 Employment 工作地 IANA 时区 |
| `AttendanceCorrection` | Attendance + Approval | 必须保存前后摘要、原因、申请人、审批实例与决定；不得改原始事实 |
| `AttendanceMonthlySnapshot` | Attendance | 员工/月/版本唯一；固化来源水位线、规则版本、日摘要、总计和 SHA-256 |
| `CompensationProfileVersion` | Payroll | 员工薪酬结构 L4 加密；生效区间不得重叠；审批后不可改 |
| `StatutoryRulePack` | Payroll | 税、社保、公积金、舍入与地区参数版本化，带来源与生效区间 |
| `PayrollPeriod` | Payroll | 一个租户与工资月只有一个活动主周期；状态、版本、锁和审批强约束 |
| `PayrollCalculationRun` | Payroll | 引用冻结输入与规则；相同规范输入产生相同步骤和结果哈希 |
| `Payslip` | Payroll | 只引用锁定计算结果；员工只能读取本人，明细按字段策略解密 |
| `DisbursementBatch` | Treasury | 只从已锁定周期形成；文件摘要、行数、总额、双人导出和对象证据齐全 |
| `BankReturnInbox` | Treasury | 验签/解密后入箱，原始文件受控归档；匹配不唯一或部分成功冻结批次 |
| `PayrollReconciliation` | Payroll + Treasury + Tax | 应发、代发、回盘、个税四方金额与人数逐项守恒 |

所有集合、缓存键、对象键、队列任务、事件和审计必须从已验证身份或系统任务取得 `tenantId`。客户端提交的租户、员工、金额汇总、审批结果或银行状态均不可信。

## 2. 状态机

考勤月结：

```text
collecting → reconciling → review → closing → closed
     ↑            │          │
     └──补拉──────┘          └→ correction_pending → review
```

- `closed` 快照不可修改。迟到数据或批准修订必须创建更高版本快照，并显式使旧快照 `superseded`。
- 关闭前必须完成来源水位线追平、重复/缺失/跨天异常处理和 Employment 有效性核对。

工资周期：

```text
draft → collecting → calculating → review → pending_approval → approved → locked
                                                                    │
                                                                    ↓
                                                        disbursing → reconciling → reconciled
```

- `approved` 只表示审批通过；`locked` 必须由不同于制单人与审批人的财务锁定人完成二次认证。
- `locked` 后任何人员、考勤、规则或薪酬输入变化都不得原地重算；必须创建新计算版本并重新审批，或在已发放后创建关联补发/扣回子批次。
- 银行回盘出现部分成功、未知行、重复行、总额不守恒或签名失败时进入 `reconciling` 冻结，不得自动把周期标为 `reconciled`。

## 3. 金额与确定性计算

- 货币值使用 ISO 4217 币种 + 安全整数分，首期只启用 `CNY`。禁止 `number` 浮点乘除工资金额；计算内核使用整数、`bigint` 或经审计的定点实现。
- 比率使用整数基点；除法必须在规则步骤声明分母、舍入模式和舍入时点。首期统一支持 `HALF_UP`，但每条法定规则仍须显式记录。
- 个人累计预扣至少固化：税年、累计收入、累计专项扣除、累计专项附加扣除、累计其他扣除、累计减除费用、累计已预扣税、税率表版本和本期应补退税。本期税额允许为负表示受控退税调整，但累计已扣税不得为负。
- 每个计算步骤保存 `code / inputDigest / ruleVersion / amountMinor / roundingMode / sequence`；结果哈希使用规范 JSON 的 SHA-256。相同输入快照、规则包和引擎版本必须逐分、逐步骤、逐哈希一致。
- 不得从当前组织或当前薪酬主档重放历史工资；所有计算必须引用当期冻结的 Employment、考勤、薪酬、绩效、扣款和法定规则快照。
- 负应发、负实发、超出安全整数、税额大于计税基础、扣款超过政策上限、人数/金额不守恒均失败关闭并进入人工复核。

## 4. 隐私、权限与双人控制

- 薪酬结构、工资明细、银行账号、证件、税务文件为 L4，使用 Payroll 独立 AES-256-GCM 密钥域；AAD 绑定租户、资源类型、资源 ID 与版本。银行账号精确匹配使用独立 HMAC 盲索引。
- 本人只读自己的已发布薪资单；直属经理默认不得读取个人工资。HR、薪酬、财务、审计和管理层分别使用服务端字段白名单与行级范围，不能依赖前端隐藏。
- 制单、复核、审批、锁定、导出、上传回盘、解除冻结不能由同一主体独占。R2/R3 操作强制近期 MFA、强 `If-Match`、幂等键、目的和审计。
- 导出使用短期单次下载、受控对象存储和水印；审计只记批次、字段策略、行数、摘要和操作者，不记工资、账号或文件正文。

## 5. 外部集成

### 5.1 钉钉/飞书考勤

- Adapter 只提供水位线补拉、Webhook 验签、原始事件标准化和对账摘要；不直接写月结或薪资集合。
- Webhook 先验签并加密入 Inbox；外部事件 ID 使用渠道隔离盲指纹去重。补拉游标加密，任务按租户/绑定隔离并支持失败显式重放。
- 统一时间模型保存供应商原始时刻、UTC 时刻、IANA 时区、业务日期和跨天归属规则；不得从服务器默认时区推导考勤日。
- 请假、加班和出差审批事实只从 ERP Approval 或经绑定验证的外部审批映射进入，不接受客户端自报“已批准”。

### 5.2 银行、税务与对象存储

- 银行/税务 Adapter 使用版本化文件契约；正文 L4 加密并写独立 WORM/受控对象存储，Mongo 只保存摘要、对象引用、行数、总额和回执。
- 代发文件必须在双人确认后生成，批次幂等键绑定租户、周期、锁定计算版本、银行格式版本和文件摘要。
- 回盘先验签/解密/病毒扫描再解析；禁止公式注入、路径穿越、压缩炸弹和 CSV 单元格执行。未知状态或格式版本进入人工复核。
- 税务申报文件与回执不得驱动工资金额反写；差异生成独立调整请求并重新审批。

## 6. REST、事件、MCP 与审计同步交付

| 用例 | REST | 事件 | MCP | 风险 |
| --- | --- | --- | --- | --- |
| 查询本人考勤月结 | `GET /attendance/months/{month}/me` | 无 | Resource + `attendance_month_get` | R0 |
| 提交考勤修订请求 | `POST /attendance/correction-requests` | `attendance.correction.requested.v1` | `attendance_correction_prepare/execute`，只形成请求 | R1 |
| 关闭考勤月份 | 内部月结命令 | `attendance.month.closed.v1` | 不开放 | R2 |
| 查询本人薪资单 | `GET /payroll/payslips/{period}/me` | 无 | Resource + `payroll_payslip_get`，默认脱敏 | R0 |
| 计算/重算工资 | 内部 Worker 命令 | `payroll.run.completed/failed.v1` | 不开放 | R2 |
| 审批与锁定工资 | Approval + 内部命令 | `payroll.period.approved/locked.v1` | 只读状态，不开放执行 | R2/R3 |
| 受控聚合分析 | `POST /payroll/analytics` | 无 | `payroll_aggregate_analyze`，最小分组阈值 | R1 |
| 生成代发/处理回盘 | Treasury 内部端点 | `treasury.batch.*.v1` | 不开放 | R3 |

MCP Server 必须继续使用 MCP 2025-11-25、OAuth 2.1 Resource Server、JSON Schema、结构化内容、风险注解和审计。任何 AI 客户端都只能通过应用服务读取脱敏投影；禁止 MCP 直接查数据库、接触银行/税务文件、执行发薪或绕过 Approval。

## 7. 测试、SLO 与 Go/No-Go

- 黄金数据集覆盖跨年、月中入离职、试用转正、补发扣回、零薪资、封顶/保底、累计预扣、舍入边界和负值拒绝，必须逐分一致。
- 性质测试至少验证确定性、步骤守恒、总额守恒、重放一致、乱序隔离和跨租户不可见；敏感字段泄漏扫描覆盖日志、事件、MCP、错误和导出元数据。
- 月结/工资计算 Worker 崩溃、重复事件、迟到数据、银行部分成功、回盘重复、规则回滚和对象存储不可用必须可恢复且不产生第二次发薪。
- 两个完整工资周期人员覆盖率、应发覆盖率和金额覆盖率均为 100%；所有差异必须归类、解释、修正并由薪酬与财务双签，未解释差异必须为零。
- 任一浮点工资计算、未版本化规则、无快照重算、越权明细、单人发薪、可修改锁定结果、银行总额不守恒或 MCP 直接发薪能力均为 No-Go。
