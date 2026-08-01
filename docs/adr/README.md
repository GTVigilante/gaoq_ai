# GaoQ-OS 架构决策记录

ADR 只记录已作出的重大架构决策，不替代阶段验收、外部联调或安全例外批准。状态
只允许 `proposed`、`accepted`、`superseded`、`rejected`；改变已接受决策必须
新增 ADR，并在新旧记录中互相引用，禁止直接改写历史结论。

| ADR | 状态 | 决策 |
|---|---|---|
| [ADR-0001](./0001-modular-monolith-and-runtime.md) | accepted | 模块化单体与运行时基线 |
| [ADR-0002](./0002-erp-master-data-and-platform-adapters.md) | accepted | ERP 主数据权威与双办公平台适配 |
| [ADR-0003](./0003-standard-mcp-service-boundary.md) | accepted | 标准 MCP 服务与 AI 风险边界 |
| [ADR-0004](./0004-professional-payroll-system-boundary.md) | accepted | 独立专业算薪生产事实源 |
| [ADR-0005](./0005-github-hosted-oidc-delivery.md) | accepted | GitHub Hosted + OIDC 发布 |
| [ADR-0006](./0006-unified-cutover-and-evidence-gates.md) | accepted | 统一切换与证据门禁 |

## 记录模板

每份 ADR 必须包含：状态、日期、关联 Issue、背景、决策、后果、被否决方案、
安全/数据影响和替代关系。`accepted` 只表示架构结论冻结，不表示实现已合并或
生产验收通过。

