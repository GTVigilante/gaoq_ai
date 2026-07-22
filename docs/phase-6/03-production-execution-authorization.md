# Phase 6 生产资金执行授权契约

- 文档编号：phase-6/03
- 状态：ERP 端授权客户端、银行/税务双重绑定与失败关闭已交付；外部授权域和真实资金通道尚未验收

## 边界

银行代发与税务申报是 R3 生产动作。它们不注册为 MCP Tool，不接受 Web、REST 或 AI 客户端传入的租户、授权标识、发布版本或 WORM 证据。调用主体仍必须是受信任的银行/税务服务身份；Phase 4 与所有非生产环境继续固定为 `sandbox`。

`production` 不再依赖单一环境开关直接放行。ERP 应用服务必须先向独立 Phase 6 授权域申请一次性短时授权，银行或税务 Adapter 再把该授权引用随不可变对象摘要提交给隔离网关。网关必须独立查询授权域并在受理回执中精确回显授权与 WORM 证据；任一层不匹配都失败关闭。

## 授权对象

授权请求只包含控制面字段，不含账号、人员、工资明细、税务身份或文件正文：

- `action`：仅 `treasury-bank-submission` 或 `payroll-tax-submission`；
- 可信租户、业务对象标识、期望版本和对象控制摘要；
- 当前发布 commit 与部署清单 SHA-256；
- 请求时间和确定性幂等键。

授权回执必须为严格白名单 JSON，声明 `approved=true`、`singleUse=true`，并原样绑定上述全部字段。签发时间最多可回溯 5 分钟，有效期最多 15 分钟且在调用时至少剩余 30 秒。授权标识、授权 WORM 证据和银行/税务受理证据必须相互独立。

## 配置与隔离

生产发布平台必须成套注入：

```text
PHASE6_PRODUCTION_AUTHORIZATION_ENDPOINT
PHASE6_PRODUCTION_AUTHORIZATION_BEARER_TOKEN
PHASE6_RELEASE_COMMIT_SHA
PHASE6_DEPLOYMENT_MANIFEST_SHA256
```

授权端点必须使用标准 HTTPS，不得携带 URL 凭据、query、fragment 或非 443 端口；其 Origin 必须与 ERP 授权服务器、Treasury WORM、银行提交、银行回盘、Payroll Tax WORM 和税务网关全部隔离。Bearer Token 不得复用任何资金、税务或 WORM 凭据。银行或税务任一模式设为 `production` 而四项配置不完整时，应用启动即失败；`NODE_ENV` 不是 `production` 时也禁止启用真实通道。

## 执行顺序

1. Phase 5 十二 Gate Go/No-Go 仍有效，发布 commit、三份镜像和部署清单已冻结。
2. 获批变更单、生产窗口、操作人与复核人记录进入企业 WORM；外部授权域才允许签发对象级授权。
3. ERP 服务身份读取已批准且已 WORM 归档的批次或税务清单，计算控制摘要并申请授权。
4. ERP 先固化 `submitting` 状态，再调用隔离银行/税务网关；网关独立核验授权后返回绑定回执。
5. ERP 只在回执的业务对象、摘要、控制量和授权证据全部匹配时固化 `submitted` 并写 Outbox。

授权失败发生在 `submitting` 之前，不产生外呼；网关失败保留 `submitting` 供同版本幂等恢复。授权过期、错租户、错对象、错版本、错发布物、重复消费或上游未回显一律拒绝，不允许手工修改数据库或通过 Issue 评论放行。

## 验收

- sandbox 请求体保持旧协议，不携带生产授权；
- production 缺授权、过期授权、错摘要和错发布物全部失败；
- 银行与税务网关分别验证授权回显，不能互相复用；
- Outbox 在生产提交事件中记录脱敏授权证据标识，不记录 Token、授权正文或业务敏感字段；
- MCP 能力目录继续保持 R3 数量为零。

统一切换的 `gaoq.phase6.cutover.v1` 证据还必须包含独立 `productionExecution` 节。它按同一发布 commit 和部署清单核验策略启用时间、900 秒最大有效期、六项强绑定、凭据隔离，以及银行/税务各自的成功、重放拒绝和错绑定拒绝证据；该节未通过时不得生成 `CUTOVER_COMPLETED`。
