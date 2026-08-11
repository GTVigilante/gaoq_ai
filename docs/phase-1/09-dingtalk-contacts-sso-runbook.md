# 钉钉通讯录与员工扫码登录运行手册

## 1. 已交付能力与边界

- ERP Web 新增 `/workspace/contacts` 企业通讯录，按可信身份中的部门数据范围读取
  ERP 组织主数据，并展示钉钉绑定状态；ERP 仍是员工与组织的唯一主数据源。
- 具备 `erp:integration:org_provisioning:write` 的管理员可从通讯录发起钉钉首次开户；
  手机号只进入既有 R3 加密开户链路，不进入浏览器持久化、日志、审计正文或 MCP。
- 登录页新增钉钉扫码入口，浏览器回调固定为 `/auth/callback/dingtalk`。扫码身份必须
  精确绑定活动 ERP 员工、同一 corpId 和 unionId；禁止按姓名、手机号或邮箱自动合并。
- 钉钉通讯录 `userid` 与网页登录 `openId` 分开保存。首次可信扫码按
  `corpId + unionId` 原子登记 `loginOpenId`，后续登录必须逐字匹配，通讯录
  `userid` 不会被覆盖。
- 标准 MCP 保持只读最小投影，不开放员工开户、外部身份绑定、凭据或登录控制面。

仓库实现与本地自动化测试已经交付；真实钉钉企业授权、生产密钥注入、索引迁移、
员工角色分配和实体扫码 UAT 仍须按本手册现场完成。

## 2. 钉钉侧准备

1. 由钉钉企业管理员创建企业内部应用，开通组织通讯录读取、员工创建/查询及网页登录
   所需的最小权限；不得授予应用无关的管理权限。
2. 登记生产回调地址 `https://<ERP Web 域名>/auth/callback/dingtalk`，必须与
   `DINGTALK_REDIRECT_URI` 逐字一致，只允许 HTTPS 标准端口。
3. 记录企业 corpId、应用 Client ID 与 Client Secret。Secret 只能写入现有
   Secret Manager，不得粘贴到工单、聊天、仓库、镜像或数据库。
4. 先在钉钉沙箱或测试企业验证权限范围，再申请生产企业授权。

## 3. GaoQ 配置

### 3.1 SSO 配置

由部署平台从 Secret Manager 注入：

- `DINGTALK_CLIENT_ID`
- `DINGTALK_CLIENT_SECRET`
- `DINGTALK_REDIRECT_URI=https://<ERP Web 域名>/auth/callback/dingtalk`

在 `identity_sso_tenant_bindings` 创建活动绑定，字段固定为 ERP `tenantId`、公开登录
别名 `loginSlug`、`provider=dingtalk`、钉钉 corpId `externalTenantId` 和
`status=active`。不得把 Secret 写入该集合。

### 3.2 通讯录与开户配置

创建独立的 Secret，例如 `GAOQ_ORG_PLATFORM_DINGTALK_<租户别名>`，正文为严格
JSON 对象 `{"clientId":"...","clientSecret":"..."}`。在
`integration_org_platform_bindings` 创建活动绑定：

- `tenantId`：与 SSO 绑定完全相同的 ERP 租户；
- `channel=dingtalk`；
- `externalTenantId`：与 SSO 绑定完全相同的 corpId；
- `credentialSecretRef`：上述受控 Secret 名称；
- `status=active`。

同一租户的两类绑定必须使用同一 corpId，但 SSO 凭据与组织下发凭据应按最小权限
独立配置。管理员需要
`erp:integration:org_provisioning:read` 与
`erp:integration:org_provisioning:write`；普通员工只分配其岗位所需的基础角色、
Scope 和部门数据范围，不得因扫码登录自动提权。

## 4. 发布与数据迁移

1. 构建并保存发布 commit、镜像摘要和脱敏配置清单。
2. 按 [`01-index-migration-runbook.md`](./01-index-migration-runbook.md) 先执行
   `phase-1-indexes-v4` dry-run；确认 19 个集合、64 个声明索引无冲突。
3. 获得独立迁移批准后执行 apply，确认
   `identity_external_identities` 存在
   `tenantId_1_provider_1_externalTenantId_1_loginOpenId_1` 唯一部分索引。
4. 再滚动发布 API、Worker 与 ERP Web。不得通过开启 Mongoose `autoIndex` 代替迁移。

## 5. 实体 UAT

至少用一名普通员工和一名通讯录管理员完成：

1. 管理员进入 `/workspace/contacts`，确认只能看见其授权部门，搜索与部门筛选结果一致。
2. 对未绑定员工发起“开通钉钉”，确认任务状态从待处理进入成功，页面显示已绑定；
   日志与审计中不得出现手机号、Client Secret、上游 Token 或钉钉响应正文。
3. 员工在 `/login` 选择“使用钉钉扫码登录”，扫码后只返回受信任的站内路径，
   Access Token 的租户、员工、角色、Scope 与部门投影必须与 ERP 当前事实一致。
4. 同一员工再次扫码必须复用已登记 openId；使用另一企业、另一账号、停用员工、
   停用绑定或错 corpId 均应失败关闭。
5. 撤销员工会话或停用外部身份后，既有访问令牌必须按当前会话/映射校验失效。
6. 保存不含个人正文和秘密的截图、时间、测试账号编号、发布 commit、迁移回执与审批人。

未完成真实钉钉企业实体 UAT 前，只能标记“仓库能力已交付”，不得标记生产 SSO 完成。

## 6. 回滚

- 应用异常时先将对应 `identity_sso_tenant_bindings.status` 或
  `integration_org_platform_bindings.status` 改为 `disabled`，吊销相关会话并回滚应用版本。
- 不删除外部身份、员工、迁移记录或唯一索引；索引保留不影响旧版本读取，后续修复
  继续使用新迁移版本。
- 钉钉侧若撤销应用授权，同时轮换或销毁对应 Secret；禁止把失效 Secret 改写进数据库。
