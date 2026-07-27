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
- 预约线索由服务端固定映射租户和站点。浏览器按构建时固化的精确 ERP HTTPS
  Origin 直接跨域提交且不携带 Cookie；API CORS 只接受完整 Origin 白名单命中。
  请求经过蜜罐、验证码、Redis 限流及隐私同意校验；任一保护组件不可用时失败
  关闭。联系方式使用 AES-256-GCM，去重使用独立 HMAC 盲索引。
- 线索通知通过 BullMQ 分别投递邮件和飞书通道，业务入库成功不因通知异常回滚；
  失败任务保留并指数退避。定时发布另有每分钟修复扫描，防止入队窗口故障漏发。

## 权限与协议

后台权限按职责拆分为：

- `erp:marketing:content:create|read|update|submit|approve|publish|rollback`
- `erp:marketing:media:create|read`
- `erp:marketing:ai:generate|review`
- `erp:marketing:lead:read|update|export`

匿名端点仅包含：

- `GET /api/marketing/public/:locale/contents/:type`
- `GET /api/marketing/public/:locale/contents/:type/:slug`
- `POST /api/marketing/public/leads`

发布事件固定为 `cn.gaoq.erp.marketing.content.published.v1`，数据只包含站点、内容
标识、类型、语言、slug 与 revision，不包含正文、联系人或凭据。

## 生产构建与部署边界

Website 生产构建必须同时提供：

- `NEXT_PUBLIC_WEBSITE_ORIGIN`：官网精确标准 HTTPS Origin；
- `NEXT_PUBLIC_ERP_API_ORIGIN`：ERP API 精确标准 HTTPS Origin；
- `NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_ORIGIN`：验证码窗口消息唯一可信 Origin；
- `NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_URL`：与验证码 Origin 同源的 HTTPS URL。

三个 Origin 必须互不相同，禁止 localhost、HTTP、非 443 端口、路径、凭据、
query 或 fragment。Widget URL 可按供应商要求携带 query，但禁止 fragment。
缺少或错配任一变量时生产构建立刻失败，不回退 localhost。

Website 全路由固定发送 CSP、HSTS、Referrer-Policy、Permissions-Policy、
X-Content-Type-Options、X-Frame-Options、COOP、CORP 与
Origin-Agent-Cluster。CSP 的 `connect-src` 和 `frame-src` 分别精确绑定 ERP API
与验证码 Origin。

Website 使用独立 `erp-website` 非 root、只读根文件系统镜像，随 API、Worker 和
ERP Web 生成 SBOM 并阻断 High/Critical 漏洞。Helm 与静态门禁覆盖 Website
Deployment、ClusterIP Service、Ingress TLS 路由、NetworkPolicy、HPA、PDB、
探针和资源限制。

Pod 运行时只有 `ERP_API_INTERNAL_ORIGIN` 从 Website ConfigMap 注入，
`MARKETING_REVALIDATE_SECRET` 从 Website 专用 Secret 注入；禁止注入
`NEXT_PUBLIC_*` 或复用 API、Worker、ERP Web Secret。

## 现场配置与验收

媒体、AI、验证码和通知网关均需成对配置 HTTPS 端点与独立 Bearer Secret。官网
需配置 `MARKETING_REVALIDATE_SECRET`，API 与官网需配置精确跨域来源。以上网关
的真实病毒扫描、图片衍生、模型输出、邮件/飞书送达、WAF 和正式域名证据属于
现场验收，本地契约测试不能替代。
