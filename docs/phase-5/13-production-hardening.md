# Phase 5 生产加固与 Go/No-Go 证据

- 文档编号：phase-5/13
- 状态：供应链、生产镜像、容量、DAST/ASVS 及韧性工具门禁已实现；真实容量、安全和韧性实测仍待完成

## 安全与供应链门禁

所有 Pull Request 执行冻结锁文件安装、生产依赖许可证审查、Bearer SAST、Gitleaks 完整 Git 历史 Secret Scan、`pnpm audit`、Trivy 文件系统扫描，并生成保留 30 天的 SPDX JSON SBOM。High/Critical 依赖漏洞和扫描发现均阻断；GitHub Action 必须固定到 40 位 commit SHA，检出步骤不保留写凭据。Bearer 与 Gitleaks CLI 均固定版本并验证官方发布包 SHA-256，不执行远端浮动安装脚本。

当前仓库为未启用 GitHub Advanced Security 的私有仓库，GitHub 官方 Dependency Review Action 会直接拒绝执行。因此许可证和漏洞策略使用仓库内可复现的 pnpm 清单门禁实现，拒绝 GPL-3.0、AGPL-3.0、未声明或无法识别的生产依赖许可证；不得以平台能力不足为由跳过门禁。若后续启用 GitHub Advanced Security，可叠加官方 Dependency Review，但仓库内门禁仍作为可移植基线保留。

Dependabot 每周分别检查 pnpm/npm 依赖与 GitHub Actions。许可证门禁拒绝 GPL-3.0 与 AGPL-3.0；例外必须由法务、安全和架构共同批准并形成可追踪 ADR，禁止在工作流中静默降级为警告。

2026-07-22 供应链盘点发现 Next.js 间接依赖 `sharp 0.34.5` 命中 High 级 GHSA-f88m-g3jw-g9cj。仓库以精确 override 固定 `sharp 0.35.3`，`pnpm audit --audit-level high` 与 Next.js production build 已通过。Next.js 原生依赖范围升级后应移除 override 并重新执行完整门禁。

## 后续生产门禁

API、Worker、Web 已有固定摘要、distroless、nonroot 的生产镜像目标；每个 PR 分别构建最终镜像、生成 SPDX JSON SBOM 并以 Trivy 阻断 High/Critical 漏洞。构建和验证细则见[生产镜像构建与验证运行手册](./14-production-images-runbook.md)。正式仓库推送、镜像签名、SLSA provenance 与准入策略仍待 CD 平台接入。

1000 并发只读 API、1000 人工资计算和三次可比证据的脚本与校验契约见[性能容量三次实测门禁](./15-performance-capacity-gate.md)。现场证据只能由受保护的 `phase-5-performance` Environment 和隔离单次 Runner 验收；工具交付不代替生产等价环境的三次真实执行。

二十六个迁移 Scope、三轮七十八个运行与三类故障演练的聚合证据由[数据迁移三次演练证据门禁](./12-data-migration-rehearsal-gate.md)验收。只有受保护的 `phase-5-migration-rehearsal` Environment 可以生成供 Go/No-Go 消费的 migration verdict；单 Scope 比较通过不能替代全链路验收。

ZAP 主动扫描、OWASP ASVS 5.0.0 L2/L3 证据与四方签署契约见[DAST 与 ASVS 5.0.0 证据门禁](./16-dast-asvs-gate.md)。工作流只能由受保护的 `phase-5-dast` GitHub Environment 在隔离测试租户执行，不允许扫描生产流量。

MongoDB 时间点恢复、Redis/BullMQ 重建、对象/WORM 与 KMS 验证、旧系统回滚及八类外部连接两小时断连追赶契约见[容灾恢复与外部系统断连追赶门禁](./17-resilience-rehearsal-gate.md)。现场证据只能由受保护的 `phase-5-resilience` Environment 和隔离单次 Runner 验收。

工程质量、供应链、生产镜像、权限、业务 UAT、隐私合规和运行保障先由[七类发布就绪 verdict 门禁](./20-readiness-verdicts.md)生成独立证据。全部上线证据的新鲜度、版本绑定、十二类门禁、十方签署和周末八小时切换窗口再由[跨职能 Go/No-Go 证据门禁](./18-go-no-go-evidence-gate.md)统一验收。工作流只生成不可部署的 verdict，不替代人工生产审批。

以下项目尚未完成，因此本文件不构成生产放行：

- 在 CD 平台执行生产镜像签名、SLSA provenance、只读文件系统冒烟、准入与回滚验证；
- 在生产等价环境执行 SAST 之外的 DAST、ASVS L2 与高风险 L3 验证，安全负责人签署；
- 验证 API P95 小于 500ms、1000 并发和 1000 人薪资 5 分钟内完成，保存原始负载结果；
- 在生产等价隔离环境完成 MongoDB、Redis、对象证据、队列和密钥依赖的 RPO 不超过 15 分钟、RTO 不超过 4 小时恢复演练并取得七方签署；
- 对 OP、钉钉、飞书、e签宝、银行、税务、附件网关和 WORM 执行两小时断连与一小时内自动追赶实测；
- 所有严重/高危漏洞为零，完成监控、值班、停止条件、回滚步骤与跨职能 Go/No-Go 签署。

扫描工具不可自动豁免漏洞或许可证；确属误报时必须保存规则版本、受影响组件、不可利用性证据、到期日和复核人。任何超过到期日的例外自动恢复为阻断。

当前 Bearer 仅保留四个精确指纹误报：SSO Client 已在网络调用前执行固定端点 allowlist；ISO 20022 生成器只处理 XML 文本节点，并执行 XML 1.0 字符范围和五实体编码，这两项复核到期日为 2026-10-20；另两项是部署清单验证器中的 Kubernetes Secret 对象引用名称，不包含 Secret 数据或认证材料，复核到期日为 2026-10-23。四项均有回归测试；新增或变更指纹必须重新 CR，禁止通配或整条规则跳过。

Gitleaks 历史扫描只允许五项固定测试假值：两个 WebAuthn 证据 ULID、一个资金授权证据 ULID、一个幂等键和一个指标字段名。配置禁止按路径、Commit 或整条规则跳过；真实格式 Token 即使位于测试文件也必须阻断。

依赖门禁固定 Next.js `16.2.11`，并通过根级 override 固定 PostCSS `8.5.10` 与 `@hono/node-server` `2.0.10`，对应修复 App Router/Server Actions High 风险、CSS stringify XSS、Windows 路径穿越和 WebSocket 握手内存泄漏。安全契约阻止降级，`pnpm audit` 必须保持无已知漏洞。
