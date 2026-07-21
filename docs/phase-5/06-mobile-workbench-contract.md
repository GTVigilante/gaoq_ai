# Phase 5 移动工作台契约

## 范围

第一切片提供 `/mobile` H5 工作台、审批待办、首页摘要、知识与个人中心入口。审批待办复用 `GET /api/approvals/instances/inbox` 和既有 `ApprovalApplicationService` 权限投影；移动端不实现业务规则，不新增绕过 REST 的内部接口。审批决策、表单详情、知识任务和平台小程序容器属于后续增量，未完成前不得宣称移动端业务闭环验收。

## 身份与数据安全

- 身份只使用 ERP HttpOnly 会话；前端不接收、不选择、不持久化 tenantId、角色或 Scope。
- 请求必须 `credentials=include`、`cache=no-store`，页面卸载时中止；禁止把审批、员工、薪酬或令牌写入 localStorage、sessionStorage、IndexedDB、Service Worker Cache 或 URL。
- API 响应在渲染前执行固定字段、枚举、ULID、数量与长度校验；异常响应统一失败关闭。
- 首切片只显示审批控制摘要，不显示标题、表单正文、审批意见或 L3/L4 数据。
- 移动端不直接执行审批决定。后续写操作必须携带服务端版本、幂等键，R2 必须走 ERP Passkey 强认证，且复用与 PC/MCP 相同的应用服务和审计点。

## 体验与无障碍

- 手机 `<768px` 为单列卡片与底部四入口导航；平板/桌面保持最大 720px 阅读宽度。
- 交互热区不小于 48px，使用语义化 header/main/nav/section、可见焦点、`aria-current` 和状态文本。
- 支持安全区、动态视口与 `prefers-reduced-motion`；不以颜色作为唯一状态表达。
- 弱网/未登录/非法响应统一展示可恢复错误，不展示服务端异常正文。

## 验收门禁

- 375px、768px 与桌面断点无横向溢出，键盘与读屏主导航可用。
- 未登录、403、500、超时、Abort、空列表和 200 条上限测试通过。
- 浏览器存储、Cache Storage、URL 与日志中不存在业务正文、Token 或租户标识。
- 前端 lint、typecheck、Next.js production build 通过；真实钉钉/飞书容器与实体手机 UAT 完成前保持“外部验收待完成”。
