# 工资、代发、回盘与个税四方对账

## 对账语义

四方对账不要求应发、实发和税额彼此相等，而是执行以下独立守恒关系：

1. 锁定工资 `totalNetMinor` 必须等于代发批次 `totalMinor`；应发总额作为财务控制量保留，不与实发做错误等值比较。
2. 银行终态回盘成功金额、成功行数必须分别等于代发控制总额和代发行数，失败金额与失败行数必须为零。
3. 已提交个税清单的员工数必须等于锁定工资员工数，申报预扣税必须等于锁定工资预扣税。
4. 工资周期、工资运行、工资结果摘要、代发批次、终态回盘和个税清单必须逐层反向绑定；错运行、错批次、非安全整数或缺失证据不是普通差异，直接失败关闭。

若存在失败行恢复子批次，对账从当前终态成功子批次沿 `recoverySourceBatchId` 反向验证整条链：每一级父批次必须因干净的 `PARTIAL_SUCCESS` 冻结，父批次失败人数/金额必须精确等于子批次人数/金额。工资净额与根批次已成功部分加各级恢复终态成功部分的汇总比较；当前子批次自身仍与自己的终态回盘逐项比较。结算链最多 32 层并生成独立 SHA-256，循环、断链、错运行或不守恒均失败关闭。父批次继续永久冻结。

标准差异码固定为：`PAYROLL_BANK_AMOUNT_MISMATCH`、`BANK_RETURN_AMOUNT_MISMATCH`、`BANK_RETURN_COUNT_MISMATCH`、`PAYROLL_TAX_AMOUNT_MISMATCH`、`PAYROLL_TAX_EMPLOYEE_COUNT_MISMATCH`。

## 事务和状态

- `POST /treasury/disbursements/:id/reconciliation` 只允许拥有 `erp:payroll:reconciliation:execute` 的受信任 `service` 或 `system_job` 调用，要求 `Idempotency-Key` 和代发批次预期版本。普通用户与 MCP 永久不可执行。
- Treasury 在线执行与迁移导入均各自校验受信任服务/迁移主体及最小 Scope，并
  复用 `LegacyPayrollBoundaryService`；`external` 模式在幂等记录、Mongo、
  Payroll 读取和任何状态推进前失败关闭。该边界关闭的是 Treasury 对账入口；
  旧 `PayrollReconciliationService` 自身仍属于后续旧 Payroll 下沉范围。
- 输入批次必须为 `reconciling`，具有银行提交回执、WORM 证据以及签名通过、恶意文件扫描通过的 `accepted` 终态回盘；个税必须为 `submitted` 并具有可信提交回执。
- 同一 Mongo 事务生成不可变对账快照、推进 Payroll 周期、推进 Treasury 批次并写双侧 Outbox。为了兼容已落地的代发链，服务会用领域状态机补齐 `locked → disbursing → reconciling` 事件版本，禁止静默跳版本。
- 全部守恒时，Payroll 与 Treasury 均进入 `reconciled`。任一标准差异出现时，对账快照为 `frozen`，Treasury 批次以 `FOUR_WAY_MISMATCH` 冻结，Payroll 保留在 `reconciling` 并绑定差异证据；不得自动解冻、重发或重报。
- 同一租户的工资周期、工资运行和代发批次各自只能生成一份对账快照。纠错必须形成新的工资/补发/税务版本并走明确恢复流程，不覆盖原证据。

## 数据、事件与审计

- `PAYROLL_FOUR_WAY_RECONCILIATION_V1` 证据摘要确定性绑定四个证据面、有序差异码和结算链摘要；同时固化代发 WORM、银行提交、回盘 WORM/签名/扫描及税务提交证据 ID。
- 持久化只包含控制金额、人数、标准差异码、摘要和证据 ID，不含员工、账号、证件、工资行、银行文件、税务正文、外部对象地址或 Token。
- Payroll 事件为 `payroll.disbursement.started.v1`、`payroll.reconciliation.started.v1`、`payroll.reconciliation.completed.v1`；Treasury 事件为 `treasury.reconciliation.completed.v1`。Writer 使用精确字段白名单。
- 执行记 R3 审计，只读记 R1 审计。日志和审计不复制逐人数据或外部正文。

## REST 与 MCP

- REST 只读：`GET /payroll/reconciliations/:id`，Scope 为 `erp:payroll:reconciliation:read`。
- MCP Tool：`payroll_reconciliation_get`。
- MCP Resource：`erp://payroll/reconciliations/{id}`。
- MCP Prompt：`payroll_reconciliation_review_guide`。

MCP 复用 `PayrollReconciliationService.getStatus`，只解释控制量和标准差异码，不访问 Model、数据库或外部连接器，不执行对账、解冻、补发或税务重报。

`pnpm quality:treasury-reconciliation-coverage` 覆盖 11 项身份、模式边界、迁移、
证据链、守恒和写冲突用例，目标服务达到
93.75%/94.57%/100%/96.33%（语句/分支/函数/行），逐文件四维 90% 门禁已接入
`pnpm check`。该仓库证据不替代真实专业算薪、银行/税务回执及财务签署。
