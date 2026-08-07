# GaoQ 平台契约来源与同步规范

算薪仓库内的 `packages/platform-contracts` 与 `packages/shared-types` 来源于
`GTVigilante/gaoq_ai` 的 `main`，整合基线为 commit
`0f387ee768d94772ec5d211fd9d7bd616f185924`；平台契约最近一次来源变更 commit 为
`143e4579bd9309d3de94736b77e7778455bb42c6`。

纳入工作区的目的，是消除对开发机相邻目录 `link:` 的依赖，使 CI、镜像构建和生产
回滚都能从单一 commit 重现。该副本不是新的契约事实源，GaoQ ERP 仍是平台契约的
权威发布方。

同步时必须执行以下步骤：

1. 从 GaoQ ERP 已通过主线门禁的 commit 复制两个包，禁止从脏工作区复制。
2. 保持 `@gaoq/platform-contracts` 的语义版本与导出完全一致；不允许在算薪仓库单独修改。
3. 更新本文的整合基线和来源变更 commit，并检查 Git diff 仅包含上游变更。
4. 运行 `pnpm install --frozen-lockfile`、`pnpm audit`、`pnpm check` 和生产镜像构建。
5. ERP 与算薪联调必须验证 CloudEvent schema、resource/audience 和快照版本协商。

接入内部 npm Registry 后，可将依赖改为 Registry 的精确版本；切换前必须比对包内容
摘要，禁止使用浮动 tag、未发布工作区或跨仓库文件路径。
