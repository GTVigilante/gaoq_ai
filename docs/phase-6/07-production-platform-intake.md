# Phase 6 生产平台准入证据

## 1. 目的

生产部署除 Go/No-Go 业务证据外，还必须证明承载平台本身已就绪。`scripts/release/validate-phase-6-platform-intake.mjs` 对外部生成的原始 JSON 执行失败关闭校验，并在部署 Plan 与 Apply 两个隔离 Runner 上重复执行。任何缺失、过期、漂移或摘要不一致都会停止发布。

这份证据只保存不可逆主体哈希、证据哈希和非敏感标识，不保存密码、token、私钥、连接串、证书正文、个人姓名或服务端点。明文凭据只能由企业 Secret Manager 管理。

## 2. 强制范围

原始证据 `suite` 固定为 `gaoq.phase6.production-platform-intake.v1`，必须包含：

- 发布绑定：默认分支 commit、部署包摘要、平台护栏渲染摘要和当前验证器摘要。
- Kubernetes：生产 Region、受支持版本、独立的平台管理/Helm 控制/ERP 业务命名空间。
- 身份与控制：短期 OIDC、不同 Plan/Apply Group、凭据不超过 60 分钟、无 ServiceAccount token；Pod Security Restricted、失败关闭准入、默认拒绝网络、server-side dry-run、Secret 读取拒绝和漂移检测均已实测。
- GitHub：默认分支 `main`；Plan/Apply 两个受保护 Environment；Apply 至少两名 Required Reviewers；两组独立短生命周期 Runner 具备精确标签且无 Secret 读取权限。
- 九类平台服务：MongoDB、Redis、KMS、Secret Manager、WORM、镜像仓库、Ingress、HTTPS Egress 和可观测平台均为 ready，并具备私网连接、TLS、静态加密、多可用区、恢复验证和审计证据。
- 六方审批：变更、合规、数据、平台、安全、SRE 由六个不同主体批准，全部绑定独立证据哈希。
- 最终决定：`READY`，晚于全部审批，不超过 72 小时，并在部署时仍有效。

字段的当前固定枚举和验证器摘要由以下命令输出：

```bash
pnpm release:phase6:platform-intake:print-contract
```

## 3. 生成和保管

1. 平台、安全、数据和合规团队从各控制面导出原始报告，将完整报告写入企业 WORM。`guardrailsManifestHash` 必须取安装后 `helm get manifest` 输出的原始 UTF-8 字节 `sha256`，并与同一时点的集群漂移报告共同留存。
2. 证据聚合器只抽取布尔结论、非敏感标识和 `sha256` 引用，生成 JSON；禁止人工把失败改成 ready。
3. 独立审批人核对目标 commit、Chart 渲染、集群、GitHub Environment、Runner 和服务证据后签署。
4. 聚合文件作为普通文件只读挂载到 `/var/lib/gaoq/platform/phase-6-platform-intake.json`，不得是符号链接、不得超过 512 KiB、组和其他用户不可写。
5. 原始文件的 `sha256` 写入两个 GitHub Environment 的 `PHASE6_DEPLOYMENT_PLATFORM_INTAKE_SHA256`，值必须一致。

本地或隔离环境校验：

```bash
pnpm release:phase6:platform-intake:validate-evidence -- <证据文件>
```

生产工作流还会以 `--enforce-environment` 绑定当前 commit、部署包、护栏清单摘要、Region、Kubernetes minor、三个命名空间和 OIDC Group；单独运行基础校验不能替代生产绑定。

## 4. 失效与重新评审

发生以下任一变化必须重新生成全部证据并重新审批：commit/部署包/护栏清单变化，集群版本或 Region 变化，OIDC issuer/Group 变化，三个命名空间变化，Environment/Reviewer/Runner 变化，平台服务拓扑或恢复状态变化，任何控制失败，或 72 小时有效期届满。

证据校验器的自测仅证明规则能拒绝构造的坏样本，不证明真实平台 ready。平台准入不注册 MCP Tool，AI 只能读取脱敏 verdict；创建 Environment、授予集群权限、审批和生产发布仍是 R3 人工治理动作。

## 5. 当前状态

当前仓库没有目标生产集群、两类 GitHub Environment/self-hosted Runner、OIDC Group、平台服务证据或六方审批，因此无法生成真实 `READY` 文件。工作流保持不可执行，Issue #12、#35 和 #38 不得关闭。
