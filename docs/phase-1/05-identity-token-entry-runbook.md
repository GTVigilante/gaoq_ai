# Phase 1 身份令牌入口与 OAuth 授权事务运行手册

## 1. 强制边界

- HTTP、MCP 和浏览器 OAuth 入口复用同一访问令牌验证器，不读取客户端提供的租户
  Header，也不把未验签声明写入可信请求上下文。
- Access Token 固定使用 RS256、`typ=at+jwt`、已登记 issuer、audience 和
  resource；`sub` 必须逐字等于 `tenant_id:actor_id`。
- 人员令牌必须绑定 ERP 中仍活动的会话；`mcp_client` 令牌同时绑定当前活动客户端、
  凭据、租户、主体、角色、部门和 Scope 投影。配置级撤销必须立即使既有令牌失效。
- audience、resource、角色、Scope 和部门集合不得重复；验证后的对象与全部数组
  深冻结，禁止后续 Guard、Interceptor 或业务处理器修改可信身份。

## 2. Authorization Code + PKCE

授权请求和授权码只以 256-bit 随机值的 SHA-256 摘要作为 Redis Key，分别保留
10 分钟和 60 秒。回调地址逐字符匹配预注册值，PKCE 只接受 S256，授权请求与
授权码都绑定 client、resource、Scope、租户、主体及会话。

Redis 不是授权事实源。服务在以下每个阶段都重新读取当前只读客户端注册表：

1. 同意页展示前重验客户端活动状态、精确回调、resource 和 Scope。
2. 批准或拒绝决策前重复同一校验；批准还必须校验浏览器可信身份的租户与 Scope。
3. 授权码交换前重验客户端活动状态、精确回调、resource、租户和 Scope，再以
   Compare-and-Delete 原子消费。

任何客户端禁用、回调/资源/Scope/租户收紧、Redis 记录受损、随机值碰撞、并发
消费或 PKCE 不匹配都失败关闭。失败响应只返回稳定分类，不回显 Redis 内容、
客户端机密、签名细节或底层 JOSE 错误。

## 3. MCP 与其他系统连接

- 交互式 MCP 客户端走 Authorization Code + PKCE；无人值守 MCP 客户端走已登记
  `client_secret_basic` 或 `private_key_jwt`，两者均受 resource 与 Scope 白名单约束。
- Basic 只接受 512 字节内、规范 Base64 和严格 UTF-8 的单一
  `clientId:secret`；`private_key_jwt` 只接受 RS256/ES256、`typ=JWT`、
  `iss=sub=clientId`、登记 audience、五分钟内有效期和唯一 `jti`。断言在签发前
  通过 Redis `SET NX EX` 原子消费，防重放设施异常时不降级签发。
- 限流和失败审计的客户端归属只从呈现的 Basic 凭据或断言 `iss` 推导；正文
  `client_id` 只作一致性校验。认证后的 resource/Scope 拒绝分别形成
  `resource_denied`/`scope_denied` 最小 R1 审计，且发生在令牌签名前。
- OAuth 令牌只授予调用 ERP REST/MCP 应用服务的身份，不授予绕过业务服务访问
  MongoDB、上游 Token、Provider 控制面或 R3 能力的权限。
- 钉钉、飞书、OP、银行、税务和其他适配器的后台 `service/system_job` 上下文由
  Worker 内部可信装配产生；不得接受调用方仅通过修改 JWT `actor_type` 自报。

## 4. 验证与生产门禁

- `pnpm quality:identity-token-entry-coverage` 固定覆盖 JWT 验签/声明投影、人员会话、
  MCP 凭据撤销、授权请求重验、PKCE、一次性消费、碰撞、并发和受损记录。
- `pnpm quality:oauth-client-credentials-coverage` 固定覆盖规范 Basic、
  `private_key_jwt`、官方 MCP SDK 请求形态、凭据轮换、断言防重放、资源/Scope
  越权、签名故障和可信审计归属。
- `access-token-verifier.ts` 与 `oauth-authorization-transaction.service.ts` 逐文件
  语句、分支、函数和行覆盖率均不得低于 90%，并由 `pnpm check` 执行。
- `oauth-client-credentials-grant.service.ts` 同样逐文件四维不得低于 90%；当前专项
  22 项测试达到 97.60%/95.14%/100%/99.07%（语句/分支/函数/行）。
- 生产仍须验证真实域名、TLS、KMS/Secret Manager、密钥轮换、Redis 故障与恢复、
  浏览器兼容、真实 MCP 客户端以及跨租户拒绝证据；本地测试不替代外部验收。
