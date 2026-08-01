# 生产运行入口、健康探针与指标信任边界运行手册

## 1. 适用范围

本手册约束 ERP API 和 Worker 的追踪、公开错误、Kubernetes 健康探针、
Prometheus 抓取以及 MongoDB/Redis 运行连接边界。它们属于平台控制面，不得读取
租户业务正文、个人信息、工资、审批内容或 MCP 参数。

## 2. 健康探针

- API `GET /api/health/live` 只证明进程可响应，不访问 MongoDB、Redis、外部平台
  或 MCP 服务。
- API `GET /api/health/ready` 并行验证 MongoDB 和 Redis，任一失败返回稳定 503
  `DEPENDENCY_UNAVAILABLE`，公开响应不枚举内部主机、拓扑或异常正文。
- MongoDB 检查必须在 1 秒操作时限内执行 `hello`，同时满足
  `isWritablePrimary=true` 和非空 Replica Set `setName`；仅 TCP 连接或
  Mongoose `readyState=1` 不构成可写就绪。
- 初始 MongoDB 断连允许使用受校验的 `MONGODB_URI` 重连；并发探针共享同一
  in-flight 操作，禁止形成连接风暴。单次依赖检查在 1.25 秒截止后失败关闭，
  未完成的底层操作仍保持单飞，不能由下一次探针重复创建。
- Redis 仅在 `wait|end` 状态执行显式连接，连接后必须为 `ready` 且 `PING`
  精确返回 `PONG`。其他状态、异常或非规范响应均视为未就绪。
- Worker `/health/live` 不要求抓取凭据，但只证明 Worker 指标监听进程存活；它
  不代替 API 就绪探针、队列积压、MongoDB 可写性或业务 Worker SLA。

## 3. 指标与追踪

- API `/api/metrics` 和 Worker `/metrics` 只接受 Secret Manager 注入的独立
  `METRICS_BEARER_TOKEN`；不得复用用户、服务账号、MCP OAuth 或外部平台 Token。
- Worker 未配置指标凭据时不启动监听器；缺失或错误凭据返回 401 和标准
  `WWW-Authenticate: Bearer`，未知路径/方法返回 404。
- 指标响应固定 `Cache-Control: no-store` 和
  `X-Content-Type-Options: nosniff`。渲染异常只返回稳定 500，不返回堆栈、
  Prometheus 内部错误或凭据。
- HTTP Method 标签只允许 CONNECT、DELETE、GET、HEAD、OPTIONS、PATCH、POST、
  PUT、TRACE；任何其他客户端可控 Method 统一为 `OTHER`。非法状态码统一为
  `500`，禁止利用任意标签制造 Prometheus 高基数内存耗尽。
- 控制器和处理器标签只来自 Nest 编译期上下文；租户、主体、资源、traceId、
  URL、异常或外部响应不得进入标签。
- `x-trace-id` 仅保留 1–64 字符白名单值；非法或缺失值由服务端重新生成，并在
  响应头和审计上下文中使用同一值。

## 4. 公开错误

- 未知异常和全部 5xx 公开消息统一为“服务暂时不可用”；规范稳定错误码可保留，
  但异常正文、数据库地址、上游响应、堆栈和 Secret 永不返回。
- 业务错误码必须匹配 `^[A-Z][A-Z0-9_]{2,127}$`，否则收敛为 `HTTP_<status>`。
- 4xx 消息不得包含控制字符，主消息最多 512 字符；字段详情最多 20 项、每项
  256 字符。超限或畸形值使用稳定回退，防止响应放大和日志注入。
- `/mcp` 的 401/403 继续使用 RFC 9728 资源元数据挑战；本切片不新增或修改任何
  MCP Tool、Resource、Prompt 或 AI 写能力。

## 5. Redis 连接参数

- `REDIS_URL` 只接受 `redis://` 或 `rediss://`；生产平台应优先使用
  `rediss://`，转换器会显式启用 TLS。
- URL 必须含主机，只允许单一规范数据库路径 `/0`、`/1` 等；禁止前导零、额外
  路径、query、fragment、0 端口和超过 1,000,000 的数据库编号。
- ACL 用户名最多 256 字符、密码最多 512 字符；百分号编码必须可解码，且凭据
  不得含控制字符。凭据不得进入日志、错误、Issue、MCP 或指标。

## 6. 验证与外部证据

仓库专项门禁：

```bash
pnpm quality:runtime-boundary-coverage
```

当前 11 个测试文件、40 项测试覆盖 11 个生产文件，合计覆盖率为
99.70%/94.44%/100%/99.67%（语句/分支/函数/行），每个生产文件四维均不低于
90%。真实 Kubernetes 探针、MongoDB 主节点切换、Redis TLS/ACL、Prometheus
抓取、告警路由和网络策略仍必须在目标环境形成证据；本地测试不能替代现场验收。
