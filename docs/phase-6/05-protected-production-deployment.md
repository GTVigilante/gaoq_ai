# Phase 6 GitHub Free 受保护生产部署

## 1. 两个独立入口

生产部署只允许以下默认分支人工入口：

- `.github/workflows/phase-6-deployment-plan.yml`：生成只读计划；
- `.github/workflows/phase-6-deployment-apply.yml`：验收外部双人签名授权后执行。

两个工作流均只接受 `workflow_dispatch`，不接受 PR、push、`workflow_call`、
`workflow_run` 或业务输入。它们没有 `needs` 关系，Plan 不能自动触发 Apply。
MCP、AI 客户端和业务服务均无触发或绕过权限。

两个入口均使用 GitHub Hosted `ubuntu-latest`；Plan 专用 OIDC audience 与
Apply 专用 OIDC audience 必须按 workflow/policy 分离。

仓库当前是 GitHub Free Public Repository；生产保护不把可变的仓库可见性、
套餐能力或 Environment/Required Reviewers 当作唯一控制。保护链为：

1. GitHub Hosted Runner 以 Plan 专用 OIDC policy/audience 取得只读短期身份；
2. Plan 重新验收输入、渲染、Schema、RBAC 与 diff，输出不可变绑定；
3. 企业变更系统由变更负责人和 SRE 两名不同主体复核并签署最长两小时的 Ed25519
   授权；两人必须使用不同的批准密钥；
4. 独立 Apply Runner 以不同 OIDC policy/audience 重新下载输入、重新渲染、验证
   授权和 server-side dry-run，再执行 Helm 原子发布。

该入口不切换 DNS/网关流量、不冻结旧系统、不执行迁移、不创建或读取 Secret 值，
也不执行银行/税务资金动作；统一切换仍按 Phase 6 双人 Runbook 独立执行。

## 2. 身份与集群权限

| 工作流 | OIDC policy | 集群权限 | 人工授权 |
|---|---|---|---|
| Plan | `phase-6-deployment-plan` | release ConfigMap、命名空间和非敏感运行配置只读；禁止 Secret get 与 Deployment create/patch/delete | 平台准入证据已有六方独立 Ed25519 签名；计划产物等待外部复核 |
| Apply | `phase-6-deployment-apply` | 仅管理当前 release 的 namespaced 非 Secret 资源；禁止 Secret get、ClusterRole、护栏和云账号权限 | `change_owner`、`sre_owner` 两名不同主体、不同批准密钥的 Ed25519 独立签名 |

每次执行均由 GitHub 分配全新 `ubuntu-latest` Runner，不复用 kubeconfig、工作目录
或缓存。工作流下载并校验固定摘要的 Helm `v4.2.0+g0646808`、Kubeconform
`v0.7.0`、kubectl `v1.30.12` 和固定 Kubernetes 1.30 schema commit。

命名空间、OIDC Group RBAC、ResourceQuota、LimitRange 和
ValidatingAdmissionPolicy 必须由独立集群管理员预装并通过正反例；应用工作流
不能修改这些边界。

## 3. Repository Variables

以下均为非敏感 Repository Variables；私钥、Token、连接串和管理员 kubeconfig
不得写入仓库、Variables 或 Secrets。

### 3.1 输入与 OIDC

| 变量 | 约束 |
|---|---|
| `PHASE6_DEPLOYMENT_PLAN_INPUT_OIDC_AUDIENCE` | Plan 证据 audience，Origin 与证据代理相同，path 尾段为 Plan policy |
| `PHASE6_DEPLOYMENT_APPLY_INPUT_OIDC_AUDIENCE` | Apply 独占证据 audience，不得与 Plan 相同 |
| `PHASE6_DEPLOYMENT_VALUES_URL`、`PHASE6_DEPLOYMENT_VALUES_SHA256` | 非敏感生产 values URL 与摘要 |
| `PHASE6_DEPLOYMENT_GO_NO_GO_URL`、`PHASE6_DEPLOYMENT_GO_NO_GO_SHA256` | Go/No-Go 脱敏证据 URL 与摘要 |
| `PHASE6_DEPLOYMENT_PLATFORM_INTAKE_URL`、`PHASE6_DEPLOYMENT_PLATFORM_INTAKE_SHA256` | 平台准入证据 URL 与摘要 |
| `PHASE6_DEPLOYMENT_PLAN_KUBERNETES_OIDC_AUDIENCE` | Plan Kubernetes audience |
| `PHASE6_DEPLOYMENT_APPLY_KUBERNETES_OIDC_AUDIENCE` | Apply Kubernetes audience，不得与 Plan 相同 |
| `PHASE6_KUBERNETES_CREDENTIAL_URL` | OIDC → ExecCredential 代理固定 HTTPS URL |
| `PHASE6_KUBERNETES_SERVER` | Kubernetes API 固定 HTTPS Origin |
| `PHASE6_KUBERNETES_CA_BASE64`、`PHASE6_KUBERNETES_CA_SHA256` | 公共集群 CA 与批准摘要 |

### 3.2 发布绑定

| 变量 | 约束 |
|---|---|
| `PHASE6_DEPLOYMENT_RELEASE_NAME` | 唯一 Helm release DNS label |
| `PHASE6_DEPLOYMENT_CONTROL_NAMESPACE` | 仅保存非敏感 Helm release ConfigMap |
| `PHASE6_DEPLOYMENT_TARGET_NAMESPACE` | ERP 业务命名空间，与控制命名空间不同 |
| `PHASE6_DEPLOYMENT_PLATFORM_NAMESPACE` | 平台护栏命名空间 |
| `PHASE6_DEPLOYMENT_KUBECTL_VERSION` | 批准的精确客户端版本 |
| `PHASE6_DEPLOYMENT_PLAN_GROUP`、`PHASE6_DEPLOYMENT_APPLY_GROUP` | 不同的最小 RBAC Group |
| `PHASE6_DEPLOYMENT_GUARDRAILS_MANIFEST_SHA256` | 已审批护栏摘要 |
| `PHASE6_DEPLOYMENT_*_IMAGE_DIGEST` | API、Worker、Web、Website 四个固定镜像摘要 |
| `PHASE6_DEPLOYMENT_MANIFEST_SHA256` | 非自引用部署包摘要 |
| `PHASE6_DEPLOYMENT_WEBSITE_PUBLIC_CONFIG_SHA256` | Website 公开配置摘要 |
| `PHASE6_DEPLOYMENT_API_CONFIG_SHA256`、`PHASE6_DEPLOYMENT_WORKER_CONFIG_SHA256` | 两个不可变非敏感 ConfigMap 的规范 JSON 摘要 |
| `PHASE6_DEPLOYMENT_RUNTIME_CONTRACT_SHA256` | 绑定两份配置、专业算薪 Resource/事件契约与平台契约版本的规范摘要 |
| `PHASE6_DEPLOYMENT_ROLLOUT_ID` | 批准窗口唯一标识 |
| `PHASE6_DEPLOYMENT_*_CONFIG_MAP`、`PHASE6_DEPLOYMENT_*_SECRET` | 四组件八个外部引用名；Runner 不读取 Secret |
| `PHASE6_DEPLOYMENT_GO_NO_GO_ENVIRONMENT`、`PHASE6_DEPLOYMENT_GO_NO_GO_REGION` | 目标环境与 Region |
| `PHASE6_DEPLOYMENT_GO_NO_GO_SIGNER_KEYSET_SHA256` | Phase 5 十方 Ed25519 公钥角色/keyId 规范集合摘要；Plan 与 Apply 都重新绑定 |
| `GO_NO_GO_PAYROLL_RESOURCE`、`GO_NO_GO_PAYROLL_AUTHORIZATION_SERVER`、`GO_NO_GO_PAYROLL_IMAGE_DIGEST`、`GO_NO_GO_PAYROLL_CONTRACT_HASH`、`GO_NO_GO_PAYROLL_CATALOG_HASH` | Phase 5 已批准的独立专业算薪边界；Phase 6 重验时不得缺失或漂移 |
| `PHASE6_DEPLOYMENT_PLATFORM_INTAKE_SIGNER_KEYSET_SHA256` | Phase 6 平台准入六方 Ed25519 公钥角色/keyId 规范集合摘要；Plan 与 Apply 都重新绑定 |

### 3.3 Apply 授权

| 变量 | 约束 |
|---|---|
| `PHASE6_DEPLOYMENT_AUTHORIZATION_URL`、`PHASE6_DEPLOYMENT_AUTHORIZATION_SHA256` | 外部签名授权 URL 与文件摘要 |
| `PHASE6_DEPLOYMENT_AUTHORIZATION_SIGNER_KEYSET_SHA256` | `change_owner`、`sre_owner` 的角色/keyId 规范集合摘要；公钥由授权证据携带并按摘要绑定 |
| `PHASE6_DEPLOYMENT_AUTHORIZED_PLAN_RUN_ID`、`...RUN_ATTEMPT` | 获批 Plan 的 GitHub run |
| `PHASE6_DEPLOYMENT_AUTHORIZED_PLAN_ARTIFACT_SHA256` | 企业 WORM 中计划包摘要 |
| `PHASE6_DEPLOYMENT_CLUSTER_SHA256` | 目标集群不可变身份摘要 |

修改上述任一变量都不会自行授权部署；证据代理仍须从已验签 OIDC claims 作决定，
Apply 还会逐字段验证外部签名文件。

## 4. Plan 产物

Plan 每次重新读取三份输入并执行：

1. Go/No-Go `GO`、24 小时新鲜度、commit、四镜像、部署包、十方独立
   Ed25519 签名和批准 signer keyset 绑定；
2. 平台准入 `READY`、当前 policy/workflow、Hosted Runner、audience、RBAC、
   六方独立 Ed25519 签名和批准 signer keyset 绑定；
3. Helm strict lint、仓库清单检查和固定 schema Kubeconform；
4. 四个 Deployment、八个运行时引用、rollout ID、Website 公开配置以及
   API/Worker 配置与运行契约摘要绑定；
5. API/Worker ConfigMap 必须不可变、无敏感键，显式启用生产和专业算薪外置
   模式；API OAuth 额外 Resource 必须包含当前 Go/No-Go 专业算薪 Resource；
6. 控制/业务命名空间和四个 ConfigMap 存在；Secret get 与 Deployment 写权限被拒绝；
7. 当前 Helm manifest 与拟发布 manifest 的本地 diff。

Artifact 保存 Go/No-Go、平台准入、运行配置、部署计划等脱敏 verdict、渲染清单、diff 和
`gaoq.phase6.deployment-plan-binding.v1`。绑定包含仓库 ID、commit、workflow
ref、run ID/attempt、输入摘要、渲染摘要、部署包摘要和验证器摘要，保存 90 天。
三份下载输入和 kubeconfig 不上传。

## 5. 外部签名授权与 Apply

`gaoq.phase6.deployment-authorization.v2` 必须：

- 绑定上述 Plan run、企业计划包摘要、三份输入、渲染清单、部署包、目标集群、
  环境、Region、release 和两个命名空间；
- 只允许 `APPROVED`，且含两个不同 actor/evidence 的 `change_owner` 与 `sre_owner`；
- 两个角色各自使用独立 Ed25519 公钥对同一 RFC 8785 兼容规范授权 payload
  签名；复用公钥、角色换签或任一签名缺失均失败关闭；
- 每个 `keyId` 等于对应公钥 SPKI DER 摘要，完整角色/keyId 集合还必须等于
  Repository Variable 固定的批准 keyset 摘要；
- 每份签名覆盖公共授权 payload 摘要、角色、keyId 与签署时间，payload 摘要和
  文件摘要全部匹配；
- 从签发至过期不超过两小时，Apply 执行时仍有效。

机器可读字段、排序、编码与签名 payload 可通过
`pnpm --silent release:phase6:deployment-authorization:print-contract` 查询。
运行配置规范与摘要输入可通过
`pnpm --silent release:phase6:runtime-config:print-contract` 查询。
平台负责人可对 `kubectl get configmap --output json` 的两份只读导出执行
`--calculate` 生成三个摘要，再写入受控 values 与 Repository Variables；计算
时仍须提供当前 Go/No-Go 的专业算薪 Resource 和事件契约摘要，禁止手工拼接。
该密码学校验只能证明证据由批准角色的私钥签署；真实人员身份、职责与角色密钥的
绑定仍必须由企业 IAM/KMS 和 WORM 签署审计证明。

Apply 用独立 OIDC policy 重取四份输入，重新渲染后才验签，以防计划后漂移。通过
后执行 server-side dry-run，并只运行：

```bash
HELM_DRIVER=configmap helm upgrade --install <release> deploy/helm/gaoq-erp \
  --namespace <控制命名空间> --values <只读 values> \
  --atomic --wait --timeout 15m --history-max 10
```

禁止 `--force`、`--reuse-values`、`--set`、自动创建 namespace、delete、uninstall
或自动 rollback 指令。`--atomic` 只处理本次 Helm 失败；业务回滚仍走人工 Runbook。

## 6. 当前阻断

代码、本地门禁和工作流已交付，2026-08-01 的 `main` Hosted Actions 已实际通过
Phase 1、Phase 5 和文档门禁。企业证据/凭据代理、Ed25519 签名服务、WORM、
目标集群 OIDC/RBAC 和真实证据仍未验收，因此当前不得执行或声称生产部署通过。
完成上述外部配置后，才能运行 Plan、人工签署、再独立运行 Apply；不得降级为
长期密钥、管理员 kubeconfig、NAS 或自托管 Runner。
