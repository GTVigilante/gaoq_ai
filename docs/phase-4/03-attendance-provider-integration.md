# Phase 4 钉钉/飞书考勤 Provider 接入

## 交付边界

考勤 Provider 链路采用 `Adapter -> 加密 Inbox -> EvidenceVerifier -> 版本化 Normalizer -> AttendanceApplicationService`。适配器不访问业务数据库，Worker 不直接创建源事实记录，最终写入始终复用 Attendance 应用服务及其幂等、Outbox 和审计边界。

已交付能力：

1. 复用 `integration_org_platform_bindings` 的租户级平台绑定、Secret Manager 引用和短期令牌缓存，不复制 `clientSecret` 或访问令牌。
2. 钉钉按最多 50 人、最多 7 个自然日调用实际打卡记录接口；飞书按最多 50 人调用 `attendance/v1/user_tasks/query`。当前实现保守使用每请求 20 人、每个 Worker 轮次 100 个映射，并把员工分页位置与日期窗口一起加密进游标，避免大租户单任务失控。HTTP 客户端固定域名、禁止重定向、8 秒超时、256 KiB 响应上限，401 只刷新一次令牌。
3. 每个外部事件先以 Attendance 独立密钥加密写入 `integration_attendance_provider_inbox`。外部事件 ID、员工 ID 均不明文落库，分别使用事件域和员工域 HMAC 盲索引。
4. Provider 请求 ID 只保留 SHA-256 指纹；原值与原始 Provider 记录位于 AES-256-GCM 密文中。Worker 校验密文上下文、请求 ID 指纹、Provider envelope、Normalizer 版本和唯一员工映射后才进入业务域。
5. 补拉游标使用密文保存。整批所有员工、所有 Inbox 写入成功后才推进；任一员工无权限、映射缺失、响应缺少请求 ID或 Schema 漂移均失败关闭。
6. 首次平台开户成功时，在同一 MongoDB 事务中建立 ERP 员工到平台员工 ID 的加密映射，并创建默认 `disabled` 的 Provider 同步状态。运维完成时区、权限和沙箱验收后才可激活。
7. 每分钟扫描到期状态，5 分钟轮询；日期窗口保留一天重叠，通过 Inbox 和 Attendance 双层幂等抵御重放。失败任务指数退避，证据/标准化/员工映射异常进入人工复核。

## Provider 契约

| 项目 | 钉钉 | 飞书 |
| --- | --- | --- |
| 读取对象 | 实际打卡记录 | 上班/下班打卡结果 |
| Endpoint | `POST https://oapi.dingtalk.com/attendance/listRecord` | `POST https://open.feishu.cn/open-apis/attendance/v1/user_tasks/query` |
| 鉴权 | `access_token` 敏感查询参数 | `Authorization: Bearer tenant_access_token` |
| 单批员工上限 | 50 | 50 |
| 时间窗口 | 最多 7 个自然日，当前只支持 `Asia/Shanghai` | 最多 7 个自然日，显式 IANA 时区用于 ERP 业务日 |
| Normalizer 版本 | `dingtalk-list-record-v1` | `feishu-user-task-v1` |
| 事实类型 | `OnDuty -> punch_in`，`OffDuty -> punch_out` | `check_in_record -> punch_in`，`check_out_record -> punch_out` |

飞书契约以官方 Node SDK 的 `attendance.userTask.query` 类型和官方考勤文档为准：[官方 Node SDK](https://github.com/larksuite/node-sdk)、[飞书考勤统计说明](https://open.feishu.cn/document/server-docs/attendance-v1/user_stats_data/attendance-statistic-reference)。钉钉当前实际打卡接口由官方开放平台契约约束：[钉钉 API 文档](https://developer.alibaba.com/docs/api.htm?apiId=37094)。上线时必须使用 API 调试台为目标企业重新导出并归档响应 fixture，禁止只依赖本文档。

Provider 的拉取响应不提供可验证的业务数字签名，因此这里的 EvidenceVerifier 验证的是“固定域名 TLS + 租户应用令牌 + 平台请求 ID + 严格响应 Schema”的传输证据，不声称为电子签名。若改为 Webhook，必须另建验签/解密入口和独立 Inbox，不得复用拉取证据语义。

## 数据与安全约束

- `tenantId` 只来自队列记录对应的受信任系统上下文；队列载荷会以固定 Schema 校验，但不作为授权来源。
- 员工映射必须由平台开户事务创建，禁止按手机号、邮箱、姓名或工号模糊关联。
- Provider 原始位置、Wi-Fi、设备、照片、备注等字段只存在加密 Inbox，Normalizer 不复制到 Attendance 源事实、Outbox、日志或 MCP。
- 单条 `punch_in/punch_out` 的分钟影响固定为零。工时、迟到、早退、跨天和缺勤由 `01-attendance-implementation.md` 的版本化班次规则计算，禁止在 Provider Adapter 中写死薪资口径。
- Registry 要求钉钉和飞书的 Adapter、Normalizer、EvidenceVerifier 三者同时存在；缺一即应用启动失败。
- MCP 不暴露 Provider 补拉、游标、员工映射或 Inbox 工具；AI 只能使用 Attendance 应用服务提供的本人汇总与标准修订申请。

## 生产 Go/No-Go

当前结论：`No-Go`。代码、静态测试和索引迁移清单完成不等于真实集成可用。生产激活前必须逐租户完成：

1. 在钉钉/飞书沙箱验证目标权限、50 人分批、7 日边界、时区、离职员工、无权限员工、401 刷新、429/5xx 退避和请求 ID Header。
2. 将经脱敏的官方响应 fixture 固化为契约测试，确认 Provider Schema 与当前 Normalizer 版本一致。
3. 在真实 MongoDB Replica Set 完成 Provider 独立索引 dry-run/apply 和唯一键冲突检查。
4. 对同一日期执行首次补拉、重叠补拉、失败重试和 Worker 崩溃恢复，证明不重复形成源事实且游标不越过失败批次。
5. 核对平台员工 ID 与 ERP 员工映射抽样，任何一对多、多对一或未绑定均不得激活。
6. 完成来源数量/时间水位线/人工复核队列的日对账和告警后，才可把对应状态从 `disabled` 改为 `active`。
