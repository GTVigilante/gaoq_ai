# 双语营销官网与 CMS 交付说明

## 已交付边界

- `apps/website` 提供 `/zh-CN`、`/en` 官网、固定品牌种子、CMS 已发布内容读取、
  SEO、结构化数据、Sitemap、RSS、预约表单与受保护缓存失效端点。
- `MarketingCmsModule` 提供受控区块、双语版本、审核、排期、发布、撤回、历史
  比较和回滚。回滚始终生成新草稿，不直接覆盖已发布终态。
- 媒体正文不经过 ERP；隔离网关签发短时上传地址，完成 MIME/大小校验、病毒
  扫描、摘要和图片衍生后，ERP 才把媒体标为 `ready`。内容只能引用当前租户
  `ready` 媒体。
- AI 网关只接收当前编辑内容并返回结构化草稿。生成记录固定为
  `pending_review`，必须由具备审核 Scope 的人员明确接受或拒绝，AI 无发布权限。
- 预约线索由服务端固定映射租户和站点，经过蜜罐、验证码、Redis 限流及隐私
  同意校验；联系方式使用 AES-256-GCM，去重使用独立 HMAC 盲索引。
- 线索、两条通知副作用与排期发布副作用写入 `marketing_side_effect_outbox`；
  业务记录、版本快照与对应 Outbox 必须使用同一 MongoDB 事务。API 不直接双写
  BullMQ，Worker 每分钟从数据库恢复待投递事实，使用稳定无 PII Job ID 至少一次
  入队，记录入队与送达尝试次数、退避、错误码及
  `dispatched → delivered|dead|cancelled` 终态。排期撤回或人工提前发布时，同一
  事务把原定时副作用置为 `cancelled`，禁止遗留永久扫描任务。
- 通知网关请求必须携带
  `marketing:{tenantId}:{leadId}:{channel}:v1` 稳定幂等键；Worker 成功后崩溃重试
  不得重复发送。定时发布同时保留到期数据库扫描，队列和 Worker 重启后可以重建
  延迟任务；扫描只从 `dispatched` 数据库 Outbox 重建，不从客户端或队列内容
  推导租户。队列任务必须与 eventId、租户、聚合版本和渠道逐项匹配后才允许访问
  联系人或执行发布。

## 权限与协议

后台权限按职责拆分为：

- `erp:marketing:content:create|read|update|submit|approve|publish|rollback`
- `erp:marketing:media:create|read`
- `erp:marketing:ai:generate|review`
- `erp:marketing:lead:read|update|export`
- `erp:marketing:operations:read`（R1，只读副作用状态，不返回联系人或正文）
- `erp:marketing:operations:replay`（R2，仅允许把当前租户死信恢复为待投递）

匿名端点仅包含：

- `GET /api/marketing/public/:locale/contents/:type`
- `GET /api/marketing/public/:locale/contents/:type/:slug`
- `POST /api/marketing/public/leads`

发布事件固定为 `cn.gaoq.erp.marketing.content.published.v1`，数据只包含站点、内容
标识、类型、语言、slug 与 revision，不包含正文、联系人或凭据。

AI 对接同步提供 `marketing_side_effect_get` Tool、
`erp://marketing/side-effects/{eventId}` Resource Template 和
`marketing_side_effect_triage_guide` Prompt。三者都复用 `MarketingCmsService`
并从 OAuth 身份解析租户；不接受租户参数，不暴露联系人/正文，不提供重放 Tool。

## 现场配置与验收

媒体、AI、验证码和通知网关均需成对配置 HTTPS 端点与独立 Bearer Secret。官网
生产构建必须提供合法 HTTPS 的 `NEXT_PUBLIC_WEBSITE_ORIGIN`、
`NEXT_PUBLIC_ERP_API_ORIGIN` 和 `NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_URL`；
缺失、localhost、凭据、query 或 fragment 均失败。`NEXT_PUBLIC_*` 已写入
Website 镜像，不得依赖 Pod 启动后替换；发布记录以
`release.websitePublicConfigHash` 绑定三项公开配置的受控清单。

Website 运行时 ConfigMap 只提供 `ERP_API_INTERNAL_ORIGIN` 等非敏感服务端配置，
Secret 只提供 `MARKETING_REVALIDATE_SECRET`；禁止复用 API、Worker 或 ERP Web
Secret。API 的 `MARKETING_WEBSITE_ORIGIN` 必须精确绑定正式 HTTPS 根 Origin，
CORS 只开放固定方法和请求头。以上网关
的真实病毒扫描、图片衍生、模型输出、邮件/飞书送达、WAF 和正式域名证据属于
现场验收，本地契约测试不能替代。

生产索引必须先运行：

```bash
pnpm --filter @gaoq/erp-api migrate:phase5:marketing-cms-indexes -- --dry-run
pnpm --filter @gaoq/erp-api migrate:phase5:marketing-cms-indexes
```

人工重放使用 `POST /api/marketing-cms/side-effects/:eventId/replay`；只能处理
`dead` 记录，必须记录独立 R2 审计。业务已提交后的审计故障只记录专用告警，
不得把线索、排期或已发送通知回写为业务失败。

生产告警必须覆盖 `MARKETING_SIDE_EFFECT_DEAD_LETTERED`、
`MARKETING_NOTIFICATION_DEAD_LETTERED`、
`MARKETING_SCHEDULED_PUBLISH_DEAD_LETTERED` 和
`MARKETING_NOTIFICATION_ROUTE_REJECTED`；告警标签只能包含 eventId、类型、
渠道、尝试次数与受控错误码，禁止联系人、正文、Bearer Token 或任意上游响应。
