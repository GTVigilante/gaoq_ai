# Codex 项目执行入口

进入本仓库执行任务前，必须依次读取：

1. `../AGENTS.md`：Codex 执行职责、安全红线、任务边界和 CR 沉淀规范。
2. `../CODEX.md`：当前系统状态、目录边界和完整验证命令。
3. `../docs/phase-0/README.md`：企业架构、数据、集成、MCP、安全和发布强制基线。
4. 对应的 `../docs/phase-N/README.md`：阶段已交付代码与外部待验收边界。

## 当前执行边界

- Phase 0–6 代码与证据验证器已交付，不得再描述为“尚无应用源码”。
- 未取得真实联调、迁移、性能、安全、容灾、UAT、Go/No-Go 和 Hypercare 证据前，
  不得宣称生产完成。
- `wordpress backup/` 永久排除，不得纳入盘点、构建、扫描或迁移。
- 禁止把密码、密钥、Token 或生产凭据写入仓库、命令行、日志和代理上下文。
- MCP 必须复用应用服务，禁止直接访问数据库、透传上游 Token 或执行 R3 操作。
- Kimi Code CLI 0.28.1 已通过正式 ACP 层发现 stdio 的 50 个 Tool；这只是实体
  客户端目录证据。Resource/Prompt、正式 Token、R0/R1/R2、撤销/重连和 UAT
  未完成前，Kimi 整体及其他厂商客户端仍保持 No-Go。
- 官方 MCP Inspector CLI 2.0.0 已通过正式 CLI 层发现 50 Tool、4 Resource、
  27 Resource Template 和 25 Prompt；这只证明四类目录兼容。读取、渲染、
  业务 Tool、正式 Token、OAuth、撤销/重连和 UAT 未完成前 Inspector 整体仍
  保持 No-Go。
- Phase 5/6 工作流只使用 GitHub Hosted `ubuntu-latest`；禁止接入 NAS、虚拟机、
  self-hosted Runner 或本地证据挂载。受保护证据和 Kubernetes 身份必须使用
  workflow/policy 专用单次 OIDC；生产 Apply 另需外部双人 Ed25519 签名授权，
  原始敏感证据仍留在企业 WORM。
