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

仓库是 GitHub Free Private Repository，不能把付费 GitHub Environment 或
Required Reviewers 当作可用控制。保护链改为：

1. GitHub Hosted Runner 以 Plan 专用 OIDC policy/audience 取得只读短期身份；
2. Plan 重新验收输入、渲染、Schema、RBAC 与 diff，输出不可变绑定；
3. 企业变更系统由变更负责人和 SRE 两名不同主体复核并签署最长两小时的 Ed25519
   授权；
4. 独立 Apply Runner 以不同 OIDC policy/audience 重新下载输入、重新渲染、验证
   授权和 server-side dry-run，再执行 Helm 原子发布。

该入口不切换 DNS/网关流量、不冻结旧系统、不执行迁移、不创建或读取 Secret 值，
也不执行银行/税务资金动作；统一切换仍按 Phase 6 双人 Runbook 独立执行。

## 2. 身份与集群权限

| 工作流 | OIDC policy | 集群权限 | 人工授权 |
|---|---|---|---|
| Plan | `phase-6-deployment-plan` | release ConfigMap、命名空间和非敏感运行配置只读；禁止 Secret get 与 Deployment create/patch/delete | 平台准入证据已有六方审批；计划产物等待外部复核 |
| Apply | `phase-6-deployment-apply` | 仅管理当前 release 的 namespaced 非 Secret 资源；禁止 Secret get、ClusterRole、护栏和云账号权限 | `change_owner`、`sre_owner` 两名不同主体的 Ed25519 签名授权 |

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
| `PHASE6_DEPLOYMENT_ROLLOUT_ID` | 批准窗口唯一标识 |
| `PHASE6_DEPLOYMENT_*_CONFIG_MAP`、`PHASE6_DEPLOYMENT_*_SECRET` | 四组件八个外部引用名；Runner 不读取 Secret |
| `PHASE6_DEPLOYMENT_GO_NO_GO_ENVIRONMENT`、`PHASE6_DEPLOYMENT_GO_NO_GO_REGION` | 目标环境与 Region |

### 3.3 Apply 授权

| 变量 | 约束 |
|---|---|
| `PHASE6_DEPLOYMENT_AUTHORIZATION_URL`、`PHASE6_DEPLOYMENT_AUTHORIZATION_SHA256` | 外部签名授权 URL 与文件摘要 |
| `PHASE6_DEPLOYMENT_AUTHORIZATION_PUBLIC_KEY_PEM_BASE64` | Ed25519 公钥 PEM 的 Base64；公钥不是秘密 |
| `PHASE6_DEPLOYMENT_AUTHORIZATION_PUBLIC_KEY_SHA256` | Ed25519 SPKI DER SHA-256 |
| `PHASE6_DEPLOYMENT_AUTHORIZED_PLAN_RUN_ID`、`...RUN_ATTEMPT` | 获批 Plan 的 GitHub run |
| `PHASE6_DEPLOYMENT_AUTHORIZED_PLAN_ARTIFACT_SHA256` | 企业 WORM 中计划包摘要 |
| `PHASE6_DEPLOYMENT_CLUSTER_SHA256` | 目标集群不可变身份摘要 |

修改上述任一变量都不会自行授权部署；证据代理仍须从已验签 OIDC claims 作决定，
Apply 还会逐字段验证外部签名文件。

## 4. Plan 产物

Plan 每次重新读取三份输入并执行：

1. Go/No-Go `GO`、24 小时新鲜度、commit、四镜像和部署包绑定；
2. 平台准入 `READY`、当前 policy/workflow、Hosted Runner、audience、RBAC 与六方审批；
3. Helm strict lint、仓库清单检查和固定 schema Kubeconform；
4. 四个 Deployment、八个运行时引用、rollout ID 和 Website 公开配置绑定；
5. 控制/业务命名空间和四个 ConfigMap 存在；Secret get 与 Deployment 写权限被拒绝；
6. 当前 Helm manifest 与拟发布 manifest 的本地 diff。

Artifact 保存脱敏 verdict、渲染清单、diff 和
`gaoq.phase6.deployment-plan-binding.v1`。绑定包含仓库 ID、commit、workflow
ref、run ID/attempt、输入摘要、渲染摘要、部署包摘要和验证器摘要，保存 90 天。
三份下载输入和 kubeconfig 不上传。

## 5. 外部签名授权与 Apply

`gaoq.phase6.deployment-authorization.v1` 必须：

- 绑定上述 Plan run、企业计划包摘要、三份输入、渲染清单、部署包、目标集群、
  环境、Region、release 和两个命名空间；
- 只允许 `APPROVED`，且含两个不同 actor/evidence 的 `change_owner` 与 `sre_owner`；
- 使用 Ed25519 对 RFC 8785 兼容的整数子集规范 JSON 签名；
- `keyId` 等于批准公钥 SPKI 摘要，payload 摘要和文件摘要全部匹配；
- 从签发至过期不超过两小时，Apply 执行时仍有效。

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

代码、本地门禁和工作流已交付，但当前 Hosted Actions 在 Runner 分配前被账户
付款或 Spending limit 状态阻塞；企业证据/凭据代理、Ed25519 签名服务、WORM、
目标集群 OIDC/RBAC 和真实证据也尚未验收。因此当前不得执行或声称生产部署通过。
恢复 GitHub 免费额度/账户状态并完成上述外部配置后，才能运行 Plan、人工签署、
再独立运行 Apply；不得降级为长期密钥、管理员 kubeconfig、NAS 或自托管 Runner。
