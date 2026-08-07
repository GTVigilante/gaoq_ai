# 单机首发生产输入清单

本清单只记录字段名和约束，不记录任何密码、Token 或私钥。敏感值只能通过目标服务器
上的受保护运行时文件或 Secret Manager 注入，禁止提交到 Git 或发送到聊天记录。
目标服务器可从 `runtime/production-inputs.env.example` 创建权限为 `0600` 的
`production-inputs.env`，由企业运维直接填写；该文件不被当前 Compose 自动加载，
必须先通过离线校验，再原子合并到正式运行时配置。

## 企业身份与 OP

- `OP_API_BASE_URL`：OP 组织下发 API 的独立标准 HTTPS 根地址，不得与 ERP 同源。
- `OP_SSO_CLIENT_ID`、`OP_SSO_CLIENT_SECRET`：OP 中为 GaoQ ERP 创建的独立客户端。
- `OP_SSO_REDIRECT_URI`：必须精确为
  `https://aio.gaoq.com/api/auth/sso/op/callback`。

## 独立专业算薪与税务

- `PAYROLL_WEB_ORIGIN`：专业算薪系统的正式 HTTPS 访客地址，不得填写 ERP 自身地址。
- `PAYROLL_TAX_WORM_ARCHIVE_ENDPOINT`、`PAYROLL_TAX_WORM_ARCHIVE_BEARER_TOKEN`：
  税务证据独立 WORM 服务。
- `PAYROLL_TAX_GATEWAY_ENDPOINT`、`PAYROLL_TAX_GATEWAY_BEARER_TOKEN`：正式税务网关。
- WORM 与税务网关必须使用不同权限域和不同凭据。

## Treasury 外部服务

- `TREASURY_WORM_ARCHIVE_ENDPOINT`、`TREASURY_WORM_ARCHIVE_BEARER_TOKEN`。
- `TREASURY_BANK_SUBMISSION_ENDPOINT`、`TREASURY_BANK_SUBMISSION_BEARER_TOKEN`。
- `TREASURY_BANK_RETURN_INBOX_ENDPOINT`、`TREASURY_BANK_RETURN_INBOX_BEARER_TOKEN`。
- 三个服务必须使用相互隔离的标准 HTTPS 权限域，且不得复用凭据。

## eSign 与文件安全

- `ESIGN_API_BASE_URL=https://openapi.esign.cn`。
- `ESIGN_MALWARE_SCAN_ENDPOINT`、`ESIGN_MALWARE_SCAN_BEARER_TOKEN`。
- `ESIGN_WORM_ARCHIVE_ENDPOINT`、`ESIGN_WORM_ARCHIVE_BEARER_TOKEN`。
- 病毒扫描和 WORM 归档必须是独立 HTTPS 服务。

## 审计锚定

- `AUDIT_WORM_ENDPOINT`、`AUDIT_WORM_BEARER_TOKEN`。
- `AUDIT_ANCHOR_SIGNING_PRIVATE_KEY_BASE64`、`AUDIT_ANCHOR_SIGNING_KEY_ID`。
- 审计 WORM 必须处于独立权限域；签名私钥不得复用应用签名或数据加密密钥。

## 业务与域名输入

- ERP 中至少需要真实的部门、招聘需求和已开放职位；首发过程禁止自动写入演示数据。
- 如需启用 `https://gaoq.com`，须先把根域 DNS 切到目标服务器，再单独签发包含根域的
  证书；根域不得复用只包含 `www.gaoq.com` 的证书。

全部输入到位后，先在服务器离线执行生产环境校验；只有校验通过，才允许将
`GAOQ_NODE_ENV` 从 `development` 改为 `production` 并启用正式 Nginx 代理。
