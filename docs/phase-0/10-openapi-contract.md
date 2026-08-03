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
| class-validator DTO Schema | 103 | 字段、必填、类型、长度、范围、枚举、数组与继承 |
| 命名 Body Schema | 116 / 116 | 85 个 DTO、27 个运行时 Zod 登记、4 个编译器内联类型 |
| 成功响应 | 231 / 231 | 229 个显式内容 Schema、1 个 302 跳转、1 个 204 无正文 |
| Component Schema | 135 | `Problem`、103 个 DTO 与 31 个补充请求组件 |

生成器拒绝动态路由字符串、动态 Scope、重复 Method + Path、重复
`operationId`、路径占位符与 `@Param` 不一致、公开路由同时声明 Scope、缺少
显式安全策略或响应定义、未命名 Body、顶层 `unknown` 成功响应、失效运行时
Schema 来源或计数漂移。`@All` 的原始语义保留在 `x-nest-method`。

## 4. 字段约束边界

当前生成器已扫描 103 个 class-validator DTO，生成字段级 JSON Schema
2020-12：必填/可选、原始类型、nullable union、继承、嵌套 DTO、长度/范围、
数组大小/唯一性、静态枚举、格式和正则来源均进入组件；85 个请求体通过 `$ref`
绑定 DTO。生成器会拒绝名称重复、动态字段名、悬空 DTO 引用和 DTO 请求体未绑定。

其余 31 个请求体全部提升为命名组件：27 个 `unknown` 入口由
`apps/erp-api/src/contracts/rest-request-contracts.ts` 的运行时 Zod 注册表生成
JSON Schema，4 个内联类型由 TypeScript Program 展开。注册表绑定实际解析器
源码位置，来源文件、符号、Operation 或名称失效时生成失败；已有 Zod 的 OAuth、
审批通知、组织投递、招聘日历、生日与人才触点运行时直接复用同一 Schema。
7 个明确允许省略的空 Body 标为 `required: false`，但一旦提交正文只能是严格
空对象。

成功响应使用 TypeScript Program 展开显式类型及推断类型；直接操作 Express
`Response` 的端点从实际 `json`、`send`、`redirect` 调用提取状态码、媒体类型和
响应结构。OAuth Token 使用 `application/x-www-form-urlencoded`，营销导出使用
`text/csv`，MCP 声明 `application/json` 与 `text/event-stream`，Passkey 删除
使用 204，OAuth 授权使用 302 + `Location`。

`Record<string, unknown>` 等业务上刻意开放的嵌套扩展字段以
`x-intentionally-untyped` 标记，不会冒充封闭对象。机器契约已足以生成成功路径
客户端骨架，但外部写集成仍必须同时评审：

1. 对应 DTO 和供应商字段映射；
2. 幂等键、`If-Match`、签名与回执规则；
3. 成功、失败、超时和结果未知契约测试；
4. REST、事件和 MCP 是否复用同一应用服务。

统一 `Problem` 只覆盖通用错误；OAuth、WebAuthn、MCP 等协议专用错误语义仍以
协议实现和对应测试为准，不能从成功响应 Schema 推断。

## 5. 变更标准

任何 Controller 路由、HTTP 方法、参数、返回类型、公开状态或 Scope 变更必须在
同一 PR：

1. 更新实现和协议测试；
2. 重新生成并提交 OpenAPI；
3. 更新对应 Story 的 REST / 事件 / MCP 三面契约；
4. 对不兼容变化给出版本策略、迁移窗口和回滚方案；
5. 通过本地总门禁和可运行的 GitHub Hosted Actions。

2026-08-01 的 `main` 已实际通过 Phase 1、Phase 5 和文档 GitHub Hosted
Actions；远端 CI 通过仍不等于外部系统或目标环境验收通过。
