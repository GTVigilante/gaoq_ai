# 组织主数据外部投递可靠性运行手册

## 1. 权威边界与连接契约

ERP 是组织、员工与任职关系唯一主数据源。组织事件只允许沿
`ERP Outbox → integration_org_deliveries → 钉钉/飞书/OP` 单向下发；平台快照只用于
对账，禁止反向覆盖 ERP 主档。

- 钉钉部门创建携带 ERP `departmentId` 作为 `source_identifier`；员工首次开户只能走
  私密开户通道，通用组织 Outbox 不携带手机号或邮箱。
- 飞书部门创建使用 ERP 稳定 `department_id` 和由事件幂等键派生的
  `client_token`；员工首次开户同样由私密通道完成。
- OP 使用稳定资源 URI、`PUT`、HMAC 服务身份和
  `x-gaoq-erp-idempotency-key`，消费方必须把同键同载荷视为同一请求。
- 三个平台的 Token、Secret、原始响应和个人联系方式均不得写入投递记录、指标、
  日志、审计 metadata 或 MCP 参数。

## 2. 版本、租约与不确定结果

每个 `tenantId + channel + aggregateType + aggregateId` 仅维护一条外部版本状态。
Worker 必须先检查低版本任务，再原子预留当前版本，平台成功后提交
`appliedVersion`，最后补写投递成功。

过期 `processing` 不得直接重新调用平台：

1. 若 `appliedVersion >= aggregateVersion`，只补写投递成功，不重复外部调用。
2. 若版本未提交，记录进入 `manual_review`，错误码为
   `ORG_DELIVERY_RESULT_INDETERMINATE`。
3. 平台已经返回成功、但版本或投递终态无法确认时，Worker 抛出
   `ORG_DELIVERY_STATE_UNAVAILABLE` 并保留现场；通用失败处理不得释放租约、增加重试
   次数或把已成功外部副作用写成失败。
4. 网络断开、响应读取失败、超限或成功响应格式无法确认时，按结果不确定隔离，不做
   自动重试。

所有成功、失败、释放和恢复写入必须同时匹配事件、渠道、聚合版本、原尝试次数、
`processing` 状态和当前 Worker。`matchedCount != 1` 视为租约丢失，禁止覆盖其他
Worker 的状态。

## 3. 人工核验与恢复

先查询终态队列：

```http
GET /api/integrations/org-deliveries?status=manual_review&channel=dingtalk&limit=50
Authorization: Bearer <具备 erp:integration:org_delivery:read 的服务身份>
```

核对 ERP 事件版本、平台对象与当日对账报告后，才可执行 R2 恢复：

```http
POST /api/integrations/org-deliveries/{eventId}/{channel}/retries
Authorization: Bearer <具备 erp:integration:org_delivery:operate 的服务身份>
Idempotency-Key: <独立操作幂等键>
Content-Type: application/json

{"reason":"approved_exception"}
```

不得直接修改 MongoDB 状态、版本或锁字段。`credentials_fixed`、`mapping_fixed` 和
`provider_recovered` 只用于已确认没有成功副作用的确定性故障；结果不确定记录必须先
完成平台侧核验并走批准例外。

## 4. 对账与审计

每日对账只读取 active 平台绑定，比较 ERP 部门/员工、外部版本映射与平台快照。
差异报告只保存聚合标识、外部标识、差异类型和字段名，不保存外部姓名、手机号、
邮箱或响应正文。单次 ERP 期望对象和映射各不得超过 20,000，报告最多保存 1,000 条
差异并标记 `truncated`。

完成或失败报告写入必须仍匹配 `running` 租约；租约丢失不得追加错误审计。报告终态
已提交后的审计故障单独分类，不得把 `completed` 回写为 `failed`。

## 5. 指标、告警与处置

- `gaoq_org_delivery_total{channel,outcome}`：固定渠道和结果枚举计数。
- `gaoq_org_delivery_duration_seconds{channel,outcome}`：单次投递耗时。
- 任一 `state_unavailable` 立即触发 critical；任一 `manual_review` 或 `dead` 触发
  warning。

处置顺序固定为：冻结该聚合后续版本 → 保全事件/版本/审计记录 → 平台只读核验 →
判定已应用则补写成功、未应用则经 R2 恢复 → 运行当日对账。禁止通过清队列或批量
改状态消除告警。

## 6. MCP 边界

标准 MCP 组织能力继续使用 `get_org_chart`，复用组织应用服务和可信租户/部门数据
范围；不接受客户端租户参数。投递列表、人工重试、凭据修复、平台写入和对账控制面
均不暴露为 MCP Tool/Resource/Prompt，AI 不得执行组织外部写入或 R2 恢复。

## 7. 仓库内验收

```bash
pnpm quality:org-delivery-reliability-coverage
pnpm check
pnpm build
```

专项门禁覆盖投递状态机、过期租约恢复、双平台适配器协议、HTTP 安全边界、对账租约
和队列载荷，目标文件语句、分支、函数和行覆盖率均不得低于 90%。真实平台沙箱回执、
Prometheus 规则加载和 24 小时演练属于外部验收，不能用本地测试替代。
