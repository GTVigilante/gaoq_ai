# Payroll Core 实现说明

Payroll Core 首批实现工资计算的可信主数据、不可变输入/结果快照、周期持久化、
REST、CloudEvents、审计和只读 MCP。审批锁定、工资单、银行代发、税务申报、
工资调整收付及年度核对已由后续 Phase 4 切片交付，完整顺序以
[Phase 4 README](./README.md) 为准。所有旧 Payroll/Treasury 代码只作为迁移和
兼容基线；默认 `PAYROLL_SYSTEM_MODE=external` 时不得形成生产工资或资金事实。

## 专业算薪模式边界

`PayrollRunService` 与 `PayrollMasterDataService` 的在线、迁移、MCP 只读及
Treasury 内部读取入口均自行校验可信主体和最小 Scope，并复用
`LegacyPayrollBoundaryService`。默认 `PAYROLL_SYSTEM_MODE=external` 时，
边界在输入解释、幂等、员工/考勤/审批读取、Mongo、解密和确定性计算前返回
`PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM`；Controller、迁移控制面或跨域调用
已经授权不能替代本层校验。
供工资调账复用的 `calculateAdjustmentCandidate` 同样在任何规则包、薪酬或考勤
读取前自行校验共享边界，禁止以“上层已校验”为由形成内部旁路。

算薪运行 33 项专项测试达到 92.36%/90.20%/96.10%/93.37%，主数据 18 项达到
四维 100%（语句/分支/函数/行）。本地结果只证明旧 ERP 入口关闭和兼容路径
完整性，不证明专业算薪真实联调、历史迁移或业务 UAT 已完成。

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
- 锁定工资的确定性差额、专用 Approval、WebAuthn UV 锁定、Treasury 补发、
  员工应收恢复和税务更正控制链已实现；真实银行/税局沙箱、员工授权工资抵扣
  金样例和现场职责分离签署仍待验收，不得用普通工资运行或客户端金额绕过。
- 年度工资代扣、已提交税表与外部税局评估核对已实现；真实税局评估适配器和
  官方个人综合所得申报不属于 ERP 自动执行范围，必须由法定申报主体在外部
  税务系统办理并回传受控证据。
- 审批、双人锁定、工资单、银行/税务文件和四方对账代码已实现；真实专业算薪、
  银行/税局联调、两个完整影子周期、零未解释差异及财务签署仍是生产切换前置
  条件。
