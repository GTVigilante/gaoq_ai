# eSign 扫描与 WORM 证据基础设施运行手册

## 1. 上线边界

- 病毒扫描与 WORM 归档必须由两个只接受 HTTPS 的受控网关提供；端点不得携带凭据、query、fragment、非 443 端口，也不得与 ERP OAuth issuer 同源。
- 四项配置 `ESIGN_MALWARE_SCAN_ENDPOINT`、`ESIGN_MALWARE_SCAN_BEARER_TOKEN`、`ESIGN_WORM_ARCHIVE_ENDPOINT`、`ESIGN_WORM_ARCHIVE_BEARER_TOKEN` 必须成套注入。生产缺任一项即拒绝启动，非生产缺失时归档用例失败关闭。
- 合同正文只作为 HTTPS `application/pdf` 请求体短暂传输，不写本地磁盘、Mongo、Outbox、日志或审计。Adapter 在出站前复算 SHA-256，并限制为 50 MiB 和 `%PDF-` 魔数。
- WORM 默认保留期为 3650 天；法律或租户政策要求更长时只允许上调 `ESIGN_WORM_RETENTION_DAYS`，不得低于十年。

## 2. 网关协议

扫描请求使用 `POST application/pdf`，携带 `x-content-sha256` 与不暴露租户的确定性 `idempotency-key`。响应必须是小于 16 KiB 的严格 JSON：

```json
{
  "clean": true,
  "evidenceId": "scan-evidence-001",
  "sha256": "base64url-sha256"
}
```

WORM 请求同样使用原始 PDF 正文，并携带 `x-object-key`、`x-content-sha256`、`x-data-classification=L4`、`x-retention-policy=employment_contract`、`x-retention-days` 和确定性幂等键。响应必须严格包含：

```json
{
  "objectRef": "worm/esign/locked-object-001",
  "receiptId": "archive-receipt-001",
  "immutable": true,
  "sha256": "base64url-sha256",
  "objectKey": "esign/{flowUlid}/{sha256}.pdf",
  "retentionDays": 3650
}
```

摘要、对象键、不可变标志或保留期任一不匹配时，ERP 不写证据账本、不推进 Offer `signed`。

## 3. 沙箱验收

1. 使用无真实个人数据的签署样本验证 clean、恶意样本、超限文件、非 PDF、摘要错位和超时。
2. 对同一对象键至少重放三次，确认返回同一不可变对象与等价回执；并发写入不得形成多个对象版本。
3. 尝试覆盖、删除、缩短保留期和使用普通可变存储，所有操作必须被网关拒绝并形成外部审计证据。
4. 轮换两个 Bearer Token，验证旧 Token 在重叠窗口后失效，ERP 日志与错误中不出现 Token、PDF、对象正文或下载短链。
5. 注入 HTTP 429/500、连接中断和回执截断，确认 Worker 可重试且 Offer/Flow 保持在 `provider_completed`。
6. 从 WORM 抽样回读对象，在独立环境复算 SHA-256，并与 `integration_esign_evidence` 的摘要和回执核对。
7. 让证据任务耗尽全部重试，确认失败 Job 被移除；保持 Flow 为
   `provider_completed` 超过十分钟，等待下一轮十五分钟对账，确认以同一
   `tenantId + flowId` 确定性任务标识重新投递并最终归档。
8. 人为暂停旧 Worker 超过十五分钟并启动新 Worker 重领同一 Inbox；旧 Worker
   恢复后必须因 `attempts + processingToken + processingJobId` 不匹配而报
   `ESIGN_WEBHOOK_INBOX_LEASE_LOST`，不得覆盖新 Worker 终态。
9. 对同一 Flow 重放三次未知供应商状态和三次冲突终态；第一次只设置受控人工
   复核，后续投影必须 `changed=false`，不得重复增加 Flow 版本。已 `completed`
   Flow 收到正常完成回执时必须保留既有 `reviewCode`，未知/冲突状态不得覆盖
   已可信的终态 `providerStatus`。

## 4. Go/No-Go 与恢复

- 扫描误放、摘要未绑定、WORM 可覆盖/删除、保留期不足、跨租户对象键冲突或凭据泄露任一出现即 No-Go。
- 首次部署租约令牌版本前先暂停 eSign 队列并等待旧 Worker 的 active Job 清零，
  再整体升级 Worker，最后恢复队列；禁止新旧 Worker 混跑。既有
  `pending/failed` 记录会在新认领时补齐租约字段，滞留 `processing` 记录在
  十五分钟租约过期后由新 Worker 安全重领。
- 网关不可用时禁止人工把流程改成 `completed`；恢复后用原 Flow ID 重新执行归档，确定性对象键和幂等键必须回到同一证据。
- Token 疑似泄露时先停用归档 Worker、吊销旧凭据、检查网关访问日志和对象写入差异，再恢复队列；不得删除已形成的证据账本。
- `ESIGN_EVIDENCE_AUDIT_AFTER_COMMIT_FAILED`、
  `ESIGN_RECONCILIATION_AUDIT_AFTER_COMMIT_FAILED` 或
  `ESIGN_WEBHOOK_APPLY_AUDIT_AFTER_COMMIT_FAILED` 表示业务可能已经提交，禁止
  通过通用失败处理回滚或重放外部创建；先核对 Flow、Offer、证据账本和 WORM
  回执，再恢复审计链。
