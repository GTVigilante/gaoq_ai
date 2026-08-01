# 通知服务适配器字段映射

- 权威方向：ERP 业务事件 `→` 通知适配器；通知服务只负责投递，不改变审批、
  招聘、关怀或营销业务终态。
- 实现：
  `../../../approval/notification/*-approval-notification.adapter.ts`、
  `../../../care/integration/care-occasion-notification-http.adapter.ts`、
  `../../../marketing-cms/marketing-gateways.service.ts`。
- 外部验收：真实钉钉/飞书机器人、短信/邮件服务商、模板备案、限流、回执和降级
  演练仍待完成。

## 审批平台通知

| ERP canonical 字段 | 钉钉/飞书字段 | 约束 |
| --- | --- | --- |
| `externalUserId` | `userIds[]/receive_id` | 来自已绑定平台身份 |
| `eventType + instanceId` | 固定文本模板 | 不透传表单、审批意见或个人敏感字段 |
| `notificationId` | 飞书 `uuid` | 平台侧幂等 |
| 应用非密钥标识 | 钉钉 `robotCode` | Secret/Token 只存在调用内存 |
| 平台回执 | `processQueryKey/message_id` | 映射为 `externalMessageId` |

## 关怀与通用通知网关

| ERP canonical 字段 | 通知网关字段类别 | 约束 |
| --- | --- | --- |
| 通知任务标识 | `notificationId` | 幂等、不可由客户端选择 |
| 关怀类型/模板编码 | `occasion/templateCode` | 固定白名单，不发送生日原值 |
| 接收者受控引用 | `recipientRef` | 网关解析；通用 Outbox 不保存联系方式 |
| 业务发生日期摘要 | 受控模板变量 | 最小必要值，不发送人员主档 |
| 网关回执标识 | `receiptId/evidenceId` | 结构校验和签名验证后保存 |
| Bearer Token/签名材料 | 无业务映射 | 仅 Secret Manager 注入，禁止落库 |

短信和邮件是通知网关内部的同类渠道适配器；邮件失败不得自动改发短信，短信失败
也不得自动改发邮件。更换同渠道供应商必须保持模板语义、幂等键和回执契约一致。
