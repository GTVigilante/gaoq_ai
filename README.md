# GaoQ AI

告趣ERP系统（代号：GaoQ-OS）产品需求、企业架构规范与工程实现仓库。

## 简介

告趣（GaoQ）是小红书头部MCN机构，管理约300人，业务涵盖MCN、广告、招商团长、电商返利、PE（浦积资本）、CVC（星媒控股）。

本仓库为告趣ERP系统的产品需求文档（PRD）和开发跟踪仓库，技术栈为 NestJS + MongoDB + React/Next.js，核心目标：
- 替代氚云（审批）、智能薪酬（薪酬+人事）、招聘门户
- 自建MCP服务层，支持员工和外部人员通过AI接入
- 钉钉/飞书SSO单点登录
- 一站式企业运营平台

## 文档

- [PRD-告趣ERP系统-v1.0.md](PRD-告趣ERP系统-v1.0.md) — 完整产品需求文档
- [Phase 0 规范包](./docs/phase-0/) — 架构、数据、集成、MCP、安全、切换与GitHub治理基线
- [Phase 1 运行手册](./docs/phase-1/) — 索引迁移、审计完整性与可观测性
- [Phase 2 验收包](./docs/phase-2/) — 审批、通知、MCP确认、迁移、UAT与SLO
- [Phase 3 规范包](./docs/phase-3/) — 招聘、电子签、入职、培训、关怀与MCP契约
- [Phase 4 薪酬闭环](./docs/phase-4/) — 考勤、薪酬、薪税、发放、对账与影子周期
- [Phase 5 生产加固](./docs/phase-5/) — OP、移动端、分析、迁移、安全、韧性与MCP联调门禁
- [Phase 6 切换验收](./docs/phase-6/) — 统一切换、回滚、Hypercare与旧系统归档证据契约

## 阶段规划

| 阶段 | 参考时间 | 目标 | 状态 |
|------|------|------|------|
| Phase 0 | 4-6周 | 架构、数据、安全、MCP、集成契约与Backlog冻结 | 已建立基线 |
| Phase 1 | 8-10周 | 多租户底座、身份、组织主数据、双平台连接、MCP Core | 执行中 |
| Phase 2 | 8-10周 | 审批工作流、PC/H5及审批MCP能力 | 执行中（代码完成，真实平台与实体认证器 UAT 待完成） |
| Phase 3 | 10-12周 | 招聘、e签宝、入职、知识培训、关怀及MCP能力 | 执行中（领域与集成契约冻结） |
| Phase 4 | 10-12周 | 考勤、薪酬、薪税文件、发放对账及MCP能力 | 执行中（核心闭环代码完成，真实连接器联调与两个完整周期实跑待完成） |
| Phase 5 | 8-10周 | OP桥接、移动端、分析、生产加固和迁移工具 | 执行中（仓库实现与证据门禁完成，真实外部联调、迁移、容量、安全和容灾验收待执行） |
| Phase 6 | 6-8周 | 三次迁移演练、统一大切换与Hypercare | 执行中（切换与28天稳定期证据契约完成，真实生产执行尚未开始） |

详细范围、责任和退出门禁以[项目章程](./docs/phase-0/00-program-charter.md)为准。

## 技术栈

- **后端**: NestJS + MongoDB Replica Set + Redis + BullMQ
- **前端**: React + Next.js App Router + Ant Design
- **移动端**: React + Ant Design Mobile (H5/小程序)
- **AI接口**: MCP当前稳定规范（Streamable HTTP / stdio）+ OAuth 2.1
- **部署**: 中国境内云私有VPC + Kubernetes/Helm + WAF/API Gateway + 托管MongoDB/Redis + 对象存储/WORM + KMS/Secret Manager

## 开发门禁

- 所有代码、接口、事件和MCP能力必须带可信租户上下文、服务端权限校验、幂等与审计。
- ERP是员工、部门、岗位和职级的唯一主数据源；钉钉、飞书和OP通过适配器同步。
- Web、REST、MCP、Webhook和后台任务必须复用同一应用服务，禁止重复实现业务规则。
- 禁止提交密钥、个人敏感数据、WordPress备份、构建产物和本地环境文件。

## 本地开发

要求 Node.js 22、pnpm 10 和 Docker。仓库使用 pnpm workspace 管理 NestJS API、Next.js Web 与共享契约包。

```bash
cp .env.example .env
pnpm install
docker compose up -d
pnpm dev
# 另开终端启动后台任务 Worker
pnpm --filter @gaoq/erp-api dev:worker
```

- Web：`http://localhost:3000`
- API 存活探针：`http://localhost:3001/api/health/live`
- API 就绪探针：`http://localhost:3001/api/health/ready`
- Worker：独立进程消费 Outbox、钉钉/飞书组织同步与审批通知任务，不开放 HTTP 端口

### MCP OAuth 公共客户端

远程 MCP 客户端使用 OAuth 2.1 Authorization Code + PKCE S256。客户端必须预注册，配置只包含公开标识、精确回调、允许的 scope 和租户白名单，禁止放入 client secret：

```dotenv
MCP_OAUTH_CLIENTS_JSON=[{"clientId":"mcp-client-001","clientName":"本地 MCP 客户端","redirectUris":["http://127.0.0.1:6274/callback"],"allowedScopes":["erp:mcp:server:connect","erp:org:chart:read"],"tenantIds":["tenant-001"],"status":"active"}]
```

- 受保护资源发现：`/.well-known/oauth-protected-resource`
- 授权服务器发现：`/.well-known/oauth-authorization-server`
- 授权端点：`/api/auth/oauth/authorize`
- Token 端点：`/api/auth/oauth/token`（仅接受 `application/x-www-form-urlencoded`）
- 用户同意页：`/oauth/consent`，以 ERP HttpOnly 登录会话确认主体与租户

### MCP OAuth 无人值守服务客户端

服务代理使用 MCP OAuth Client Credentials 扩展
`io.modelcontextprotocol/oauth-client-credentials`。授权服务器同时支持
`client_secret_basic` 与优先推荐的 `private_key_jwt`（RS256 或 ES256），不接受请求体
`client_secret`。每个客户端固定绑定一个 ERP 租户、服务主体、角色、部门数据范围与最小
scope 集合，不能由调用方提交或覆盖租户。

`MCP_SERVICE_CLIENTS_JSON` 最多配置 100 个客户端，每个客户端最多保留 5 个重叠轮换凭据：

```json
[
  {
    "clientId": "service-client-001",
    "clientName": "组织只读代理",
    "tenantId": "tenant-001",
    "actorId": "mcp-agent-001",
    "allowedScopes": ["erp:mcp:server:connect", "erp:org:chart:read"],
    "roleCodes": ["service-reader"],
    "departmentIds": ["department-001"],
    "status": "active",
    "authentication": {
      "method": "client_secret_basic",
      "credentials": [
        {
          "credentialId": "credential-001",
          "secretSha256": "<43字符SHA-256-base64url摘要>",
          "notBefore": "2026-07-01T00:00:00+08:00",
          "expiresAt": "2026-10-01T00:00:00+08:00",
          "status": "active"
        }
      ]
    }
  }
]
```

- `client_secret_basic` 的原始 secret 必须是 43–128 字符高熵 base64url，只交付给调用方
  和 Secret Manager；配置仅保存其 SHA-256 base64url 摘要。
- `private_key_jwt` 配置只保存公开 JWK：RSA/RS256 或 P-256/ES256，且必须带
  `kid`、`use: "sig"`、`key_ops: ["verify"]`；严禁保存 `d`、`p`、`q` 等私钥参数。
- 轮换时先加入新凭据并保留短暂重叠窗口，客户端切换完成后将旧凭据设为 `revoked`。
  当前注册表在进程启动时加载；吊销、scope、角色或部门范围调整必须滚动重启全部 API 实例，
  全部实例加载新版本后，令牌验证链路会拒绝旧权限快照。紧急吊销不得只改环境变量而不重启。
- `private_key_jwt` 断言有效期不得超过 5 分钟；`jti` 在 Redis 中以摘要键一次性消费，
  Redis 不可用时拒绝签发，禁止降级绕过防重放。

提交前执行：

```bash
pnpm check
pnpm build
```

生产 Kubernetes 编排基线位于 [`deploy/helm/gaoq-erp`](./deploy/helm/gaoq-erp/README.md)。Chart 只生成受控工作负载清单，不创建云资源或 Secret，也不自动执行生产发布。
