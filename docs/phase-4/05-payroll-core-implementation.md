# Payroll Core 实现说明

本批次实现工资计算的可信主数据、不可变输入/结果快照、周期持久化、REST、CloudEvents、审计和只读 MCP。它不包含审批锁定、工资单、银行代发或税务申报，因此旧系统仍是生产工资事实源。

## 专业算薪模式边界

`PayrollRunService` 与 `PayrollMasterDataService` 的在线、迁移、MCP 只读及
Treasury 内部读取入口均自行校验可信主体和最小 Scope，并复用
`LegacyPayrollBoundaryService`。默认 `PAYROLL_SYSTEM_MODE=external` 时，
边界在输入解释、幂等、员工/考勤/审批读取、Mongo、解密和确定性计算前返回
`PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM`；Controller、迁移控制面或跨域调用
已经授权不能替代本层校验。

算薪运行 33 项专项测试达到 92.36%/90.20%/96.10%/93.37%，主数据 18 项达到
四维 100%（语句/分支/函数/行）。本地结果只证明旧 ERP 入口关闭和兼容路径
完整性，不证明专业算薪真实联调、历史迁移或业务 UAT 已完成。

## 权威输入链

工资运行接口只接收 `periodId / rulePackId / employeeId / compensationProfileId / attendanceSnapshotId` 等 ERP 引用，不接收金额、累计税额、租户或上游 Token。应用服务在同一 MongoDB 事务快照内完成：

1. 从已发布规则包读取税率和基本减除费用，并复核 `rulesHash`。
2. 解密已审批薪酬档案，复核 `profileHash`；档案必须覆盖完整工资月，首版不静默按日折算。
3. 读取该员工该月活动考勤月结；超时和缺勤按已审批薪酬档案中的每分钟政策形成固定金额调整。
4. 从同一税年最近一个包含该员工且已经锁定/支付/对账的工资结果继承累计预扣状态；普通计算结果不能成为下月税务事实。
5. 使用整数分、整数基点和 `bigint` 中间值执行累计预扣，形成逐步账、`inputHash` 与 `resultHash`。
6. 加密保存员工级输入和结果；周期、Outbox、审计与 MCP 只保留汇总和摘要。

## 主数据与并发

- 薪酬档案仅允许 `service/system_job` 且具备 `erp:payroll:compensation:attest` 的连接器登记；必须引用审批证据。
- 法定规则仅允许 `service/system_job` 且具备 `erp:payroll:rule:attest` 的发布器登记；必须包含来源摘要、受控来源引用和审批证据。
- 生效区间禁止重叠。员工版本唯一键与法域版本唯一键用于把并发发布冲突转为事务失败，禁止最后写入者覆盖。
- `PAYROLL_DATA_ENCRYPTION_KEYS` 是独立 AES-256-GCM 密钥环；AAD 绑定租户、资源类型、资源标识和版本。生产环境缺失时启动失败。

## 契约边界

- REST：创建周期、进入收集、读取脱敏周期，以及两个仅受信任连接器使用的主数据证明入口。工资计算没有用户 REST 入口。
- 事件：`payroll.period.created`、`payroll.period.collecting`、`payroll.run.completed`、`payroll.compensation_profile.attested`、`payroll.rule_pack.attested`；均为 CloudEvents v1，只携带汇总与哈希。
- MCP：`payroll_period_get`、`erp://payroll/periods/{id}` 和 `payroll_period_review_guide`。MCP 复用 `PayrollRunService`，不访问数据库；没有计算、规则发布、薪酬登记、审批、锁定或代发 Tool。
- 审计：REST 与 MCP 按 R0/R2 记录资源标识和摘要，不记录员工工资明细或密文。

## 暂不放行项

- 月中薪酬变更、跨法域拆分、补发/冲销和年度汇算尚未实现；遇到不覆盖完整月份的档案时失败关闭。
- 审批、双人锁定、工资单、银行/税务文件、四方对账与两个完整影子周期仍是生产切换前置条件。
