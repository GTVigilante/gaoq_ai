# Phase 5 七类发布就绪 verdict 门禁

- 文档编号：phase-5/20
- 状态：证据契约与受保护验收工作流已交付；真实签署与现场证据尚未形成

## 目的

Go/No-Go 不接受“最终表单自报通过”。工程质量、供应链、生产镜像、权限、业务 UAT、隐私合规和运行保障七类证据必须先由独立门禁形成固定 suite 的 verdict；再与迁移、性能、DAST/ASVS、容灾和 MCP 联调五类 verdict 一起进入十二类最终评审。

`gaoq.phase5.readiness.v2` 证据绑定同一 commit、API/Worker/ERP Web/Website
四类镜像 SHA-256、部署清单、生产等价但非生产数据/流量的环境和区域。七类证据
各自拥有不可复用的 evidence ID、原始 WORM 摘要、完成/到期时间和密码学可验证
的角色签署，输出为：

- `gaoq.phase5.engineering-quality.verdict`：lint、类型、单元/集成/契约/E2E、构建、Sev1/Sev2 与阻断 flaky；
- `gaoq.phase5.supply-chain.verdict`：SAST、SCA、Secret Scan、许可证、依赖审计、四类 SBOM、Critical/High 与安全例外；
- `gaoq.phase5.production-images.verdict`：四类镜像摘要、签名、SLSA provenance、SBOM、nonroot、只读根文件系统、健康检查、回滚冒烟与准入策略；
- `gaoq.phase5.authorization.verdict`：至少 200 个权限矩阵用例、至少 50 次跨租户拒绝、字段/数据范围与 MCP R3 为零；
- `gaoq.phase5.business-uat.verdict`：审批影子至少 28 天、薪资影子至少两个完整周期、八域 UAT 与零未解释记录/金额差异；
- `gaoq.phase5.privacy-compliance.verdict`：数据清单、PIA、法定依据、保存删除、授权撤回、隐私发现和跨境传输；
- `gaoq.phase5.operations.verdict`：监控、告警、值班、Runbook、备份、回滚、冻结、事故指挥、支持交接和 28 天 Hypercare 准备。

## 独立签署

七类 Gate 合计使用 13 个治理角色：架构、变更、工程、财务、HR、法务、平台、
隐私、产品、QA、安全、SRE 和支持负责人，并分别使用独立 Ed25519 密钥。输入
顶层 `signingAuthorities[]` 必须逐角色声明 `Ed25519`、`keyId` 和 SPKI DER
公钥；13 个公钥不得复用，
`keyId` 必须等于对应公钥 DER 的 SHA-256。规范排序后的完整
`{role,keyId}` 集合摘要必须与 Repository Variable
`READINESS_SIGNER_KEYSET_SHA256` 完全一致，证据自带公钥不能自行建立信任。

每个 Gate 的签署共同覆盖：

- v2 契约、总证据 ID、Gate 名称、环境、commit、四镜像、部署清单和验证器摘要；
- 该 Gate 的全部量化结果、原始 WORM 摘要、完成与到期时间；
- 各签署人的角色、不可逆主体摘要、批准决定、独立证据 ID/摘要和批准时间；
- 完整 13 角色 keyset 摘要。

每份签名再绑定 `gaoq.phase5.readiness.signoff.v1`、Gate payload 摘要、自身角色、
keyId 和签署时间，签署不得早于批准、不得晚于评估且最长相隔 24 小时；编码固定
为 64 字节 Ed25519 签名的无填充 base64url。同一角色跨 Gate 必须保持同一
主体和角色密钥；不同角色不得复用主体、公钥、证据或签名。伪造签名、签后篡改、
角色换钥、主体漂移、keyset 漂移或未来签署均失败关闭。

密码学验签只证明批准角色密钥签署了指定载荷。企业 IAM/KMS 仍须把私钥使用权
绑定到对应在职责任人，启用强认证、轮换、离职撤权和 WORM 审计；私钥不得进入
GitHub、仓库、Variables、Secrets、命令行或 AI 上下文。

## 执行与隔离

```bash
pnpm --silent release:readiness:print-contract > /secure/readiness/contract.json
pnpm release:readiness:validate-evidence -- /secure/readiness/phase-5-readiness.json
```

`.github/workflows/phase-5-readiness.yml` 只允许 `main` 手工启动，使用
`phase-5-readiness` workflow policy 和 GitHub Hosted `ubuntu-latest`。
Repository Variables 固定环境、区域、当前 commit、四类镜像、部署清单、
签署角色 keyset 摘要、脱敏摘要 HTTPS URL、预期 SHA-256 和专用 OIDC
audience。工作流以当前
policy 的单次 GitHub OIDC 身份拉取最多 1 MiB 的严格 JSON，复核传输和
文件摘要后只上传七类脱敏 verdict bundle；原始测试、扫描、业务 UAT、PIA、
签名与生产配置留在企业 WORM。

任一签署缺失或验签失败、证据过期、版本错配、跨租户成功、未解释差异、隐私
发现、未批准跨境传输、未签名镜像、高危漏洞或生产副作用都会失败关闭。该门禁
不触发部署、不签署 `GO`，也不向 MCP 注册批准能力。
