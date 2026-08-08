# 项目工程规范

## 当前状态

- 2026-07-27 已建立与 GaoQ ERP 同构的 pnpm monorepo、NestJS API、Next.js Web、
  BullMQ Worker、MongoDB Replica Set 和 Redis 本地编排。
- 已完成 GaoQ 多资源 OAuth/JWKS 验证、可信租户上下文、组织主数据 CloudEvent
  Inbox、版本缺口检测和快照契约。
- 已完成整数分确定性算薪核心、L4 AES-256-GCM 数据加密、独立 HMAC 盲索引、
  不可变薪酬档案和工资结果基础模型。
- 已完成自包含平台契约、零已知依赖漏洞、三类生产镜像、独立认证 MongoDB
  Replica Set/Redis 编排，以及专业算薪独立 OAuth Resource 的标准 MCP 最低目录。
- MCP 使用 `2025-11-25` Streamable HTTP，固定四个只读 Tool、两个 Resource
  Template、两个 Prompt 和可复核 `catalogHash`；不包含 R3 Tool。
- 旧 `backend/` 与 `frontend/` 尚未删除；它们是待迁移功能参考，不得继续扩展为
  第二套正式架构。
- 真实发薪事实源切换仍需两个完整影子周期、零未解释差异和薪酬/财务签署。

## 强制边界

- GaoQ ERP 是身份、组织、员工和劳动关系唯一主数据源。
- 本项目是工资规则、运行、结果、薪税与发放唯一事实源。
- 禁止共享数据库、客户端租户、浮点工资、明文工资/银行卡/证件和双系统写入。
- REST、Worker 和后续 MCP 必须复用应用服务；异步任务必须携带可信主体上下文。

## 验证

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
docker compose -f docker-compose.platform.yml config
```
