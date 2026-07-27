# Knowledge 考试编排与评分运行手册

## 交付边界

课程版本不可变地锁定题型、答题时限、最大次数、评分策略版本、通过规则、自动评分 SLA 和人工复核 SLA。客观题可自动评分；主观题与混合题必须进入人工复核。ERP 只保存题库与试题集摘要、不透明会话/提交/证据引用和最终结论，禁止保存题目、答案、标准答案、下载地址或网关 Token。

REST 契约如下：

- `POST /knowledge/assignments/:id/exam-runs`，Scope `erp:knowledge:exam:start`，必须提供 `Idempotency-Key`，返回 `202`、`ETag` 与 `Retry-After`。
- `POST /knowledge/exam-runs/:id/submit`，Scope `erp:knowledge:exam:submit`，必须提供强 `If-Match` 与 `Idempotency-Key`；正文只允许 `submissionRef`，返回 `202`、`ETag` 与 `Retry-After`。
- `GET /knowledge/exam-runs/:id`，Scope `erp:knowledge:exam:read`；员工用户只可读取当前有效任职对应的本人考试。
- 旧 `/knowledge/assignments/:id/exam-attempts` REST 路由已移除，任何题型均不得绕过考试运行状态机直接形成最终成绩。

评分网关端点固定为 `/v1/exam-runs/start`、`/v1/exam-runs/timeout`、`/v1/exam-runs/finalize` 和 `/v1/exam-runs/status`。每份 Ed25519 签名回执必须逐字段绑定租户、运行、任务、课程、次数、题库引用及摘要、题型、评分策略、通过规则、人工复核要求、SLA、会话、试题集、提交引用、超时标记及时间。网关不得返回题目、答案或访问凭据。

## 可靠性与安全

MongoDB `knowledge_exam_runs` 是唯一运行事实源；BullMQ 只每 15 秒以空载荷唤醒 Worker。状态机为：

`starting → in_progress → submitted → pending_review → graded`

任一网关步骤最多 8 次指数退避，之后进入 `dead`；评分网关连续 5 次失败后熔断 30 秒，半开仅允许一个探测。到达 `deadlineAt` 后只能调用受信任的超时端点形成不透明提交引用，客户端迟到提交失败关闭。最终 `knowledge_exam_attempts` 与 `graded` 状态在同一 Mongo 事务形成，状态迁移事件使用同事务 Outbox；业务提交后的审计故障单独记录，不得把已成功终态回写为失败。

事件固定为：

- `cn.gaoq.erp.knowledge.exam.run.requested.v1`
- `cn.gaoq.erp.knowledge.exam.run.started.v1`
- `cn.gaoq.erp.knowledge.exam.run.submitted.v1`
- `cn.gaoq.erp.knowledge.exam.run.timed_out.v1`
- `cn.gaoq.erp.knowledge.exam.run.review_pending.v1`
- `cn.gaoq.erp.knowledge.exam.graded.v1`
- `cn.gaoq.erp.knowledge.exam.run.dead.v1`
- `cn.gaoq.erp.knowledge.exam.run.replayed.v1`

事件不含题库引用、试题集摘要、会话、提交引用、评分证据、题目或答案。

低基数指标固定为 `gaoq_knowledge_exam_run_transition_total{operation,outcome}`、`gaoq_knowledge_exam_run_last_success_timestamp_seconds{operation}`、按固定状态的 backlog/最老年龄以及 `gaoq_knowledge_exam_grading_duration_seconds{review_mode}`。禁止租户、员工、运行或课程标签。

## 发布与运维

先在生产等价影子库执行：

```bash
pnpm --filter @gaoq/erp-api migrate:phase3:knowledge-exam-indexes -- --dry-run
pnpm --filter @gaoq/erp-api migrate:phase3:knowledge-exam-indexes
pnpm --filter @gaoq/erp-api reconcile:phase3:knowledge-exams
```

对账命令只读输出状态聚合、过期动作、陈旧锁、SLA 违约、最终尝试错位、孤立尝试、最近终态 Outbox 缺口、人工介入数量和 `ready` 判定。死信必须经人工确认根因后先 dry-run，再使用相同租户、运行、版本和受控原因码显式应用：

```bash
pnpm --filter @gaoq/erp-api replay:phase3:knowledge-exam -- \
  --dry-run --tenant-id <TENANT_ID> --run-id <ULID> \
  --expected-version <N> --reason-code GATEWAY_RECOVERED

pnpm --filter @gaoq/erp-api replay:phase3:knowledge-exam -- \
  --apply --tenant-id <TENANT_ID> --run-id <ULID> \
  --expected-version <N> --reason-code GATEWAY_RECOVERED
```

重放使用租户及版本门禁，只按已形成的最远证据恢复到 `starting`、`in_progress`、`submitted` 或 `pending_review`，并在同一事务把受控 `replayReason`、`replayedAt` 写回权威运行记录并发布 `replayed` Outbox 事件；两处事实使用同一时间与原因码，便于对账。不改分数、不伪造证据、不绕过最大次数。原因码只允许大写受控编码，不接受可能包含敏感信息的自由文本。

标准 AI 对接只读能力固定为 Tool `knowledge_exam_run_get`、Resource Template `erp://knowledge/exam-runs/{id}`、Prompt `knowledge_exam_run_status_guide`。三者复用应用服务和本人任职校验；不提供开始、提交、评分、复核或重放 MCP Tool。

真实评分沙箱仍必须覆盖客观/主观/混合代表题集、伪造签名、摘要错配、跨租户、超时边界、网关断连、人工复核积压、重复回执、SLA、性能、安全与业务 UAT。本地替身通过不等于外部验收完成。
