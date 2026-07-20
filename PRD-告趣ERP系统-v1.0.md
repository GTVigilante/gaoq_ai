# 告趣ERP系统（代号：GaoQ-OS）产品需求文档（PRD）

> **版本**: v1.1.0
> **日期**: 2026-07-21
> **撰写**: Kimi / Codex 架构团队  
> **目标读者**: 技术团队、产品团队、Kimi Code / Codex 编码 Agent  
> **技术栈**: NestJS + MongoDB + React/Next.js  
> **核心目标**: 替代氚云（审批）、智能薪酬（薪酬+人事）、招聘门户；自建 MCP 服务层；钉钉/飞书 SSO；一站式企业运营平台。
>
> **规范优先级**：本PRD描述产品需求；架构、租户、主数据、集成、MCP、安全、质量与上线门禁以[`docs/phase-0/`](./docs/phase-0/)为强制基线。冲突内容以Phase 0规范和已接受ADR为准。

---

## 1. 文档概述

### 1.1 项目背景
告趣（GaoQ）是小红书头部MCN机构，当前管理约300名员工，业务涵盖：
- **MCN业务**：达人签约、内容生产、账号运营
- **广告业务**：品牌投放、广告执行、结案报告
- **招商团长业务**：选品、撮合、佣金管理
- **电商返利业务**：返利追踪、结算、对账
- **投资业务**：浦积资本（PE）、星媒控股（CVC）

目前公司依赖多套外部SaaS系统（钉钉、飞书、氚云、智能薪酬、智能人事）管理内部运营，存在数据割裂、权限分散、培训成本高等问题。同时，公司自研的业务系统（OP）已成熟，即将对外发布SaaS版本，需要一个统一的企业级ERP底座。

### 1.2 核心目标
1. **替代外部系统**：完全替代氚云（审批流）、智能薪酬（薪酬计算与发放）、智能人事（招聘管理与招聘门户）。
2. **MCP原生**：系统从底层设计为MCP（Model Context Protocol）服务器，支持员工和外部合作方通过AI助手接入系统。
3. **SSO统一入口**：员工通过钉钉/飞书扫码SSO登录，无需记忆新密码。
4. **数据安全与合规**：严格的RBAC权限、数据脱敏、审计日志、数据隔离（MCN/广告/团长/返利/投资）。
5. **知识驱动培训**：建立岗位知识库（经纪人、编导、商务、媒介执行、媒介拓展），支持入职培训、考试、分享、总结。
6. **入职全引导**：从Offer签署到入职材料（行政、财务）一站式数字化引导。
7. **员工关怀**：在职关怀、离职管理、行业人才关系维护（PR库）。
8. **多端自适应**：PC端管理后台 + 移动端H5/小程序（简约美观，原生级体验）。
9. **可维护性**：所有接口必须附带中文注释和OpenAPI规范，代码仓库自解释。

### 1.3 术语表

| 术语 | 英文 | 定义 |
|------|------|------|
| MCP | Model Context Protocol | AI上下文协议，允许AI Agent通过标准化接口操作本系统 |
| SSO | Single Sign-On | 单点登录，通过钉钉/飞书身份提供商认证 |
| RBAC | Role-Based Access Control | 基于角色的访问控制 |
| OP | Operation Platform | 告趣现有自研业务系统，未来作为SaaS对外提供 |
| PE | Private Equity | 私募股权投资（浦积资本） |
| CVC | Corporate Venture Capital | 企业风险投资（星媒控股） |
| OKR | Objectives and Key Results | 目标与关键成果法（本系统支持） |
| SOP | Standard Operating Procedure | 标准作业程序 |

---

## 2. 用户角色体系

### 2.1 角色总览

| 角色编码 | 角色名称 | 描述 |
|----------|----------|------|
| SUPER_ADMIN | 超级管理员 | 系统初始化，技术团队使用，拥有所有权限 |
| GROUP_ADMIN | 集团管理员 | 告趣集团层面管理层，跨业务线查看数据 |
| HR_ADMIN | HR管理员 | 负责招聘、薪酬、员工关系、培训 |
| HRBP | HR业务伙伴 | 对接业务部门，负责培训安排、绩效考核、员工关系 |
| HR_SPECIALIST | HR专员 | 执行招聘、入职办理、考勤统计 |
| FINANCE_ADMIN | 财务管理员 | 负责薪酬审核、报销审批、财务公告 |
| FINANCE_STAFF | 财务专员 | 执行薪酬计算、发放、对账 |
| DEPARTMENT_LEAD | 部门负责人 | 各业务部门Leader（MCN/广告/团长/返利/投资） |
| TEAM_LEAD | 团队Leader | 小组负责人，如某经纪人团队Leader |
| EMPLOYEE | 正式员工 | 已通过试用期，有完整系统权限 |
| PROBATION | 试用期员工 | 入职30-180天内，部分敏感数据受限 |
| CANDIDATE | 候选人 | 已通过面试，进入Offer/入职流程 |
| EXTERNAL | 外部合作方 | 达人、品牌方、供应商，通过MCP/有限账号接入 |
| ALUMNI | 离职校友 | 已离职员工，保留校友社区权限 |

### 2.2 角色继承关系
```
SUPER_ADMIN
└── GROUP_ADMIN
    ├── HR_ADMIN
    │   ├── HR_SPECIALIST
    │   ├── HRBP
    ├── FINANCE_ADMIN
    │   ├── FINANCE_STAFF
    ├── DEPARTMENT_LEAD
    │   ├── TEAM_LEAD
    │   ├── EMPLOYEE
    │   └── PROBATION
    └── CANDIDATE (流转为 EMPLOYEE)
        
EXTERNAL (独立体系，不与内部角色继承)
ALUMNI (独立体系，保留历史数据只读权限)
```

---

## 3. 系统架构总览

### 3.1 架构分层图

```
┌─────────────────────────────────────────────────────────────────┐
│                        接入层 (Access Layer)                      │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────────────────┐  │
│  │  PC Web  │  │ Mobile  │  │ 钉钉小程序│  │  AI Agent / MCP     │  │
│  │ (React) │  │  H5     │  │  飞书应用│  │  Client             │  │
│  └─────────┘  └─────────┘  └─────────┘  └─────────────────────┘  │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTPS / SSE / WebSocket
┌──────────────────────────▼──────────────────────────────────────┐
│                      网关层 (Gateway Layer)                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │   Nginx     │  │  Rate Limit │  │  JWT / SSO Auth           │  │
│  │   负载均衡   │  │  流量控制   │  │  钉钉/飞书/内部Token       │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                    应用层 (Application Layer)                     │
│                   NestJS 模块化架构                                │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌───────────┐ │
│  │ Auth    │ │ User    │ │ Approval│ │ Payroll │ │ Recruitment│ │
│  │ Module  │ │ Module  │ │ Module  │ │ Module  │ │ Module    │ │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └───────────┘ │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌───────────┐ │
│  │ Knowledge│ │ Onboard │ │ Care    │ │ Notice  │ │ MCP       │ │
│  │ Module  │ │ Module  │ │ Module  │ │ Module  │ │ Server    │ │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └───────────┘ │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐               │
│  │ Org     │ │ Security│ │ Audit   │ │ OP SaaS │               │
│  │ Module  │ │ Module  │ │ Module  │ │ Bridge  │               │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘               │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                      数据层 (Data Layer)                          │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                 MongoDB 集群 (Replica Set)                 │  │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────────┐  │  │
│  │  │用户/权限  │  │ 审批/流程  │  │ 薪酬/考勤  │  │ 知识/培训   │  │  │
│  │  │ 数据库   │  │ 数据库    │  │ 数据库    │  │ 数据库     │  │  │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────────┘  │  │
│  └─────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │              Redis 缓存 / 消息队列 / 文件存储                │  │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────────┐  │  │
│  │  │ 会话缓存  │  │ 速率限制  │  │ 任务队列  │  │ 文件(OSS)   │  │  │
│  │  │ (Redis)  │  │ (Redis)  │  │ (BullMQ) │  │ (MinIO/S3)  │  │  │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────────┘  │  │
│  └─────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 技术选型

| 层级 | 技术选型 | 说明 |
|------|----------|------|
| 前端框架 | React 18 + Next.js 14 (App Router) | PC端管理后台，支持SSR/SSG |
| 移动端 | React + Ant Design Mobile | H5自适应，未来可打包为钉钉/飞书小程序 |
| UI组件库 | Ant Design 5.x (PC) + Ant Design Mobile (H5) | 美观、简约、企业级 |
| 后端框架 | NestJS 10.x | 模块化、依赖注入、TypeScript原生 |
| 数据库 | MongoDB 6.x (Replica Set) | 灵活Schema，适合HR/审批等非结构化数据 |
| 缓存 | Redis 7.x | 会话、缓存、分布式锁、限流 |
| 消息队列 | BullMQ (Redis-backed) | 异步任务：薪酬计算、邮件发送、MCP消息 |
| 文件存储 | MinIO (自建) / 阿里云OSS | 合同、证件、头像、附件存储 |
| 搜索引擎 | MongoDB Atlas Search / Meilisearch | 知识库搜索、人才库搜索 |
| 文档生成 | Puppeteer / PDFKit | 合同PDF生成、薪酬单PDF生成 |
| 日志收集 | Winston + ELK (可选) | 结构化日志，审计追踪 |
| 监控 | Prometheus + Grafana (可选) | 系统指标监控 |

---

## 4. 核心模块详细设计

### 4.1 模块一：统一身份认证与SSO（auth-module）

#### 4.1.1 功能概述
提供员工和外部人员的统一身份认证入口，支持钉钉、飞书扫码/免密登录，同时支持MCP协议的API Key认证。

#### 4.1.2 核心需求

| 需求编号 | 需求描述 | 优先级 | 备注 |
|----------|----------|--------|------|
| AUTH-001 | 支持钉钉扫码登录（企业内部应用） | P0 | 读取钉钉通讯录同步组织架构 |
| AUTH-002 | 支持飞书扫码登录（企业自建应用） | P0 | 读取飞书通讯录同步组织架构 |
| AUTH-003 | 支持手机验证码登录（外部人员/候选人） | P1 | 用于候选人面试安排、外部合作方 |
| AUTH-004 | 支持MCP OAuth 2.1认证（人员代理与服务代理） | P0 | 令牌绑定资源、租户、主体和最小Scope |
| AUTH-005 | JWT Token刷新机制（Access Token 2h + Refresh Token 7d） | P0 | 移动端长期保持登录 |
| AUTH-006 | 单点登出（SSO Logout）同步 | P1 | 登出时使所有端Token失效 |
| AUTH-007 | 多租户隔离（告趣集团 vs OP SaaS客户） | P1 | 数据库层面tenantId隔离 |
| AUTH-008 | 登录失败告警（连续5次失败锁定15分钟） | P2 | 安全策略 |

#### 4.1.3 登录流程（钉钉示例）
```
用户点击"钉钉登录" → 前端跳转钉钉授权页 → 用户扫码/确认 → 
钉钉回调携带authCode → 后端用authCode换accessToken → 
用accessToken调钉钉"获取用户详情" → 匹配本系统员工表 → 
生成JWT（含userId, role, tenantId, departmentId） → 返回前端 → 
前端存储Token并跳转首页
```

#### 4.1.4 数据库集合（MongoDB）

```typescript
// collection: users
interface User {
  _id: ObjectId;
  tenantId: string;           // 租户ID，告趣主租户为"gaoq"
  unionId: string;            // 统一身份ID（钉钉/飞书unionId映射）
  dingtalkId?: string;       // 钉钉用户ID
  feishuId?: string;         // 飞书用户ID
  phone: string;             // 手机号（唯一）
  email?: string;            // 企业邮箱
  realName: string;          // 真实姓名
  avatar?: string;           // 头像URL
  status: 'active' | 'inactive' | 'probation' | 'resigned' | 'candidate';
  roleCodes: string[];       // 角色编码数组，支持多角色
  departmentId: ObjectId;    // 主部门
  departmentIds: ObjectId[]; // 兼岗部门
  jobTitle: string;          // 职位名称
  jobLevel: string;          // 职级（如P4, M3）
  entryDate?: Date;          // 入职日期
  probationEndDate?: Date;   // 试用期结束日期
  resignDate?: Date;         // 离职日期
  lastLoginAt?: Date;        // 最后登录时间
  lastLoginIp?: string;      // 最后登录IP
  createdAt: Date;
  updatedAt: Date;
}

// collection: tenants
interface Tenant {
  _id: ObjectId;
  tenantId: string;          // 唯一租户标识
  name: string;              // 租户名称（如"告趣集团"）
  type: 'internal' | 'saas'; // 内部使用或SaaS客户
  dingtalkCorpId?: string;   // 钉钉企业ID
  feishuAppId?: string;      // 飞书应用ID
  feishuAppSecret?: string;  // 加密存储
  features: string[];        // 启用的功能模块
  settings: Record<string, any>; // 租户级配置
  createdAt: Date;
}
```

---

### 4.2 模块二：MCP服务层（mcp-module）

#### 4.2.1 功能概述
系统最重要的差异化模块。将ERP的所有业务能力通过Model Context Protocol（MCP）暴露给AI Agent，支持员工通过自然语言操作ERP，支持外部合作方通过AI接入告趣系统。

#### 4.2.2 核心需求

| 需求编号 | 需求描述 | 优先级 | 备注 |
|----------|----------|--------|------|
| MCP-001 | 实现MCP Server（远程Streamable HTTP、本地stdio） | P0 | 遵循当前稳定MCP规范，不支持旧HTTP+SSE |
| MCP-002 | 提供Resources（资源暴露）：员工信息、审批列表、薪酬单、知识库文章 | P0 | 支持动态URI模板，如`user://{userId}/profile` |
| MCP-003 | 提供Tools（工具调用）：提交审批、查询薪酬、发起招聘、搜索知识库 | P0 | 每个工具必须有中文描述和参数说明 |
| MCP-004 | 提供Prompts（预设提示词）："帮我查本月待审批","我要请假3天" | P1 | 降低员工使用门槛 |
| MCP-005 | 细粒度权限控制：AI Agent只能操作被授予权限的Tools/Resources | P0 | 防止越权操作 |
| MCP-006 | MCP操作审计日志：记录所有AI操作（who/what/when/result） | P0 | 安全可追溯 |
| MCP-007 | 支持标准会话和协议版本协商 | P0 | 权限每次请求重新校验，不依赖会话授权 |
| MCP-008 | 通过Streamable HTTP进度通知和任务Resource处理长耗时操作 | P1 | 避免超时，不依赖旧SSE传输 |
| MCP-009 | MCP OAuth Scope与风险分级授权 | P0 | 只读、普通写、高风险和禁止操作分级 |

#### 4.2.3 MCP Tools 清单（示例）

| Tool名称 | 中文描述 | 权限要求 | 对应模块 |
|----------|----------|----------|----------|
| `submitApproval` | 提交审批申请 | 员工及以上 | 审批模块 |
| `getApprovalList` | 查询我的待审批/已审批列表 | 员工及以上 | 审批模块 |
| `approveRequest` | 审批通过/拒绝 | 审批权限 | 审批模块 |
| `getPayrollDetail` | 查询我的薪酬明细 | 本人/HR/财务 | 薪酬模块 |
| `getAttendanceSummary` | 查询考勤统计 | 本人/HR | 考勤模块 |
| `searchKnowledge` | 搜索知识库 | 员工及以上 | 知识模块 |
| `getTrainingSchedule` | 查询我的培训计划 | 员工及以上 | 培训模块 |
| `submitExam` | 提交考试答案 | 员工及以上 | 培训模块 |
| `createTrainingPlan` | **创建培训计划（HRBP专用）** | HRBP/HR_ADMIN | 培训模块 |
| `assignTrainingToUsers` | **为员工分配培训任务（HRBP专用）** | HRBP/HR_ADMIN | 培训模块 |
| `updateTrainingProgress` | **更新培训进度/安排（HRBP专用）** | HRBP/HR_ADMIN | 培训模块 |
| `getTrainingProgress` | **查询培训进度报表（HRBP/管理层）** | HRBP/管理层 | 培训模块 |
| `createExam` | **创建考试/试卷（HRBP专用）** | HRBP/HR_ADMIN | 培训模块 |
| `getExamResults` | **查询考试成绩（HRBP/管理层）** | HRBP/管理层 | 培训模块 |
| `exportExamResults` | **导出考核结果（HRBP/管理层）** | HRBP/管理层 | 培训模块 |
| `getMcpGuide` | **查询企业MCP使用指南（AI培训）** | 全员 | 培训模块 |
| `getCandidateStatus` | 查询候选人面试进度 | HR/面试官 | 招聘模块 |
| `createInterview` | 安排面试 | HR/面试官 | 招聘模块 |
| `getOrgChart` | 查询组织架构 | 员工及以上 | 组织模块 |
| `sendNotice` | 发送企业公告 | 管理员 | 公告模块 |
| `getMyTasks` | 查询我的入职任务 | 本人 | 入职模块 |
| `signDocument` | 签署电子文件 | 本人 | 入职模块 |
| `getAlumniList` | 查询校友/人才库 | HR/管理层 | 关怀模块 |
| `addAlumniContact` | 添加离职人员联系记录 | HR/管理层 | 关怀模块 |

#### 4.2.4 MCP 架构实现
```typescript
// 伪代码：MCP Server 注册逻辑
@Module({
  providers: [McpServerService, McpToolRegistry, McpAuditLogger],
})
export class McpModule {
  // 注册所有Tools
  registerTools() {
    this.mcpServer.addTool({
      name: 'submitApproval',
      description: '提交审批申请，如请假、报销、加班等',
      parameters: z.object({
        type: z.string().describe('审批类型：leave/expense/overtime/...'),
        formData: z.record(z.any()).describe('审批表单数据，JSON对象'),
        approverIds: z.array(z.string()).describe('指定审批人ID列表，可选'),
      }),
      handler: async (params, context) => {
        // 1. 权限校验（context.userId, context.apiKeyPermissions）
        // 2. 调用ApprovalService提交
        // 3. 记录审计日志
        // 4. 返回结果
      },
    });
  }
}
```

---

### 4.3 模块三：审批工作流（approval-module）【替代氚云】

#### 4.3.1 功能概述
完全替代氚云的核心功能。提供可视化流程设计器、表单设计器、审批引擎、抄送/转交/催办等完整BPM能力。

#### 4.3.2 核心需求

| 需求编号 | 需求描述 | 优先级 | 备注 |
|----------|----------|--------|------|
| APP-001 | 可视化流程设计器（拖拽节点：开始→审批→条件→抄送→结束） | P0 | 类似氚云体验 |
| APP-002 | 表单设计器（拖拽字段：文本、数字、日期、附件、部门、人员） | P0 | 支持字段校验规则 |
| APP-003 | 预设常用审批模板（请假、报销、出差、加班、采购、用印、离职） | P0 | 开箱即用 |
| APP-004 | 支持条件分支（如：金额>5000需CEO审批，否则部门经理审批） | P0 | 条件基于表单字段 |
| APP-005 | 支持会签（多人同时审批，全部通过才通过） | P0 | 如合同审批 |
| APP-006 | 支持或签（多人中任意一人审批即可） | P0 | 如请假审批 |
| APP-007 | 支持加签（审批中临时增加审批人） | P1 | 灵活处理 |
| APP-008 | 支持转交（审批人转给其他人处理） | P1 | 如审批人休假 |
| APP-009 | 支持审批评论和附件补充 | P0 | 沟通留痕 |
| APP-010 | 审批催办（自动提醒和手动催办） | P1 | 钉钉/飞书消息推送 |
| APP-011 | 审批委托（设置代理人，如休假期间） | P1 | 时间管理 |
| APP-012 | 审批数据分析（平均耗时、驳回率、节点耗时） | P2 | 管理报表 |
| APP-013 | 审批数据导出（PDF/Excel） | P1 | 归档和审计 |
| APP-014 | 与MCP集成：AI可代提交/查询/审批 | P0 | 自然语言发起审批 |

#### 4.3.3 审批流程状态机

```
[草稿] → [提交] → [审批中] → [已通过] → [已归档]
                ↓
           [已驳回] → [可重新提交]
                ↓
           [已撤回] → [可重新提交]
                ↓
           [已转交] → [审批中]
                ↓
           [加签中] → [审批中]
```

#### 4.3.4 数据库集合

```typescript
// collection: approval_templates
interface ApprovalTemplate {
  _id: ObjectId;
  tenantId: string;
  code: string;              // 模板编码：leave, expense, overtime...
  name: string;              // 模板名称：请假申请
  icon?: string;             // 图标
  description?: string;      // 说明
  formSchema: FormSchema;    // 表单JSON Schema（含字段定义、校验规则）
  flowConfig: FlowConfig;    // 流程配置（节点、条件、流转规则）
  isEnabled: boolean;        // 是否启用
  isDefault: boolean;        // 是否系统预设（不可删除）
  createdBy: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

// collection: approval_instances
interface ApprovalInstance {
  _id: ObjectId;
  tenantId: string;
  templateId: ObjectId;     // 关联模板
  templateName: string;      // 冗余存储，模板变更不影响历史
  applicantId: ObjectId;     // 申请人
  title: string;             // 审批标题：如"张三的请假申请"
  formData: Record<string, any>; // 表单数据
  status: 'draft' | 'pending' | 'processing' | 'approved' | 'rejected' | 'revoked' | 'transferred';
  currentNodeId: string;     // 当前节点ID
  nodes: ApprovalNode[];     // 所有节点执行记录
  ccUserIds: ObjectId[];    // 抄送人
  startedAt: Date;          // 开始时间
  completedAt?: Date;        // 完成时间
  duration?: number;         // 耗时（秒）
  attachments?: string[];    // 附件URL列表
  createdAt: Date;
  updatedAt: Date;
}

interface ApprovalNode {
  nodeId: string;            // 节点唯一ID
  nodeType: 'start' | 'approval' | 'condition' | 'cc' | 'end';
  nodeName: string;          // 节点名称：如"部门经理审批"
  approverIds: ObjectId[];   // 审批人/执行人
  status: 'pending' | 'processing' | 'approved' | 'rejected' | 'skipped' | 'transferred';
  comment?: string;          // 审批意见
  action?: 'agree' | 'reject' | 'transfer' | 'addSign';
  transferredTo?: ObjectId;  // 转交给谁
  handledAt?: Date;         // 处理时间
  duration?: number;         // 节点耗时
}

// 表单Schema定义（示例）
interface FormSchema {
  fields: FormField[];
}

interface FormField {
  fieldId: string;           // 唯一标识
  fieldType: 'text' | 'number' | 'date' | 'datetime' | 'select' | 'multiselect' | 
             'user' | 'dept' | 'money' | 'textarea' | 'attachment' | 'formula';
  label: string;             // 显示名称：如"请假天数"
  required: boolean;         // 是否必填
  defaultValue?: any;        // 默认值
  validation?: {             // 校验规则
    min?: number;
    max?: number;
    pattern?: string;        // 正则
    message?: string;        // 错误提示
  };
  options?: { label: string; value: string }[]; // 下拉选项
  visibleCondition?: { fieldId: string; operator: string; value: any }; // 显示条件
  formula?: string;          // 计算公式（如：days * dailySalary）
}
```

---

### 4.4 模块四：组织架构与人员管理（org-module）

#### 4.4.1 功能概述
管理人员、部门、岗位、职级，支持从钉钉/飞书同步组织架构，支持兼职/借调管理。

#### 4.4.2 核心需求

| 需求编号 | 需求描述 | 优先级 | 备注 |
|----------|----------|--------|------|
| ORG-001 | 部门树管理（增删改查、拖拽排序） | P0 | 与钉钉/飞书双向同步 |
| ORG-002 | 人员档案管理（基本信息、联系方式、教育、家庭、合同） | P0 | 完整员工档案 |
| ORG-003 | 岗位与职级体系（MCN经纪人P1-P6，管理M1-M5） | P0 | 支持自定义职级序列 |
| ORG-004 | 入职/转正/调岗/离职全流程管理 | P0 | 状态流转触发审批 |
| ORG-005 | 合同管理（电子合同模板、签署、续签提醒） | P1 | 与法大大/ e签宝集成 |
| ORG-006 | 考勤组管理（弹性打卡、固定班次、自由工时） | P1 | 未来替代钉钉考勤 |
| ORG-007 | 加班/假期余额管理（年假、调休、事假、病假） | P1 | 自动计算 |
| ORG-008 | 人员搜索（支持姓名、手机号、部门、岗位组合搜索） | P0 | 全局搜索 |
| ORG-009 | 组织架构图可视化（树状图+通讯录卡片） | P1 | 美观展示 |
| ORG-010 | 人员数据导出（脱敏处理） | P2 | 权限控制导出 |

#### 4.4.3 数据库集合

```typescript
// collection: departments
interface Department {
  _id: ObjectId;
  tenantId: string;
  parentId?: ObjectId;       // 父部门ID
  name: string;              // 部门名称
  code: string;              // 部门编码
  managerId?: ObjectId;     // 部门负责人
  dingtalkDeptId?: string;   // 钉钉部门ID
  feishuDeptId?: string;    // 飞书部门ID
  sortOrder: number;         // 排序
  isActive: boolean;         // 是否启用
  createdAt: Date;
  updatedAt: Date;
}

// collection: job_levels
interface JobLevel {
  _id: ObjectId;
  tenantId: string;
  sequence: string;          // 序列：professional（专业）/ management（管理）
  code: string;              // 编码：P1, P2, M1...
  name: string;              // 名称：初级经纪人、高级编导...
  description?: string;      // 职责描述
  requirements?: string;     // 晋升要求
  minSalary?: number;        // 薪资范围下限
  maxSalary?: number;        // 薪资范围上限
  createdAt: Date;
}

// collection: employee_contracts
interface EmployeeContract {
  _id: ObjectId;
  tenantId: string;
  userId: ObjectId;          // 员工
  contractType: 'labor' | 'internship' | 'parttime' | 'consultant'; // 合同类型
  contractNo: string;        // 合同编号
  startDate: Date;           // 合同开始
  endDate?: Date;            // 合同结束
  probationMonths: number;   // 试用期月数
  salary?: number;          // 合同约定月薪（基础）
  workingCity: string;       // 工作城市
  workingHours: string;      // 工时制度
  attachmentUrl?: string;    // 电子合同PDF
  status: 'active' | 'expired' | 'terminated' | 'renewed';
  createdAt: Date;
}
```

---

### 4.5 模块五：薪酬管理（payroll-module）【替代智能薪酬】

#### 4.5.1 功能概述
完全替代智能薪酬，支持薪酬结构配置、考勤数据对接、社保公积金计算、个税计算、薪酬发放、薪酬单查询。

#### 4.5.2 核心需求

| 需求编号 | 需求描述 | 优先级 | 备注 |
|----------|----------|--------|------|
| PAY-001 | 薪酬结构配置（基本工资、岗位工资、绩效、提成、奖金、补贴） | P0 | 支持多薪酬方案 |
| PAY-002 | 薪酬方案绑定（不同部门/岗位可应用不同薪酬方案） | P0 | 如MCN经纪人用提成制，职能用固定制 |
| PAY-003 | 考勤数据导入（打卡记录、请假、加班、出差） | P0 | 支持钉钉/飞书考勤数据导入 |
| PAY-004 | 社保公积金基数配置（按城市） | P0 | 支持多城市缴纳 |
| PAY-005 | 个税计算（累计预扣法，支持专项附加扣除） | P0 | 对接税务局最新税率 |
| PAY-006 | 薪酬计算引擎（每月自动生成薪酬单） | P0 | 异步计算，支持重算 |
| PAY-007 | 薪酬审批流程（HR计算→财务审核→CEO审批→发放） | P0 | 审批通过后锁定 |
| PAY-008 | 薪酬发放记录（银行代发、支付宝、微信） | P0 | 记录发放状态 |
| PAY-009 | 员工薪酬单查询（APP/PC查看，支持PDF下载） | P0 | 只能查看自己的 |
| PAY-010 | 薪酬数据分析（人力成本、部门成本、同比环比） | P1 | 管理层报表 |
| PAY-011 | 年终奖/13薪计算 | P1 | 特殊场景 |
| PAY-012 | 薪酬数据加密（数据库敏感字段加密） | P0 | AES-256 |
| PAY-013 | 薪酬操作审计（谁查看/修改/导出了薪酬数据） | P0 | 严格审计 |
| PAY-014 | 与MCP集成：AI查询薪酬、生成薪酬分析报告 | P1 | 管理层使用 |

#### 5.5.3 薪酬计算逻辑（伪代码）

```typescript
interface PayrollCalculation {
  // 输入
  userId: ObjectId;
  month: string;             // 2025-06
  attendanceDays: number;    // 应出勤天数
  actualDays: number;        // 实际出勤天数
  leaveDays: { type: string; days: number; }[]; // 各类假期天数
  overtimeHours: number;     // 加班小时数
  
  // 薪酬结构
  baseSalary: number;        // 基本工资
  positionSalary: number;    // 岗位工资
  performanceSalary: number; // 绩效工资（根据考核结果）
  commission: number;        // 提成/奖金（MCN/广告业务）
  allowance: number;         // 各类补贴合计
  
  // 扣减项
  socialInsurance: number;   // 社保个人缴纳
  housingFund: number;       // 公积金个人缴纳
  personalTax: number;       // 个人所得税
  otherDeductions: number;   // 其他扣减（如餐费、借款）
  
  // 计算结果
  grossSalary: number;       // 应发 = 基本工资+岗位+绩效+提成+补贴
  netSalary: number;         // 实发 = 应发 - 社保 - 公积金 - 个税 - 其他
  companyCost: number;       // 公司成本 = 应发 + 公司社保 + 公司公积金
}

// 个税计算（累计预扣法）
function calculateTax(
  currentMonthIncome: number,    // 本月应纳税所得额
  cumulativeIncome: number,     // 本年累计应纳税所得额
  cumulativeTax: number,        // 本年累计已缴个税
  deductions: number            // 专项附加扣除
): number {
  // 使用最新个税税率表计算
  // 返回本月应缴个税
}
```

#### 4.5.4 数据库集合

```typescript
// collection: payroll_schemes
interface PayrollScheme {
  _id: ObjectId;
  tenantId: string;
  name: string;              // 方案名称：如"MCN经纪人薪酬方案"
  applicableDeptIds: ObjectId[]; // 适用部门
  applicableJobLevels: string[]; // 适用职级
  items: PayrollItem[];      // 薪酬项目列表
  formula: string;          // 计算公式（安全沙箱执行）
  isDefault: boolean;
  createdAt: Date;
}

interface PayrollItem {
  itemId: string;            // 唯一标识
  name: string;              // 项目名称：基本工资
  type: 'fixed' | 'formula' | 'input' | 'lookup'; // 固定/公式/手工录入/查表
  category: 'income' | 'deduction'; // 收入项/扣减项
  defaultValue?: number;     // 默认值
  formula?: string;          // 计算公式（如：baseSalary * 0.8）
  isVisibleToEmployee: boolean; // 员工是否可见
  isTaxable: boolean;        // 是否计税
}

// collection: payroll_sheets
interface PayrollSheet {
  _id: ObjectId;
  tenantId: string;
  month: string;             // 薪酬月份：2025-06
  userId: ObjectId;          // 员工
  schemeId: ObjectId;        // 薪酬方案
  status: 'draft' | 'calculated' | 'auditing' | 'approved' | 'paid' | 'locked';
  items: { itemId: string; name: string; amount: number; }[]; // 各项目金额
  grossSalary: number;       // 应发
  totalDeductions: number;  // 扣减合计
  netSalary: number;         // 实发
  companyCost: number;       // 公司成本
  taxDetail: {               // 个税明细
    cumulativeIncome: number;
    cumulativeTax: number;
    currentTax: number;
    deductions: number;
  };
  paidAt?: Date;             // 发放时间
  paidMethod?: string;       // 发放方式
  createdBy: ObjectId;       // 计算人
  createdAt: Date;
  updatedAt: Date;
}

// collection: salary_structures (员工个人薪酬结构)
interface SalaryStructure {
  _id: ObjectId;
  tenantId: string;
  userId: ObjectId;
  effectiveDate: Date;       // 生效日期
  baseSalary: number;        // 基本工资
  positionSalary: number;    // 岗位工资
  performanceBase: number;   // 绩效基数
  allowanceDetails: { name: string; amount: number; }[]; // 补贴明细
  socialInsuranceBase: number; // 社保基数
  housingFundBase: number;   // 公积金基数
  probationRatio: number;     // 试用期比例（如0.8）
  createdAt: Date;
}
```

---

### 4.6 模块六：招聘管理（recruitment-module）【替代智能人事招聘】

#### 4.6.1 功能概述
替代智能人事的招聘管理和招聘门户。支持招聘需求、职位发布、简历管理、面试流程、Offer管理、候选人体验。

#### 4.6.2 核心需求

| 需求编号 | 需求描述 | 优先级 | 备注 |
|----------|----------|--------|------|
| REC-001 | 招聘需求管理（部门提交HC需求→HR审核→管理层审批） | P0 | 与审批模块联动 |
| REC-002 | 职位发布管理（对内/对外发布，绑定招聘渠道） | P0 | 支持官网、BOSS直聘、智联等渠道标记 |
| REC-003 | 简历库管理（手动上传、邮箱自动抓取、渠道导入） | P0 | 去重识别（手机号+邮箱） |
| REC-004 | 候选人管理（简历解析、标签、备注、阶段流转） | P0 | 阶段：新简历→初筛→面试→Offer→入职 |
| REC-005 | 面试管理（安排面试官、时间、地点/视频、反馈表） | P0 | 与钉钉/飞书日历集成 |
| REC-006 | 面试评价表（结构化评分：专业能力、沟通能力、文化匹配） | P0 | 多维度打分+评语 |
| REC-007 | Offer管理（Offer模板、审批、发送、电子签署） | P0 | 候选人手机端签署 |
| REC-008 | 人才库管理（未通过但优秀的人才入人才库） | P1 | 长期跟踪 |
| REC-009 | 招聘数据分析（渠道效果、转化率、平均招聘周期） | P1 | 管理层看板 |
| REC-010 | 招聘门户（候选人可查看职位、投递简历、查看进度） | P1 | 对外官网/内推 |
| REC-011 | 内推管理（员工内推、奖励跟踪） | P2 | 激励体系 |
| REC-012 | AI简历筛选（基于职位要求自动评分排序） | P2 | 未来扩展 |
| REC-013 | 与MCP集成：HR通过AI安排面试、查询候选人状态 | P1 | 提升效率 |

#### 4.6.3 招聘流程状态机

```
[简历投递] → [简历初筛] → [初筛通过] → [安排面试] → [面试中] → [面试通过] → [Offer审批] → [Offer发送] → [Offer接受] → [待入职] → [已入职]
                  ↓                ↓              ↓              ↓              ↓
              [不匹配]         [初筛淘汰]      [面试淘汰]      [Offer拒绝]     [放弃入职]
                  ↓                ↓              ↓              ↓              ↓
               [人才库]         [淘汰库]       [淘汰库]        [人才库]        [淘汰库]
```

#### 4.6.4 数据库集合

```typescript
// collection: recruitment_positions
interface RecruitmentPosition {
  _id: ObjectId;
  tenantId: string;
  requisitionId: ObjectId;   // 关联招聘需求
  title: string;             // 职位名称：小红书经纪人
  departmentId: ObjectId;    // 所属部门
  jobLevel: string;          // 职级
  location: string;          // 工作地点
  headcount: number;         // 招聘人数
  salaryRange?: { min: number; max: number; }; // 薪资范围
  description: string;       // 职位描述（富文本）
  requirements: string;      // 任职要求（富文本）
  tags: string[];            // 标签：MCN, 小红书, 经纪人...
  channels: string[];        // 发布渠道：internal, boss, zhaopin, lagou...
  status: 'draft' | 'open' | 'paused' | 'closed';
  publishedAt?: Date;        // 发布时间
  closedAt?: Date;           // 关闭时间
  createdBy: ObjectId;
  createdAt: Date;
}

// collection: candidates
interface Candidate {
  _id: ObjectId;
  tenantId: string;
  positionId: ObjectId;     // 应聘职位
  source: string;            // 来源：boss直聘, 智联, 内推, 官网...
  referrerId?: ObjectId;     // 内推人
  name: string;              // 姓名
  phone: string;             // 手机号（加密）
  email: string;             // 邮箱（加密）
  gender?: 'male' | 'female' | 'other';
  age?: number;
  education?: {               // 最高学历
    school: string;
    major: string;
    degree: string;
    graduationYear: number;
  };
  workExperience?: {        // 工作经历（数组）
    company: string;
    position: string;
    duration: string;
    description?: string;
  }[];
  resumeUrl?: string;       // 简历附件
  resumeParsed?: Record<string, any>; // 解析后的结构化数据
  stage: 'new' | 'screening' | 'interview' | 'offer' | 'onboarding' | 'hired' | 'rejected' | 'withdrawn' | 'talent_pool';
  stageHistory: {
    from: string;
    to: string;
    operatorId: ObjectId;
    note?: string;
    createdAt: Date;
  }[];
  interviews: Interview[];   // 面试记录
  offer?: OfferInfo;          // Offer信息
  tags: string[];             // 标签：优秀, 跟进, 不匹配...
  notes?: string;            // 备注
  createdAt: Date;
  updatedAt: Date;
}

interface Interview {
  _id: ObjectId;
  round: number;            // 第几轮
  type: 'phone' | 'video' | 'onsite' | 'written'; // 面试类型
  interviewers: ObjectId[];   // 面试官
  scheduledAt: Date;          // 预约时间
  duration: number;           // 预计时长（分钟）
  location?: string;          // 地点/会议室/视频链接
  status: 'scheduled' | 'completed' | 'cancelled' | 'no_show';
  feedback?: InterviewFeedback;
  createdAt: Date;
}

interface InterviewFeedback {
  overallScore: number;      // 综合评分 1-5
  dimensions: {
    name: string;             // 维度：专业能力, 沟通能力, 文化匹配...
    score: number;            // 评分 1-5
    comment?: string;         // 评语
  }[];
  recommendation: 'strong_hire' | 'hire' | 'neutral' | 'reject' | 'strong_reject';
  comment?: string;          // 总体评语
  submittedBy: ObjectId;
  submittedAt: Date;
}

interface OfferInfo {
  salary: number;             // 月薪
  probationMonths: number;   // 试用期
  probationSalary: number;   // 试用期工资
  position: string;           // 职位
  department: string;         // 部门
  startDate: Date;           // 预计入职日期
  benefits: string[];        // 福利说明
  attachmentUrl?: string;      // Offer函PDF
  status: 'draft' | 'pending_approval' | 'approved' | 'sent' | 'accepted' | 'rejected' | 'withdrawn';
  sentAt?: Date;
  respondedAt?: Date;
  createdAt: Date;
}
```

---

### 4.7 模块七：知识库与培训体系（knowledge-module）

#### 4.7.1 功能概述
这是告趣的核心差异化需求。为各岗位（经纪人、编导、商务、媒介执行、媒介拓展）建立完整的知识库，支持入职培训、考试、分享、总结。

#### 4.7.2 核心需求

| 需求编号 | 需求描述 | 优先级 | 备注 |
|----------|----------|--------|------|
| KNL-001 | 知识库分类（按岗位：经纪人/编导/商务/媒介执行/媒介拓展/通用） | P0 | 树形分类 |
| KNL-002 | 知识文章管理（富文本编辑、视频嵌入、附件、标签） | P0 | 类似飞书文档体验 |
| KNL-003 | SOP标准作业程序（步骤化、可勾选、有版本） | P0 | 每个岗位核心SOP |
| KNL-004 | 培训课程管理（课程章节、视频/文档、学习进度） | P0 | 支持视频托管 |
| KNL-005 | 培训计划（为不同岗位/职级制定必修/选修课程） | P0 | 如经纪人入职必修 |
| KNL-006 | 考试管理（题库、组卷、考试、自动判分、防作弊） | P0 | 试用期转正需通过考试 |
| KNL-007 | 考试题库（单选、多选、判断、填空、问答） | P0 | 按岗位分类题库 |
| KNL-008 | 学习进度跟踪（已学、在学、未学、学习时长） | P0 | 管理者可见 |
| KNL-009 | 学习证书（通过考试后颁发电子证书） | P1 | 激励 |
| KNL-010 | 经验分享（员工可发布经验、案例、技巧） | P1 | 内部社区 |
| KNL-011 | 知识搜索（全文检索、标签过滤、岗位推荐） | P0 | 支持AI搜索（MCP） |
| KNL-012 | 知识库权限（按岗位/部门控制读写权限） | P0 | 如投资部知识仅投资部可见 |
| KNL-013 | 与MCP集成：AI问答、知识推荐、学习辅导 | P1 | "如何谈成一个品牌合作？" |
| KNL-015 | **MCP培训管理（HRBP专用）**：HRBP可通过MCP创建/修改培训计划 | P0 | `createTrainingPlan` / `updateTrainingPlan` |
| KNL-016 | **MCP培训管理（HRBP专用）**：HRBP可通过MCP为指定员工/部门批量分配培训任务 | P0 | `assignTrainingToUsers` |
| KNL-017 | **MCP培训管理（HRBP专用）**：HRBP可通过MCP查询培训进度、生成培训报表 | P0 | `getTrainingProgress` / `getTrainingReport` |
| KNL-018 | **MCP培训管理（HRBP专用）**：HRBP可通过MCP安排考试、查询考试成绩、导出考核结果 | P0 | `createExam` / `getExamResults` / `exportExamResults` |
| KNL-019 | **MCP培训管理（全员）**：员工通过MCP查询个人培训进度、提交考试 | P0 | `getMyTrainingProgress` / `submitExam`（已有） |
| KNL-020 | **MCP培训辅导**：AI基于知识库内容辅导员工学习，如"请帮我讲解达人签约SOP的第3步" | P1 | MCP Knowledge Resource + LLM |

#### 4.7.3 岗位培训体系（示例）

| 岗位 | 必修课程 | 培训周期 | 考试要求 |
|------|----------|----------|----------|
| 经纪人 | 达人签约SOP、平台规则、合同解读、定价策略 | 入职2周内 | 80分通过 |
| 编导 | 内容策划、拍摄剪辑、平台算法、爆款分析 | 入职2周内 | 80分通过 |
| 商务 | 客户开发、提案撰写、谈判技巧、结案报告 | 入职2周内 | 85分通过 |
| 媒介执行 | 投放操作、数据监测、异常处理、对账流程 | 入职1周内 | 80分通过 |
| 媒介拓展 | 渠道拓展、资源盘点、合作谈判、返点政策 | 入职2周内 | 80分通过 |
| 通用 | 公司文化、信息安全、合规培训、财务报销 | 入职1周内 | 60分通过 |
| **通用** | **企业AI使用培训（MCP+ERP使用）** | **入职前3天** | **必须完成，不计分但需签到** |

#### 4.7.4 数据库集合

```typescript
// collection: knowledge_categories
interface KnowledgeCategory {
  _id: ObjectId;
  tenantId: string;
  parentId?: ObjectId;       // 父分类
  name: string;              // 分类名称：如"经纪人培训"
  code: string;              // 编码
  applicableRoles: string[]; // 适用角色
  applicableJobLevels: string[]; // 适用职级
  sortOrder: number;
  createdAt: Date;
}

// collection: knowledge_articles
interface KnowledgeArticle {
  _id: ObjectId;
  tenantId: string;
  categoryId: ObjectId;    // 分类
  title: string;             // 标题
  content: string;           // 富文本内容（Markdown/HTML）
  contentType: 'article' | 'sop' | 'video' | 'document';
  attachments?: { name: string; url: string; type: string; }[];
  tags: string[];            // 标签
  authorId: ObjectId;        // 作者
  version: number;            // 版本号
  status: 'draft' | 'published' | 'archived';
  viewCount: number;         // 阅读次数
  likeCount: number;         // 点赞数
  isRequired: boolean;       // 是否必修
  requiredForRoles: string[]; // 哪些角色必修
  publishAt?: Date;          // 发布时间
  createdAt: Date;
  updatedAt: Date;
}

// collection: courses
interface Course {
  _id: ObjectId;
  tenantId: string;
  categoryId: ObjectId;
  title: string;             // 课程名称
  description: string;        // 课程描述
  coverImage?: string;       // 封面图
  chapters: CourseChapter[]; // 章节
  isRequired: boolean;       // 是否必修
  requiredForRoles: string[]; // 必修角色
  estimatedDuration: number; // 预计学习时长（分钟）
  passingScore?: number;     // 通过分数（关联考试）
  examId?: ObjectId;         // 结业考试
  status: 'draft' | 'published' | 'archived';
  createdAt: Date;
}

interface CourseChapter {
  chapterId: string;
  title: string;
  content: string;           // 内容（视频URL或文档）
  contentType: 'video' | 'document' | 'quiz';
  duration: number;          // 时长（分钟）
  sortOrder: number;
}

// collection: training_plans
interface TrainingPlan {
  _id: ObjectId;
  tenantId: string;
  name: string;              // 计划名称：如"经纪人入职培训计划"
  description?: string;
  targetRoles: string[];     // 目标角色
  targetJobLevels: string[]; // 目标职级
  items: {                   // 计划项目
    itemType: 'course' | 'article' | 'exam';
    itemId: ObjectId;        // 课程/文章/考试ID
    isRequired: boolean;     // 是否必修
    deadlineDays: number;    // 入职后多少天内完成
  }[];
  isDefault: boolean;        // 是否默认计划
  createdAt: Date;
}

// collection: user_trainings
interface UserTraining {
  _id: ObjectId;
  tenantId: string;
  userId: ObjectId;          // 员工
  planId: ObjectId;          // 培训计划
  status: 'in_progress' | 'completed' | 'overdue';
  items: {
    itemType: string;
    itemId: ObjectId;
    status: 'not_started' | 'in_progress' | 'completed';
    progress: number;         // 进度百分比
    startedAt?: Date;
    completedAt?: Date;
    score?: number;           // 考试分数
  }[];
  overallProgress: number;   // 总进度
  startedAt: Date;
  completedAt?: Date;
  updatedAt: Date;
}

// collection: exam_papers
interface ExamPaper {
  _id: ObjectId;
  tenantId: string;
  title: string;             // 试卷名称
  description?: string;
  categoryId: ObjectId;      // 关联分类
  questions: ExamQuestion[]; // 题目列表
  totalScore: number;        // 总分
  passingScore: number;      // 及格分
  timeLimit: number;         // 限时（分钟）
  shuffleQuestions: boolean;  // 是否打乱题目顺序
  shuffleOptions: boolean;    // 是否打乱选项顺序
  allowRetake: boolean;      // 允许重考
  maxRetakes: number;        // 最大重考次数
  createdBy: ObjectId;
  createdAt: Date;
}

interface ExamQuestion {
  questionId: string;
  type: 'single_choice' | 'multiple_choice' | 'true_false' | 'fill_blank' | 'essay';
  question: string;          // 题目内容
  options?: { label: string; text: string; }[]; // 选项
  correctAnswer: any;         // 正确答案（单选为option label，多选为label数组，判断为boolean）
  score: number;              // 本题分值
  explanation?: string;      // 答案解析
  tags: string[];            // 标签
}

// collection: exam_records
interface ExamRecord {
  _id: ObjectId;
  tenantId: string;
  userId: ObjectId;
  paperId: ObjectId;
  status: 'in_progress' | 'submitted' | 'graded';
  answers: { questionId: string; answer: any; }[];
  score?: number;             // 得分
  isPassed?: boolean;         // 是否通过
  startedAt: Date;
  submittedAt?: Date;
  duration?: number;          // 实际耗时（秒）
  ipAddress?: string;         // 考试IP
  createdAt: Date;
}
```

---

### 4.8 模块八：入职引导与电子签署（onboarding-module）

#### 4.8.1 功能概述
新员工从Offer接受到正式入职的全流程数字化引导，包括任务清单、材料签署、行政/财务事项办理、企业公告查阅。

#### 4.8.2 核心需求

| 需求编号 | 需求描述 | 优先级 | 备注 |
|----------|----------|--------|------|
| ONB-001 | 入职任务清单（可配置、分阶段、带截止日） | P0 | 如"入职前3天：提交身份证照片" |
| ONB-002 | 电子签署（劳动合同、保密协议、竞业限制、员工手册） | P0 | 与法大大/e签宝集成 |
| ONB-003 | 行政事项引导（工位分配、设备领取、门禁办理、邮箱开通） | P0 | 任务化 |
| ONB-004 | 财务事项引导（银行卡提交、个税APP绑定、报销培训） | P0 | 任务化 |
| ONB-005 | 入职材料收集（身份证、学历证、离职证明、体检报告） | P0 | 拍照上传 |
| ONB-006 | 入职进度可视化（进度条、已完成/待完成列表） | P0 | 员工和管理者都可见 |
| ONB-007 | 自动分配培训计划（根据岗位自动分配） | P0 | 与知识库联动 |
| ONB-008 | 导师/伙伴分配（自动分配导师，建立联系） | P1 | 文化融入 |
| ONB-009 | 入职第一天欢迎（欢迎信、团队介绍、日程安排） | P1 | 体验设计 |
| ONB-010 | 企业公告（制度发布、通知、文化宣传） | P0 | 全员必读/部门必读 |
| ONB-011 | 公告阅读确认（已读未读追踪） | P0 | 合规要求 |
| **ONB-012** | **企业AI使用培训（MCP+ERP使用指南）** | **P0** | **新员工必修，了解如何用AI操作ERP** |
| **ONB-013** | **MCP培训任务跟踪（入职培训含AI培训进度）** | **P0** | **与知识库联动，完成AI使用课程** |
| ONB-014 | 与MCP集成：AI提醒待办、查询入职进度 | P1 | 新员工关怀 |

#### 4.8.3 入职任务清单（示例）

| 阶段 | 时间节点 | 任务 | 负责方 | 类型 |
|------|----------|------|--------|------|
| 入职前 | Offer接受后 | 签署劳动合同 | 员工+HR | 电子签署 |
| 入职前 | Offer接受后 | 签署保密协议 | 员工+HR | 电子签署 |
| 入职前 | 入职前3天 | 提交身份证、学历证明 | 员工 | 材料上传 |
| 入职前 | 入职前3天 | 提交银行卡信息 | 员工 | 表单填写 |
| 入职前 | 入职前1天 | 完成《公司文化》课程 | 员工 | 培训学习 |
| 入职前 | 入职前1天 | 完成《信息安全》课程 | 员工 | 培训学习 |
| **入职前** | **入职前3天** | **完成《企业AI使用培训》（MCP+ERP入门）** | **员工** | **培训学习** |
| 入职日 | 入职当天 | 领取办公设备 | 行政 | 现场办理 |
| 入职日 | 入职当天 | 开通企业邮箱/账号 | IT | 系统开通 |
| 入职日 | 入职当天 | 认识导师/伙伴 | 导师 | 社交 |
| 入职第一周 | 入职3天内 | 完成岗位必修培训 | 员工 | 培训学习 |
| 入职第一周 | 入职5天内 | 完成岗位考试 | 员工 | 考试 |
| **入职第一周** | **入职7天内** | **完成MCP使用实操练习（AI查询薪酬/审批）** | **员工** | **考试/实操** |
| 入职第一周 | 入职7天内 | 阅读企业公告（全部） | 员工 | 阅读确认 |

#### 4.8.4 数据库集合

```typescript
// collection: onboarding_templates
interface OnboardingTemplate {
  _id: ObjectId;
  tenantId: string;
  name: string;              // 模板名称：如"标准入职流程"
  applicableRoles: string[]; // 适用角色
  applicableDepts: ObjectId[]; // 适用部门
  items: OnboardingItem[];  // 任务项
  createdAt: Date;
}

interface OnboardingItem {
  itemId: string;
  title: string;             // 任务标题
  description?: string;       // 任务说明
  itemType: 'document_sign' | 'material_upload' | 'form_fill' | 'course_complete' | 'exam_pass' | 'read_notice' | 'physical_task' | 'system_setup';
  referenceId?: ObjectId;   // 关联ID（如课程ID、文档模板ID、公告ID）
  deadlineDays: number;     // 入职后第几天前完成（负数表示入职前）
  responsibleType: 'employee' | 'hr' | 'manager' | 'admin' | 'it'; // 执行方
  isRequired: boolean;      // 是否必须完成
  sortOrder: number;
}

// collection: onboarding_instances
interface OnboardingInstance {
  _id: ObjectId;
  tenantId: string;
  userId: ObjectId;          // 新员工
  templateId: ObjectId;      // 使用的模板
  status: 'not_started' | 'in_progress' | 'completed' | 'overdue';
  items: {
    itemId: string;
    status: 'not_started' | 'in_progress' | 'completed' | 'overdue';
    completedAt?: Date;
    completedBy?: ObjectId;
    result?: any;             // 结果（如签署ID、考试成绩）
    note?: string;            // 备注
  }[];
  mentorId?: ObjectId;       // 导师
  buddyId?: ObjectId;        // 伙伴
  overallProgress: number;  // 总进度
  startedAt: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// collection: notices
interface Notice {
  _id: ObjectId;
  tenantId: string;
  title: string;             // 公告标题
  content: string;            // 公告内容（富文本）
  type: 'company' | 'department' | 'system' | 'culture' | 'finance' | 'admin';
  priority: 'normal' | 'important' | 'urgent'; // 优先级
  targetDepts?: ObjectId[];  // 目标部门（空为全员）
  targetRoles?: string[];    // 目标角色
  attachments?: { name: string; url: string; }[];
  requireConfirmation: boolean; // 是否需要阅读确认
  confirmedBy: ObjectId[];   // 已确认人员列表
  readCount: number;         // 阅读次数
  publishAt: Date;           // 发布时间
  expireAt?: Date;           // 过期时间
  status: 'draft' | 'published' | 'archived';
  createdBy: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}
```

---

### 4.9 模块九：员工关怀与校友管理（care-module）

#### 4.9.1 功能概述
覆盖在职关怀和离职管理，建立校友人才库，维护与离职员工的良好关系，支持行业PR。

#### 4.9.2 核心需求

| 需求编号 | 需求描述 | 优先级 | 备注 |
|----------|----------|--------|------|
| CARE-001 | 在职关怀日历（生日提醒、入职周年、转正提醒） | P0 | 自动推送HR和管理层 |
| CARE-002 | 生日/周年祝福（系统自动发送祝福，支持定制） | P1 | 钉钉/飞书消息+邮件 |
| CARE-003 | 满意度调查（试用期、季度、年度） | P1 | 匿名问卷 |
| CARE-004 | 离职申请流程（审批→交接→离职面谈） | P0 | 与审批模块联动 |
| CARE-005 | 离职交接清单（工作交接、账号回收、设备归还） | P0 | 任务化 |
| CARE-006 | 离职面谈记录（离职原因、建议、去向） | P1 | 结构化记录 |
| CARE-007 | 校友库管理（离职人员信息、去向、联系方式） | P1 | 长期维护 |
| CARE-008 | 校友联系记录（定期回访、活动邀请、合作机会） | P1 | 维护关系 |
| CARE-009 | 校友社区（可选：校友群组、活动、内推） | P2 | 长期规划 |
| CARE-010 | 在职员工关怀活动（团建、节日礼物、福利发放） | P2 | 记录管理 |
| CARE-011 | 与MCP集成：AI提醒关怀事项、查询校友信息 | P1 | HR效率 |

#### 4.9.3 数据库集合

```typescript
// collection: alumni
interface Alumni {
  _id: ObjectId;
  tenantId: string;
  userId: ObjectId;          // 原员工ID（保留关联）
  name: string;              // 姓名
  phone?: string;           // 手机号（加密）
  email?: string;           // 邮箱（加密）
  lastPosition: string;      // 离职职位
  lastDepartment: string;    // 离职部门
  entryDate: Date;           // 入职日期
  resignDate: Date;          // 离职日期
  tenureDays: number;        // 在职天数
  resignReason: string;      // 离职原因（面谈记录）
  resignType: 'voluntary' | 'involuntary' | 'contract_end' | 'mutual';
  nextCompany?: string;      // 去向公司
  nextPosition?: string;     // 去向职位
  contactStatus: 'active' | 'lost' | 'rehire_candidate' | 'partner';
  contactRecords: {
    date: Date;
    type: 'call' | 'meeting' | 'message' | 'event';
    content: string;
    operatorId: ObjectId;
  }[];
  tags: string[];            // 标签：优秀, 可返聘, 行业资源...
  isRehireEligible: boolean; // 是否可返聘
  notes?: string;            // 备注
  createdAt: Date;
  updatedAt: Date;
}

// collection: care_events
interface CareEvent {
  _id: ObjectId;
  tenantId: string;
  userId: ObjectId;          // 关联员工
  eventType: 'birthday' | 'anniversary' | 'probation_end' | 'promotion' | 'transfer' | 'custom';
  eventDate: Date;           // 事件日期
  title: string;             // 事件标题
  description?: string;       // 描述
  isAutoGenerated: boolean;  // 是否系统自动生成
  handledBy?: ObjectId;     // 处理人
  handledAt?: Date;          // 处理时间
  status: 'pending' | 'handled' | 'ignored';
  createdAt: Date;
}

// collection: resignation_records
interface ResignationRecord {
  _id: ObjectId;
  tenantId: string;
  userId: ObjectId;
  approvalInstanceId: ObjectId; // 关联审批实例
  submitDate: Date;           // 提交日期
  lastWorkingDate: Date;      // 最后工作日
  reason: string;             // 离职原因
  interviewFeedback?: {       // 离职面谈
    interviewerId: ObjectId;
    content: string;
    score?: number;           // 公司推荐度 1-5
    createdAt: Date;
  };
  handoverStatus: {           // 交接状态
    work: 'pending' | 'completed';
    accounts: 'pending' | 'completed';
    devices: 'pending' | 'completed';
    documents: 'pending' | 'completed';
  };
  createdAt: Date;
  updatedAt: Date;
}
```

---

### 4.10 模块十：数据安全与权限（security-module）

#### 4.10.1 功能概述
系统的安全底座，提供RBAC权限、数据脱敏、审计日志、数据加密、访问控制。

#### 4.10.2 核心需求

| 需求编号 | 需求描述 | 优先级 | 备注 |
|----------|----------|--------|------|
| SEC-001 | RBAC权限模型（角色-权限-资源三级） | P0 | 菜单/按钮/字段/数据四级控制 |
| SEC-002 | 数据脱敏（手机号、身份证、银行卡、邮箱） | P0 | 前端展示脱敏，后端按需解密 |
| SEC-003 | 字段级权限（某些字段仅HR/财务可见） | P0 | 如薪酬字段 |
| SEC-004 | 数据级权限（只能看本部门/本人数据） | P0 | 部门隔离 |
| SEC-005 | 审计日志（登录、操作、导出、查看） | P0 | 保留180天 |
| SEC-006 | 敏感操作二次确认（如批量导出、修改薪酬） | P0 | 需再次验证身份 |
| SEC-007 | 数据加密（AES-256-GCM，敏感字段数据库级加密） | P0 | 手机号、身份证、银行卡 |
| SEC-008 | 密码策略（如使用密码登录时的复杂度） | P1 | 外部账号使用 |
| SEC-009 | 登录安全（异地登录告警、异常行为检测） | P1 | 安全运营 |
| SEC-010 | 数据备份策略（每日增量、每周全量） | P1 | 可恢复 |
| SEC-011 | API限流（防止暴力破解和数据爬取） | P0 | 网关层实现 |
| SEC-012 | MCP权限隔离（不同API Key只能访问指定资源） | P0 | 防止AI越权 |

#### 4.10.3 权限模型（RBAC）

```typescript
// 权限粒度：4级
// Level 1: 菜单权限（能否看到"薪酬管理"菜单）
// Level 2: 操作权限（能否点击"计算薪酬"按钮）
// Level 3: 字段权限（能否看到"基本工资"字段）
// Level 4: 数据权限（能否看到"本部门"还是"全公司"数据）

// collection: permissions
interface Permission {
  _id: ObjectId;
  tenantId: string;
  code: string;              // 权限编码：如 payroll:sheet:view
  name: string;              // 权限名称：查看薪酬单
  module: string;            // 所属模块：payroll
  resource: string;          // 资源：sheet
  action: string;            // 操作：view | create | update | delete | export | approve
  description: string;       // 中文描述
  createdAt: Date;
}

// collection: roles
interface Role {
  _id: ObjectId;
  tenantId: string;
  code: string;              // 角色编码
  name: string;              // 角色名称
  description?: string;      // 描述
  permissions: string[];     // 权限编码列表
  dataScope: 'all' | 'department' | 'self' | 'custom'; // 数据范围
  customDeptIds?: ObjectId[]; // 自定义部门范围
  isSystem: boolean;         // 是否系统预设
  createdAt: Date;
}

// collection: audit_logs
interface AuditLog {
  _id: ObjectId;
  tenantId: string;
  userId?: ObjectId;         // 操作人
  oauthClientId?: string;    // MCP OAuth客户端ID
  action: string;            // 操作：LOGIN / VIEW / CREATE / UPDATE / DELETE / EXPORT / MCP_CALL
  module: string;             // 模块
  resourceId?: string;       // 资源ID
  resourceType: string;      // 资源类型
  details: Record<string, any>; // 操作详情（变更前后）
  ipAddress: string;         // IP地址
  userAgent: string;         // 浏览器UA
  timestamp: Date;           // 操作时间
  duration?: number;         // 耗时（ms）
  result: 'success' | 'failure';
  errorMessage?: string;     // 错误信息
}
```

---

### 4.11 模块十一：UI/UX设计规范（ui-module）

#### 4.11.1 设计原则
- **简约（Simplicity）**：减少视觉噪音，信息层级清晰
- **高效（Efficiency）**：常用操作3步内完成，支持批量操作
- **一致（Consistency）**：跨模块统一组件、交互、文案
- **响应式（Responsive）**：PC端为主，移动端自适应
- **友好（Friendly）**：空状态引导、操作反馈、加载动画

#### 4.11.2 颜色体系

```css
:root {
  /* 主色调 */
  --primary-color: #1677FF;          /* 品牌蓝 */
  --primary-hover: #4096FF;
  --primary-active: #0958D9;
  
  /* 功能色 */
  --success-color: #52C41A;          /* 成功/通过 */
  --warning-color: #FAAD14;          /* 警告/待处理 */
  --error-color: #F5222D;            /* 错误/驳回 */
  --info-color: #1677FF;             /* 信息/提示 */
  
  /* 中性色 */
  --text-primary: #1F1F1F;           /* 主标题 */
  --text-secondary: #666666;         /* 次要文字 */
  --text-disabled: #BFBFBF;           /* 禁用/提示 */
  --border-color: #E5E5E5;            /* 边框 */
  --bg-primary: #FFFFFF;              /* 背景白 */
  --bg-secondary: #F5F5F5;           /* 背景灰 */
  --bg-hover: #F0F5FF;               /* 悬停背景 */
}
```

#### 4.11.3 布局规范

**PC端（管理后台）**
- 顶部导航栏：60px高，Logo + 模块切换 + 全局搜索 + 消息 + 头像
- 左侧菜单栏：200px宽，可收起，支持多级菜单
- 内容区域：自适应宽度，最大1400px居中，24px内边距
- 面包屑导航：内容区顶部，支持返回
- 页签栏：支持多页面缓存（类似浏览器Tab）

**移动端（H5/小程序）**
- 底部Tab导航：4-5个主入口（首页/审批/知识/我的）
- 顶部导航栏：44px高，返回按钮 + 标题 + 操作按钮
- 卡片式布局：圆角12px，阴影0 2px 8px rgba(0,0,0,0.08)
- 列表式布局：左图右文，点击热区48px高

#### 4.11.4 组件规范
- 按钮：主按钮（实心）/ 次按钮（描边）/ 文字按钮/ 危险按钮
- 表单：标签左对齐（PC）/ 顶部对齐（移动端），必填用红色星号
- 表格：支持排序、筛选、分页、批量操作、空状态
- 审批卡片：状态色标签 + 进度条 + 审批人头像 + 时间线
- 消息通知：Toast（2秒自动消失）/ Modal（需确认）/ 抽屉（侧滑）

#### 4.11.5 响应式断点

| 设备 | 断点 | 布局 |
|------|------|------|
| 手机 | < 768px | 底部Tab + 单列卡片 |
| 平板 | 768px - 1024px | 左侧抽屉菜单 + 双列卡片 |
| 电脑 | > 1024px | 左侧固定菜单 + 多列布局 |

---

### 4.12 模块十二：OP SaaS桥接（saas-bridge-module）

#### 4.12.1 功能概述
告趣自研的OP业务系统（管理MCN/广告/团长/返利）已成熟，即将对外SaaS化。ERP需要与OP SaaS建立桥接，实现：
- 统一账号体系（ERP账号可直接登录OP）
- 组织架构同步（ERP的部门/人员同步到OP）
- 权限映射（ERP角色映射到OP角色）
- 数据互通（OP的业务数据可在ERP查看摘要）
- 审批互通（OP的业务审批可路由到ERP审批中心）

#### 4.12.2 核心需求

| 需求编号 | 需求描述 | 优先级 | 备注 |
|----------|----------|--------|------|
| SAA-001 | ERP账号Token可换取OP登录Token（JWT互信） | P1 | 单点登录 |
| SAA-002 | 组织架构变更自动同步到OP（Webhook推送） | P1 | 实时同步 |
| SAA-003 | OP的业务数据摘要推送到ERP（每日同步） | P2 | 如本月GMV、合作达人数量 |
| SAA-004 | ERP的审批结果回调到OP（通过/驳回） | P2 | 业务审批联动 |
| SAA-005 | OP的MCP Server注册到ERP的MCP网关 | P1 | 统一AI入口 |

---

## 5. API接口规范

### 5.1 通用规范

#### 5.1.1 基础约定
- **协议**: HTTPS
- **格式**: JSON
- **编码**: UTF-8
- **时区**: 服务器使用UTC，接口返回ISO 8601格式（如`2025-06-27T10:00:00Z`），前端按本地时区展示
- **语言**: 接口文档和代码注释全部使用中文
- **版本控制**: URL路径版本化，如 `/api/v1/users`

#### 5.1.2 请求规范

```http
GET /api/v1/approval/templates?status=published&page=1&pageSize=20
Authorization: Bearer {accessToken}
Content-Type: application/json
Accept-Language: zh-CN
```

#### 5.1.3 响应规范

```typescript
// 统一响应结构
interface ApiResponse<T> {
  code: string;              // 业务状态码："SUCCESS" / "ERROR" / "VALIDATION_ERROR"
  message: string;           // 中文提示信息
  data: T;                  // 响应数据
  traceId: string;          // 请求追踪ID（用于排查）
  timestamp: string;         // 响应时间戳（ISO 8601）
}

// 分页响应结构
interface PaginatedResponse<T> {
  list: T[];                // 数据列表
  total: number;            // 总条数
  page: number;             // 当前页
  pageSize: number;         // 每页条数
  totalPages: number;       // 总页数
}

// 错误响应示例（HTTP 400）
{
  "code": "VALIDATION_ERROR",
  "message": "请求参数校验失败",
  "data": {
    "fields": [
      { "field": "phone", "message": "手机号格式不正确" },
      { "field": "realName", "message": "真实姓名不能为空" }
    ]
  },
  "traceId": "req-20250627-abc123",
  "timestamp": "2025-06-27T10:00:00Z"
}

// 业务错误响应示例（HTTP 404）
{
  "code": "APPROVAL_NOT_FOUND",
  "message": "审批实例不存在或已被删除",
  "data": null,
  "traceId": "req-20250627-def456",
  "timestamp": "2025-06-27T10:00:00Z"
}
```

#### 5.1.4 标准HTTP状态码

| 状态码 | 含义 | 使用场景 |
|--------|------|----------|
| 200 | OK | 成功响应 |
| 201 | Created | 创建成功 |
| 204 | No Content | 删除成功/无返回体 |
| 400 | Bad Request | 参数校验失败 |
| 401 | Unauthorized | 未认证/Token过期 |
| 403 | Forbidden | 无权限访问 |
| 404 | Not Found | 资源不存在 |
| 409 | Conflict | 资源冲突（如重复提交） |
| 429 | Too Many Requests | 请求过于频繁 |
| 500 | Internal Server Error | 服务器内部错误 |

#### 5.1.5 业务状态码规范

所有业务状态码使用大写下划线命名，按模块前缀：

```
通用：SUCCESS, ERROR, VALIDATION_ERROR, UNAUTHORIZED, FORBIDDEN, NOT_FOUND
认证：AUTH_INVALID_TOKEN, AUTH_EXPIRED_TOKEN, AUTH_LOGIN_FAILED, AUTH_SSO_ERROR
审批：APPROVAL_NOT_FOUND, APPROVAL_ALREADY_HANDLED, APPROVAL_NO_PERMISSION, APPROVAL_INVALID_FLOW
薪酬：PAYROLL_NOT_FOUND, PAYROLL_LOCKED, PAYROLL_CALC_ERROR, PAYROLL_NO_PERMISSION
招聘：CANDIDATE_NOT_FOUND, CANDIDATE_DUPLICATE, CANDIDATE_INVALID_STAGE
知识：KNOWLEDGE_NOT_FOUND, EXAM_ALREADY_PASSED, EXAM_TIME_EXCEEDED
```

### 5.2 模块接口清单（按模块）

#### 5.2.1 认证模块（Auth）

| 方法 | 路径 | 中文说明 | 请求体 | 响应体 |
|------|------|----------|--------|--------|
| POST | /api/v1/auth/login/dingtalk | 钉钉登录 | `{ authCode: string }` | `{ accessToken, refreshToken, user }` |
| POST | /api/v1/auth/login/feishu | 飞书登录 | `{ code: string }` | `{ accessToken, refreshToken, user }` |
| POST | /api/v1/auth/login/phone | 手机号登录 | `{ phone, smsCode }` | `{ accessToken, refreshToken, user }` |
| POST | /api/v1/auth/refresh | 刷新Token | `{ refreshToken }` | `{ accessToken, refreshToken }` |
| POST | /api/v1/auth/logout | 退出登录 | `{}` | `null` |
| GET | /api/v1/auth/me | 获取当前用户信息 | - | `User` |
| GET | /api/v1/auth/mcp-connections | 获取我的MCP授权连接 | - | `McpConnection[]` |
| DELETE | /api/v1/auth/mcp-connections/:id | 撤销MCP授权连接 | - | `null` |
| POST | /api/v1/security/oauth-clients | 创建服务型MCP OAuth客户端（管理员） | `{ name, scopes, expiresAt }` | `OAuthClientMetadata` |

#### 5.2.2 审批模块（Approval）

| 方法 | 路径 | 中文说明 | 请求体 | 响应体 |
|------|------|----------|--------|--------|
| GET | /api/v1/approval/templates | 查询审批模板列表 | query参数 | `PaginatedResponse<Template>` |
| GET | /api/v1/approval/templates/:id | 获取审批模板详情 | - | `Template` |
| POST | /api/v1/approval/instances | 提交审批申请 | `{ templateId, formData, ccUserIds }` | `Instance` |
| GET | /api/v1/approval/instances | 查询审批列表（我发起的/待我审批的/我已审批的） | query: `type=my|pending|handled` | `PaginatedResponse<Instance>` |
| GET | /api/v1/approval/instances/:id | 获取审批详情 | - | `Instance` |
| POST | /api/v1/approval/instances/:id/handle | 处理审批（同意/驳回/转交） | `{ action, comment, attachments }` | `Instance` |
| POST | /api/v1/approval/instances/:id/urge | 催办审批 | `{ message }` | `null` |
| POST | /api/v1/approval/instances/:id/revoke | 撤回审批 | `{ reason }` | `Instance` |
| GET | /api/v1/approval/instances/:id/timeline | 获取审批时间线 | - | `TimelineItem[]` |
| GET | /api/v1/approval/statistics | 审批统计（管理员） | query: `startDate, endDate` | `Statistics` |

#### 5.2.3 薪酬模块（Payroll）

| 方法 | 路径 | 中文说明 | 请求体 | 响应体 |
|------|------|----------|--------|--------|
| GET | /api/v1/payroll/schemes | 查询薪酬方案列表 | - | `PayrollScheme[]` |
| POST | /api/v1/payroll/schemes | 创建薪酬方案 | `PayrollScheme` | `PayrollScheme` |
| GET | /api/v1/payroll/sheets | 查询薪酬单列表（管理员） | query: `month, deptId, status` | `PaginatedResponse<PayrollSheet>` |
| GET | /api/v1/payroll/sheets/my | 查询我的薪酬单 | query: `month` | `PayrollSheet[]` |
| GET | /api/v1/payroll/sheets/:id | 获取薪酬单详情 | - | `PayrollSheet` |
| POST | /api/v1/payroll/sheets/calculate | 批量计算薪酬 | `{ month, userIds }` | `{ jobId: string }` |
| GET | /api/v1/payroll/sheets/calculate/:jobId | 查询计算进度 | - | `{ progress, status }` |
| POST | /api/v1/payroll/sheets/:id/approve | 薪酬单审批 | `{ action }` | `PayrollSheet` |
| POST | /api/v1/payroll/sheets/:id/pay | 标记薪酬已发放 | `{ paidMethod, paidAt }` | `PayrollSheet` |
| GET | /api/v1/payroll/sheets/:id/pdf | 下载薪酬单PDF | - | `PDF文件流` |
| GET | /api/v1/payroll/statistics | 薪酬统计 | query: `month, groupBy` | `Statistics` |

#### 5.2.4 招聘模块（Recruitment）

| 方法 | 路径 | 中文说明 | 请求体 | 响应体 |
|------|------|----------|--------|--------|
| GET | /api/v1/recruitment/positions | 查询招聘职位 | query参数 | `PaginatedResponse<Position>` |
| POST | /api/v1/recruitment/positions | 创建职位 | `Position` | `Position` |
| GET | /api/v1/recruitment/candidates | 查询候选人 | query参数 | `PaginatedResponse<Candidate>` |
| POST | /api/v1/recruitment/candidates | 添加候选人 | `Candidate` | `Candidate` |
| POST | /api/v1/recruitment/candidates/:id/stage | 更新候选人阶段 | `{ stage, note }` | `Candidate` |
| POST | /api/v1/recruitment/candidates/:id/interviews | 安排面试 | `Interview` | `Interview` |
| POST | /api/v1/recruitment/candidates/:id/feedback | 提交面试反馈 | `InterviewFeedback` | `Interview` |
| POST | /api/v1/recruitment/candidates/:id/offer | 发送Offer | `OfferInfo` | `Candidate` |
| GET | /api/v1/recruitment/talent-pool | 查询人才库 | query参数 | `PaginatedResponse<Candidate>` |
| GET | /api/v1/recruitment/statistics | 招聘统计 | query: `startDate, endDate` | `Statistics` |
| POST | /api/v1/recruitment/apply | 外部投递简历（无需登录） | `{ positionId, name, phone, email, resume }` | `Candidate` |

#### 5.2.5 知识库模块（Knowledge）

| 方法 | 路径 | 中文说明 | 请求体 | 响应体 |
|------|------|----------|--------|--------|
| GET | /api/v1/knowledge/categories | 查询知识分类 | - | `Category[]` |
| GET | /api/v1/knowledge/articles | 查询文章 | query: `categoryId, keyword` | `PaginatedResponse<Article>` |
| GET | /api/v1/knowledge/articles/:id | 获取文章详情 | - | `Article` |
| POST | /api/v1/knowledge/articles/:id/like | 点赞文章 | - | `null` |
| GET | /api/v1/knowledge/courses | 查询课程列表 | query参数 | `PaginatedResponse<Course>` |
| GET | /api/v1/knowledge/courses/:id | 获取课程详情 | - | `Course` |
| POST | /api/v1/knowledge/courses/:id/progress | 更新学习进度 | `{ chapterId, progress }` | `UserTraining` |
| GET | /api/v1/knowledge/trainings | 查询我的培训计划 | - | `UserTraining[]` |
| GET | /api/v1/knowledge/exams | 查询我的考试 | - | `ExamRecord[]` |
| POST | /api/v1/knowledge/exams/:id/start | 开始考试 | - | `ExamRecord` |
| POST | /api/v1/knowledge/exams/:id/submit | 提交考试 | `{ answers }` | `{ score, isPassed }` |
| GET | /api/v1/knowledge/search | 知识搜索 | `q: string` | `SearchResult[]` |

#### 5.2.6 入职模块（Onboarding）

| 方法 | 路径 | 中文说明 | 请求体 | 响应体 |
|------|------|----------|--------|--------|
| GET | /api/v1/onboarding/templates | 查询入职模板 | - | `Template[]` |
| GET | /api/v1/onboarding/instances | 查询入职实例（HR） | query参数 | `PaginatedResponse<Instance>` |
| GET | /api/v1/onboarding/my-progress | 查询我的入职进度 | - | `Instance` |
| POST | /api/v1/onboarding/instances/:id/items/:itemId/complete | 完成入职任务 | `{ result }` | `Instance` |
| POST | /api/v1/onboarding/instances/:id/sign | 电子签署 | `{ documentType }` | `{ signUrl }` |
| GET | /api/v1/notices | 查询公告列表 | query: `type, target` | `PaginatedResponse<Notice>` |
| GET | /api/v1/notices/:id | 获取公告详情 | - | `Notice` |
| POST | /api/v1/notices/:id/confirm | 确认已读 | - | `null` |
| GET | /api/v1/notices/unread-count | 查询未读公告数 | - | `{ count: number }` |

#### 5.2.7 关怀模块（Care）

| 方法 | 路径 | 中文说明 | 请求体 | 响应体 |
|------|------|----------|--------|--------|
| GET | /api/v1/care/events | 查询关怀事件 | query: `type, month` | `CareEvent[]` |
| GET | /api/v1/care/alumni | 查询校友库 | query参数 | `PaginatedResponse<Alumni>` |
| POST | /api/v1/care/alumni/:id/contact | 添加联系记录 | `{ type, content }` | `Alumni` |
| GET | /api/v1/care/resignations | 查询离职记录 | query参数 | `PaginatedResponse<ResignationRecord>` |
| POST | /api/v1/care/resignations/:id/interview | 提交离职面谈 | `InterviewFeedback` | `ResignationRecord` |
| POST | /api/v1/care/resignations/:id/handover | 更新交接状态 | `{ type, status }` | `ResignationRecord` |
| GET | /api/v1/care/statistics | 员工关怀统计 | query: `startDate, endDate` | `Statistics` |

#### 5.2.8 组织模块（Org）

| 方法 | 路径 | 中文说明 | 请求体 | 响应体 |
|------|------|----------|--------|--------|
| GET | /api/v1/org/departments | 查询部门树 | - | `Department[]` |
| GET | /api/v1/org/users | 查询员工列表 | query参数 | `PaginatedResponse<User>` |
| GET | /api/v1/org/users/:id | 获取员工详情 | - | `User` |
| PUT | /api/v1/org/users/:id | 更新员工信息 | `User` | `User` |
| POST | /api/v1/org/users/:id/transfer | 员工调岗 | `{ newDeptId, newJobTitle, effectiveDate }` | `User` |
| POST | /api/v1/org/users/:id/promote | 员工晋升 | `{ newJobLevel, effectiveDate }` | `User` |
| POST | /api/v1/org/users/:id/resign | 发起离职 | `{ resignDate, reason }` | `ResignationRecord` |
| GET | /api/v1/org/org-chart | 获取组织架构图 | query: `deptId` | `OrgChartNode` |
| POST | /api/v1/org/sync/dingtalk | 同步钉钉组织架构 | - | `{ jobId: string }` |
| POST | /api/v1/org/sync/feishu | 同步飞书组织架构 | - | `{ jobId: string }` |

---

## 6. MCP协议规范

### 6.1 MCP Server 配置

```json
{
  "name": "gaoq-erp",
  "version": "1.0.0",
  "description": "告趣企业ERP系统MCP接口，支持审批、薪酬、招聘、知识库等操作",
  "transport": {
    "type": "streamable-http",
    "url": "https://erp.gaoq.com/mcp",
    "headers": {
      "Authorization": "Bearer {oauthAccessToken}",
      "MCP-Protocol-Version": "2025-11-25"
    }
  },
  "resources": [
    {
      "uri": "user://{userId}/profile",
      "name": "员工档案",
      "description": "获取指定员工的档案信息（需有权限）",
      "mimeType": "application/json"
    },
    {
      "uri": "approval://pending",
      "name": "我的待审批",
      "description": "获取当前用户的待审批列表",
      "mimeType": "application/json"
    },
    {
      "uri": "payroll://my/{month}",
      "name": "我的薪酬单",
      "description": "获取指定月份的薪酬单",
      "mimeType": "application/json"
    },
    {
      "uri": "knowledge://search?q={query}",
      "name": "知识库搜索",
      "description": "搜索知识库文章和课程",
      "mimeType": "application/json"
    },
    {
      "uri": "training://plans",
      "name": "培训计划列表",
      "description": "获取当前用户的培训计划列表",
      "mimeType": "application/json"
    },
    {
      "uri": "training://progress/{userId}",
      "name": "员工培训进度",
      "description": "获取指定员工的培训进度（需有权限）",
      "mimeType": "application/json"
    },
    {
      "uri": "exam://results/{examId}",
      "name": "考试结果",
      "description": "获取指定考试的详细结果和统计数据",
      "mimeType": "application/json"
    },
    {
      "uri": "mcp://guide",
      "name": "MCP使用指南",
      "description": "获取企业MCP使用指南，帮助员工学习如何通过AI操作ERP",
      "mimeType": "application/json"
    }
  ],
  "tools": [
    {
      "name": "submitApproval",
      "description": "提交审批申请，支持请假、报销、出差等",
      "inputSchema": {
        "type": "object",
        "properties": {
          "type": { "type": "string", "description": "审批类型编码" },
          "formData": { "type": "object", "description": "审批表单数据" },
          "ccUserIds": { "type": "array", "items": { "type": "string" }, "description": "抄送人ID列表" }
        },
        "required": ["type", "formData"]
      }
    },
    {
      "name": "createTrainingPlan",
      "description": "【HRBP专用】创建培训计划，指定目标岗位、职级和培训课程",
      "inputSchema": {
        "type": "object",
        "properties": {
          "name": { "type": "string", "description": "培训计划名称，如'经纪人入职培训计划'" },
          "targetRoles": { "type": "array", "items": { "type": "string" }, "description": "目标角色编码列表" },
          "targetJobLevels": { "type": "array", "items": { "type": "string" }, "description": "目标职级列表，如['P1', 'P2']" },
          "items": { "type": "array", "items": { "type": "object" }, "description": "培训项目列表，每项含itemType/itemId/isRequired/deadlineDays" }
        },
        "required": ["name", "targetRoles", "items"]
      }
    },
    {
      "name": "assignTrainingToUsers",
      "description": "【HRBP专用】为指定员工/部门批量分配培训任务",
      "inputSchema": {
        "type": "object",
        "properties": {
          "userIds": { "type": "array", "items": { "type": "string" }, "description": "员工ID列表，为空则按部门分配" },
          "deptIds": { "type": "array", "items": { "type": "string" }, "description": "部门ID列表，userIds为空时按部门全员分配" },
          "planId": { "type": "string", "description": "培训计划ID" },
          "assignType": { "type": "string", "description": "分配类型：mandatory强制/optional选修" }
        },
        "required": ["planId"]
      }
    },
    {
      "name": "getTrainingProgress",
      "description": "【HRBP/管理层】查询培训进度报表，支持按部门/岗位/个人维度统计",
      "inputSchema": {
        "type": "object",
        "properties": {
          "planId": { "type": "string", "description": "培训计划ID" },
          "deptId": { "type": "string", "description": "部门ID" },
          "userId": { "type": "string", "description": "指定员工ID" },
          "dimension": { "type": "string", "description": "统计维度：overview/dept/user" }
        },
        "required": ["planId"]
      }
    },
    {
      "name": "createExam",
      "description": "【HRBP专用】创建考试/试卷，从题库中组卷",
      "inputSchema": {
        "type": "object",
        "properties": {
          "title": { "type": "string", "description": "考试名称" },
          "categoryId": { "type": "string", "description": "知识分类ID" },
          "questionIds": { "type": "array", "items": { "type": "string" }, "description": "题目ID列表" },
          "passingScore": { "type": "number", "description": "及格分数线" },
          "timeLimit": { "type": "number", "description": "考试限时（分钟）" },
          "assignedUserIds": { "type": "array", "items": { "type": "string" }, "description": "参加考试的员工ID列表" }
        },
        "required": ["title", "questionIds", "passingScore"]
      }
    },
    {
      "name": "getMcpGuide",
      "description": "获取企业MCP使用指南，帮助员工了解如何通过AI操作ERP系统",
      "inputSchema": {
        "type": "object",
        "properties": {
          "topic": { "type": "string", "description": "主题，如'薪酬查询'/'审批提交'/'通用介绍'，为空则返回完整指南" }
        }
      }
    }
  ]
}
```

### 6.2 MCP 权限控制

每个MCP OAuth授权或服务客户端绑定：
- **允许访问的Resources**（白名单）
- **允许调用的Tools**（白名单）
- **数据范围**（本人/本部门/全公司）
- **IP白名单**（可选）

### 6.3 MCP 审计

所有MCP调用记录到 `mcp_audit_logs` 集合：

```typescript
interface McpAuditLog {
  _id: ObjectId;
  oauthClientId: string;     // OAuth客户端ID
  subjectId: string;         // 用户或服务主体ID
  tenantId: string;          // 租户ID
  toolName?: string;         // 调用的Tool
  resourceUri?: string;      // 访问的Resource
  parameters: Record<string, any>; // 参数
  result: 'success' | 'failure';
  errorMessage?: string;     // 错误信息
  ipAddress: string;         // 调用方IP
  duration: number;          // 执行耗时（ms）
  timestamp: Date;           // 调用时间
}
```

---

## 7. 数据库设计原则

### 7.1 MongoDB设计规范

1. **集合命名**：小写下划线，复数形式，如 `users`, `payroll_sheets`, `approval_instances`
2. **字段命名**：驼峰命名（camelCase），如 `createdAt`, `userId`, `jobLevel`
3. **ID生成**：使用MongoDB原生ObjectId
4. **租户隔离**：所有集合必须包含 `tenantId` 字段，查询必须带租户过滤
5. **软删除**：使用 `isDeleted` + `deletedAt` 字段，非物理删除
6. **审计字段**：所有集合必须有 `createdAt`, `updatedAt`
7. **索引策略**：
   - 所有查询条件字段建索引
   - 租户字段+查询条件建联合索引
   - 时间排序字段建索引
   - 文本搜索字段建文本索引

### 7.2 关键索引示例

```javascript
// users 集合索引
db.users.createIndex({ tenantId: 1, phone: 1 }, { unique: true });
db.users.createIndex({ tenantId: 1, unionId: 1 });
db.users.createIndex({ tenantId: 1, status: 1, departmentId: 1 });
db.users.createIndex({ realName: "text", phone: "text" });

// approval_instances 集合索引
db.approval_instances.createIndex({ tenantId: 1, applicantId: 1, status: 1, createdAt: -1 });
db.approval_instances.createIndex({ tenantId: 1, status: 1, "nodes.approverIds": 1 });
db.approval_instances.createIndex({ tenantId: 1, templateId: 1, createdAt: -1 });

// payroll_sheets 集合索引
db.payroll_sheets.createIndex({ tenantId: 1, month: 1, userId: 1 }, { unique: true });
db.payroll_sheets.createIndex({ tenantId: 1, month: 1, status: 1 });

// candidates 集合索引
db.candidates.createIndex({ tenantId: 1, phone: 1 }, { sparse: true });
db.candidates.createIndex({ tenantId: 1, email: 1 }, { sparse: true });
db.candidates.createIndex({ tenantId: 1, stage: 1, positionId: 1 });
```

---

## 8. 实施路线图

### 8.1 阶段划分

| 阶段 | 参考时间 | 目标 | 强制交付 |
|------|------|------|--------|
| **Phase 0** | 4-6周 | 治理与契约冻结 | 架构、数据、安全、集成、MCP、切换规范与GitHub Backlog |
| **Phase 1** | 8-10周 | 平台与主数据底座 | 多租户、身份、组织主数据、双平台连接、MCP Core |
| **Phase 2** | 8-10周 | 审批工作流MVP | 审批、表单、PC/H5、通知与审批MCP能力 |
| **Phase 3** | 10-12周 | 人才与学习闭环 | 招聘、e签宝、入职、知识培训、关怀与对应MCP能力 |
| **Phase 4** | 10-12周 | 薪酬闭环 | 考勤、薪酬、薪税文件、发放回盘、对账与对应MCP能力 |
| **Phase 5** | 8-10周 | 连接与生产加固 | OP桥接、移动端、分析、迁移工具和完整MCP目录 |
| **Phase 6** | 6-8周 | 统一大切换 | 三次演练、正式切换、回滚保障和四周Hypercare |

### 8.2 迭代详细计划

详细阶段范围、责任、质量指标和退出门禁统一维护在[`docs/phase-0/00-program-charter.md`](./docs/phase-0/00-program-charter.md)。本PRD不再复制实现清单，避免产品需求与工程Backlog出现双重事实源。

执行原则：

1. 多租户、身份、安全、审计、可观测性、集成底座和MCP Core在Phase 1完成，不得后置。
2. 每个业务模块必须同步交付REST、事件、MCP能力和审计点。
3. e签宝在Offer和员工合同正式上线前完成验收。
4. 薪酬正式上线前至少完成两个完整薪资周期的影子计算。
5. 所有旧系统在Phase 6统一切换；此前只做影子验证和迁移演练。

### 8.3 风险与应对

| 风险 | 影响 | 概率 | 应对措施 |
|------|------|------|----------|
| 钉钉/飞书API变更 | 高 | 中 | 封装适配层，监控API版本 |
| 薪酬计算逻辑复杂 | 高 | 高 | 先支持简单结构，逐步迭代；找财务专家Review |
| 数据迁移（历史数据） | 高 | 中 | 提供导入脚本，先跑并行再切换 |
| 移动端体验不佳 | 中 | 中 | 用Ant Design Mobile，先做核心功能 |
| 员工使用习惯阻力 | 中 | 高 | 培训和激励并行，保留钉钉/飞书消息通知 |
| 安全合规（数据保护） | 高 | 中 | 数据加密、审计日志、权限控制，定期安全Review |

---

## 9. 非功能性需求

### 9.1 性能需求
- 页面加载时间 < 2秒（PC端）
- API响应时间 < 500ms（P95）
- 并发支持：1000用户同时在线
- 薪酬计算：1000人/月 < 5分钟
- 数据库查询：简单查询 < 50ms，复杂查询 < 500ms

### 9.2 可用性需求
- 系统可用性：99.5%（月度停机时间 < 3.6小时）
- 数据备份：每日增量备份，每周全量备份，保留30天
- 灾难恢复：RTO < 4小时，RPO < 1小时

### 9.3 安全需求
- 所有敏感数据（手机号、身份证、银行卡、邮箱）数据库加密存储
- 传输层TLS 1.3
- 密码（如有）使用bcrypt哈希，成本因子12
- 会话Token 2小时过期，Refresh Token 7天过期
- 敏感操作需二次验证（如修改薪酬、导出数据）
- 审计日志保留180天，不可修改
- 防SQL注入（MongoDB参数化查询）、防XSS（输出转义）

### 9.4 可扩展性需求
- 支持多租户（告趣内部 + SaaS客户）
- 模块化架构，支持按需启用功能
- 支持水平扩展（无状态服务，可部署多实例）

---

## 10. 附录

### 10.1 相关系统接口

**钉钉开放平台**
- 获取用户详情：https://open.dingtalk.com/document/isvapp-server/obtain-the-user-information-based-on-the-applicable-scenario
- 部门管理：https://open.dingtalk.com/document/isvapp-server/department
- 审批：https://open.dingtalk.com/document/isvapp-server/create-an-approval-instance

**飞书开放平台**
- 获取用户身份：https://open.feishu.cn/document/server-docs/authentication-management/login-state-management/get-user-identity
- 通讯录管理：https://open.feishu.cn/document/server-docs/historic-version/contact-v3/department/introduction
- 审批：https://open.feishu.cn/document/server-docs/approval-v4/instance/create

**法大大/e签宝（电子签署）**
- 法大大API：https://www.fadada.com/api/
- e签宝API：https://www.esign.cn/api/

### 10.2 代码仓库结构

```
gaoq-erp/
├── apps/
│   ├── erp-api/              # NestJS 后端主服务
│   │   ├── src/
│   │   │   ├── main.ts         # 入口文件
│   │   │   ├── app.module.ts   # 根模块
│   │   │   ├── modules/        # 业务模块
│   │   │   │   ├── auth/       # 认证模块
│   │   │   │   ├── user/       # 用户模块
│   │   │   │   ├── org/        # 组织模块
│   │   │   │   ├── approval/   # 审批模块
│   │   │   │   ├── payroll/    # 薪酬模块
│   │   │   │   ├── recruitment/# 招聘模块
│   │   │   │   ├── knowledge/  # 知识库模块
│   │   │   │   ├── onboarding/ # 入职模块
│   │   │   │   ├── care/       # 关怀模块
│   │   │   │   ├── mcp/        # MCP服务层
│   │   │   │   ├── security/   # 安全模块
│   │   │   │   └── common/     # 公共模块（工具、中间件、拦截器）
│   │   │   └── config/         # 配置文件
│   │   ├── test/               # 测试文件
│   │   └── Dockerfile
│   └── erp-web/              # Next.js 前端（PC管理后台）
│       ├── src/
│       ├── pages/              # 页面路由
│       ├── components/         # 公共组件
│       ├── hooks/              # 自定义Hooks
│       ├── services/           # API调用封装
│       └── Dockerfile
├── packages/
│   ├── shared-types/          # 共享TypeScript类型定义
│   ├── shared-utils/          # 共享工具函数
│   └── ui-components/         # 共享UI组件（可选）
├── docs/                       # 文档（API文档、部署文档、操作手册）
├── scripts/                    # 脚本（部署、数据迁移、备份）
├── docker-compose.yml          # 开发环境编排
├── docker-compose.prod.yml     # 生产环境编排
├── README.md                   # 项目说明
└── package.json                # 根配置（pnpm workspace）
```

### 10.3 开发规范

1. **代码注释**：所有接口、类、方法必须中文注释，复杂逻辑必须注释说明
2. **接口文档**：使用Swagger/OpenAPI自动生成，每个接口必须包含中文描述和参数说明
3. **Git提交**：使用中文提交信息，格式：`[模块] 操作：说明`，如 `[审批] 新增：支持条件分支审批`
4. **代码审查**：所有代码合并需通过CI（测试+Lint+TypeCheck）
5. **测试覆盖**：核心业务模块单元测试覆盖率 > 80%

---

> **文档结束**  
> 本PRD为告趣ERP系统（GaoQ-OS）的完整产品需求文档，涵盖了从MVP到V2.5的全部功能规划。后续开发请以此文档为基准，任何需求变更需更新本文档并记录变更历史。
