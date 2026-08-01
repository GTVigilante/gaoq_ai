# Phase 5 性能容量三次实测门禁

- 文档编号：phase-5/15
- 状态：压测脚本、v2 可验签证据校验器与受保护现场验收工作流已交付；三次
  生产等价实测和真实职责签署尚未执行

## 测试边界

性能测试只能在与生产拓扑、规格、索引和观测配置等价的隔离环境运行，禁止对生产流量执行。环境至少包含 3 节点 MongoDB Replica Set、Redis Sentinel 或 Cluster、3 个 API 副本和 2 个 Worker 副本；外部 OP、钉钉、飞书、e签宝、银行、税务和 WORM 依赖必须使用沙箱或受控替身。

`scripts/load/phase-5-api-capacity.js` 使用 k6 2.0.0 对组织树、审批待办和管理驾驶舱执行只读混合负载：5 分钟升至 1000 VU，稳定 20 分钟，再用 5 分钟降载。必须由 Secret Manager 在运行时挂载至少 1000 个不同测试身份的 Token JSON 文件；文件不进入仓库、命令行、日志或结果。脚本没有 POST、PUT、PATCH、DELETE，禁止扩展为写压测。

工资容量不由 k6 或 AI 直接触发。薪酬负责人在隔离租户按既有受控工资状态机运行恰好 1000 人的完整计算，银行和税务模式保持 sandbox，禁止代发、申报或其他外部副作用。运行平台只输出人数、耗时、状态、错误数、结果摘要和证据摘要，不输出员工、金额、账号或规则正文。

## API 执行

固定并校验官方 k6 2.0.0 二进制摘要后执行；Linux amd64 发布包摘要固定为 `sha256:2ae87d976f6cdba17185bdd980d8819a3a98e9092c6f0638cd58272ecefc8b90`。CI 会从官方发布地址下载、校验摘要并运行 `k6 inspect` 与证据契约自测。以下路径均位于受控证据目录。`PERFORMANCE_INSPECT_ONLY` 只允许做脚本语法检查，负载函数会主动拒绝在该模式发送请求：

```bash
PERFORMANCE_BASE_URL=https://erp-capacity.example.com \
PERFORMANCE_AS_OF=2026-07-01 \
PERFORMANCE_TOKEN_FILE=/secure/performance/tokens.json \
PERFORMANCE_API_RESULT_PATH=/secure/performance/run-1-k6.json \
k6 run scripts/load/phase-5-api-capacity.js
```

阈值为：业务错误率不高于 0.1%；组织/审批核心读 P95 小于 500ms、P99 小于 1 秒；管理驾驶舱 P95 不高于 2 秒、P99 不高于 5 秒。k6 阈值失败必须返回非零，禁止使用 `--no-thresholds` 或修改结果文件将失败改为成功。

## 三次证据契约

性能平台把原始 k6 摘要、工资受控运行摘要、基础设施快照、监控快照、日志查询
和三方签署组装为严格字段白名单的 `gaoq.phase5.capacity.v2` JSON。证据不接受
URL、Token、租户 ID、员工明细、金额、账号或规则正文。每份证据必须满足：

- 生产等价但非生产流量；恰好 1000 VU、1800 秒、错误率和各端点延迟全部达标；
- 数据集恰好 1000 人，工资计算少于 300000ms、状态 completed、错误为零、外部副作用为 false；
- API/Worker/ERP Web/Website 镜像均以 `sha256:` digest 标识；commit、k6 二进制、压测脚本和原始证据都有 SHA-256；
- 部署清单以 SHA-256 固定，并与四类镜像、commit、环境名和区域共同绑定；
- 性能、平台、安全三类负责人使用不同主体、不同证据 ID、不同意见摘要和
  不同 Ed25519 公钥分别签署；
- 每个 `keyId` 等于对应 SPKI DER 公钥的 SHA-256；按角色排序的三方
  `{role,keyId}` 规范 JSON 摘要必须与 Repository Variable
  `PERFORMANCE_SIGNER_KEYSET_SHA256` 完全一致；
- 三次运行必须使用同一角色主体和受信 keyset；运行 ID、负载结果、工资运行
  证据、监控快照、日志查询、九份签署证据、意见与签名均不得复用，但 commit、
  镜像、数据集、环境、区域和基础设施完全一致。

每次运行结束后 72 小时内，三方必须完成 `approve` 和签名。共同批准 payload
覆盖环境、commit、k6 版本与摘要、压测脚本、部署清单、四类镜像、数据集、API
负载与阈值、工资容量结果、基础设施、三份工件和三方批准元数据。每位负责人再
以职责密钥签署共同 payload 摘要、自身角色、keyId 和签署时间。伪签名、角色
换钥、主体/公钥/证据/意见/签名复用、签后篡改、超时签署、三次 keyset 或角色
主体漂移均失败关闭。

三次证据完成后执行：

```bash
pnpm --silent performance:print-contract \
  > /secure/performance/phase-5-capacity-contract.json
pnpm performance:validate -- \
  /secure/performance/run-1.json \
  /secure/performance/run-2.json \
  /secure/performance/run-3.json
```

校验器仅输出运行 ID、commit、受信 keyset 摘要、三份批准 payload 摘要和
`comparisonChecksum`。任一阈值失败、环境不一致、证据重复、缺少签署、验签
失败、职责漂移或出现外部副作用，三次计数全部重新开始。

`.github/workflows/phase-5-performance.yml` 只允许在 `main` 手工启动，使用
`phase-5-performance` workflow policy 和 GitHub Hosted `ubuntu-latest`。
Repository Variables 配置环境名、区域、API/Worker/ERP Web/Website
镜像 SHA-256、部署清单 SHA-256，以及三份脱敏证据各自的 HTTPS URL、预期
SHA-256、共同专用 OIDC audience 和 `PERFORMANCE_SIGNER_KEYSET_SHA256`。
工作流以当前 policy 的单次 GitHub
OIDC 身份拉取三份 JSON，逐份限制 256 KiB、严格复核媒体类型与传输/字节摘要，
并以 `0600` 写入 `$RUNNER_TEMP`；随后绑定当前 commit、环境、区域、四镜像、
部署清单和受信 keyset。工作流只上传脱敏比较结论，不上传原始负载、工资、
监控、日志、Token、公钥或签署材料。

## Go/No-Go

自动门禁通过仍不等于生产放行。需联合检查 CPU、内存、事件循环、Mongo 查询/锁/复制延迟、Redis 延迟、队列积压、审计写入、错误预算和扩缩容行为；任何资源持续超过 70%、审计失败、队列 failed 非零、复制落后或数据摘要不一致均为 No-Go。原始结果、监控和日志证据必须进入不可变制品库并关联 commit 与镜像 digest。

仓库自测只生成临时 Ed25519 密钥且不保存私钥。真实人员身份、IAM/KMS/HSM
职责与角色密钥绑定、三次生产等价运行、监控复核、联合签署和企业 WORM 原始
材料仍须现场验收。
