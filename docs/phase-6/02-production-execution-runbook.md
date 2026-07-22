# Phase 6 现场执行与证据运行手册

- 文档编号：phase-6/02
- 状态：执行模板已交付；仅能在获批生产窗口使用

## GitHub 受保护环境

仓库需要两个 Required Reviewers 保护的 Environment：

- `phase-6-cutover-acceptance`：只读挂载 `/var/lib/gaoq/phase-6/cutover.json`；
- `phase-6-hypercare-acceptance`：只读挂载 `/var/lib/gaoq/phase-6/hypercare.json`。

两个 Environment 使用不同的隔离单次 self-hosted Runner。PR、push、`workflow_call` 和普通云 Runner 不能读取现场证据。Runner 不保存生产密钥，作业结束后销毁；证据文件不得为符号链接、不得允许组或其他用户写入，最大 1 MiB。

## 执行次序

1. 在默认分支完成 Phase 5 Go/No-Go，并冻结 commit、三份镜像摘要和部署清单。
2. 现场团队执行三次全量演练及生产级回滚演练，将原始证据写入企业 WORM。
3. 数据负责人导出脱敏的 `cutover.json`；在默认分支手工运行 `Phase 6 统一切换证据验收`。
4. 工作流仅生成 `CUTOVER_COMPLETED` verdict。它不部署、不切流、不改变旧系统状态。
5. 连续 28 天生成日报，稳定期结束后由法务、财务、数据负责人签署归档批准。
6. 导出脱敏的 `hypercare.json`；手工运行 `Phase 6 稳定期与归档证据验收`。

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
