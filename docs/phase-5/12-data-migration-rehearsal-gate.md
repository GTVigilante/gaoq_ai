# Phase 5 数据迁移三次演练证据门禁

本门禁用于验证三次真实全量迁移演练的可重复性、幂等性和控制总量，不创建测试数据、不代替来源系统抽取，也不把本地工具结果冒充外部验收。三次演练必须使用同一份已批准来源快照、三个不同 `sourceRunId`，并分别形成冻结运行的完整证据 NDJSON。

每轮必须按来源包手册完成全部已启用 Scope；考勤链后执行薪资规则与薪酬档案。规则包核验 approved 历史、法规摘要、确定性规则校验、连续版本与区间；薪酬档案核验员工/approved 历史、L4 密文、目标 `profileHash`、连续版本、不重叠区间和逐条 WORM，并证明没有普通 attest、计算、审批、支付或税务副作用。任一 Scope 失败即整轮失败。

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

上述命令每次只比较一个 Scope。全部已启用 Scope 都必须分别比较；当前白名单为二十六个 Scope，因此完整三轮形成七十八个独立运行。不得用任意一个 Scope 的三次通过替代整轮通过。

## 自动门禁

比较工具只接受每行都携带 `formatVersion: 1` 的证据，逐行读取且限制单行不超过 1 MiB，拒绝空行、非法 JSON、错误记录顺序、封印后追加内容、重复文件和重复运行 ID。每份证据必须满足：

- 全量运行已冻结为 `completed`，`phaseSixEligible=true` 且差异清单为空；
- 检查点、来源记录总数和来源校验和闭合，拒绝记录、未解析关联、未决附件均为零；
- 明细证据条数与聚合报告中的记录、关联和附件控制总量一致；
- 重新计算的滚动封印与文件末尾 seal 完全一致；
- 三次运行的来源系统、Scope、来源总数、来源校验和、目标校验和、关联数和附件数完全一致。

首轮通常产生 `applied`，后续幂等复跑可能产生 `duplicate`，因此比较的是目标事实校验和与总控制量，不错误要求 applied/duplicate 分布一致。通过后只向标准输出返回不含 payload、姓名和 Token 的比较摘要及 `comparisonChecksum`。

## 全链路聚合验收

每个 Scope 的比较摘要必须按控制面唯一事实源中的固定顺序写入 `gaoq.phase5.migration-rehearsal.v1` 聚合证据。聚合证据精确覆盖全部二十六个 Scope、三轮七十八个不重复 runId/封印、每轮不超过八小时的窗口、同一来源快照与来源包清单，以及中断续传、附件网关短暂不可用、重复输入三类故障演练。任何 Scope 缺失、次序变化、运行/封印/比较摘要复用、Critical/High 差异、审计失败或生产副作用均失败关闭。

聚合证据同时绑定发布 commit、API/Worker/ERP Web/Website 四类镜像摘要、部署清单、生产等价隔离环境与区域，并要求架构、安全、数据和业务负责人使用不同证据 ID 签署。校验器输出的 suite 固定为 `gaoq.phase5.migration-rehearsal.verdict`，供 Go/No-Go 的 migration 门禁消费：

```bash
pnpm --silent migration:rehearsal:print-contract > /secure/migration/contract.json
pnpm migration:rehearsal:validate-evidence -- \
  /secure/migration/phase-5-rehearsal.json
```

`.github/workflows/phase-5-migration-rehearsal.yml` 只允许在 `main` 手工启动，绑定 Required Reviewers 保护的 `phase-5-migration-rehearsal` Environment，并使用带同名标签的隔离单次 self-hosted Runner。只读现场摘要固定为 `/var/lib/gaoq/migration/phase-5-rehearsal.json`，不得为符号链接、不得允许组或其他用户写入，最大 1 MiB。Environment 固定环境、区域、四类镜像、部署清单、来源快照和来源包清单摘要；GitHub 只上传脱敏 verdict，原始 NDJSON、业务数据、附件和签署材料留在企业 WORM。

## 人工与外部门禁

自动比较通过后仍须保存三次运行的变更单、执行人、复核人、时间窗口、监控快照、停止条件、故障注入记录和恢复记录。至少覆盖一次中断续传、一次附件网关短暂不可用和一次重复输入；任何一次发生 Critical/High 差异、SLO 越线、审计链异常或来源快照变化，三次计数全部重新开始。

证据文件按 L2 加密保存并限制访问；附件正文、来源凭据和个人敏感字段不得进入证据。架构、安全、数据负责人和业务负责人完成签署前，不得把 Phase 5 迁移预验收或 Phase 6 三次演练标记为完成。
