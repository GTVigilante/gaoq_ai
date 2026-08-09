# GaoQ 动态表单、多维数据与自动化平台交接

交接日期：2026-08-09（Asia/Shanghai）
适用对象：产品负责人、架构师、开发、SRE、安全评审人员及后续 AI 代理

> 本文不包含密码、Token、数据库连接串或密钥。当前切片已受控部署生产；部署只
> 更新 GaoQ API、Worker 与 ERP Web，未删除或重建数据库/Redis，未重启 CMS、
> 专业算薪或同机其他项目。

## 1. 结论

本切片建立了一个共享数据内核，并提供两个独立工作台：

1. 氚云式动态表单与审批流程设计器；
2. 多维 Base/Table/View 数据管理工作台。

外部 REST、表单、多维表格、MCP 和 CLI 复用同一 `DynamicFormService` 与加密
Record Engine，不存在“外部写一套、页面再复制一套”的旁路。当前已经具备可继续
扩展的底座，但不应宣称已经完整复刻飞书多维表格：专用看板/日历/甘特/画册/仪表盘
渲染、公式与聚合引擎、自动化执行 Worker、Base 行列权限和 MCP 写确认仍待后续切片。

### 1.1 生产发布状态

- Git：`main@bdb09a0a53046a89f048650de9ccd60208479f41`，已推送 `origin/main`。
- Release：`/opt/gaoq-ai-releases/bdb09a0a530`；Compose Project：`gaoq-ai`。
- API 镜像：`sha256:fa8847e4f9e79eddb0a00c54b75186c2fd17de15da99313156be2515da39f2f0`。
- Worker 镜像：`sha256:627128c0b6ce7e15338ab317094a480f0a78a128b025d582091d5e9c8da7e816`。
- ERP Web 镜像：`sha256:b09fe7fb0b061af615aba4f519d7d0e8308313412f6ae8369122aeda36f9ac7f`。
- 三个目标容器均为 Docker `healthy`、`restart=0`；API live/ready、新表单页面与
  多维 Base 页面均为 200。
- CMS Website 与专业算薪沿用原镜像，未重建；回环健康检查均为 200。
- `FORM_DATA_ENCRYPTION_KEYS` 尚未配置，记录写入失败关闭；不得用临时或复用密钥
  绕过该边界。

## 2. 已实现能力

### 2.1 表单与审批设计

- 三栏拖拽设计器：字段目录、画布、属性面板；支持移动、复制、删除和半宽布局。
- 22 种数据字段：文本、长文本、数字、整数分金额、百分比、布尔、日期/时间、
  邮箱、手机、HTTPS URL、单/多选、成员、部门、附件引用、单/多关联、关联属性。
- 3 种布局组件：分组、说明、分隔线。
- 附件字段固化数量、单文件大小与类型策略；记录层只保存已验证附件 ULID 引用。
- 单向关联边、反向关联列表和一层实时关联属性；关联目标与租户在服务端复核。
- 流程画布支持审批/抄送节点、拖拽排序、会签/或签、条件执行、直属上级、角色、
  指定员工与表单部门负责人解析器。
- 流程可转换成既有 GaoQ 审批模板草稿；动态表单发布继续执行创建/发布职责分离。

### 2.2 共享 Record Engine

- 表单定义、记录与关联边均绑定可信租户上下文。
- 写入使用严格字段白名单、类型/范围/枚举/格式校验，拒绝只读关联属性与未知字段。
- 金额跨边界使用整数分字符串，不使用 JavaScript 浮点金额。
- 全记录以 AES-256-GCM 加密，HKDF 派生用途密钥，AAD 绑定租户、表单、记录和修订。
- `FORM_DATA_ENCRYPTION_KEYS` 缺失时定义设计仍可启动，任何记录写入失败关闭。
- 单条创建/更新和最多 50 条批量创建均使用幂等事务；关系边和 Outbox 同事务提交。
- 记录读取和列表为 R2 审计语义；读取审计不可用时不返回敏感记录。
- 领域事件只含表单/记录标识、版本和修订，不含记录值、附件或审批参与人。

### 2.3 Base/Table/View

- 一个 Base 最多挂接 100 张已发布动态表单作为 Table，不复制 Schema 或数据。
- View 定义支持 `grid`、`kanban`、`calendar`、`gallery`、`gantt`、`form`、
  `dashboard`，统一保存显示字段、冻结列、行高、排序、分组和筛选配置。
- Grid 工作台已读取真实加密记录并按字段定义渲染；L3/L4 字段有显式视觉标记。
- 其他六类 View 已具备控制面定义、目录和切换入口，专用布局渲染器尚未交付。
- 自动化定义支持记录创建/更新、周期、Webhook、手动触发，以及通知、建记录、
  更新记录、发起审批、登记 Connector 调用；任意 URL 不进入定义，外呼必须引用
  服务端登记的 `connectorId + operation`。
- 当前自动化只有严格定义与安全约束，执行 Worker、租约、重试、人工复核和运行
  证据尚未交付，因此生产必须保持 `enabled=false` 或不配置自动化。

### 2.4 外部接入

- OpenAPI 3.1 已重新生成：52 个 Controller、265 个路由声明、271 个 Operation。
- 动态表单 REST：定义 CRUD/发布、记录创建/列表/详情/更新、批量创建、双向关联。
- Base REST：创建、列表、详情、强版本更新。
- 外部系统使用 OAuth 2.1 Client Credentials，租户来自已验证服务身份；请求体不得
  传入或覆盖 `tenantId`。
- 所有写请求要求 8–128 位白名单 `Idempotency-Key`；更新另要求强 `If-Match`。
- AsyncAPI 3.0 当前包含 189 个事件，其中动态表单新增 5 个出站事件。

### 2.5 MCP 与 CLI

当前 ERP MCP 目录为 54 Tool、4 Resource、27 Resource Template、25 Prompt。
本切片新增：

- `dynamic_form_catalog`：已发布表单和字段最小目录，R0；
- `dynamic_form_record_get`：单条记录 L1/L2 安全投影，R1，永久排除 L3/L4 与附件；
- `multidimensional_base_catalog`：Base/Table/View 导航元数据，R0，不返回自动化动作。

MCP Tool 只调用应用服务，不访问 Repository/MongoDB。当前不提供 MCP 记录写入；
未来写能力必须使用既有 prepare/execute 一次性确认账本，不能注册直接写 Tool。

CLI 入口：

```bash
pnpm forms:cli -- help
pnpm forms:cli -- forms list
pnpm forms:cli -- records list --form <FORM_ULID> --limit 100
pnpm forms:cli -- records create --form <FORM_ULID> \
  --file ./values.json --key external-sync:00000001
pnpm forms:cli -- records bulk --form <FORM_ULID> \
  --file ./batch.json --key external-batch:00000001
```

CLI 只读取 `GAOQ_API_ORIGIN` 与短时 `GAOQ_ACCESS_TOKEN`，不接受命令行 Token，
不直连数据库，不输出响应正文中的自由文本错误。

## 3. 主要代码位置

| 目的 | 路径 |
|---|---|
| 表单领域与记录校验 | `apps/erp-api/src/modules/dynamic-form/domain/dynamic-form.ts` |
| Base/View/Automation 定义 | `apps/erp-api/src/modules/dynamic-form/domain/multidimensional-base.ts` |
| 加密记录 | `apps/erp-api/src/modules/dynamic-form/persistence/dynamic-form-data-crypto.service.ts` |
| 表单应用服务 | `apps/erp-api/src/modules/dynamic-form/application/dynamic-form.service.ts` |
| Base 应用服务 | `apps/erp-api/src/modules/dynamic-form/application/multidimensional-base.service.ts` |
| REST 入口 | `apps/erp-api/src/modules/dynamic-form/*.controller.ts` |
| 领域事件 | `apps/erp-api/src/modules/dynamic-form/persistence/dynamic-form-outbox.writer.ts` |
| 表单/流程设计器 | `apps/erp-web/app/workspace/forms/dynamic-form-designer.tsx` |
| 多维数据工作台 | `apps/erp-web/app/workspace/bases/multidimensional-base-console.tsx` |
| CLI | `scripts/dynamic-form-cli.mjs` |
| OpenAPI | `contracts/openapi/erp-api.openapi.json` |
| AsyncAPI | `contracts/asyncapi/erp-events.asyncapi.json` |

## 4. 数据集合与索引

新增逻辑集合：

- `dynamic_form_definitions`
- `dynamic_form_records`
- `dynamic_form_relations`
- `multidimensional_bases`

事件继续复用 `integration_outbox`。仅追加迁移
`phase-6-dynamic-data-platform-indexes-v1` 已随代码交付。生产只读 dry-run 已执行：
`checksum=hbtv21c45wIB1xjf2L1zkIRqX2Sr38s2ehIzUGOlMmA`、`missing=11`、
`created=0`、`verified=0`；尚未 apply。只有在备份、维护窗口和人类独立批准后才可
创建这 11 个追加索引。禁止删除集合、索引、MongoDB、Redis 或运行卷；禁止执行
`docker compose down -v`。

## 5. 已完成验证

- ERP API TypeScript 类型检查通过。
- ERP Web TypeScript 类型检查通过。
- 动态表单与 Base 领域测试：6 项通过。
- 新增集合索引迁移清单测试：2 项通过，未连接数据库、未执行 apply。
- MCP Tool Service：48 项通过，包含新增表单记录与 Base 安全投影。
- 官方 MCP Streamable HTTP 协议集成：1 项通过，54 Tool 目录逐项匹配。
- MCP 确定性目录与联调证据门禁自测通过。
- OpenAPI 和 AsyncAPI 已重新生成。
- 定向 ESLint 与 `git diff --check` 通过。
- 全仓覆盖测试 449 个文件、7,249 项；并发运行 7,247 项通过，两个 MCP 协议用例
  因资源竞争超时，单进程定向复跑 2/2 通过。
- `pnpm audit` 无已知漏洞；全工作区生产构建、`pnpm payroll:check` 和
  `pnpm payroll:deployment:validate` 通过。
- 生产 API/Worker/Web 镜像修订逐一绑定 `bdb09a0a530…`；新 REST 无 Token 均返回
  401，证明路由与身份边界生效。
- 公网 `aio.gaoq.com` 健康、表单、多维 Base 与算薪为 200，`joinus.gaoq.com/careers`
  和 `www.gaoq.com/zh-CN` 为 200；`gaoq.com` 的 HTTP/HTTPS 均 301 到 `www`。
- `recruit.gaoq.com/careers` 当前仍被 CDN 返回 404，属于外部配置待办。

上述仓库与生产验活不替代生产等价 Mongo 事务、浏览器 UAT、外部系统、附件、
自动化、实体 MCP 客户端、性能、安全和灾备验收。

## 6. 发布后人工待办

### P0：必须完成

1. 审查四个新增集合的 11 个追加索引及上述 dry-run 摘要，在备份与维护窗口另行
   批准 apply；本次部署没有创建索引。
2. 在 Secret Manager/KMS 生成独立 `FORM_DATA_ENCRYPTION_KEYS`，完成双密钥轮换演练；
   禁止复用审批、招聘或算薪密钥。
3. 注册最小 Scope：`erp:forms:design`、`erp:forms:publish`、
   `erp:forms:data:read/write`、`erp:bases:read/design`；完成职责分离和角色矩阵 UAT。
4. 为每个外部系统注册独立 OAuth Client Credentials 与可撤销短时 Token，不得共享。
5. 完成 Mongo Replica Set 事务、并发幂等、关系完整性、密钥轮换和备份恢复演练。
6. 重新执行 Kimi、Inspector 及计划支持客户端的 54 Tool 实体目录发现；旧 50 Tool
   证据不能用于当前发布。
7. 完成安全/隐私评审，尤其是 L3/L4 表单、员工/部门字段、附件和外部数据写入。
8. 在阿里 CDN 修复 `recruit.gaoq.com` 回源/缓存规则，并明确 recruit 与 joinus 的
   canonical 关系；当前可用招聘门户为 `joinus.gaoq.com/careers`。

### P1：启用完整产品能力前完成

1. 接入附件对象存储、恶意文件扫描、内容摘要、保留策略和下载授权；表单只保存引用。
2. 实现看板、日历、画册、甘特和仪表盘专用渲染器以及 Grid 行内编辑。
3. 实现公式 AST、查找引用/聚合、计算依赖图、循环检测和重算队列；禁止 `eval`。
4. 实现 Base 行/列/视图权限，并在 Record Engine 查询边界强制，而非只隐藏前端列。
5. 实现自动化 Worker：Inbox/Outbox、租约、幂等、重试、结果不确定人工复核、
   Connector 注册表和 Webhook 验签；生产外呼前进行 SSRF/重定向/正文上限验证。
6. 将动态流程发布与审批模板版本建立服务端不可变绑定，并完成实例化与回滚 UAT。
7. 如需 MCP 写入，实现 R1/R2 prepare/execute、确认过期和强认证，不增加直接写 Tool。
8. 增加有签名游标的分页、受控索引投影和大表性能门禁；当前列表硬上限为 200。

## 7. 发布与回滚边界

应用底座已经生产部署，但在 P0 完成前，**记录写入、外部系统写入和业务启用仍为
No-Go**。API、Worker、Web 与契约已绑定同一 commit；索引和密钥明确保持未启用。

运行时回滚备份：`/opt/gaoq-ai-runtime/compose.env.pre-bdb09a0-20260809`。回滚只恢复
该文件并对 `api worker web` 执行 `docker compose ... up -d --no-deps`，随后复核
live/ready 与公网入口。必须保留新增集合和数据，不删除记录、索引、密钥、MongoDB、
Redis 或卷，不得通过删库“恢复”。

## 8. 后续 AI 接手顺序

1. 先阅读本文件、根 `CODEX.md`、`docs/phase-0/README.md` 和项目 `AGENTS.md`。
2. 只在本仓库工作，先 `git status --short`，保留所有非本任务改动。
3. 优先完成 P0 索引迁移、密钥/Scope 契约和专项覆盖，再开发 P1 UI/Worker。
4. 每个切片同步 REST、事件、MCP、安全审计和文档；MCP 始终复用应用服务。
5. 未取得明确生产授权前，不 SSH、不连接生产 MongoDB、不执行迁移或发布。
