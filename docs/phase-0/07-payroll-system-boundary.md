# GaoQ ERP 与专业算薪系统边界

## 权威数据源

- GaoQ ERP 是租户、身份、组织、员工和劳动关系唯一主数据源。
- 独立专业算薪系统是薪酬档案、规则、工资运行、工资结果、工资条、薪税与发放
  证据唯一事实源。
- 两套系统禁止共享数据库、双写工资或使用姓名/邮箱/工号关联人员。

## 身份与契约

- GaoQ OAuth 为算薪 API 注册独立 resource/audience，算薪通过 GaoQ JWKS 验签。
- 跨系统员工主键固定为 `tenantId + employeeId`。
- `@gaoq/platform-contracts@1.0.0` 定义可信身份、整数分金额、CloudEvents、
  组织投影、脱敏工资摘要、逐事件运行时校验器和 JSON Schema；生产通过内部
  npm Registry 锁定精确版本。
- 共享事件名严格采用 `cn.gaoq.<域>.<实体>.<动作>.v<主版本>`。旧
  `com.gaoq.*` 名称只通过显式迁移入口兼容一个发布迭代，主验证器永久拒绝。
- 组织增量采用 Outbox CloudEvents；首次同步和事件版本缺口使用受服务身份保护的
  游标快照修复。
- 快照只允许携带 `erp:payroll:master-data:read` 的可信 `service|system_job`
  身份读取。`snapshotId/snapshotDigest` 必须绑定可信租户、契约版本和稳定排序
  后的脱敏投影；游标只接受规范 Base64URL、精确 `digest/offset` 字段及 200 条
  页边界。跨租户重放、主数据变化、未知字段、非规范编码和伪造偏移均失败关闭。
- 每页读取写 R1 审计，只记录快照摘要、偏移和三类实体计数，不记录姓名或人员
  正文；审计不可用时不得返回批量快照。

## OAuth 注册

- `AUTH_ADDITIONAL_RESOURCES_JSON` 注册算薪 API 的 resource/audience。
- 公共与服务客户端分别在 `MCP_OAUTH_CLIENTS_JSON`、
  `MCP_SERVICE_CLIENTS_JSON` 显式列出 `allowedResources`。全局已注册不代表
  当前客户端获授权；字段缺失、重复或引用未知 resource 均在启动阶段失败关闭。
- 算薪 Web 使用公共客户端、Authorization Code + PKCE，不分发客户端密钥。
- 主数据同步 Worker 使用机密客户端，为 ERP 与算薪两个 resource 分别申请最小
  Scope 令牌：`erp:payroll:master-data:read` 和
  `erp:payroll:master-data:sync`。
- 用户访问令牌必须携带服务端解析的 `employee_id`；算薪系统不接受请求头或请求体
  提供的员工身份回退。

## 共享事件 v1

- ERP → 算薪：`cn.gaoq.erp.department.upserted.v1`、
  `cn.gaoq.erp.employee.upserted.v1`、
  `cn.gaoq.erp.employment.changed.v1`。
- 算薪 → ERP：`cn.gaoq.payroll.run.status_changed.v1`、
  `cn.gaoq.payroll.payslip.published.v1`、
  `cn.gaoq.payroll.cost_summary.published.v1`、
  `cn.gaoq.payroll.reconciliation.completed.v1`。
- 信封必须逐字包含 CloudEvents 1.0、UTC `time`、JSON 媒体类型、租户绑定
  `subject`、`traceId`、`idempotencyKey` 与 `schemaVersion=1`，并拒绝未知字段。
  金额只接受非负 CNY 整数分，摘要只接受 `sha256:` 加 64 位小写十六进制。
- 早期本地提交中的 `com.gaoq.*` 从未进入发布分支或外部联调，作为首次发布前的
  协议纠正直接拒绝，不设隐式别名。未来已发布事件的破坏性变更必须升主版本并
  至少并行一个迭代周期。

## 运行边界

- `PAYROLL_SYSTEM_MODE=external` 时 ERP 旧 Payroll/Treasury REST 入口返回 410，
  禁止继续形成工资或资金事实。
- 同一边界必须下沉到 REST、MCP、Worker、迁移与内部调用共用的应用服务，不能
  只依赖 Controller Guard。ERP 为兼容旧客户端保留的
  `payroll_payslip_get_self` Tool/Resource 在 `external` 模式只返回
  `PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM`，不得读取 ERP 旧工资集合或解密快照。
- 当前共享 `LegacyPayrollBoundaryService` 已由 REST Guard、本人薪资单应用服务
  和全部 Treasury 应用服务复用。银行账户、代发、回盘、失败恢复和 Treasury
  四方对账的在线、迁移及内部续跑入口均先校验可信主体与最小 Scope，再在审批、
  强认证、生产授权、Payroll 端口、Mongo、加密、WORM、银行网关或 Inbox 前
  失败关闭。其余旧 Payroll 算薪运行、审批、主数据、税务、对账和影子周期应用
  服务仍须按风险逐项下沉，不能据此宣称旧 Payroll 内部入口已经完成切换。
- ERP 门户只进行统一登录和受控跳转；工资明细不复制到 ERP。
- 本人工资条由专业算薪系统自己的 OAuth Resource 和标准 MCP 提供；访问令牌中的
  `employee_id` 必须由服务端身份映射产生。ERP 不使用服务令牌加请求体
  `employeeId` 代理 L4 工资条，也不透传用户 Token。
- 专业算薪批量主数据快照是专用服务到服务 REST，不注册 MCP Resource/Tool；
  AI 不得借 MCP 绕过批量导出限制。
- 真实发薪切换仍必须完成两个完整影子周期、零未解释差异、回滚演练和财务签署。

## 当前代码切换

- GaoQ 默认 `PAYROLL_SYSTEM_MODE=external`，旧 Payroll/Treasury REST 写入口停止
  形成工资事实；旧本人薪资单和全部 Treasury 应用服务同步失败关闭，MCP、迁移、
  Worker 或内部续跑不可绕过 REST 守卫。
- 专业算薪系统已实现权威快照同步、事件 Inbox、字段加密、确定性整数分计算、
  提交审批、职责分离锁定和本人工资条访问。
- ERP 与专业算薪的七类共享事件现按完整信封、精确字段集、状态、日期、范围、
  摘要和敏感字段递归拒绝规则校验；机器可读契约由共享包统一导出。
- 生产事实源切换仍受上述两个影子周期门禁约束；代码就绪不等同于批准真实发薪。
