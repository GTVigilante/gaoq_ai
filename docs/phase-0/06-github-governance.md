# 告趣ERP（GaoQ-OS）GitHub 治理规范

- 文档编号：phase-0/06
- 版本：v1.1
- 状态：规范约定；Milestone、Issue、标签和 Draft PR 已配置，Project 看板因最小
  权限未授权仍待 Issue #41 配置，实时边界见
  [仓库实施完成度审计](../implementation-completion-audit.md)
- 适用范围：告趣ERP 全部 GitHub 仓库的 Issue、Project、分支、PR、CI 与版本管理

---

## 0. 角色与红线

- Codex：首席架构师，负责架构决策、安全审计、CR（用 `[OK]` / `[CR]` 标记）。
- Kimi：执行代理，只执行 Codex 下发或人类转述的指令，产出必须可复核（diff / 文件列表 / 日志）。
- 红线：任何人（含 AI 代理）未经明确授权不得执行 `git push --force`、删除分支、关闭他人的 Security Issue、修改 main 分支保护规则。

---

## 1. Milestone（Phase 0–6）

固定 7 个 Milestone，与项目阶段一一对应：

| Milestone | 名称 | 目标（验收口径） | 退出条件 |
|-----------|------|------------------|----------|
| Phase 0 | 治理与规范 | 多租户基线、本套规范文档、仓库治理配置完成 | 全部规范文档经 Codex CR 通过；CI 骨架可运行 |
| Phase 1 | 基座模块 | auth/org/security 模块可运行，多租户贯穿 | 钉钉+飞书 SSO 登录演示通过 |
| Phase 2 | 审批与工作流 | approval-module 替代氚云核心场景 | 现有审批模板迁移清单 100% 覆盖 |
| Phase 3 | 人才与学习 | recruitment + onboarding + knowledge + care + e签宝首发 | 候选人到员工、签署与培训链路通过 |
| Phase 4 | 薪酬与考勤 | payroll + 考勤归集 + 银行/税务文件 + 对账 | 两个完整薪酬周期影子计算且未解释差异为零 |
| Phase 5 | OP与生产加固 | OP桥接、移动端、分析、迁移与生产加固 | 性能、安全、容灾和全量迁移预验收通过 |
| Phase 6 | 大切换与稳定化 | 三次演练、统一大切换、旧系统只读、观察期 | Go/No-Go门禁通过且完成四周Hypercare |

- 每个 Issue/PR 必须归属且仅归属一个 Milestone。
- Milestone 的关闭由 Codex 按退出条件裁决，禁止"到期即关"。

---

## 2. Issue 类型

六类，用 `type:*` 标签区分，Issue 标题加前缀：

| 类型 | 前缀 | 用途 | 必填模板 |
|------|------|------|----------|
| Epic | `[Epic]` | 跨模块、跨迭代的大的工作包，只做拆解不直接开发 | Epic 模板 |
| Story | `[Story]` | 用户视角的完整功能切片，可验收 | Story 模板 |
| Task | `[Task]` | 技术任务（重构、迁移、脚本、文档） | Task 模板 |
| Bug | `[Bug]` | 已验收功能的缺陷 | Bug 模板 |
| ADR | `[ADR]` | 架构决策记录，正文即决策内容 | ADR 模板 |
| Security | `[Security]` | 安全问题（默认私密流程，见 §9） | Security 模板 |

规则：
- Epic 只挂 Story/Task 子 Issue，不直接挂 PR；Epic 的 DoD = 全部子 Issue 关闭 + 验收记录。
- 一个 Story 超过 5 个工作日必须拆小；Task 超过 2 个工作日必须说明原因。
- Bug 必须挂发现环境标签（`env/dev`、`env/staging`、`env/prod`）。

---

## 3. 标签体系

四组正交标签，禁止混用：

| 组 | 前缀 | 取值 |
|----|------|------|
| 类型 | `type:` | `epic`、`story`、`task`、`bug`、`adr`、`security` |
| 模块 | `domain:` | `platform`、`identity`、`org`、`approval`、`payroll`、`recruitment`、`knowledge`、`onboarding`、`care`、`security`、`integration`、`mcp`、`op`、`frontend`、`devops`、`docs` |
| 阶段 | `phase:` | `0`至`6` |
| 优先级 | `priority:` | `p0`、`p1`、`p2`、`p3` |
| 风险 | `risk:` | `r0`、`r1`、`r2`、`r3` |
| 状态辅助 | `status:` | `implementation-delivered`、`external-acceptance`、`blocked`、`needs-info`、`wontfix`、`duplicate` |

环境标签 `env:dev|staging|prod` 仅 Bug 使用。

标签纪律：
- 每个 Issue 至少 1 个 `type:*` + 1 个 `domain:*` + 1 个 `phase:*` + 1 个 `priority:*`；MCP可触达操作另加`risk:*`；
- `priority:p0` 只能由产品负责人、首席架构师或值班负责人设置；
- 新标签需经 ADR 或治理 Issue 评审后加入，禁止随手建标签。

交付状态纪律：

- `status:implementation-delivered` 表示仓库内代码、契约、测试、脚本或运行手册
  已交付并有可复核路径；它不表示已合入 `main`、Hosted Actions 已运行或生产验收
  已通过。
- `status:external-acceptance` 表示仍需真实外部系统、目标基础设施、生产等价环境、
  业务 UAT、人工签署、切换或 Hypercare 证据。
- 两个标签可以同时存在，用于明确“工程实现已交付、外部验收未完成”；禁止以
  `implementation-delivered` 关闭仍有外部验收项的 Issue。
- `status:blocked` 必须在正文写明阻塞原因、解除条件和责任边界；账号付费限制、
  缺少 GitHub 权限和缺少目标环境均不得伪装成代码失败。
- Epic 只有在全部仓库内子项都具备实施证据后才能添加
  `status:implementation-delivered`；只有全部子 Issue 满足 DoD 并关闭后才能进入
  Project 的 `Done`。

---

## 4. Issue 模板必填项

### 4.1 Epic

- 目标与业务价值；范围（做什么/不做什么）；子 Issue 清单（可后续补挂）；关联 Milestone；验收口径。

### 4.2 Story

- 用户故事（作为……我希望……以便……）；**验收标准（可测试的 Given/When/Then 至少 1 条）**；涉及模块与租户影响说明；关联 Epic；预估工作量。

### 4.3 Task

- 任务描述；产出物（文件/命令/配置）；验证方式；关联 Epic 或 Story。

### 4.4 Bug

- 环境（`env/*` 标签 + 版本/commit）；复现步骤；期望行为 vs 实际行为；影响范围（租户/模块/数据量）；日志或截图；怀疑根因（可空）。

### 4.5 ADR

- 背景与约束；候选方案（至少 2 个，含放弃理由）；**最终决策**；影响范围与迁移成本；关联 Issue/PR。ADR 一旦被 Codex 标记 `[OK]` 即为冻结决策，变更必须新开 ADR 并标注"替代 ADR-N"。

### 4.6 Security

- 按 GitHub Private Vulnerability Reporting 流程提交；不在公开 Issue 描述漏洞细节，公开面只写影响版本与修复进度。详见 §9。

---

## 5. GitHub Project 状态流转

统一一个 Project 看板（按 Milestone 视图切换），状态列固定：

```
Backlog → Ready → In Progress → In Review → Security Review → UAT → Done
```

- `Backlog`：已建档但未达 DoR；
- `Ready`：满足 §7 DoR，可被认领；
- `In Progress`：有指派人 + 有进行中的 Draft PR 或明确的执行记录；
- `In Review`：PR 已转 Ready for review，等待 CR/CI；不涉及安全或业务验收的文档项可跳过后续专门列；
- `Security Review`：R2/R3、L3/L4数据、身份、租户、权限、合同、薪酬及外部连接的强制安全复核；
- `UAT`：需要业务验收的Story由产品、HR、财务或法务验证；
- `Done`：满足 §7 DoD，由评审人移动到 Done，不允许执行人自评 Done。

周会节奏：每周过一遍 `In Progress` 超过 5 天无更新的 Issue，要么更新进展，要么退回 `Ready` 并说明。

---

## 6. 分支、Commit 与 PR

### 6.1 分支模型

- `main`：受保护，永远可发布；只允许经 PR 合入。
- 不启用`develop`长期分支，所有工作从`main`创建短期分支并经PR合回。
- 人工功能分支命名：`<type>/<issue号>-<简述>`；Codex执行分支使用`agent/<简述>`。
- 长期分支禁止；分支存活超过 10 个工作日必须 rebase 并说明。

### 6.2 Commit 规范（中文）

格式：`[模块] 操作：中文说明`，例：

```
[组织] 新增：部门树变更事件outbox落库
[薪酬] 修复：回盘部分成功时冻结批次
[规范] 更新：补充集成死信处置约定
```

- 操作使用中文动词，如`新增/修复/更新/重构/测试/安全`；说明和正文均使用中文；
- 一个 commit 只做一件事；禁止把格式化、无关重构混进功能 commit；
- 禁止提交：临时调试日志、硬编码密钥/token/账号、重复索引与 ORM warning（沉淀自 CR #1）。

### 6.3 PR 流程

1. 开工即开 **Draft PR**（标题前缀 `WIP:` 可选，Draft 状态为准），让 CI 尽早跑；
2. 自测完成、勾完 PR 模板清单后转 Ready for review；
3. **CR**：由 Codex（或其指定评审人）评审，反馈必须带 `[OK]` / `[CR]` 标记；存在未解决的 `[CR]` 项时禁止合入；
4. 合入方式：Squash merge（保留 PR 标题为 commit 摘要）；涉及多模块的架构性 PR 可用 merge commit，由评审人决定；
5. PR 描述必须关联 Issue（`Closes #123`），并写明验证证据（命令 + 输出摘要，或"未能验证 + 原因"——本机缺工具时必须如实说明）。

### 6.4 CI 门槛（Phase 0 骨架起配，逐 Phase 加严）

- 必过：lint + 类型检查 + 单元测试 + 安全扫描（依赖漏洞 + 密钥扫描）；
- PR 合入前 CI 全绿；`main` 红时冻结非 hotfix 合入；
- hotfix 走 `hotfix/<issue号>-*` 分支，评审不可省略，事后 24h 内补测试。

---

## 7. DoR / DoD

### 7.1 DoR（Ready 准入）

- [ ] 使用对应模板且必填项完整（Story 有可测试的验收标准）
- [ ] 归属唯一 Milestone，类型/模块/阶段/优先级标签齐全
- [ ] 涉及外部集成的，已对照 `docs/phase-0/03-integration-standard.md` 上线检查清单自评
- [ ] 涉及架构/安全/跨模块决策的，已有 `[OK]` 状态的 ADR
- [ ] 工作量已估，超阈值已拆分（见 §2）

### 7.2 DoD（Done 标准）

- [ ] 代码或文档合入 `main`，CI 全绿
- [ ] 新增/变更逻辑有对应测试，关键路径不无测试上线
- [ ] 验收标准逐条验证通过，验证证据（命令/截图/日志）留在 Issue 或 PR
- [ ] 无临时调试代码、无新增 warning、无硬编码敏感信息
- [ ] 涉及的规范/文档（含 AGENTS.md 约定项）已同步更新
- [ ] Codex CR 闭环：所有 `[CR]` 项已解决并复核为 `[OK]`

---

## 8. 版本与变更管理

- 版本号：SemVer，`v<主>.<次>.<补丁>`；Phase 0–5 期间主版本为 0（`v0.x.y`），Phase 6 大切换完成后发布 `v1.0.0`。
- 每次发布打 Git Tag + GitHub Release，Release Notes 中文，按"新增 / 变更 / 修复 / 安全 / 迁移说明"分组，条目关联 Issue 号。
- 破坏性变更（API、事件 schema、数据迁移）必须：提前一个版本在 Release Notes 预告 + 提供迁移脚本或说明 + ADR 登记。
- 变更冻结：大切换窗口（Phase 6 内由 Codex 宣布）内只允许 hotfix。
- 生产变更一律关联 Issue；无 Issue 的生产配置变更视为违规。

---

## 9. 安全 Issue 特别流程

- 漏洞报告走 GitHub Private Vulnerability Reporting（或私有安全渠道），不走公开 Issue；
- 公开侧只建 `type:security` 占位 Issue：标题不含漏洞细节，只含影响版本与状态；
- 修复 PR 引用私有 advisory，合入后统一在 Release Notes 披露；
- 安全修复的 DoD 额外要求：攻击面回归用例 + 同类问题全仓排查记录。

---

## 10. 现有空 Issue 迁移规则

针对仓库中已存在的空 Issue（无模板必填项、无标签、无 Milestone）：

1. **盘点**：Phase 0 内一次性导出全部现有 Issue 清单（编号、标题、创建人、创建时间），登记到治理 Issue 中。
2. **分类**（由 Codex 逐条裁决）：
   - 仍有效 → 创建人（或指定人）**7 天内**按对应模板补全必填项、补齐类型/领域/阶段/优先级标签与 Milestone；逾期未补全自动转 `status:needs-info` 并退回 Backlog；
   - 已被新规划覆盖 → 打 `status:duplicate`，评论指向新 Issue 后关闭；
   - 已失效 → 打 `status:wontfix`，注明原因后关闭。
3. **不删历史**：空 Issue 只关闭不删除，保留编号连续性；关闭评论必须给出去向（补全 / 重复 / 失效）。
4. **迁移完成后**：未按新模板创建的 Issue 一律退回补全，不再享受宽限期。
5. 迁移完成以"治理盘点 Issue 中每条记录都有处置结果"为验收标准。

---

## 11. 附：治理自身的变更

本文件的修改必须走 `type:adr` 或 `domain:docs` Issue + PR，经 Codex `[OK]` 后合入；执行代理（Kimi）不得在无 Codex 指令的情况下变更本规范。
