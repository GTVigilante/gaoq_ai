# GaoQ-OS MCP 服务规范

## 1. 目标与协议基线

MCP 是 GaoQ-OS 的标准 AI 接入面，不是独立业务实现。Web、REST、MCP 和后台任务必须复用同一应用服务、权限策略、事务、幂等和审计逻辑。

- 当前协议基线：MCP `2025-11-25`。
- 远程传输：Streamable HTTP，单一 `/mcp` 端点支持 POST/GET。
- 本地开发与 Inspector：stdio。
- 不实现已被替代的独立 HTTP+SSE 传输；Streamable HTTP 内部可按标准使用 SSE 流。
- JSON-RPC消息使用UTF-8，并实现协议版本协商和能力声明。

## 2. 身份与授权

### 2.1 OAuth发现

- 提供 `/.well-known/oauth-protected-resource`。
- 未认证请求返回 HTTP 401，并通过 `WWW-Authenticate` 指向资源元数据。
- 人员代理使用 Authorization Code + PKCE；无人值守服务代理使用 MCP OAuth Client Credentials 扩展。
- 访问令牌必须校验 `iss/aud/resource/sub/tenant_id/scope/exp/jti`。
- MCP令牌只用于ERP MCP资源；禁止原样透传给OP、钉钉、飞书或其他上游。
- 废弃长期明文 MCP API Key；客户端凭据只保存哈希或非对称公钥材料并支持吊销、轮换和有效期。

### 2.2 Scope与数据范围

Scope格式固定为 `erp:{domain}:{resource}:{action}`，例如：

- `erp:approval:instance:read`
- `erp:approval:instance:submit`
- `erp:payroll:sheet:read_self`
- `erp:knowledge:training:assign`

一次调用必须同时通过OAuth Scope、租户、主体状态、角色权限、字段权限和 `self/department/custom/all` 数据范围校验。

## 3. 能力设计

### 3.1 Resources

- Resource只读且无副作用，URI必须稳定、可授权、可分页。
- 建议URI：`erp://org/me`、`erp://approval/pending`、`erp://payroll/my/{month}`、`erp://knowledge/articles/{id}`。
- L3/L4数据默认脱敏；Resource不得成为批量导出或绕过字段权限的通道。

### 3.2 Tools

- 名称采用 `领域_动作`，只使用安全的字母、数字和下划线，如 `approval_submit`。
- 每个Tool必须声明中文 `title/description`、JSON Schema 2020-12 `inputSchema/outputSchema`、副作用提示、幂等性、开放世界访问提示和风险等级。
- 返回优先使用结构化内容；长结果返回受权限保护的Resource Link。
- 参数校验失败使用可修正的Tool Execution Error；认证失败必须在HTTP边界返回401/403。
- 业务Tool只能调用应用服务，禁止访问Model、Repository或供应商SDK。

### 3.3 Prompts

Prompt由用户显式选择，用于指导审批提交、薪资查询、入职学习等操作。Prompt不得包含密钥、隐式提权、未授权个人信息或绕过确认的指令。

## 4. AI操作风险控制

| 等级 | 场景 | 服务端强制措施 |
| --- | --- | --- |
| R0 | 本人/授权范围只读查询 | 可直接执行，完整审计与脱敏 |
| R1 | 创建草稿、普通修改、提交申请 | 先准备操作，用户确认后执行 |
| R2 | 审批终态、薪酬、合同、权限、批量导出 | 二次认证、独立审批、短时确认凭据 |
| R3 | 直接发薪、超级权限提升、物理删除审计、绕过审批 | 不注册Tool，服务端永久拒绝 |

R1/R2统一采用：

1. `*_prepare`校验权限和参数，返回 `operationId/digest/riskLevel/expiresAt/confirmationUrl`。
2. 用户在ERP页面查看完整影响并完成确认；R2增加二次认证和独立审批人。
3. `*_execute`验证一次性确认凭据、摘要未变化和未过期后执行。
4. 重复调用返回同一结果，不重复产生副作用。

客户端界面确认不能替代服务端确认记录。

## 5. Tool交付矩阵

| 阶段 | Resources/Tools |
| --- | --- |
| Phase 1 | 个人档案、组织查询、我的权限、MCP使用指南 |
| Phase 2 | 待办审批、审批详情、提交/撤回准备与执行、审批处理准备与执行 |
| Phase 3 | 候选申请/HC/职位/面试/Offer 脱敏查询；HC 提交、职位状态、Offer 发送确认链；入职任务、知识搜索、培训与考试；本人生日/周年关怀及校友授权下游清理最小状态摘要（只读，AI 不执行删除、重放或重建） |
| Phase 4 | 本人薪资单、考勤摘要、工资周期与个税申报控制摘要；不提供锁定、发薪、税务提交或对账写 Tool |
| Phase 5 | OP经营摘要、完整能力目录、管理分析与受控导出请求 |

每个业务Issue必须同时列出REST、事件和MCP契约；不能把MCP集中留到后期回填。

Phase 3 招聘的候选人身份、面试地点/评价和 Offer 条款属于 L3/L4，不得进入 MCP 确认记录的 `commandJson`。涉及这些原文的创建能力必须先形成服务端加密草稿引用，再把引用放入 `*_prepare`；在加密草稿能力交付前不得注册对应写 Tool。候选人接受、eSign 完成和入职终态由可信门户、Webhook 或 Worker 驱动，永久不提供 AI 执行 Tool。

授权撤回/到期后的个人数据删除、匿名化、密钥销毁、不可变证明、死信重放和灾后
重建均属于服务端或人工治理能力，不注册 MCP 写 Tool。AI 只可经业务应用服务读取
脱敏状态和固定计数；参数、结果、Resource、Prompt、审计及日志均不得包含自然人、
联系方式、授权证明、下游证明摘要/引用、错误正文或上游凭据。

## 6. 会话、长任务与错误

- 会话ID使用加密安全随机值，不承载权限事实；每次请求重新校验令牌和授权。
- 薪酬计算、导出等长任务返回 `jobId` 和Resource Link，通过进度通知与查询Tool读取状态。
- 核心业务暂不依赖实验性MCP Tasks。
- 错误不得泄漏堆栈、查询、密钥或个人信息；返回稳定错误码、中文说明、`traceId`和可恢复建议。

## 7. 审计与可观测性

审计记录至少包含租户、主体、客户端、Tool/Resource、风险等级、参数摘要、授权Scope、确认/审批引用、结果、时长、IP、协议版本和Trace ID。禁止记录Token、完整身份证/银行卡/薪资明细或附件正文。

指标至少包含连接数、初始化失败率、401/403、Tool成功率、P95/P99、外部调用耗时、确认放弃率、限流和高风险拒绝次数。

## 8. 兼容与验收

- 使用官方TypeScript SDK和MCP Inspector执行协议测试。
- 建立Claude、Kimi、Cursor当前版本兼容矩阵；仅承诺兼容支持当前稳定MCP规范的客户端。
- 必测协议协商、OAuth发现、PKCE、Client Credentials、分页、结构化输出、超时、幂等、确认过期、跨租户拒绝、字段脱敏和审计脱敏。
- 升级协议版本必须先做ADR、双版本契约测试和迁移公告，不得静默破坏客户端。
