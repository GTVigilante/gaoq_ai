# 税务文件边界字段映射

- 权威方向：ERP 生成税务申报/年度汇算控制对象，税务隔离网关返回签名回执；
  文件正文和自然人税务明细保留在 L4/WORM 边界。
- 实现：
  `../../../payroll/integration/payroll-tax-gateway-http.adapter.ts`、
  `../../../payroll/integration/payroll-annual-assessment-http.adapter.ts`、
  `../../../payroll/integration/payroll-tax-archive-http.adapter.ts`。
- 外部验收：真实税局沙箱、金样例、证书/公钥轮换、断连追赶和薪税签署仍待完成。

## 月度申报

| ERP canonical 字段 | 税务隔离网关字段 | 约束 |
| --- | --- | --- |
| `tenantId` | `tenantId` | 可信执行上下文 |
| `filingId/runId/period` | 同名控制字段 | 必须互相关联且回执一致 |
| `objectRef` | WORM 文件引用 | 不发送文件正文到应用日志或 MCP |
| `fileHash` | SHA-256 摘要 | 网关回执必须一致 |
| `lineCount/totalTaxMinor` | 控制合计 | 安全整数、有界、逐项对账 |
| `submissionMode` | `sandbox/production` | 生产需要短时独立授权 |
| 网关回执 | 申报/证据标识和状态 | 结构、请求绑定和签名全部校验 |

## 年度汇算

| ERP canonical 字段 | 官方网关/回执字段 | 约束 |
| --- | --- | --- |
| `tenantId/employeeId/taxYear` | 查询绑定 | 员工只能读取本人官方结论 |
| 年度收入/扣除/预缴控制量 | 评估请求控制量 | 来源为已锁定 ERP 工资事实 |
| 官方应补/应退结论 | 年度评估结果 | ERP 不自行伪造官方结论 |
| `settlementUrl` | 官方办理链接 | 只允许固定 HTTPS origin，短时返回本人 |
| 原始回执字节 | 签名输入摘要 | Ed25519 原始字节验签后才解析 |
| `x-gaoq-signing-key-id` | 公钥环 keyId | 必须命中预配置公钥 |
| `x-gaoq-signature` | Ed25519 签名 | 长度、canonical base64url 和签名全部校验 |
| 最小幂等账本 | 请求/回执摘要与状态 | 不保存自然人明细、链接、Token 或回执正文 |

税务提交、重新提交、回执伪造和对账写操作均不注册 MCP Tool；MCP 仅通过工资应用
服务读取本人脱敏控制摘要。
