# GaoQ 多维表格与审批表单设计器公开资料调研

> 日期：2026-08-09
> 范围：飞书多维表格、氚云表单与流程设计器，以及可借鉴的官方开源仓库
> 证据边界：只引用产品官方帮助中心、官方开放平台、官方 GitHub 仓库和许可证原文；本文不是法律意见

## 1. 结论先行

GaoQ 不宜分别建设一套“多维表格数据”和一套“审批表单数据”。更稳妥的目标是建立一个共享的版本化元数据内核：

`Workspace → Base → Table/Form → Field → Record → View/FormLayout → Workflow/Automation → Permission`

在这个内核上提供两种工作界面：

- 飞书式数据工作台：高密度表格、同源多视图、记录详情、关联计算、仪表盘、自动化和开放接口。
- 氚云式搭建工作台：左侧控件/节点、中间拖拽画布、右侧属性，支持表单布局、跨表规则、复杂审批流和节点级字段权限。

当前 GaoQ 已有正确的安全底座和部分元模型，但离“完整产品”仍有明显距离：多维 Base 已声明 7 类视图，生产界面实际只有 grid 渲染，其余视图仍是占位；自动化目前主要是定义保存与校验，没有完整设计器、执行编排和运行日志；审批流程设计器目前是线性节点列表，尚不具备连线分支、并行汇合和子流程。应先补齐这些真实闭环，再做 AI 搭建和大规模实时协作。

开源策略上，建议优先采用 MIT 许可的基础组件（Formily、dnd-kit、React Flow），并自行实现 GaoQ 领域模型。APITable、Teable 的产品与架构最值得研究，但主体为 AGPL；NocoDB 已改为 Sustainable Use License；SurveyJS Creator 是商业开发者许可。它们适合用作公开行为参考，不应直接把受限代码复制进 GaoQ 专有仓库。

## 2. GaoQ 当前实现基线与主要缺口

本节是对当前仓库的只读核对，不代表外部产品已经联调或生产验收。

| 能力 | 当前实现证据 | 判断 |
| --- | --- | --- |
| 动态字段 | `apps/erp-api/src/modules/dynamic-form/domain/dynamic-form.ts` 已定义 22 类字段、附件策略、单/多关联、关联属性及 L1–L4 分级 | 安全骨架可复用；缺公式、汇总、自动编号、系统字段、评分/进度/按钮、子表等 |
| 表单设计 | `apps/erp-web/app/workspace/forms/dynamic-form-designer.tsx` 已有三栏布局、拖入/排序、属性面板、预览、关系图、草稿/发布 | 方向正确；HTML5 DnD、单层 full/half 布局，缺嵌套容器、撤销重做、复制、响应式布局、字段联动与影响分析 |
| 审批流程 | 同文件已有审批/抄送、审批人解析、简单条件、会签/或签配置 | 当前本质是线性数组；缺图式连线、多个条件边、经办、并行汇合、子流程、退回路径、节点字段权限矩阵 |
| 多维 Base | `domain/multidimensional-base.ts` 已定义 grid、kanban、calendar、gallery、gantt、form、dashboard，以及筛选、排序、分组、自动化定义 | 定义层领先于交互和运行时 |
| 多视图前端 | `multidimensional-base-console.tsx` 读取最多 100 条记录，grid 使用 Ant Design Table；其他视图进入 `ViewPlaceholder` | 这是用户感知“不完整”的直接原因；尚不是可用的多维表格 |
| 自动化 | 已有数据/定时/webhook/manual 触发器和通知、增改记录、发起审批、连接器动作 Schema | 尚未看到完整执行编排、运行实例、重试/幂等日志与设计器闭环 |
| 外部接入 | 已有 REST/OpenAPI、CloudEvents、MCP/CLI 方向，并坚持租户、Scope、幂等、加密边界 | 应继续让 UI、REST、MCP、CLI 复用同一应用服务，不新增旁路 |

## 3. 飞书多维表格：应该复刻的功能与交互范式

### 3.1 对象模型与信息架构

飞书把多维表格描述为“表格形态的数据库”：一个多维表格内可有多张数据表，一张数据表可有多个视图；各视图共享同一份记录，视图的筛选、分组、排序和字段展示配置彼此独立。[飞书：数据表和视图](https://www.feishu.cn/hc/zh-CN/articles/472603853615-%E5%A4%9A%E7%BB%B4%E8%A1%A8%E6%A0%BC%E7%9A%84%E6%95%B0%E6%8D%AE%E8%A1%A8%E5%92%8C%E8%A7%86%E5%9B%BE)

开放平台也把资源拆为 app、table、view、record、field、dashboard、role/member 和 workflow，说明这些对象应有独立稳定标识与接口边界。[飞书开放平台：多维表格概述](https://open.feishu.cn/document/server-docs/docs/bitable-v1/bitable-overview?lang=zh-CN)

对 GaoQ 的直接约束：

- 视图只能保存“如何看同一份记录”，不能复制出一份业务数据。
- 表单视图只能是 Table Field Schema 的采集布局，不能另起一套字段定义。
- Base、Table、Field、View、Record 必须都用稳定 ID；名称只是可变显示属性。
- 左侧导航宜同时容纳数据表、仪表盘和工作流，当前对象在主工作区展开。

### 3.2 字段、关联和计算

飞书官方字段体系覆盖常规字段、进度/评分/按钮等业务字段、公式、创建/修改信息、自动编号、单/双向关联和查找引用；首列为记录索引列。[飞书：使用多维表格字段](https://www.feishu.cn/hc/zh-CN/articles/541575577400-%E4%BD%BF%E7%94%A8%E5%A4%9A%E7%BB%B4%E8%A1%A8%E6%A0%BC%E5%AD%97%E6%AE%B5)

关联交互不是简单保存外键：配置时选择目标表和可选数据范围；填写时用可搜索、可勾选的记录选择器；选中后可看关联记录详情并跳转目标表。[飞书：单向关联字段](https://www.feishu.cn/hc/zh-CN/articles/361914682520-%E4%BD%BF%E7%94%A8%E5%A4%9A%E7%BB%B4%E8%A1%A8%E6%A0%BC%E5%8D%95%E5%90%91%E5%85%B3%E8%81%94%E5%AD%97%E6%AE%B5)

查找引用通过配置面板选择源表、源字段及“全部/任一”条件，结果随源数据实时更新且不可直接编辑。[飞书：查找引用字段](https://www.feishu.cn/hc/zh-CN/articles/398396737655-%E7%94%A8%E6%9F%A5%E6%89%BE%E5%BC%95%E7%94%A8%E6%95%B0%E6%8D%AE)

GaoQ 应补齐的字段插件协议至少包括：

- `value schema / codec / storage / encryption / audit redaction`
- `grid cell renderer + editor`
- `form renderer + property editor`
- `record-detail renderer`
- `filter / sort / group / aggregate operators`
- `formula input/output type`
- `import / export conversion`
- `permission and sensitivity behavior`

这样新增字段类型才不会同时修改多套巨大 `switch`。

### 3.3 同源多视图

飞书公开六类数据视图：表格、看板、日历、甘特、画册和表单。[飞书：使用多维表格视图](https://www.feishu.cn/hc/zh-CN/articles/360049067931-%E4%BD%BF%E7%94%A8%E5%A4%9A%E7%BB%B4%E8%A1%A8%E6%A0%BC%E8%A7%86%E5%9B%BE)

应复刻的是任务完成方式，而非像素：

- 表格：键盘连续编辑、框选、批量复制粘贴、字段显隐/排序/宽度、冻结行列、多级筛选/分组/排序、右键记录菜单、展开详情。
- 看板：按字段分列，拖卡后立即修改底层分组字段；更新应走强版本与幂等写入。
- 日历：日/周/月切换；拖动日程改变起止日期，拖两端改变时长；支持卡片字段和颜色配置。[飞书：日历视图](https://www.feishu.cn/hc/zh-CN/articles/980591272592-%E4%BD%BF%E7%94%A8%E5%A4%9A%E7%BB%B4%E8%A1%A8%E6%A0%BC%E7%9A%84%E6%97%A5%E5%8E%86%E8%A7%86%E5%9B%BE)
- 甘特：拖时间条修改计划，缩放时间粒度，支持里程碑和依赖关系。
- 画册：以附件为封面，点击卡片展开完整记录。
- 表单：题目明确绑定字段；分享、预览和提交都落到同一数据表。[飞书：表单视图](https://www.feishu.cn/hc/zh-CN/articles/356120632302-%E4%BD%BF%E7%94%A8%E5%A4%9A%E7%BB%B4%E8%A1%A8%E6%A0%BC%E7%9A%84%E8%A1%A8%E5%8D%95%E8%A7%86%E5%9B%BE)

仪表盘不是静态报表。飞书支持选数据源/范围、配置维度指标、拖动和缩放图表，并支持图表间联动筛选。[飞书：仪表盘图表联动](https://www.feishu.cn/hc/zh-CN/articles/743471387668-%E4%BD%BF%E7%94%A8%E4%BB%AA%E8%A1%A8%E7%9B%98%E7%9A%84%E5%9B%BE%E8%A1%A8%E8%81%94%E5%8A%A8%E5%8A%9F%E8%83%BD)

### 3.4 记录详情、权限、历史与协作

飞书支持关注单条记录，字段被 UI、自动化或 API 修改时通知关注者，并在权限不足时抑制无权字段通知。[飞书：关注单条记录](https://www.feishu.cn/hc/zh-CN/articles/453817491270-%E5%85%B3%E6%B3%A8%E5%A4%9A%E7%BB%B4%E8%A1%A8%E6%A0%BC%E5%8D%95%E6%9D%A1%E8%AE%B0%E5%BD%95)

高级权限可按角色控制表、记录条件和字段的阅读/编辑/新增/删除，并对多角色结果定义合并规则。[飞书：高级权限行列权限](https://www.feishu.cn/hc/zh-CN/articles/915018184717-%E9%AB%98%E7%BA%A7%E6%9D%83%E9%99%90%E7%9A%84%E8%A1%8C%E5%88%97%E6%9D%83%E9%99%90%E8%AF%B4%E6%98%8E)

历史记录覆盖表结构和数据的增删改、单条记录变更及历史版本恢复；恢复数据时保持当前权限配置。[飞书：历史记录](https://www.feishu.cn/hc/zh-CN/articles/263286036719-%E6%9F%A5%E7%9C%8B%E5%A4%9A%E7%BB%B4%E8%A1%A8%E6%A0%BC%E7%9A%84%E5%8E%86%E5%8F%B2%E8%AE%B0%E5%BD%95)

GaoQ 的记录详情应成为统一侧边抽屉/全页：字段、关联、附件、评论、关注者、活动流、审批状态和自动化运行记录共享同一个 record identity，并在服务端裁剪无权字段。

### 3.5 自动化、工作流与开放集成

飞书自动化的基本交互是 `trigger → conditions → actions`，保存并启用后运行；管理面板区分运行中/未启用、触发方式和创建者。[飞书：自动化流程](https://www.feishu.cn/hc/zh-CN/articles/665088655709-%E4%BD%BF%E7%94%A8%E5%A4%9A%E7%BB%B4%E8%A1%A8%E6%A0%BC%E8%87%AA%E5%8A%A8%E5%8C%96%E6%B5%81%E7%A8%8B)

工作流支持多分支，可执行第一条命中分支或所有命中分支。[飞书：工作流多分支节点](https://www.feishu.cn/hc/zh-CN/articles/576337753396)

最新公开能力还包括 AI 生成工作流、AI 分类节点和可调用自定义 MCP 工具的 AI Agent 节点。[飞书：多维表格全新功能说明](https://www.feishu.cn/hc/zh-CN/articles/366209794581-%E5%A4%9A%E7%BB%B4%E8%A1%A8%E6%A0%BC%E5%85%A8%E6%96%B0%E5%8A%9F%E8%83%BD%E8%AF%B4%E6%98%8E)

对 GaoQ 的边界：

- 自动化定义必须编译成服务器执行计划，不能在浏览器中直接执行外部副作用。
- 每个运行实例都要有触发事实、节点输入摘要、幂等键、状态、稳定错误码、重试/人工复核记录。
- MCP/CLI 只复用应用服务；R2/R3 动作继续使用现有确认和强认证边界。
- AI 生成的只是草稿定义，必须经过 Schema 校验、权限分析和人工发布。

## 4. 氚云：应该复刻的表单与审批搭建范式

### 4.1 三栏表单设计器

氚云官方明确采用左侧控件选择区、中间表单编辑区、右侧属性设置区；用户把控件拖入画布后配置名称、描述、校验和权限并保存。[氚云：表单设计](https://help.h3yun.com/api/preview/1/777/874)

氚云公开称有 31 类控件，分为基础、布局、系统和高级控件；删除已有数据的控件会清除相应内容，因此设计器必须给出明确影响提示。[氚云：控件说明](https://help.h3yun.com/contents/788/847.html)

值得 GaoQ 复刻的设计器细节：

- 控件库可搜索并按基础、组织、业务、关联、布局分组。
- 拖拽时显示精确插入线和允许/禁止落点；支持容器内嵌套、跨容器移动。
- 选中节点后在右侧修改属性，不用弹窗打断连续搭建。
- 支持复制、删除、键盘移动、撤销/重做、桌面/H5 预览。
- 删除字段、改变字段类型、改变关联目标前先做影响分析：数据、公式、视图、权限、流程、自动化、API 映射分别列出。
- 布局至少支持分组、说明、分隔、一行多列和子表。氚云子表用于固定列结构下的不定明细行。[氚云：布局控件](https://help.h3yun.com/contents/790/849.html)

### 4.2 表单关系和业务规则

氚云把数据标题作为记录的主显示标识和关联选择器显示值；普通表单和流程表单共用表单结构，流程表单只是在其上开启流程。[氚云：表单设计帮助](https://help.h3yun.com/contents/63/18.html)

关联表单不仅选取目标记录，还可限制可选范围并把目标字段填入当前表单；关联属性实时展示目标字段且不可编辑。[氚云：高级控件](https://help.h3yun.com/api/preview/1/792/853)

业务规则可跨表 INSERT、UPDATE、UPSERT、DELETE，也能追加、覆盖或移除附件；执行语义区分数据生效和作废。[氚云：业务规则高级函数](https://help.h3yun.com/contents/808/873.html)

GaoQ 不应照搬自由文本函数直接操作数据库。可借鉴其简易/高级两种编辑体验，但内部必须编译为白名单 AST：

- 目标表、字段、操作符和函数均来自元数据注册表。
- 提交前静态分析循环引用、权限、敏感字段和副作用等级。
- 事务内完成记录/关系/Outbox；提交后外部副作用交给 Worker。
- 禁止规则表达式直接拼 Mongo 查询、任意 URL 或任意 JavaScript。

### 4.3 图式流程设计器

氚云流程由经办、审批、抄送、汇合点、子流程和连接线组成；流程需要一条从开始到结束的主路线，并可有条件分支。[氚云：流程设计](https://help.h3yun.com/api/preview/1/778/875)

审批节点可配置处理人、字段权限、通知和按钮；处理人可来自人员、部门、角色、表单字段或经理函数。[氚云：流程节点和连接线](https://help.h3yun.com/contents/814/878.html) [氚云：节点处理人](https://help.h3yun.com/contents/815/877.html)

最关键的差异是“每节点字段权限矩阵”：同一字段在不同节点可分别设置可见、可写、必填和打印，而不是只依赖表单全局权限。[氚云：流程节点操作权限](https://help.h3yun.com/api/preview/1/817/880)

GaoQ 流程定义应从当前线性 `nodes[]` 升级为版本化图：

```text
WorkflowDefinition
├─ nodes: start | task | approval | copy | branch | join | subflow | end
├─ edges: source + target + condition + priority
├─ assigneeResolver
├─ nodeFieldPolicy: fieldId -> hidden | readonly | writable | required
├─ decisionPolicy: all | any | sequential | count | percentage
└─ timeoutPolicy / rejectTarget / exceptionPolicy
```

发布校验至少包括：可达性、无孤儿节点、开始/结束唯一性、条件边穷尽或默认分支、并行汇合闭合、子流程版本锁定、审批人最大展开数、字段引用闭合和高风险节点强认证。

## 5. 官方开源实现比较与取舍

### 5.1 结论矩阵

| 项目 | 最值得借鉴 | 与 GaoQ 适配度 | 官方许可事实 | 建议 |
| --- | --- | --- | --- | --- |
| [APITable](https://github.com/apitable/apitable) | Canvas 高性能表格、OT 实时协作、Changeset/Operation/Action/Snapshot、跨表关联、API-first；技术栈含 NextJS/NestJS/TypeScript | 很高 | 开源版为 AGPL；官方还说明嵌入及移除品牌涉及 AGPL/企业许可，[LICENSING](https://github.com/apitable/apitable/blob/develop/LICENSING.md) | 研究架构和公开交互，不复制应用代码；若要嵌入或衍生必须先法务/商业许可评估 |
| [Teable](https://github.com/teableio/teable) | Next.js + NestJS、表格/表单/看板/画册/日历、公式、实时、撤销重做和百万行方向 | 很高 | `apps/nestjs-backend`、`apps/nextjs-app` 为 AGPL；`packages/` 为 MIT，且许可证含品牌附加条款，[LICENSE](https://github.com/teableio/teable/blob/develop/LICENSE) | 仅考虑逐包审计后的 MIT package；禁止从两个 app 目录复制代码或视觉资产 |
| [NocoDB](https://github.com/nocodb/nocodb) | 视图体系、字段/关系、workflow/scripts/webhook、Dashboard、REST 和 MCP 产品面 | 高 | 当前 develop/master 为 Sustainable Use License，只允许内部业务或非商业/个人使用等有限范围，[LICENSE](https://github.com/nocodb/nocodb/blob/develop/LICENSE.md) | 只作产品和 API 参考；在 GaoQ 商业边界未澄清前不要集成或复制源码 |
| [Baserow](https://github.com/baserow/baserow) | 字段插件、关系/lookup/rollup、视图、API-first、自动生成 API 文档 | 中高 | OSE 与客户端 JS 为 MIT；`premium/`、`enterprise/` 另有许可证，[LICENSE](https://github.com/baserow/baserow/blob/develop/LICENSE) | 全平台中可借鉴代码风险相对最低，但 Vue/Django/Postgres 与 GaoQ 技术栈不同；只能从 OSE 范围选择并保留版权通知 |
| [Formily](https://github.com/alibaba/formily) | 响应式字段状态、JSON Schema 驱动渲染、表单联动、React/Ant Design 集成思路 | 高 | MIT，[LICENSE](https://github.com/alibaba/formily/blob/formily_next/LICENSE.md) | 可做表单运行时/状态模型 POC；先验证 React 19、Ant Design 6、无障碍和现有 Schema 兼容性，避免形成双元模型 |
| [SurveyJS Form Library](https://github.com/surveyjs/survey-library) | 动态 JSON 表单渲染、条件逻辑、多页、校验、自动保存、签名/图片等字段 | 中 | Form Library 为 MIT | 可参考或用于纯表单渲染 POC |
| [SurveyJS Creator](https://github.com/surveyjs/survey-creator) | 成熟拖拽 Builder、属性面板、条件逻辑、主题编辑 | 高 | 生产集成需要按开发者购买商业许可，[许可证原文](https://github.com/surveyjs/survey-creator/blob/master/LICENSE) | 未购买前不得用于生产；可以用官方演示评估交互 |
| [dnd-kit](https://github.com/clauderic/dnd-kit) | 列表/网格/多容器/嵌套拖拽，鼠标、触控、键盘传感器和无障碍 | 高 | MIT，[LICENSE](https://github.com/clauderic/dnd-kit/blob/main/LICENSE) | 适合表单画布、字段/视图排序、看板拖卡；先锁定稳定版本并做 React 19 POC |
| [React Flow / xyflow](https://github.com/xyflow/xyflow) | 节点、边、手柄、缩放、框选、小地图、自定义节点，适合流程和自动化画布 | 高 | MIT，[LICENSE](https://github.com/xyflow/xyflow/blob/main/LICENSE) | 推荐作为流程画布层；领域图、校验和执行必须留在 GaoQ 服务端 |

### 5.2 不建议“整仓移植”的原因

- APITable 和 Teable 的应用层与 GaoQ 技术栈接近，反而最容易无意复制出 AGPL 衍生关系。
- Baserow 技术栈差异较大，移植成本可能高于按 GaoQ 领域模型实现。
- NocoDB 当前许可证已不是标准开源许可，不能依据旧版本印象判断。
- SurveyJS Creator “源码可见”不等于免费商用。
- 全平台代码往往绑定其自己的权限、数据库、实时协作和插件模型，直接嵌入会破坏 GaoQ 已建立的可信租户、加密、审计、MCP 和审批安全边界。

因此推荐“组件级采用 + 行为级复刻 + 领域层自研”。每个新增依赖必须记录精确包名、版本、许可证文件摘要、引入文件和 NOTICE 要求。

## 6. 可落地目标架构

### 6.1 元数据内核

```text
DynamicDataPlatformModule
├─ Metadata
│  ├─ Base / Table / FieldDefinition
│  ├─ ViewDefinition / FormLayoutDefinition / DetailLayoutDefinition
│  ├─ WorkflowDefinition / AutomationDefinition / DashboardDefinition
│  └─ PermissionPolicy / PublishedRevision
├─ Data
│  ├─ Record / RelationEdge / AttachmentReference
│  ├─ FormulaDependency / ComputedProjection
│  └─ RecordHistory / Comment / Watcher
├─ Runtime
│  ├─ QueryPlanner / FieldRegistry / FormulaEngine
│  ├─ WorkflowRuntime / AutomationRuntime
│  └─ ImportExport / Connector / Webhook
└─ Surfaces
   ├─ REST / CloudEvents
   ├─ Web UI
   ├─ MCP（风险受控）
   └─ CLI（服务身份）
```

不要把动态记录继续无限塞进一个未索引的 `values` 对象后在浏览器全量过滤。建议：

- 元数据仍可保存在 MongoDB，但每个字段定义必须带稳定 `fieldId` 和不可复用 key。
- 查询使用服务端游标、白名单 Query AST 和 View Query Plan；禁止客户端传任意 Mongo 操作符。
- 高频筛选/排序字段需要受控投影或物化索引；新增索引仍遵循现有 dry-run、审批和无破坏迁移规则。
- 公式、lookup、rollup 建依赖图，发布时检查环路；同步计算有预算，超预算进入 Worker 物化。
- 关系边保持独立集合并反向绑定租户、源/目标表和记录；删除、归档和权限变化需有明确策略。
- 附件只存受控对象引用和元数据，上传、预览、病毒扫描、保留和授权走独立边界。

### 6.2 前端分层

```text
Metadata Studio
├─ Form Builder          dnd-kit + GaoQ Field Registry
├─ Workflow Builder      React Flow + GaoQ Graph Schema
├─ Automation Builder    React Flow/step builder + GaoQ Action Registry
└─ View/Dashboard Config GaoQ View Registry

Data Runtime
├─ Virtualized Grid
├─ Kanban / Calendar / Gantt / Gallery / Form
├─ Record Detail
└─ Dashboard
```

画布库只负责拖拽、坐标、边和选择态；任何业务定义都必须转成 GaoQ 自有的严格 Schema。前端状态建议采用 Command 模型实现撤销/重做：`addField`、`moveNode`、`changeProperty`、`connectEdge` 等命令可逆，保存时只发送规范化完整草稿或带版本的 Patch。

### 6.3 工作流与自动化运行边界

- 审批工作流负责“人做决定、权限和证据”；自动化负责“系统执行触发与动作”。两者共享图编辑器和条件 AST，但运行时、风险等级和审计语义分离。
- 保存草稿、发布修订、启用运行必须分离。运行实例永久绑定已发布修订，不能随编辑中的草稿漂移。
- 外部副作用采用 Inbox/Outbox、确定性幂等键、租约栅栏和结果未知人工复核，继续遵守仓库既有 CR 标准。
- 自动化需要运行列表、逐节点输入/输出摘要、耗时、重试、稳定错误码和人工重放入口；敏感正文不进入日志。

## 7. 分阶段实现建议

### P0：从“有定义”变成“可用产品”

1. **统一字段注册表**：把当前前后端散落的字段类型判断收敛为 Schema、序列化、校验和 UI renderer 契约。
2. **真正的多维表格 grid**：虚拟滚动、单元格编辑、键盘导航、框选/复制粘贴、列宽/排序/冻结、记录详情、游标分页和强版本写入。
3. **View CRUD 与查询计划**：字段显隐、分组、筛选、排序真实保存；用户可新建、复制、重命名、锁定和删除视图。
4. **表单设计器基础升级**：dnd-kit、多容器嵌套布局、一行多列、子表、复制、撤销/重做、设备预览和删除影响分析。
5. **图式审批设计器**：React Flow，先落地开始/结束、经办、审批、抄送、条件边、并行汇合和子流程；发布前图校验。
6. **节点字段权限矩阵**：可见/只读/可写/必填/打印，并提供“以某角色/节点预览”。

P0 验收不能使用静态演示数据代替：看板拖卡、日历拖动、表单提交、审批流转都必须真实改写同一条记录并经过正式应用服务。

### P1：业务完整性

1. 公式、自动编号、系统字段、lookup/rollup/count、评分/进度/按钮等字段。
2. 看板、日历、甘特、画册、表单六视图全部接入统一 View 引擎。
3. 关联记录选择器、反向关联、跨表填充、关系详情和跳表。
4. 记录详情自定义布局、评论、关注、附件、活动流、打印/分享。
5. 自动化设计器和运行时：数据/定时/按钮/webhook 触发，条件、分支、循环、查找、新增/更新、通知、HTTP 和发起审批。
6. 会签/或签/顺序签、退回、撤回、转交、催办、加签、超时和异常审批人策略。
7. Base/Table/Field/Record 高级权限和角色结果预览。

### P2：高级体验与规模

1. Dashboard 拖拽布局、指标卡、图表、切片器和图表联动。
2. CSV/XLSX 导入时自动推断字段，先预览映射、错误行和转换影响；导出结构与数据。
3. 同步表/外部连接器：远端字段标记为只读来源字段，可加 GaoQ 本地字段。
4. Schema/记录/视图历史、Time Machine、归档、沙箱发布和模板中心。
5. AI 生成 Base、表单、字段、流程和仪表盘，但只生成待审核草稿；AI 执行仍通过受控 MCP。
6. 在真实并发指标证明需要后，再引入 OT/CRDT；不要把实时协作置于字段、视图和权限正确性之前。

## 8. 交互验收清单

### 多维表格

- 10,000 条以上样例数据仍能平滑滚动，网络只按视窗/游标取数。
- 鼠标与键盘均可完成连续编辑；复制粘贴先预览错误并保证批次幂等。
- 字段拖动、调宽、显隐、冻结、分组、筛选、排序会持久化为当前视图配置。
- 看板拖卡和日历/甘特拖动立即更新真实字段；冲突时明确提示并支持重新加载，不静默覆盖。
- 所有视图打开同一记录详情并显示一致的版本、权限和活动流。
- 关联选择器可搜索、分页、查看详情和跳转；无权记录永远不出现在候选列表。

### 表单设计器

- 左侧控件可点击添加，也可拖到精确位置；键盘用户可完成同等排序。
- 容器明确显示允许的子节点类型，不合法落点有原因提示。
- 属性修改实时预览；撤销/重做覆盖拖拽和属性修改。
- 删除/改类型前展示数据、公式、视图、流程、自动化和 API 影响。
- 草稿、发布修订和运行实例清晰区分；发布版本不可原地修改。

### 流程/自动化设计器

- 支持缩放、平移、框选、小地图、对齐、快捷键和自动布局。
- 边可配置条件和优先级；错误节点/边可从校验面板一键定位。
- 每节点都有处理人、字段权限、按钮、通知、超时和异常策略摘要。
- 提供真实数据试运行，但试运行不得执行外部副作用；外部动作以模拟结果显示。
- 发布前显示风险摘要：R2/R3 节点、外部连接器、L3/L4 字段、无处理人可能性和不可达路径。

## 9. 许可证、品牌与知识产权边界

1. 可以复刻公开功能语义、常见信息架构和任务路径；不要复制飞书/氚云商标、名称、图标、插画、截图、文案、CSS、专有代码或逐像素整体外观。
2. GaoQ 应使用自己的设计 token、组件、图标和术语；验收指标应是任务成功率、步骤数、错误恢复和性能，而不是像素相似度。
3. APITable、Teable 的 AGPL 应视为红线依赖。任何源码复制、修改、链接、嵌入或衍生行为在实施前都需由法律/许可证负责人审查。
4. NocoDB 当前是 Sustainable Use License，不能按旧 AGPL 版本或“GitHub 可见”推定可商用集成。
5. Baserow 必须逐文件排除 `premium/`、`enterprise/`；MIT 代码仍需保留版权和许可通知。
6. SurveyJS Creator 需商业开发者许可；Form Library 的 MIT 许可不能推导 Creator 免费。
7. Teable 只有明确位于 `packages/` 且自身许可证为 MIT 的包才可进入技术评估，应用目录不可混用。
8. 每个第三方包进入仓库前建立 SBOM、许可证摘要、NOTICE、版本锁定、漏洞扫描和替换预案。

## 10. 推荐决策

- **立即采用的方向**：GaoQ 自有元数据内核；dnd-kit 用于表单/看板拖拽；React Flow 用于审批/自动化画布；Formily 只做兼容性 POC后决定是否作为运行时。
- **只研究不复制**：APITable、Teable 应用层、NocoDB，以及飞书/氚云公开交互。
- **需采购才采用**：SurveyJS Creator。
- **可选择性借鉴**：Baserow OSE 的字段插件与 API 组织方式，但不建议移植其全栈。
- **产品次序**：先完成 grid、真实六视图、三栏表单和图式审批的业务闭环；再做自动化执行、权限历史；最后做 AI 和大规模协作。

这条路径能最大限度复用 GaoQ 已经建立的 NestJS 模块化单体、Next.js、MongoDB、Outbox、可信租户、加密、审批和 MCP 安全边界，同时把用户最直接感知的“不齐全、不完整、交互不好”按可验收切片解决。
