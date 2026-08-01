# e签宝适配器字段映射

- 权威方向：ERP 发起；e签宝在流程进行中提供状态；证据完成归档后 ERP 成为内部
  终态权威。
- 实现：`esign.adapter.ts`、`esign-webhook.*`、`esign-evidence-*`、
  `esign-issuance.*`。
- 外部验收：真实企业认证、签署人核验、回调、拉单、恶意文件扫描和 WORM
  Object Lock 仍待完成。

## 发起与签署

| ERP canonical 字段 | e签宝 V3 字段 | 约束 |
| --- | --- | --- |
| `providerFileId` | `docs[0].fileId` | 只接受受控文件标识，不接收 URL |
| 固定名称 | `docs[0].fileName="劳动合同.pdf"` | 不透传候选人输入 |
| `expiresAtEpochMs` | `signFlowExpireTime` | 5 分钟至 90 天 |
| 固定标题 | `signFlowTitle="员工劳动合同签署"` | 不包含候选人或 Offer 条款 |
| 固定策略 | `autoStart/autoFinish/identityVerify=true` | 调用方不可关闭 |
| `signerAccount` | `psnAccount` | Worker 从招聘窄口临时取得 |
| `signerName` | `psnInfo.psnName` | 不进入 MCP 或普通 Outbox |
| `signaturePosition.page/x/y` | `positionPage/positionX/positionY` | 有界数值 |
| `signFlowId` | ERP 加密 `externalFlowId` | 摘要用于精确关联，原文不进 MCP |
| `url` | 临时签署链接 | 只允许无凭据的 `https://*.esign.cn:443` |

## 状态与证据

| e签宝字段/动作 | ERP 投影 | 约束 |
| --- | --- | --- |
| `SIGN_MISSON_COMPLETE` | 部分签署投影 | 仅白名单官方 action |
| `SIGN_FLOW_COMPLETE` + 状态 `2` | `PROVIDER_COMPLETED` | 不直接等于 ERP `COMPLETED` |
| 状态 `3/5/7` | `CANCELLED/EXPIRED/REJECTED` | 未知状态转人工复核 |
| `files[].fileId/downloadUrl` | 签署文件下载描述 | URL 仅短时内存使用 |
| `signature.modify=false` | 文件签名有效项 | 全部签名项均须通过 |
| 签署文件 SHA-256 | 证据摘要 | 病毒扫描和 WORM 归档后才完成 |
| Webhook 原始正文 | AES-256-GCM Inbox 密文 | AAD 绑定可信租户和 Inbox ID |
| `appId` | 可信租户绑定 | 仅在验签后解析，拒绝 body/header 自报租户 |

