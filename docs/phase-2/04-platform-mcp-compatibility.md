# Phase 2 平台与 MCP 兼容矩阵

## 外部平台

| 平台 | 能力 | 当前实现 | 生产门禁 |
| --- | --- | --- | --- |
| 飞书 | 应用机器人单聊 | `POST /open-apis/im/v1/messages`，`receive_id_type=user_id`，通知 ULID 作为 `uuid` | 真实租户权限、可用范围、限流、401、回执和 uuid 去重验证 |
| 钉钉 | 企业机器人单聊 | `POST /v1.0/robot/oToMessages/batchSend`，应用 clientId 作为 `robotCode` | 真实租户接口版本、机器人权限、限流、401、回执与重复投递验证 |

平台合同必须以联调日期当日官方文档和 API Explorer 为准。任何字段或端点变化须先更新适配器契约测试和本文档，再升级生产。

## MCP 客户端

协议基线为 MCP `2025-11-25`，服务端 SDK 为 `@modelcontextprotocol/sdk 1.29.x`。

| 客户端 | 初始化/发现 | R0 | R1 确认 | R2 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 官方 TypeScript Client | 自动化测试通过 | 通过 | 协议与服务测试通过 | WebAuthn UV 服务测试通过；实体认证器待 UAT | 条件通过 |
| Claude 当前稳定版 | 待真实客户端验证 | 待验证 | 待验证确认链接和结构化输出 | 待验证外部浏览器确认回传 | No-Go |
| Kimi 当前稳定版 | 待真实客户端验证 | 待验证 | 待验证确认链接和结构化输出 | 待验证外部浏览器确认回传 | No-Go |
| Cursor 当前稳定版 | 待真实客户端验证 | 待验证 | 待验证确认链接和结构化输出 | 待验证外部浏览器确认回传 | No-Go |

客户端验收必须覆盖 OAuth Authorization Code + PKCE、Token 刷新、Scope 拒绝、结构化输出、中文错误、确认链接、一次性凭据、重放和过期。服务端不接受客户端 UI 自报“已确认”作为授权事实。

R2 的授权事实仅来自 ERP 服务端验证成功的 WebAuthn 仪式。确认页必须在 `WEB_ORIGIN` 精确域名打开；生产环境必须使用 HTTPS。普通确认端点继续对 R2 失败关闭，作为防降级门禁。
