# 员工本人薪资单与 MCP

本文件描述独立专业算薪迁移前的 legacy 兼容实现。薪资金额来自已锁定活动运行的
确定性快照，不创建可漂移的第二套工资明细。REST 与 MCP 均调用
`PayrollPayslipService`，不直接查询数据库或解密服务。

`PAYROLL_SYSTEM_MODE=external` 是默认和唯一生产模式。此模式下共享应用服务在
访问 Access Profile、Mongo 和解密服务前返回
`PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM`；因此旧 REST 守卫和 MCP 兼容入口具有
相同失败关闭语义。ERP 不缓存、不代理专业算薪工资条，AI 客户端应使用专业算薪
系统自己的 OAuth Resource 与标准 MCP。

## 发布与完整性

- 只有 `locked / disbursing / reconciling / reconciled` 周期视为已发布；draft、collecting、review、pending_approval 和 approved 均返回“尚未发布”。
- 当前主体必须是 user，并由已验证 actor 通过 Access Profile 反查 ERP employeeId；接口不接受 employeeId 或 tenantId。
- 周期、活动运行、输入行和结果行在查询后再次反向绑定可信租户、月份、员工与
  记录标识；不能仅信任 Mongo 查询条件或 TypeScript 类型。
- 输入与结果分别通过独立 Payroll AES-256-GCM 密钥域解密，AAD 绑定租户、资源类型、记录 ID 与版本。
- 密文信封和解密 JSON 使用有界严格 Schema，拒绝未知字段、非法金额、损坏步骤
  账和非规范摘要；读取时重新执行确定性工资内核，并同时复核员工、月份、活动
  运行、`inputHash`、`resultHash`，任一不一致失败关闭。
- 输出不包含员工标识、累计税历史、审批证据、薪酬档案 ID、考勤快照 ID 或加密元数据。
- legacy `publishedAt` 是兼容字段，当前表示薪资周期控制状态的最近更新时间；
  发薪或对账推进后可以变化，不得解释为不可变锁定时间。新的专业算薪契约必须由
  工资唯一事实源提供独立、不可变的发布时间或版本证据。

## 字段权限

- `erp:payroll:sheet:read_self`：只允许读取当前已验证员工本人的已发布薪资单。
- 管理者、HR、财务没有隐式穿透本人边界；跨员工读取必须在未来独立用例中定义字段白名单、目的限制和审批，不复用本接口。
- REST 与 MCP 读取均记 R1 审计，只记录月份和完整性摘要，不复制工资金额到审计或日志。

## MCP 契约

- Tool：`payroll_payslip_get_self`
- Resource：`erp://payroll/payslips/{period}/me`
- Prompt：`payroll_payslip_review_guide`

上述 Tool/Resource 是 legacy 兼容契约；在 `external` 模式不得返回旧工资数据。
专业算薪 MCP 可以解释本人工资构成，但不得比较或推断他人薪酬，也不得触发重算、
审批、锁定、导出、代发或对账。

独立门禁 `pnpm quality:payroll-payslip-coverage` 对共享应用服务逐文件强制语句、
分支、函数、行均不低于 90%，并纳入 `pnpm precheck` 与 `pnpm check`。该门禁
不替代专业算薪 OAuth/MCP 真实联调、L4 数据安全验证和员工 UAT。
