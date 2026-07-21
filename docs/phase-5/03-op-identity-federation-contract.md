# OP 身份联合契约

- 文档编号：phase-5/03
- 版本：v1.0
- 状态：OP SSO 运行时代码与协议测试已实现；真实 OP 授权服务器、初始绑定迁移和实体认证器 UAT 待验收

## 1. 权威与边界

OP 只负责证明 OP 外部身份；ERP 的 `CanonicalIdentity`、员工关联、账号启停、角色、Scope 和数据范围始终由 ERP 裁决。OP 业务角色不得转换为 ERP 角色，手机号、邮箱、姓名不得用于自动合并账号。

登录仅接受 `provider=op` 的显式绑定：`tenantId + provider + externalTenantId + unionId + externalUserId` 必须同时命中 `bound` 记录。缺失、停用、任一标识漂移或外部租户不一致均失败关闭并返回统一错误。

## 2. 协议

- 浏览器入口：`POST /api/auth/sso/op/start`，先按受控 `tenantSlug` 解析唯一 active 租户绑定。
- 授权地址固定为 `OP_API_BASE_URL/oauth2/authorize`，参数固定为 Authorization Code、PKCE S256、`openid profile`、一次性 state 和已登记 externalTenantId。
- 回调入口：`POST /api/auth/sso/op/callback`，必须同时通过可信 Origin、HttpOnly/SameSite state Cookie 和 Redis `GETDEL` 一次性 state。
- 授权码仅发送到 `OP_API_BASE_URL/erp/v1/sso/token`；用户信息仅从 `OP_API_BASE_URL/erp/v1/sso/userinfo` 获取。禁止请求提供 URL、Header、Scope 或上游 Token。
- state 与 PKCE verifier 均使用 256 位随机数，TTL 300 秒；Redis key 只保存 state 的 SHA-256 摘要。
- OP access token 只在适配器内存中用于一次 userinfo 请求，不落数据库、日志、审计、Outbox 或浏览器响应。

## 3. 凭据与租户约束

- `OP_SSO_CLIENT_ID`、`OP_SSO_CLIENT_SECRET`、`OP_SSO_REDIRECT_URI` 必须成套配置，并与 `GAOQ_OP_HMAC_*`、`GAOQ_ORG_PLATFORM_OP_*` 分离。
- 生产 redirectUri 必须精确为 ERP issuer 下的 `/api/auth/sso/op/callback`，禁止任意域、query、fragment、凭据或 HTTP。
- OP API 根地址只允许独立权限域的标准 HTTPS 根路径；授权、token 和 userinfo 路径在代码中固定。
- 授权响应中的 externalTenantId 必须与一次性 state 中的受信绑定一致；不信任浏览器请求传入租户。

## 4. 绑定生命周期

- 初始 OP 身份绑定属于 R3 数据治理动作，必须通过后续受控迁移/双人复核流程建立；本登录端点永久不自动创建或修改绑定。
- 绑定唯一索引覆盖租户、provider、外部租户及外部用户标识；冲突必须人工仲裁。
- ERP 员工离职或授权主体停用时，沿用 Identity 生命周期事务停用 OP 绑定、会话和刷新令牌。
- OP 解绑或标识变更不得通过登录回调隐式生效，必须走变更审批与审计。

## 5. REST、事件、MCP 与审计

- REST 只增加 OP 到现有统一 SSO start/callback；不提供公共绑定写接口或外部身份搜索接口。
- 登录不产生业务领域事件；会话与刷新令牌仍由 ERP Identity 模块事务创建，OP Token 不进入 ERP 事件。
- MCP 不注册登录、绑定、解绑或身份搜索 Tool。AI 客户端使用 ERP OAuth 2.1，不得携带或换取 OP 用户 Token。
- 成功/失败登录指标、会话创建/吊销和初始绑定迁移证据必须进入统一审计与安全监控；不得记录授权码、state、verifier、clientSecret 或 access token。

## 6. 验收与门禁

- [x] OP provider 纳入统一 state、PKCE、Cookie、租户绑定和本地授权裁决链路。
- [x] OP 授权、token、userinfo 地址固定，凭据独立，响应使用严格白名单。
- [x] externalTenantId、unionId、externalUserId 同时匹配；无绑定时不自动合并。
- [x] 身份提供者响应在流式读取阶段限制为 256 KiB。
- [ ] OP 沙箱完成成功、错租户、重复 state、错 verifier、过期 code 和 Token 泄漏测试。
- [ ] 初始 OP 身份映射迁移完成双人复核且对账 100%。
- [ ] 实体浏览器与认证器完成登录、离职吊销和凭据轮换 UAT。

任一外部项未通过，不得把 OP 身份联合标记为生产验收完成。
