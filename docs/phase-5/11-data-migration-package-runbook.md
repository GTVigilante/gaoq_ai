# Phase 5 数据迁移来源包运行手册

## 固定格式

每个来源包是一个独立目录，只允许两个文件：`manifest.json` 与 `records.ndjson`。`manifest.json` 固定字段如下：

```json
{
  "formatVersion": 1,
  "sourceSystem": "legacy-hr",
  "sourceRunId": "full-20260722-001",
  "mode": "full",
  "scope": "org_reference",
  "expectedSourceCount": 1,
  "expectedSourceChecksum": "base64url-sha256"
}
```

`records.ndjson` 每行是一条完整 JSON 记录，字段与迁移记录 REST 契约一致。禁止空行、额外字段和超过 10 MiB 的单行；序号必须从 1 连续递增。来源生成器必须先计算 payload 摘要，再按控制面契约计算 `sourceFactHash` 与滚动校验和。来源包不得纳入 Git，必须位于受控迁移工作区并执行保留期与销毁策略。

## 离线预检

```bash
pnpm --filter @gaoq/erp-api build
pnpm --filter @gaoq/erp-api migration:package -- validate /secure/path/to/package
```

预检会完整流式读取 NDJSON，核对 JSON 结构、连续序号、来源记录唯一性、payload SHA-256、Scope、总数与滚动校验和。任何失败都发生在调用 ERP 之前；输出只包含 Scope、来源运行 ID、记录数和校验和，不输出 payload、姓名或附件内容。

## 应用与断点续传

```bash
export ERP_API_BASE_URL=https://erp.example.com/api
export ERP_MIGRATION_TOKEN=从受控密钥系统短期签发的服务令牌
pnpm --filter @gaoq/erp-api migration:package -- apply /secure/path/to/package
unset ERP_MIGRATION_TOKEN
```

令牌必须绑定可信租户、`service|system_job` 身份以及 `erp:migration:execute`、`erp:org:master:write` Scope。工具不接受命令行 Token，避免进入 shell history；除 `localhost`/`127.0.0.1` 外只允许 HTTPS。每次 apply 都先完整预检，然后幂等创建来源运行；服务端返回的 checkpoint 决定续传起点，已确认序号不会再次发送。全部记录处理后调用 complete 并输出聚合差异报告。

## 操作门禁

- 生产 apply 前必须完成来源包双人校验、恶意文件扫描、备份、变更单和演练编号登记。
- 任何 `rejected`、未解析关联、未决/拒绝附件、来源总数或校验和差异都禁止进入 Phase 6。
- 工具不会替代领域校验，也不会直接连接 MongoDB；所有目标写入仍由 REST 进入应用服务。
- 网络超时或进程中断后使用同一来源包重跑 apply；禁止修改原包后复用 `sourceRunId`。
- 当前实现会在预检期间维护来源记录 ID 集合；超大数据包必须按已批准 Scope 和容量演练结果拆分，不得绕过服务端总控制量。
