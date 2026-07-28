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

## 3. 浏览器会话、Refresh Token 与签名密钥轮换

- SSO 登录在单个 Mongo 事务中创建服务端会话与首个 Refresh Token；令牌固定
  绑定租户、主体、`gaoq-web` 客户端、会话、family、代次和绝对过期时间。
- 刷新只接受精确 Web Origin、单一固定名称 Cookie 和规范 `rt_` 高熵值；超过
  8 KiB 的 Cookie Header、重复同名 Cookie、异常标识或受损持久化记录均在构造
  Mongo 查询或设置 Cookie 前失败关闭。
- 轮换以 `consumedAt` 原子消费旧令牌，创建下一代后必须用 `_id + tokenHash +
  consumedAt + replacedByHash不存在` 完成前驱 CAS；任一写入冲突回滚整笔事务。
  新 Access Token 在同一事务提交前完成签名，签名设施故障必须回滚前驱消费和
  后继创建。旧令牌重放吊销整个 family 和服务端会话，Access Token 随会话校验
  立即失效。
- 当前 RSA 私钥与 `kid` 仍由 Secret Manager 注入；历史公开验签键通过
  `AUTH_SIGNING_VERIFY_ONLY_JWKS_JSON` 注入，最多五把，只允许 RS256、`use=sig`
  和可选唯一 `key_ops=["verify"]`，禁止任何私钥参数。
- 轮换必须分两阶段：先让所有资源服务器看到“当前键 + 新键”，再切换活动私钥；
  旧公钥至少保留 `AUTH_ACCESS_TOKEN_TTL_SECONDS + 300 秒 JWKS 缓存 + 5 秒时钟容差`
  后方可移除。回滚只切回仍在 JWKS 中的上一把活动键，禁止复用 `kid`。
- 会话吊销提交后的审计故障只形成稳定告警，不改写已提交结果；成功令牌审计失败
  仍失败关闭，不向调用方返回已签名 Token。

## 4. MCP 与其他系统连接

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

## 5. 验证与生产门禁

- `pnpm quality:identity-token-entry-coverage` 固定覆盖 JWT 验签/声明投影、人员会话、
  MCP 凭据撤销、授权请求重验、PKCE、一次性消费、碰撞、并发和受损记录。
- `pnpm quality:oauth-client-credentials-coverage` 固定覆盖规范 Basic、
  `private_key_jwt`、官方 MCP SDK 请求形态、凭据轮换、断言防重放、资源/Scope
  越权、签名故障和可信审计归属。
- `pnpm quality:identity-session-lifecycle-coverage` 固定覆盖签名键环、JWKS、
  Authorization Code 令牌签发、浏览器 Cookie、Refresh Token family、会话仓储、
  登录/刷新服务与两个 HTTP 控制器。
- `access-token-verifier.ts` 与 `oauth-authorization-transaction.service.ts` 逐文件
  语句、分支、函数和行覆盖率均不得低于 90%，并由 `pnpm check` 执行。
- `oauth-client-credentials-grant.service.ts` 同样逐文件四维不得低于 90%；当前专项
  22 项测试达到 97.60%/95.14%/100%/99.07%（语句/分支/函数/行）。
- 会话生命周期专项 11 个测试文件、82 项测试达到
  99.17%/95.97%/100%/99.13%，十二个生产文件逐文件四维均不得低于 90%。
- 生产仍须验证真实域名、TLS、KMS/Secret Manager、两阶段密钥轮换演练、Redis 故障与恢复、
  浏览器兼容、真实 MCP 客户端以及跨租户拒绝证据；本地测试不替代外部验收。
