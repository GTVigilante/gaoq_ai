# 银行文件边界字段映射

- 权威方向：ERP 生成代发文件并提交隔离网关；银行回盘经上游验签、扫描、规范化
  后进入 ERP；回盘不匹配冻结批次。
- 实现：
  `../../../treasury/integration/treasury-bank-submission-http.adapter.ts`、
  `../../../treasury/integration/treasury-bank-return-http.adapter.ts`、
  `../../../treasury/integration/treasury-evidence-http.adapter.ts`。
- 外部验收：真实银行格式、签名/加密、沙箱回执、法定留存和财务签署仍待完成。

## 代发提交

| ERP canonical 字段 | 银行隔离网关字段 | 约束 |
| --- | --- | --- |
| `tenantId` | `tenantId` | 可信执行上下文，网关回执不具备改租户权 |
| `batchId` | `batchId` | 工资批次 ULID |
| `objectRef` | `objectRef` | WORM 文件引用，不传文件正文 |
| `fileHash` | `fileHash` | SHA-256 base64url |
| `lineCount` | `lineCount` | 1..5000 |
| `totalMinor` | `totalMinor` | 安全整数最小货币单位 |
| 运行模式 | `submissionMode` | `sandbox/production`，生产必须有短时授权 |
| 生产授权 | `productionAuthorization*` | 精确绑定提交、commit 和部署清单摘要 |
| 网关回执 | `submissionId/evidenceId/accepted` | 所有控制量必须原样回显并校验 |

## 银行回盘

| 隔离网关字段 | ERP canonical 字段 | 约束 |
| --- | --- | --- |
| `returnId` | 回盘标识 | ULID，幂等处理 |
| `tenantId/batchId/bankSubmissionId` | 批次关联 | 必须与 claim 请求逐字一致 |
| `sequence` | 回盘序号 | 单调正整数 |
| `returnHash/objectRef` | 回盘证据 | 正文保留在隔离/WORM 边界 |
| `objectEvidenceId/signatureEvidenceId` | 留存/验签证据 | 必须是不同的稳定标识 |
| `signatureVerified` | 验签结论 | `false` 时失败关闭 |
| `malwareScanEvidenceId/malwareClean` | 扫描结论 | `false` 时失败关闭 |
| `lines[].instructionId` | 支付指令关联 | 必须属于本批次 |
| `lines[].outcome` | `succeeded/failed` | 未知值拒绝 |
| `lines[].amountMinor` | 回盘金额 | 与原指令逐项对账 |
| `lines[].bankLineReference` | 银行行回执 | 只保存规范标识 |

银行账号、户名和文件正文属于 L4，不进入此 HTTPS 控制面、日志、审计 metadata
或 MCP。MCP 永久不注册发薪、重发、回盘认领或对账写 Tool。
