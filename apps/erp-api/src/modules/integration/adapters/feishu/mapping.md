# 飞书适配器字段映射

- 权威方向：组织/员工 `ERP → 飞书`；身份 `飞书认证 → ERP 裁决`；原始考勤
  `飞书 → ERP`；通知和招聘日历 `ERP → 飞书`。
- 实现：
  `feishu-org-push.adapter.ts`、`attendance-provider.adapter.ts`、
  `../../../identity/feishu-sso.adapter.ts`、
  `../../../approval/notification/feishu-approval-notification.adapter.ts`、
  `feishu-recruitment-calendar.adapter.ts`。
- 外部验收：真实企业租户、应用权限、限流、日历绑定和组织对账仍待完成。

## 组织与员工

| Canonical 字段 | 飞书字段 | 方向/约束 |
| --- | --- | --- |
| `departmentId` | `department_id` | 创建时使用 ERP 稳定标识 |
| `name` | `name` | ERP 权威 |
| `parentExternalId` | `parent_department_id` | 根部门固定为 `0` |
| `managerExternalId` | `leader_user_id` | 仅已绑定平台身份 |
| `sortOrder` | `order` | 规范整数转十进制字符串 |
| `externalUserId` | `user_id` | 私密开户通道派生并回读校验 |
| `displayName` | `name` | ERP 权威 |
| `employeeNo` | `employee_no` | ERP 权威；开户回读必须完全一致 |
| `departmentExternalIds` | `department_ids` | ERP 部门映射结果 |
| `contact.mobile` | `mobile` | 仅私密开户 Worker 使用 |
| `contact.email` | `email` | 可选；不得进入通用 Outbox、日志或 MCP |
| `idempotencyKey` | `client_token` | SHA-256 派生，不含业务正文 |

## SSO

| 飞书字段 | ERP canonical 字段 | 约束 |
| --- | --- | --- |
| `tenant_key` | `externalTenantId` | 必须等于服务端 state 绑定的预期企业 |
| `union_id` | `unionId` | 与 `user_id` 联合解析已绑定身份 |
| `user_id` | `externalUserId` | 不使用手机号、邮箱或 `open_id` 自动合并 |
| `name` | `displayName` | 仅显示，不覆盖 ERP 主档 |
| `access_token` | 无持久化映射 | 只在固定飞书域名请求期间短暂使用 |

## 考勤、通知与日历

| 飞书字段 | Canonical 字段 | 约束 |
| --- | --- | --- |
| `user_task_results[].user_id` | `externalEmployeeId` | 经员工映射解析 |
| `check_in_record/check_out_record.check_time` | `occurredAt` | 秒 epoch，严格验证拉取窗口 |
| `check_in_record_id/check_out_record_id` | `externalEventId` 的组成 | 与结果 ID、方向和槽位共同生成 |
| `message_id` | `externalMessageId` | 审批通知最小回执 |
| `receive_id` | 通知接收者外部标识 | 必须来自已绑定身份 |
| `notificationId` | `uuid` | 平台侧通知去重 |
| `startsAt/endsAt/timezone` | `start_time/end_time` | 招聘日历固定私密忙碌事件 |
| `location` | `location.name` | 仅专用 Worker 读取，不进入 Outbox |
| `attendeeExternalIds[]` | `attendees[].user_id` | 参与人权限固定为不可转邀 |
| `idempotencyKey` | `idempotency_key` | SHA-256 派生 UUID |
