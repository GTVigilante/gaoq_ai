# OP 组织与人员下发契约

- 文档编号：phase-5/02
- 版本：v1.0
- 状态：代码、队列路由、版本门禁、对账适配器与运维渠道已实现；真实 OP 沙箱和断连演练待验收

## 1. 权威与范围

ERP 是组织、部门、员工状态和组织归属的唯一主数据源。OP 仅是下游消费者，不得反向覆盖 ERP 组织数据。本切片复用既有 `integration_outbox → integration_org_deliveries → integration_org_external_versions` 管线，把每个组织事件原子扇出到钉钉、飞书和 OP。

本切片不建立 OP 登录身份绑定，不接收 OP 组织回写，也不实现 OP 业务审批。OP 私密开户通道永久拒绝；身份联合必须使用后续独立契约。

## 2. OP 出站身份与签名

- 每租户在 `integration_org_platform_bindings` 建立 `channel=op` 的唯一绑定，只保存 `GAOQ_ORG_PLATFORM_*` Secret 引用。
- Secret 内容严格为 `clientId/clientSecret` JSON；clientId、externalTenantId 均为受控标识，禁止 CR/LF 和任意 Header 注入。
- OP 出站凭据与 OP→ERP 经营摘要的 `GAOQ_OP_HMAC_*` 完全分离，也不得复用钉钉/飞书凭据。
- OP API 根地址来自 `OP_API_BASE_URL`；只允许独立权限域的标准 HTTPS 根地址，禁止凭据、路径、query、fragment 和非标准端口。
- 每请求生成 128 位随机 nonce 和毫秒时间戳。签名串为：

  `timestamp + "\n" + nonce + "\n" + method + "\n" + path + "\n" + externalTenantId + "\n" + idempotencyKey + "\n" + SHA-256(body bytes)`

  使用 HMAC-SHA256 输出十六进制签名；OP 必须校验 ±5 分钟时间窗、nonce 防重放和幂等键。

## 3. 下发 API

| 方法与路径 | 用途 | 外部标识 |
| --- | --- | --- |
| `PUT /erp/v1/org/departments/{erpDepartmentId}` | 创建或按版本更新部门 | 固定使用 ERP departmentId |
| `PUT /erp/v1/org/employees/{erpEmployeeId}` | 创建、更新、停用或终止员工组织投影 | 固定使用 ERP employeeId |
| `GET /erp/v1/org/snapshot` | 每日只读全量快照对账 | 返回部门与员工 canonical 白名单 |

请求正文只包含组织投影所需字段：ERP 聚合 ID、version、部门编码/名称/父级/负责人/顺序，或员工号/显示名/状态/部门外部 ID。禁止联系方式、证件、薪酬、银行、审批正文和 OP 业务角色进入组织事件。

成功响应严格为 `code=OK` 和与路径一致的 `externalId`；未知响应、外部 ID 错位、超 256 KiB 响应或非 JSON 均失败关闭。

## 4. 版本、幂等与故障恢复

- Outbox 事件按 `eventId + channel` 唯一，新增 OP 后每个部门/员工事件形成三条独立 Delivery。
- OP 幂等键沿用 ERP CloudEvent 的固化键；适配器只接受 `[A-Za-z0-9._:-]` 白名单。
- `{tenantId, channel, aggregateType, aggregateId}` 版本状态只允许单租约；低版本与重复版本不再次调用 OP。
- 部门依赖先于员工；父部门或主部门映射未就绪时不消耗业务重试预算。
- 网络、429 和 5xx 指数退避；业务/冲突错误进入 manual_review；重试耗尽进入 dead。人工重试复用既有 R2 REST 与审计，并已支持 `channel=op`。

## 5. REST、事件、MCP 与审计

- 主数据写入继续使用既有 ERP 组织 REST；不新增 OP 可调用的 ERP 组织写接口。
- 运维 REST：`GET /integrations/org-deliveries?status=&channel=op` 与 `POST /integrations/org-deliveries/:eventId/op/retries`。
- 事件继续使用既有 `cn.gaoq.erp.org.*.v1` CloudEvents；OP Delivery 保存脱敏信封，不另造第二套领域事件。
- MCP 继续使用只读 `get_org_chart`；组织下发属于 R2，不注册 OP 下发、重试或对账写 Tool。
- 人工重试与每日对账写统一审计；Delivery 和版本状态提供机器可核验投递轨迹，禁止记录签名、Secret、请求/响应正文。

## 6. 每日对账

只有存在 active OP 绑定的租户才运行 OP 对账。快照最多 20,000 个对象，只保留 canonical 白名单，比较：

- 部门映射、存在性、名称、父级和停用状态；
- 员工映射、存在性、员工号、显示名、部门集合和停用/离职状态；
- OP 孤儿对象。

差异只生成只读报告和告警，禁止自动用 OP 快照反写 ERP，也禁止未经批准删除 OP 孤儿对象。

## 7. 验收与生产门禁

- [x] 三渠道原子扇出、独立消费任务和版本防乱序已实现。
- [x] OP HMAC 签名绑定 method/path/租户/幂等键/body 摘要，凭据不透传。
- [x] 固定 HTTPS 根域、路径和 Header 白名单防 SSRF/Header 注入。
- [x] OP 适配器单测覆盖部门、员工、签名、身份通道拒绝与快照投影。
- [ ] 在 OP 沙箱验证创建、更新、停用、重复、乱序与错签名。
- [ ] 完成 OP 不可用两小时后自动追赶且不丢失的演练。
- [ ] 完成三方日对账、告警接收和人工重试演练。
- [ ] 真实 `OP_API_BASE_URL` 与每租户出站 Secret 经 KMS/Secret Manager 注入并完成轮换演练。

任一外部项未通过，不得把本切片标记为生产验收完成。
