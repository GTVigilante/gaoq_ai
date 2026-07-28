# Phase 4 考勤事实、修订与月结实现

## 已交付边界

本纵切实现六类不可变记录：

1. `attendance_source_facts`：受信任 `service/system_job` 使用 `erp:attendance:source:ingest` 追加写。外部事件 ID 只形成租户与 Provider 域隔离的 HMAC 盲指纹，发生时刻、IANA 时区和分钟影响使用 Attendance 独立 AES-256-GCM 密钥域加密。
2. `attendance_corrections`：只接纳 Approval 中 `attendance_correction` 模板的 `approved` 终态。员工、业务日期从源事实反查，替换影响和原因码加密；源事实永不更新。
3. `attendance_monthly_snapshots`：员工/月/版本唯一。逐日摘要加密，总计、规则版本、来源截止点和 SHA-256 快照哈希固化。重开必须由 `attendance_month_reopen` 审批授权，新版本激活后旧版本仅改为 `superseded`。
4. `attendance_shift_rules`：受信任治理服务登记版本化班次。班次代码、IANA
   时区、上下班本地时间、ISO 工作日、计划分钟、迟到/早退宽限、跨天签退宽限、
   有效期与治理证据摘要均不可变。
5. `attendance_shift_assignments`：员工排班只引用已登记规则，必须完整落在唯一
   `Employment` 有效区间和规则有效区间内；同一员工的有效区间不得重叠。
6. `attendance_provider_coverages`：Provider 状态、员工映射、月份、已完整覆盖的
   业务日、截止时间和确定性摘要共同形成覆盖证明，不保存游标密文或外部员工 ID。

考勤业务日期只使用事件 UTC instant 与权威班次的显式 IANA 时区计算。跨天
`punch_out` 只有位于前一业务日夜班的结束时间与受控宽限内才归属前日；普通白班
不跨日归属。月结同时按上游观测时间、ERP 落库时间、审批完成时间和修订登记时间
裁剪，并验证 `Employment`、排班、规则版本、完整 Provider 水位线和零未决 Inbox。
单条 Provider 打卡的分钟影响保持为零，工作、迟到、早退与缺勤分钟只由本规则
纵切推导。任何迟到事实或迟到修订只能通过审批后的更高版本快照进入。

## 接口、事件、审计与 MCP

| 能力 | REST / 内部契约 | CloudEvent | 审计 | MCP |
| --- | --- | --- | --- | --- |
| 追加源事实 | `POST /attendance/source-facts` | `cn.gaoq.erp.attendance.source_fact.ingested.v1` | R1，只有标识、Provider、类型、业务日 | 不开放 |
| 发起本人修订审批 | `POST /attendance/correction-requests` | `cn.gaoq.erp.attendance.correction.requested.v1` | R1，不记原因和分钟 | `attendance_correction_prepare/execute` |
| 登记已批准修订 | `POST /attendance/corrections` | `cn.gaoq.erp.attendance.correction.approved.v1` | R2，不记原因和分钟 | 不开放直接写 |
| 登记班次规则 | `POST /attendance/shift-rules/attest` | `cn.gaoq.erp.attendance.shift_rule.attested.v1` | R2，只记版本、班次代码和有效期 | 不开放 |
| 登记员工排班 | `POST /attendance/shift-assignments/attest` | `cn.gaoq.erp.attendance.shift_assignment.attested.v1` | R2，只记员工、规则、Provider 和有效期 | 不开放 |
| 对账 Provider 覆盖 | `POST /integrations/attendance-provider-coverages/reconcile` | 每名员工产生 `cn.gaoq.erp.attendance.provider_coverage.reconciled.v1` | R2，只记状态、月份、水位和数量 | 不开放 |
| 首次关账/审批重开 | `POST /attendance/months/close` | `attendance.month.closed.v1` / `attendance.month.superseded.v1` | R2，记录版本与哈希 | 不开放 |
| 查询本人月结 | `GET /attendance/months/{month}/me` | 无 | R0 敏感读取审计 | Resource `erp://attendance/months/{month}/me`、Tool `attendance_month_get` |

MCP 使用当前 OAuth 身份反查 `AccessProfile.employeeId`，不接受租户或员工参数；
返回月度汇总、规则版本、来源截止点和快照哈希，不返回打卡时刻、地点、设备、
逐日明细、修订原因或审批正文。所有 MCP 读取复用
`AttendanceApplicationService`，没有数据库访问路径。班次规则、排班、Provider
水位线对账和月结均为 R2/R3 管理动作，标准 MCP 不注册对应写 Tool；AI 只能读取
已关闭快照或准备本人修订审批。

修订申请创建和提交 `attendance_correction` 专用 Approval。MCP 先校验源事实属于当前 `AccessProfile.employeeId`，再把源事实 ID、四类替换分钟和受控原因码固化到服务端确认账本；只有 ERP 浏览器确认产生的一次性凭据可以执行。Attendance 登记端不接受修订分钟或原因入参，只从已通过审批的加密表单读取强类型决定，并再次核对源事实员工与业务日。月结重开同样核对审批正文中的员工、月份和前序快照 ID。

## Scope 与职责边界

- `erp:attendance:source:ingest`：仅受信任考勤 Adapter 服务身份。
- `erp:attendance:rule:attest`：仅受信任规则治理服务身份。
- `erp:attendance:shift_assignment:attest`：仅受信任排班治理服务身份。
- `erp:attendance:provider:reconcile` + `erp:attendance:coverage:attest`：Provider
  对账任务必须同时持有，缺一失败关闭。
- `erp:attendance:correction:attest` + `erp:attendance:approval:sync`：审批终态同步任务。
- `erp:attendance:month:close`：月结编排任务；重开还必须有专用审批实例。
- `erp:attendance:month:read_self`：员工本人汇总读取。

服务身份的 `tenantId` 必须由签发后的身份上下文提供。任何请求体、Header、队列载荷中的租户值都不是授权来源。

## 失败关闭与运行顺序

1. 先登记不可变班次规则，再登记完整落在 `Employment` 与规则有效期内的员工排班；
   同一员工的排班登记必须先在事务内递增并发守卫，再执行重叠查询，禁止不同
   幂等键通过快照隔离产生区间 write skew。
2. Provider 补拉必须完成到月份末日，且 Provider 本地时区下月末之前的 Inbox
   全部为 `completed`，才允许分页生成每名活动映射员工的覆盖证明。
3. 月结读取月份与次月首日候选事实，在同一 MongoDB 会话内读取劳动关系、规则、
   排班和截止点之前的覆盖证明；缺失、重叠、越界、篡改、时区错配、未成对打卡
   或超出截止时间均失败关闭。
4. 规则、排班、排班并发守卫和覆盖证明索引使用追加迁移
   `phase-4-attendance-rules-indexes-v2`，执行步骤见
   `20-attendance-rules-index-migration-runbook.md`。

## 当前明确未完成

- 钉钉/飞书增量补拉、加密 Inbox、水位线、规则计算与覆盖对账代码已实现；真实
  Provider 沙箱证据未取得前保持禁用和 No-Go。
- 没有真实 Provider 沙箱和真实 MongoDB Replica Set 时，只能完成代码门禁与
  迁移 dry-run，不能签署生产 Go。
