# Phase 6 Kubernetes 平台最小权限护栏

## 1. 目标与责任边界

`deploy/helm/gaoq-platform-guardrails` 为受保护生产部署建立集群侧失败关闭边界，覆盖双命名空间、Pod Security Restricted、ResourceQuota、LimitRange、OIDC Group RBAC 和 ValidatingAdmissionPolicy。它不创建业务工作负载、Secret、云账号、证书或外部系统连接。护栏自身的 Helm release 必须位于预先存在、仅平台管理员可访问的管理命名空间，不得与它创建的控制/业务命名空间复用。

护栏安装、升级和删除均属于集群管理员 R3 操作，必须由平台与安全负责人双人审批，在应用发布窗口之外执行。应用 CD、AI 和 MCP 不得获得安装、修改或绕过护栏的权限；仓库不会自动把本 Chart 安装到任何集群。

## 2. 身份和命名空间模型

平台必须从企业身份提供方签发短期 OIDC 身份，并把不可伪造的 Group claim 映射到两类单次 Runner。不得使用长期 kubeconfig、ServiceAccount token、共享管理员身份或客户端自报 Group。

| 边界 | Plan OIDC Group | Apply OIDC Group |
|---|---|---|
| 控制命名空间 | `get/list` 非敏感 Helm release ConfigMap | 管理当前 Helm release ConfigMap |
| ERP 业务命名空间 | `get` 两个指定运行时 ConfigMap | 管理本 release 的白名单工作负载资源并只读 Pod、两个运行时 ConfigMap |
| Secret | 无任何权限 | 无任何权限 |
| RBAC / 准入 / Namespace | 无任何权限 | 无任何权限 |
| 集群级权限 | 仅 `get` 两个指定 Namespace | 仅 `get` 两个指定 Namespace |

控制命名空间只保存 `HELM_DRIVER=configmap` 的非敏感发布记录，硬限制为零 Pod、零 Secret；业务命名空间承载工作负载和由独立 Secret Manager 同步的运行时 Secret。两个命名空间必须不同，且均强制 Kubernetes 1.30 `restricted` 的 enforce、audit 和 warn 标签。

## 3. 失败关闭准入

RBAC 之外还有两条 `ValidatingAdmissionPolicy`：

1. ERP 业务命名空间的白名单资源写请求必须来自 Apply Group，同时满足 `app.kubernetes.io/part-of=gaoq-os`、当前 release 标签、批准的应用资源名前缀或精确 ServiceAccount 名。资源名前缀必须由目标应用 Chart 的实际渲染结果生成，不能假设未使用 `nameOverride/fullnameOverride`。
2. 控制命名空间的 ConfigMap 写请求必须来自 Apply Group，名称必须属于 `sh.helm.release.v1.<release>.v*`，并带有 Helm 的 `owner=helm` 与当前 release 标签。

策略使用 `failurePolicy: Fail` 和 `Deny, Audit`，因此身份不匹配、标签缺失、名称越界、CEL 求值错误或策略后端异常均不得静默放行。集群管理员的 break-glass 身份、策略豁免和恢复流程必须由企业平台另行治理并写入不可变审计，本仓库不预设旁路。

## 4. 受控安装

平台负责人必须从目标环境批准单独的非敏感 values 文件，至少冻结控制/业务命名空间、release 名、应用资源名前缀、ServiceAccount 名、两个 OIDC Group、两个运行时 ConfigMap 名和容量配额。资源名前缀与 ServiceAccount 名必须从同一份批准的应用渲染清单取得。`values.schema.json` 拒绝未知字段，values 中禁止放入 token、证书、连接串、Secret 值或个人身份信息。

在隔离工作站先执行：

```bash
helm lint deploy/helm/gaoq-platform-guardrails --strict --values <批准values>
helm template gaoq-platform-guardrails deploy/helm/gaoq-platform-guardrails \
  --namespace <平台管理命名空间> --values <批准values> > guardrails.yaml
node scripts/validate-kubernetes-platform-guardrails.mjs guardrails.yaml
kubeconform -strict -summary -kubernetes-version 1.30.0 guardrails.yaml
kubectl apply --server-side --dry-run=server --filename guardrails.yaml
```

最后一条命令必须在目标集群执行，以验证 API 兼容性和 CEL 编译；本地 Helm/Kubeconform 不能替代该步骤。通过双人评审后，由独立集群管理员身份安装：

```bash
helm upgrade --install gaoq-platform-guardrails deploy/helm/gaoq-platform-guardrails \
  --namespace <平台管理命名空间> --values <批准values> \
  --atomic --wait --timeout 10m --history-max 10
```

平台管理命名空间必须由集群基线预先建立，并禁止 Plan/Apply Group 访问。禁止 `--force`、`--reuse-values`、命令行 `--set`、自动创建命名空间和应用 CD 代装。渲染清单、values 摘要、工具版本、server-side dry-run、审批和实际 release 状态进入企业 WORM。

## 5. 目标集群正反例

平台与安全负责人必须在隔离的生产等价集群执行下表测试，保存请求身份、命令、退出码、API 响应、审计事件和资源前后状态。只有全部符合预期才允许配置生产 Environment。

| 用例 | 身份 | 操作 | 预期 |
|---|---|---|---|
| P01 | Plan Group | 读取两个 Namespace、Helm release ConfigMap、指定运行时 ConfigMap | 允许 |
| P02 | Plan Group | 创建、更新或删除 Deployment | RBAC 拒绝 |
| P03 | Plan Group | 读取任一 Secret | RBAC 拒绝 |
| A01 | Apply Group | 对合法 release 执行 server-side dry-run | 允许 |
| A02 | Apply Group | 管理带正确标签和名称的本 release 资源 | 允许 |
| A03 | Apply Group | 读取任一 Secret | RBAC 拒绝 |
| A04 | Apply Group | 创建 Role、RoleBinding、Namespace 或集群级资源 | RBAC 拒绝 |
| A05 | Apply Group | 写入其他 release、错误名称或错误标签的资源 | 准入拒绝并产生 Audit |
| A06 | Apply Group | 写入非 Helm、其他 release 或标签不符的控制 ConfigMap | 准入拒绝并产生 Audit |
| N01 | 非 Apply 身份但被临时误授相同 Role | 写入任一受护栏资源 | 准入拒绝并产生 Audit |
| N02 | 任一发布身份 | 创建 Secret 或获取 Secret 数据 | RBAC 拒绝 |

测试后必须撤销临时误授权。不得为了让测试通过而降低 RBAC、改为管理员 kubeconfig、关闭准入或把 Secret 放入 ConfigMap。

## 6. 漂移、监控和变更

- 每次应用发布前运行 `kubectl auth can-i` 负权限断言；发布后核对准入拒绝、RBAC 拒绝和异常 Group 使用告警。
- 平台持续比较 Git 批准清单、Helm release 和集群实际对象；Namespace 标签、Role/Binding、VAP/Binding、Quota 或 LimitRange 漂移立即阻断下一次发布。
- OIDC Group、release 名、命名空间、运行时 ConfigMap 或资源种类变化时，必须重新完成威胁建模、正反例和双人审批，不能只改 Environment Variable。
- 准入策略故障应停止发布并由平台恢复；不得临时删除策略继续上线。

## 7. 当前阻断

截至仓库交付时，GitHub 尚无 `phase-6-production-plan`、`phase-6-production-deployment` Environment 或相应 self-hosted Runner，也没有目标集群、OIDC Group、生产命名空间和管理员审批。因此本 Chart 仅完成仓库侧契约与严格 schema 验证，尚未完成目标 API Server 的 CEL 编译、正反例、实际安装或漂移验证；这些结果不得在 Issue 中标记为已完成。
