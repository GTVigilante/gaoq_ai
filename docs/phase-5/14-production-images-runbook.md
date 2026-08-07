# Phase 5 生产镜像构建与验证运行手册

- 文档编号：phase-5/14
- 状态：API、Worker、ERP Web、Website 镜像与 CI 门禁已实现；镜像仓库签名发布仍待 CD 平台接入

## 镜像边界

根目录 `Dockerfile` 只允许输出 `erp-api`、`erp-worker`、`erp-web`、`erp-website` 四个生产目标。构建阶段使用固定版本和 OCI 摘要的 Node.js 22 builder；最终运行阶段统一使用固定 OCI 摘要的 distroless Debian 13 Node.js 22 nonroot 镜像，不携带 shell、包管理器、应用源码、应用测试或构建工具。Debian 12 runtime 曾在首次 CI 被 Trivy 阻断 1 个 Critical 和 5 个 High 的 OpenSSL 漏洞，因此不得回退。API 与 Worker 共享同一份经过 `pnpm deploy --prod` 裁剪的生产依赖，但拥有独立入口与健康检查；两个 Next.js 应用分别构建 standalone 产物，不共享运行时 Secret。Docker 生态的 Dependabot 每周检查 builder 与 runtime 基础镜像更新，更新 PR 必须重新通过全部镜像门禁。

所有运行目标显式使用 UID/GID `65532:65532`，应用日志只写 stdout/stderr，业务证据只写 MongoDB、Redis、WORM 或受控网关。部署平台必须设置只读根文件系统、禁止提权、删除全部 Linux capabilities，并至少提供只读 Secret 挂载；不得把密钥写入镜像、Docker build arg、环境样例或镜像标签。

## 构建命令

Web 的 `NEXT_PUBLIC_ERP_API_ORIGIN` 会写入浏览器产物，只能传公开 HTTPS 根地址，禁止凭据、路径、query 和 fragment。`ERP_MOBILE_FRAME_ANCESTORS` 只接受空格分隔、最多 10 个精确 HTTPS Origin；禁止通配符、路径、query、fragment 和凭据，留空时移动端仅允许同源嵌入。二者都不是身份或租户配置，平台容器身份仍必须经过 ERP SSO 与本地授权快照裁决。

Website 构建同时强制
`NEXT_PUBLIC_WEBSITE_ORIGIN`、`NEXT_PUBLIC_ERP_API_ORIGIN` 与
`NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_URL` 为合法 HTTPS 地址，禁止缺失和
localhost。三项配置写入浏览器产物，必须在镜像 provenance 中登记并生成
`release.websitePublicConfigHash`；Pod 启动后注入同名变量不能改变已构建产物。

```bash
docker build --target erp-api --build-arg IMAGE_REVISION="$(git rev-parse HEAD)" -t gaoq-os/api:local .
docker build --target erp-worker --build-arg IMAGE_REVISION="$(git rev-parse HEAD)" -t gaoq-os/worker:local .
docker build --target erp-web --build-arg IMAGE_REVISION="$(git rev-parse HEAD)" --build-arg NEXT_PUBLIC_ERP_API_ORIGIN=https://erp.example.com --build-arg ERP_MOBILE_FRAME_ANCESTORS="https://h5.dingtalk.com https://open.feishu.cn" -t gaoq-os/web:local .
docker build --target erp-website --build-arg IMAGE_REVISION="$(git rev-parse HEAD)" --build-arg NEXT_PUBLIC_WEBSITE_ORIGIN=https://www.example.com --build-arg NEXT_PUBLIC_ERP_API_ORIGIN=https://erp.example.com --build-arg NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_ORIGIN=https://captcha.example.net --build-arg NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_URL=https://captcha.example.net/widget -t gaoq-os/website:local .
```

构建时只允许仓库根目录作为 context；`.dockerignore` 必须排除 Git 元数据、环境文件、依赖目录和本地产物。生产发布必须使用不可变镜像 digest，禁止部署 `latest` 或仅靠可变 tag 定位。

## 强制验证

每个 Pull Request 在 GitHub Actions 分别构建四种最终镜像，并验证最终用户为 `65532:65532`、健康检查存在、SPDX JSON SBOM 可生成、Trivy 的 High/Critical 发现为零。SBOM 保留 30 天作为 PR 证据；正式发布流水线必须把 SBOM、镜像 digest、Git commit、构建者身份和签名绑定到同一发布记录，并由制品仓库执行保留与不可变策略。

API 存活检查为 `/api/health/live`，就绪检查为 `/api/health/ready`；Worker 存活
检查为指标端口的 `/health/live`，指标 `/metrics` 仍要求独立 Bearer Token；
ERP Web 存活检查为 `/`，Website 为 `/zh-CN`。存活检查不得访问 MongoDB、Redis
或上游系统。API 就绪检查必须在有界时间内同时确认 MongoDB 是可写 Replica Set
主节点且 Redis 精确返回 PONG，并对并发重连执行单飞；它不检查外部业务平台，
外部连接健康由独立低基数指标、告警与 Go/No-Go 证据判定。

本切片不授权将镜像推送到任何生产仓库，也不构成生产放行。镜像签名、SLSA provenance、准入策略、生产等价只读文件系统冒烟和回滚演练必须在 CD 平台接入后形成独立证据。
