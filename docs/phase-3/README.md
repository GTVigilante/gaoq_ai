# Phase 3：人才与学习闭环

Phase 3 以候选人到正式员工的完整证据链为主线，交付招聘、e签宝、入职、知识培训、关怀及对应 MCP 能力。实现顺序为：领域与数据契约 → 招聘主流程 → 电子签 → 入职与组织转化 → 培训考试 → 关怀与离职 → MCP 与生产验收。

当前仓库已交付候选人、申请、HC、职位、面试/日历、Offer
审批/投递/接受证据、Recruitment MCP、招聘门户、智能简历库、eSign 验签入箱，
以及 Onboarding 证据任务与建档 Saga。组织域已分离
`Person`、`Employee`、`Employment`，Onboarding MCP 只提供按部门裁剪的 R0
摘要，R3 建档不向 AI 开放。

招聘渠道已交付 Adapter/Normalizer/EvidenceVerifier、加密 Inbox、盲指纹去重、
加密游标、可靠补拉/重放及状态回传；智能简历库已交付隔离网关契约、OpenAI
严格结构化输出、受控词表、异步分析、人工确认和管理页面。真实招聘渠道、简历
扫描/对象存储/脱敏网关、OpenAI Secret 与数据保留控制及招聘 UAT 仍待现场验收。

Knowledge 已交付版本发布、绝对进度、评分摘要、必修证明、可恢复 Onboarding
回填、严格 HTTPS 证据网关和只读 MCP。Care 已交付离职审批、四类清算证据、
时区绑定、Employment/Employee/Identity 原子终止、校友授权自动到期，以及
生日/周年关怀可靠编排。校友授权终止后的下游清理证明也已交付撤回/到期统一
编排、独立目标信任域、Ed25519 不可变证明、对账/重放/重建、追加迁移、指标、
REST 和只读 MCP；运行规范见
[校友授权终止后的下游清理证明运行手册](./05-alumni-cleanup-proof-runbook.md)。

Talent Lifecycle 360 已交付 `Candidate → Person → Employment` 跨域投影、
生命周期推导、加密服务触点、授权门禁、Outbox、只读 MCP 和管理页面。eSign V3
Adapter 已覆盖流程补拉、已签 PDF 短时下载、供应商验签、证据账本及 Offer
`signed` 门禁；病毒扫描与 WORM 归档缺少成套配置时失败关闭。

真实 e签宝、招聘渠道、通知、日历、简历基础设施、Knowledge 证据网关、Care
清算/授权校验器、CRM/校友平台清理证明、生产索引、角色映射、历史回放及各业务
UAT 尚未形成现场证据，因此 Phase 3 只能标记“代码已交付”，不得标记生产完成。

Knowledge 授权全文检索代码已交付：可信任职及部门/岗位裁剪、应用服务二次授权、独立签名搜索网关、课程发布/下架事务索引任务、重试/死信、低基数新鲜度指标、追加迁移、只读对账、全量重建以及标准 MCP Tool/Resource/Prompt。真实搜索集群的中文/英文分词、撤权收敛、性能、安全与业务 UAT 仍待现场验收；代码交付不得描述为生产完成。

Knowledge 可靠考试编排代码已交付：版本化题型/时限/次数/评分与通过策略、超时自动提交、人工复核、Mongo 权威状态机、Worker 退避/死信/熔断、事务 Outbox、低基数 SLA 指标、追加索引、只读对账、显式重放和本人只读 MCP。运行规范见 [考试编排与评分运行手册](./03-knowledge-exam-orchestration-runbook.md)。真实评分沙箱、代表题集和业务 UAT 仍待现场验收。

## 强制边界

- ERP Recruitment 是候选人、申请和 Offer 的权威源；渠道只提供原始投递及参考状态。
- `Person`、`Candidate`、`CandidateApplication`、`UserAccount`、`Employment` 分离；同一候选人可以跨职位、跨招聘周期产生多个申请。
- Onboarding 只保存招聘、签署、材料和培训引用，不直接修改 Org 集合；完成门禁后由 Org 应用接口建立 Employment 并发布主数据事件。
- e签宝、招聘渠道、短信、邮件、日历和对象存储均通过 Integration 防腐层；供应商 Token、状态和对象键不得进入领域 API。
- Web、REST、MCP、Webhook 和 Worker 复用应用服务；R1/R2 写操作沿用服务端 `prepare → confirm → execute`，R3 不注册工具。
- 候选人 L3 与合同/身份/银行卡 L4 数据使用独立密钥域、盲索引、目的限制、访问审计和到期清理。

详细契约见 [领域与集成契约](./00-domain-integration-contract.md)。
