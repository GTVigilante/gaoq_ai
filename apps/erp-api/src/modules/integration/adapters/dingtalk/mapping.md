# 钉钉适配器字段映射

- 权威方向：组织/员工 `ERP → 钉钉`；身份 `钉钉认证 → ERP 裁决`；原始考勤
  `钉钉 → ERP`；通知和招聘日历 `ERP → 钉钉`。
- 实现：
  `dingtalk-org-push.adapter.ts`、`attendance-provider.adapter.ts`、
  `../../../identity/dingtalk-sso.adapter.ts`、
  `../../../approval/notification/dingtalk-approval-notification.adapter.ts`、
  `dingtalk-recruitment-calendar.adapter.ts`。
- 外部验收：真实企业租户、权限、限流、回执和对账仍待完成。

## 组织与员工

| Canonical 字段 | 钉钉字段 | 方向/约束 |
| --- | --- | --- |
| `departmentId` | `source_identifier` | 创建时写入，作为失败恢复的确定性关联 |
| `name` | `name` | ERP 权威，1:1 下发 |
| `parentExternalId` | `parent_id` | 根部门固定为 `1` |
| `sortOrder` | `order` | ERP 权威整数 |
| `currentExternalId` | `dept_id` | 更新时使用，不接受业务输入改写 |
| `externalUserId` | `userid` | 私密开户通道派生并回读校验 |
| `displayName` | `name` | ERP 权威 |
| `employeeNo` | `job_number` | ERP 权威；开户回读必须完全一致 |
| `departmentExternalIds` | `dept_id_list` | ERP 部门映射结果，逗号拼接 |
| `contact.mobile.subscriberNumber` | `mobile` | 仅 15 分钟私密开户 Worker 内存使用 |
| `contact.mobile.countryCode` | `state_code` | 去掉前导 `+`；不得进入通用 Outbox |
| `contact.email` | `email` | 可选；不得进入日志、MCP 或普通幂等响应 |
| 固定策略 | `hide_mobile=true` | 禁止由调用方覆盖 |

## SSO

| 钉钉字段 | ERP canonical 字段 | 约束 |
| --- | --- | --- |
| Token `corpId` | `externalTenantId` | 必须等于服务端 state 绑定的预期企业 |
| Profile `unionId` | `unionId` | 与 `openId` 联合解析已绑定身份 |
| Profile `openId` | `loginOpenId` | 与通讯录 `userid` 分栏；首次可信扫码由同一 `corpId + unionId` 原子登记，后续必须精确匹配 |
| Profile `nick` | `displayName` | 仅显示，不授予角色或组织权限 |
| `accessToken` | 无持久化映射 | 只在固定钉钉域名请求期间短暂使用 |

## 考勤、通知与日历

| ERP/钉钉字段 | Canonical 字段 | 约束 |
| --- | --- | --- |
| `record.id` | `externalEventId` | 原始事件幂等标识 |
| `record.userId` | `externalEmployeeId` | 经双向员工映射解析，不直接当 ERP employeeId |
| `record.userCheckTime` | `occurredAt` | 毫秒 epoch，严格落在拉取窗口 |
| `record.checkType=OnDuty/OffDuty` | `factType=punch_in/punch_out` | 白名单枚举 |
| `processQueryKey` | `externalMessageId` | 审批通知最小回执 |
| `instanceId` | 文本模板参数 | 仅固定模板，不透传自定义富文本 |
| `startsAt/endsAt/timezone` | `start/end.dateTime/timeZone` | 招聘日历固定忙碌事件 |
| `location` | `location.displayName` | 仅专用 Worker 读取，不进入 Outbox |
| `attendeeExternalIds[]` | `attendees[].id` | 来自已绑定平台身份 |
| `idempotencyKey` | `x-client-token` | SHA-256 派生 UUID，不含业务正文 |
