# Phase 3：人才与学习闭环

Phase 3 以候选人到正式员工的完整证据链为主线，交付招聘、e签宝、入职、知识培训、关怀及对应 MCP 能力。实现顺序为：领域与数据契约 → 招聘主流程 → 电子签 → 入职与组织转化 → 培训考试 → 关怀与离职 → MCP 与生产验收。

当前状态：候选人、申请、HC、职位、面试/日历、Offer 审批/投递/接受证据、Recruitment MCP、招聘门户、智能简历库、eSign 验签入箱，以及 Onboarding 证据任务与建档 Saga 已实现。招聘门户已提供 ERP 开放职位最小投影、独立 BFF 服务身份和联系人投递；简历原件上传仍待病毒扫描与对象存储网关交付。智能简历库已提供隔离网关脱敏读取契约、OpenAI 严格结构化输出、受控职业词表、BullMQ 异步分析、人工标签确认、确认标签检索及 `/workspace/recruitment` 管理页面；真实隔离网关、OpenAI Secret/数据保留控制、代表性简历评测与招聘 UAT 未配置时失败关闭。Talent Lifecycle 360 已提供 `Candidate → Person → Employment` 跨域只读投影、招聘到校友的阶段推导、加密服务触点、授权门禁、Outbox、只读 MCP 及 `/workspace/talent-lifecycle` 管理页面；生产索引执行、角色映射、历史数据回放和业务 UAT 仍待现场验收。招聘渠道已交付 Adapter/Normalizer/EvidenceVerifier 三件套契约、加密 Inbox、盲指纹去重、加密游标、外部映射、BullMQ 补拉/显式重放、受信任证据贯穿、职位发布/下架及申请阶段顺序回传；具体渠道实现未登记时失败关闭。组织域已分离 `Person`、`Employee`、`Employment`，工号由租户年度序列生成；Onboarding MCP 已提供按部门裁剪的 R0 结构化摘要，R3 建档不向 AI 开放。Knowledge 已实现课程版本发布校验、绝对进度源事件、服务端评分摘要、必修培训聚合证明及可恢复 Onboarding 回填；MCP 只读课程和任务脱敏投影，不开放评分、完成或证明写入。Care 已实现审批、四类清算证据、业务日期与租户时区绑定、BullMQ 定时执行、Employment/Employee/Identity 原子终止和可恢复 Saga；校友授权创建后使用稳定延迟任务自动到期，Worker 仅持有到期 Scope，发布脱敏到期事件且不向 REST/MCP 开放执行能力；非离职状态也会在同一事务同步 Employee 与当前 Employment。MCP 只返回脱敏进度且不开放写入。生日/周年关怀与校友下游数据删除证明仍未交付；内容校验器、评分器、Care 清算证据校验器与校友授权校验器的生产适配器当前均失败关闭。eSign V3 Adapter 已覆盖流程补拉、已签 PDF 短时下载、供应商验签、证据账本和 Offer `signed` 门禁；病毒扫描与 WORM 对象归档已接入严格 HTTPS Adapter，缺失成套配置时失败关闭，真实服务验收见 [证据基础设施运行手册](./02-esign-evidence-infrastructure-runbook.md)。未完成真实 e签宝、招聘渠道、通知、日历、简历扫描/对象存储与脱敏、OpenAI 数据控制、内容校验、评分、Care 清算证据、校友授权服务和人才全周期 UAT 前，不得标记生产完成。

## 强制边界

- ERP Recruitment 是候选人、申请和 Offer 的权威源；渠道只提供原始投递及参考状态。
- `Person`、`Candidate`、`CandidateApplication`、`UserAccount`、`Employment` 分离；同一候选人可以跨职位、跨招聘周期产生多个申请。
- Onboarding 只保存招聘、签署、材料和培训引用，不直接修改 Org 集合；完成门禁后由 Org 应用接口建立 Employment 并发布主数据事件。
- e签宝、招聘渠道、短信、邮件、日历和对象存储均通过 Integration 防腐层；供应商 Token、状态和对象键不得进入领域 API。
- Web、REST、MCP、Webhook 和 Worker 复用应用服务；R1/R2 写操作沿用服务端 `prepare → confirm → execute`，R3 不注册工具。
- 候选人 L3 与合同/身份/银行卡 L4 数据使用独立密钥域、盲索引、目的限制、访问审计和到期清理。

详细契约见 [领域与集成契约](./00-domain-integration-contract.md)。
