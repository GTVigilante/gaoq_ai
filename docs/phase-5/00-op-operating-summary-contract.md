# OP 每日经营摘要垂直切片契约

- 文档编号：phase-5/00
- 版本：v1.0
- 状态：应用代码、REST、事件、MCP 与追加式索引迁移已实现；生产索引迁移、OP 沙箱联调和运行验收待完成
- 上位规范：[项目章程](../phase-0/00-program-charter.md)、[外部系统集成规范](../phase-0/03-integration-standard.md) §4/§9/§10、
  [MCP 服务规范](../phase-0/04-mcp-service-standard.md)、[安全质量与切换规范](../phase-0/05-security-quality-cutover.md)、[领域与数据规范](../phase-0/02-domain-data-standard.md)

---

## 1. 范围与权威方向

ERP 是组织与员工的**唯一主数据源**；OP 永远是外部系统，即使未来作为 SaaS 对外提供也不改变本契约。本切片只覆盖一件事：**OP 每日经营指标摘要经安全入站通道进入 ERP，供管理层只读展示**。

不在本切片范围（Phase 5 后续切片，各自独立契约）：

- OP 组织与人员下发管线（ERP→OP）；
- OP 审批桥（OP 单据发起 ERP 审批、结果回推）；
- 移动端；
- 管理驾驶舱与受控分析导出；
- 全量迁移工具与生产加固（断连演练、性能、容灾、切换预验收）。

## 2. 入站安全契约

- 唯一入口：`POST /webhooks/op/operating-summaries`，回调 URL 固定不带 query；经网关来源 IP 白名单后才进入验签。
- OP 使用**独立服务身份**，不共用钉钉/飞书凭据：每个 clientId 绑定独立 HMAC-SHA256 密钥，密钥只存 KMS/Secret Manager，按环境隔离，轮换周期 ≤180 天。
- 签名串为 `timestamp + "\n" + nonce + "\n" + eventId + "\n" + raw body bytes` 的 HMAC-SHA256；验签失败使用统一错误，不泄露失败细节。
- 请求时间戳窗口 ±5 分钟；`clientId + nonce` 的 SHA-256 摘要进入 Redis 去重缓存，TTL 24 小时；`tenantId + clientId + eventId` 由 Mongo 唯一索引作持久幂等。
- **租户解析只发生在验签通过之后**：按唯一 clientId→租户绑定关系解析 tenantId；禁止信任 URL、query、header 或 body 中的 tenantId。clientId 与租户一对一绑定，绑定建立与变更必须经安全负责人批准并留审计。

## 3. Inbox 与异步处理

- Webhook 只做三件事：验签、写 Inbox、返回 202；业务投影与摘要生成全部异步（BullMQ Worker）。
- 原始 body 字节以 AES-256-GCM 加密写入 Inbox，AAD 绑定 tenantId 与 Inbox ID；nonce 只保存 SHA-256 摘要；日志、事件、审计、MCP 禁止出现原始报文。
- 原始报文保留 90 天用于争议排查与对账，到期 TTL 清理。
- 单请求 body 最大 1 MiB，超限返回 413 并计数；压缩、分块或拼接绕过大小限制一律失败关闭。
- Worker 对暂时性错误最多重试 12 次并指数退避；永久契约错误直接把 Inbox 标记为 failed。失败作业保留供告警与排查；人工重新入队/标记处理控制面属于 Phase 5 加固切片，交付前不得宣称生产闭环完成。

## 4. 幂等

- eventId 为必填；幂等键 = `tenantId + clientId + eventId`，不接受服务端合成 eventId。
- 同一幂等键且载荷摘要相同的重试复用首次 Inbox 并重新确保排队；同一 eventId 对应不同载荷时失败关闭，不产生新摘要或事件。
- 同一统计日的后续有效推送按 §7 追加新版本，不属于重放。

## 5. 指标白名单与数据形状

- 仅接受以下**固定白名单指标**；新增指标必须先更新契约、Schema、事件白名单和 MCP 输出并走评审：

  | 指标编码 | 含义 | 类型 | 单位 |
  | --- | --- | --- | --- |
  | `gmvMinor` | 成交总额 | 金额 | 整数分 |
  | `paidOrderCount` | 支付单量 | 整数 | 单 |
  | `refundMinor` | 退款金额 | 金额 | 整数分 |
  | `refundOrderCount` | 退款单量 | 整数 | 单 |
  | `activeCustomerCount` | 活跃客户数 | 整数 | 人 |

- 金额字段必须是非负安全整数分（JSON 整数，≤ 9,000,000,000,000,000），禁止浮点或字符串金额；币种固定为 CNY，统计日期为真实 `YYYY-MM-DD`，不得晚于事件的上海业务日且仅接受最近 31 日补传。
- 出现白名单外指标、未知字段、非法日期、金额越界或非整数时**整批失败关闭**：不生成摘要版本，拒绝原因计数并告警，原始报文仍按 §3 加密入箱。
- 读取侧同样白名单化：禁止动态字段、动态排序和自定义字段查询；过滤与排序字段只认本契约登记的白名单映射。

## 6. 摘要存储与修订

- 摘要记录按 `tenantId + summaryDate + revision` 存储；首版 revision 必须为 1，后续修订必须严格连续递增。
- **修订只追加新版本，禁止覆盖或物理删除历史版本**；展示层默认取该统计日最新版本，历史版本可审计查询。
- 摘要记录不含原始报文、不含个人信息；若某指标未来可归因到个人，必须先升级为 L3 并脱敏后才允许进入白名单。

## 7. 只读使用边界

- 经营摘要仅用于 ERP 管理层看板展示（Web 与 MCP 只读通道）。
- **禁止**经营摘要进入工资、税务、资金、会计任何计算链路。代码层以依赖方向固化：payroll、treasury、tax、accounting 模块不得 import 摘要读模型；契约测试扫描依赖方向，违规即红灯。
- 摘要不作为任何审批、放款、考核、结算的输入；需要此类用途必须另立契约并经数据负责人签署。

## 8. REST 契约

| 端点 | 说明 | 权限 |
| --- | --- | --- |
| `POST /webhooks/op/operating-summaries` | OP 推送入口，202 表示已加密入箱并确保排队 | 仅 OP HMAC 服务身份，不挂用户 scope |
| `GET /op/operating-summaries/:date` | 按统计日读取最新 revision | `erp:op:operating_summary:read` |

REST 响应只含白名单指标、版本号与统计日，不含原始报文、Inbox 内部字段或其他租户数据；无写端点，摘要不提供任何 REST 修改/删除入口。

## 9. 事件契约

CloudEvents 1.0 信封（遵循集成规范 §9.1）：

| type | 触发 | data 内容 |
| --- | --- | --- |
| `cn.gaoq.erp.op.operating_summary.published.v1` | Worker 生成不可变新修订 | tenantId、summaryDate、revision、currency、五项白名单指标、payloadHash |

事件一律使用 canonical 字段，禁止透传 OP 原始报文；事件与摘要版本写入在同一 MongoDB 事务内提交（outbox）。

## 10. MCP 契约

- **Resource（只读）**：`erp://op/operating-summaries/{date}`，读取指定统计日最新修订。
- **Tool**：`op_operating_summary_get`（R0），唯一参数 `date`；声明中文 title/description、input/output Schema 和只读幂等注解。
- **Prompt**：`op_operating_summary_review_guide`，仅指导经营摘要解读，不产生写操作。
- **禁止注册任何经营摘要写 Tool**：接收、修订、删除摘要均无 MCP 入口；写入路径只认 §2 webhook。未标注风险等级的 Tool 默认按 R3 处理。
- MCP 通道只调用应用服务，禁止访问 Model、Repository、供应商 SDK 或数据库；禁止把 OP 凭据、签名密钥或 MCP 令牌透传给 OP 或其他上游。

## 11. Scope 与权限

- `erp:op:operating_summary:read`（R0）：读取经营摘要，数据范围按租户 + 管理层角色执行；字段权限、数据范围校验与 REST 完全一致。
- webhook 端点仅接受验签通过的 OP 服务身份，不参与用户 OAuth scope 体系。
- 摘要读取按 L2 内部数据处理；不含 L3/L4 字段，无需二次认证。

## 12. 审计点

当前代码审计：已解析 clientId 绑定后的验签成功/失败、载荷拒绝、重放拒绝、版本追加成功/失败、REST 读取、MCP Tool/Resource 调用。未知或格式非法 clientId、无效时间戳等无法安全归属租户的请求由网关安全指标承接，不写入任一租户审计链。审计禁止记录密钥、签名原文、nonce 原文或原始报文。审计事件持久化为每租户独立 HMAC 前向链——当前只声明**可检测篡改**，未完成独立权限域 WORM 锚定前不得宣称完整不可抵赖。

Webhook 在租户解析后的验证拒绝、重放拒绝和成功入箱均尝试写可信外部服务审计；
若审计设施自身故障，只记录稳定
`OP_WEBHOOK_AUDIT_AFTER_DECISION_FAILED` 告警，不得覆盖原始 4xx 决策，也不得
把已加密入箱并确保排队的 202 成功反向暴露为失败。告警不得包含签名、nonce 或
原始正文。

## 13. 数据分级

| 数据 | 分级 | 处理 |
| --- | --- | --- |
| OP 原始请求报文 | L3 | AES-256-GCM 入箱，AAD 绑定租户与 Inbox ID，保留 90 天 |
| 摘要指标数据 | L2 | 租户 + 角色权限；无个人信息 |
| 指标值精确检索（如需要） | —— | 只允许 HMAC 盲索引，禁止对明文或随机密文建索引 |
| 日志/事件/审计/MCP 输出 | —— | 默认不含原始报文与密钥材料 |

## 14. 索引

所有集合以 tenantId 为联合索引首字段：

- 摘要：`{tenantId, summaryDate, revision}` 唯一；`{tenantId, summaryDate, revision:-1}` 供最新修订查询。
- 持久幂等：摘要与 Inbox 均使用 `{tenantId, clientId, externalEventId}` 唯一索引。
- Inbox：`{tenantId, status, createdAt}` 扫描；`expiresAt` TTL 索引按写入时确定的 90 天到期时间清理。
- 索引通过独立追加式迁移建立，禁止在请求路径上隐式建索引。

## 15. SLO

- webhook 入口 P95 < 500ms，月度可用性 ≥99.9%（对齐项目级目标）。
- 入站到可查询端到端延迟 P95 ≤ 5 分钟（异步处理）；Worker 队列积压接入告警。
- 每日生成摘要条数、版本数、拒绝数对账报告；OP 侧推送数与 ERP 入库数不一致即告警。
- 上线前通过"OP 不可用 2 小时"断连演练：事件不丢失，恢复后自动追赶；重放攻击演练（过期时间戳、重复 nonce）全部拒绝。

## 16. 验收标准

契约测试必须覆盖：

- [ ] 有效签名通过；错密钥、错签名串、改 body 均 401；
- [ ] 时间戳超出 ±5 分钟拒绝；nonce/eventId 24 小时内重放拒绝；
- [ ] body/header/query 携带伪造 tenantId 不影响租户解析（按 clientId 绑定），跨租户读取为零；
- [ ] body 超过 1 MiB 返回 413；
- [ ] 白名单外指标/未知字段整批失败关闭并入箱留证；
- [ ] 金额为非整数、浮点、超安全整数范围全部拒绝；
- [ ] 同一统计日再次推送追加新版本，历史版本完整保留且不可修改；
- [ ] 幂等重放返回首次结果，不重复产生版本与事件；
- [ ] REST/MCP 仅接受单个 date 参数，不提供动态字段、动态排序或自定义查询；
- [ ] MCP 无经营摘要写 Tool；MCP 调用链不触达 Model/Repository；
- [ ] 审计链完整且不含原始报文与密钥；
- [ ] 关键模块单测覆盖率 ≥90%。

仓库自动化证据：`pnpm quality:op-webhook-ingress-coverage` 同时覆盖经营摘要与
审批请求两个 Controller、入口服务和独立 AES-256-GCM 服务，要求每个目标文件
语句、分支、函数和行均不低于 90%。当前 124 项测试合计达到
98.34%/96.13%/100%/100%。

## 17. 退出门禁

代码交付已覆盖 REST、Worker、Outbox、MCP、测试和追加式迁移。生产退出仍必须满足：§16 验收全绿；安全门禁通过；死信告警接收人已指定；日对账任务上线；OP 方沙箱联调签署确认；索引迁移在预发验证可重复执行；架构与安全负责人共同签署。任一未满足不得宣称该切片生产验收完成。

## 18. 与后续切片的关系

本契约仅为 Phase 5 第一个垂直切片。OP 组织下发、审批桥、移动端、驾驶舱、全量迁移与生产加固均不在此交付，其实现不得复用本切片的 clientId、密钥、Inbox 集合或摘要读模型绕过各自契约；每个后续切片必须独立定义自己的 REST/事件/MCP/审计/SLO，禁止借本切片隐式扩张。
