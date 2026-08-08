# GaoQ 专业算薪系统

独立部署的专业算薪产品，与 GaoQ ERP 使用统一身份、租户和组织员工主数据。

## 系统边界

- GaoQ ERP 是 Tenant、Person、Employee、Employment、Department、Position、
  JobLevel 和 AccessProfile 的唯一主数据源。
- 本系统是薪酬档案、算薪规则、工资运行、工资结果、工资条、薪税与发放证据的
  唯一事实源。
- 两套系统不共享数据库，不使用邮箱、姓名或工号关联员工；跨系统固定使用
  `tenantId + GaoQ employeeId`。
- 身份使用 GaoQ OAuth 2.1 Authorization Code + PKCE 和 JWKS；本系统不保存密码。

## 新架构

- `apps/payroll-api`：NestJS、MongoDB Replica Set、可信租户上下文和 L4 加密。
- `apps/payroll-web`：Next.js App Router、Ant Design、GaoQ SSO BFF。
- `apps/payroll-worker`：BullMQ 确定性算薪任务。
- `packages/payroll-core`：只使用整数分和 BigInt 的无副作用算薪核心。
- `apps/payroll-api/src/mcp`：独立 OAuth Resource 的 MCP 2025-11-25
  Streamable HTTP 服务，固定提供四个只读 Tool、两个 Resource Template 和两个
  Prompt；复用算薪应用服务，R3 Tool 永久为零。
- `backend/`、`frontend/`：旧 MVP，迁移验收完成前只作为功能参考。

## 本地验证

```bash
pnpm install
pnpm check
docker compose -f docker-compose.platform.yml config
```

## 已落地的集成闭环

- GaoQ 为 ERP API 与算薪 API 分别签发 resource/audience 绑定令牌。
- Worker 使用机密客户端的两个资源令牌，按游标拉取 ERP 权威快照并写入算薪只读
  投影；增量 CloudEvent 接口具备 Inbox 幂等和严格聚合版本校验。
- 工资运行支持 `draft → calculated → pending_approval → locked`，提交人与锁定审批人
  强制分离，所有状态更新使用乐观版本。
- 员工工资条只允许凭 GaoQ 令牌中的 `employee_id` 和
  `erp:payroll:payslip:self` 读取本人已锁定结果。
- 薪酬档案和逐员工工资结果使用 AES-256-GCM 字段加密；查询使用租户绑定 HMAC
  盲索引，数据密钥与盲索引密钥禁止复用。
- MCP 的 `payroll_payslip_get_self` 只从已验签令牌的 `employee_id` 读取本人结果；
  期间、对账和税务 Tool 只返回控制摘要，不接受 `tenantId` 或员工参数，不代理 ERP、
  不返回对方 Token，也不执行计算、审批、锁定、导出、发放或税务提交。

## GaoQ 配置要求

GaoQ 的 `AUTH_ADDITIONAL_RESOURCES_JSON` 必须注册算薪 API resource/audience；
同时注册两个 OAuth 客户端：

- 公共 Web 客户端：Authorization Code + PKCE，回调
  `http://localhost:3100/api/auth/callback`。
- 机密同步客户端：允许分别申请 `erp:payroll:master-data:read`（ERP resource）和
  `erp:payroll:master-data:sync`（算薪 resource）。

客户端密钥、数据加密密钥和盲索引密钥只通过 Secret Manager 注入，示例环境文件
故意不提供任何可用密钥。

共享契约以精确版本纳入 `packages/platform-contracts`，不再依赖开发机相邻目录；
来源 commit、同步规则与上线校验见 `docs/contract-provenance.md`。后续接入内部 npm
Registry 时，必须保持相同版本和内容摘要后再切换依赖来源。

## 生产部署

生产镜像、独立 MongoDB Replica Set、Redis、回环端口、运行时 Secret 和回滚边界见
`deploy/standalone/README.md`。该编排不会连接或修改 GaoQ ERP 与服务器其他项目的
数据库；主数据同步在 OAuth 服务客户端完成注册和联调前保持关闭。
