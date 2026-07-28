# Phase 5：OP 完整桥接、移动端、分析与生产加固

Phase 5 在已验收的组织、审批、招聘入职、考勤薪酬底座之上，完成 OP（告趣自研业务平台）的完整桥接、移动端、管理分析、生产加固与全量迁移预验收。阶段目标与退出条件以 [Phase 0 项目章程](../phase-0/00-program-charter.md) §4 为准：性能、安全、容灾、集成和全量迁移预验收全部通过。

实现顺序：

1. [OP 每日经营摘要垂直切片契约](./00-op-operating-summary-contract.md)（代码已交付，外部联调待验收）
   - [OP 索引迁移运行手册](./01-op-index-migration-runbook.md)
2. [OP 组织与人员下发管线](./02-op-organization-delivery-contract.md)（代码已交付，OP 沙箱联调待验收）
3. [OP 身份联合](./03-op-identity-federation-contract.md)（运行时代码已交付，初始绑定迁移与实体 UAT 待验收）
4. [OP 审批桥契约](./04-op-approval-bridge-contract.md)（运行时代码、可信读取与出站连接信任边界已交付，OP 沙箱联调待验收）
   - [OP 审批桥索引迁移运行手册](./05-op-approval-index-migration-runbook.md)
5. [移动工作台契约](./06-mobile-workbench-contract.md)（H5 首页、审批待办/详情/时间线、R1 决策/转交/加签、限期委托、模板驱动发起、本人培训任务与容器安全策略已交付；真实内容/评分服务、平台容器及实体 UAT 待续）
6. [管理驾驶舱与受控分析导出契约](./07-management-dashboard-contract.md)（Web、REST、MCP 与 R2 异步导出代码已交付，生产数据与管理层 UAT 待验收）
   - [管理分析索引迁移运行手册](./08-analytics-index-migration-runbook.md)
7. [全量/增量迁移控制面契约](./09-data-migration-control-plane.md)（二十六个本地历史适配器已全部交付；REST 最小权限、提交后审计隔离、附件 Job/租约栅栏及网关上下文绑定已加固，标准 MCP 保持只读；三次真实全量演练、签署和实体 UAT 待续）
   - [数据迁移控制面索引运行手册](./10-data-migration-index-runbook.md)
   - [旧审批历史索引运行手册](./10a-approval-history-index-runbook.md)
   - [Payroll 迁移证据索引运行手册](./10b-payroll-migration-index-runbook.md)
   - [Treasury 迁移证据索引运行手册](./10c-treasury-migration-index-runbook.md)
   - [业务附件迁移索引运行手册](./10d-business-attachment-migration-index-runbook.md)
   - [数据迁移来源包运行手册](./11-data-migration-package-runbook.md)
   - [数据迁移三次演练证据门禁](./12-data-migration-rehearsal-gate.md)（工具已交付，三次真实演练待执行）
8. [生产加固与 Go/No-Go 证据](./13-production-hardening.md)（供应链、镜像、容量、DAST 及韧性门禁工具已实现，真实实测待续）
   - [生产镜像构建与验证运行手册](./14-production-images-runbook.md)
   - [性能容量三次实测门禁](./15-performance-capacity-gate.md)
   - [DAST 与 ASVS 5.0.0 证据门禁](./16-dast-asvs-gate.md)
   - [容灾恢复与外部系统断连追赶门禁](./17-resilience-rehearsal-gate.md)
   - [跨职能 Go/No-Go 证据门禁](./18-go-no-go-evidence-gate.md)
   - [MCP 完整能力目录与联调门禁](./19-mcp-capability-catalog.md)
   - [七类发布就绪 verdict 门禁](./20-readiness-verdicts.md)
9. [双语营销官网与 CMS](../marketing-cms.md)（Website、事务 Outbox、通知幂等、
   独立镜像与 Kubernetes 门禁代码已交付；正式域名、WAF、验证码、媒体、通知及
   UAT 仍待外部验收）
   - [Marketing CMS 与副作用 Outbox 索引运行手册](./10e-marketing-cms-index-runbook.md)

后续切片各自拥有独立契约文档；禁止借任何已立项切片隐式扩张范围。

OP 审批结果出站连接已固定 HTTPS origin、PUT 路径和八个签名协议 Header，
16 KiB 请求对象与 256 KiB 严格 UTF-8/JSON 响应均失败关闭；非 2xx 只按状态码
分类且不保留上游正文或 cause。49 项专项测试达到
99.13%/98.03%/100%/99.02%（语句/分支/函数/行），目标生产文件逐文件四维
90% 门禁已由 OP 审批结果门禁接入 `pnpm check`；真实 OP TLS、限流、幂等、
Secret 轮换与断连追赶仍待现场验收。

数据迁移控制面入口与附件链路的 169 项专项测试已覆盖 REST 最小静态 Scope、
应用服务动态业务域授权、提交后审计隔离、确定性 JobId、原租约 fencing、严格
HTTPS/UTF-8/JSON 回执及租户、运行、来源系统和附件反向绑定。业务附件服务进一步
固定严格迁移输入、最小持久化投影，以及归属类型/用途、checksum、状态、版本、
对象证据和可用时间组合；受损记录在更新与 Outbox 前失败关闭，available 重放
仅接受同一目标证据。九个目标生产文件合计达到
99.54%/98.24%/100%/99.50%（语句/分支/函数/行），且逐文件四维均不低于
90%；门禁已接入 `pnpm precheck` 与 `pnpm check`。标准 MCP 继续只读，不暴露
附件对象、checksum、上传员工或迁移写能力；真实附件网关、对象证据、恶意文件
扫描、断连追赶和三次迁移演练仍待现场验收。

## 强制边界

- ERP 是组织与员工的唯一主数据源；OP 永远是外部系统。即使 OP 未来作为 SaaS 对外提供，对 ERP 而言仍然只是"一个外部系统"，本阶段所有契约不因 OP 形态变化而改变。
- OP 入站一律使用独立服务身份：每 clientId 独立 HMAC-SHA256 密钥、请求时间戳窗口 ±5 分钟、`clientId + nonce/eventId` 防重放缓存 24 小时。验签通过后按唯一 clientId 绑定解析租户；禁止信任 body、header、URL 或 query 中的 tenantId。
- OP 入站原始请求一律 AES-256-GCM 加密写入 Inbox，异步处理，单请求最大 1 MiB；仅接受固定白名单指标，金额一律为安全整数分；禁止动态字段、动态排序和自定义字段查询。
- 经营摘要只用于 ERP 管理层只读展示，不得进入工资、税务、资金、会计计算链路；修订只追加新版本，禁止覆盖历史。
- MCP 只读，复用应用服务，不直接访问数据库；禁止注册经营摘要写 Tool。
- 本阶段每个业务切片必须同步交付 REST、事件、MCP 契约、Scope、审计点、数据分级、索引、SLO、验收标准与退出门禁，不得后期集中回填 MCP。
