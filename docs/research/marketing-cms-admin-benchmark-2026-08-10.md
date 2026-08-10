# 营销 CMS 管理后台竞品基线与实施建议（2026-08-10）

## 1. 结论先行

当前项目已经具备内容创建、人工审核、排期发布、修订回滚、媒体上传、AI 草稿复核、
双语内容、线索状态和可靠副作用投递等可靠后端能力，但管理后台仍主要是一个
“列表 + 动作按钮 + 新建弹窗”。与 Contentful、Sanity、Strapi 的官方产品能力相比，
主要差距不在更多单点 API，而在营销人员每天使用的完整工作台：可配置内容模型、
可视化编辑与预览、搜索筛选和保存视图、协作任务、发布日历、媒体资产治理、翻译
完整度、SEO 质量门禁、批量操作、审计检索、内容效果及线索跟进闭环。

建议按三个层次建设：

- **P0（必须）**：先把现有可靠后端能力做成可用的内容工作台，包括内容详情/编辑、
  搜索筛选、预览、版本差异、发布日历、翻译状态、SEO 检查、媒体选择器、线索详情
  和负责人/备注。
- **P1（重要）**：补齐协作和规模化运营，包括评论与任务、自定义工作流、批量操作、
  保存视图、资产标签/文件夹、审计检索、重定向管理和内容效果看板。
- **P2（增强）**：再建设可配置内容模型、跨内容发布包、内容实验/个性化、翻译供应商
  集成、数字资产权利管理和高级线索自动化。

这一路径避免先复制通用 Headless CMS 的全部平台能力，而是优先把本项目已有领域和
安全边界转化为营销团队可操作、可审查、可追踪的产品体验。

## 2. 调研范围与方法

调研对象为 Contentful、Sanity、Strapi，截至 2026-08-10 仅引用其官方文档、官方
帮助中心或官方产品文档。结论不是采购选型，而是提取现代营销 CMS 后台的共同产品
基线，并结合本项目 `apps/erp-web/app/workspace/marketing/`、
`apps/erp-api/src/modules/marketing-cms/` 与 `docs/marketing-cms.md` 的已交付边界给出
实施优先级。

优先级定义：

- **P0**：没有该能力会直接阻塞日常编辑、审核、发布或线索跟进。
- **P1**：内容量和协作人数增长后显著影响效率、质量或治理。
- **P2**：成熟运营阶段的扩展能力，不应阻塞 P0/P1 落地。

## 3. 官方产品能力基线

### 3.1 Contentful

Contentful 的官方能力呈现出“结构化内容平台 + 企业协作治理 + 营销效果回流”的特点：

- 内容模型由 Content Type、字段、引用和校验构成，模型以 JSON 表示，便于结构化复用；
  角色可以独立控制 Content Model 权限，并按内容、环境和动作建立允许列表。
  [Data model](https://www.contentful.com/developers/docs/concepts/data-model/)、
  [Roles](https://www.contentful.com/developers/docs/references/content-management-api/roles/)
- 工作流支持步骤、步骤迁移权限和规则；条目侧提供字段级评论、@成员/团队、回复与
  解决状态；Tasks 可分配给个人或团队、设置截止时间，并阻止未完成任务的内容发布。
  [Workflow steps management](https://www.contentful.com/help/ai-automations/workflows/workflows-steps-management/)、
  [Comments](https://www.contentful.com/help/content-and-entries/comments/)、
  [Tasks](https://www.contentful.com/help/content-and-entries/tasks/)
- Live Preview 提供编辑器与页面并排预览、实时更新、Inspector 点击定位字段，并可随
  编辑器语言切换预览语言。
  [Live preview](https://www.contentful.com/help/content-preview/live-preview/)
- 本地化支持字段级、条目级、Content Type 级和 Space 级策略；官方明确将权限治理、
  异步发布、回退、粒度和编辑体验列为选型维度。
  [Localization strategies](https://www.contentful.com/help/localization/field-and-entry-localization/)
- Bulk Actions 可异步验证、发布和撤回 Entry/Asset，并在执行前继续执行版本与权限
  校验；这说明批量能力不是绕过单条治理的捷径。
  [Bulk Actions](https://www.contentful.com/developers/docs/references/content-management-api/bulk-actions/)
- Analytics 将内容、参与度与客户数据放入内容生命周期，支持在条目层识别表现模式；
  GA4 应用可把页面浏览等指标直接显示在条目编辑侧栏。
  [Analytics](https://www.contentful.com/help/analytics/)、
  [Google Analytics 4](https://www.contentful.com/help/apps/google-analytics-4/)

### 3.2 Sanity

Sanity 的官方能力强调“Schema 驱动的可定制编辑器 + Visual Editing + 多版本发布视角”：

- Studio 允许以 Schema 定义文档、字段、校验和编辑组件，并可定制文档列表、视图、
  菜单与结构；这是将后台工作区适配具体内容团队的基础。
  [Studio documentation](https://www.sanity.io/docs/studio)
- Content Releases 可把多个文档版本组成发布包，统一预览、验证、排期、发布或撤回；
  Release layering 能预览多个未来发布层的叠加结果，并支持复制版本与回滚。
  [Content Releases user guide](https://www.sanity.io/docs/studio/content-releases)、
  [Content releases and versions API](https://www.sanity.io/docs/apis-and-sdks/js-client-releases)
- 角色可按数据集、文档和资产控制访问；自定义角色还可通过内容资源进一步限制特定
  内容类型。
  [Roles](https://www.sanity.io/docs/user-guides/roles)
- 本地化官方区分字段级和文档级：前者适合共享字段并需同时发布，后者支持语言独立
  发布；项目可以按内容结构混用两种策略。
  [Localization](https://www.sanity.io/docs/studio/localization)
- Media Library 支持跨应用/数据集复用资产、搜索、文件夹、可配置分类信息，以及图片、
  视频、PDF、音频和动画预览；资产还可设为私有并通过短时签名 URL 使用。
  [Media Library introduction](https://www.sanity.io/docs/media-library/introduction)
- History API 可按时间或 revision ID 读取文档历史，并对历史修订继续应用当前访问控制。
  [History API](https://www.sanity.io/docs/http-reference/history)

### 3.3 Strapi

Strapi 的官方后台提供了一套接近“开箱即用通用 CMS”的能力清单：

- Content-type Builder 可视化创建 Collection Type、Single Type 和可复用 Component，
  配置关系、Dynamic Zone、字段校验、条件显示、私有字段、字段级本地化及 Draft & Publish。
  [Content-type Builder](https://docs.strapi.io/cms/features/content-type-builder)
- Content Manager 覆盖内容列表、创建、编辑、过滤、排序、发布和批量管理，是编辑人员的
  中央工作区。
  [Content Manager](https://docs.strapi.io/cms/features/content-manager)
- Review Workflows、Releases、RBAC 分别承担多阶段审核、成组排期发布和后台细粒度授权。
  [Review Workflows](https://docs.strapi.io/cms/features/review-workflows)、
  [Releases](https://docs.strapi.io/cms/features/releases)、
  [RBAC](https://docs.strapi.io/cms/features/rbac)
- Preview 支持从后台打开前台预览，Live Preview 支持编辑与预览联动；Content History
  提供修订浏览和恢复；Audit Logs 用于查询管理员行为。
  [Preview](https://docs.strapi.io/cms/features/preview)、
  [Content History](https://docs.strapi.io/cms/features/content-history)、
  [Audit Logs](https://docs.strapi.io/cms/features/audit-logs)
- Internationalization 和 Media Library 分别提供多语言内容与集中资产管理。
  [Internationalization](https://docs.strapi.io/cms/features/internationalization)、
  [Media Library](https://docs.strapi.io/cms/features/media-library)

## 4. 营销 CMS 必要能力矩阵

| 能力域 | 现代后台基线 | 本项目当前状态 | 优先级 | 建议交付 |
| --- | --- | --- | --- | --- |
| 内容建模 | 类型、字段、校验、引用、可复用组件/区块 | 后端已有固定类型和受控区块，后台不能查看模型、字段说明或模板 | P1；可配置模型为 P2 | P1 先做只读“内容类型目录”和模板化新建；P2 再引入有版本的模型定义与迁移门禁 |
| 内容列表 | 全文搜索、类型/状态/语言/作者/时间筛选、排序、分页、保存视图 | 当前一次加载并展示表格，缺少完整检索与视图 | P0 | 服务端分页和白名单排序；组合筛选、关键词、列配置、保存视图、URL 可分享查询 |
| 编辑体验 | 独立详情页、自动保存、离开保护、字段说明、校验、关联内容、草稿状态 | 新建集中在弹窗，缺少内容详情与持续编辑 | P0 | `/contents/new`、`/contents/:id` 路由；分区表单、自动保存/手动保存状态、冲突提示、关系选择器 |
| 可视化预览 | 桌面/平板/手机预览、草稿预览、点击定位字段、可分享预览 | 官网存在，但后台无草稿预览工作区 | P0 | 服务端签发短时一次性预览会话；同源预览壳、设备切换、语言切换，禁止公开草稿 API |
| 工作流与权限 | 可配置步骤、负责人、步骤迁移权、职责分离、到期提醒 | 固定 `draft → in_review → approved → published`，Scope 拆分较好 | P1 | 保留服务端状态机，增加工作流模板、负责人、截止时间、待办箱、步骤 SLA；迁移仍逐动作授权 |
| 评论与任务 | 条目/字段级评论、@提及、解决状态、个人/团队任务、截止时间 | 缺失 | P1 | 独立评论/任务集合，字段路径使用白名单；通知只传低敏引用；未完成阻断规则在服务端执行 |
| 版本与回滚 | 时间线、作者、变更摘要、字段级 diff、预览历史、恢复新草稿 | 后端已有修订和回滚，后台只要求人工输入版本号 | P0 | 版本抽屉/页面、双栏或逐字段 diff、选择历史预览、“恢复为新草稿”；不允许覆盖发布终态 |
| 排期与发布 | 日历、时区、冲突检查、发布/撤回排期、成组发布、上线前验证 | 有单条排期和恢复扫描，后台无日历/发布中心 | P0；发布包 P2 | P0 发布日历、时区显示、冲突/过期提示、上线检查清单；P2 增加原子发布包和整包预览 |
| 媒体资产 | 搜索、文件夹/标签、元数据、尺寸/格式、版权、替代文本、引用处、裁剪/衍生 | 有安全直传与 ready 校验，后台为上传按钮 + 表格 | P0/P1 | P0 媒体选择器、缩略图、搜索、Alt 完整度、引用处；P1 文件夹/标签、版权到期、焦点/裁剪及重复资产提示 |
| SEO | SEO 标题/描述、索引控制、Canonical、OG、结构化数据、slug、可读性与长度检查 | 新建表单仅有 SEO 标题/描述，缺少持续编辑和质量门禁 | P0 | SEO 面板、搜索/社交预览、slug 唯一性、canonical、robots、OG 图、结构化数据类型、质量评分；发布前服务端校验 |
| 本地化 | 翻译关系、语言独立状态、回退、并排编辑、缺失字段、翻译进度 | 有 `zh-CN`/`en` 独立记录，首页只粗略统计缺失英文 | P0 | 建立稳定 translation group；双栏/切换编辑、复制源语言、字段差异、完整度、过期翻译标识、各语言独立审批/排期 |
| 审计 | 按人员/动作/资源/时间筛选，详情、导出、保留策略 | 服务端已有审计语义，管理台没有可检索入口 | P1 | 只读审计中心；低敏投影、固定筛选、游标分页、导出审批；写入提交后审计故障继续隔离告警 |
| 批量操作 | 选择、批量验证、分配、标签、送审/发布/撤回、异步进度与部分失败报告 | 缺失 | P1 | 先做批量分配/标签/送审；发布类动作必须预验证、逐项版本绑定、后台任务和结果清单，禁止前端循环调用 |
| 分析 | 条目级浏览/转化、渠道和活动维度、时间对比、效果反馈到编辑器 | 缺失 | P1 | 接入第一方事件或 GA4 等分析源；按内容 ID/locale/revision 绑定，提供访问、CTA、表单转化和趋势，不把访客明细复制进 CMS |
| 线索管理 | 详情、来源、负责人、状态管道、备注/活动、筛选、导出、SLA、转化归因 | 有列表、状态变更、加密/去重和导出后端能力，后台缺负责人、备注及详情 | P0 | 线索详情抽屉、负责人、跟进备注、状态时间线、来源/活动筛选、待跟进视图、批量分配；联系方式按需展示并记录读取审计 |
| 运营首页 | 我的任务、待审核、待发布、翻译缺口、SEO/媒体告警、线索 SLA、失败副作用 | 当前仅四个统计数 | P0 | 角色化工作台；所有卡片可下钻到已应用筛选的列表，异常和待办优先于总量 |
| 重定向与内容下线 | slug 变更重定向、链接检查、下线原因、替代内容、过期复核 | 缺失 | P1 | 独立 Redirect 实体、循环/冲突校验、定期失效检查；撤回时要求原因与替代目标 |

## 5. 推荐信息架构

建议将当前单页三个 Tab 重构为稳定左侧导航：

1. **工作台**：我的任务、待审核、今日发布、翻译/SEO/媒体告警、待跟进线索、失败副作用。
2. **内容**：全部内容、文章、案例、服务、页面；支持保存视图和批量选择。
3. **发布中心**：日历、已排期、发布历史；未来扩展发布包。
4. **媒体库**：网格/列表、上传、文件夹/标签、资产详情、引用关系。
5. **本地化**：语言矩阵、缺失翻译、过期翻译、语言独立工作流。
6. **线索**：管道、列表、我的待跟进、导出任务。
7. **分析**：内容表现、转化漏斗、渠道/活动、条目级洞察。
8. **审计与运营**：审计日志、副作用状态、人工重放（继续受 R2 Scope 保护）。
9. **设置**：内容类型目录、工作流、SEO 默认值、语言、媒体规范、通知规则。

内容编辑页采用三栏或“主编辑区 + 右侧上下文栏”：主区编辑结构化字段和区块；右栏显示
状态、语言、负责人、SEO 分数、任务评论和发布动作；预览以可调整宽度的并排模式开启。
发布动作只在固定操作区展示，并明确列出验证错误、未完成任务、翻译状态和排期时区。

## 6. 分阶段实施建议

### 6.1 第一阶段：把现有能力产品化（P0）

1. 新建管理台骨架、路由和角色化工作台，保留现有 Scope 显隐及服务端鉴权。
2. 将内容列表改为服务端分页、全文检索、白名单排序与组合筛选，加入 URL 查询状态。
3. 建立内容新建/详情编辑页，支持保存、强 ETag 冲突处理、离开保护和关联媒体选择。
4. 增加版本时间线与字段级 diff，替代“手输 revision 回滚”。
5. 增加安全草稿预览、设备/语言切换和发布前检查面板。
6. 增加发布日历、本地化矩阵、SEO/社交预览和媒体 Alt/引用完整度。
7. 完成线索详情、负责人、备注、状态时间线、筛选和待跟进视图。

验收标准应以营销人员完整完成“创建中文内容 → 关联英文版本 → 选择媒体 → SEO 检查 →
预览 → 送审 → 批准 → 排期 → 查看效果”和“接收线索 → 分配 → 跟进 → 关闭”的端到端
任务为准，而不是以页面或接口数量计数。

### 6.2 第二阶段：协作与规模化（P1）

1. 评论、@提及、任务、负责人、截止时间、待办箱和工作流 SLA。
2. 保存视图、批量分配/标签/送审、异步批量验证和逐项结果报告。
3. 媒体文件夹/标签、版权期限、重复检测、裁剪/焦点与引用追踪。
4. 审计检索与受控导出、重定向与链接健康检查。
5. 按内容 ID、locale、revision、campaign/UTM 建立内容分析和线索归因摘要。

### 6.3 第三阶段：平台化与优化（P2）

1. 版本化内容模型设计器、模型迁移预演和生产变更审批。
2. 多条内容组成的发布包、整包验证/预览、原子发布与回滚。
3. 内容实验、受众分群、个性化、翻译供应商和 AI 辅助质检。
4. 与 CRM/营销自动化平台同步线索，但 ERP 继续保留可信租户、加密、幂等和审计边界。

## 7. 架构与安全约束

- 搜索、排序、筛选、批量操作必须由服务端实施字段白名单，不能把任意 Mongo 条件交给
  管理台。
- 草稿预览必须使用短时、用途受限、绑定内容/语言/版本的预览会话；不得放宽匿名发布
  内容 API，也不得把后台 Bearer Token 注入 iframe URL。
- 自动保存必须继续使用强 ETag/版本乐观锁。冲突时展示差异并要求用户选择，不得静默
  以最后写入覆盖。
- 评论、任务、通知和分析事件不得携带联系人、AI 提示词、签名 URL 或正文快照；只使用
  稳定低敏标识和受控摘要。
- 批量发布应像 Contentful 的 Bulk Actions 一样异步执行并逐项绑定权限和版本；不能在
  浏览器中循环复用单条动作。
- 线索联系方式仍按需解密；列表默认遮罩，查看明文必须单独 Scope、失败关闭读取审计，
  CSV 继续防公式注入。
- 内容分析只保存按内容和时间聚合的最小指标；访客级身份和行为明细留在分析平台。
- AI 只能生成或建议内容，继续保持显式人工复核，不能获得批准、排期或发布权限。
- 后端可靠发布、事务 Outbox、提交后审计隔离和现场联调边界必须保持；后台体验升级不得
  破坏 `docs/marketing-cms.md` 已定义的安全协议。

## 8. 不建议立即复制的能力

- 不建议 P0 就建设任意 Schema 设计器。当前官网内容类型有限，先用模板与只读类型目录
  验证编辑流程；动态模型会引入迁移、兼容、权限和前台渲染风险。
- 不建议把 CMS 直接做成完整 CRM。管理台只需覆盖营销线索首次响应、分配、跟进和归因，
  深度销售流程应通过明确契约对接专业系统。
- 不建议为了“可视化”允许任意 HTML/JavaScript 区块；继续使用受控区块和前台组件注册表。
- 不建议用 AI 自动翻译、自动 SEO 或自动发布替代人工决定；AI 输出必须可比较、可拒绝、
  可追踪，发布权保持职责分离。

## 9. 官方来源索引

### Contentful

- [Data model](https://www.contentful.com/developers/docs/concepts/data-model/)
- [Roles](https://www.contentful.com/developers/docs/references/content-management-api/roles/)
- [Workflow steps management](https://www.contentful.com/help/ai-automations/workflows/workflows-steps-management/)
- [Comments](https://www.contentful.com/help/content-and-entries/comments/)
- [Tasks](https://www.contentful.com/help/content-and-entries/tasks/)
- [Live preview](https://www.contentful.com/help/content-preview/live-preview/)
- [Localization strategies](https://www.contentful.com/help/localization/field-and-entry-localization/)
- [Bulk Actions](https://www.contentful.com/developers/docs/references/content-management-api/bulk-actions/)
- [Analytics](https://www.contentful.com/help/analytics/)
- [Google Analytics 4](https://www.contentful.com/help/apps/google-analytics-4/)

### Sanity

- [Studio](https://www.sanity.io/docs/studio)
- [Content Releases user guide](https://www.sanity.io/docs/studio/content-releases)
- [Content releases and versions API](https://www.sanity.io/docs/apis-and-sdks/js-client-releases)
- [Roles](https://www.sanity.io/docs/user-guides/roles)
- [Localization](https://www.sanity.io/docs/studio/localization)
- [Media Library introduction](https://www.sanity.io/docs/media-library/introduction)
- [History API](https://www.sanity.io/docs/http-reference/history)

### Strapi

- [Content-type Builder](https://docs.strapi.io/cms/features/content-type-builder)
- [Content Manager](https://docs.strapi.io/cms/features/content-manager)
- [Review Workflows](https://docs.strapi.io/cms/features/review-workflows)
- [Releases](https://docs.strapi.io/cms/features/releases)
- [RBAC](https://docs.strapi.io/cms/features/rbac)
- [Preview](https://docs.strapi.io/cms/features/preview)
- [Content History](https://docs.strapi.io/cms/features/content-history)
- [Audit Logs](https://docs.strapi.io/cms/features/audit-logs)
- [Internationalization](https://docs.strapi.io/cms/features/internationalization)
- [Media Library](https://docs.strapi.io/cms/features/media-library)
