# OP 适配器字段映射

- 权威方向：组织/员工 `ERP → OP`；身份 `OP 认证 → ERP 裁决`；业务审批请求
  `OP → ERP` 后由 ERP 重新解析路由；审批结果 `ERP → OP`；经营摘要 `OP → ERP`
  只读展示。
- 实现：
  `op-org-push.adapter.ts`、`../../../identity/op-sso.adapter.ts`、
  `../../../op/op-approval-http.client.ts` 与 `../../../op/` 应用服务。
- 外部验收：真实 OP 租户、服务身份、限流、历史数据和双向对账仍待完成。

## 组织与员工

| Canonical 字段 | OP 字段 | 方向/约束 |
| --- | --- | --- |
| 固定值 | `schemaVersion="1.0"` | 版本不可由业务输入覆盖 |
| `departmentId` | `erpDepartmentId` | ERP 权威标识 |
| `currentExternalId ?? departmentId` | `externalId` | 路径和正文必须一致 |
| `version` | `version` | 单调版本，拒绝旧事件 |
| `code/name/status` | 同名字段 | ERP 权威 |
| `parentExternalId/managerExternalId/sortOrder` | 同名字段 | ERP 组织映射结果 |
| `employeeId` | `erpEmployeeId` | ERP 权威标识 |
| `employeeNo/displayName/status` | 同名字段 | ERP 权威 |
| `departmentExternalIds` | 同名数组 | 不允许 OP 回写 ERP 组织 |
| `primaryDepartmentExternalId` | 同名字段 | 必须属于部门数组 |

## SSO、审批和经营摘要

| OP 字段 | ERP canonical 字段 | 约束 |
| --- | --- | --- |
| `externalTenantId` | `externalTenantId` | 必须等于服务端 state 绑定值 |
| `unionId` | `unionId` | 与外部用户标识联合解析 |
| `externalUserId` | `externalUserId` | 映射缺失时拒绝登录 |
| `displayName` | `displayName` | 仅显示，不提供 ERP 授权事实 |
| OP 业务单据引用 | 审批发起业务引用 | ERP 按当前组织/角色重新解析审批人 |
| OP 提供的审批人/部门/角色 | 无映射 | 永久拒绝，不进入审批快照 |
| ERP 最终审批状态 | OP 结果摘要 | 经 Outbox 可靠投递和幂等回执 |
| `GMV/单量/日期/业务维度` | OP 经营摘要 | 只读、带租户、不得参与 ERP 计算 |
| OP Access Token | 无持久化映射 | 不进入仓储、日志、JWT 或 MCP |

## 服务身份

组织请求使用 `externalTenantId`、方法、固定路径、幂等键和正文摘要生成 HMAC-SHA-256
签名；随机 nonce 和毫秒时间戳用于防重放。Secret 仅从服务端凭据解析器取得，禁止
写入本文档、配置样例、审计或 AI 上下文。
