# GaoQ OS 招聘、HRBP、绩效与专业算薪生产交接

交接时间：2026-08-09（Asia/Shanghai）
适用对象：项目维护人员、SRE、HR 产品负责人及后续 AI 代理

> 安全声明：本文不包含密码、Token、私钥、数据库连接串或可复用凭据。禁止在交接、
> 排障或截图中输出 `/opt/gaoq-ai-runtime/*.env` 的值。

## 1. 交付结论

- `main@51460191c871c7cd99c77d3306c1c315ddec917b` 已部署到生产机。
- GaoQ API、Worker、ERP Web 均为该提交，`restart=0`、Docker 健康；
  `/api/health/live` 与 `/api/health/ready` 均为 200。
- 招聘管理、绩效管理、HRBP 与汇报关系页面已上线并公网 200。
- CMS Website 与专业算薪没有重启或改镜像，验活均为 200。
- MongoDB 已由另一条受控生产流程迁移到 GaoQ 独立单节点 Replica Set
  `gaoq-rs0`；本次部署没有删除、覆盖、导入或修改业务数据。
- 新模块 15 个索引只执行了 dry-run，尚未 apply。未完成独立迁移批准和角色 UAT
  前，不得授予新模块写 Scope。
- 同机其他项目、容器、数据库、Nginx 配置和代码均未修改。

## 2. 仓库与发布版本

| 项目 | 当前状态 |
| --- | --- |
| 仓库 | `GTVigilante/gaoq_ai` |
| 分支 | 本地与远端仅 `main`；`origin/HEAD` 只是指向 `origin/main` 的符号引用 |
| 业务实现提交 | `ac8c91a05990532070644335ff522a77f668c577` |
| 生产修复/最终提交 | `51460191c871c7cd99c77d3306c1c315ddec917b` |
| 生产 release | `/opt/gaoq-ai-releases/51460191c871` |
| Compose Project | `gaoq-ai` |
| 运行时配置 | `/opt/gaoq-ai-runtime`，目录/环境文件保持 `0700/0600` |
| 官方镜像工作流 | GitHub Actions run `31293553459`，API/Worker/Web/Website 全部成功 |

生产本机镜像：

| 组件 | 镜像 ID | 源码修订 |
| --- | --- | --- |
| API | `sha256:0d6b65de4b9c197ba6cd20067dc44ee02d5086f93b5d6145861eb03e3847304c` | `51460191c871…` |
| Worker | `sha256:19bbb578cc9245b177a6a57549700a2972430d3bdd2a7ced0879caceafa9ae44` | `51460191c871…` |
| ERP Web | `sha256:482e3e69b60a7ccce6bfca989e2f6d872648a80f23b54a8cd21aa5b57d7b75fb` | `51460191c871…` |
| CMS Website | `sha256:1b1ff22aff7b570f9ac808fe21d148aa432256f23784d700ff2c172e5ce282eb` | 未变更，`d5a19277bd62…` |

专业算薪保持原生产版本：API
`sha256:5cb5a3082863777f066b2856b0af9ee486865155e8ffcda269ac709e655f7bf4`，
Worker `sha256:02ea8e584834cd16ebf15cba24cc190fbe94010563729e40982151ed7486d8e8`，
Web `sha256:53b0ff93ee495dc54217e5ab83afd7392c31dbca83d9215a1dc687c1c3cb6674`。

## 3. 已交付业务能力

### 3.1 招聘管理

- 招聘运营总览、HC 需求、职位、候选流程、面试、Offer 和简历库统一工作台。
- 查询固定最小投影、稳定排序、状态白名单、部门数据范围和硬上限。
- AI 只辅助简历解析/摘要，不做候选人排名、淘汰或自动录用决定。
- 员工入口：`https://aio.gaoq.com/workspace/recruitment`。
- 访客入口：`https://joinus.gaoq.com/careers`。

### 3.2 HRBP 与汇报关系

- 支持员工级直属汇报关系、生效区间、重叠拒绝、100 层环路检测。
- 支持部门 HRBP 主负责人、最多 3 名备份和向子部门继承。
- 仅 active/probation 员工可参与关系配置，读取按可信部门数据范围收敛。
- 入口：`https://aio.gaoq.com/workspace/workforce`。

### 3.3 绩效管理

- 季度周期，OKR + KPI + 胜任力默认权重 `40% / 40% / 20%`。
- 自评 → 经理评价 → HRBP 校准 → 员工确认/五个工作日申诉 → 最终定级。
- 等级为 `S/A/B/C/D`，不强制分布；奖金系数由模板固化，ERP 不直接算奖金。
- 最终结果形成不可变算薪快照、SHA-256 摘要和
  `cn.gaoq.performance.result.finalized.v1` Outbox 事件。
- 算薪快照 REST 仅允许可信 service/system_job 主体；标准 MCP 只提供本人脱敏只读。
- 入口：`https://aio.gaoq.com/workspace/performance`。

### 3.4 领域与产品上下文

- 领域模型：`CONTEXT.md`。
- ERP Web 产品事实：`apps/erp-web/PRODUCT.md`。
- OpenAPI：`contracts/openapi/erp-api.openapi.json`。

## 4. 数据与迁移状态

- GaoQ 生产 MongoDB：独立容器 `gaoq-mongo`，Replica Set `gaoq-rs0`，无主机端口，
  仅接入 `gaoq-ai-private`。原共享实例中的 `gaoqos` 由既有流程保留作回滚副本。
- 新增集合：`workforce_reporting_lines`、`workforce_hrbp_assignments`、
  `performance_templates`、`performance_cycles`、`performance_assignments`、
  `performance_payroll_snapshots`。
- 生产 dry-run：迁移 ID `phase-6-workforce-performance-indexes-v1`，校验摘要
  `VC9EKbPolholLEh7wRELY6vC2L7e5HDk6ba_QvuIzbk`，`missing=15`，
  `created=0`。因此数据库尚无新模块生产索引，也没有写入新模块业务数据。
- 迁移脚本只允许追加并核验索引，不删除集合或索引：

```bash
# 只读 dry-run
docker exec gaoq-ai-api-1 /nodejs/bin/node \
  dist/migrations/phase-6-workforce-performance-indexes.js --dry-run

# 仅在人工批准、维护窗口和备份复核后执行；执行前再次 dry-run
docker exec gaoq-ai-api-1 /nodejs/bin/node \
  dist/migrations/phase-6-workforce-performance-indexes.js
```

## 5. 验证证据

- API：446 个测试文件、7,240 项测试全部通过；修正后的契约测试和 MCP 套件已定向
  复跑。类型检查、ESLint 与生产构建通过。
- Web：14 个测试文件、88 项测试通过；类型检查与 Next.js 生产构建通过。
- 算薪：`pnpm payroll:check` 通过，22 项测试通过；API/Worker/Web/核心构建通过；
  `pnpm payroll:deployment:validate` 通过。
- 编排：`pnpm deployment:standalone:validate` 与 `git diff --check` 通过。
- 公网：`aio.gaoq.com` 的健康、招聘、绩效、HRBP、算薪均 200；
  `joinus.gaoq.com/careers`、`www.gaoq.com/zh-CN` 均 200；
  `gaoq.com` 301 到 `www.gaoq.com`。
- 新 REST 入口无 Token 返回 401，证明路由存在且身份边界生效。
- 发布时首次 API 候选镜像因 DTO 声明顺序启动失败，自动触发回滚到旧 API；未写
  数据。修复后补做生产编译产物直接导入、重建、二次切换，最终所有目标容器
  `restart=0`、健康。

## 6. 域名注意事项

- 源站 Nginx 当前将 `recruit.gaoq.com` 301 到 `joinus.gaoq.com`，直接源站验证正确。
- 阿里 CDN 当前仍对 `https://recruit.gaoq.com/careers` 返回缓存/规则层 404；这与用户
  最初指定 `recruit.gaoq.com` 为招聘门户存在偏差。需要在阿里 CDN 控制台统一
  回源规则并清缓存，且由产品负责人确定最终 canonical 域名：
  建议按用户原始要求以 `recruit.gaoq.com` 为主域，`joinus.gaoq.com` 301 到 recruit。
- `gaoq.com` 已正确 301 到 `https://www.gaoq.com/`。

## 7. 回滚

回滚配置备份：`/opt/gaoq-ai-runtime/compose.env.pre-5146019-20260809`。

```bash
cp -p /opt/gaoq-ai-runtime/compose.env.pre-5146019-20260809 \
  /opt/gaoq-ai-runtime/compose.env

docker compose -p gaoq-ai \
  --env-file /opt/gaoq-ai-runtime/compose.env \
  -f /opt/gaoq-ai-releases/e357c43277d4/deploy/standalone/compose.yaml \
  config --quiet

docker compose -p gaoq-ai \
  --env-file /opt/gaoq-ai-runtime/compose.env \
  -f /opt/gaoq-ai-releases/e357c43277d4/deploy/standalone/compose.yaml \
  up -d --no-deps api worker web
```

禁止执行 `docker compose down -v`，禁止删除或重建 MongoDB/Redis，禁止清理其他
Compose Project。回滚后必须复核 API live/ready、三个 GaoQ 容器、CMS、算薪和
同机其他项目健康。

## 8. 人工配合待办

### P0：启用新模块前必须完成

1. 审批索引迁移：复核备份与维护窗口，再次 dry-run 后执行 15 个追加索引；记录
   apply 输出和回滚证据。
2. 配置身份与角色：为 HR 管理员、HRBP、经理、员工、Payroll service client
   分配最小 Scope 和部门范围；在此之前不得授予新模块写 Scope。
3. 准备权威数据：核对员工劳动状态、部门、直属经理和 HRBP 主备关系；完成 HR、
   HRBP、经理、员工、薪酬五类实体账号 UAT。
4. 按旧交接要求撤销并重新授权曾用于生产中转的本机 GitHub CLI OAuth。

### P1：完成业务闭环

1. 阿里 CDN：确定 recruit/joinus canonical 域名，修正回源与缓存并做全链路验活。
2. 候选人账号：提供短信/邮件 OTP 服务商、模板、发送域名、回调和风控配置；当前
   访客申请可用，但候选人 OTP 账户中心尚未启用。
3. 绩效到专业算薪：创建短时 OAuth 服务客户端、配置事件传输/重放/死信，并在专业
   算薪实现快照消费和财务对账；当前 ERP 已产出 REST/Outbox 契约，算薪消费未启用。
4. 受控数据迁移：基于现有迁移框架补齐新模块 Excel/CSV 字段映射，依次执行
   预检、dry-run、抽样复核、导入和对账，不得直接写集合。

### P2：正式企业验收

- 完成真实 SSO、邮件/短信、招聘渠道、日历、eSign、WORM、银行、税务等外部联调。
- 完成性能、安全、容灾、财务 UAT、Go/No-Go 签署与 Hypercare；仓库门禁和当前
  单机验活不能替代这些现场证据。

## 9. 日常只读验活

```bash
docker ps --filter name=gaoq-ai- --format '{{.Names}} {{.Status}} {{.Image}}'
curl -fsS http://127.0.0.1:3201/api/health/live >/dev/null
curl -fsS http://127.0.0.1:3201/api/health/ready >/dev/null
curl -fsS http://127.0.0.1:3200/workspace/recruitment >/dev/null
curl -fsS http://127.0.0.1:3200/workspace/performance >/dev/null
curl -fsS http://127.0.0.1:3200/workspace/workforce >/dev/null
curl -fsS http://127.0.0.1:3211/api/payroll/v1/health/ready >/dev/null
```

所有后续 AI 代理必须先读 `AGENTS.md`、`CODEX.md`、`CONTEXT.md`、
`apps/erp-web/PRODUCT.md` 和本交接文档，再执行任何生产操作。
