# Phase 0 规范索引

本目录是 GaoQ-OS 开发、验收和上线的强制基线。现有 PRD 负责描述产品目标；本目录负责规定系统如何设计、连接、验证和交付。发生冲突时，安全、租户、主数据、MCP 和发布门禁以本目录为准，并通过 ADR 记录例外。

## 文档清单

| 编号 | 文档 | 目的 |
| --- | --- | --- |
| 00 | [项目章程与阶段门禁](./00-program-charter.md) | 确定范围、原则、组织、Phase 0–6 和退出条件 |
| 01 | [企业架构规范](./01-enterprise-architecture.md) | 规定领域边界、模块依赖、运行架构和公共上下文 |
| 02 | [领域与数据规范](./02-domain-data-standard.md) | 规定主数据、租户、权限、状态、金额和数据生命周期 |
| 03 | [外部系统集成规范](./03-integration-standard.md) | 规定钉钉、飞书、OP、电子签、薪税、招聘等连接方式 |
| 04 | [MCP 服务规范](./04-mcp-service-standard.md) | 规定 AI 接入协议、鉴权、能力、风险控制与兼容测试 |
| 05 | [安全、质量与切换规范](./05-security-quality-cutover.md) | 规定安全基线、测试门禁、灾备、迁移和统一大切换 |
| 06 | [GitHub 治理规范](./06-github-governance.md) | 规定 Milestone、Issue、分支、PR、DoR 和 DoD |
| 07 | [专业算薪系统边界](./07-payroll-system-boundary.md) | 规定 ERP 主数据、统一身份与独立工资事实源边界 |

跨阶段的仓库实现、外部验收和 GitHub 阻塞边界统一见
[仓库实施完成度审计](../implementation-completion-audit.md)。该审计是状态索引，
不降低本目录任何强制规范或阶段退出条件。

当前覆盖率策略由 `scripts/validate-critical-coverage-policy.mjs` 自动复核：
全生产源码四维 80% 分母及 132 个专项脚本覆盖的 323 个生产文件逐文件四维
90% 阈值必须同时接入 `precheck/check`；租户、Identity、Approval、Payroll、
Treasury 与 MCP 六类章程关键域的 117 个权威文件必须全部位于该专项闭包内。
这只证明仓库质量实现，不能替代 Hosted Actions 真实执行、Phase 0 三方签署或
目标环境验收。

## 强制性用语

- “必须/禁止”：不可豁免，除非安全负责人和架构负责人共同批准 ADR。
- “应”：默认执行，偏离时必须在 Issue 中说明理由。
- “可”：按场景选择，不构成验收门禁。

## 变更流程

规范变更必须先提交 ADR，再更新相关文档、契约测试和 GitHub Backlog。任何业务 Issue 不得绕过已生效的租户、安全、审计或 MCP 风险控制。
