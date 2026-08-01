# 外部适配器字段映射索引

本目录落实 `docs/phase-0/03-integration-standard.md` 的字段级映射要求。映射表描述
当前仓库代码中的 canonical command、外部协议字段、权威方向和敏感性边界，不代表
真实租户、沙箱或生产环境已经验收。

| 外部系统 | 映射表 | 主要实现 |
| --- | --- | --- |
| 钉钉 | [dingtalk](./dingtalk/mapping.md) | 组织、SSO、考勤、审批通知、招聘日历 |
| 飞书 | [feishu](./feishu/mapping.md) | 组织、SSO、考勤、审批通知、招聘日历 |
| OP | [op](./op/mapping.md) | 组织、SSO、审批桥接、经营摘要 |
| e签宝 | [esign](./esign/mapping.md) | 发起、状态、签署链接、签署证据 |
| 招聘渠道 | [recruitment](./recruitment/mapping.md) | 职位、申请、阶段和简历证据 |
| 银行文件边界 | [bank-file](./bank-file/mapping.md) | 代发提交、回盘隔离和 WORM 证据 |
| 税务文件边界 | [tax-file](./tax-file/mapping.md) | 申报、回执、年度汇算和 WORM 证据 |
| 通知服务 | [notification](./notification/mapping.md) | 平台待办、关怀通知、营销通知 |

## 维护规则

1. 外部请求或响应字段变化时，必须在同一 PR 更新对应映射表、运行时 schema 和
   协议测试。
2. `tenantId`、主体、权限和数据范围只能来自可信服务端上下文；表内出现
   `tenantId` 仅表示服务端绑定，不授权客户端或 AI 自报。
3. Token、Secret、签名私钥、联系方式、薪资正文、银行账户和合同正文不得进入
   通用 Outbox、日志、审计 metadata、MCP Resource、Prompt 或确认账本。
4. 映射表中的“外部验收待完成”不得改为通过，除非 Issue 绑定了目标环境、原始
   回执、签名、公钥集、执行时间窗和责任人签署证据。

