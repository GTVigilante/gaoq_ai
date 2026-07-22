# Phase 6 受保护生产部署工作流

## 1. 控制目标

`.github/workflows/phase-6-deployment.yml` 是 GaoQ-OS 唯一仓库级生产部署入口。它只接受默认分支的人工 `workflow_dispatch`，不接受 PR、push、复用工作流或调用方输入；MCP、AI 客户端和业务服务均不能触发。

执行链分为三个不可合并的职责域：

1. 公共 Runner 只执行仓库契约自测，不接触集群或生产证据。
2. `phase-6-deployment-plan` 隔离 Runner 使用只读集群身份，重新验收 Go/No-Go 原始证据，渲染并校验清单，检查外部 ConfigMap，并把现有 Helm manifest 与拟发布 manifest 做本地 diff；它不能执行 server-side dry-run，因为该操作需要 Kubernetes 写权限。
3. `phase-6-deployment-apply` 独立单次 Runner 只有在 `phase-6-production-deployment` Required Reviewers 批准后启动；它重新验收全部绑定、重新渲染并比对计划摘要，再执行 server-side dry-run、Helm 原子发布和只读 rollout 验证。

该工作流部署 ERP 工作负载，但不切换 DNS/网关流量、不冻结旧系统、不执行迁移、不创建或读取 Secret 值，也不执行银行/税务资金动作。统一切换仍按 Phase 6 双人 Runbook 独立执行。

## 2. GitHub 保护环境

仓库所有者必须创建两个 Environment，且当前仓库未创建时工作流保持不可执行：

| Environment | Runner 标签 | 集群权限 | 审批要求 |
|---|---|---|---|
| `phase-6-production-plan` | `self-hosted,linux,x64,phase-6-deployment-plan` | 控制命名空间 release ConfigMap 与业务命名空间非敏感资源只读；工作流主动证明无 Deployment create/patch/delete 和 Secret get 权限 | 平台与安全负责人复核运行条件 |
| `phase-6-production-deployment` | `self-hosted,linux,x64,phase-6-deployment-apply` | 控制命名空间仅管理 Helm release ConfigMap；独立业务命名空间只允许管理本 release 的 namespaced 非 Secret 资源；禁止 Secret 读取、ClusterRole 和云账号权限 | 至少两名独立 Required Reviewers，包含变更负责人和 SRE |

两个 Runner 必须是不同的短生命周期执行器，不能复用 kubeconfig、工作目录或缓存。Runner 镜像预装 Helm `v4.2.0+g0646808`、Kubeconform `v0.7.0`、受支持的精确 kubectl 版本，以及固定 commit `987aa4ee419358d6ae108f54f6c42f4e90f22b70` 的 Kubernetes 1.30 strict schema。工具链供应链证明进入企业 WORM。

## 3. Environment Variables

以下变量必须在两个 Environment 中独立配置且值完全一致；它们不包含密钥：

| 变量 | 约束 |
|---|---|
| `PHASE6_DEPLOYMENT_RELEASE_NAME` | Kubernetes DNS label，Helm release 唯一名称 |
| `PHASE6_DEPLOYMENT_CONTROL_NAMESPACE` | 只保存非敏感 Helm release ConfigMap 的独立控制命名空间 |
| `PHASE6_DEPLOYMENT_TARGET_NAMESPACE` | 预创建且已启用 Restricted Pod Security 的 ERP 业务命名空间，必须与控制命名空间不同 |
| `PHASE6_DEPLOYMENT_KUBECTL_VERSION` | Runner 上精确 `gitVersion`，由平台兼容矩阵批准 |
| `PHASE6_DEPLOYMENT_API_IMAGE_DIGEST` | API 镜像 `sha256` 摘要 |
| `PHASE6_DEPLOYMENT_WORKER_IMAGE_DIGEST` | Worker 独立镜像 `sha256` 摘要 |
| `PHASE6_DEPLOYMENT_WEB_IMAGE_DIGEST` | Web 独立镜像 `sha256` 摘要 |
| `PHASE6_DEPLOYMENT_MANIFEST_SHA256` | 非自引用部署包清单摘要 |
| `PHASE6_DEPLOYMENT_ROLLOUT_ID` | 批准窗口的唯一 rollout 标识 |
| `PHASE6_DEPLOYMENT_API_CONFIG_MAP` | API 外部 ConfigMap 名称 |
| `PHASE6_DEPLOYMENT_API_SECRET` | API 外部 Secret 名称，只做清单强绑定，不由 Runner 读取 |
| `PHASE6_DEPLOYMENT_WORKER_CONFIG_MAP` | Worker 外部 ConfigMap 名称 |
| `PHASE6_DEPLOYMENT_WORKER_SECRET` | Worker 外部 Secret 名称，只做清单强绑定，不由 Runner 读取 |
| `PHASE6_DEPLOYMENT_GO_NO_GO_ENVIRONMENT` | Go/No-Go 生产等价环境名称 |
| `PHASE6_DEPLOYMENT_GO_NO_GO_REGION` | Go/No-Go 证据 Region |

工作流从 `github.sha` 取得 commit，不允许人工输入。三镜像摘要和部署包摘要同时用于 Go/No-Go 原始证据复验与渲染清单复验，任一 Environment 漂移都会导致计划摘要不一致并停止部署。

## 4. Runner 只读挂载

两个 Runner 必须以只读方式挂载：

- `/var/lib/gaoq/deployment/production-values.yaml`：最多 1 MiB、普通文件、不得为符号链接、组和其他用户不可写；只含非敏感名称/摘要/标签/CIDR，不含 Secret 值。
- `/var/lib/gaoq/go-no-go/phase-5-go-no-go.json`：由证据域导出的原始 Go/No-Go 文件，继续受既有大小、权限、版本绑定和 24 小时新鲜度检查。
- `/var/lib/gaoq/kubernetes-schema/v1.30.0-standalone-strict/`：固定 commit 的离线 schema，运行时不从互联网取可变 schema。

API/Worker Secret 由 Secret Manager 同步到目标命名空间。Kubernetes 的 `get secret` 会返回数据而不只是 metadata，因此两个 Runner 都不得拥有 `get/list/watch secrets`；Secret 同步状态由独立平台证明，缺失时 Pod 无法 Ready，Helm `--atomic --wait` 必须失败关闭。日志、Artifact 和渲染清单不得出现 Secret 内容。

Helm 默认 Secret 存储驱动会要求发布身份读取命名空间内的全部 release Secret。工作流因此固定 `HELM_DRIVER=configmap`，release 元数据只保存在专用控制命名空间；Chart 的 `targetNamespace` 则把 21 个业务资源显式部署到独立 ERP 命名空间。values 和 manifest 不含 Secret 数据，两个命名空间不得承载无关系统。

## 5. 计划与执行门禁

计划阶段必须全部成功：

1. Go/No-Go 原始证据仍为 `GO`、不超过 24 小时，且 commit、三镜像摘要和部署包摘要完全一致。
2. Helm strict lint、仓库静态/渲染安全检查和 Kubeconform strict schema 均通过。
3. API、Worker、Web 三个 Deployment 的 release、commit、镜像摘要、部署包摘要和 rollout ID 完全一致。
4. API/Worker 的四个 ConfigMap/Secret 引用与受保护变量一致；Web 不包含 Secret 或 `envFrom`。
5. 控制/业务命名空间和两个非敏感 ConfigMap 存在，Secret 引用与平台证明一致；Plan Runner 明确没有业务 Deployment 写权限和 Secret 读取权限，本地 diff 退出码只能为“无变化”或“存在计划变化”。
6. 渲染清单及其 `sha256`、脱敏 verdict 和 diff 保存 90 天，供 Required Reviewers 审阅。

执行阶段再次完成上述版本和清单检查，并要求重新渲染的摘要与计划 job output 完全一致；在人工批准后先执行 server-side dry-run。之后只运行：

```bash
HELM_DRIVER=configmap helm upgrade --install <release> deploy/helm/gaoq-erp \
  --namespace <控制命名空间> --values <只读values> \
  --atomic --wait --timeout 15m --history-max 10
```

禁止 `--force`、`--reuse-values`、命令行 `--set`、自动创建 namespace、删除、uninstall 或自动 rollback 指令。`--atomic` 仅处理本次 Helm 发布失败；跨数据、身份、网关、外部系统和旧系统的业务回滚仍由获批人工 Runbook 执行。

## 6. 当前阻断

截至文档交付时，GitHub 仓库没有配置上述 Environment 或 self-hosted Runner，因此没有执行任何生产计划或部署。要解除阻断，仓库所有者和平台负责人必须提供并批准：集群、独立控制/业务命名空间、最小 RBAC、两类单次 Runner、完整变量、只读 values、离线 schema、Go/No-Go 原始证据和 Required Reviewers。缺少任一项时不得降低门禁或改用管理员 kubeconfig。
