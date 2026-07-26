# GaoQ ERP 与专业算薪系统边界

## 权威数据源

- GaoQ ERP 是租户、身份、组织、员工和劳动关系唯一主数据源。
- 独立专业算薪系统是薪酬档案、规则、工资运行、工资结果、工资条、薪税与发放
  证据唯一事实源。
- 两套系统禁止共享数据库、双写工资或使用姓名/邮箱/工号关联人员。

## 身份与契约

- GaoQ OAuth 为算薪 API 注册独立 resource/audience，算薪通过 GaoQ JWKS 验签。
- 跨系统员工主键固定为 `tenantId + employeeId`。
- `@gaoq/platform-contracts` 定义可信身份、整数分金额、CloudEvents、组织投影和
  脱敏工资摘要；生产通过内部 npm Registry 锁定精确版本。
- 组织增量采用 Outbox CloudEvents；首次同步和事件版本缺口使用受服务身份保护的
  游标快照修复。

## OAuth 注册

- `AUTH_ADDITIONAL_RESOURCES_JSON` 注册算薪 API 的 resource/audience。
- 算薪 Web 使用公共客户端、Authorization Code + PKCE，不分发客户端密钥。
- 主数据同步 Worker 使用机密客户端，为 ERP 与算薪两个 resource 分别申请最小
  Scope 令牌：`erp:payroll:master-data:read` 和
  `erp:payroll:master-data:sync`。
- 用户访问令牌必须携带服务端解析的 `employee_id`；算薪系统不接受请求头或请求体
  提供的员工身份回退。

## 运行边界

- `PAYROLL_SYSTEM_MODE=external` 时 ERP 旧 Payroll/Treasury REST 入口返回 410，
  禁止继续形成工资或资金事实。
- ERP 门户只进行统一登录和受控跳转；工资明细不复制到 ERP。
- 真实发薪切换仍必须完成两个完整影子周期、零未解释差异、回滚演练和财务签署。

## 当前代码切换

- GaoQ 默认 `PAYROLL_SYSTEM_MODE=external`，旧 Payroll/Treasury REST 写入口停止
  形成工资事实。
- 专业算薪系统已实现权威快照同步、事件 Inbox、字段加密、确定性整数分计算、
  提交审批、职责分离锁定和本人工资条访问。
- 生产事实源切换仍受上述两个影子周期门禁约束；代码就绪不等同于批准真实发薪。
