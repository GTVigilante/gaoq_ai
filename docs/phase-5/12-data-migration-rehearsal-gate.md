# Phase 5 数据迁移三次演练证据门禁

本门禁用于验证三次真实全量迁移演练的可重复性、幂等性和控制总量，不创建测试数据、不代替来源系统抽取，也不把本地工具结果冒充外部验收。三次演练必须使用同一份已批准来源快照、三个不同 `sourceRunId`，并分别形成冻结运行的完整证据 NDJSON。

每轮必须按来源包手册完成全部已启用 Scope；`recruitment_reference` 位于审批 Scope 之后，且包内 HC 必须早于职位；`recruitment_candidates` 随后独立执行，并核验目标集合无身份明文、盲索引可精确检索且证据导出无 PII。任一 Scope 失败即整轮失败，不能用后续 Scope 的成功掩盖前置引用差异。

## 执行顺序

每次演练均在隔离环境按以下顺序执行，令牌只通过环境变量注入：

```bash
pnpm --filter @gaoq/erp-api migration:package -- validate /secure/rehearsal-1/package
pnpm --filter @gaoq/erp-api migration:package -- apply /secure/rehearsal-1/package
pnpm --filter @gaoq/erp-api migration:package -- evidence 01J8ZQK7V0A2M4N6P8R0T2W4F1 > /secure/rehearsal-1/evidence.ndjson
```

三次证据形成后执行：

```bash
pnpm --filter @gaoq/erp-api migration:package -- compare \
  /secure/rehearsal-1/evidence.ndjson \
  /secure/rehearsal-2/evidence.ndjson \
  /secure/rehearsal-3/evidence.ndjson
```

## 自动门禁

比较工具只接受每行都携带 `formatVersion: 1` 的证据，逐行读取且限制单行不超过 1 MiB，拒绝空行、非法 JSON、错误记录顺序、封印后追加内容、重复文件和重复运行 ID。每份证据必须满足：

- 全量运行已冻结为 `completed`，`phaseSixEligible=true` 且差异清单为空；
- 检查点、来源记录总数和来源校验和闭合，拒绝记录、未解析关联、未决附件均为零；
- 明细证据条数与聚合报告中的记录、关联和附件控制总量一致；
- 重新计算的滚动封印与文件末尾 seal 完全一致；
- 三次运行的来源系统、Scope、来源总数、来源校验和、目标校验和、关联数和附件数完全一致。

首轮通常产生 `applied`，后续幂等复跑可能产生 `duplicate`，因此比较的是目标事实校验和与总控制量，不错误要求 applied/duplicate 分布一致。通过后只向标准输出返回不含 payload、姓名和 Token 的比较摘要及 `comparisonChecksum`。

## 人工与外部门禁

自动比较通过后仍须保存三次运行的变更单、执行人、复核人、时间窗口、监控快照、停止条件、故障注入记录和恢复记录。至少覆盖一次中断续传、一次附件网关短暂不可用和一次重复输入；任何一次发生 Critical/High 差异、SLO 越线、审计链异常或来源快照变化，三次计数全部重新开始。

证据文件按 L2 加密保存并限制访问；附件正文、来源凭据和个人敏感字段不得进入证据。架构、安全、数据负责人和业务负责人完成签署前，不得把 Phase 5 迁移预验收或 Phase 6 三次演练标记为完成。
