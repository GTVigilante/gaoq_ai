# Phase 5：OP 完整桥接、移动端、分析与生产加固

Phase 5 在已验收的组织、审批、招聘入职、考勤薪酬底座之上，完成 OP（告趣自研业务平台）的完整桥接、移动端、管理分析、生产加固与全量迁移预验收。阶段目标与退出条件以 [Phase 0 项目章程](../phase-0/00-program-charter.md) §4 为准：性能、安全、容灾、集成和全量迁移预验收全部通过。

实现顺序：

1. [OP 每日经营摘要垂直切片契约](./00-op-operating-summary-contract.md)（代码已交付，外部联调待验收）
   - [OP 索引迁移运行手册](./01-op-index-migration-runbook.md)
2. [OP 组织与人员下发管线](./02-op-organization-delivery-contract.md)（代码已交付，OP 沙箱联调待验收）
3. [OP 身份联合](./03-op-identity-federation-contract.md)（运行时代码已交付，初始绑定迁移与实体 UAT 待验收）
4. [OP 审批桥契约](./04-op-approval-bridge-contract.md)（运行时代码已交付，OP 沙箱联调待验收）
   - [OP 审批桥索引迁移运行手册](./05-op-approval-index-migration-runbook.md)
5. [移动工作台契约](./06-mobile-workbench-contract.md)（H5 首页与审批待办首切片已交付，决策/知识/小程序容器待续）
6. 管理驾驶舱与受控分析导出（待立项契约文档）
7. 全量迁移工具与生产加固（断连演练、性能、容灾、切换预验收，待立项契约文档）

后续切片各自拥有独立契约文档；禁止借任何已立项切片隐式扩张范围。

## 强制边界

- ERP 是组织与员工的唯一主数据源；OP 永远是外部系统。即使 OP 未来作为 SaaS 对外提供，对 ERP 而言仍然只是"一个外部系统"，本阶段所有契约不因 OP 形态变化而改变。
- OP 入站一律使用独立服务身份：每 clientId 独立 HMAC-SHA256 密钥、请求时间戳窗口 ±5 分钟、`clientId + nonce/eventId` 防重放缓存 24 小时。验签通过后按唯一 clientId 绑定解析租户；禁止信任 body、header、URL 或 query 中的 tenantId。
- OP 入站原始请求一律 AES-256-GCM 加密写入 Inbox，异步处理，单请求最大 1 MiB；仅接受固定白名单指标，金额一律为安全整数分；禁止动态字段、动态排序和自定义字段查询。
- 经营摘要只用于 ERP 管理层只读展示，不得进入工资、税务、资金、会计计算链路；修订只追加新版本，禁止覆盖历史。
- MCP 只读，复用应用服务，不直接访问数据库；禁止注册经营摘要写 Tool。
- 本阶段每个业务切片必须同步交付 REST、事件、MCP 契约、Scope、审计点、数据分级、索引、SLO、验收标准与退出门禁，不得后期集中回填 MCP。
