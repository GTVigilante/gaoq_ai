# GaoQ-OS 企业架构规范

## 1. 架构原则

1. 业务能力优先于技术分层，模块边界必须对应明确业务责任。
2. Web、MCP、队列和外部回调只能调用同一应用服务，禁止复制业务规则。
3. 采用模块化单体作为首发形态；跨模块通过应用接口和领域事件协作，禁止直接读写其他模块集合。
4. 外部系统必须经过防腐层，供应商字段、状态和错误不得泄漏进核心领域。
5. 多租户、安全、审计、幂等和可观测性属于底座，不得作为后期功能补做。

## 2. 领域边界

| 领域 | 权威数据与行为 | 允许依赖 | 禁止事项 |
| --- | --- | --- | --- |
| Identity | 主体、会话、OAuth客户端、凭据状态 | Tenant、Org | 保存明文密钥；决定业务权限 |
| Tenant | 租户、功能开关、密钥域、配额 | 无 | 使用客户端Header直接切换租户 |
| Org | 员工、部门、岗位、职级、合同关系 | Tenant、Identity | 让钉钉/飞书覆盖ERP主档 |
| Security | 角色、权限、数据范围、策略、审计 | Tenant、Identity、Org | 仅依赖前端隐藏字段实现权限 |
| Approval | 模板、表单、流程、实例、节点、委托 | Org、Security | 执行任意脚本；修改历史快照 |
| Recruitment | HC、职位、候选人、面试、Offer | Approval、Org、Integration | 将同一候选人与单一职位永久绑定 |
| Onboarding | 入职实例、任务、材料、签署引用 | Recruitment、Org、Knowledge | 在日志记录身份证、银行卡原文 |
| Knowledge | 文章、课程、培训、考试、学习记录 | Org、Security | 向学员接口暴露标准答案 |
| Payroll | 规则、结构、考勤快照、薪资、发放与对账 | Org、Approval、Security | 使用浮点金额；允许AI直接发薪 |
| Care | 关怀事件、离职、交接、校友关系 | Org、Approval | 无期限保留无业务目的的个人信息 |
| Integration | 外部映射、出入站事件、重试、对账 | Tenant、各领域公开接口 | 直接修改领域集合 |
| MCP | 协议、能力目录、授权、确认、调用审计 | Identity、Security、各领域应用接口 | 直接访问数据库；透传访问令牌 |

## 3. 依赖规则

```text
接入层（Web / MCP / Webhook / Job）
                ↓
应用层（用例、授权、事务、幂等）
                ↓
领域层（实体、值对象、状态机、策略）
                ↓
基础设施层（MongoDB / Redis / MQ / OSS / 外部适配器）
```

- 领域层不得依赖 NestJS、MongoDB、HTTP 或供应商 SDK。
- 应用层负责租户与权限校验、事务边界、幂等和领域事件发布。
- 适配器把 OpenAPI、MCP、Webhook 和任务输入转换成应用命令或查询。
- 跨模块一致性默认采用领域事件和最终一致性；薪酬锁定、权限变更等强一致用例通过应用编排明确处理。

## 4. 运行架构

- 生产部署在境内云 VPC，入口仅开放 WAF/API Gateway；数据库、缓存、队列、对象存储和密钥服务位于私网。
- 开发、测试、预发、生产和灾备使用不同账号、网络、密钥和数据集；禁止复制生产明文个人信息到非生产环境。
- NestJS API 与 Worker 无状态部署；长任务进入 BullMQ，任务必须具备幂等键、重试上限和死信处理。
- MongoDB 使用副本集和时间点恢复；Redis 不作为任何业务事实的唯一存储。
- 文件对象按 `tenantId/classification/year/month` 分区，使用短时签名URL和服务端权限校验。

## 5. 公共上下文

```typescript
interface TenantContext {
  tenantId: string;
  source: 'access_token' | 'service_identity';
}

interface ActorContext {
  actorType: 'user' | 'service' | 'mcp_client' | 'system_job';
  actorId: string;
  tenantId: string;
  roleCodes: string[];
  scopes: string[];
  departmentIds: string[];
  traceId: string;
}

interface Money {
  amountMinor: bigint;
  currency: 'CNY';
}
```

- `TenantContext` 必须由验证后的身份生成；请求头只能用于诊断，不得覆盖身份租户。
- `ActorContext` 必须贯穿同步调用、队列、MCP与审计，异步任务不得退化为无主体的超级权限。
- 时间存储使用 UTC 和 ISO 8601；业务规则显式携带 `Asia/Shanghai` 时区。

## 6. 架构决策记录

以下事项必须以 ADR 管理：数据存储变更、服务拆分、公开契约不兼容变更、权威数据源变更、MCP协议版本、安全控制例外、外部供应商替换及统一切换策略调整。ADR状态采用 `proposed/accepted/superseded/rejected`，接受后关联实现 Issue 和验证证据。
