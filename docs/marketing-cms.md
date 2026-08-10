# 双语营销官网与 CMS 交付说明

## 已交付边界

- `apps/website` 提供 `/zh-CN`、`/en` 官网、固定品牌种子、CMS 已发布内容读取、
  SEO、结构化数据、Sitemap、RSS、预约表单与受保护缓存失效端点。
- `MarketingCmsModule` 提供受控区块、双语版本、审核、排期、发布、撤回、历史
  比较和回滚。回滚始终生成新草稿，不直接覆盖已发布终态。
- ERP 工作台已升级为营销运营工作区：工作台集中展示审核、排期、双语缺口和
  线索待办；内容区支持组合筛选、结构化区块编辑、SEO、双语关联、安全预览、
  修订时间线、回滚与排期；媒体区支持缩略图、替代文本、版权来源和受控直传；
  线索区支持管道视图、负责人、备注统计、状态跟进与受保护 CSV 导出。
- 媒体正文不经过 ERP；隔离网关签发短时上传地址，完成 MIME/大小校验、病毒
  扫描、摘要和图片衍生后，ERP 才把媒体标为 `ready`。内容只能引用当前租户
  `ready` 媒体。
- AI 网关只接收当前编辑内容并返回结构化草稿。生成记录固定为
  `pending_review`，必须由具备审核 Scope 的人员明确接受或拒绝，AI 无发布权限。
  网关输出按 250 KiB、12 层、5,000 节点、单数组 1,000 项和单对象 256 键
  预算克隆并冻结；自定义原型、存取器、Symbol、原型污染键和可执行标记均失败
  关闭。模型标识和提示词版本只留作服务端证据，不进入管理端响应。
- 预约线索由服务端固定映射租户和站点。浏览器按构建时固化的精确 ERP HTTPS
  Origin 直接跨域提交且不携带 Cookie；API CORS 只接受完整 Origin 白名单命中。
  请求经过蜜罐、验证码、Redis 限流及隐私同意校验；任一保护组件不可用时失败
  关闭。联系方式使用 AES-256-GCM，去重使用独立 HMAC 盲索引。
- 线索、两条通知副作用与排期发布副作用写入 `marketing_side_effect_outbox`；
  业务记录、版本快照与对应 Outbox 必须使用同一 MongoDB 事务。API 不直接双写
  BullMQ，Worker 每分钟从数据库恢复待投递事实，使用稳定无 PII Job ID 至少一次
  入队，记录入队与送达尝试次数、退避、错误码及
  `dispatched → delivered|dead|cancelled` 终态。排期撤回或人工提前发布时，同一
  事务把原定时副作用置为 `cancelled`，禁止遗留永久扫描任务。
- 通知网关请求必须携带
  `marketing-side-effect:{eventId}` 稳定幂等键；同一副作用重试不得重复发送，不同
  副作用事件不得被网关错误合并。网关已经成功但本地送达终态暂时写入失败时，
  Worker 只重试同一幂等事件，禁止反向登记通知失败或死信。定时发布同时保留
  到期数据库扫描，队列和 Worker 重启后可以重建延迟任务；扫描只从
  `dispatched` 数据库 Outbox 重建，不从客户端或队列内容推导租户。队列任务必须
  与 eventId、租户、聚合版本和渠道逐项匹配后才允许访问联系人或执行发布。
- Outbox 抢占与释放同时绑定 eventId、Worker、状态和原尝试次数；丢失租约必须
  失败关闭，禁止覆盖其他 Worker 的终态。运行时再次校验 eventId、租户、聚合、
  版本、尝试次数、到期时间、种类和渠道，受损记录不得进入外部队列。错误与存储
  异常只保留稳定受控编码，不把数据库或上游明细写入 BullMQ 失败记录；受损记录
  属于确定性错误并立即隔离为 `dead`，禁止无意义重试。

## 权限与协议

后台权限按职责拆分为：

- `erp:marketing:content:create|read|update|submit|approve|publish|rollback`
- `erp:marketing:media:create|read`
- `erp:marketing:ai:generate|review`
- `erp:marketing:lead:read|update|export`
- `erp:marketing:operations:read`（R1，只读副作用状态，不返回联系人或正文）
- `erp:marketing:operations:replay`（R2，仅允许把当前租户死信恢复为待投递）

PC 管理台先读取 `/api/auth/profile` 的可信主体与 Scope，再按
`content:read`、`lead:read`、`media:read` 分别加载数据。任何动作入口都同时要求
对应读取 Scope 与动作 Scope；前端显隐只改善操作体验，服务端仍逐请求强制授权。
内容、线索、媒体和 AI 响应均经过逐字键集合、枚举、规范 UTC 时间、URL 与大小
预算校验；Controller 只返回管理任务所需的最小公开投影。线索列表只增加负责人
标识、备注数量和最后备注时间，不返回归因或备注正文；媒体列表只增加文件大小、
双语替代文本、版权来源和创建时间，不返回对象引用、checksum 或扫描证据。所有
响应继续排除 `tenantId`、内部维护者、模型和提示词版本。

## 管理后台产品边界

本轮实现优先把既有可靠后端能力产品化，并保持职责分离与强版本控制：

- 工作台卡片可下钻到内容、发布、媒体和线索任务，不以总量报表替代待办；
- 编辑器只产生受控结构化区块，不接受任意 HTML/JavaScript；保存继续使用强
  `If-Match` 与幂等键，结果未知时只能重试原请求；
- 预览使用经管理端契约校验的结构化内容，不把后台 Bearer Token 写入 URL；
- 历史回滚由选择具体修订代替手工输入版本号，服务端仍恢复为新草稿；
- 线索导出通过受保护下载客户端校验固定 API 路径、媒体类型、声明长度与实际大小。

完整竞品基线、能力矩阵与后续路线见
`docs/research/marketing-cms-admin-benchmark-2026-08-10.md`。评论与任务、保存视图、
异步批量操作、资产文件夹/标签、审计检索、内容效果分析、重定向和跨内容发布包
仍属于后续 P1/P2，不能把本轮界面增强表述为已经交付这些服务端能力。

匿名端点仅包含：

- `GET /api/marketing/public/:locale/contents/:type`
- `GET /api/marketing/public/:locale/contents/:type/:slug`
- `POST /api/marketing/public/leads`

匿名内容接口统一返回逐字键集合固定的成功信封
`code/message/data/traceId/timestamp`。列表只返回标识、类型、语言、slug、
标题、摘要、修订号和发布时间，按发布时间倒序且最多 500 项，禁止携带区块、
SEO 或内部字段；详情必须与路径中的语言、类型和 slug 逐项反向绑定。Website
对信封、时间、ULID、枚举和正文执行严格运行时校验，并按 250 KiB、12 层、
5,000 节点、单数组 1,000 项和单对象 256 键预算克隆冻结；未知字段、自定义
原型、存取器、Symbol、原型污染键、非有限数字和可执行标记均失败关闭。

全部后台写接口和匿名线索提交都必须携带符合
`^[A-Za-z0-9._:-]{8,128}$` 的 `Idempotency-Key`。带版本的内容、线索与媒体写入
同时必须携带强 `If-Match: "<version>"`，成功响应返回新的强 `ETag`。官网预约
表单按不含验证码的业务载荷生成一次客户端键；网络失败或验证码刷新后，只要业务
载荷未改变就复用该键，禁止重试产生重复线索或重复通知。验证码消息必须同时来自
构建时固化的精确 Origin 和当前 iframe 的 `Window`，iframe 重新加载即清除旧
令牌。线索成功响应只接受精确 `{leadId, duplicate}`；网络、超时、408、425、
429、5xx、处理中冲突或成功响应契约异常均视为结果未知并保留原请求，只有明确
`IDEMPOTENCY_KEY_REUSED` 或确定性拒绝才清除。

线索使用“可信固定租户 + 幂等键”的 SHA-256 稳定标识，并在同一事务中先裁决
同键请求；同键同业务载荷返回原线索，同键异载荷返回
`IDEMPOTENCY_KEY_REUSED`。Mongo 唯一键竞争在事务外重读裁决，禁止把并发重试
误报为失败。联系人不进入幂等快照、日志或审计。

媒体上传采用“安全持久快照 + 短时结果”幂等协议：账本只保存媒体标识、对象引用
和版本，签名上传 URL 与到期时间不落账本；重放时用原安全快照向隔离网关重新签发
短时 URL，并校验对象引用不得变化。媒体与 AI 网关接收原
`Idempotency-Key`，HTTP、网络、JSON 或响应契约异常统一映射为受控不可用错误，
不得泄露上游响应或凭据。

PC 所有写入在页面内存冻结可信 actorId、所需 Scope、目标、强版本、精确正文和
`Idempotency-Key`。网络、超时、5xx、429、`IDEMPOTENCY_IN_PROGRESS` 或响应
契约异常导致结果未知时，只提供“重试原请求”，不得生成新键或切换目标；服务端
明确拒绝、可信主体变化或授权失效时才清除原请求。线索状态、媒体票据/核验与 AI
生成/复核同样强制幂等键。媒体直传保留同一文件、对象和创建键；签名 URL
401/403 时用原创建键重新签发，上传结果未知时复用原 URL，核验阶段复用独立原
核验键。签名 URL 只允许无凭据、无 fragment 的短期 HTTPS 能力且不写日志。

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

发布事件触发 Website 缓存失效时，端点必须同时清理
`marketing:{locale}:{type}:list` 与
`marketing:{locale}:{type}:{slug}`，防止 Sitemap、列表与详情版本分裂。
`MARKETING_REVALIDATE_SECRET` 只接受 32–512 位可打印 ASCII；缺失或畸形配置
返回稳定不可用错误，错误凭据返回未授权。事件正文只接受 `application/json`，
执行 16 KiB 流式硬上限、Fatal UTF-8、精确事件与 data 键集合、标识和正整数
修订校验；均不得泄漏 Secret 或内部异常。

AI 对接同步提供 `marketing_side_effect_get` Tool、
`erp://marketing/side-effects/{eventId}` Resource Template 和
`marketing_side_effect_triage_guide` Prompt。三者都复用 `MarketingCmsService`
并从 OAuth 身份解析租户；不接受租户参数，不暴露联系人/正文，不提供重放 Tool。
Tool 输出固定十二个字段，标识、枚举、非负计数、带时区 `date-time` 和错误码均
由严格 JSON Schema 约束，父对象和副作用对象都拒绝未知字段；Tool 防御性重建并
冻结结果，不能透传应用服务未来新增的租户、锁或内部调度字段。标准 MCP 继续只读。

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
`dead` 记录，必须提供 `Idempotency-Key` 并记录独立 R2 审计。所有营销写入在
事务提交后统一执行审计；审计故障只记录稳定
`MARKETING_AUDIT_AFTER_COMMIT_FAILED` 告警，不得把已提交内容、线索、媒体、
AI 审核、排期或已发送通知回写为业务失败，告警也不得包含正文、联系方式、提示词
或签名 URL。后台草稿、修订、线索、媒体和副作用状态读取采用失败关闭审计；审计
不可用时不向调用方返回业务数据。

仓库门禁 `pnpm quality:website-public-contract-coverage` 覆盖 Website 公开
契约、CMS 客户端和缓存失效端点；
`pnpm quality:marketing-cms-service-coverage` 覆盖业务服务，
`pnpm quality:marketing-entry-idempotency-coverage` 覆盖营销后台与公开入口、
验证码保护、隔离网关和通用幂等核心；
`pnpm quality:marketing-side-effect-delivery-coverage` 覆盖 Outbox Relay、
通知 Worker、排期发布 Worker 和送达终态服务。四条门禁均
逐文件强制语句、分支、函数、行不低于 90%。

生产告警必须覆盖 `MARKETING_SIDE_EFFECT_DEAD_LETTERED`、
`MARKETING_NOTIFICATION_DEAD_LETTERED`、
`MARKETING_SCHEDULED_PUBLISH_DEAD_LETTERED` 和
`MARKETING_NOTIFICATION_ROUTE_REJECTED`、
`MARKETING_NOTIFICATION_DELIVERY_STATE_UNAVAILABLE`；告警标签只能包含
eventId、类型、渠道、尝试次数与受控错误码，禁止联系人、正文、Bearer Token
或任意上游响应。`MARKETING_OUTBOX_CLAIM_LOST` 与
`MARKETING_OUTBOX_RELEASE_LEASE_LOST` 必须触发 Worker 失败和运维事件，禁止
静默继续扫描。
