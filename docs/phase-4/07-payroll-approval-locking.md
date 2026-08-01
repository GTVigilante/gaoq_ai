# 工资审批与强认证锁定

本批次把工资周期状态机接入 Approval 可信终态与 WebAuthn 用户验证证据。锁定属于 R3，MCP 不注册请求、执行或变通入口。

## 专业算薪模式边界

`PayrollApprovalService` 的历史审批/锁定导入、在线申请、审批同步和强认证锁定
均先校验迁移或用户主体、最小 Scope 及主体绑定，再调用共享
`LegacyPayrollBoundaryService`。默认 `external` 模式在输入解释、Approval
读取/创建、WebAuthn、幂等和 Mongo 前失败关闭；任何上层 Guard、Worker 或
迁移服务都不能代替该服务自身的校验。24 项专项测试使目标服务四维 100%。
真实 Approval 终态、强认证设备和薪酬业务 UAT 仍须外部验收。

## 审批模板契约

生产前必须发布代码为 `payroll_period_approval` 的 R2 模板，表单固定包含以下只读字段：

- `period_id`：工资周期 ULID。
- `run_id`：当前活动计算运行 ULID。
- `input_snapshot_hash`：权威输入集合摘要。
- `result_hash`：员工结果集合摘要。

工资制单人创建并提交审批。同步服务只读取专用模板的 approved/rejected 终态、最终决策人和上述四个绑定字段；任一字段与当前活动运行不一致即失败关闭。领域层强制审批人不得等于制单人。

## R3 锁定

1. 前端以工资周期 `periodId` 作为 WebAuthn authentication ceremony 的 `operationId`。
2. WebAuthn 必须完成 UV；证据绑定租户、人员、登录会话、工资周期和五分钟有效期。
3. 锁定接口只接收 `expectedVersion` 与证据 ULID，人员/租户/会话从已验签访问令牌取得。
4. 领域层强制锁定人同时独立于制单人和审批人；事务内以版本和状态乐观锁更新。
5. 事件与审计只记录周期、状态和认证方法，不记录凭据、工资明细或认证响应。

## 禁止项

- MCP/AI 不得发起工资审批、同步审批、开始强认证或锁定工资。
- 不得把普通登录、OTP、客户端布尔值或证据标识存在本身视为强认证成功。
- 已批准后不得原地重算；如需重算必须回到新运行和新审批链。

员工本人薪资单、字段级授权和发布证据将在下一纵切交付；本批次仍不允许生产代发。
