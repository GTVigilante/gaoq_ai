# Phase 6 Kubernetes 生产编排基线

## 1. 适用范围与结论

仓库已提供云中立 Helm Chart，覆盖 GaoQ-OS ERP 的 API、异步 Worker、Next.js Web、ClusterIP Service、TLS Ingress、HPA、PDB、拓扑分散、Restricted Pod 安全上下文和默认拒绝 NetworkPolicy。它是生产部署契约，不是云账号基础设施，也不会自动执行发布。

云厂商、Region、账号、VPC、集群、域名、证书、KMS、WORM、托管数据库规格和出站网关尚未获得授权前，不应猜测或提交任何厂商专用 IaC。对应变量由平台、安全、数据和合规负责人在受保护环境中冻结。

## 2. 平台前置条件

生产平台至少满足以下条件：

1. Kubernetes 1.30 或更高的受支持版本，三个可用区，节点和控制面监控已接入值班体系；命名空间强制 Pod Security `restricted`，准入策略拒绝特权、host namespace、hostPath、非摘要镜像和未授权仓库。
2. 托管 MongoDB Replica Set 跨可用区部署，启用静态/传输加密、PITR、备份恢复演练和连接数告警；托管 Redis 启用认证、TLS、持久化和故障转移。
3. 独立 Secret Manager/KMS 负责凭据生成、版本、轮换、紧急吊销和访问审计；不得把明文 Secret 写入 values、Git、CI 日志或 ConfigMap。
4. 合规 WORM/对象存储位于独立权限域，审计锚点、发布证据、迁移证据和资金授权证据按保留期不可变保存。
5. WAF/API Gateway/Ingress Controller 强制 TLS、请求大小、限流和安全头；ERP 外部连接统一经过私网 HTTPS egress gateway，实施 FQDN/证书/方法/目的端白名单并留存审计。
6. Prometheus/日志/Trace、告警路由、值班与事故响应已就绪；生产命名空间之外的入口、监控和 DNS 工作负载必须有稳定标签。

## 3. 工作负载与最小权限

| 组件 | 最小副本 | 暴露方式 | 运行时凭据 | 允许网络 |
|---|---:|---|---|---|
| API | 3 | ClusterIP `3001`，由 TLS Ingress 代理 | 独立 API ConfigMap/Secret | DNS、MongoDB、Redis、HTTPS egress gateway、入口网关、监控 |
| Worker | 2 | 仅监控 ClusterIP `9464` | 独立 Worker ConfigMap/Secret | DNS、MongoDB、Redis、HTTPS egress gateway、监控 |
| Web | 3 | ClusterIP `3000`，由 TLS Ingress 代理 | 不挂载后端 Secret | DNS、API、入口网关 |

所有容器固定 UID/GID `65532`，根文件系统只读，禁止提权并删除全部 Linux capabilities；ServiceAccount 不挂载 token。部署按可用区分散，API/Web 滚动升级不可中断现有副本，PDB 和 HPA 防止维护或扩缩容破坏最低服务能力。

NetworkPolicy 从默认拒绝开始，再逐条开放精确组件与端口：入口网关到 API/Web、监控到 API/Worker、所有组件到 DNS、Web 到 API、后端到三类独立私网 CIDR。公网 `0.0.0.0/0` 永久禁止；外部 SaaS、ERP 主数据、钉钉、飞书、电子签、银行、税务和 WORM 都必须由 HTTPS egress gateway 代理。

## 4. Secret 与配置责任

Chart 不创建 Secret。平台负责人必须在发布前创建四个独立对象引用：API ConfigMap、API Secret、Worker ConfigMap、Worker Secret。API 与 Worker 可包含不同最小字段集和不同轮换周期；Web 的公共 API Origin 与 frame ancestors 在镜像构建时固定，不继承服务器凭据。

Secret Manager 同步器或平台流水线必须满足：工作负载身份最小权限、只读挂载/注入、版本可追溯、轮换有重启策略、回滚不会恢复已吊销凭据。银行、税务、电子签、WORM、OAuth 与审计 HMAC/签名密钥必须分域分 key，禁止复用。

## 5. 发布绑定与执行顺序

三个镜像都以 `repository@sha256:digest` 部署。`release.commitSha`、三个镜像摘要、`release.deploymentManifestHash` 和 `release.rolloutId` 必须与 Phase 5/6 证据以及资金执行授权完全一致。

`deploymentManifestHash` 指发布平台生成的“部署包清单”摘要：其输入包含 Chart 版本、受控 values 摘要、镜像摘要、外部配置版本和平台策略版本，但排除该摘要字段本身，避免自引用。发布平台生成后将它写入 values 和工作负载 annotation，现场验证器再比对证据。

受控执行顺序为：

1. 完成镜像供应链、依赖、SAST、Secret、DAST、性能、迁移、韧性、权限、隐私、UAT 和 MCP 证据门禁。
2. 在隔离环境用目标 values 执行 `helm lint`、`helm template`、仓库渲染检查和 Kubeconform；再由目标集群执行 server-side dry-run 与准入策略。
3. 人工复核 NetworkPolicy CIDR、外部 ConfigMap/Secret 版本、证书、发布绑定和回滚点。
4. 经 Go/No-Go 和变更审批后，在批准窗口人工执行 GitOps 同步或 Helm 发布；AI/MCP 只能读取脱敏状态。
5. 验证 rollout、探针、SLO、队列、审计锚点、外部连接和全域对账；异常立即按 Phase 6 契约回滚并保全证据。

## 6. 仓库验证

Chart 位于 [`deploy/helm/gaoq-erp`](../../deploy/helm/gaoq-erp/README.md)。本地静态检查：

```bash
pnpm deployment:kubernetes:validate
```

安全工作流使用固定摘要的 Helm 4.2.0 和 Kubeconform 0.7.0，执行严格 lint、完整渲染、仓库安全断言及 Kubernetes 1.30 strict schema 验证。schema 源也固定到明确 Git commit，避免 CI 隐式漂移。模板和 schema 检查不能替代目标集群的准入、服务端校验与真实网络测试。

## 7. 未完成的真实生产项

以下内容不属于仓库可凭空完成的事项，缺少负责人输入时必须保持阻断：

- 云厂商和账号、Region/VPC/子网、Kubernetes 服务版本与节点规格；
- MongoDB、Redis、KMS、Secret Manager、WORM、镜像仓库、WAF、Ingress 与 egress gateway 的资源标识和私网 CIDR；
- 生产域名、证书、身份提供方、外部系统沙箱/生产端点和凭据；
- 集群管理员、安全、财务、法务、数据保护、业务 Owner 的审批与执行人员；
- 三次全量迁移、生产等价联调、性能/安全/容灾/UAT、Go/No-Go、切换和 28 天 Hypercare 的真实证据。

这些输入齐备后，应在独立受控仓库交付厂商专用 IaC，并通过双人评审、计划审查、策略即代码和漂移检测；不得在本 Chart 中混入云账号凭据或绕过审批的自动发布。
