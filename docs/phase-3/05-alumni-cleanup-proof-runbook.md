# 校友授权终止后的下游清理证明运行手册

## 1. 交付边界

ERP 是校友联系授权的唯一事实源。授权转为 `withdrawn` 或 `expired` 并提交
Outbox 事件后，清理协调器按服务端登记目标逐项创建任务。CRM、通知、校友平台等
下游负责删除、匿名化或密钥销毁业务联系数据，并返回绑定对象、目标和政策版本的
签名不可变证明。ERP 只保存证明摘要与受控元数据，不复制证明正文。

代码已交付不等于生产验收完成。真实下游删除/阻断、WORM 或追加账本、凭据轮换、
故障演练、性能与业务 UAT 必须在目标环境留存证据。

## 2. 状态机与可靠性

```text
withdrawn | expired Outbox
          ↓
pending → dispatching → completed
   ↑           │
   └── retry ──┤
               └→ dead → 审批重放 → pending
```

- 撤回与到期共用同一状态机。自然键固定为租户、授权、授权版本、目的、目标和
  `policyVersion`；任务 ID、控制摘要、外部 `Idempotency-Key` 均为确定性值。
- MongoDB 是任务事实源，BullMQ 只携带可信租户与任务 ID。终止事件 relay 和
  周期对账队列为空载荷；每分钟恢复 Outbox→任务和 DB→Queue 窗口。
- 抢占锁 15 分钟后可恢复。失败按 30 秒指数退避，最长 6 小时；达到目标登记的
  `maxAttempts` 后进入 `dead`，禁止自动越过人工门禁。
- 终止事件信封、Outbox 元数据或源授权终态不一致时，必须在当前批次释放原认领、
  增加尝试次数并持久化稳定错误码；禁止依赖锁超时反复占用批次。
- 事务驱动必须确认回调实际执行；空事务、来源认领丢失或幂等上下文漂移均失败
  关闭。清理投递应用服务只接受具有专用 Scope 的可信 `system_job`。
- 外部已成功而本地事务失败时保留 `dispatching`；锁恢复后使用同一幂等键重取
  同一证明，不得重复产生业务删除。

## 3. 下游登记与证明协议

`CARE_ALUMNI_CLEANUP_TARGETS_JSON` 必须整体存放在 Secret Manager/Kubernetes
Secret，禁止进入 ConfigMap、日志、事件或审计。每个目标必须使用唯一
`targetCode`、独立标准 HTTPS 根 Origin、独立 Bearer Token、独立 Ed25519 SPKI
公钥及 `signingKeyId`，并明确 `policyVersion`、`maxAttempts` 和不少于 2,555 天
的证明保留期。

ERP 固定调用 `POST /v1/alumni-consent-cleanups/execute`，只发送授权不透明标识、
版本/目的、终止原因/时刻、目标、政策版本、控制摘要及三项指令：删除或匿名化业务
联系数据、阻止未来处理、保留授权见证与审计。不得发送自然人身份、联系方式、
授权证明正文或上游 Token。

回执必须逐字绑定请求上下文，声明 `deleted|anonymized|crypto_shredded`、
`processingBlocked=true`、只保留 `consent_attestation` 与 `audit_log`，存储必须为
`immutable_worm|append_only_ledger`，并满足政策保留期。响应体 SHA-256 摘要经
目标独立 Ed25519 密钥签名；Key ID、签名、摘要、上下文、未来时间、可变存储或
保留期任一不匹配均失败关闭。

## 4. REST、事件、MCP 与审计

- REST：`GET /care/alumni-consents/:id/cleanup-status`，Scope
  `erp:care:alumni:cleanup:read`。不返回证明摘要、证明引用、错误正文或自然人信息。
- CloudEvent：
  `cn.gaoq.erp.care.alumni_cleanup.scheduled|completed|dead|replayed.v1`，只含
  目的、终止原因、目标、政策版本、状态、尝试次数和受控重放原因码。
- MCP：R0 Tool `care_alumni_cleanup_status_get`、Resource
  `erp://care/alumni-consents/{id}/cleanup`、Prompt
  `care_alumni_cleanup_status_guide`。三者复用应用服务，只返回终态、总体状态和
  固定计数；AI 不得执行清理、重放、重建或恢复授权。
- Worker 外部调用按 R2 审计；REST/MCP 读取按 R1/R0 审计。审计成功写入异常与
  已完成外部副作用必须分开分类，禁止把成功终态回写成失败。

## 5. 迁移、对账与人工恢复

先在影子库检查自然键与证明摘要重复，再执行独立追加索引：

```bash
pnpm --filter @gaoq/erp-api migrate:phase3:care-alumni-cleanup-indexes -- --dry-run
pnpm --filter @gaoq/erp-api migrate:phase3:care-alumni-cleanup-indexes
pnpm --filter @gaoq/erp-api reconcile:phase3:care-alumni-cleanup
```

仓库内每次变更必须执行独立不可回退门禁：

```bash
pnpm quality:care-alumni-cleanup-coverage
```

该门禁覆盖协调器与执行应用服务，语句、分支、函数和行阈值均固定为 90%，并由
根目录 `pnpm check` 调用；不得排除任一目标生产文件或复用其他报告目录。

对账为只读，只输出状态计数、逾期待处理、陈旧锁、状态/证明不一致、重复自然键、
重复证明摘要、终止授权漏任务和 Outbox TTL 窗口内漏终态事件。`ready=false` 时
必须阻断发布并由人工分类。

目标在授权终止后新增，或原始终止 Outbox 已缺失/已死时，先对全部终态授权执行
只读覆盖扫描，再由变更单批准全局重建：

```bash
pnpm --filter @gaoq/erp-api rebuild:phase3:care-alumni-cleanup -- --dry-run
pnpm --filter @gaoq/erp-api rebuild:phase3:care-alumni-cleanup -- --apply
pnpm --filter @gaoq/erp-api reconcile:phase3:care-alumni-cleanup
```

重建工具只从权威 `withdrawn|expired` 授权的原版本、原目的和原终止时刻恢复
缺失/已死源事件，不直接创建清理任务；运行时 relay 仍是唯一扇出方。新鲜
`dispatching` 源事件、目标登记为空、终止时刻缺失或状态冲突均失败关闭。
`dead` 任务只能经渠道与隐私负责人审批，以精确版本和受控原因码重放：

```bash
pnpm --filter @gaoq/erp-api replay:phase3:care-alumni-cleanup -- \
  --dry-run --tenant-id TENANT --task-id TASK --expected-version VERSION \
  --reason-code TARGET_OWNER_APPROVED
pnpm --filter @gaoq/erp-api replay:phase3:care-alumni-cleanup -- \
  --apply --tenant-id TENANT --task-id TASK --expected-version VERSION \
  --reason-code TARGET_OWNER_APPROVED
```

## 6. SLO、告警与保留

- 指标：
  `gaoq_care_alumni_cleanup_transition_total{operation,outcome}`、
  `gaoq_care_alumni_cleanup_dispatch_duration_seconds{outcome}`、
  `gaoq_care_alumni_cleanup_backlog{status}`、
  `gaoq_care_alumni_cleanup_oldest_age_seconds{status}`。禁止使用租户、授权、任务、
  目标或证明摘要作标签。
- 目标：终止事件 5 分钟内形成全部登记任务，99% 任务 30 分钟内完成，100% 在
  24 小时内完成或进入有负责人的人工处置；证明验证失败不得降级放行。
- 告警：relay 连续 5 分钟失败、最老 pending 超 15 分钟、锁超 15 分钟、任一
  dead、证明失败或对账 `ready=false`，立即通知隐私与集成值班。
- 清理证明摘要、政策与签名元数据至少保留 2,555 天；证明正文位于独立权限域
  WORM/追加账本。本系统只能声明可检测篡改，缺少独立锚定时不得宣称完整不可抵赖。

## 7. 现场验收清单

- 对撤回和到期分别覆盖 CRM、通知、校友平台真实删除/匿名化及未来处理阻断。
- 演练重复、乱序、超时、签名错、摘要错、政策漂移、可变存储、短保留期、外部
  成功后本地事务失败、队列丢失和 Worker 重启，重复业务副作用必须为零。
- 验证跨租户、缺 Scope、伪造目标、客户端租户、Token/证明泄漏全部拒绝。
- 连续对账确认 `dead=0`、`ready=true`，归档指标、审批重放、WORM 保留策略、
  恢复演练和业务签署。未完成现场证据前保持“外部验收待完成”。
