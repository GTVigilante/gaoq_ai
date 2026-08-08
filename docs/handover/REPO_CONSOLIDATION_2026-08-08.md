# 仓库合并纪要：gaoq-payroll 并入 gaoq_ai 单仓

> 合并时间：2026-08-08（Asia/Shanghai）
> 执行方式：`git subtree add`，保留 gaoq-payroll 全部提交历史
> 安全声明：本文不包含密码、Token、私钥或可复用凭据。

## 1. 结论

专业算薪系统（原 `GTVigilante/gaoq-payroll`，生产提交
`503509b8023a4a38cc9f6bb9034a560ca8ea1d4a`）已通过 `git subtree add` 并入
`GTVigilante/gaoq_ai`，payroll 全部 10 个历史提交保留在本仓 Git 历史中。

**生产运行不受影响**：两套系统继续使用服务器上既有发布快照与运行目录，本次
仅变更代码仓布局，未触碰生产机、数据库、容器或配置。

## 2. 合并前备份

- Git 全引用 bundle 与工作区归档：
  `/Users/gilberthomemacmini/Projects/gaoq-repository-backups/20260808-payroll-merge/`
  （`gaoq-payroll-main.bundle`、`salary-cal-sys-worktree.tar.gz`）
- 合并前已核实 payroll `main` 与 `origin/main` 一致、工作区干净。

## 3. 目录映射

| 原 gaoq-payroll | gaoq_ai 内新位置 |
| --- | --- |
| `apps/payroll-{api,web,worker}` | 同名，位置不变 |
| `packages/payroll-core` | 同名，位置不变 |
| `packages/shared-types`、`packages/platform-contracts` | 未搬迁（与 gaoq_ai 同包逐文件一致，直接复用） |
| `deploy/standalone/` | `deploy/payroll/standalone/` |
| `scripts/`（3 个生产脚本） | `scripts/payroll/` |
| `docs/`、`智能薪酬自建系统_PRD.md`、`AGENT_SPEC.md` | `docs/payroll/` |
| 根 `Dockerfile` | `docker/payroll.Dockerfile` |
| `docker/mongo-init.js` | `docker/payroll-mongo-init.js` |
| `docker-compose.platform.yml` | `docker-compose.payroll-platform.yml` |
| `.github/workflows/ci.yml` | `.github/workflows/payroll-ci.yml` |
| `publish-production-images.yml` / `export-production-images.yml` | `publish-payroll-images.yml` / `export-payroll-images.yml` |
| `backend/`、`frontend/`（旧版算薪 MVP） | **未并入**，历史保留在原仓库与本仓 subtree 历史中 |

## 4. 命令与配置变化

- 根 `package.json` 新增：`payroll:check`（payroll 范围 lint/typecheck/test/build）、
  `payroll:deployment:validate`、`payroll:deployment:set-images`、`dev:payroll`。
- 根 `dev` 不再启动 payroll 应用（payroll 开发用 `pnpm dev:payroll`，需先起
  `docker-compose.payroll-platform.yml` 的独立 MongoDB/Redis）。
- 根 `prelint` 增加 `@gaoq/payroll-core` 构建。
- payroll 镜像构建统一使用 `docker build -f docker/payroll.Dockerfile`，
  GHCR 镜像名保持 `ghcr.io/gtvigilante/gaoq-payroll-{api,worker,web}` 不变。
- payroll 的 `tsconfig.base.json` 与 gaoq_ai 逐文件一致，直接复用根配置。

## 5. 运维提示（下次 payroll 发布起生效）

- 发布快照内编排路径由 `deploy/standalone/compose.yaml` 变为
  `deploy/payroll/standalone/compose.yaml`；`compose.env`、运行目录
  `/opt/gaoq-payroll-runtime`、Compose Project `gaoq-payroll` 均不变。
- 运行时生成命令变为
  `node scripts/payroll/generate-production-runtime.mjs /opt/gaoq-payroll-runtime <releaseTag>`。
- 镜像摘要固定命令变为 `pnpm payroll:deployment:set-images -- ...`。
- 服务器既有快照 `/opt/gaoq-payroll-releases/503509b8023a` 保持原样，回滚原则
  以 `PRODUCTION_HANDOVER_2026-08-08.md` 第 5 节为准。

## 6. 验证证据（合并提交前本地完成）

- `pnpm install`：lockfile 合并成功。
- `pnpm payroll:check`：payroll 4 包 lint / typecheck / test（22 项）/ build 全通过。
- `pnpm payroll:deployment:validate`：生产镜像、编排、凭据与数据边界静态校验通过。
- 全仓 `pnpm lint`、`pnpm typecheck`、`pnpm test`（含全部既有套件与 GitHub/MCP
  自测）通过。
- `docker-compose config --quiet`：`deploy/payroll/standalone/compose.yaml` 与
  `docker-compose.payroll-platform.yml` 均解析通过。

## 7. 人工收尾待办

- [ ] 确认合并无误后，在 GitHub 将 `GTVigilante/gaoq-payroll` 设为 archived 只读。
- [ ] 确认后可删除或归档本地 `/Users/gilberthomemacmini/Projects/salary-cal-sys`。
- [ ] 原交接文档 P0/P1/P2 人工待办（GitHub CLI OAuth 重授权、MongoDB Replica Set、
  `payroll.gaoq.com` 回源等）不因本次合并改变，继续按原文执行。
