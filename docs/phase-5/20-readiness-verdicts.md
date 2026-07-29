# Phase 5 七类发布就绪 verdict 门禁

- 文档编号：phase-5/20
- 状态：证据契约与受保护验收工作流已交付；真实签署与现场证据尚未形成

## 目的

Go/No-Go 不接受“最终表单自报通过”。工程质量、供应链、生产镜像、权限、业务 UAT、隐私合规和运行保障七类证据必须先由独立门禁形成固定 suite 的 verdict；再与迁移、性能、DAST/ASVS、容灾和 MCP 联调五类 verdict 一起进入十二类最终评审。

`gaoq.phase5.readiness.v1` 证据绑定同一 commit、API/Worker/ERP Web/Website 四类镜像 SHA-256、部署清单、生产等价但非生产数据/流量的环境和区域。七类证据各自拥有不可复用的 evidence ID、原始 WORM 摘要、完成/到期时间和角色签署，输出为：

- `gaoq.phase5.engineering-quality.verdict`：lint、类型、单元/集成/契约/E2E、构建、Sev1/Sev2 与阻断 flaky；
- `gaoq.phase5.supply-chain.verdict`：SAST、SCA、Secret Scan、许可证、依赖审计、四类 SBOM、Critical/High 与安全例外；
- `gaoq.phase5.production-images.verdict`：四类镜像摘要、签名、SLSA provenance、SBOM、nonroot、只读根文件系统、健康检查、回滚冒烟与准入策略；
- `gaoq.phase5.authorization.verdict`：至少 200 个权限矩阵用例、至少 50 次跨租户拒绝、字段/数据范围与 MCP R3 为零；
- `gaoq.phase5.business-uat.verdict`：审批影子至少 28 天、薪资影子至少两个完整周期、八域 UAT 与零未解释记录/金额差异；
- `gaoq.phase5.privacy-compliance.verdict`：数据清单、PIA、法定依据、保存删除、授权撤回、隐私发现和跨境传输；
- `gaoq.phase5.operations.verdict`：监控、告警、值班、Runbook、备份、回滚、冻结、事故指挥、支持交接和 28 天 Hypercare 准备。

## 执行与隔离

```bash
pnpm --silent release:readiness:print-contract > /secure/readiness/contract.json
pnpm release:readiness:validate-evidence -- /secure/readiness/phase-5-readiness.json
```

`.github/workflows/phase-5-readiness.yml` 只允许 `main` 手工启动，使用
`phase-5-readiness` workflow policy 和 GitHub Hosted `ubuntu-latest`。
Repository Variables 固定环境、区域、当前 commit、四类镜像、部署清单、
脱敏摘要 HTTPS URL、预期 SHA-256 和专用 OIDC audience。工作流以当前
policy 的单次 GitHub OIDC 身份拉取最多 1 MiB 的严格 JSON，复核传输和
文件摘要后只上传七类脱敏 verdict bundle；原始测试、扫描、业务 UAT、PIA、
签名与生产配置留在企业 WORM。

任一签署缺失、证据过期、版本错配、跨租户成功、未解释差异、隐私发现、未批准跨境传输、未签名镜像、高危漏洞或生产副作用都会失败关闭。该门禁不触发部署、不签署 `GO`，也不向 MCP 注册批准能力。
