# GitHub Free Hosted OIDC 证据交换标准

- 文档编号：phase-5/21
- 状态：客户端、工作流和失败关闭门禁已交付；企业证据网关与目标集群信任尚待配置

## 1. 适用边界

Phase 5/6 的受保护验收与生产部署只使用 GitHub Hosted `ubuntu-latest`，不使用
NAS、虚拟机、自建或 self-hosted Runner。仓库是 GitHub Free 的 Private
Repository：按 GitHub 当前产品限制，私有仓库不能依赖 Environment 或 Required
Reviewers。因此仓库不声明 `environment:`，非敏感配置只使用 Repository
Variables，人类授权由企业变更系统产生的外部签名证据完成。

GitHub 只保存严格脱敏的输入摘要、verdict、计划 diff 和必要部署状态。原始业务
数据、工资、银行文件、附件、扫描日志、备份、Token、私钥和签署正文仍由企业
WORM 或对应事实系统保管。工作流不得持有长期访问密钥。

受保护 Job 必须：

1. 只由 `workflow_dispatch` 在 `main` 触发；
2. 只授予 `contents: read` 与 `id-token: write`；
3. 使用工作流/策略专用的 GitHub 单次 OIDC JWT；
4. 在 `$RUNNER_TEMP` 以 `0600` 保存临时输入；
5. 只上传严格 Schema 验证后的脱敏输出，不上传下载的原始输入；
6. 生产 Apply 必须重新验收独立 Plan 和两名不同负责人的 Ed25519 签名授权。

## 2. 服务端 OIDC 信任

证据网关和 Kubernetes 凭据代理必须通过 GitHub OIDC Discovery/JWKS 验证签名、
算法、`iss`、`nbf`、`iat`、`exp` 和单次 `jti`，并同时精确绑定：

| Claim | 强制条件 |
|---|---|
| `iss` | `https://token.actions.githubusercontent.com` |
| `aud` | 当前 workflow/policy 独占的规范 HTTPS URL；Origin 与接收代理相同，最后一个 path segment 等于策略名 |
| `sub` | `repo:GTVigilante/gaoq_ai:ref:refs/heads/main`；不得出现 `environment` subject |
| `repository`、`repository_id` | `GTVigilante/gaoq_ai` 及不可变仓库 ID |
| `ref`、`event_name` | `refs/heads/main`、`workflow_dispatch` |
| `sha` | 当前批准的发布 commit |
| `runner_environment` | `github-hosted` |
| `job_workflow_ref` | 明确允许的 workflow 文件及 `refs/heads/main` |

策略名是 audience 与审计中的稳定标签，不是客户端可自证的权限。代理必须拒绝
重复 `jti`、未知 workflow、跨策略 audience、错误 Origin、重定向、客户端自报
角色以及未获批准的证据 ID。Repository Variable 和请求 Header 都只是客户端
预期值，服务端授权只能来自已验签 claims 与服务端策略。

## 3. 受保护输入协议

每份输入使用无 userinfo、query 和 fragment 的固定 HTTPS URL。Runner 发送：

```http
GET /v1/evidence/<evidence-id>
Authorization: Bearer <github-oidc-jwt>
Accept: application/json
X-GaoQ-Repository-Id: <repository-id>
X-GaoQ-Commit-Sha: <commit>
X-GaoQ-Policy: <workflow-policy>
```

三个 `X-GaoQ-*` Header 只用于审计和早期拒绝，不能替代 JWT。响应必须为 `200`，
禁止 Redirect；`Content-Type`、`X-GaoQ-Content-SHA256`、实际字节摘要、大小、
Fatal UTF-8 和 JSON/YAML 契约必须全部匹配。正文不得包含与当前任务无关的个人
信息、工资明细、银行账号、原始外部报文、长期密钥或证书。

`scripts/github/fetch-oidc-protected-input.mjs` 在请求前复核仓库、commit、workflow、
事件、分支、Hosted Runner、无 `environment` claim 和 ref-bound `sub`，随后
执行上述响应校验。错误只输出稳定错误码，不得包含 JWT、请求 Token 或正文。

DAST 的短期目标 URL 和低权限 Token 也通过该协议取得，最长四小时，只用于非生产
隔离目标，原始配置不上传 Artifact。

## 4. Kubernetes 短期身份

Phase 6 Plan 与 Apply 使用不同 workflow、policy、audience、代理策略和 Kubernetes
RBAC Group。`write-oidc-kubeconfig.mjs` 只写集群 HTTPS Origin、固定摘要 CA 和
ExecCredential，不写静态 Token、客户端证书、ServiceAccount Token 或管理员
kubeconfig；短期 Kubernetes Token 最长有效期 15 分钟。

`github-oidc-kubernetes-credential.mjs` 使用当前 Job OIDC JWT 换取
`client.authentication.k8s.io/v1` ExecCredential，最长 15 分钟。Plan 只能读取
release、命名空间和非敏感 ConfigMap，并证明 Secret get 与 Deployment
create/patch/delete 均被拒绝。Apply 仅能管理当前 release 所需的 namespaced
非 Secret 资源；仍禁止 Secret 读取、ClusterRole、护栏修改和云账号管理。

## 5. GitHub Free 审批补偿控制

只读 Plan 与写入 Apply 是两个独立 `workflow_dispatch` 工作流，不能通过 `needs`、
`workflow_run` 或复用工作流自动串联。Plan 输出包含仓库 ID、commit、
`job_workflow_ref`、run ID/attempt、三份输入摘要、渲染清单摘要和验证器摘要的
绑定文件。

企业变更系统复核 Plan 后生成
`gaoq.phase6.deployment-authorization.v2`：

- 精确绑定 Plan run、计划包摘要、commit、输入、渲染清单、目标集群与命名空间；
- 由 `change_owner` 与 `sre_owner` 两名不同主体批准；
- 两个角色使用不同 Ed25519 私钥，分别签署同一规范化授权 payload 摘要及自身
  角色/keyId/签署时间；证据携带 SPKI DER 公钥，Repository Variable 固定
  角色/keyId 规范集合摘要；
- 授权最长两小时，Apply 重新渲染后逐字段验签、验时效和验摘要；
- 原始签署正文留在 WORM，GitHub Artifact 只保存脱敏授权 verdict。

公钥、URL、audience、摘要、CA 和资源名可以放 Repository Variables；Token、
私钥、连接串和长期云凭据不得进入 Variables、Secrets、仓库或命令行。

## 6. 验收与产品限制

本地失败关闭自测：

```bash
pnpm github:oidc-input:self-test
pnpm github:oidc-kubernetes:self-test
pnpm github:oidc-kubeconfig:self-test
pnpm release:phase6:deployment-authorization:self-test
pnpm security:validate
pnpm release:phase6:workflows:validate
```

仓库自测不证明企业代理、WORM、目标集群 RBAC 或 Hosted Actions 已可用。现场必须
保留 OIDC 验签审计、`jti` 消费记录、拒绝探针、计划包摘要、双人签名、短期凭据
和最终 verdict；缺少任一项仍为 No-Go。

产品边界以 GitHub 官方文档为准：

- [OpenID Connect reference](https://docs.github.com/en/actions/reference/security/oidc)
- [Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [Reviewing deployments](https://docs.github.com/en/actions/how-tos/managing-workflow-runs-and-deployments/managing-deployments/reviewing-deployments)
- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [Variables](https://docs.github.com/en/actions/concepts/workflows-and-actions/variables)
