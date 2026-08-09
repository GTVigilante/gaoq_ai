# AsyncAPI 3.0 与 CloudEvents 1.0 契约

## 1. 目的

`contracts/asyncapi/erp-events.asyncapi.json` 是 ERP 事务 Outbox 与独立专业算薪
平台双向事件的机器可读目录。它不替代业务模块运行时 Schema，而是把事件
`type`、`source`、收发方向、权威系统、数据分级、幂等规则和 Schema 源码位置
统一到 AsyncAPI 3.0。

所有消息采用 CloudEvents 1.0 结构化 JSON，`tenantId` 必须来自可信上下文。
事件目录不授权 MCP、AI 或普通 REST 客户端直接发布、消费、重放或修改 Outbox。

## 2. 确定性生成与门禁

```bash
pnpm contracts:asyncapi:generate
pnpm contracts:asyncapi:self-test
pnpm contracts:asyncapi:validate
```

- 生成器只扫描固定生产事件源，不扫描测试、构建产物或自由文本。
- `EVENT_TYPES` 必须是静态数组；事件 type 必须符合
  `cn.gaoq.(erp|payroll).<domain>.<action>.vN`。
- 同一 type 被多个运行时来源声明、专业算薪 source 映射缺失、事件数量或方向
  漂移时失败关闭。
- 生成结果无时间戳、机器路径、租户、Token、真实 Broker 或生产 Topic。
- `pretypecheck` 同时执行 OpenAPI 与 AsyncAPI 的正负自测和逐字节漂移校验，
  因而 `pnpm check` 自动包含两类机器契约。

## 3. 当前事件目录

| 领域 | 事件数 | 方向 |
|---|---:|---|
| Approval | 17 | ERP 出站 |
| Attendance | 13 | ERP 出站 |
| Care | 22 | ERP 出站 |
| Document | 1 | ERP 出站 |
| Dynamic Form | 5 | ERP 出站 |
| Knowledge | 15 | ERP 出站 |
| Marketing | 1 | ERP 出站 |
| Onboarding | 4 | ERP 出站 |
| OP | 1 | ERP 出站 |
| Org | 14 | ERP 出站 |
| Payroll（ERP 控制面） | 41 | ERP 出站 |
| Recruitment | 31 | ERP 出站 |
| Talent Lifecycle | 3 | ERP 出站 |
| Treasury | 14 | ERP 出站 |
| 专业算薪平台契约 | 7 | ERP→专业算薪 3；专业算薪→ERP 4 |
| **合计** | **189** | **出站 185；入站 4** |

专业算薪的 7 个事件来自 `packages/platform-contracts` 的冻结数组与逐 type
JSON Schema；兼容窗口内的 `com.gaoq.*` 旧 type 不进入现行目录。

## 4. 信封与负载边界

统一信封完整声明：

- `specversion = 1.0`；
- ULID `id`；
- 固定 `source` 和版本化 `type`；
- 有界 `subject`、规范 UTC `time`、`datacontenttype`；
- `tenantId`、`traceId`、`idempotencyKey`、`schemaVersion = 1`；
- 逐 type 的最小 `data`。

AsyncAPI 完整展开统一信封，并以 `x-runtime-schema-sources` 指向实际 Zod、
TypeScript 或 JSON Schema。复杂逐 type `data` 当前不在单一生成器中重复展开，
避免两个 Schema 源漂移；生产消费者必须同时使用所列运行时 Schema 与协议测试。

工资与资金事件只能携带汇总、状态和证据摘要，禁止员工级薪资、银行账号、
证件、盲索引或密文进入事件。外部专业算薪仍是生产算薪事实源，ERP 只接收脱敏
控制摘要。

## 5. 物理总线和外部验收

AsyncAPI 中的 Channel 地址是逻辑事件 type。物理 Broker、Topic、ACL、mTLS、
保留期、重试、死信、跨区复制和 WORM 证据必须由目标环境平台准入决定，不在
仓库中假定。

外部验收至少包括重复、乱序、超时、签名失败、跨租户、旧版本、死信重放、
断连追赶和对账。2026-08-01 的 `main` 已实际通过仓库 GitHub Hosted Actions；
该结果不能替代真实事件总线验收。
