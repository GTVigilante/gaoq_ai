# Phase 6 生产平台准入证据

## 1. 目的

生产部署除 Go/No-Go 业务证据外，还必须证明承载平台本身已就绪。
`scripts/release/validate-phase-6-platform-intake.mjs` 对外部生成的原始 JSON
执行失败关闭校验，并在 Plan 与 Apply 两个独立 GitHub Hosted Job 上重复执行。
任何缺失、过期、漂移或摘要不一致都会停止发布。

这份证据只保存不可逆主体哈希、证据哈希和非敏感标识，不保存密码、token、私钥、连接串、证书正文、个人姓名或服务端点。明文凭据只能由企业 Secret Manager 管理。

## 2. 强制范围

原始证据 `suite` 固定为 `gaoq.phase6.production-platform-intake.v2`，必须包含：

- 发布绑定：默认分支 commit、部署包摘要、平台护栏渲染摘要和当前验证器摘要。
- Kubernetes：生产 Region、受支持版本、独立的平台管理/Helm 控制/ERP 业务命名空间。
- 身份与控制：短期 OIDC、不同 Plan/Apply Group、凭据不超过 15 分钟、无 ServiceAccount token；Pod Security Restricted、失败关闭准入、默认拒绝网络、server-side dry-run、Secret 读取拒绝和漂移检测均已实测。
- GitHub：默认分支 `main`；Plan/Apply 两个独立 workflow/policy；Apply 至少两名
  外部签名审批人；两个独立短生命周期 GitHub Hosted `ubuntu-latest` Job
  分别绑定证据读取和 Kubernetes 两类 audience 哈希，四个 audience 两两按用途/
  policy 隔离，均无 GitHub Secret 或 Kubernetes Secret 读取权限。
- 九类平台服务：MongoDB、Redis、KMS、Secret Manager、WORM、镜像仓库、Ingress、HTTPS Egress 和可观测平台均为 ready，并具备私网连接、TLS、静态加密、多可用区、恢复验证和审计证据。
- 六方审批：变更、合规、数据、平台、安全、SRE 由六个不同主体批准，全部绑定
  独立证据哈希、不同 Ed25519 公钥和独立签名；复用公钥、角色换签或缺少任一
  签名均失败关闭。
- 最终决定：`READY`，晚于全部审批，不超过 72 小时，并在部署时仍有效。

每个 `signingAuthorities[]` 条目包含角色、`Ed25519`、公钥 SPKI DER 的
Base64 编码及 `keyId`；`keyId` 必须等于该 DER 字节的 SHA-256。六个
角色/keyId 按角色排序后的规范 JSON 摘要形成 `signerKeysetHash`，并与
Repository Variable
`PHASE6_DEPLOYMENT_PLATFORM_INTAKE_SIGNER_KEYSET_SHA256` 精确匹配。

签名分两层绑定：

1. 公共准入 payload 使用 RFC 8785 兼容的已校验整数子集规范化，覆盖版本、
   `suite`、准入 ID、评估时间、发布源、集群、GitHub、九类服务、六份无签名
   审批元数据、最终决定和 `signerKeysetHash`；
2. 每个角色分别签署签名 `suite`、公共 payload 摘要、自身角色、`keyId` 和
   `signedAt`。签署时间不得早于最终决定，必须早于证据过期时间，且不得超过
   校验时钟五分钟容差。

因此，任何控制、审批元数据、最终决定、公钥集合或签署角色的变化都会使签名
失效。字段、顺序、编码、签名 payload 和当前验证器摘要由以下机器可读命令输出：

```bash
pnpm release:phase6:platform-intake:print-contract
```

## 3. 生成和保管

1. 平台、安全、数据和合规团队从各控制面导出原始报告，将完整报告写入企业 WORM。`guardrailsManifestHash` 必须取安装后 `helm get manifest` 输出的原始 UTF-8 字节 `sha256`，并与同一时点的集群漂移报告共同留存。
2. 证据聚合器只抽取布尔结论、非敏感标识和 `sha256` 引用，生成 JSON；禁止人工把失败改成 ready。
3. 六名审批人先分别核对目标 commit、Chart 渲染、集群、GitHub
   workflow/policy、Hosted Runner、Plan/Apply audience 和服务证据，记录
   不同主体与不同证据摘要；聚合器在六方批准后形成最终 `READY` 决定。
4. 变更、合规、数据、平台、安全和 SRE 六个角色必须通过企业 IAM/KMS 各自控制
   的不同 Ed25519 私钥，对同一最终准入 payload 独立签名。私钥不得由聚合器、
   GitHub 或另一个审批角色代持；人员、职责和角色密钥绑定必须另存 WORM 审计。
5. 聚合文件不得超过 512 KiB，由受控 HTTPS 证据网关仅向匹配当前仓库 ID、
   commit、workflow、policy、audience 与 Hosted Runner claims 的 GitHub
   OIDC 主体返回；网关不得返回原始报告或凭据。
6. 原始文件的 `sha256` 写入 Repository Variable
   `PHASE6_DEPLOYMENT_PLATFORM_INTAKE_SHA256`，Plan/Apply 使用同一值；URL 写入
   `PHASE6_DEPLOYMENT_PLATFORM_INTAKE_URL`。批准角色/keyId 集合摘要写入
   `PHASE6_DEPLOYMENT_PLATFORM_INTAKE_SIGNER_KEYSET_SHA256`，Plan/Apply
   必须使用同一批准值。

本地或隔离环境校验：

```bash
pnpm release:phase6:platform-intake:validate-evidence -- <证据文件>
```

生产工作流还会以 `--enforce-environment` 绑定当前 commit、部署包、护栏清单
摘要、Region、Kubernetes minor、三个命名空间、OIDC Group、GitHub policy
、当前 Kubernetes audience 和六角色 signer keyset；单独运行基础校验不能
替代生产绑定。

## 4. 失效与重新评审

发生以下任一变化必须重新生成全部证据并重新审批：commit/部署包/护栏清单变化，
集群版本或 Region 变化，OIDC issuer/Group/audience/代理策略变化，三个命名空间
变化，workflow/policy/审批人/角色密钥/Hosted Runner 镜像变化，平台服务拓扑
或恢复状态变化，任何控制失败，或 72 小时有效期届满。

证据校验器的自测使用临时测试密钥，只证明规则能拒绝篡改、伪签名、复用公钥、
角色换签和 keyset 漂移，不证明真实平台 ready，也不证明 keyId 背后是真实责任人。
平台准入不注册 MCP Tool，AI 只能读取脱敏 verdict；配置 OIDC 策略、授予集群
权限、管理角色私钥、审批和生产发布仍是 R3 人工治理动作。

## 5. 当前状态

当前仓库已交付 GitHub Hosted 工作流和 OIDC 客户端门禁，但没有目标生产集群、
两类 GitHub workflow/policy、证据/凭据代理信任、OIDC Group、平台服务证据、
六方真实角色密钥或独立签名，因此无法生成真实 `READY` 文件。工作流保持外部
阻塞，Issue #12、#35 和 #38 不得关闭。
