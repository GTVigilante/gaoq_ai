# 首发版生产上线状态

更新时间：2026-08-07

## 上线结论

GaoQ-OS 首发版已使用 `NODE_ENV=production`、`GAOQ_RELEASE_PROFILE=initial`
在目标服务器上线。三个正式入口均已启用 HTTPS，并完成服务器侧与公网侧检查：

| 入口 | 首发用途 | 检查结果 |
| --- | --- | --- |
| `https://aio.gaoq.com/` | ERP 工作台与 API | 首页、存活、就绪、JWKS 正常；受保护组织接口未认证返回 401 |
| `https://recruit.gaoq.com/careers` | 招聘门户 | 页面与 ERP 职位投影接口正常，当前公开职位数为 0 |
| `https://www.gaoq.com/zh-CN` | CMS 访客官网 | 页面正常 |
| `https://www.gaoq.com/system-status.html` | 系统介绍与交付状态 | 独立静态页面正常；明确代码交付与现场验收边界 |

2026-08-07 根域 `gaoq.com` 已切换到目标服务器并取得独立证书；HTTP 和 HTTPS
均永久跳转到 `https://www.gaoq.com/`，不复用仅包含 `www` 的证书。

## 首发能力边界

- 企业 SSO 尚未接入，因此 ERP 登录按钮不能完成真实企业身份登录。
- `PAYROLL_SYSTEM_MODE=external` 保持启用；独立专业算薪源站尚未部署，ERP 旧工资与
  资金 REST 只返回迁移边界，不提供模拟发薪能力。
- 资金、报税、电子签及外部审计 WORM 网关尚未接入，首发档位不执行对应外部副作用。
- 招聘门户链路已连通 ERP，但当前 ERP 没有已发布职位，因此职位列表为空。

这些边界属于首发版明确限制，不得解释为完整企业外部系统已经验收。

## 隔离与数据保护

- GaoQ 服务仅占用 `127.0.0.1:3200`、`127.0.0.1:3201`、`127.0.0.1:3202`，
  使用独立 Compose Project、网络、Redis 与数据卷。
- MongoDB 仅由服务器端运行时连接；本次没有执行数据库迁移、写入演示数据、删库或
  重建数据库，生产运行时关闭自动建索引。
- Nginx 只新增 GaoQ 三个子域名及根域 HTTP 跳转，没有改写服务器上其他站点配置。
- 系统状态页仅使用 `www.gaoq.com` 的精确静态路由，不重启应用容器，不访问数据库，
  并通过 `noindex`、CSP、`nosniff` 与禁止嵌入响应头收敛公开边界。
- 上线后复核其他既有容器与站点，状态与切换前一致。

## 发布与回滚证据

- API 镜像：`gaoq-os/api:20260806-219c54bfcfca`
- Worker 镜像：`gaoq-os/worker:20260806-219c54bfcfca`
- ERP Web 镜像：`gaoq-os/web:20260806-9d59533855a8`
- CMS/招聘门户镜像：`gaoq-os/website:20260806-9d59533855a8`
- 根域证书：`/etc/nginx/ssl/gaoq.com.pem`，由既有 acme.sh 自动续期
- 系统状态页源文件：`apps/website/public/system-status.html`
- 服务器静态文件：`/var/www/gaoq-system-status/system-status.html`
- 切换前 API 回滚标签：`gaoq-os/api:rollback-pre-initial-20260806`
- 切换前 Worker 回滚标签：`gaoq-os/worker:rollback-pre-initial-20260806`
- 切换前运行时配置备份：`/opt/gaoq-ai-runtime/compose.env.pre-initial-20260806`
- 切换前 Nginx ACME 配置备份：
  `/opt/gaoq-ai-runtime/nginx/gaoq-ai-acme-bootstrap.conf.pre-launch`

回滚只允许针对 GaoQ 自有容器、镜像和 Nginx 配置执行；禁止操作其他 Compose
Project、数据库、数据卷或站点配置。
