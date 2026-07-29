# Phase 6：统一大切换与稳定期

Phase 6 只接受真实生产证据，不把 CI 自测、模拟数据或 AI 结论当作上线结果。统一切换、回滚和旧系统归档均为 R3 人工治理动作，永久不注册为 MCP Tool；MCP 只能读取脱敏状态与证据摘要。

全部 Phase 6 工作流只使用 GitHub Hosted `ubuntu-latest`。受保护输入和
Kubernetes 身份按[GitHub Hosted OIDC 证据交换标准](../phase-5/21-github-oidc-evidence-exchange.md)
通过 workflow/policy 专用 audience 获取；生产 Apply 另需变更负责人和 SRE
使用不同批准密钥完成的两份外部 Ed25519 签名授权；统一切换需五方独立签名，
Hypercare 归档需三方独立签名。禁止 NAS、虚拟机、self-hosted Runner、本地证据
挂载和长期 kubeconfig。

## 交付物

- [统一切换控制契约](./00-unified-cutover-contract.md)
- [四周 Hypercare 与旧系统归档契约](./01-hypercare-archive-contract.md)
- [现场执行与证据运行手册](./02-production-execution-runbook.md)
- [生产资金执行授权契约](./03-production-execution-authorization.md)
- [Kubernetes 生产编排基线](./04-kubernetes-deployment-baseline.md)
- [受保护生产部署工作流](./05-protected-production-deployment.md)
- [Kubernetes 平台最小权限护栏](./06-kubernetes-platform-guardrails.md)
- [生产平台准入证据](./07-production-platform-intake.md)

## 完成定义

仓库交付完成仅代表契约、验证器和受保护工作流具备执行条件。Phase 6 业务完成还必须满足：

1. 三次生产等价全量演练均在 8 小时内完成，记录、权限、金额、附件和校验和未解释差异为零。
2. 一次覆盖数据、身份、网关、外部集成、队列和 MCP 的生产级回滚演练在 4 小时内完成。
3. 十二类 Go/No-Go Gate 仍在有效期内，发布 commit、镜像摘要和部署清单与现场一致。
4. 统一切换每一步均有不同操作人与复核人的证据，五方使用不同角色密钥签署同一
   切换终态，旧系统写入冻结后保持只读。
5. 连续 28 个自然日完成核心 SLO、七域每日对账和事故审查，法务、财务、数据
   负责人使用三个不同角色密钥批准归档。

任何一项缺失时，Issue #14、#37、#38、#39 或 #40 不得关闭。
