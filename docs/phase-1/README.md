# Phase 1 运行手册

本目录承载 Phase 1 可执行验收与生产运维手册；架构和安全强制规范仍以 [`../phase-0/README.md`](../phase-0/README.md) 为入口。

- [`01-index-migration-runbook.md`](./01-index-migration-runbook.md)：生产索引只增不删迁移、验证与失败处理。
- [`02-audit-integrity-runbook.md`](./02-audit-integrity-runbook.md)：持久审计链、密钥轮换、完整性验证与外部 WORM 锚定边界。
- [`03-observability-slo-runbook.md`](./03-observability-slo-runbook.md)：Prometheus 指标、告警、SLO、WORM 回执契约与负载基线。
- [`04-org-delivery-reliability-runbook.md`](./04-org-delivery-reliability-runbook.md)：ERP 组织主数据向钉钉、飞书和 OP 投递的租约、结果不确定隔离、对账与 MCP 边界。
- [`05-identity-token-entry-runbook.md`](./05-identity-token-entry-runbook.md)：人员 SSO 映射、JWT 可信身份投影、OAuth 授权事务重验、一次性消费与失败关闭边界。
- [`06-runtime-boundary-runbook.md`](./06-runtime-boundary-runbook.md)：公开错误、追踪、健康探针、Prometheus 与 Redis/Rediss 连接参数信任边界。

当前审计追加代码已强制规范链载荷与规范 Base64URL，Mongo 事务提交后的会话清理
故障不会反向诱发重复追加；独立 WORM 连接强制 HTTPS 443、成套凭据、载荷摘要与
Ed25519 签名绑定、16 KiB 严格 JSON 回执、时钟与保留期校验。HMAC、Mongo Sink
与 WORM Client 均纳入逐文件四维 90% 门禁。审计 Worker 另强制固定空载荷任务、
六小时幂等调度、指数退避、无重入队列观测及 API/Worker 模块隔离，七个生产文件
逐文件四维均为 100%；真实 WORM 抽样回读仍是外部验收。

员工首次平台开户已补齐认领后运行时任务校验、确定性平台 userId 反向绑定、外部
身份白名单、失败终态审计隔离和 Mongo 事务提交后的会话清理隔离；R3 入口仍永久
拒绝 MCP 服务主体，标准 MCP 不注册开户、重试、凭据或平台写 Tool。7 个测试文件、
81 项测试达到 99.07%/97.46%/100%/100%，七个生产文件逐文件四维 90% 门禁已
接入 `pnpm precheck`。真实钉钉/飞书沙箱、Secret 轮换和身份核验仍待现场验收。

OAuth Client Credentials 已强制规范 Basic/UTF-8、RS256/ES256
`private_key_jwt`、短时断言与 Redis 原子防重放；客户端归属只从实际认证材料
推导，正文 `client_id` 不能注入失败审计。认证后的 resource/Scope 越权在签名前
失败关闭并记录最小 R1 审计。22 项专项测试达到
97.60%/95.14%/100%/99.07%，逐文件四维 90% 门禁已接入 `pnpm precheck`。

浏览器与交互式 OAuth 会话已补齐 Refresh Token family 原子轮换、前驱 CAS、
重放后整族/会话吊销、单一 Cookie 与 8 KiB 头边界、受损持久化状态失败关闭，
以及活动/历史 RSA JWKS 两阶段轮换。会话吊销提交后的审计故障不改写业务终态。
11 个测试文件、82 项测试达到 99.17%/95.97%/100%/99.13%，十二个生产文件逐文件
四维 90% 门禁已接入 `pnpm precheck`。

生产运行入口已补齐 MongoDB 可写 Replica Set `hello`、Redis `PING`、1.25 秒截止
与并发单飞探针；HTTP 指标 Method/状态标签收敛、5xx 脱敏、4xx 有界详情、
Worker 抓取挑战和 Redis/Rediss 规范 URL 均失败关闭。11 个测试文件、40 项测试
达到 99.70%/94.44%/100%/99.67%，11 个生产文件逐文件四维 90% 门禁已接入
`pnpm precheck`；真实主节点切换、TLS/ACL、抓取网络与告警仍待现场验收。
