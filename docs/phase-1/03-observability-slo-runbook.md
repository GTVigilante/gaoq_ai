# Phase 1 可观测性、SLO 与负载基线运行手册

## 1. 抓取边界

- API 指标：`GET /api/metrics`；Worker 指标：独立端口 `GET /metrics`，默认 `9464`。
- 两个端点都只接受 Secret Manager 注入的 `METRICS_BEARER_TOKEN`，不得复用用户、服务或 MCP OAuth Token。
- Worker 指标端口只承载 `/metrics`，不会装配任何 ERP 业务控制器。生产网络策略仅允许 Prometheus 抓取节点访问。
- 指标标签只允许 HTTP 方法、编译期控制器/方法、状态码和固定结果枚举；禁止租户、员工、资源 ID、trace ID 或外部响应文本进入标签。

## 2. Phase 1 指标与 SLO

| 范围 | 指标 | Phase 1 门槛 |
|---|---|---|
| HTTP 可用性 | `gaoq_http_requests_total` | 月度非计划 5xx 比例 `< 0.1%` |
| HTTP 延迟 | `gaoq_http_request_duration_seconds` | P95 `< 500ms`，P99 `< 1s` |
| 审计写入 | `gaoq_audit_append_total` | 失败数必须为 `0`；业务写入随审计失败关闭 |
| 审计并发 | `gaoq_audit_transaction_retries_total` | 5 分钟重试 `<= 10`，持续超限排查热点租户 |
| 完整性验证 | `gaoq_audit_verification_total` | 失败数必须为 `0` |
| 外部锚定 | `gaoq_audit_worm_exports_total` | 失败数必须为 `0` |
| 锚点新鲜度 | `gaoq_audit_worm_last_success_timestamp_seconds` | 任一环境不得超过 24 小时无成功锚点 |
| 队列积压/死信 | `gaoq_queue_jobs` | waiting+delayed 持续 `< 100`；failed 必须为 `0` |
| 队列采集 | `gaoq_queue_metrics_poll_failures_total` | 失败数必须为 `0` |

Prometheus 规则位于 `deploy/observability/phase-1-alerts.yml`。生产导入前必须用目标 Prometheus 版本的 `promtool check rules` 校验，并把 `critical` 路由到安全值班与平台值班双通道。

生产 Kubernetes 抓取网络边界由 [`deploy/helm/gaoq-erp`](../../deploy/helm/gaoq-erp/README.md) 强制：监控命名空间和 Prometheus Pod 必须同时匹配受控标签；API 只开放 `3001`，Worker 只开放 `9464`，Web 不向监控开放后端端口。真实集群必须验证网络插件执行了 NetworkPolicy，不能只检查 YAML。

## 3. WORM 锚定契约

Worker 每六小时选择最久未锚定的租户，先完整验链，再生成固定字段顺序的 `gaoq.audit.anchor.v1` 载荷。载荷包含租户、序号、链头哈希、审计 HMAC key id、链更新时间和请求保留期；随后由独立 Ed25519 密钥签名。

外部端点必须：

1. 使用 `payloadHash` 作为幂等键，对相同键和相同载荷返回同一回执；
2. 把载荷、签名、签名 key id 写入由另一权限域管理的合规保留/WORM 存储；
3. 返回 `receiptId`、不可变 `objectVersion`、相同 `payloadHash`、`anchoredAt` 和不早于请求值的 `retainedUntil`；
4. 禁止重定向；响应体不得超过 16 KiB；网络超时为 10 秒；
5. 独立保存 Ed25519 公钥和验签程序，定期从 WORM 平台抽样回读并验签。

生产 `AUDIT_WORM_ENDPOINT` 必须是 HTTPS、不得带凭据/查询/fragment，且不得与 ERP 授权域同源。专用私钥不得复用 OAuth 签名密钥或审计 HMAC 密钥。

## 4. 负载基线

在隔离测试环境启动 API 后执行：

```bash
LOAD_BASE_URL=https://erp-test.example.com \
LOAD_DURATION_SECONDS=60 \
LOAD_CONCURRENCY=50 \
node scripts/load/phase-1-http-load.mjs
```

脚本只访问存活探针和 OAuth 元数据，不创建业务数据。门禁为错误率 `<= 0.1%`、P95 `<= 250ms`、P99 `<= 500ms`；结果 JSON 必须随发布证据归档。此轻量基线不能替代带真实 MongoDB Replica Set、Redis、Worker、外部沙箱和 24 小时 soak test 的容量验收。

## 5. 故障处置

- 审计追加或验链失败：立即停止 R2/R3 写入发布，保全 MongoDB 快照，禁止修链或删除事件。
- WORM 失败：确认外部端点、凭据、保留策略与幂等回执；在 24 小时窗口内恢复并重新运行待锚定任务。
- HTTP 错误率/延迟超限：按控制器和方法聚合定位；不得临时加入租户标签排查，使用 trace 日志做租户级诊断。
- 指标端点鉴权失败：检查 Secret Manager 版本与 Prometheus 抓取配置，禁止把 token 写入 URL、日志或告警注释。
