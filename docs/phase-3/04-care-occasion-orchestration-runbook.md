# 生日与入职周年关怀运行手册

## 交付与外部验收边界

代码已交付生日证明盲索引、本人偏好与退订、时区/闰日/复聘策略、事务任务与
Outbox、BullMQ 周期对账和投递、Ed25519 签名回执、锁恢复、退避/死信/显式重放、
追加索引、指标、REST 与只读 MCP。真实通知沙箱、渠道授权目录、生产等价故障演练
和员工 UAT 仍须现场执行；未取得这些证据前不得宣称生产完成。

## 必需配置

- `ORG_PERSON_BIRTHDAY_BLIND_INDEX_KEYS`：独立 HMAC-SHA256 密钥环，一把
  `active`、最多四把 `lookup_only`，禁止复用招聘、考勤、资金或审计密钥。
- `CARE_OCCASION_POLICIES_JSON`：按租户唯一配置策略版本、IANA 时区、发送时间、
  静默时段、闰日口径、复聘口径、生日/周年模板编码和最大尝试次数。
- `CARE_OCCASION_NOTIFICATION_ENDPOINT`、独立 Bearer Token、Ed25519 SPKI DER
  base64 公钥和 Key ID 必须成套配置。端点必须是独立标准 HTTPS 域名根地址。

生产 Secret 只由 Secret Manager 注入，禁止进入仓库、日志、证据包或 MCP。
API 的 Secret/ConfigMap 必须注入生日盲索引密钥环和租户策略；Worker 另须注入
通知网关全套配置。通知网关解析出的已审批公网 CIDR 还必须加入 Helm
`networkPolicy.httpsEgressCidrs`，禁止用全网段放行代替精确出口审批。

## 发布顺序

1. 在影子库执行 `migrate:phase3:care-occasion-indexes -- --dry-run`，审核 checksum、
   缺失索引和所有唯一键重复。
2. 完成快照与变更审批后执行 `migrate:phase3:care-occasion-indexes`，确认
   `verified` 等于清单总数且迁移记录为 `completed`。
3. 先以一个非生产租户注入策略、盲索引密钥和通知沙箱配置，再启动 API 与 Worker。
4. 身份服务通过 `POST /org/persons/:id/birthday-attestations` 登记证明；请求必须
   使用服务身份、强 `If-Match` 和 `Idempotency-Key`，任何响应/审计不得出现月日。
5. 员工本人创建偏好后，确认 `scheduled` 事件与任务同事务形成，BullMQ 投递只含
   `tenantId/occasionTaskId`，空载荷周期对账存在且无重复业务任务。
6. 执行 `pnpm quality:org-care-occasion-source-coverage`，确认内部窄口只接受同租户
   `service/system_job`，且 Employee、当前 Employment、Person、唯一开放关系、
   复聘历史和生日证明三元组的完整性门禁四维覆盖率均不低于 90%。

## 沙箱验收矩阵

- 时区：UTC±12/14、跨年、夏令时存在/缺失时刻；静默时段冲突必须失败关闭。
- 日期：普通生日、2 月 29 日按 `feb28/mar01` 两种口径；当前复聘段与最初任职
  两种周年口径。
- 身份：普通用户持有内部 Scope、跨租户、伪造 employeeId、当前劳动关系错位、
  Person 缺失、多个开放关系、复聘历史损坏、停职/离职、生日更正、证明与盲索引
  不成套及盲索引密钥轮换均须覆盖；数据损坏不得被误判为正常离职并取消待发任务。
- 偏好：未配置、单类型关闭、渠道清空、全局退订、版本冲突、并发更新。
- 可靠性：重复/乱序事件、Worker 在抢占后崩溃、通知超时、外部成功后本地提交失败、
  签名/Key ID/控制摘要/渠道错配、达到上限进入 dead、审批后显式重放。
- 隐私：数据库任务、Outbox、队列、日志、审计、指标、MCP 均不得出现完整生日、
  月日明文、联系方式、通知正文、模板内容或送达证据。

## 观测、告警与恢复

- `gaoq_care_occasion_transition_total{operation,outcome}`：关注 `retry/dead` 增长。
- `gaoq_care_occasion_dispatch_duration_seconds{outcome}`：监控 P95/P99 与网关 SLA。
- `gaoq_care_occasion_backlog{status}` 和
  `gaoq_care_occasion_oldest_age_seconds{status}`：pending 最老年龄超过 15 分钟、
  dispatching 超过锁租期或 dead 非零立即告警。
- 对账只由空载荷周期任务触发并从服务端租户注册表枚举；不得让队列或 MCP 指定扫描
  范围。锁超时先恢复为 pending，再使用原稳定幂等键调用网关。
- 先执行只读对账：
  `pnpm --filter @gaoq/erp-api reconcile:phase3:care-occasions`。它只输出状态计数、
  过期任务、陈旧锁、终态组合、重复自然键/送达证据、孤儿偏好和近 29 天缺失事件，
  不修改数据库。
- dead 重放必须先确认根因、偏好仍有效、主数据摘要与策略未漂移，并在变更单中记录
  受控原因码。先使用
  `replay:phase3:care-occasion -- --dry-run --tenant-id ... --task-id ... --expected-version ... --reason-code ...`
  复核，再经审批改用 `--apply`；重放与 `replayed` Outbox 事件同事务提交，周期对账
  负责恢复固定队列任务。应用内重放仅允许 `erp:care:occasion:operations` 身份；
  AI 不提供重放 Tool。

## MCP

只读能力固定为 `care_occasion_summary_get_self`、
`erp://care/occasions/mine` 和 `care_occasion_summary_guide`。输出只有关怀开关及
pending/delivered/dead 计数；不得返回具体日期、员工引用、渠道、联系方式、模板、
正文或证据，也不得直接调用 Org 关怀来源窄口或提供修改偏好、退订、发送、渠道
授权、对账或重放能力。
