# Phase 3：人才与学习闭环

Phase 3 以候选人到正式员工的完整证据链为主线，交付招聘、e签宝、入职、知识培训、关怀及对应 MCP 能力。实现顺序为：领域与数据契约 → 招聘主流程 → 电子签 → 入职与组织转化 → 培训考试 → 关怀与离职 → MCP 与生产验收。

当前状态：候选人、申请、HC、职位、面试/日历、Offer 审批/投递/接受证据、Recruitment MCP、eSign 验签入箱，以及 Onboarding 证据任务与建档 Saga 已实现。组织域已分离 `Person`、`Employee`、`Employment`，工号由租户年度序列生成；Onboarding MCP 已提供按部门裁剪的 R0 结构化摘要，R3 建档不向 AI 开放。eSign V3 Adapter 已覆盖流程补拉、已签 PDF 短时下载、供应商验签、证据账本和 Offer `signed` 门禁；病毒扫描与 WORM 对象归档当前为失败关闭端口，尚未绑定生产供应商。未完成真实 e签宝、招聘渠道、通知、日历、扫描和对象存储沙箱验收前，不得标记生产完成。

## 强制边界

- ERP Recruitment 是候选人、申请和 Offer 的权威源；渠道只提供原始投递及参考状态。
- `Person`、`Candidate`、`CandidateApplication`、`UserAccount`、`Employment` 分离；同一候选人可以跨职位、跨招聘周期产生多个申请。
- Onboarding 只保存招聘、签署、材料和培训引用，不直接修改 Org 集合；完成门禁后由 Org 应用接口建立 Employment 并发布主数据事件。
- e签宝、招聘渠道、短信、邮件、日历和对象存储均通过 Integration 防腐层；供应商 Token、状态和对象键不得进入领域 API。
- Web、REST、MCP、Webhook 和 Worker 复用应用服务；R1/R2 写操作沿用服务端 `prepare → confirm → execute`，R3 不注册工具。
- 候选人 L3 与合同/身份/银行卡 L4 数据使用独立密钥域、盲索引、目的限制、访问审计和到期清理。

详细契约见 [领域与集成契约](./00-domain-integration-contract.md)。
