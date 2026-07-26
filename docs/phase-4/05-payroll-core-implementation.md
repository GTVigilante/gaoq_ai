# Payroll Core 实现说明

本批次实现工资计算的可信主数据、不可变输入/结果快照、周期持久化、REST、CloudEvents、审计和只读 MCP。它不包含审批锁定、工资单、银行代发或税务申报，因此旧系统仍是生产工资事实源。

## 权威输入链

工资运行接口只接收 `periodId / rulePackId / employeeId / compensationProfileId / additionalCompensationProfileIds / attendanceSnapshotId` 等 ERP 引用，不接收金额、累计税额、租户或上游 Token。`compensationProfileId` 是期间首个档案；仅在月中变更时按生效顺序提交 `additionalCompensationProfileIds`。应用服务在同一 MongoDB 事务快照内完成：

1. 从已发布规则包读取税率和基本减除费用，并复核 `rulesHash`。
2. 解密全部明确引用的已审批薪酬档案，逐一复核 `profileHash` 和密文/明文法域一致性。单档案必须覆盖完整工资月；多档案必须恰好覆盖整月且无重叠。
3. 多档案按自然日执行 `CALENDAR_DAY_HALF_UP` 分摊，冻结档案 ID/版本/哈希、法域、分配起止日和天数到 L4 输入快照。税率包仍按整月累计预扣，法域差异的社保、公积金及薪酬组件来自各段已审批档案。
4. 读取该员工该月活动考勤月结；超时和缺勤按已审批薪酬档案中的每分钟政策形成固定金额调整。由于月结只提供月度分钟，若不同档案的考勤费率变化则失败关闭，必须先补逐日归属证据，禁止猜分。
5. 从同一税年最近一个包含该员工且已经锁定/支付/对账的工资结果继承累计预扣状态；普通计算结果不能成为下月税务事实。
6. 使用整数分、整数基点和 `bigint` 中间值执行累计预扣，形成逐步账、`inputHash` 与 `resultHash`。
7. 加密保存员工级输入和结果；输入快照另外保存完整档案 ID 集合，周期、Outbox、审计与 MCP 只保留汇总和摘要。

## 主数据与并发

- 薪酬档案仅允许 `service/system_job` 且具备 `erp:payroll:compensation:attest` 的连接器登记；必须引用审批证据和 `jurisdictionCode`。法域同时写入控制字段和 L4 密文，计算前交叉核验。
- 法定规则仅允许 `service/system_job` 且具备 `erp:payroll:rule:attest` 的发布器登记；必须包含来源摘要、受控来源引用和审批证据。
- 生效区间禁止重叠。员工版本唯一键与法域版本唯一键用于把并发发布冲突转为事务失败，禁止最后写入者覆盖。
- `PAYROLL_DATA_ENCRYPTION_KEYS` 是独立 AES-256-GCM 密钥环；AAD 绑定租户、资源类型、资源标识和版本。生产环境缺失时启动失败。

## 契约边界

- REST：创建周期、进入收集、读取脱敏周期，以及两个仅受信任连接器使用的主数据证明入口。工资计算没有用户 REST 入口。
- 事件：`payroll.period.created`、`payroll.period.collecting`、`payroll.run.completed`、`payroll.compensation_profile.attested`、`payroll.rule_pack.attested`；均为 CloudEvents v1，只携带汇总与哈希。
- MCP：`payroll_period_get`、`erp://payroll/periods/{id}` 和 `payroll_period_review_guide`。MCP 复用 `PayrollRunService`，不访问数据库；没有计算、规则发布、薪酬登记、审批、锁定或代发 Tool。
- 审计：REST 与 MCP 按 R0/R2 记录资源标识和摘要，不记录员工工资明细或密文。

## 暂不放行项

- 月中薪酬变更与跨法域自然日拆分已实现；真实薪酬/税务沙箱的金样例、闰年、跨法域政策和考勤逐日归属仍待现场验收。
- 锁定工资的补发/冲销确定性差额准备、专用 Approval 审批与独立 WebAuthn UV
  锁定已实现；实际补发、员工应收/合法后续抵扣、结算回写和税务更正仍未实现，
  不得用普通工资运行、客户端金额或 locked 状态绕过。
- 年度工资代扣、已提交税表与外部税局评估核对已实现；真实税局评估适配器、官方个人综合所得申报、税务更正和收付未实现。
- 审批、双人锁定、工资单、银行/税务文件、四方对账与两个完整影子周期仍是生产切换前置条件。
