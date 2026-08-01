# Phase 2 SLO 与告警手册

## SLO

| 能力 | 目标 | 统计窗口 |
| --- | --- | --- |
| 审批 REST/MCP 读 | 可用性 ≥ 99.9%，P95 < 500ms，P99 < 1.5s | 30 天 |
| 审批写事务 | 成功请求 P95 < 800ms，P99 < 2s | 30 天 |
| 通知投递 | 99% 在 60 秒内成功或进入可解释重试 | 7 天 |
| 通知最终结果 | 24 小时内成功率 ≥ 99.9%，死信率 < 0.1% | 7 天 |
| MCP R1 确认 | prepare/confirm/execute 服务可用性 ≥ 99.9% | 30 天 |
| MCP R2 强认证确认 | 服务端可用性 ≥ 99.9%，成功断言 P95 < 5s | 30 天 |
| 审计 | R1/R2 成功操作审计覆盖率 100% | 持续 |

## 指标

- `gaoq_http_requests_total`、`gaoq_http_request_duration_seconds`
- `gaoq_queue_jobs{queue="approval-notification",state=...}`
- `gaoq_queue_metrics_poll_failures_total{queue="approval-notification"}`
- `gaoq_approval_notification_delivery_total{channel,outcome}`
- `gaoq_approval_notification_delivery_duration_seconds{channel,outcome}`
- `gaoq_mcp_confirmation_total{stage,risk_level,outcome}`
- `gaoq_audit_append_total`、`gaoq_audit_verification_total`

标签只能使用固定渠道、阶段、风险等级、结果和 HTTP 路由，不得使用租户、人员、审批、通知或操作 ID。

## 告警基线

- Sev1：审计追加失败；跨租户/权限绕过信号；R2 在无有效 WebAuthn UV 证据时执行成功；表单或凭据泄漏。
- Sev2：通知死信率 15 分钟 > 1%；任一 `state_unavailable`；任一渠道连续
  5 分钟无成功且存在积压；最老待发送记录 > 15 分钟；执行中租约持续超时。
- Sev2：出现 `APPROVAL_NOTIFICATION_DELIVERY_INDETERMINATE` 时立即暂停对应钉钉
  自动恢复，先通过平台回执/消息查询确认结果，再由双人批准是否使用
  `approved_exception`；禁止以普通 `provider_recovered` 绕过。
- Sev2：MCP confirm/execute 5xx 比例 5 分钟 > 2%；命令摘要不匹配出现任意一次。
- Sev2：R2 `confirm/denied` 15 分钟异常高于历史基线 3 倍；同一发布后 Passkey 断言失败持续 5 分钟。
- Sev3：通知重试率 15 分钟 > 5%；队列 failed > 0 持续 10 分钟；R1 确认放弃率 24 小时 > 40%。

## 响应

1. 先确认审批业务事务是否正常；禁止为恢复通知而修改审批状态。
2. 平台故障时暂停对应渠道消费或降低并发，保留另一渠道；不得把 Token 写入工单。
3. 身份绑定错误进入死信并由组织/身份管理员修复，之后使用有理由码的人工重试。
   `credentials_fixed` 仅恢复凭据引用、凭据正文、平台绑定或 401 类错误；
   `identity_bound` 仅恢复收件人停用或身份未绑定；`provider_recovered` 仅恢复
   网络、响应读取/限长/格式、429、5xx 或平台响应契约错误；任何原因码与存量
   错误类别不匹配时必须失败关闭。
4. `state_unavailable` 表示平台可能已成功但 ERP 终态未确认；不得手工修改记录或
   直接重发。飞书使用原通知 ULID 安全恢复；钉钉进入结果不确定死信并对账。
5. MCP 摘要或强认证异常立即停用写 Tool Scope，保留只读能力并启动安全事件响应。
6. 恢复后执行双平台对账、审计验链和抽样业务核对，再关闭事件。
