# GaoQ ERP Helm Chart

本 Chart 只描述 API、Worker、ERP Web、公共 Website 四类无状态工作负载及其最小 Kubernetes 网络和可用性边界，不创建 MongoDB、Redis、对象存储、KMS、WORM、Secret 或云厂商资源，也不代表生产发布获批。

## 必填输入

- `images.*.repository` 与 `images.*.digest`：四个经过供应链门禁的独立镜像仓库和 `sha256` 摘要，禁止 tag 部署。
- `targetNamespace`：ERP 工作负载的独立业务命名空间；它与保存 Helm release ConfigMap 的控制命名空间分离。
- `release.commitSha`：与发布证据一致的 40 位 Git commit。
- `release.deploymentManifestHash`：发布系统生成的不可变部署包清单摘要，不对包含本字段的渲染 YAML 做自引用哈希。
- `release.websitePublicConfigHash`：Website 镜像构建时三个公开 HTTPS 地址的
  canonical 清单摘要；必须与镜像 provenance 和发布证据一致。
- `release.rolloutId`：本次发布窗口的唯一标识。
- `runtime.*`：平台预创建且可独立轮换的 API、Worker、ERP Web、Website ConfigMap 与 Secret 名称。Web Secret 只允许保存招聘门户 BFF 的最小 OAuth 客户端凭据；Website ConfigMap 只提供 `ERP_API_INTERNAL_ORIGIN`，Website Secret 只提供 `MARKETING_REVALIDATE_SECRET`，禁止相互复用。
- Website 的 `NEXT_PUBLIC_WEBSITE_ORIGIN`、`NEXT_PUBLIC_ERP_API_ORIGIN`、
  `NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_ORIGIN` 和 Widget URL 必须在生产镜像
  构建时固化并进入镜像供应链证据，禁止把构建期公开变量当成 Pod 运行时配置。
- `networkPolicy.*Labels`：经平台负责人确认的入口网关、监控和 DNS 工作负载标签。
- `networkPolicy.httpsEgressCidrs`：统一 HTTPS 出站网关的私网 CIDR；ERP、钉钉、飞书、电子签、银行、税务、WORM 等外联只能经该网关。
- `networkPolicy.mongodbCidrs`、`networkPolicy.redisCidrs`：托管 MongoDB Replica Set 和 Redis 的独立私网 CIDR。

## 验证

```bash
pnpm deployment:kubernetes:validate
helm lint deploy/helm/gaoq-erp --strict --values <受控值文件>
helm template <发布名> deploy/helm/gaoq-erp --values <受控值文件> > <渲染清单>
node scripts/validate-kubernetes-deployment.mjs <渲染清单>
```

CI 还使用固定版本、固定摘要的 Kubeconform 和固定 commit 的 Kubernetes schema 验证最终清单。生产集群仍需执行服务端 dry-run、准入策略和实际 NetworkPolicy 连通性测试。

## 发布边界

Chart 不包含自动安装步骤。受保护工作流使用 `HELM_DRIVER=configmap` 把不含敏感值的 release 元数据保存到独立控制命名空间，所有 Chart 资源显式写入 `targetNamespace`；生产发布、回滚、Secret 创建、网络放行和数据库操作均为 R3 人工治理动作，不能由 MCP Tool 或 AI 自主执行。
