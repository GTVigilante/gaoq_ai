# REST OpenAPI 3.1 契约

## 1. 目的与适用范围

`contracts/openapi/erp-api.openapi.json` 是 ERP REST 接入面的机器可读基线。
它由 47 个 NestJS Controller 源文件确定性生成，覆盖全局 `/api` 前缀、四个
前缀例外、HTTP 方法、路径、OAuth Scope、公开路由、Guard、Header、Query、
Path、Body、响应类型和源码定位。

该文件服务于外部系统、前端、测试工具和 AI 代理的发现与漂移检查，但不能绕过
业务应用服务、可信租户上下文、OAuth、幂等、强版本、确认链或审计控制。MCP
继续使用独立的 MCP 协议目录，不把 OpenAPI 路由直接转换成可执行 Tool。

## 2. 确定性生成

```bash
pnpm contracts:openapi:generate
pnpm contracts:openapi:self-test
pnpm contracts:openapi:validate
```

- `generate` 扫描 `apps/erp-api/src/**/*controller.ts` 并写入契约。
- `self-test` 执行正向和负向校验，不写仓库文件。
- `validate` 重新生成内存结果并逐字节比对已提交文件；路由、Scope 或参数漂移
  未同步时失败。
- `pnpm typecheck` 的 `pretypecheck` 生命周期和总门禁 `pnpm check` 都会先执行
  自测与漂移校验。

生成结果不含时间戳、机器路径、Token、租户或真实域名。文件顺序、路径和操作均
按字典序固定，同一源码必须得到相同字节。

## 3. 当前覆盖盘点

| 项目 | 数量 | 说明 |
|---|---:|---|
| Controller | 47 | 全部生产 Controller |
| Nest 路由声明 | 225 | `Get/Post/Put/Patch/Delete/All` |
| OpenAPI Path | 218 | 相同路径的不同方法合并 |
| OpenAPI Operation | 231 | MCP 的 `@All` 展开为七种标准方法 |
| OAuth Scope | 165 | 从 `RequiredScopes` 静态提取并写入安全方案 |
| 公开 Operation | 27 | 必须显式 `PublicRoute` |
| Scope 保护 Operation | 203 | 每项写入精确 scope |
| 已认证无 Scope Operation | 1 | 当前会话撤销，仅要求已认证主体 |

生成器拒绝动态路由字符串、动态 Scope、重复 Method + Path、重复
`operationId`、路径占位符与 `@Param` 不一致、公开路由同时声明 Scope、缺少
显式安全策略或响应定义。`@All` 的原始语义保留在 `x-nest-method`。

## 4. 字段约束边界

当前生成器对 `string/number/boolean/Date/array/string literal union` 生成标准
Schema；复杂 DTO 和响应对象保留 `x-typescript-type`、运行时参数清单和
`ValidationPipe` 标记。字段级白名单、嵌套校验、长度、枚举和业务不变量仍以
DTO、全局 `ValidationPipe`、应用服务及契约测试为准。

因此，本基线可以作为路由、鉴权和载荷类型的机器发现入口，但在字段级 Schema
完全展开前，禁止宣称它单独足以生成生产写客户端。外部写集成仍必须同时评审：

1. 对应 DTO 和供应商字段映射；
2. 幂等键、`If-Match`、签名与回执规则；
3. 成功、失败、超时和结果未知契约测试；
4. REST、事件和 MCP 是否复用同一应用服务。

## 5. 变更标准

任何 Controller 路由、HTTP 方法、参数、返回类型、公开状态或 Scope 变更必须在
同一 PR：

1. 更新实现和协议测试；
2. 重新生成并提交 OpenAPI；
3. 更新对应 Story 的 REST / 事件 / MCP 三面契约；
4. 对不兼容变化给出版本策略、迁移窗口和回滚方案；
5. 通过本地总门禁和可运行的 GitHub Hosted Actions。

当前 GitHub Hosted Actions 在 Job 启动前受账号付款或 Spending limit 阻塞，
所以仓库自测通过不等于远端 CI 或外部验收通过。
