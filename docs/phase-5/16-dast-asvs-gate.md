# Phase 5 DAST 与 ASVS 5.0.0 证据门禁

- 文档编号：phase-5/16
- 状态：扫描工作流与证据校验器已交付；生产等价环境实测和签署尚未执行

## 标准与范围

应用安全基线固定为 [OWASP ASVS 5.0.0](https://github.com/OWASP/ASVS/releases/tag/v5.0.0_release)。门禁使用官方英文 CSV，固定摘要为 `sha256:6124dba176dc563f66363a11ae0c47f9b86b8a4a84c66a793670bd196ed86cd5`；普通 PR CI 会从固定 release 下载并复验。目录共 345 项，其中 L1 70 项、L2 183 项、L3 92 项。发布前必须评估全部 253 项 L2 基线；不适用项必须在逐项矩阵中提供证据，最多 30 项，失败项和临时例外均为零。

身份、会话、权限、租户、OAuth/MCP、薪酬、合同、附件、密钥、批量导出、通信、配置、数据保护、架构和审计按 L3 验证。固定高风险 Profile 为全部非 WebRTC 的 87 项 L3 要求，必须全部通过且不接受“不适用”；系统没有 WebRTC 能力，剩余 V17 的 5 项 L3 要求以功能不存在证据单独排除。

DAST 使用 [ZAP 2.17.0 Full Scan](https://www.zaproxy.org/docs/docker/full-scan/)，Docker Hub Linux amd64 镜像固定为 `zaproxy/zap-stable@sha256:c558ee87358911ab17278c70991e856f57793e115d9cd0f88ca475cf82907a1a`。固定摘要不会自动取得后续规则更新；升级版本或镜像后必须重新评审、更新摘要并从头执行门禁。

## 主动扫描安全边界

`.github/workflows/phase-5-dast.yml` 只能通过 `workflow_dispatch` 在 `main` 启动，
使用 GitHub Hosted Runner、`phase-5-dast` policy 和单次 OIDC。GitHub Free
私有仓库不依赖 Environment 或 Required Reviewers；Repository Variables 提供：

- `DAST_CONFIG_URL`、`DAST_CONFIG_SHA256`、`DAST_CONFIG_OIDC_AUDIENCE`；网关返回最长四小时的严格 JSON，包含目标和专用低权限 Token，原始配置不得上传；
- Variable：`DAST_ENVIRONMENT_NAME`、`DAST_ALLOWED_HOST_SUFFIX`、`DAST_PRODUCTION_EQUIVALENT=true`、`DAST_PRODUCTION_TRAFFIC=false`、`DAST_ACTIVE_SCAN_APPROVED=true`；
- 目标必须是带 `dast/preprod/security/stage/staging/uat` 独立标签的 HTTPS FQDN，只允许根路径、默认 443 端口和显式批准的域名后缀；禁止凭据、IP、路径、查询与 fragment。

Full Scan 会发送攻击载荷并可能触发业务写入，因此目标必须是生产等价的隔离租户：使用合成数据，OP、钉钉、飞书、e签宝、银行、税务、附件和 WORM 全部指向沙箱或受控替身；发薪、申报、签署、删除等 R3 能力在网关和应用两层禁用。任何生产数据、生产流量或外部副作用都会使证据失败。

扫描分别执行未认证与低权限认证两轮。认证 Token 只作为容器环境变量交给只读挂载的 HTTP Sender 脚本，不进入命令行、仓库和报告；脚本同时要求 `hostname === approvedHost` 和 ZAP in-scope，禁止使用官方 `ZAP_AUTH_HEADER_SITE` 的子串匹配，避免向恶意相似域名泄漏凭据。容器固定摘要、只读根文件系统、移除全部 Linux capabilities、禁止提权并限制 CPU、内存和进程数。任何 ZAP `FAIL/WARN` 或运行错误均返回非零；禁止 `-I`、进度文件、规则忽略、浮动镜像和在线 add-on 更新。

## 联合验证

ZAP 不能替代业务授权验证。安全测试必须额外完成至少：100 次已认证请求；10 次跨租户拒绝；10 次 IDOR 拒绝；10 次 Scope 拒绝；对应安全审计事件不少于 30 条；MCP `tools/list` 中 R3 数量为零。还必须人工验证 OAuth PKCE、Refresh Token 轮换、Passkey/R2、CSRF、SSRF、XSS、Mongo 查询注入、文件上传、Webhook 重放、日志脱敏、错误信息、速率限制和审计失败关闭。

原始 JSON、XML、HTML 报告只在 GitHub Artifact 暂存 14 天，随后转存至受控不可变证据库。运行器会流式检查六份报告，只有文件齐全且不含测试 Token 时才允许上传；扫描发现仍保持失败状态。报告不得含 Cookie、生产个人信息、工资金额、银行账号或外部平台凭据。GitHub Artifact 不是长期 WORM 证据。

## 证据契约与 Go/No-Go

安全平台将逐项 ASVS 矩阵、两轮 ZAP 报告、授权探针、监控、审计查询和测试数据清单组装为严格白名单的 `gaoq.phase5.dast-asvs.v1` JSON。文件只保存目标 Origin 的 SHA-256，不保存 URL；API、Worker、ERP Web、Website 镜像、commit、ZAP 镜像、Node 调度器、认证脚本、Hook、手动工作流和 ASVS 目录必须固定摘要。AppSec、平台、QA、风险四类负责人使用不同证据 ID 签署。

```bash
pnpm security:dast:validate-evidence -- /secure/security/phase-5-dast-asvs.json
```

以下任一情况均为 No-Go：Critical/High/Medium 动态发现非零；ASVS L2 未全部评估或存在失败；87 项高风险 L3 任一未通过；认证、跨租户、IDOR、Scope、审计或 MCP R3 探针不足；报告复用；签署缺失；出现生产数据、生产流量或外部副作用。工具自测和工作流成功不等于安全负责人已完成实测与签署。
