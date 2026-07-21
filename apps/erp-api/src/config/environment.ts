import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  WORKER_METRICS_PORT: z.coerce.number().int().min(1).max(65_535).default(9464),
  MONGODB_URI: z.string().url().startsWith('mongodb://'),
  REDIS_URL: z.string().url().startsWith('redis://'),
  WEB_ORIGIN: z.string().url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  AUTH_ISSUER: z.string().url(),
  AUTH_AUDIENCE: z.string().min(1),
  AUTH_RESOURCE: z.string().url(),
  AUTH_JWKS_URI: z.string().url(),
  AUTH_SIGNING_PRIVATE_KEY_BASE64: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(64).optional(),
  ),
  AUTH_SIGNING_KEY_ID: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(8).max(128).regex(/^[A-Za-z0-9._-]+$/).optional(),
  ),
  /** 审计 HMAC 密钥环，仅由 Secret Manager 注入，仓库内必须保持为空。 */
  AUDIT_INTEGRITY_KEYS: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(64).max(16_384).optional(),
  ),
  /** 审批表单 AES-256-GCM 密钥环，仅由 Secret Manager 注入。 */
  APPROVAL_DATA_ENCRYPTION_KEYS: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(64).max(16_384).optional(),
  ),
  /** 招聘 L3/L4 数据密钥环，与审批和盲索引密钥域隔离。 */
  RECRUITMENT_DATA_ENCRYPTION_KEYS: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(64).max(16_384).optional(),
  ),
  /** 招聘精确去重 HMAC 密钥环；不得复用数据加密密钥。 */
  RECRUITMENT_BLIND_INDEX_KEYS: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(64).max(16_384).optional(),
  ),
  /** 考勤 L4 明细密钥环，与招聘、审批和盲索引密钥域隔离。 */
  ATTENDANCE_DATA_ENCRYPTION_KEYS: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(64).max(16_384).optional(),
  ),
  /** 考勤外部事件精确去重 HMAC 密钥环；不得复用数据加密密钥。 */
  ATTENDANCE_BLIND_INDEX_KEYS: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(64).max(16_384).optional(),
  ),
  /** 薪酬 L4 输入、步骤和结果密钥环；不得复用考勤、审批或招聘密钥。 */
  PAYROLL_DATA_ENCRYPTION_KEYS: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(64).max(16_384).optional(),
  ),
  /** 个税内部规范清单专用 WORM；与 Treasury 和税务提交网关权限域隔离。 */
  PAYROLL_TAX_WORM_ARCHIVE_ENDPOINT: z.preprocess(
    (value) => value === '' ? undefined : value, z.string().url().optional(),
  ),
  PAYROLL_TAX_WORM_ARCHIVE_BEARER_TOKEN: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(32).max(512).regex(/^[\x21-\x7e]+$/).optional(),
  ),
  PAYROLL_TAX_WORM_RETENTION_DAYS: z.coerce.number().int().min(3_650).max(36_500).default(3_650),
  /** 隔离税务网关负责身份凭证解析、地区官方格式转换、签名与申报。 */
  PAYROLL_TAX_GATEWAY_ENDPOINT: z.preprocess(
    (value) => value === '' ? undefined : value, z.string().url().optional(),
  ),
  PAYROLL_TAX_GATEWAY_BEARER_TOKEN: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(32).max(512).regex(/^[\x21-\x7e]+$/).optional(),
  ),
  /** Phase 6 总体 Go/No-Go 门禁落地前必须保持 sandbox；production 当前失败关闭。 */
  PAYROLL_TAX_GATEWAY_MODE: z.enum(['sandbox', 'production']).default('sandbox'),
  /** 资金账号、支付指令、银行文件与回盘正文专用密钥环；不得复用薪酬密钥。 */
  TREASURY_DATA_ENCRYPTION_KEYS: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(64).max(16_384).optional(),
  ),
  /** 银行账号精确匹配 HMAC 密钥环；不得复用资金数据加密密钥。 */
  TREASURY_BLIND_INDEX_KEYS: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(64).max(16_384).optional(),
  ),
  /** 银行代发文件专用 WORM 归档；与 ERP 应用权限域隔离。 */
  TREASURY_WORM_ARCHIVE_ENDPOINT: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().url().optional(),
  ),
  TREASURY_WORM_ARCHIVE_BEARER_TOKEN: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(32).max(512).regex(/^[\x21-\x7e]+$/).optional(),
  ),
  TREASURY_WORM_RETENTION_DAYS: z.coerce.number().int().min(3_650).max(36_500).default(3_650),
  /** 银行代发提交网关；只接收 WORM 对象引用与控制摘要，不接收 ERP 银行凭据。 */
  TREASURY_BANK_SUBMISSION_ENDPOINT: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().url().optional(),
  ),
  TREASURY_BANK_SUBMISSION_BEARER_TOKEN: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(32).max(512).regex(/^[\x21-\x7e]+$/).optional(),
  ),
  /** Phase 6 总体 Go/No-Go 门禁落地前必须保持 sandbox；production 当前失败关闭。 */
  TREASURY_BANK_SUBMISSION_MODE: z.enum(['sandbox', 'production']).default('sandbox'),
  /** 银行回盘隔离 Inbox；在返回规范清单前完成验签、扫描与 WORM 留档。 */
  TREASURY_BANK_RETURN_INBOX_ENDPOINT: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().url().optional(),
  ),
  TREASURY_BANK_RETURN_INBOX_BEARER_TOKEN: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(32).max(512).regex(/^[\x21-\x7e]+$/).optional(),
  ),
  /** eSign Webhook L4 加密密钥环，仅由 Secret Manager 注入。 */
  ESIGN_WEBHOOK_ENCRYPTION_KEYS: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(64).max(16_384).optional(),
  ),
  /** OP 经营摘要原始请求专用 AES-256-GCM 密钥环；不得复用 eSign 或业务数据密钥。 */
  OP_WEBHOOK_ENCRYPTION_KEYS: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(64).max(16_384).optional(),
  ),
  /** OP 组织下发 API 根地址；只允许标准 HTTPS 且不得携带凭据、query 或 fragment。 */
  OP_API_BASE_URL: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().url().optional(),
  ),
  /** eSign OpenAPI 只允许官方生产或沙箱域名，禁止自定义地址导致 SSRF。 */
  ESIGN_API_BASE_URL: z.enum([
    'https://openapi.esign.cn', 'https://smlopenapi.esign.cn',
  ]).default('https://smlopenapi.esign.cn'),
  /** eSign 合同病毒扫描网关；正文只通过 HTTPS 请求体传输，凭据由 Secret Manager 注入。 */
  ESIGN_MALWARE_SCAN_ENDPOINT: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().url().optional(),
  ),
  ESIGN_MALWARE_SCAN_BEARER_TOKEN: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(32).max(512).regex(/^[\x21-\x7e]+$/).optional(),
  ),
  /** eSign 合同独立 WORM 归档网关；不得与 ERP 授权域同源。 */
  ESIGN_WORM_ARCHIVE_ENDPOINT: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().url().optional(),
  ),
  ESIGN_WORM_ARCHIVE_BEARER_TOKEN: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(32).max(512).regex(/^[\x21-\x7e]+$/).optional(),
  ),
  ESIGN_WORM_RETENTION_DAYS: z.coerce.number().int().min(3_650).max(36_500).default(3_650),
  /** Prometheus 独立抓取凭据，仅由 Secret Manager 注入，不复用业务 OAuth token。 */
  METRICS_BEARER_TOKEN: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(32).max(256).regex(/^[\x21-\x7e]+$/).optional(),
  ),
  /** 独立 WORM 平台写入端点与凭据；不得指向 ERP 自身或普通可变对象存储。 */
  AUDIT_WORM_ENDPOINT: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().url().optional(),
  ),
  AUDIT_WORM_BEARER_TOKEN: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(32).max(512).regex(/^[\x21-\x7e]+$/).optional(),
  ),
  /** 审计锚点专用 Ed25519 PKCS#8 私钥及 key id，只由 KMS/Secret Manager 注入。 */
  AUDIT_ANCHOR_SIGNING_PRIVATE_KEY_BASE64: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(64).max(8_192).optional(),
  ),
  AUDIT_ANCHOR_SIGNING_KEY_ID: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(8).max(128).regex(/^[A-Za-z0-9._-]+$/).optional(),
  ),
  AUDIT_WORM_RETENTION_DAYS: z.coerce.number().int().min(365).max(36_500).default(2_555),
  AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).max(900).default(600),
  AUTH_REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(86_400)
    .max(2_592_000)
    .default(2_592_000),
  MCP_AUTHORIZATION_SERVER: z.string().url(),
  MCP_ALLOWED_ORIGINS: z.string().min(1),
  /** 预注册公共 MCP OAuth 客户端；仅含公开标识、回调和授权范围，不得包含密钥。 */
  MCP_OAUTH_CLIENTS_JSON: z.string().default('[]'),
  /** 无人值守 MCP 服务客户端；只允许凭据摘要或公钥，禁止明文 secret 与私钥。 */
  MCP_SERVICE_CLIENTS_JSON: z.string().default('[]'),
  DINGTALK_CLIENT_ID: z.string().optional(),
  DINGTALK_CLIENT_SECRET: z.string().optional(),
  DINGTALK_REDIRECT_URI: z.string().url().optional(),
  FEISHU_CLIENT_ID: z.string().optional(),
  FEISHU_CLIENT_SECRET: z.string().optional(),
  FEISHU_REDIRECT_URI: z.string().url().optional(),
}).superRefine((environment, context) => {
  const issuer = new URL(environment.AUTH_ISSUER);
  const authorizationServer = new URL(environment.MCP_AUTHORIZATION_SERVER);
  const resource = new URL(environment.AUTH_RESOURCE);
  if (
    issuer.pathname !== '/' || issuer.search !== '' || issuer.hash !== '' ||
    authorizationServer.origin !== issuer.origin || authorizationServer.pathname !== '/' ||
    authorizationServer.search !== '' || authorizationServer.hash !== ''
  ) {
    context.addIssue({
      code: 'custom',
      path: ['MCP_AUTHORIZATION_SERVER'],
      message: '内建 MCP OAuth 授权服务器必须与无路径 AUTH_ISSUER 同源且位于根路径',
    });
  }
  if (environment.AUTH_JWKS_URI !== new URL('/.well-known/jwks.json', issuer).toString()) {
    context.addIssue({
      code: 'custom',
      path: ['AUTH_JWKS_URI'],
      message: '内建授权服务器的 AUTH_JWKS_URI 必须指向 issuer 的 /.well-known/jwks.json',
    });
  }
  if (resource.hash !== '' || resource.username !== '' || resource.password !== '') {
    context.addIssue({
      code: 'custom',
      path: ['AUTH_RESOURCE'],
      message: 'AUTH_RESOURCE 禁止凭据与 fragment',
    });
  }
  if (
    environment.NODE_ENV === 'production' &&
    (environment.AUTH_SIGNING_PRIVATE_KEY_BASE64 === undefined ||
      environment.AUTH_SIGNING_KEY_ID === undefined)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['AUTH_SIGNING_PRIVATE_KEY_BASE64'],
      message: '生产环境必须由 Secret Manager 注入签名私钥与 key id',
    });
  }
  if (
    environment.NODE_ENV === 'production' &&
    environment.PAYROLL_DATA_ENCRYPTION_KEYS === undefined
  ) context.addIssue({
    code: 'custom', path: ['PAYROLL_DATA_ENCRYPTION_KEYS'],
    message: '生产环境必须由 Secret Manager 注入薪酬数据独立密钥环',
  });
  if (
    environment.NODE_ENV === 'production' &&
    (environment.TREASURY_DATA_ENCRYPTION_KEYS === undefined ||
      environment.TREASURY_BLIND_INDEX_KEYS === undefined)
  ) context.addIssue({
    code: 'custom', path: ['TREASURY_DATA_ENCRYPTION_KEYS'],
    message: '生产环境必须由 Secret Manager 注入资金数据与盲索引独立密钥环',
  });
  if (
    environment.TREASURY_DATA_ENCRYPTION_KEYS !== undefined &&
    environment.TREASURY_DATA_ENCRYPTION_KEYS === environment.TREASURY_BLIND_INDEX_KEYS
  ) context.addIssue({
    code: 'custom', path: ['TREASURY_BLIND_INDEX_KEYS'],
    message: '资金数据加密与账号盲索引不得复用同一密钥环',
  });
  const treasuryArchive = [
    environment.TREASURY_WORM_ARCHIVE_ENDPOINT,
    environment.TREASURY_WORM_ARCHIVE_BEARER_TOKEN,
  ];
  if (
    treasuryArchive.some((value) => value !== undefined) &&
    treasuryArchive.some((value) => value === undefined)
  ) context.addIssue({
    code: 'custom', path: ['TREASURY_WORM_ARCHIVE_ENDPOINT'],
    message: 'Treasury WORM 端点与凭据必须成套配置',
  });
  if (
    environment.NODE_ENV === 'production' &&
    treasuryArchive.some((value) => value === undefined)
  ) context.addIssue({
    code: 'custom', path: ['TREASURY_WORM_ARCHIVE_ENDPOINT'],
    message: '生产环境必须完整配置 Treasury 独立 WORM 归档',
  });
  if (environment.TREASURY_WORM_ARCHIVE_ENDPOINT !== undefined) {
    const endpoint = new URL(environment.TREASURY_WORM_ARCHIVE_ENDPOINT);
    if (
      endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '' ||
      endpoint.search !== '' || endpoint.hash !== '' ||
      (endpoint.port !== '' && endpoint.port !== '443') || endpoint.origin === issuer.origin
    ) context.addIssue({
      code: 'custom', path: ['TREASURY_WORM_ARCHIVE_ENDPOINT'],
      message: 'Treasury WORM 必须为独立权限域 HTTPS，且禁止凭据、查询、fragment 和非标准端口',
    });
  }
  const treasuryBank = [
    environment.TREASURY_BANK_SUBMISSION_ENDPOINT,
    environment.TREASURY_BANK_SUBMISSION_BEARER_TOKEN,
  ];
  if (
    treasuryBank.some((value) => value !== undefined) &&
    treasuryBank.some((value) => value === undefined)
  ) context.addIssue({
    code: 'custom', path: ['TREASURY_BANK_SUBMISSION_ENDPOINT'],
    message: 'Treasury 银行提交端点与凭据必须成套配置',
  });
  if (
    environment.NODE_ENV === 'production' && treasuryBank.some((value) => value === undefined)
  ) context.addIssue({
    code: 'custom', path: ['TREASURY_BANK_SUBMISSION_ENDPOINT'],
    message: '生产环境必须完整配置 Treasury 独立银行提交网关',
  });
  if (
    environment.TREASURY_BANK_SUBMISSION_BEARER_TOKEN !== undefined &&
    environment.TREASURY_BANK_SUBMISSION_BEARER_TOKEN ===
      environment.TREASURY_WORM_ARCHIVE_BEARER_TOKEN
  ) context.addIssue({
    code: 'custom', path: ['TREASURY_BANK_SUBMISSION_BEARER_TOKEN'],
    message: 'Treasury 银行提交与 WORM 归档不得复用同一凭据',
  });
  if (environment.TREASURY_BANK_SUBMISSION_ENDPOINT !== undefined) {
    const endpoint = new URL(environment.TREASURY_BANK_SUBMISSION_ENDPOINT);
    const archiveOrigin = environment.TREASURY_WORM_ARCHIVE_ENDPOINT === undefined
      ? null : new URL(environment.TREASURY_WORM_ARCHIVE_ENDPOINT).origin;
    if (
      endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '' ||
      endpoint.search !== '' || endpoint.hash !== '' ||
      (endpoint.port !== '' && endpoint.port !== '443') || endpoint.origin === issuer.origin ||
      endpoint.origin === archiveOrigin
    ) context.addIssue({
      code: 'custom', path: ['TREASURY_BANK_SUBMISSION_ENDPOINT'],
      message: 'Treasury 银行提交网关必须为独立权限域 HTTPS，且禁止凭据、查询、fragment 和非标准端口',
    });
  }
  const treasuryReturnInbox = [
    environment.TREASURY_BANK_RETURN_INBOX_ENDPOINT,
    environment.TREASURY_BANK_RETURN_INBOX_BEARER_TOKEN,
  ];
  if (
    treasuryReturnInbox.some((value) => value !== undefined) &&
    treasuryReturnInbox.some((value) => value === undefined)
  ) context.addIssue({
    code: 'custom', path: ['TREASURY_BANK_RETURN_INBOX_ENDPOINT'],
    message: 'Treasury 回盘 Inbox 端点与凭据必须成套配置',
  });
  if (
    environment.NODE_ENV === 'production' &&
    treasuryReturnInbox.some((value) => value === undefined)
  ) context.addIssue({
    code: 'custom', path: ['TREASURY_BANK_RETURN_INBOX_ENDPOINT'],
    message: '生产环境必须完整配置 Treasury 独立回盘 Inbox',
  });
  if (environment.TREASURY_BANK_RETURN_INBOX_ENDPOINT !== undefined) {
    const endpoint = new URL(environment.TREASURY_BANK_RETURN_INBOX_ENDPOINT);
    const forbiddenOrigins = [
      issuer.origin,
      environment.TREASURY_WORM_ARCHIVE_ENDPOINT === undefined
        ? null : new URL(environment.TREASURY_WORM_ARCHIVE_ENDPOINT).origin,
      environment.TREASURY_BANK_SUBMISSION_ENDPOINT === undefined
        ? null : new URL(environment.TREASURY_BANK_SUBMISSION_ENDPOINT).origin,
    ];
    if (
      endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '' ||
      endpoint.search !== '' || endpoint.hash !== '' ||
      (endpoint.port !== '' && endpoint.port !== '443') || forbiddenOrigins.includes(endpoint.origin)
    ) context.addIssue({
      code: 'custom', path: ['TREASURY_BANK_RETURN_INBOX_ENDPOINT'],
      message: 'Treasury 回盘 Inbox 必须为独立权限域 HTTPS，且禁止凭据、查询、fragment 和非标准端口',
    });
  }
  if (
    environment.TREASURY_BANK_RETURN_INBOX_BEARER_TOKEN !== undefined &&
    [environment.TREASURY_WORM_ARCHIVE_BEARER_TOKEN,
      environment.TREASURY_BANK_SUBMISSION_BEARER_TOKEN]
      .includes(environment.TREASURY_BANK_RETURN_INBOX_BEARER_TOKEN)
  ) context.addIssue({
    code: 'custom', path: ['TREASURY_BANK_RETURN_INBOX_BEARER_TOKEN'],
    message: 'Treasury 回盘 Inbox 不得复用 WORM 或银行提交凭据',
  });
  const payrollTaxInfrastructure = [
    environment.PAYROLL_TAX_WORM_ARCHIVE_ENDPOINT,
    environment.PAYROLL_TAX_WORM_ARCHIVE_BEARER_TOKEN,
    environment.PAYROLL_TAX_GATEWAY_ENDPOINT,
    environment.PAYROLL_TAX_GATEWAY_BEARER_TOKEN,
  ];
  if (
    payrollTaxInfrastructure.some((value) => value !== undefined) &&
    payrollTaxInfrastructure.some((value) => value === undefined)
  ) context.addIssue({
    code: 'custom', path: ['PAYROLL_TAX_WORM_ARCHIVE_ENDPOINT'],
    message: 'Payroll Tax WORM 与税务网关端点及凭据必须成套配置',
  });
  if (
    environment.NODE_ENV === 'production' &&
    payrollTaxInfrastructure.some((value) => value === undefined)
  ) context.addIssue({
    code: 'custom', path: ['PAYROLL_TAX_WORM_ARCHIVE_ENDPOINT'],
    message: '生产环境必须完整配置 Payroll Tax WORM 与税务网关',
  });
  const payrollTaxOrigins = [
    environment.PAYROLL_TAX_WORM_ARCHIVE_ENDPOINT,
    environment.PAYROLL_TAX_GATEWAY_ENDPOINT,
  ].filter((value): value is string => value !== undefined).map((value) => new URL(value));
  const forbiddenTaxOrigins = new Set([
    issuer.origin,
    ...[environment.TREASURY_WORM_ARCHIVE_ENDPOINT,
      environment.TREASURY_BANK_SUBMISSION_ENDPOINT,
      environment.TREASURY_BANK_RETURN_INBOX_ENDPOINT]
      .filter((value): value is string => value !== undefined)
      .map((value) => new URL(value).origin),
  ]);
  for (const endpoint of payrollTaxOrigins) {
    if (
      endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '' ||
      endpoint.search !== '' || endpoint.hash !== '' ||
      (endpoint.port !== '' && endpoint.port !== '443') || forbiddenTaxOrigins.has(endpoint.origin)
    ) context.addIssue({
      code: 'custom', path: ['PAYROLL_TAX_WORM_ARCHIVE_ENDPOINT'],
      message: 'Payroll Tax 外部服务必须使用相互隔离的标准 HTTPS 权限域',
    });
    forbiddenTaxOrigins.add(endpoint.origin);
  }
  const treasuryTokens = [
    environment.TREASURY_WORM_ARCHIVE_BEARER_TOKEN,
    environment.TREASURY_BANK_SUBMISSION_BEARER_TOKEN,
    environment.TREASURY_BANK_RETURN_INBOX_BEARER_TOKEN,
  ];
  if (
    environment.PAYROLL_TAX_WORM_ARCHIVE_BEARER_TOKEN !== undefined &&
    (
      environment.PAYROLL_TAX_WORM_ARCHIVE_BEARER_TOKEN ===
        environment.PAYROLL_TAX_GATEWAY_BEARER_TOKEN ||
      treasuryTokens.includes(environment.PAYROLL_TAX_WORM_ARCHIVE_BEARER_TOKEN)
    )
  ) context.addIssue({
    code: 'custom', path: ['PAYROLL_TAX_WORM_ARCHIVE_BEARER_TOKEN'],
    message: 'Payroll Tax WORM 不得复用税务网关或 Treasury 凭据',
  });
  if (
    environment.PAYROLL_TAX_GATEWAY_BEARER_TOKEN !== undefined &&
    treasuryTokens.includes(environment.PAYROLL_TAX_GATEWAY_BEARER_TOKEN)
  ) context.addIssue({
    code: 'custom', path: ['PAYROLL_TAX_GATEWAY_BEARER_TOKEN'],
    message: 'Payroll Tax 税务网关不得复用 Treasury 凭据',
  });
  if (environment.NODE_ENV === 'production' && environment.ESIGN_WEBHOOK_ENCRYPTION_KEYS === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['ESIGN_WEBHOOK_ENCRYPTION_KEYS'],
      message: '生产环境必须由 Secret Manager 注入 eSign Webhook 加密密钥环',
    });
  }
  if (environment.NODE_ENV === 'production' && environment.OP_WEBHOOK_ENCRYPTION_KEYS === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['OP_WEBHOOK_ENCRYPTION_KEYS'],
      message: '生产环境必须由 Secret Manager 注入 OP Webhook 独立加密密钥环',
    });
  }
  if (environment.NODE_ENV === 'production' && environment.OP_API_BASE_URL === undefined) {
    context.addIssue({
      code: 'custom', path: ['OP_API_BASE_URL'],
      message: '生产环境必须配置 OP 组织下发独立 HTTPS API 根地址',
    });
  }
  if (environment.OP_API_BASE_URL !== undefined) {
    const endpoint = new URL(environment.OP_API_BASE_URL);
    if (
      endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '' ||
      endpoint.search !== '' || endpoint.hash !== '' || endpoint.pathname !== '/' ||
      (endpoint.port !== '' && endpoint.port !== '443') || endpoint.origin === issuer.origin
    ) context.addIssue({
      code: 'custom', path: ['OP_API_BASE_URL'],
      message: 'OP API 必须是独立权限域的标准 HTTPS 根地址，禁止凭据、路径、query、fragment 和非标准端口',
    });
  }
  if (
    environment.NODE_ENV === 'production' &&
    environment.ESIGN_API_BASE_URL !== 'https://openapi.esign.cn'
  ) {
    context.addIssue({
      code: 'custom', path: ['ESIGN_API_BASE_URL'],
      message: '生产环境 eSign OpenAPI 必须使用官方生产域名',
    });
  }
  const evidenceInfrastructure = [
    environment.ESIGN_MALWARE_SCAN_ENDPOINT,
    environment.ESIGN_MALWARE_SCAN_BEARER_TOKEN,
    environment.ESIGN_WORM_ARCHIVE_ENDPOINT,
    environment.ESIGN_WORM_ARCHIVE_BEARER_TOKEN,
  ];
  if (
    evidenceInfrastructure.some((value) => value !== undefined) &&
    evidenceInfrastructure.some((value) => value === undefined)
  ) context.addIssue({
    code: 'custom', path: ['ESIGN_MALWARE_SCAN_ENDPOINT'],
    message: 'eSign 扫描与 WORM 归档端点及凭据必须成套配置',
  });
  if (
    environment.NODE_ENV === 'production' &&
    evidenceInfrastructure.some((value) => value === undefined)
  ) context.addIssue({
    code: 'custom', path: ['ESIGN_MALWARE_SCAN_ENDPOINT'],
    message: '生产环境必须完整配置 eSign 病毒扫描与独立 WORM 归档',
  });
  for (const [field, value] of [
    ['ESIGN_MALWARE_SCAN_ENDPOINT', environment.ESIGN_MALWARE_SCAN_ENDPOINT],
    ['ESIGN_WORM_ARCHIVE_ENDPOINT', environment.ESIGN_WORM_ARCHIVE_ENDPOINT],
  ] as const) {
    if (value === undefined) continue;
    const endpoint = new URL(value);
    if (
      endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '' ||
      endpoint.search !== '' || endpoint.hash !== '' ||
      (endpoint.port !== '' && endpoint.port !== '443') || endpoint.origin === issuer.origin
    ) context.addIssue({
      code: 'custom', path: [field],
      message: 'eSign 证据端点必须为独立权限域 HTTPS，且禁止凭据、查询、fragment 和非标准端口',
    });
  }
  if (
    environment.NODE_ENV === 'production' &&
    new URL(environment.WEB_ORIGIN).protocol !== 'https:'
  ) {
    context.addIssue({
      code: 'custom',
      path: ['WEB_ORIGIN'],
      message: '生产环境 WebAuthn 依赖可信安全上下文，WEB_ORIGIN 必须使用 HTTPS',
    });
  }
  if (environment.NODE_ENV === 'production' && environment.AUDIT_INTEGRITY_KEYS === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['AUDIT_INTEGRITY_KEYS'],
      message: '生产环境必须由 Secret Manager 注入审计完整性密钥环',
    });
  }
  if (environment.NODE_ENV === 'production' && environment.APPROVAL_DATA_ENCRYPTION_KEYS === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['APPROVAL_DATA_ENCRYPTION_KEYS'],
      message: '生产环境必须由 Secret Manager 注入审批表单加密密钥环',
    });
  }
  if (
    environment.NODE_ENV === 'production' &&
    (environment.RECRUITMENT_DATA_ENCRYPTION_KEYS === undefined ||
      environment.RECRUITMENT_BLIND_INDEX_KEYS === undefined)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['RECRUITMENT_DATA_ENCRYPTION_KEYS'],
      message: '生产环境必须由 Secret Manager 注入招聘数据与盲索引独立密钥环',
    });
  }
  if (
    environment.NODE_ENV === 'production' &&
    (environment.ATTENDANCE_DATA_ENCRYPTION_KEYS === undefined ||
      environment.ATTENDANCE_BLIND_INDEX_KEYS === undefined)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['ATTENDANCE_DATA_ENCRYPTION_KEYS'],
      message: '生产环境必须由 Secret Manager 注入考勤数据与盲索引独立密钥环',
    });
  }
  if (environment.NODE_ENV === 'production' && environment.METRICS_BEARER_TOKEN === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['METRICS_BEARER_TOKEN'],
      message: '生产环境必须由 Secret Manager 注入指标抓取凭据',
    });
  }
  if (environment.NODE_ENV === 'production') {
    const wormFields = [
      environment.AUDIT_WORM_ENDPOINT,
      environment.AUDIT_WORM_BEARER_TOKEN,
      environment.AUDIT_ANCHOR_SIGNING_PRIVATE_KEY_BASE64,
      environment.AUDIT_ANCHOR_SIGNING_KEY_ID,
    ];
    if (wormFields.some((value) => value === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['AUDIT_WORM_ENDPOINT'],
        message: '生产环境必须完整配置独立 WORM 锚定端点、凭据与专用签名密钥',
      });
    }
    if (
      environment.AUDIT_WORM_ENDPOINT !== undefined &&
      new URL(environment.AUDIT_WORM_ENDPOINT).protocol !== 'https:'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['AUDIT_WORM_ENDPOINT'],
        message: '生产环境 WORM 锚定端点必须使用 HTTPS',
      });
    }
    if (environment.AUDIT_WORM_ENDPOINT !== undefined) {
      const endpoint = new URL(environment.AUDIT_WORM_ENDPOINT);
      if (
        endpoint.username !== '' || endpoint.password !== '' || endpoint.search !== '' ||
        endpoint.hash !== '' || endpoint.origin === issuer.origin
      ) {
        context.addIssue({
          code: 'custom',
          path: ['AUDIT_WORM_ENDPOINT'],
          message: 'WORM 锚定端点禁止凭据、查询、fragment，且必须与 ERP 授权域隔离',
        });
      }
    }
  }
});

export type AppEnvironment = z.infer<typeof environmentSchema>;

/**
 * 在应用连接外部资源前校验环境配置，避免隐式默认值进入生产环境。
 */
export const validateEnvironment = (input: Record<string, unknown>): AppEnvironment => {
  const result = environmentSchema.safeParse(input);

  if (!result.success) {
    throw new Error(`环境变量校验失败：${z.prettifyError(result.error)}`);
  }

  return result.data;
};
