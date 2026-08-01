# ADR-0005：GitHub Hosted + OIDC 发布

- 状态：accepted
- 日期：2026-07-30
- 关联 Issue：#1、#12、#35、#38、#39、#40
- 替代关系：替代历史 self-hosted Runner、本地挂载和长期 kubeconfig 方案

## 背景

用户明确不付费、不创建虚拟机、不使用 NAS。自建 Runner 会把本地内网凭据、
可变工作区和运维责任引入供应链，长期 kubeconfig/ServiceAccount Token 也无法
满足最小权限与可审计发布。

## 决策

代码、Issue、PR 和 CI/CD 只使用 GitHub。工作流运行在 GitHub Hosted
`ubuntu-latest`；生产等价证据和 Kubernetes 凭据通过 workflow/policy 专用
GitHub OIDC 换取最长 15 分钟的单次身份。Plan 与 Apply 使用不同 audience、
RBAC Group 和工作流，kubeconfig 仅包含 ExecCredential，不写静态凭据。

生产 Apply 必须绑定批准的 Plan 产物、commit、镜像、部署清单、目标环境，以及
变更/SRE 两个不同职责主体的外部 Ed25519 签名。GitHub Free 私有仓库不依赖付费
Environment 作为安全门禁。

## 后果

- 账号计费/额度在 Runner 分配前阻塞时只能记录外部 No-Go；不得用 NAS、虚拟机、
  self-hosted Runner 或本地执行冒充远端通过。
- 相同 commit 不重复空跑；新 commit 自然触发一次并保存原始 run/job 证据。
- 企业证据代理、目标集群 OIDC 和 RBAC 仍须现场建设与验收。

## 被否决方案

- NAS/本地 Mac/self-hosted Runner：供应链边界和可恢复性不足。
- 长期 GitHub Secret kubeconfig：权限过大且轮换/归责困难。
- 付费 Environment 门禁：与用户成本约束及 GitHub Free 私有仓库不匹配。

## 安全与数据影响

OIDC 输入只允许脱敏证据，工作流不得上传个人数据、凭据或业务正文。下载器固定
仓库、workflow、policy、audience、commit、媒体类型、大小和 SHA-256。

