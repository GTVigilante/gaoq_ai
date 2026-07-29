# Phase 5 跨职能 Go/No-Go 证据门禁

- 文档编号：phase-5/18
- 状态：最终证据契约与受保护验收工作流已交付；现场证据、跨职能签署和生产决定尚未形成

## 决策原则

Go/No-Go 是人工治理决定，不是 CI 成功、AI 建议或某个负责人单独批准。门禁只在
工程质量、供应链、生产镜像、三次迁移、三次容量、安全、容灾、权限、业务 UAT、
隐私合规、外部集成/MCP 和运行保障十二类证据同时通过、未过期且绑定同一发布
候选版本时生成 `GO` verdict。输入契约固定为
`gaoq.phase5.go-no-go.v3`；Verdict 不触发部署，CD 仍必须校验变更单、冻结窗口
和独立生产审批。

禁止带条件放行。Sev1/Sev2、Critical/High 漏洞、未到期安全例外、未解释数据或金额差异必须为零；`exceptions` 只能为空数组。任何证据过期、版本或环境不一致，必须重新执行相应门禁并重新签署。

## 十二类强制证据

| 门禁 | 最低要求 |
| --- | --- |
| 工程质量 | Lint、类型、单元/集成/契约/E2E、构建全部通过 |
| 供应链 | SAST、SCA、Secret Scan、许可证、SBOM、仓库与依赖扫描无阻断项 |
| 生产镜像 | API/Worker/ERP Web/Website 固定摘要、nonroot、签名、SLSA provenance、准入策略和回滚冒烟通过 |
| 数据迁移 | 固定 `gaoq.phase5.migration-rehearsal.verdict`；v2 输入已由架构、业务、数据、安全四方独立 Ed25519 签署并绑定受信 keyset；全部二十六个 Scope、三轮七十八个运行、故障演练、记录、关联、金额、附件和校验和未解释差异为零 |
| 性能容量 | 固定 `gaoq.phase5.capacity.comparison`；三份 v2 输入已由性能、平台、安全三方逐次独立 Ed25519 签署并绑定同一受信 keyset；三次独立实测满足 1000 并发、API P95 `<500ms`、业务错误率 `≤0.1%`、1000 人工资 `<300s` |
| DAST/ASVS | 固定 `gaoq.phase5.dast-asvs.verdict`；v2 输入已由 AppSec、平台、QA、风险四方独立 Ed25519 签署并绑定受信 keyset；ASVS 5.0 L2 与高风险 L3、认证/越权探针及 ZAP 主动扫描通过 |
| 容灾韧性 | RPO `≤900s`、RTO `≤14400s`；九类适配器（含独立专业算薪）断连 `≥7200s`、追赶 `≤3600s`、零丢失与重复业务效果；专业算薪 Resource、授权服务器、镜像、目录和事件契约必须与 MCP 联调结论逐字一致 |
| 权限 | 至少 200 个租户/角色/字段/数据范围矩阵用例全部通过；至少 50 次跨租户尝试全部拒绝；MCP R3 Tool 为零 |
| 业务 UAT | 审批影子至少 28 天、薪酬影子至少 2 个完整周期；八个业务域 UAT 全部通过且零未解释差异 |
| 隐私合规 | 数据清单、隐私影响评估、法定依据、保存删除和授权撤回均验证；未解决隐私发现与未批准跨境传输为零 |
| 外部集成/MCP | OP、钉钉、飞书、e签宝、银行、税务、附件、WORM、消息、ERP MCP 与专业算薪 OAuth/MCP/七类共享事件的契约、沙箱演练、凭据预检、对账全部通过 |
| 运行保障 | 监控、告警路由、值班、运行手册、备份、回滚、冻结、事故指挥、支持交接和 28 天 Hypercare 就绪 |

十二份下游 verdict 必须声明固定 suite，并以 `subjectCommitSha` 精确绑定当前发布候选 commit；不同版本的通过报告不能拼接。证据完成时间距评估不得超过 30 天，每项证据自身有效期不得超过 90 天；最终评估与决定在提交验收时均不得超过 24 小时，也不得使用未来时间。计划切换窗口结束时间和 `GO` 有效期不得晚于任何一项证据的到期时间。

其中工程质量、供应链、生产镜像、权限、业务 UAT、隐私合规和运行保障由[七类发布就绪 verdict 门禁](./20-readiness-verdicts.md)生成，不允许在最终 Go/No-Go 文档中自行声明通过。

## MCP 上线标准

MCP 固定使用 `2025-11-25`、Streamable HTTP 和 OAuth 2.1。最终能力目录必须
直接绑定仓库实时生成的完整 `catalogHash`，并精确等于 50 个 Tool、4 个静态
Resource、27 个 Resource Template 和 25 个 Prompt；Tool 风险分层固定为
R0 23、R1 19、R2 8、R3 0。陈旧哈希、遗漏 Resource Template 或只满足数量
下限均失败关闭。每个 Tool 必须同时具备输入/输出 Schema 和风险级别；直接
数据库访问、上游 Token 暴露均为零。

至少使用三类协议客户端完成同版本互操作：交互式用户 Agent、机器服务 Agent、只读审计 Agent。必须覆盖初始化协商、OAuth 发现与授权、分页、结构化输出、资源/提示（如已声明）、确认、超时、幂等、错误、跨租户拒绝和审计。至少执行 30 次跨租户尝试并全部拒绝，审计事件数不得少于 Tool 总数。具体能力目录和跨系统实测由后续 MCP 验收切片提供；没有该证据时本门禁无法通过。

专业算薪必须作为独立 OAuth 2.1 Resource Server 进入同一门禁：resource、
授权服务器、镜像摘要、平台契约版本、七类事件契约摘要和完整 MCP
`catalogHash` 均与现场 `integration-mcp` v3 verdict 一致，且该 verdict 的
原始输入已由集成、MCP、QA 和安全四方使用独立 Ed25519 职责密钥签署并绑定
受信 signer keyset。其最低目录固定为
四个 Tool、两个 Resource Template、两个 Prompt，三类客户端均完成初始化；
跨 resource Token 和错误租户各至少 30 次全部拒绝，七类事件至少回放 70 次
且全部接受当前严格契约。专业算薪与 ERP 任一侧出现 R3 Tool、缺失 Schema、
直接跨库或 Token 暴露时结论必须为 No-Go。

## 受保护工作流

`.github/workflows/phase-5-go-no-go.yml` 只能在 `main` 手工启动，使用
`phase-5-go-no-go` workflow policy 和 GitHub Hosted `ubuntu-latest`。PR、push
与 `workflow_call` 不能触发该工作流；验收作业只读
代码和证据，不承担生产部署。

Repository Variables 配置以下非敏感值：环境名、区域、API/Worker/ERP Web/Website
镜像 SHA-256、部署清单 SHA-256、证据 HTTPS URL、专用 OIDC audience、预期
证据 SHA-256，以及专业算薪 resource、授权服务器、镜像、事件契约、MCP
目录摘要和 `GO_NO_GO_SIGNER_KEYSET_SHA256`。最后一项是十方 Ed25519 公钥按
角色与 SPKI 摘要组成的规范 keyset 摘要；公钥不是秘密，私钥不得进入 GitHub。
工作流把这些值及当前 `main` commit 与证据精确绑定，以单次 GitHub OIDC 身份
读取最多 1 MiB 的脱敏 JSON，并在 `$RUNNER_TEMP` 以 `0600` 保存到作业结束。

```bash
pnpm --silent release:go-no-go:print-contract > /secure/release/go-no-go-contract.json
pnpm release:go-no-go:validate-evidence -- /secure/release/phase-5-go-no-go.json
```

GitHub 只保存 decision ID、`GO`、commit、签署 keyset 摘要、最终决策 payload
摘要和整体校验和，不上传业务数据、报告正文、签名人姓名、私钥、凭据或生产
配置。原始报告、个人签署和变更记录留在企业 WORM。

## 十方签署与窗口

项目发起人、产品、架构、安全、数据、HR、财务、法务、QA 和 SRE 必须在全部
证据评估完成后、最终决定产生前，分别以不同证据 ID、意见摘要和独立 Ed25519
密钥签署 `GO`。十把公钥必须逐角色声明且互不复用，`keyId` 必须等于公钥 SPKI
DER 的 SHA-256；受保护工作流还要把完整 keyset 与 Repository Variable 的批准
摘要比对。机器可读 contract 固定算法、编码、角色、规范化方法和两层 payload
字段；签署系统必须消费该 contract，禁止自行猜测字段顺序或序列化形式。

每份签名绑定同一最终决策 payload 摘要，以及该角色、决定、证据 ID、意见摘要
和签署时间。最终 payload 覆盖环境、commit、四镜像、部署清单、十二门禁、
全部定量验收结果、十一类外部集成、ERP/专业算薪 MCP、运行保障、切换窗口与
决定。签名长度、Base64URL 规范形式、payload 摘要、公钥角色映射或密码学验签
任一失败均为 No-Go；只改 JSON 中一个仍处于允许范围的数值也会使全部既有签名
失效。任一角色拒绝、缺席、复用密钥或超时，结论同样是 No-Go。

v3 额外把容灾汇总中的专业算薪 Resource、独立授权服务器、镜像、MCP 目录和
七类事件契约摘要与 `mcp.professionalPayroll` 逐字段比对。这样即使容灾和 MCP
联调分别通过，也不能用另一个测试替身、旧镜像、旧目录或旧事件契约拼接最终
`GO`；任一字段漂移都返回
`PHASE5_GO_NO_GO_RESILIENCE_PAYROLL_MISMATCH`。

密码学验签只证明批准的角色密钥签署了指定载荷，不单独证明现实人员身份。企业
IAM/KMS 必须把每把私钥的签署权限绑定到对应在职责任人，启用强认证、密钥轮换、
职责分离和 WORM 审计；这部分身份发行与托管证据必须在现场验收，不能由仓库自测
替代。

统一切换窗口固定为 Asia/Shanghai 周末连续 8 小时，必须在最终决定之后且不晚于任何证据有效期。`GO` 决定最长有效 7 天；窗口延期、发布候选 commit/镜像/清单变化、门禁证据更新或发生新的 Sev1/Sev2，均使原决定失效并要求重新评估和签署。

AI 与 MCP 可以在授权范围内读取脱敏门禁状态和解释差异，但不得提交签署、生成 `GO`、修改证据、批准例外、启动切换或触发回滚；这些动作均按 R3 永久不注册 Tool。
