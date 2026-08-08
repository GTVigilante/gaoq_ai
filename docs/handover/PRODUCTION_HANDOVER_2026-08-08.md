# GaoQ OS 与专业算薪生产交接

> 交接时间：2026-08-08（Asia/Shanghai）  
> 适用对象：项目维护人员、SRE、后续 AI 代理  
> 安全声明：本文不包含密码、Token、私钥、数据库连接串或可复用凭据。

## 1. 当前结论

GaoQ OS 与专业算薪系统已部署到 `121.5.32.244` 的独立 Compose Project。
GaoQ 的 API、Worker、ERP Web、CMS Website、Redis 共 5 个容器健康；专业算薪的
API、Worker、Web、MongoDB、Redis 共 5 个容器健康。服务器上既有
`agents100-prod` 项目的 3 个容器保持原状态并健康，本次没有修改其环境、配置、
代码或数据。

本次未执行数据库删除、集合删除、迁移、初始化、种子数据写入或数据库重建。
GaoQ 使用服务器既有 MongoDB；专业算薪使用自己的独立 MongoDB 和 Redis，二者
均未发布主机端口。

## 2. 代码仓库与发布版本

| 系统 | 仓库 | 生产应用提交 | 质量证据 |
| --- | --- | --- | --- |
| GaoQ OS | `GTVigilante/gaoq_ai` | `e357c43277d421c716f967e55d66369203a88ee6`（API、Worker）；Web/CMS 应用代码来自其父提交 `d5a19277bd62f4d37aa3dc78c4d3448482c60671` | 本地 440 个测试文件、7,223 项测试通过；GitHub 工程、安全、文档与镜像发布门禁通过 |
| 专业算薪 | `GTVigilante/gaoq-payroll` | `503509b8023a4a38cc9f6bb9034a560ca8ea1d4a` | `pnpm check`、`pnpm audit`、构建与 GitHub 镜像发布门禁通过 |

两个仓库的保全备份位于本地：

`/Users/gilberthomemacmini/Projects/gaoq-repository-backups/20260808-branch-consolidation`

备份含全引用 Git bundle、工作区/暂存区补丁、未跟踪文件归档、状态清单与
`SHA256SUMS`。历史工作区内容先保全后收敛，不应把备份中的旧实现直接合入生产
`main`。

## 3. 生产拓扑

| 入口或组件 | 主机监听 | 容器/用途 | 状态 |
| --- | --- | --- | --- |
| `aio.gaoq.com` | Nginx → `127.0.0.1:3200/3201` | ERP Web 与 GaoQ API | 公网 200 |
| `recruit.gaoq.com` | Nginx → `127.0.0.1:3200/3201` | 招聘门户受限路由 | `/careers` 公网 200 |
| `www.gaoq.com` | Nginx → `127.0.0.1:3202` | CMS 访客站 | `/zh-CN` 公网 200 |
| `gaoq.com` | Nginx 301 | 跳转 `https://www.gaoq.com` | 已验证 |
| 专业算薪 Web | `127.0.0.1:3210` | `gaoq-payroll-payroll-web-1` | 本机 200、健康 |
| 专业算薪 API | `127.0.0.1:3211` | `gaoq-payroll-payroll-api-1` | `/api/payroll/v1/health/ready` 200、健康 |

运行目录：

- GaoQ：`/opt/gaoq-ai-runtime`，Compose Project `gaoq-ai`。
- GaoQ 发布快照：`/opt/gaoq-ai-releases/e357c43277d4`。
- 专业算薪：`/opt/gaoq-payroll-runtime`，Compose Project `gaoq-payroll`。
- 专业算薪发布快照：`/opt/gaoq-payroll-releases/503509b8023a`。
- 运行时目录和环境文件分别保持 `0700/0600` 级别权限；交接时只核对键名，禁止
  输出值。

### 3.1 当前不可变镜像

GaoQ：

| 组件 | 本机镜像 ID | 源码修订 |
| --- | --- | --- |
| API | `sha256:496c5694bca64f98f43e64e35475ddd1ccc46ae801e29b3fc0c2ce6e21d42634` | `e357c43277d421c716f967e55d66369203a88ee6` |
| Worker | `sha256:468ad2cb79e264e3dd9a9d504882ebd2dc861a623104928477ecf941bd995659` | `e357c43277d421c716f967e55d66369203a88ee6` |
| ERP Web | `sha256:b926bce0d190551cf20f94064c2e106e308369583289315b4c3fde26a2047cf4` | `d5a19277bd62f4d37aa3dc78c4d3448482c60671` |
| CMS Website | `sha256:1b1ff22aff7b570f9ac808fe21d148aa432256f23784d700ff2c172e5ce282eb` | `d5a19277bd62f4d37aa3dc78c4d3448482c60671` |

专业算薪三个应用组件均绑定
`503509b8023a4a38cc9f6bb9034a560ca8ea1d4a`：

| 组件 | 本机镜像 ID |
| --- | --- |
| API | `sha256:5cb5a3082863777f066b2856b0af9ee486865155e8ffcda269ac709e655f7bf4` |
| Worker | `sha256:02ea8e584834cd16ebf15cba24cc190fbe94010563729e40982151ed7486d8e8` |
| Web | `sha256:78cebfa82d0789ee01cc955a79b29ad5b398e43d8c3d0e8dd91eb131bd6af305` |

GitHub 已发布相同算薪提交的官方 GHCR 镜像。生产机访问 GHCR/GCR 的新运行层速度
不稳定，因此当前使用服务器隔离构建、内容寻址的本机镜像；构建使用同一锁文件、
同一提交和服务器既有的已验证 distroless Node 22 只读基础镜像。网络恢复后应在
维护窗口把本机镜像替换为官方摘要并重新验活，不要使用 `latest`。

## 4. 数据与安全边界

- GaoQ MongoDB 仅通过服务器内部地址连接。本次只执行了 `hello` 只读探测，确认
  节点可写但不是 Replica Set；没有查询业务集合或修改数据。
- GaoQ `/api/health/live` 为 200，容器健康；严格 `/api/health/ready` 因 MongoDB
  不是 Replica Set 返回 503。这是事务/可靠性门禁，不得通过放宽代码绕过。
- 专业算薪 MongoDB、Redis 和 GaoQ Redis 均无主机发布端口。
- 专业算薪主数据同步保持 `MASTER_DATA_SYNC_ENABLED=false`，未获得正式 OAuth
  客户端与联调证据前不得开启。
- GaoQ 服务客户端注册表只做兼容升级：为原有客户端补充当前 ERP
  `allowedResources`，未更改客户端身份、Scope、角色、部门、凭据摘要或有效期；
  原文件已在运行目录留有只读回滚备份。
- 所有生产配置备份均在各自运行目录，文件名含 `pre-...-20260808`；不得提交到
  Git、复制到聊天或交接文档。

## 5. 运维操作

以下命令只允许在确认目录、Compose Project 与目标服务名后执行。不要省略
`--no-deps` 去重建数据库或 Redis。

### GaoQ 查看与验活

```bash
cd /opt/gaoq-ai-runtime
docker compose --env-file compose.env \
  -f /opt/gaoq-ai-releases/e357c43277d4/deploy/standalone/compose.yaml ps
curl -fsS http://127.0.0.1:3201/api/health/live
curl -fsS http://127.0.0.1:3200/ >/dev/null
curl -fsS http://127.0.0.1:3202/zh-CN >/dev/null
```

### 专业算薪查看与验活

```bash
cd /opt/gaoq-payroll-runtime
docker compose --env-file compose.env \
  -f /opt/gaoq-payroll-releases/503509b8023a/deploy/standalone/compose.yaml ps
curl -fsS http://127.0.0.1:3211/api/payroll/v1/health/ready
curl -fsS http://127.0.0.1:3210/ >/dev/null
```

### 应用层回滚原则

1. 先读取对应 `compose.env.pre-...-20260808`，只恢复应用镜像键。
2. 先执行 `docker compose config --quiet`。
3. 只对目标应用执行 `up -d --no-deps <service>`。
4. 等待健康检查并验证回环 HTTP；失败则恢复刚才的配置备份。
5. 禁止回滚、删除或重建 MongoDB/Redis，禁止执行 `down -v`。

## 6. 人工协作待办

### P0：立即处理

1. **撤销并重新授权本机 GitHub CLI OAuth。** 下载中转时临时授权曾短暂进入远端
   进程参数，已立即终止且未写入仓库或配置，但应按凭据暴露处理。完成全部 Git
   操作后，在 GitHub 账户中撤销该 OAuth 授权并重新登录，旧凭据不得继续使用。
2. **制定 GaoQ MongoDB Replica Set 升级方案。** 必须先做备份、恢复演练、维护
   窗口与回滚审批；不得由自动代理直接修改现有数据库。升级后验证 `/ready=200`、
   事务、Worker 与审计链。
3. **完成 `payroll.gaoq.com` 的真实回源。** 当前目标服务器没有 payroll 专属证书
   和 Nginx server block；直接以该 Host 访问目标机命中其他站点默认页。需要把
   DNS/CDN 回源指向 `121.5.32.244`，签发独立证书，新增只代理
   `127.0.0.1:3210/3211` 的 server block，`nginx -t` 后再 reload。不得编辑其他
   项目的 server block。

### P1：上线联调

1. 通过 Secret Manager 新增 `payroll-sync-production` 服务客户端及轮换凭据，完成
   ERP 主数据资源、算薪资源、Scope、错误租户、撤销和过期测试后，才允许把
   `MASTER_DATA_SYNC_ENABLED` 改为 `true`。
2. 完成专业算薪 Web 的 ERP OAuth 登录、回调、会话、跨资源 Token 与员工/财务
   角色 UAT；不得把客户端 Secret 写入仓库。
3. 配置并验收企业 SSO、验证码、通知、招聘渠道、eSign、税务、银行、WORM、
   AI/媒体网关等外部服务。未配置的副作用通道保持关闭。
4. 在维护窗口拉取官方 GHCR 摘要替换当前本机内容寻址镜像，逐组件验活并保留
   回滚镜像。

### P2：正式投产证据

完成数据库恢复演练、两个影子算薪周期、工资差异对账、容量/安全/容灾测试、业务
UAT、Go/No-Go 签署与 Hypercare。仓库门禁和当前单机验活不能替代这些现场证据。

## 7. 后续 AI 接手约束

1. 先阅读根目录 `AGENTS.md`、`CODEX.md`、`.codex/AGENTS.md` 与本文。
2. 默认只操作 `gaoq_ai`、`salary-cal-sys` 以及服务器上的两个对应 Compose
   Project；其他项目全部视为禁止修改。
3. 任何数据库变更、分支强推、批量覆盖、删除、证书/Nginx 改动必须先确认目标和
   获得人类批准；永远禁止 `docker compose down -v`。
4. 运行时 Secret 只校验存在性、长度、权限与结构，不打印值。
5. 外部配置缺失时继续完成其他安全工作，最终统一输出人工待办，不能以假配置
   代替真实验收。

## 8. 交接验收清单

- [x] GaoQ OS 5 个容器健康。
- [x] 专业算薪 5 个容器健康，API ready 与 Web 首页为 200。
- [x] `aio`、`recruit`、`www` 与根域跳转已验证。
- [x] 目标端口仅绑定 `127.0.0.1`，数据库/Redis 无主机端口。
- [x] 其他 `agents100-prod` 容器保持健康。
- [x] 未执行数据库迁移、初始化、种子或删除。
- [x] 代码与历史工作区已做可校验备份。
- [ ] GaoQ MongoDB Replica Set 与 `/ready=200`（人工 P0）。
- [ ] `payroll.gaoq.com` DNS、证书、Nginx 与公网验活（人工 P0）。
- [ ] GitHub CLI OAuth 撤销并重新授权（人工 P0）。
- [ ] 外部系统、OAuth、业务 UAT 和正式投产证据（人工 P1/P2）。
