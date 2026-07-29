# ADR-0003：标准 MCP 服务与 AI 风险边界

- 状态：accepted
- 日期：2026-07-20
- 关联 Issue：#2、#7、#18、#25、#30、#36
- 替代关系：无

## 背景

多类 AI 客户端需要统一访问 ERP，但独立 AI 业务实现会复制权限、事务和审计，
并可能把高风险工资、合同、权限或删除操作暴露给模型。

## 决策

采用 MCP `2025-11-25` 稳定规范。生产远程入口仅使用 Streamable HTTP `/mcp`，
本机实体客户端使用 stdio；不实现被替代的独立 HTTP+SSE 服务。人员代理使用
Authorization Code + PKCE，服务代理使用受限 Client Credentials；所有调用
重新校验 issuer、audience、resource、主体、租户、Scope、数据范围和会话状态。

MCP 不是独立业务层。Tool、Resource、Prompt 和 Worker 必须复用对应应用服务；
禁止直查 Model/Repository、透传上游 Token 或调用供应商 SDK。R1/R2 使用服务端
prepare/execute 确认链，R3 永久不注册。每个业务 Story 同步列出 REST、事件和
MCP 契约。

## 后果

- Web、REST、MCP 和 Worker 共享授权、幂等、事务、审计和脱敏。
- 客户端兼容需分别验证 Kimi、Inspector、Claude、Cursor 等实体版本，协议测试
  不能替代正式 Token 与业务 UAT。
- MCP 目录和运行时语义必须哈希锁定，协议升级需新 ADR 和兼容窗口。

## 被否决方案

- 为每个 AI 客户端开发私有插件 API：契约和权限会分叉。
- 长期 MCP API Key：无法满足人员身份、轮换、撤销和数据范围。
- 让 AI 直接发薪、签合同、删数据或提升权限：风险不可接受。

## 安全与数据影响

Token、确认凭据、L3/L4 原文和外部凭据不得进入日志、Prompt、Resource 或确认
账本。确认完成后的审计故障不能释放操作或重复执行副作用。

