# 招聘渠道适配器字段映射

- 权威方向：职位和阶段 `ERP → 渠道`；原始申请和简历 `渠道 → ERP Inbox`；
  ERP 招聘状态机始终为流程权威。
- 实现：`recruitment-channel.adapter.ts`、`recruitment-channel-*.service.ts`、
  `../../recruitment/integration/recruitment-resume.adapters.ts`。
- 外部验收：具体渠道必须按 `channelCode` 单独登记真实 schema 版本、凭据、
  限流、样本和回执；未完整装配 Adapter/Normalizer/EvidenceVerifier 时失败关闭。

## 职位与阶段

| Canonical 字段 | 渠道字段类别 | 约束 |
| --- | --- | --- |
| `positionId` | 外部职位关联标识 | ERP 稳定标识，不接受渠道覆盖 |
| `title` | 职位标题 | 已发布 ERP 职位快照 |
| `departmentCode` | 部门编码 | ERP 主数据，渠道只展示 |
| `location` | 工作地点 | 最小必要字段 |
| `headcount` | 招聘人数 | 正整数、有界 |
| `idempotencyKey` | 渠道幂等键 | 发布、下架、阶段回传分别独立 |
| `externalPositionId` | ERP 加密/受控映射 | 供应商回执，必须与请求关联 |
| `stage` | `applied/screening/interview/offer/hired/rejected/withdrawn` | 只回传 ERP 已提交状态 |
| `receiptId` | 投递回执 | 只保存规范标识，不保存响应正文 |

## 申请与证据

| 渠道字段类别 | ERP canonical 字段 | 约束 |
| --- | --- | --- |
| 外部事件标识 | `externalEventId` | Inbox 幂等键组成 |
| 外部职位标识 | `externalPositionId` | 必须映射到本租户已发布职位 |
| 外部候选人标识 | `externalCandidateId` | 不作为跨租户自然人主键 |
| 外部申请标识 | `externalApplicationId` | 同渠道内稳定 |
| 姓名/电话/邮箱 | `candidate` | L3，加密保存；MCP 只返回脱敏结果 |
| 授权版本/目的/到期 | `consent` | EvidenceVerifier 验证后才能采纳 |
| 附件不可解释引用 | `attachmentReferences[]` | 禁止 URL、Token 或文件正文 |
| 扫描与 WORM 回执 | `consentEvidenceId/resumeSnapshotId` | 未通过时申请不得进入业务状态机 |
| 渠道游标 | `nextCursor/hasMore` | 受控分页，禁止无界拉取 |

传输异常只有适配器明确返回 `not_committed` 才可自动重试；超时、连接中断或响应
无效统一按 `unknown` 进入人工复核，避免重复发布、下架或阶段回传。

