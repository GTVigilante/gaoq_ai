# GaoQ-OS 企业威胁模型

- 文档编号：phase-0/09
- 方法：STRIDE + 业务滥用场景
- 状态：仓库控制基线；目标环境、供应商和人员流程仍须现场复核
- 负责人：安全负责人维护，首席架构师/数据/业务/SRE 共同评审

## 1. 范围与安全目标

范围覆盖 Browser/Web、ERP API、Worker、MongoDB、Redis/BullMQ、对象/WORM、
钉钉、飞书、OP、e签、招聘、通知、搜索/评分、银行、税务、独立专业算薪、
MCP 客户端及 GitHub→Kubernetes 发布链。

安全目标：

1. 租户、主体、角色、数据范围和字段范围不可由客户端、AI、Webhook 正文或
   外部平台自报。
2. ERP 是人员/组织唯一权威源；专业算薪是工资唯一生产事实源。
3. L3/L4 原文、Token、Secret、签署私钥和银行/税务文件不进入日志、事件、MCP、
   通用幂等响应或 GitHub 证据。
4. 外部副作用结果未知时不自动重放；已提交终态后的审计故障不反向改写业务结果。
5. 审计 HMAC 链只声明可检测篡改；完整不可抵赖依赖独立权限域 WORM 锚定和
   Ed25519 回执。

## 2. 关键资产

| 资产 | 分级 | 主要风险 |
|---|---|---|
| 身份映射、会话、OAuth/MCP Token 与 WebAuthn 凭据 | L3/L4 安全材料 | 账号接管、租户冒用、重放 |
| 员工/组织/雇佣主数据 | L2/L3 | 权威污染、越权路由、离职权限残留 |
| 候选人、简历、合同、入职材料、校友联系方式 | L3/L4 | 隐私泄漏、用途扩张、过期继续处理 |
| 考勤、工资、银行账户、税务与回盘 | L3/L4 | 金额篡改、批量泄漏、重复支付 |
| 审批状态、职责分离和确认账本 | L2–L4 | 越权终态、重放、否认 |
| Outbox/Inbox/队列、事件和迁移包 | 原数据分级 | 跨租户、乱序、重复、毒化负载 |
| 审计链、WORM、发布/切换证据与签署 keyset | L2/L4 元数据 | 伪证、签后篡改、职责伪装 |
| MCP 目录、Prompt、Tool Schema 和 Resource | L2/L3 控制面 | 提示注入、工具越权、数据外带 |

## 3. 信任边界

| 边界 | 不可信侧 | 可信建立方式 | 失败策略 |
|---|---|---|---|
| TB-01 Browser/API | Cookie、Header、Body、Query、Origin | 服务端会话/Bearer 验签、CSRF/Origin、DTO 白名单 | 401/403 或稳定 4xx，默认拒绝 |
| TB-02 外部 IdP | 授权码、Profile、外部组织/角色 | 一次性 state + PKCE、固定域名、租户绑定、双标识映射 | 映射缺失/漂移即拒绝 |
| TB-03 MCP Client | JSON-RPC、Tool 参数、Prompt 内容 | OAuth Resource/Scope、逐消息复验、运行时 Schema、确认链 | 关闭 transport 或稳定 Tool Error |
| TB-04 API/数据层 | 动态字段、排序、过滤、租户条件 | 可信 TenantContext、Repository 绑定、字段白名单、事务 | 数据调用前失败关闭 |
| TB-05 API/Worker/Queue | Job、事件、租约、重试 | 最小 Job 引用、严格事件 Schema、处理 Token/JobId/attempt | 旧租约不可提交，未知结果人工复核 |
| TB-06 外部供应商 | Webhook、HTTP 回执、附件、状态 | 固定 HTTPS origin/path/method/header、验签、大小/UTF-8/Schema | 不信正文，失败稳定分类 |
| TB-07 专业算薪 | Resource、事件、工资投影 | 独立 OAuth、共享契约包、主体/租户/事件严格绑定 | ERP 旧生产路径失败关闭 |
| TB-08 GitHub/目标集群 | workflow 输入、证据、Kubernetes 凭据 | Hosted Runner claims、专用 OIDC、短时 ExecCredential、双人签名 | Runner/身份/证据任一缺失即 No-Go |
| TB-09 WORM/证据域 | 存储回执、签名、公钥集 | 内容摘要、对象键、保留期、Ed25519、受信 keyset | 不推进业务/发布终态 |

## 4. STRIDE 威胁登记

| ID | 类别 | 场景 | 影响 | 仓库控制 | 外部残余风险/验收 |
|---|---|---|---|---|---|
| TM-001 | Spoofing | 客户端自报 tenantId/employeeId 代查他人数据 | 跨租户/L4 泄漏 | 可信身份上下文、反向主体映射、Repository 租户绑定、负向测试 | 真实角色/租户矩阵 UAT |
| TM-002 | Spoofing | 外部账号按手机号/邮箱自动合并 | 账号接管 | tenant + unionId + userId 双标识；冲突人工仲裁 | 钉钉/飞书真实租户冲突演练 |
| TM-003 | Spoofing | 伪造 OAuth client、assertion 或 MCP Token | AI/服务越权 | Basic/私钥断言主体、audience/resource、jti Redis 防重放、逐消息复验 | 正式授权服务器、轮换和撤销 |
| TM-004 | Spoofing | 伪造 Webhook appId/tenantId | 跨租户状态推进 | raw bytes 验签后按唯一 appId 解析租户；Body/Header 租户无效 | 真实供应商密钥轮换和重放 |
| TM-005 | Tampering | Mongo/SQL 动态操作符、排序或字段注入 | 越权读取/写入 | DTO 严格字段集、白名单映射、拒绝 Mongo 操作符/原型键 | DAST/ASVS 与模糊测试 |
| TM-006 | Tampering | 事件类型/负载/信封被篡改或版本漂移 | 错误业务终态 | CloudEvents 严格信封、逐 type schema、事务 Outbox、摘要/版本绑定 | 真实事件总线回放与兼容窗口 |
| TM-007 | Tampering | 银行、税务、eSign、WORM 回执错位 | 重复支付/伪证 | 请求控制量、原始字节摘要、签名、对象键、保留期逐字段反向绑定 | 真实证书、公钥轮换和恶意样本 |
| TM-008 | Tampering | 发布证据签后修改、角色换钥或复用公钥 | 未批准上线 | 多角色独立 Ed25519、keyId/SPKI、keyset 摘要、完整 payload 签名 | 企业 IAM/KMS/HSM 与 WORM |
| TM-009 | Repudiation | 高风险操作者否认审批/发薪/发布 | 争议无法追责 | R2 WebAuthn、职责分离、审计 HMAC 链、外部 WORM 锚点 | 真实人员身份、设备、独立证据域 |
| TM-010 | Repudiation | 审计成功写入失败被误报业务失败 | 重复外部副作用 | 区分业务失败/提交后审计故障；终态不回写、不自动重放 | 告警与现场故障演练 |
| TM-011 | Information Disclosure | 日志/错误/指标泄漏 Token、工资、合同或 PII | 大规模敏感泄漏 | 稳定错误码、最小日志、指标标签收敛、敏感键扫描 | 日志平台权限/保留和人工抽检 |
| TM-012 | Information Disclosure | MCP Resource/Prompt/Tool 绕过字段权限或批量导出 | AI 数据外带 | 应用服务复用、结构输出校验、Resource URI 白名单、R2 导出、R3 禁止 | 各客户端正式 Token 与提示注入测试 |
| TM-013 | Information Disclosure | 外部 URL/redirect/header 被业务输入控制 | SSRF/凭据外泄 | 固定 HTTPS origin/443/path/method/header，禁重定向，流式限长 | 目标网络 egress/WAF 验收 |
| TM-014 | Information Disclosure | 招聘/通知/日历 Job 或事件携带原文 | 长期扩散 | Job 只含引用，联系方式仅短时内存，L3/L4 加密草稿/Inbox | 真实队列、DLQ 和日志抽检 |
| TM-015 | Denial of Service | 超大 JSON/文件/响应、压缩炸弹、无界分页 | 内存/Worker 耗尽 | 请求/响应字节上限、fatal UTF-8、页数/对象/深度上限、扫描网关 | 容量、恶意文件和限流实测 |
| TM-016 | Denial of Service | Redis/Mongo/供应商断连导致无限重试 | 队列堆积/重复副作用 | 有界退避、租约、dead/manual_review、断路与告警，结果未知不重放 | 两小时断连、RPO/RTO/追赶演练 |
| TM-017 | Elevation of Privilege | OP/IdP/AI 提供审批人、角色或部门路由 | 绕过职责分离 | ERP 当前组织/授权重新解析，不信外部路由；审批快照不可变 | 真实组织角色矩阵 |
| TM-018 | Elevation of Privilege | MCP/用户执行发薪、超级权限、物理删审计 | 灾难性业务/合规影响 | R3 不注册 Tool，REST/应用服务永久拒绝，生产授权独立 | 红队和运维权限复核 |
| TM-019 | Elevation of Privilege | Worker 为复用 Provider 引入 HTTP/OAuth 全模块 | 扩大后台攻击面 | Worker 最小模块和服务身份；无浏览器/公共协议入口 | 镜像/SBOM/运行权限验证 |
| TM-020 | Elevation of Privilege | 旧 ERP 工资旁路恢复为生产 | 双主和资金越权 | `PAYROLL_SYSTEM_MODE=external` 应用层失败关闭；ADR-0004 | 专业算薪联调与配置/部署证据 |

## 5. 业务滥用场景

### 5.1 审批与确认

- 用户重复、并发、弱网重放或改摘要：强 `If-Match`、幂等键、不可变命令摘要、
  一次性确认凭据和终态重放返回同一结果。
- 审批人、部门、角色由客户端/OP/AI 指定：全部拒绝，由 ERP 当前主数据解析并
  冻结快照。
- 已完成副作用后审计故障：只告警，不释放确认、不再次执行。

### 5.2 招聘、eSign 与个人数据

- 伪造同意、过期后继续搜索/联系：授权目的、到期、保留期和 WORM 证据共同校验。
- eSign 创建超时后自动重试：结果未知进入 `manual_review`；只有供应商明确证明
  `not_committed` 才可批准重新外呼。
- 简历/附件携带恶意文件或 URL：只接受不可解释引用，经扫描/WORM 后使用短时 URL。

### 5.3 工资、资金与税务

- 通过客户端 employeeId 代查薪资：只从可信用户主体映射本人；跨 Resource Token
  拒绝。
- 修改锁定工资或原批次重发：只允许追加版本/子批次，原终态不可变。
- 银行部分成功/未知行自动重发：冻结并人工复核，逐行金额/引用对账。
- 伪造年度汇算结论/办理链接：官方网关原始回执 Ed25519 验签，URL 固定同源且
  只短时返回本人。

### 5.4 MCP 与生成式 AI

- Prompt injection 要求忽略权限或访问数据库：Tool 只接受严格 Schema 并调用
  应用服务，Prompt 不具备授权事实。
- 模型尝试 R3 或绕过确认：目录没有相应 Tool，服务端再次拒绝。
- AI 输出含脚本、原型键、未知字段或超大 JSON：本地 Schema、深度/节点/字节
  上限和危险标记扫描失败关闭。

### 5.5 供应链与发布

- PR 绕过 CR/Issue/验证：GitHub 治理门禁检查 Milestone、关联 Issue、CR 和证据。
- 恶意依赖/镜像：锁文件、SCA、SBOM、Secret/SAST、容器和 Kubernetes 门禁。
- 用 NAS/self-hosted/长期 kubeconfig 绕过发布：工作流语义门禁拒绝，生产只接受
  GitHub Hosted OIDC 和受信签名证据。

## 6. 风险处置与退出条件

| 等级 | 定义 | 处置 |
|---|---|---|
| Critical | 可直接跨租户、发薪、泄漏 L4、伪造发布或不可恢复破坏 | 阻断合并/上线；修复并完成安全负责人复核 |
| High | 可绕过关键授权、证据、加密或造成大范围业务错误 | 阻断上线；需要负向回归与同类全仓排查 |
| Medium | 有界可恢复影响，需特定前提 | 修复或由架构+安全以 ADR 批准限期例外 |
| Low | 不触及敏感数据/核心终态的有限影响 | 进入 Backlog，明确期限和监控 |

Phase 0 退出需要架构、安全和业务对本模型签署；Phase 5 需要 DAST/ASVS、实体
身份、外部沙箱、断连/恢复和隐私登记证明；Phase 6 需要真实发布、回滚、切换和
Hypercare 证据。当前仓库只证明控制实现与失败关闭校验器存在，以上现场条件均
未完成。

## 7. 维护触发器

出现新外部供应商、新数据活动、MCP 协议升级、公开接口不兼容、服务拆分、事实源
变更、跨境处理、新 R2/R3 操作、生产身份/网络变化或重大安全事件时，必须在同一
变更中更新本模型、数据处理登记册、适配器映射、ADR、测试与对应 Issue。

