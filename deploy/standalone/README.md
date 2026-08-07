# 专业算薪单机生产部署

本编排只创建 `gaoq-payroll` Compose Project，公网入口前仅占用回环端口
`127.0.0.1:3210`（Web）和 `127.0.0.1:3211`（API）。MongoDB、Redis、网络和
数据卷均使用 `gaoq-payroll-*` 独立名称，不共享 GaoQ ERP 或服务器其他项目的
数据库、缓存、网络、端口和卷。

## 安全与数据边界

- MongoDB 是独立单节点 Replica Set，开启认证和 keyFile 内部成员认证；应用只用
  `gaoq_payroll` 数据库的 `readWrite` 账号，不使用管理员账号。
- MongoDB 和 Redis 不发布任何主机端口。运行时文件位于仓库外，目录权限 `0700`，
  环境文件 `0600`，Mongo keyFile `0400`。
- MongoDB、Redis 只连接内部 `gaoq-payroll-data` 网络；需要访问 GaoQ OAuth/JWKS
  的 API/Worker 另接独立出口网络，数据容器自身没有外网路径。
- MongoDB/Redis 官方镜像使用发布时核验的 digest；生成器必须以 root 运行，把
  `mongo-keyfile` 设为 MongoDB 官方镜像的 `999:999` 且保持 `0400`。
- API、Worker、Web 使用非 root distroless 镜像、只读根文件系统、全部 capability
  删除和 `no-new-privileges`。禁止使用 `latest`。
- 首次上线只创建新卷和新数据库，不连接、不迁移、不写入 GaoQ ERP 或任何其他
  项目的数据库。ERP 主数据同步保持关闭，直到 OAuth 客户端完成注册和联调。

## 上线顺序

1. 运行 `pnpm check`、`pnpm audit` 与 `pnpm deployment:production:validate`。
2. 构建 `payroll-api`、`payroll-worker`、`payroll-web` 三个不可变镜像。
3. 在服务器仓库外运行
   `node scripts/generate-production-runtime.mjs /opt/gaoq-payroll-runtime <releaseTag>`。
4. 先执行 Compose 配置展开检查，确认仅出现 `3210/3211` 回环端口和
   `gaoq-payroll-*` 资源，再启动编排。
5. 验证容器健康、API 存活、Web 首页、未认证 API 为 401，且 Mongo/Redis 无主机端口。
6. 公网域名、Nginx、证书、GaoQ OAuth 客户端和主数据同步属于共享入口变更，必须
   获得用户明确批准后单独启用。

生产服务器无法直连构建基础镜像仓库时，只允许在 GitHub `main` 手动触发
`publish-production-images.yml`，由已通过 Actions 门禁的相同 Dockerfile 发布到
`ghcr.io/gtvigilante/gaoq-payroll-{api,worker,web}`。部署时必须把版本标签解析为
`@sha256:` 摘要后写入 `compose.env`；禁止使用 `latest`、分支名或浮动标签。
固定摘要时使用 `pnpm deployment:production:set-images -- <运行时绝对目录>
<API摘要> <Worker摘要> <Web摘要>`；脚本会拒绝非官方仓库、组件错配、浮动标签、
符号链接和重复环境变量，并以原子替换方式更新受保护的 `compose.env`。
如生产链路无法稳定直拉某个已发布镜像，可从 `main` 手动运行
`export-production-images.yml`，同时提供固定发布标签、完整源码 revision 和组件名。
该流程只读取并核验既有镜像，不重建、不推送、不覆盖标签；离线包和 SHA-256 校验
文件只保留 1 天。导入后仍须执行一次 `docker pull <固定标签>`，由 Registry 清单把
本地层绑定到官方 `RepoDigest`，再按内容摘要部署。

公网反向代理必须同时转发 `/api/payroll/v1`，以及 RFC 9728 对带路径 Resource
规定的 `/.well-known/oauth-protected-resource/api/payroll/v1`；不得把元数据错误地
放到 `/api/payroll/v1/.well-known/*`。

## 回滚

回滚只替换 `gaoq-payroll` 三个应用镜像并重启对应应用服务。不得删除 Mongo/Redis
卷，不得执行 Compose `down -v`，不得清理其他项目的镜像、容器、网络或配置。
