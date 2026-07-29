# Phase 6 现场执行与证据运行手册

- 文档编号：phase-6/02
- 状态：执行模板已交付；仅能在获批生产窗口使用

## GitHub Free 受保护入口

仓库使用四个 workflow/policy：

- `phase-6-deployment-plan`：以 Plan 专用 OIDC audience 和最小 Kubernetes
  Group 生成只读计划与 diff；
- `phase-6-deployment-apply`：验收变更负责人和 SRE 的外部 Ed25519 双人签名后，
  以 Apply 专用 OIDC audience 和独立最小 Group 执行 Helm 原子发布；
- `phase-6-cutover-acceptance`：通过 OIDC 证据网关读取脱敏 `cutover.json`；
- `phase-6-hypercare-acceptance`：通过 OIDC 证据网关读取脱敏 `hypercare.json`。

四个入口均使用 GitHub Hosted `ubuntu-latest`，只允许 `main` 上的
`workflow_dispatch`。PR、push 和 `workflow_call` 不能触发；Runner 不保存生产
密钥。GitHub Free 私有仓库不依赖 Environment 或 Required Reviewers；证据 URL、
专用 audience 和预期 SHA-256 是非敏感 Repository Variables，临时输入以 `0600`
写入 `$RUNNER_TEMP`，作业结束即清除。完整交换标准见
[GitHub Hosted OIDC 证据交换标准](../phase-5/21-github-oidc-evidence-exchange.md)。

## 执行次序

1. 在默认分支完成 Phase 5 Go/No-Go，并冻结 commit、三份镜像摘要和部署清单。
2. 按[受保护生产部署工作流](./05-protected-production-deployment.md)运行独立
   Plan，复核计划包并取得外部双人签名，再手工运行独立 Apply；此步骤不切流。
3. 现场团队执行三次全量演练及生产级回滚演练，将原始证据写入企业 WORM。
4. 数据负责人导出脱敏的 `cutover.json`；在默认分支手工运行 `Phase 6 统一切换证据验收`。
5. 现场变更负责人按[生产资金执行授权契约](./03-production-execution-authorization.md)启用独立授权域；每个真实银行或税务对象仍需单独短时授权。
6. 切换验收工作流仅生成 `CUTOVER_COMPLETED` verdict。它不部署、不切流、不改变旧系统状态。
7. 连续 28 天生成日报，稳定期结束后由法务、财务、数据负责人签署归档批准。
8. 导出脱敏的 `hypercare.json`；手工运行 `Phase 6 稳定期与归档证据验收`。

本地契约自测：

```bash
pnpm release:phase6:cutover:self-test
pnpm release:phase6:hypercare:self-test
```

现场文件验收：

```bash
pnpm release:phase6:cutover:validate-evidence -- /secure/phase-6/cutover.json
pnpm release:phase6:hypercare:validate-evidence -- /secure/phase-6/hypercare.json
```

## 证据与结论

GitHub Artifact 只保留 release ID、commit、结论和整体摘要，保存 90 天；原始证据和签署记录进入企业 WORM。验证失败一律 No-Go，不允许手工编辑 verdict、条件放行或以 Issue 评论代替证据。
