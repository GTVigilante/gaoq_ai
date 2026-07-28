# 告趣ERP（GaoQ-OS）外部系统集成规范

- 文档编号：phase-0/03
- 版本：v1.0
- 状态：规范约定，**不代表任何已完成实现**
- 适用范围：告趣ERP 与全部外部系统（钉钉、飞书、OP、e签宝、招聘渠道、银行、税务、短信、邮件）之间的集成设计、开发与验收

---

## 0. 前置决策（已冻结，本文不再讨论）

| 编号 | 决策 | 对本规范的影响 |
|------|------|----------------|
| D1 | ERP 是员工/组织的**唯一主数据源** | 组织与人员数据只准 ERP→外部系统单向下发，禁止反向回写 ERP 主档 |
| D2 | 多租户在 Phase 0 **强制** | 所有集成数据模型、事件信封、外部映射必须带 `tenantId` |
| D3 | 钉钉和飞书首期**同时正式接入** | 两个渠道均为一级适配器，不允许"先做钉钉、飞书后补"的实现路径 |
| D4 | 部署在中国境内云私有 VPC | 所有出站调用走 VPC NAT/专线；webhook 入口经网关白名单 + 签名校验 |
| D5 | e签宝首发，法大大作为后续适配器 | 电子签抽象按适配器模式设计，首发只实现 e签宝适配器 |
| D6 | 薪酬首发：银行代发文件 + 回盘 + 税务申报文件 + 自动对账 | 不做银企直连 API，首期以文件交换为准 |
| D7 | 统一大切换 | 不做分域生产切换；切换前允许旧系统为事实源的影子验证，切换窗口内旧系统只读 |
| D8 | MCP 仅采用当前稳定标准 | 集成层不依赖 MCP 实验性特性；AI 相关写操作走风险分级确认（见 §11） |

---

## 1. 总体原则与统一防腐层（ACL）

### 1.1 集成架构

```
外部系统                防腐层（integration-module）              ERP 内部
┌──────────┐   适配器    ┌──────────────────────────┐   规范模型   ┌────────────┐
│ 钉钉      │ ◄──────►  │ dingtalk-adapter          │ ◄────────► │            │
│ 飞书      │ ◄──────►  │ feishu-adapter            │ ◄────────► │ org-module │
│ OP       │ ◄──────►  │ op-adapter                │ ◄────────► │ auth-module│
│ e签宝    │ ◄──────►  │ esign-adapter（法大大预留） │ ◄────────► │ approval-  │
│ 招聘渠道  │ ◄──────►  │ recruitment-adapter × N   │ ◄────────► │ module 等  │
│ 银行/税务 │ ◄──────►  │ bank-file / tax-file 适配器│ ◄────────► │            │
│ 短信/邮件 │ ◄──────►  │ notify-adapter × N        │ ◄────────► │            │
└──────────┘            └──────────────────────────┘            └────────────┘
                                   │
                          事件总线（CloudEvents + outbox/inbox）
```

### 1.2 硬性规则

1. **任何外部系统的 SDK、API 报文结构、字段命名不得泄漏到防腐层之外。** 业务模块只感知 canonical model（规范模型）。
2. 每个外部系统一个适配器，适配器职责仅限：协议转换、签名/鉴权、字段映射、限流与重试的执行。业务判断（如"该员工是否可下发"）在业务模块完成。
3. 适配器之间禁止互相调用；跨系统流程（如"入离职触发多系统同步"）由编排服务（sync-orchestrator）组合。
4. 所有出站写入、入站事件必须先落库（outbox/inbox），再走网络，保证可重放、可对账。
5. 每个外连客户端必须在类型和运行时同时固定 HTTPS origin、端口、方法、路径及
   协议 Header 白名单；禁止业务输入、数据库正文或 AI/MCP 参数选择 URL、覆盖
   Host/Accept/传输编码或增加协议外 Header。
6. 请求与响应必须按业务最小必要值分别设置字节硬上限；响应在无
   Content-Length 时仍须流式限长并严格解码 UTF-8。非 2xx 只按状态码和受控
   provider code 分类，禁止把上游正文、cause、签名、凭据或 Token 写入错误、
   日志、审计、指标、REST 或 MCP。

### 1.3 Canonical Model（规范模型）最小集

| 模型 | 关键字段 | 权威方 |
|------|----------|--------|
| `CanonicalEmployee` | employeeId、tenantId、工号、姓名、手机号、邮箱、部门、岗位、状态（在职/试用/离职）、入离职日期 | ERP |
| `CanonicalOrgUnit` | orgUnitId、tenantId、名称、父级、负责人 employeeId、排序 | ERP |
| `CanonicalIdentity` | identityId、employeeId、provider（dingtalk/feishu/op/local）、外部账号ID、绑定状态 | ERP（auth-module） |
| `CanonicalApproval` | approvalId、tenantId、模板编码、发起人、当前节点、状态机状态、表单快照 | ERP |
| `CanonicalAttendance` | employeeId、日期、打卡记录、排班、请假/加班关联审批号 | 钉钉/飞书原始打卡为源，ERP 归集后为内部权威 |
| `CanonicalESignFlow` | flowId、tenantId、合同文件、签署方、状态（见 §6 状态机）、完成文件地址 | ERP 发起，e签宝回传状态 |
| `CanonicalCandidate` | candidateId、tenantId、渠道来源、职位、简历快照、阶段 | ERP（渠道仅投递来源） |
| `CanonicalPayslipFile` | tenantId、批次号、代发文件/回盘文件/税务文件摘要、对账状态 | ERP（薪酬模块） |

字段级映射表按适配器分别维护在 `integration-module/adapters/<name>/mapping.md`（实现期产出），新增字段必须走 ADR。

---

## 2. 数据权威方向总表与失败处置

| 数据域 | 权威方 | 流向 | 失败处置 |
|--------|--------|------|----------|
| 员工主档 | ERP | ERP→钉钉/飞书/OP | 下发失败重试至死信，HR 告警人工处理；**禁止**以钉钉/飞书数据覆盖 ERP |
| 组织架构 | ERP | ERP→钉钉/飞书/OP | 同上；父子结构校验失败整批拒绝，防止半截组织树 |
| 身份/SSO | ERP 绑定关系为准 | 双向协商：外部 IdP 认证，ERP 裁决授权 | 映射缺失 → 拒绝登录并引导绑定；禁止自动合并账号 |
| 考勤原始打卡 | 钉钉/飞书 | 钉钉/飞书→ERP | 拉取缺口按小时补拉；超 24h 缺口告警 HR |
| 审批 | ERP | ERP 内部闭环；结果摘要可推送钉钉/飞书消息 | 推送失败不影响审批状态机，仅重试消息 |
| 电子签状态 | e签宝（流程进行中）/ ERP（归档后） | ERP→e签宝发起；e签宝→ERP 回传 | webhook 丢失按 §6.4 定时拉单兜底 |
| 招聘简历 | 渠道（原始件）/ ERP（流程状态） | 渠道→ERP | 重复简历按指纹去重；拉取失败告警，不阻塞已有流程 |
| 薪酬代发 | ERP | ERP→银行（文件），银行→ERP（回盘） | 回盘不匹配 → 冻结该批次，人工介入，禁止自动重发 |
| 税务申报 | ERP | ERP→税务（文件） | 申报文件校验失败阻断导出，重算后重新生成 |
| 通知（短信/邮件） | ERP | ERP→服务商 | 失败降级备用通道（邮件↔短信不互替，仅同通道换服务商） |

**通则**：任何外部系统都不是 ERP 主档的写方。反向数据只能以"事件/原始件"形式进入 inbox，经校验后由 ERP 业务模块裁决是否采纳。

---

## 3. ERP → 钉钉 / 飞书

钉钉与飞书首期同时接入，两个适配器实现同一组接口（`OrgPushAdapter`、`SsoAdapter`、`AttendancePullAdapter`、`MessageAdapter`、`CalendarAdapter`），差异仅允许存在于适配器内部。

### 3.1 组织与人员下发（ERP→钉钉/飞书）

- 触发源：org-module 的员工/部门变更事件（outbox）。
- 下发顺序：先部门树、后人员，保证父级存在；离职先做停用（禁登录），T+30 天后再删除外部账号。
- 幂等键：`tenantId + employeeId + version`。ERP 每主档行维护单调递增 `version`，适配器拒绝执行低于已记录版本的事件（防乱序）。
- 冲突策略：外部侧已存在同手机号或邮箱账号时，禁止自动合并或覆盖；必须进入人工仲裁，完成独立身份核验后才能建立 external mapping。
- 全量校准：每日凌晨对钉钉/飞书各跑一次全量 diff（ERP 为基准），差异自动生成修复任务，差异率 >1% 告警。

#### 3.1.1 员工首次开户私密资料通道

- 联系方式禁止进入组织 Outbox、通用幂等响应、日志、审计 metadata 和 MCP 参数；只允许通过 `POST /api/integrations/org-provisioning-requests` 提交。
- 端点为 R3，必须由 `actorType=user` 且具有 `erp:integration:org_provisioning:write` 的已验证人员发起；即使 MCP 服务主体持有同名 scope 也永久拒绝，且不注册 MCP Tool。
- API 在请求内完成严格 DTO 校验和平台前置校验，使用 AES-256-GCM 加密；AAD 固定绑定 `tenantId/requestId/employeeId/channel`，幂等比较使用独立 HKDF 子密钥生成的 HMAC-SHA-256，禁止保存可字典攻击的明文 SHA-256。
- 主密钥环只从 Secret Manager 注入的 `GAOQ_ORG_PROVISIONING_ENCRYPTION_KEYS` 解析，格式为 `activeKeyId + 1..5 keys`，密钥状态仅允许 `active/decrypt_only`；每次只允许一枚 active，旧密钥至少保留至对应请求整记录 TTL 结束。
- 密文有效期 15 分钟；成功、业务冲突、重试耗尽或到期时立即将 IV/密文/AuthTag 置空，最小状态记录 30 天后 TTL 清理。
- Worker 最多 6 次带抖动退避；只在内存中解密，平台调用后尽力断开明文引用。外部 userId 使用平台租户+员工+渠道的确定性标识，创建后固定回读 userId、unionId 与工号，以恢复“外部成功、本地未提交”。
- 平台回读必须与 ERP 工号完全一致；缺少字段或任一冲突均失败关闭。最小权限 AccessProfile、ExternalIdentity 和开户终态必须在同一 Mongo 事务中提交。
- Worker 从 Mongo 认领后必须再次校验租户、请求 ULID、员工、渠道、幂等键、密钥
  标识、尝试次数和敏感资料有效期；损坏任务进入终态隔离，禁止触达身份仓储、密钥
  或平台。平台回读的 userId 必须等于 ERP 派生的确定性标识，外部租户、userId 和
  unionId 均须符合身份仓储白名单。
- Mongo 事务已提交后的会话清理或成功审计故障，以及失败终态已提交后的审计故障，
  必须单独归类并向 Worker 告警；通用失败处理不得重复调用平台、改写成功终态或
  二次更新失败终态。

### 3.2 SSO 身份映射

- 登录流程：钉钉/飞书/OP Authorization Code + PKCE → 消费一次性 state → 校验
  state、适配器、平台租户和 ERP 租户绑定 → 同时使用外部 tenantId、unionId 与
  userId 查 `CanonicalIdentity` 映射 → 命中后才可生成 ERP 可信主体；未命中一律
  拒绝并进入独立人工绑定流程。
- 外部平台 Token 只能在固定域名适配器内部短暂使用，不得进入仓储、日志、JWT、
  MCP 或业务服务；上游重定向、任意 URL、query、非标准端口和超限响应均失败关闭。
- 租户绑定、外部身份映射与授权快照从数据库读取后必须按运行时契约二次验证，
  并转换为最小、深冻结的普通对象；受损记录、查询越界、平台/租户漂移不得降级。
- 一个外部账号只能映射一个 ERP 员工；一个员工可绑定多个 provider。
- 离职员工映射立即失效（联动 §3.1 停用事件），不等待外部账号删除。
- 禁止事项：不允许以手机号或邮箱自动合并已有账号；不允许外部 IdP 回传字段
  （如外部侧部门、角色）覆盖 ERP 主档；AI/MCP 不得建立、修改或绕过人员身份映射。

### 3.3 考勤入站（钉钉/飞书→ERP）

- 双通道：webhook 实时事件（打卡、请假审批结果）+ 定时全量拉取（每小时增量、每日全量校准）。
- 原始打卡记录**不可修改**地写入 inbox 原始层；ERP 归集层（排班、异常判定、请假关联）在其上加工，归集结果为 ERP 内部权威。
- 补拉机制：以"水位线"（lastSyncedAt）推进，发现缺口自动补拉；同一时段重复数据按外部记录 ID 幂等去重。

### 3.4 消息与日历（ERP→钉钉/飞书）

- 消息：审批待办、薪酬单发放通知、培训任务、公告，经 notify 编排统一走模板；模板按渠道各维护一份，渠道差异（卡片格式）封闭在适配器内。
- 日历：入职日程、培训日程、审批截止提醒，ERP 为日历事件源；外部侧修改不回写。
- 每个业务日历必须有独立、可停用的目标日历绑定；出站任务创建时固化外部日历 ID，禁止在重试时重新解释“默认日历”，避免配置切换后误改其他日历。
- 日历位置和参与人为最小必要下发数据，只允许专用 Integration Worker 在受信服务身份与最小 Scope 下读取；Outbox、投递轨迹、日志和告警不得保存这些字段。
- 创建类接口必须使用平台原生幂等键；外部成功但本地提交失败时，重试必须恢复同一事件而非重复创建。取消已不存在事件按幂等成功处理，权限错误不得伪装为不存在。
- 限流：遵守各渠道 QPS 上限，出站统一走令牌桶；触发限流时降级为批量聚合发送（如合并同一人的多条提醒）。

---

## 4. OP 系统（告趣自研业务平台）

| 集成点 | 方向 | 说明 |
|--------|------|------|
| 身份 | 协商 | OP 账号与 ERP 员工通过 `CanonicalIdentity(provider=op)` 绑定；OP 侧角色仅业务角色，组织权限以 ERP 为准 |
| 组织 | ERP→OP | 与钉钉/飞书同一下发管线，OP 为下游消费方 |
| 审批 | 双向 | OP 业务单据可在 ERP 审批模块发起审批（经 API 创建 `CanonicalApproval`）；审批结果回推 OP；ERP 内部审批不回传 OP |
| 经营摘要 | OP→ERP | OP 每日推送经营指标摘要（GMV、单量等业务指标），仅作 ERP 管理层看板展示，**只读**，不参与 ERP 计算 |

- OP 接入走独立服务账号 + 签名（§10），不共用钉钉/飞书凭据。
- OP 入站可提供业务单据和 ERP 发起员工映射，不得提供或覆盖审批人、审批部门、
  角色或路由结果。ERP 必须按当前组织主数据、在职状态、授权快照和已发布模板
  重新解析审批主体；外部值与 ERP 结果不一致时失败关闭。
- OP 作为未来 SaaS 对外提供时，本规范不变：OP 对 ERP 而言始终是"一个外部系统"。

---

## 5. 招聘渠道

- 适配器按渠道一个一实现（具体渠道清单以招聘模块需求为准，实现期逐项登记）。
- 入站：简历投递 → 原始件入 inbox → 指纹去重（姓名+手机号+邮箱归一化哈希）→ 建 `CanonicalCandidate`，记录 `sourceChannel`。
- 出站：职位发布、职位下架、候选人阶段回执（如渠道支持）。
- 渠道回传的候选人状态变更只作为事件参考，ERP 招聘状态机（PRD §4.6.3）为唯一权威。
- 简历附件经病毒扫描后入对象存储；访问走短期签名 URL。
- 职位发布/下架与阶段回传 Worker 只能认领 `pending`。过期 `processing`、
  未分类传输异常及渠道已响应后的本地终态故障均代表外部结果未知，必须进入
  `manual_review`；只有 Adapter 以稳定错误码显式声明 `not_committed` 才允许
  自动退避重试。
- 人工处置必须使用可信租户、幂等键和 R2 审计；结果未知任务只有在
  `approved_exception` 且供应商确认未提交时才能重新入队，禁止直接伪造成功。
  标准 MCP 不注册渠道凭据、补拉、人工核验、重试或重放 Tool。

---

## 6. 电子签（e签宝首发，法大大预留）

### 6.1 适配器抽象

`ESignAdapter` 接口：`createFlow / getFlow / signUrl / listSignedFiles /
downloadSignedFile / verifySignedFile`；Webhook 验签是入站边界能力，不与出站
Adapter 请求混用。首发仅 `esign-adapter`（e签宝）；`fadada-adapter` 作为后续
适配器按同一接口实现，切换经 ADR 评审。

- `createFlow` 固定调用 V3 `POST /v3/sign-flow/create-by-file`，只接受受控文件
  标识、个人签署账号、姓名、5 分钟至 90 天的到期时间及有界坐标；强制
  `autoStart/autoFinish/identityVerify=true`，不得把客户端任意 JSON 透传给
  供应商。
- `signUrl` 固定调用 V3 `POST /v3/sign-flow/{id}/sign-url`，使用已核验的个人
  账号、`needLogin=false`、`urlType=2`；只返回无凭据、标准 443 端口的
  `https://*.esign.cn` 页面。候选人免登录不等于跳过身份一致校验。

### 6.2 签署流程状态机（ERP 侧权威）

```
AWAITING_SIGNATURE → PARTIAL_SIGNED → PROVIDER_COMPLETED → COMPLETED
        │                 │
        ├→ REJECTED      ├→ EXPIRED
        └→ CANCELLED     └→ REVIEW_REQUIRED（旁路标记）
```

- 状态迁移只允许由两类输入驱动：适配器回传（webhook/拉单）或 ERP 用户显式操作（发起、撤销）。
- 外部状态与内部状态的映射表由适配器维护；外部新增未知状态必须设置 `REVIEW_REQUIRED` 并告警，保持当前状态，禁止把未知值伪造成业务状态或静默忽略。

### 6.3 Webhook 处理

- 入口：`POST /webhooks/esign`，回调 URL 固定不带 query。经网关来源限制后，按 e签宝 V3 规则对 `X-Tsign-Open-Timestamp + raw body bytes` 执行 HMAC-SHA256，请求时间戳窗口为 ±5 分钟。事件发生时间可因供应商重试早于请求时间，不用它代替请求防重放。租户只能在验签后根据唯一 `appId` 绑定解析，禁止信任 URL、query、header 或 body 中的 `tenantId`。
- 处理模型：webhook 只做三件事——验签、写 inbox、返回 200；业务处理异步进行。
- 入箱只保存 AES-256-GCM 密文，AAD 绑定租户和 Inbox ID；外部 flowId 同样加密，只用 SHA-256 摘要作精确关联。
- 重放：以 `appId + raw body` 的 SHA-256 事件标识幂等；同一 flowId 只应用不早于已提交时间的事件，乱序事件标记 `ignored` 并保留审计。
- 只白名单处理官方 action `SIGN_MISSON_COMPLETE` 和 `SIGN_FLOW_COMPLETE`（保留供应商官方拼写）；流程状态 `2/3/5/7` 分别投影为供应商完成/撤销/过期/拒签。未知 action 仅入箱告警，未知状态仅转人工复核，都不推进业务终态。
- BullMQ 任务标识必须绑定租户、Inbox 和供应商事件摘要；Worker 认领时写入随机
  `processingToken`、确定性 `processingJobId` 与递增 `attempts`。成功、忽略和
  失败终态更新必须同时匹配这三项租约证据，旧 Worker 丢失租约后不得覆盖新
  Worker 的终态。

### 6.4 兜底对账

- 每 15 分钟对 `SENT/PARTIAL_SIGNED` 且超过 10 分钟未更新的流程主动调 `getFlow` 拉单，防止 webhook 丢失。
- `SIGN_FLOW_COMPLETE + signFlowStatus=2` 只进入 `PROVIDER_COMPLETED`，不等于 ERP `COMPLETED`。已签 PDF 必须下载、验签、病毒扫描、记录 SHA-256 并进入不可变对象存储；证据归档成功后 ERP 才进入 `COMPLETED` 并允许 Offer 进入 `signed`。
- 已签文件获取使用 V3 推荐的 POST 下载地址接口，短链有效期不超过 300 秒。只允许 eSign HTTPS 域名，禁止 HTTP 跳转；文件最大 50 MiB，必须通过 PDF 魔数、病毒扫描和供应商签名有效性核验。
- 对账范围同时包含滞留的 `PROVIDER_COMPLETED`。证据任务使用租户与流程绑定的
  确定性 ID，耗尽失败后移除失败 Job；下一轮对账重建任务。供应商补拉、流程
  投影或归档已经提交后的审计故障只形成独立告警，不得把已成功业务终态回写为
  失败或重复执行外部副作用。

---

## 7. 银行代发与税务申报（文件交换）

首发不做银企直连 API，全部为**文件交换 + 自动对账**（决策 D6）。

### 7.1 银行代发文件（出站）

- 生成：薪酬审批通过后，由 payroll-module 生成代发文件（批次号 = `tenantId + 薪酬期间 + 序号`）。
- 文件管控：字段含银行卡号等敏感信息，落盘即加密（密钥见 §12 凭据托管），传输走银行指定安全通道（U盾操作/SFTP/银企客户端，按开户行要求逐项登记）。
- 校验：生成后自检（行数、总金额、账号格式、重复收款人）通过才允许导出；导出操作双人确认并留审计。

### 7.2 回盘文件（入站）

- 回盘入 inbox 后按批次号匹配；解析结果分为：成功、失败（含银行退回原因码）、部分成功。
- **部分成功或无法匹配批次的回盘一律冻结该批次**，自动生成对账异常工单，禁止自动重发任何一笔。
- 失败明细经 HR/财务确认后，走"补发子批次"流程（新批次号，关联原批次）。

### 7.3 税务申报文件（出站）

- 按税务局要求格式生成个税申报文件；导出前由财务复核，文件版本与薪酬批次强关联。
- 申报结果（导入成功/失败回执）人工录入或文件回传，记入批次对账状态。

### 7.4 自动对账

对账维度（每批次必过）：

1. 应发总额 = 代发文件总额 = 回盘成功总额 + 回盘失败总额；
2. 代发笔数 = 回盘笔数；
3. 个税申报合计与薪酬计算结果一致。

对账每日定时执行 + 回盘到达即触发；不一致自动冻结批次并告警 FINANCE_ADMIN。对账记录不可删除，仅可追加更正记录。

---

## 8. 短信与邮件

- 统一 notify 编排：业务方只声明"通知事件 + 接收人 + 模板编码"，通道选择（短信/邮件/钉钉/飞书消息）由编排层按通知策略决定。
- 短信、邮件服务商均按适配器接入，凭据独立托管；同一通道预留备用服务商，主通道失败率超阈值自动切换并告警。
- 发送状态（已提交/已送达/失败）回写通知记录；含薪酬、合同类敏感内容的通知禁止在正文出现明文敏感数据，只发链接 + 登录后查看。
- 退订与频控：营销/关怀类通知遵守员工退订设置；同一员工同类通知有最小间隔。

---

## 9. 事件总线：CloudEvents 信封与 outbox/inbox

### 9.1 CloudEvents 1.0 信封（所有跨系统事件的统一包装）

```json
{
  "specversion": "1.0",
  "id": "01J...（ULID，全局唯一）",
  "source": "//gaoq-erp/org-module",
  "type": "cn.gaoq.erp.employee.updated.v1",
  "subject": "tenant/{tenantId}/employee/{employeeId}",
  "time": "2026-07-20T04:00:00Z",
  "datacontenttype": "application/json",
  "tenantid": "…",
  "idempotencykey": "tenantId:type:businessKey:version",
  "traceid": "…",
  "schemaversion": "1",
  "data": { "tenantId": "...", "version": 42, "...": "..." }
}
```

- `type` 命名：`cn.gaoq.<域>.<实体>.<动作>.v<主版本>`；破坏性变更升主版本，新旧版本至少并行一个迭代周期。
- 事件体一律使用 canonical model，禁止透传外部报文。

### 9.2 Outbox（出站可靠性）

1. 业务写入与 outbox 事件插入在**同一 MongoDB 事务**内完成；
2. 后台 relay 轮询 outbox（或 Change Stream），投递至适配器/事件总线；
3. 投递成功后标记 `dispatchedAt`；记录保留 30 天后归档。

### 9.3 Inbox（入站可靠性）

1. 所有 webhook/拉取结果先加密写入 inbox（含原始报文、签名摘要、接收时间），日志禁止记录原始敏感报文；
2. 消费端以 `idempotencyKey` 去重，处理成功标记 `processedAt`；
3. 原始报文保留 90 天，用于争议排查与对账。

### 9.4 幂等规则

- 出站：幂等键 = `tenantId + 实体ID + version`（下发类）或 `tenantId + 业务批次号`（文件类）；
- 入站：幂等键 = 外部 `eventId`，外部无 eventId 时以"报文哈希 + 时间窗"合成；
- 所有写接口必须声明幂等键，无幂等键的写接口不允许上线。

### 9.5 ERP 与专业算薪共享事件

`@gaoq/platform-contracts@1.0.0` 是 ERP、专业算薪应用、Worker 和协议测试的
唯一共享契约包。正式事件逐字固定为：

首次同步与版本缺口修复使用
`GET /integrations/payroll/v1/master-data/snapshots`。入口只接受带
`erp:payroll:master-data:read` 的可信 `service|system_job`；快照摘要绑定租户和
契约版本，游标采用规范 Base64URL、精确字段集与 200 条页边界，任何跨租户、
主数据漂移或非规范游标均失败关闭。每页仅审计摘要、偏移和实体计数，禁止审计
人员正文。该接口不属于 MCP 能力目录。

| 方向 | 事件 |
| --- | --- |
| ERP → 算薪 | `cn.gaoq.erp.department.upserted.v1` |
| ERP → 算薪 | `cn.gaoq.erp.employee.upserted.v1` |
| ERP → 算薪 | `cn.gaoq.erp.employment.changed.v1` |
| 算薪 → ERP | `cn.gaoq.payroll.run.status_changed.v1` |
| 算薪 → ERP | `cn.gaoq.payroll.payslip.published.v1` |
| 算薪 → ERP | `cn.gaoq.payroll.cost_summary.published.v1` |
| 算薪 → ERP | `cn.gaoq.payroll.reconciliation.completed.v1` |

- 每个事件必须通过包内逐类型运行时验证器和
  `PAYROLL_EVENT_JSON_SCHEMAS`；信封与 `data` 均拒绝未知字段。
- 信封必须包含可信 `source/subject/time/tenantId/traceId/idempotencyKey`、
  `schemaVersion=1` 和 `application/json`，主题中的租户、实体类型和实体 ID
  必须与信封及负载一致。
- 日期、期间、状态、数组、计数、版本、整数分金额和
  `sha256:<64位小写十六进制>` 摘要按业务语义限制，禁止只校验 JavaScript 类型。
- 旧 `com.gaoq.*` 名称不属于正式目录。只允许通过包内显式迁移函数并行一个发布
  迭代；迁移入口仍执行 v1 严格负载校验，禁止把兼容窗口变成宽松解析入口。

---

## 10. 安全：签名、防重放、限流、重试、死信

| 机制 | 约定 |
|------|------|
| 出站签名 | 按各平台规范（钉钉/飞书应用密钥签名、OP HMAC-SHA256）；密钥不落代码与配置仓库 |
| 入站验签 | 全部 webhook 强制验签，验签后由受信任应用标识解析租户；验签失败返回 401 并计数告警 |
| 防重放 | 时间戳窗口 ±5 分钟 + nonce/eventId 去重缓存（Redis，TTL 24h） |
| 限流 | 出站：每适配器令牌桶，遵守对方 QPS 上限并预留 20% 余量；入站：网关按来源 IP + tenantId 双维限流 |
| 重试 | 指数退避（1s/5s/30s/2m/10m/30m，最多 6 次）+ 抖动；仅对可重试错误（5xx、限流、网络错误）重试，4xx 业务拒绝直接进人工队列 |
| 死信 | 重试耗尽 → 死信队列 + 告警（钉钉/飞书值班群 + 邮件）；死信必须支持人工"重新入队/标记已处理"操作，操作留审计 |
| 断连演练 | 每个适配器上线前须通过"对方不可用 2 小时"演练：事件不丢失、恢复后自动追赶 |

---

## 11. AI / MCP 集成的写操作风险分级

依据决策 D8，MCP 仅采用当前稳定标准。AI Agent（含 MCP Tools）触发的外部系统写操作按风险分级确认：

| 级别 | 示例 | 确认要求 |
|------|------|----------|
| R0 只读 | 查询考勤、查询审批状态 | 可执行，仍需权限、脱敏和审计 |
| R1 普通写 | 发送单条工作通知、创建日历提醒、创建审批草稿 | 必须生成待确认操作并由用户显式确认 |
| R2 高风险写 | 发布职位、发起签署、组织下发、薪酬导出请求 | 二次认证；合同、薪酬、权限等场景还需独立审批人 |
| R3 禁止 | 直接发薪、提升超级权限、绕过审批、物理删除审计 | 不注册Tool，服务端永久拒绝 |

- 分级表随 MCP Tools 清单维护，新增 Tool 必须标注级别，未标注默认按 R3 处理。具体准备、确认、执行协议以[《MCP服务规范》](./04-mcp-service-standard.md)为准。

---

## 12. 凭据托管

- 所有外部系统凭据（AppKey/AppSecret、API Key、银行证书、短信签名密钥、e签宝密钥）统一存于云厂商 KMS/密钥管理服务，应用启动时注入，**禁止**出现在代码、配置仓库、Issue、日志中。
- 凭据按 `环境（dev/staging/prod）× 系统` 隔离；prod 凭据仅平台组可申领，申领留审计。
- 轮换周期：应用级密钥 ≤180 天，银行/支付类证书按对方要求；轮换流程预演后方可执行。
- 日志脱敏：手机号、银行卡号、证件号、薪资数字在日志与事件追踪中默认脱敏。

---

## 13. 外部映射（External Mapping）

统一 `external_mappings` 集合：

```json
{
  "tenantId": "…",
  "entityType": "employee | orgUnit | candidate | approval | esignFlow | payBatch",
  "internalId": "…",
  "provider": "dingtalk | feishu | op | esign | bank | …",
  "externalId": "…",
  "version": 42,
  "status": "active | conflict | disabled",
  "createdAt": "…",
  "updatedAt": "…"
}
```

- 任何适配器读写外部对象前必须先查映射；映射缺失按各数据域规则处理（§2），禁止"按名字猜"。
- `conflict` 状态进入人工处理队列，处理结果（合并/拆分/指定权威）留审计。

---

## 14. 上线检查清单（每个集成点）

- [ ] canonical model 映射表评审通过（ADR 登记）
- [ ] outbox/inbox 落库 + 幂等键声明
- [ ] 验签/签名、防重放、限流、重试、死信全部生效
- [ ] 数据权威方向符合 §2，无反向回写主档路径
- [ ] 失败处置与告警已配置（死信告警接收人已指定）
- [ ] 对账任务（日级）已上线
- [ ] 凭据走 KMS，日志脱敏验证通过
- [ ] 断连演练通过
- [ ] AI 可触达的写操作已分级标注
