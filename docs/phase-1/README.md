# Phase 1 运行手册

本目录承载 Phase 1 可执行验收与生产运维手册；架构和安全强制规范仍以 [`../phase-0/README.md`](../phase-0/README.md) 为入口。

- [`01-index-migration-runbook.md`](./01-index-migration-runbook.md)：生产索引只增不删迁移、验证与失败处理。
- [`02-audit-integrity-runbook.md`](./02-audit-integrity-runbook.md)：持久审计链、密钥轮换、完整性验证与外部 WORM 锚定边界。
- [`03-observability-slo-runbook.md`](./03-observability-slo-runbook.md)：Prometheus 指标、告警、SLO、WORM 回执契约与负载基线。
- [`04-org-delivery-reliability-runbook.md`](./04-org-delivery-reliability-runbook.md)：ERP 组织主数据向钉钉、飞书和 OP 投递的租约、结果不确定隔离、对账与 MCP 边界。
- [`05-identity-token-entry-runbook.md`](./05-identity-token-entry-runbook.md)：JWT 可信身份投影、OAuth 授权事务重验、一次性消费与失败关闭边界。
