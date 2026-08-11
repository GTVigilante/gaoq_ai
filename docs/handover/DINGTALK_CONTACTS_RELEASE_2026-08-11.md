# 企业通讯录与钉钉扫码登录生产发布交接

> 发布时间：2026-08-11（Asia/Shanghai）
>
> 安全声明：本文不包含密码、Token、Client Secret、数据库连接串或个人联系方式。

## 1. 发布结论

企业通讯录、钉钉员工绑定状态、R3 加密开户入口及钉钉扫码登录浏览器回调已经随
`main@30409ae6e24f2f62e616bf830f02d4334ab7493c` 定向部署到 GaoQ OS 生产 API、
Worker 和 ERP Web。三个目标容器均为 `healthy`、`restart=0`；官网、Redis、
MongoDB、专业算薪和同机其他项目未被重启或覆盖。

生产钉钉 Client ID、Client Secret、回调 URI、企业 corpId 绑定与员工角色尚未配置，
因此扫码入口代码已上线但真实企业扫码登录仍保持未启用。`phase-1-indexes-v4` 仅完成
生产 dry-run，未执行写迁移。

## 2. 提交与镜像证据

- 提交：`30409ae6e24f2f62e616bf830f02d4334ab7493c`
- GitHub 镜像发布 Run：`31444774594`，四个矩阵任务全部成功。
- 生产发布目录：`/opt/gaoq-ai-releases/30409ae6e24f`
- 运行配置回滚备份：
  `/opt/gaoq-ai-runtime/compose.env.pre-30409ae6e24f-20260811`

| 服务 | GHCR Manifest Digest | 生产 Image ID |
|---|---|---|
| API | `sha256:b9bfd900292b4ca1dde651c1dadaa57bce3dce332132ff693a0f9dd190da08e8` | `sha256:5b3cd4aee6bf7c0b1512323102ad578d8caffe6da314285fc4503d9a7112c360` |
| Worker | `sha256:6f16c1094e0221cd26944ddb07b65b3ad21735da34021ee713534bef856b312e` | `sha256:bd22858b02ee05113d88515663365f8004161e4392be23e192fa88dfefb24b6d` |
| ERP Web | `sha256:0ecedfbf7b1bc0483747b2b72e57ddf312c90067e022e3b64816a724c7b54c1e` | `sha256:15e19fe5a1fe9181c6590f2e4562e409c4c65c768d438008671443ad1933ceb2` |

## 3. 质量与生产验证

- 干净候选提交：后端 5 个文件、69 项专项测试通过；前端 2 个文件、7 项测试通过。
- API 与 Web 类型检查通过；API Nest 构建和 Web Next.js 生产构建通过。
- 目标文件 ESLint、OpenAPI 273 路由/279 Operation 一致性及文档门禁通过。
- 生产索引 dry-run：`phase-1-indexes-v4`，校验和
  `XXnk8pSy-UV2EwXWGO9lMtMG8_3Wut3Z92prLXydZOY`，`verified=63`、
  `missing=1`、`created=0`；唯一缺项为 `loginOpenId` 唯一部分索引。
- 回环与公网 `/api/health/live`、`/api/health/ready`、`/workspace/contacts`、
  `/auth/callback/dingtalk` 均返回 200。
- 未认证绑定状态接口返回 401，证明新路由存在且 OAuth Scope 边界生效。
- API、Worker、ERP Web 发布后最近十分钟日志窗口内，关键错误/警告计数均为 0。

## 4. 未完成的现场事项

1. 钉钉管理员创建或授权企业内部应用，登记精确生产回调
   `https://aio.gaoq.com/auth/callback/dingtalk`。
2. 通过 Secret Manager 注入独立 SSO 与组织下发凭据，禁止写入仓库或聊天。
3. 按 `docs/phase-1/09-dingtalk-contacts-sso-runbook.md` 创建同 corpId 的 SSO 与组织平台绑定。
4. 独立批准后再次 dry-run 并执行 `phase-1-indexes-v4`；当前不得开放真实扫码流量。
5. 分配管理员开户读写 Scope、普通员工基础角色与部门范围，完成真实企业扫码和跨租户拒绝 UAT。

## 5. 回滚

回滚只恢复三个目标服务，保留数据库、Redis、官网和所有业务数据：

```bash
cp -p /opt/gaoq-ai-runtime/compose.env.pre-30409ae6e24f-20260811 \
  /opt/gaoq-ai-runtime/compose.env

docker compose -p gaoq-ai \
  --env-file /opt/gaoq-ai-runtime/compose.env \
  -f /opt/gaoq-ai-releases/30409ae6e24f/deploy/standalone/compose.yaml \
  config --quiet

docker compose -p gaoq-ai \
  --env-file /opt/gaoq-ai-runtime/compose.env \
  -f /opt/gaoq-ai-releases/30409ae6e24f/deploy/standalone/compose.yaml \
  up -d --no-deps api worker web
```

禁止执行 `docker compose down -v`，禁止删除或重建 MongoDB、Redis 或任何业务数据。
