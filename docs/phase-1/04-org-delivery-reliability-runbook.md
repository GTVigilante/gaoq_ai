# 组织主数据外部投递可靠性运行手册

## 1. 权威边界与连接契约

ERP 是组织、员工与任职关系唯一主数据源。组织事件只允许沿
`ERP Outbox → integration_org_deliveries → 钉钉/飞书/OP` 单向下发；平台快照只用于
对账，禁止反向覆盖 ERP 主档。

- 钉钉部门创建携带 ERP `departmentId` 作为 `source_identifier`；员工首次开户只能走
  私密开户通道，通用组织 Outbox 不携带手机号或邮箱。
- 飞书部门创建使用 ERP 稳定 `department_id` 和由事件幂等键派生的
  `client_token`；员工首次开户同样由私密通道完成。
- OP 使用稳定资源 URI、`PUT`、HMAC 服务身份和
  `x-gaoq-erp-idempotency-key`，消费方必须把同键同载荷视为同一请求。
- 三个平台的 Token、Secret、原始响应和个人联系方式均不得写入投递记录、指标、
  日志、审计 metadata 或 MCP 参数。

员工首次开户私密通道只支持钉钉和飞书。API 只允许已验证 `user` 以专用 R3 Scope
提交，15 分钟密文使用独立 AES-256-GCM/HMAC 子密钥域；Worker 认领后再次校验
任务记录、敏感有效期和平台绑定。平台回读 userId 必须与 ERP 根据平台租户、员工
和渠道派生的确定性标识一致，外部租户、userId、unionId 任一损坏或漂移均进入
人工复核，不得绑定身份或考勤映射。

## 2. 版本、租约与不确定结果

每个 `tenantId + channel + aggregateType + aggregateId` 仅维护一条外部版本状态。
Worker 必须先检查低版本任务，再原子预留当前版本，平台成功后提交
`appliedVersion`，最后补写投递成功。

过期 `processing` 不得直接重新调用平台：

1. 若 `appliedVersion >= aggregateVersion`，只补写投递成功，不重复外部调用。
2. 若版本未提交，记录进入 `manual_review`，错误码为
   `ORG_DELIVERY_RESULT_INDETERMINATE`。
3. 平台已经返回成功、但版本或投递终态无法确认时，Worker 抛出
   `ORG_DELIVERY_STATE_UNAVAILABLE` 并保留现场；通用失败处理不得释放租约、增加重试
   次数或把已成功外部副作用写成失败。
4. 网络断开、响应读取失败、超限或成功响应格式无法确认时，按结果不确定隔离，不做
   自动重试。
5. 首次开户的 AccessProfile、ExternalIdentity、考勤 Provider 映射和开户成功终态
   在同一 Mongo 事务提交；提交后的会话清理或成功审计故障单独告警，不得回写失败。
   考勤映射必须确认活动事务，并同时按 ERP 员工与外部员工盲索引检查双向唯一性；
   只允许复用租户、平台、员工、盲索引和状态均反向匹配的活动最小投影。停用、
   一对多、多对一或损坏投影直接进入人工复核，不得依赖唯一索引异常继续重试。
   失败终态提交后的审计故障同样不得二次更新请求。

所有成功、失败、释放和恢复写入必须同时匹配事件、渠道、聚合版本、原尝试次数、
`processing` 状态和当前 Worker。`matchedCount != 1` 视为租约丢失，禁止覆盖其他
Worker 的状态。

## 3. 人工核验与恢复

先查询终态队列：

```http
GET /api/integrations/org-deliveries?status=manual_review&channel=dingtalk&limit=50
Authorization: Bearer <具备 erp:integration:org_delivery:read 的服务身份>
```

核对 ERP 事件版本、平台对象与当日对账报告后，才可执行 R2 恢复：

```http
POST /api/integrations/org-deliveries/{eventId}/{channel}/retries
Authorization: Bearer <具备 erp:integration:org_delivery:operate 的服务身份>
Idempotency-Key: <独立操作幂等键>
Content-Type: application/json

{"reason":"approved_exception"}
```

不得直接修改 MongoDB 状态、版本或锁字段。`credentials_fixed`、`mapping_fixed` 和
`provider_recovered` 只用于已确认没有成功副作用的确定性故障；结果不确定记录必须先
完成平台侧核验并走批准例外。

查询参数 `limit` 只接受规范十进制 `1..100`，禁止前导零、指数、符号或空白；
人工恢复正文只接受唯一 `reason` 字段，未知字段、Token、平台回执或任意覆盖状态
字段均在调用应用服务前拒绝。业务操作失败后的审计故障只记录稳定低敏告警并保留
原始业务异常；幂等事务已提交后的成功审计故障不得把成功响应改写为失败。

## 4. 对账与审计

每日对账只读取 active 平台绑定，比较 ERP 部门/员工、外部版本映射与平台快照。
差异报告只保存聚合标识、外部标识、差异类型和字段名，不保存外部姓名、手机号、
邮箱或响应正文。单次 ERP 期望对象和映射各不得超过 20,000，报告最多保存 1,000 条
差异并标记 `truncated`。

完成或失败报告写入必须仍匹配 `running` 租约；租约丢失不得追加错误审计。报告终态
已提交后的审计故障单独分类，不得把 `completed` 回写为 `failed`。

## 5. 指标、告警与处置

- `gaoq_org_delivery_total{channel,outcome}`：固定渠道和结果枚举计数。
- `gaoq_org_delivery_duration_seconds{channel,outcome}`：单次投递耗时。
- 任一 `state_unavailable` 立即触发 critical；任一 `manual_review` 或 `dead` 触发
  warning。

处置顺序固定为：冻结该聚合后续版本 → 保全事件/版本/审计记录 → 平台只读核验 →
判定已应用则补写成功、未应用则经 R2 恢复 → 运行当日对账。禁止通过清队列或批量
改状态消除告警。

## 6. MCP 边界

标准 MCP 组织能力继续使用 `get_org_chart`，复用组织应用服务和可信租户/部门数据
范围；不接受客户端租户参数。REST `GET /api/org/chart`、组织写响应和
`get_org_chart` 必须复用同一公开投影，只包含业务标识、组织字段和并发版本，
不得返回 `tenantId`、`createdAt`、`updatedAt`。MCP 输出 Schema 对组织图及其
元素使用严格对象，新增内部字段必须先建立独立公开契约和协议测试，不得被 Zod
默认剥离后静默放行。

投递列表、人工重试、凭据修复、平台写入和对账控制面均不暴露为 MCP
Tool/Resource/Prompt，AI 不得执行组织外部写入或 R2 恢复。

## 7. PC 授权与弱网重试

- PC 同时加载组织公开投影与 `/api/auth/profile` 可信身份摘要；只有摘要包含
  `erp:org:master:write` 才显示新建部门和新建员工入口。隐藏按钮只用于减少误操作，
  服务端 Scope Guard 仍是最终授权边界。
- 浏览器必须在渲染前严格校验组织图和写响应的字段、枚举、ULID、版本、数组上限与
  唯一性。未知字段、租户路由、持久化时间戳或损坏的主部门引用一律失败关闭。
- 创建载荷只能由白名单构造器生成，禁止展开任意表单对象，禁止提交 `tenantId`。
- 写请求的正文和幂等键必须在发起前绑定。超时、限流、处理中、5xx、网络断开或
  无法校验成功响应时，页面保留原正文和原幂等键，只提供“重试原请求”；只有服务端
  明确拒绝或可信主体变化才清除。结果未知期间禁止修改表单或关闭对话框。
- 弱网 UAT 必须分别验证请求未到达、服务端已提交但响应丢失、幂等处理中、明确
  4xx 拒绝、切换主体五条路径，并用服务端审计与最终主数据证明没有重复创建。

## 8. 仓库内验收

```bash
pnpm quality:org-delivery-reliability-coverage
pnpm quality:org-external-identity-boundary-coverage
pnpm quality:org-platform-adapters-coverage
pnpm quality:org-provisioning-coverage
pnpm --filter @gaoq/erp-web test
pnpm check
pnpm build
```

第一条专项门禁覆盖投递状态机、过期租约恢复、对账租约和队列载荷；第二条覆盖
活动绑定/身份最小投影、钉钉令牌外部租户反向绑定和 `unionId → userid` 回执；
第三条覆盖钉钉、飞书、OP 适配器与专用 HTTP 客户端的目标白名单、令牌刷新、
HMAC、身份恢复、分页和响应硬上限；第四条覆盖首次开户入口、编排、密钥环、
密文 Schema、平台凭据、适配器注册及考勤映射事务/双向唯一边界。四组目标文件
语句、分支、函数和行
覆盖率均不得低于 90%。当前组织投递 73 项、外部身份解析 20 项、平台边界
88 项、首次开户 124 项测试全部通过；组织投递五个
生产文件合计为 98.27%/97.70%/96.55%/98.34%，平台边界五个生产文件合计为
97.18%/95.18%/100%/97.99%，外部身份解析文件四维均为 100%，首次开户八个
生产文件合计为
99.02%/97.69%/100%/100%。真实平台沙箱回执、Secret 轮换、Prometheus 规则加载
和 24 小时演练属于外部验收，不能用本地测试替代。

组织公开投影还须由应用服务、REST 控制器、MCP Tool 与浏览器运行时契约共同覆盖；
本地测试只能证明字段闭包、授权入口和幂等重试状态机，不能替代真实浏览器网络故障
注入、实体角色矩阵与外部平台沙箱验收。
