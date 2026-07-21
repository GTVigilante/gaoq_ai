# Phase 4 考勤事实、修订与月结实现

## 已交付边界

本纵切实现三类不可变记录：

1. `attendance_source_facts`：受信任 `service/system_job` 使用 `erp:attendance:source:ingest` 追加写。外部事件 ID 只形成租户与 Provider 域隔离的 HMAC 盲指纹，发生时刻、IANA 时区和分钟影响使用 Attendance 独立 AES-256-GCM 密钥域加密。
2. `attendance_corrections`：只接纳 Approval 中 `attendance_correction` 模板的 `approved` 终态。员工、业务日期从源事实反查，替换影响和原因码加密；源事实永不更新。
3. `attendance_monthly_snapshots`：员工/月/版本唯一。逐日摘要加密，总计、规则版本、来源截止点和 SHA-256 快照哈希固化。重开必须由 `attendance_month_reopen` 审批授权，新版本激活后旧版本仅改为 `superseded`。

考勤业务日期只使用事件 UTC instant 与显式 IANA 时区计算。月结同时按上游观测时间、ERP 落库时间、审批完成时间和修订登记时间裁剪；任何迟到事实或迟到修订只能通过审批后的更高版本快照进入。

## 接口、事件、审计与 MCP

| 能力 | REST / 内部契约 | CloudEvent | 审计 | MCP |
| --- | --- | --- | --- | --- |
| 追加源事实 | `POST /attendance/source-facts` | `cn.gaoq.erp.attendance.source_fact.ingested.v1` | R1，只有标识、Provider、类型、业务日 | 不开放 |
| 登记已批准修订 | `POST /attendance/corrections` | `cn.gaoq.erp.attendance.correction.approved.v1` | R2，不记原因和分钟 | 不开放直接写 |
| 首次关账/审批重开 | `POST /attendance/months/close` | `attendance.month.closed.v1` / `attendance.month.superseded.v1` | R2，记录版本与哈希 | 不开放 |
| 查询本人月结 | `GET /attendance/months/{month}/me` | 无 | R0 敏感读取审计 | Resource `erp://attendance/months/{month}/me`、Tool `attendance_month_get` |

MCP 使用当前 OAuth 身份反查 `AccessProfile.employeeId`，不接受租户或员工参数；返回月度汇总、规则版本、来源截止点和快照哈希，不返回打卡时刻、地点、设备、逐日明细、修订原因或审批正文。所有 MCP 读取复用 `AttendanceApplicationService`，没有数据库访问路径。

修订申请使用现有 Approval 标准接口创建和提交 `attendance_correction` 模板；Attendance 的登记端只消费其可信终态。AI 若协助发起修订，必须采用服务端 prepare/execute 确认账本，不能调用本文件中的内部登记端。

## Scope 与职责边界

- `erp:attendance:source:ingest`：仅受信任考勤 Adapter 服务身份。
- `erp:attendance:correction:attest` + `erp:attendance:approval:sync`：审批终态同步任务。
- `erp:attendance:month:close`：月结编排任务；重开还必须有专用审批实例。
- `erp:attendance:month:read_self`：员工本人汇总读取。

服务身份的 `tenantId` 必须由签发后的身份上下文提供。任何请求体、Header、队列载荷中的租户值都不是授权来源。

## 当前明确未完成

- 钉钉/飞书 Webhook 验签、加密 Inbox、水位线补拉与 Adapter/Normalizer/EvidenceVerifier 注册表尚未进入本纵切。
- `attendance_correction_prepare/execute` 的 MCP 请求能力尚未交付；当前 MCP 仅提供 R0 本人月结读取。
- Employment 有效区间、班次规则、跨天归属和来源水位线对账仍需在 Attendance Adapter 纵切补齐。
- 没有真实 Provider 沙箱和真实 Replica Set 时，只能完成代码门禁与迁移 dry-run，不能签署生产 Go。
