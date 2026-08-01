# 审批主体解析与组织主数据完整性运行手册

## 1. 适用范围

本手册约束审批实例提交时将模板解析器转换为不可变审批主体快照的边界。REST、
标准 MCP 和 OP 审批入站最终必须复用
`ApprovalActorResolverService`，不得在入口层复制角色、部门负责人或固定员工
解析逻辑。

ERP 的组织、员工和授权快照是唯一可信来源。钉钉、飞书和 OP 的外部身份、部门、
角色或消息接收人只能用于登录和投递，不能覆盖审批主体。

## 2. 强制信任链

解析按以下顺序失败关闭：

1. 发起主体标识必须符合审批标识白名单，租户只读取可信请求上下文。
2. 发起主体必须具有当前租户内 active 授权快照，快照中的租户、主体、员工、
   部门集合和状态必须通过运行时完整性校验。
3. 即使授权快照仍为 active，关联 ERP 员工也必须存在且处于 `active` 或
   `probation`；`suspended`、`terminated`、缺失或持久化漂移均禁止提交。
4. 固定员工反查得到的 actor 必须再次解析当前 active 授权快照，并精确回绑同一
   employee；一人多 actor、actor 漂移或停用映射均失败关闭。
5. 角色解析结果必须全部属于当前租户、状态 active，actor 与 employee 均不得
   重复；只保留当前仍在职或试用的员工。
6. 部门及员工仓储返回值必须与查询标识和可信租户精确一致。未知状态、非法负责人
   标识或跨租户投影视为持久化污染，不得按“未找到”静默跳过。
7. 单节点最终主体最多 100 人；审批节点必须至少一人，抄送节点允许为空。结果按
   actorId 稳定排序、去重并深冻结后进入审批实例快照。

## 3. 模板约束

- `employees` 只接受 1–100 个不重复 ERP employeeId。
- `roles` 只接受白名单角色编码，作用域仅为租户或发起人部门。
- `initiator_manager` 只读取发起员工当前主部门负责人。
- `department_manager` 必须引用模板中声明的 `department` 类型字段；引用文本、
  数字或其他字段即使运行时值看似标识也拒绝发布模板。
- 条件 AST 仍由模板领域服务按字段白名单、深度和节点数限制解释，不执行脚本或
  属性路径。

## 4. REST、OP 与 MCP 一致性

- REST `POST /api/approvals/instances/:id/submit` 调用审批应用服务，再由应用服务
  调用本解析器。
- OP 入站只允许持有 `erp:approval:op:ingest` 的可信后台主体；映射到 ERP 员工
  后仍执行相同解析链，不能信任 OP 审批人或部门。
- MCP Tool `approval_submit_prepare` 与 `approval_submit_execute` 仅在标准确认链
  完成后以内部操作 `approval.submit` 调用同一审批应用服务；MCP 不接收自定义
  审批人、不访问组织数据库，也不透传上游 Token。
- 本切片不新增 MCP Tool、Resource 或 Prompt，不扩大 AI 风险面。

## 5. 验证与观测

- 专项门禁：
  `pnpm quality:approval-actor-resolution-coverage`。
- 当前专项执行 13 项测试，生产文件
  `approval-actor-resolver.service.ts` 覆盖率为
  96.96%/95.60%/100%/98.79%（语句/分支/函数/行），逐文件四维均不低于 90%。
- 模板字段类型约束继续由
  `pnpm quality:approval-template-domain-coverage` 保护。
- `APPROVAL_ACTOR_RESOLUTION_FAILED` 应按租户安全拒绝计数，但日志和审计不得包含
  表单正文、候选审批人清单或外部平台凭据。

本地测试只证明代码边界。真实组织数据质量、角色映射、历史模板迁移、在途审批和
业务 UAT 仍必须在目标环境形成签署证据。
