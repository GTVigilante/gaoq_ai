# Phase 5 MCP stdio 客户端接入手册

- 文档编号：phase-5/20
- 适用范围：同机 AI 客户端、开发和 MCP Inspector
- 协议基线：仓库锁定的 MCP `2025-11-25`
- 状态：标准入口和自动化协议测试已交付；Kimi Tool 目录及 Inspector 四类
  目录实体探针已通过，其余授权与业务实体联调待验收

## 1. 安全边界

stdio 不是匿名或开发后门。它与远程 `/mcp` 共用 `McpRuntimeService`、
`AccessTokenVerifier`、应用服务、Scope、租户、数据范围、确认账本和审计规则。
启动进程必须具有 ERP API 正常运行所需的数据库、Redis、加密和服务配置。

本地入口只读取两个专用变量：

| 变量 | 必填 | 约束 |
| --- | --- | --- |
| `MCP_STDIO_ACCESS_TOKEN` | 是 | 64–8192 字符的短时 JWT 形态 Token；必须包含 `erp:mcp:server:connect` |
| `MCP_STDIO_TRACE_ID` | 否 | 8–128 字符安全标识；缺失时由服务端生成 |

Token 必须由本机秘密管理器在启动时注入。禁止写入仓库、共享客户端配置、截图、
Issue、PR、日志或命令行参数；禁止使用长期个人 Token。入口启动前预检一次，
连接后每条消息重新验签，因此会话撤销、凭据撤销、过期或 Scope 变化会立即关闭
transport。客户端应重新完成授权，而不是自动无限重试。

stdout 是 MCP 协议通道，只能包含 JSON-RPC 帧；不得在入口前包装会写 stdout 的
脚本。稳定运行错误写入 stderr，详细验证错误、Token 和堆栈不会回显。

## 2. 构建与启动

从仓库根目录构建：

```bash
pnpm --filter @gaoq/erp-api build
```

构建产物入口：

```text
<仓库绝对路径>/apps/erp-api/dist/mcp-stdio-main.js
```

开发时也可使用：

```bash
pnpm --filter @gaoq/erp-api dev:mcp:stdio
```

不应把 Token 直接拼进上述命令。应由操作系统钥匙串、企业秘密管理器或 AI 客户端
支持的本地秘密注入机制提供环境变量。

## 3. 标准客户端配置模型

MCP 协议不规定各厂商配置文件的名称或位置。任何支持本地 stdio 的客户端都应
映射为以下等价配置；字段名称以该客户端当前官方文档为准：

```json
{
  "name": "gaoq-erp",
  "transport": "stdio",
  "command": "node",
  "args": [
    "/absolute/path/to/gaoq_ai/apps/erp-api/dist/mcp-stdio-main.js"
  ],
  "env": {
    "MCP_STDIO_ACCESS_TOKEN": "<由本机秘密管理器运行时注入的短时令牌>",
    "MCP_STDIO_TRACE_ID": "local-ai-client-001"
  }
}
```

必须使用绝对路径。示例中的 Token 是占位符，不能作为真实配置提交。若客户端
不支持安全秘密注入，不得把真实 Token 持久化到明文 JSON；应使用远程
Streamable HTTP + OAuth，或在完成安全评审后使用受控启动器。

Claude、Kimi、Cursor 等厂商的字段、OAuth 支持和发行版行为可能变化。仓库不维护
绕过标准协议的厂商私有分支，接入当日必须核对其官方文档，并把版本、原始协议
记录、`catalogHash` 和验收结果写入受控证据。

## 4. Inspector 与自动化验证

仓库把官方 MCP Inspector CLI 2.0.0 隔离锁定在
`tools/mcp-inspector-client`，不会使用未固定的 `latest`，也不会把其 UI/开发
依赖加入生产应用。先完成仓库锁定安装，再由秘密管理器为当前进程环境注入短时
Token；手工连接真实入口时使用：

```bash
pnpm install --frozen-lockfile
pnpm --filter @gaoq/mcp-inspector-client exec mcp-inspector \
  node /absolute/path/to/gaoq_ai/apps/erp-api/dist/mcp-stdio-main.js
```

仓库自动化门禁：

```bash
pnpm quality:mcp-stdio-coverage
pnpm mcp:catalog:self-test
pnpm --silent mcp:catalog:print
pnpm mcp:client:kimi:self-test
pnpm mcp:client:inspector:self-test
pnpm mcp:client:inspector:run
```

自动化测试使用官方 TypeScript Client 和真实 stdio 字节流完成初始化，验证同一
运行时可以发现 50 个 Tool、4 个静态 Resource、27 个 Resource Template 与
25 个 Prompt。专项覆盖环境白名单、
连接 Scope、启动预检、逐消息复验、消息顺序、认证失败关闭、错误脱敏和幂等关闭。
进程入口测试还验证应用模块只在环境预检后动态加载，输入结束、`SIGINT`、
`SIGTERM`、连接错误和启动中迟到资源共用按对象身份幂等清理；stderr 或资源关闭
失败只提升退出码，不能把内部异常、配置、Token、路径或堆栈写入协议通道。

`mcp:client:inspector:run` 使用官方 Inspector 的正式 CLI 层连接只读目录夹具，
依次且仅执行 `tools/list`、`resources/list`、`resources/templates/list` 和
`prompts/list`。它将实体响应逐项绑定完整 `catalogHash` 与
`runtimeContractHash`，拒绝缺项、重复名称、定位符或 Prompt 参数漂移以及夹杂
banner 的非纯 JSON 输出。该探针不读取 Resource 内容、不渲染 Prompt、不调用
业务 Tool、不调用模型，也不访问数据库或外部系统。

## 5. 实体客户端验收

每个客户端版本至少记录：

1. 客户端名称、精确版本、操作系统、commit 和 `catalogHash`。
2. 初始化协商、50 个 Tool、4 个静态 Resource、27 个 Resource Template
   和 25 个 Prompt 的目录一致性。
3. R0 读取、R1 确认、R2 外部浏览器强认证、结构化输出和 Resource Link。
4. 无 Scope、跨租户、过期、即时撤销、重放、取消、超时和客户端重连。
5. stdout 无非协议文本，日志、审计和错误中无 Token、L3/L4 正文或上游凭据。

官方 Client 自动化或目录实体探针通过不等于完整客户端验收。Claude、Kimi、
Cursor 和 Inspector 在正式 Token、授权读写、撤销/重连、安全复核和业务验收
签署完成前整体仍保持 No-Go。远程生产接入还必须单独完成 OAuth Authorization
Code + PKCE 或 Client Credentials、Origin、TLS、限流和外部系统联调。

### 5.1 Kimi 实体客户端目录兼容证据

2026-07-29 已使用本机 Kimi Code CLI 0.28.1 的正式 ACP 客户端层执行：

```bash
pnpm --filter @gaoq/erp-api build
pnpm mcp:client:kimi:run
```

探针只走 ACP `initialize → session/new → /mcp`，其中 `/mcp` 是 Kimi 的本地
状态命令，不调用模型、不执行 ERP 业务 Tool，也不读取 MongoDB、Redis 或外部
系统。Kimi 实体进程经 stdio 成功连接同一个 `McpRuntimeService`，报告
`gaoq-erp: connected (stdio, 50 tools)`；输出只保留客户端精确版本、连接结论、
Tool 数量和当前 `catalogHash`。夹具禁止任何 Tool 调用，不包含真实 Token、
租户数据或上游凭据。

该证据把 Kimi 的“标准 stdio 启动及 50 Tool 目录发现”从 No-Go 收敛为已通过，
但 Kimi 的 Resource、Resource Template、Prompt、正式短时 Token、R0/R1/R2、
撤销/重连和业务 UAT 尚未验收，因此 Kimi 整体仍保持 No-Go。Claude、Cursor 与
Inspector 也没有因此获得完整验收结论。

### 5.2 Inspector 实体客户端四类目录证据

2026-07-29 已使用锁定的官方 MCP Inspector CLI 2.0.0 执行：

```bash
pnpm mcp:client:inspector:run
```

Inspector 通过 stdio 连接同一个 `McpRuntimeService` 目录夹具，并以正式 CLI
方法发现 50 个 Tool、4 个静态 Resource、27 个 Resource Template 和 25 个
Prompt。探针输出绑定当前 `catalogHash` 与 `runtimeContractHash`，同时明确记录
`businessToolInvoked=false`、`resourceContentRead=false`、
`promptRendered=false` 和 `modelInvoked=false`。

该证据只关闭 Inspector 2.0.0 的四类目录兼容缺口，不证明正式短时 Token、
Resource 内容授权、Prompt 渲染、R0/R1/R2 Tool、撤销/重连、远程 OAuth 或业务
UAT；Inspector 整体仍保持 No-Go。Inspector 上游开发依赖当前存在 peer 与废弃
子依赖警告，因此固定隔离在工具工作区；生产依赖审计和许可证门禁继续独立执行。

## 6. 参考

- [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector)
- [MCP 调试指南](https://modelcontextprotocol.io/docs/tools/debugging)
- [MCP TypeScript SDK：构建首个 Server](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-server)
- [Kimi Code MCP](https://moonshotai.github.io/kimi-code/en/customization/mcp.html)
- [Kimi Code ACP](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp)
