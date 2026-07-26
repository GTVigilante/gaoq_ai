# Phase 4 考勤事实、修订与月结实现

## 已交付边界

本纵切实现四类不可变记录：

1. `attendance_source_facts`：受信任 `service/system_job` 使用 `erp:attendance:source:ingest` 追加写。外部事件 ID 只形成租户与 Provider 域隔离的 HMAC 盲指纹，发生时刻、IANA 时区和分钟影响使用 Attendance 独立 AES-256-GCM 密钥域加密。
2. `attendance_shift_plans`：受信任排班服务按外部计划盲指纹追加版本化日班次。开始/结束 UTC instant、IANA 时区、休息、宽限和打卡捕获窗口加密；捕获窗口不得重叠。
3. `attendance_corrections`：只接纳 Approval 中 `attendance_correction` 模板的 `approved` 终态。员工、业务日期从源事实反查，替换影响和原因码加密；源事实永不更新。
4. `attendance_monthly_snapshots`：员工/月/版本唯一。逐日摘要加密，总计、规则版本、来源截止点、Provider 数量、水位摘要和 SHA-256 快照哈希固化。重开必须由 `attendance_month_reopen` 审批授权，新版本激活后旧版本仅改为 `superseded`。

考勤业务日期只使用事件 UTC instant 与显式 IANA 时区计算。跨日班次固定归属开始业务日；早到晚退不自动形成加班，缺少任一打卡先派生整班缺勤，后续只能修订派生 `shift` 事实。独立 BullMQ Worker 每分钟扫描已超过“班次结束 + 晚退捕获窗口”的待计算计划，以稳定任务 ID 重试并在同一事务中固化派生事实检查点。月结同时按上游观测时间、ERP 落库时间、审批完成时间和修订登记时间裁剪；任何迟到事实或迟到修订只能通过审批后的更高版本快照进入。

## 接口、事件、审计与 MCP

| 能力 | REST / 内部契约 | CloudEvent | 审计 | MCP |
| --- | --- | --- | --- | --- |
| 追加日班次 | `POST /attendance/shift-plans` | `cn.gaoq.erp.attendance.shift_plan.assigned.v1` | R1，不记时间与窗口 | 不开放 |
| 计算班次结果 | `POST /attendance/shift-plans/{shiftPlanId}/evaluate` | `cn.gaoq.erp.attendance.shift.evaluated.v1` | R1，不记分钟与缺卡结果 | 不开放 |
| 追加源事实 | `POST /attendance/source-facts` | `cn.gaoq.erp.attendance.source_fact.ingested.v1` | R1，只有标识、Provider、类型、业务日 | 不开放 |
| 发起本人修订审批 | `POST /attendance/correction-requests` | `cn.gaoq.erp.attendance.correction.requested.v1` | R1，不记原因和分钟 | `attendance_correction_prepare/execute` |
| 登记已批准修订 | `POST /attendance/corrections` | `cn.gaoq.erp.attendance.correction.approved.v1` | R2，不记原因和分钟 | 不开放直接写 |
| 首次关账/审批重开 | `POST /attendance/months/close` | `cn.gaoq.erp.attendance.month.closed.v1` / `cn.gaoq.erp.attendance.month.superseded.v1` | R2，记录版本与哈希 | 不开放 |
| 查询本人月结 | `GET /attendance/months/{month}/me` | 无 | R0 敏感读取审计 | Resource `erp://attendance/months/{month}/me`、Tool `attendance_month_get` |

MCP 使用当前 OAuth 身份反查 `AccessProfile.employeeId`，不接受租户或员工参数；返回月度汇总、规则版本、来源截止点、Provider 数量、水位摘要和快照哈希，不返回打卡时刻、班次时间、地点、设备、逐日明细、修订原因或审批正文。所有 MCP 读取复用 `AttendanceApplicationService`，没有数据库访问路径。班次写入与计算只允许 `service/system_job`，不注册 MCP Tool，避免 AI 改排班或直接生成薪资事实。

修订申请创建和提交 `attendance_correction` 专用 Approval。MCP 先校验源事实属于当前 `AccessProfile.employeeId`，再把源事实 ID、四类替换分钟和受控原因码固化到服务端确认账本；只有 ERP 浏览器确认产生的一次性凭据可以执行。Attendance 登记端不接受修订分钟或原因入参，只从已通过审批的加密表单读取强类型决定，并再次核对源事实员工与业务日。月结重开同样核对审批正文中的员工、月份和前序快照 ID。

## Scope 与职责边界

- `erp:attendance:source:ingest`：仅受信任考勤 Adapter 服务身份。
- `erp:attendance:shift_plan:write`：仅受信任排班服务身份。
- `erp:attendance:shift:evaluate`：仅规则计算系统任务。
- `erp:attendance:correction:attest` + `erp:attendance:approval:sync`：审批终态同步任务。
- `erp:attendance:month:close`：月结编排任务；重开还必须有专用审批实例。
- `erp:attendance:month:read_self`：员工本人汇总读取。

服务身份的 `tenantId` 必须由签发后的身份上下文提供。任何请求体、Header、队列载荷中的租户值都不是授权来源。

## 关账硬门禁

- 每条事实和每个班次业务日必须落在 ERP `Employment.effectiveFrom/effectiveTo` 内；没有有效劳动关系或越界事实直接冲突。
- 员工已激活的 Provider 必须有非敏感 `committedThroughDate`，覆盖月末；跨日班次还必须覆盖其结束业务日。水位必须不晚于 `sourceCutoffAt`，当月 Inbox 不得存在 `pending/processing/failed/manual_review` 或截止点后才完成的记录。
- 月结规则版本必须与每个班次一致，每个班次必须存在唯一 `attendance_rules/shift` 派生事实；只有 Provider 打卡但没有班次、派生事实缺失或绑定错误均阻断月结。

## 当前明确未完成

- 钉钉/飞书增量补拉、加密 Inbox、水位线与 Adapter/Normalizer/EvidenceVerifier 注册表已实现，详见 `03-attendance-provider-integration.md`；真实 Provider 沙箱证据未取得前保持禁用和 No-Go。
- 没有真实 Provider 沙箱和真实 Replica Set 时，只能完成代码门禁与迁移 dry-run，不能签署生产 Go。
