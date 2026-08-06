# 本地开发运行时手册

## 1. 目标

`pnpm dev:up` 是 Issue #6 的单一开发入口。它只服务本机开发，依次完成：

1. 探测 `docker compose` 或 `docker-compose`；
2. 生成或复用本机专用对象存储随机凭据；
3. 启动并等待 MongoDB、Redis 和 MinIO 健康；
4. 以一次性容器显式完成 MongoDB Replica Set 与存储桶初始化；
5. 启动 API、独立 Worker、ERP Web 与官网；
6. 任一应用非预期退出时终止其余应用，返回非零状态。

该入口不替代 GitHub Actions，不部署虚拟机、自建 Runner、NAS 或生产基础设施。

## 2. 凭据与数据边界

- 对象存储凭据只保存在 `.local-runtime/object-storage.env`，文件权限固定为
  `0600`，目录被 Git 忽略；脚本禁止把凭据打印到 stdout/stderr。
- Compose 文件只引用运行时环境变量，禁止提供默认用户名、密码或 Token。
- Compose 不固定全局容器名，由项目名隔离容器、网络与命名卷，允许不同工作区和
  GitHub Runner 并行执行；应用只通过服务名 `mongo`、`redis` 与 `object-store`
  做容器内发现。
- MinIO 只模拟 S3 对象 API；它没有生产 WORM、KMS、病毒扫描、跨区复制和
  法定保留能力，任何本地结果均不能作为 Phase 3–6 外部证据。
- `pnpm dev:down` 停止容器但保留命名卷；数据销毁属于独立危险操作，本入口不
  自动删除卷。

## 3. 命令

```bash
cp .env.example .env
pnpm install
pnpm dev:up
```

退出应用后，按需停止依赖：

```bash
pnpm dev:down
```

只启动 Compose 时，操作者必须自行通过环境变量提供
`DEV_OBJECT_STORAGE_ACCESS_KEY`、`DEV_OBJECT_STORAGE_SECRET_KEY` 和
`DEV_OBJECT_STORAGE_BUCKET`。不得把它们写入 `docker-compose.yml`。

## 4. 失败处理

- Docker/Compose 不可用、基础设施未在健康时限内就绪、MongoDB Replica Set
  初始化失败或存储桶初始化失败：不启动任何应用。
- API、Worker 或任一 Web 进程退出：编排器向其余应用发送 `SIGTERM`，超时后
  提升为 `SIGKILL`，并返回首个失败码。
- `SIGINT`/`SIGTERM`：只关闭应用进程；容器与数据卷保留，便于下一次恢复。
- 凭据文件字段、权限或编码不合法：失败关闭，不生成弱默认值。

## 5. 验证

`pnpm deployment:local-runtime:validate` 会执行：

- MongoDB 副本集初始化异步行为测试；
- Worker 模块与运行时边界检查；
- 本地编排器凭据、Compose 命令探测、参数和子进程收敛自测；
- Compose、脚本、README、Git 忽略和无硬编码凭据的静态契约检查。

本机具备 Docker 时可再执行 `pnpm dev:up` 做实体启动；缺少 Docker 或镜像网络
时，静态门禁通过不代表实体运行通过。

## 6. GitHub 临时运行时门禁

`Phase 1 工程质量门禁` 在完成冻结依赖安装、`pnpm check` 和全工作区构建后，
会在同一个 GitHub-hosted Runner 内继续执行以下集成验证：

1. 只启动临时 MongoDB 7 单节点 Replica Set 与 Redis 7，等待主节点可写；
2. 启动真实 Worker，验证健康端点、指标默认拒绝、Bearer 放行和队列装配；API
   必须连续就绪 5 秒，避免 MongoDB 拓扑或开发索引初始化竞态；
3. 启动真实 API，以进程内生成的临时 RSA/HMAC/Client Secret 完成 OAuth 2.1
   Client Credentials 换票；
4. 由官方 MCP SDK 经 Streamable HTTP 完成握手，并逐项比对 50 个 Tool、4 个
   Resource、27 个 Resource Template、25 个 Prompt 的受控目录；
5. 无论成功或失败均删除该 Runner 创建的容器和命名卷，失败时只输出 MongoDB 与
   Redis 最近 100 行基础设施日志。

该门禁不保存临时密钥，不接触生产数据或外部供应商，不执行 R3 工具，也不创建
NAS、自建 Runner、虚拟机或长期基础设施。它证明当前提交能在真实数据库、队列、
OAuth 和 MCP SDK 链路上启动运行，但不替代外部沙箱联调、生产等价演练、人工
UAT、切换或 Hypercare 证据。
