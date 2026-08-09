# 单机隔离部署

本目录用于在已有业务服务器上以独立 Compose Project 部署 GaoQ-OS。部署只占用
`127.0.0.1:3200`、`127.0.0.1:3201`、`127.0.0.1:3202`，使用独立网络和 Redis
数据卷；MongoDB 只读取运行时 `MONGODB_URI`，本编排不创建、删除或重建数据库。
生产切换前必须逐项满足 [PRODUCTION_INPUTS.md](./PRODUCTION_INPUTS.md)。

2026-08-06 首发版的实际入口、能力限制、隔离检查和回滚证据见
[LAUNCH_STATUS.md](./LAUNCH_STATUS.md)。该文档只记录已经验证的生产事实，不替代
后续企业 SSO、专业算薪及外部证据系统的现场验收。

## 安全边界

- 运行时配置必须放在仓库外目录，权限为 `0700`；其中环境文件权限为 `0600`。
- 镜像必须使用包含 digest 的不可变引用，禁止 `latest`。
- 首次启动前只执行 `docker compose config`，确认容器名、端口、网络和数据卷没有冲突。
- 索引迁移必须独立审批并先做 dry-run；启动编排本身不自动运行迁移。
- `GAOQ_NODE_ENV=development` 仅允许回环预部署验证，禁止安装 Nginx 配置或开放公网。
- `GAOQ_NODE_ENV=production` 必须满足 `environment.ts` 的全部外部证据网关和密钥门禁。
- `GAOQ_RELEASE_PROFILE=initial` 只豁免首发尚未接入的 OP、资金、税务、eSign 外部
  网关与 WORM 必填项；签名、招聘/审批/薪酬/资金数据密钥、指标凭据、HTTPS、租户
  身份和 Bearer 权限门禁仍按 production 强制。`full` 恢复全部企业外部系统门禁。
- `initial` 不等于允许真实发薪、报税、银行提交或电子签副作用；相关通道保持
  sandbox/未配置状态，ERP 旧工资和 Treasury REST 继续由 `PAYROLL_SYSTEM_MODE=external`
  返回迁移边界响应。
- 单机生产镜像只允许从 `main` 手动运行
  `.github/workflows/publish-standalone-images.yml` 发布。四个组件同时绑定完整提交
  SHA 和日期标签；生产运行时必须把标签解析为 `@sha256:` 摘要后再部署，禁止
  使用 `latest`、分支名或其他浮动引用。
- `AUTH_JWKS_URI` 始终保留公开 issuer 地址；单机部署仅用
  `AUTH_JWKS_FETCH_URI=http://127.0.0.1:3001/.well-known/jwks.json` 在 API 进程内部
  取钥，禁止改成 Docker DNS、任意内网地址或外部非同源地址。
- Worker 不提供本机 JWKS 端点，必须显式覆盖为公开
  `https://aio.gaoq.com/.well-known/jwks.json`；禁止沿用 API 的回环取钥地址。
- 运行时生成器会额外创建 `payroll-sync.env`（`0600`），作为算薪 Worker 的专用
  OAuth 机密客户端交接文件。只允许把这两个变量注入 `gaoq-payroll` 编排，不得将
  密钥提交到 Git、打印到终端或复用于招聘门户等其他客户端。

## 域名路由

- `aio.gaoq.com`：ERP Web，`/api`、`/mcp`、`/.well-known` 转发 API。
- `recruit.gaoq.com`：只开放 `/careers`、招聘 BFF 和 Next.js 静态资源。
- `joinus.gaoq.com`：招聘门户新增域名，与 `recruit.gaoq.com` 共用同一组受限路由。
- `gaoq.com`：HTTP 和使用根域独立证书的 HTTPS 均永久重定向到
  `https://www.gaoq.com`；禁止让根域 HTTPS 复用仅含 `www` 的证书。
- `www.gaoq.com`：转发 CMS 访客站。

`nginx/gaoq-ai.conf.example` 和代理请求头文件只是模板。目标域名完成 DNS/CDN 回源并
取得独立证书前，不得复制到 Nginx 配置目录，也不得 reload Nginx。

首次签发证书时，只允许先安装 `nginx/gaoq-ai-acme-bootstrap.conf.example`。该配置
仅服务 `aio.gaoq.com`、`recruit.gaoq.com`、`joinus.gaoq.com`、`www.gaoq.com` 的
ACME HTTP-01 挑战，其余请求返回 503，不代理开发模式应用，也不包含服务器上的
其他项目域名。
