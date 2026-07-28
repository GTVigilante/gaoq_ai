# Phase 1 运行手册

本目录承载 Phase 1 可执行验收与生产运维手册；架构和安全强制规范仍以 [`../phase-0/README.md`](../phase-0/README.md) 为入口。

- [`01-index-migration-runbook.md`](./01-index-migration-runbook.md)：生产索引只增不删迁移、验证与失败处理。
- [`02-audit-integrity-runbook.md`](./02-audit-integrity-runbook.md)：持久审计链、密钥轮换、完整性验证与外部 WORM 锚定边界。
- [`03-observability-slo-runbook.md`](./03-observability-slo-runbook.md)：Prometheus 指标、告警、SLO、WORM 回执契约与负载基线。
- [`04-org-delivery-reliability-runbook.md`](./04-org-delivery-reliability-runbook.md)：ERP 组织主数据向钉钉、飞书和 OP 投递的租约、结果不确定隔离、对账与 MCP 边界。
- [`05-identity-token-entry-runbook.md`](./05-identity-token-entry-runbook.md)：JWT 可信身份投影、OAuth 授权事务重验、一次性消费与失败关闭边界。

当前审计追加代码已强制规范链载荷与规范 Base64URL，Mongo 事务提交后的会话清理
故障不会反向诱发重复追加；独立 WORM 连接强制 HTTPS 443、成套凭据、载荷摘要与
Ed25519 签名绑定、16 KiB 严格 JSON 回执、时钟与保留期校验。HMAC、Mongo Sink
与 WORM Client 均纳入逐文件四维 90% 门禁。审计 Worker 另强制固定空载荷任务、
六小时幂等调度、指数退避、无重入队列观测及 API/Worker 模块隔离，七个生产文件
逐文件四维均为 100%；真实 WORM 抽样回读仍是外部验收。
