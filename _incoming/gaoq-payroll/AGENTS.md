# 专业算薪项目执行规范

- 回复、代码注释、文档和提交说明使用中文。
- TypeScript 使用 ESM、严格类型和 async/await，禁止 `var` 与 `any`。
- 金额跨边界使用整数分字符串，领域计算使用 BigInt，禁止 JavaScript 浮点。
- `tenantId` 只能来自已验证 GaoQ 访问令牌或服务身份，禁止请求头回退。
- L4 工资、税务、证件和银行数据必须加密；精确检索使用独立盲索引密钥。
- 禁止硬编码密码、Token、密钥、银行卡号或生产标识。
- 旧 `backend/`、`frontend/` 的未提交内容属于用户，迁移前不得删除或覆盖。
- 修改后至少运行 `pnpm lint`、`pnpm typecheck`、`pnpm test` 和 `pnpm build`。
