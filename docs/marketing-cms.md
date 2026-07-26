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

## 现场配置与验收

媒体、AI、验证码和通知网关均需成对配置 HTTPS 端点与独立 Bearer Secret。官网
需配置 `MARKETING_REVALIDATE_SECRET`，API 与官网需配置精确跨域来源。以上网关
的真实病毒扫描、图片衍生、模型输出、邮件/飞书送达、WAF 和正式域名证据属于
现场验收，本地契约测试不能替代。
