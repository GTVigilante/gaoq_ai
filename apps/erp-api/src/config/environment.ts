import { createPublicKey } from 'node:crypto';
import { isIP } from 'node:net';

import { z } from 'zod';

const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/\.$/u, '')
    .replace(/^\[(.*)\]$/u, '$1');
  return normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    (isIP(normalized) === 4 && normalized.startsWith('127.')) ||
    (isIP(normalized) === 6 && normalized === '::1');
};

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  RUNTIME_ROLE: z.enum(['api', 'worker']).default('api'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  WORKER_METRICS_PORT: z.coerce.number().int().min(1).max(65_535).default(9464),
  MONGODB_URI: z.string().url().startsWith('mongodb://'),
  REDIS_URL: z.string().url().startsWith('redis://'),
  WEB_ORIGIN: z.string().url(),
  MARKETING_WEBSITE_ORIGIN: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().url().optional(),
  ),
  /** 官网匿名接口固定映射，禁止从客户端请求读取租户或站点标识。 */
  MARKETING_PUBLIC_TENANT_ID: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
    .default('tenant-marketing'),
  MARKETING_PUBLIC_SITE_ID: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
    .default('gaoq'),
  /** 营销联系人 AES-256-GCM 与盲索引密钥必须来自不同 Secret。 */
  MARKETING_LEAD_ENCRYPTION_KEY_BASE64: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
  ),
  MARKETING_LEAD_BLIND_INDEX_KEY_BASE64: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
  ),
  MARKETING_MEDIA_GATEWAY_ENDPOINT: z.preprocess(
    (value) => value === '' ? undefined : value, z.string().url().optional(),
  ),
  MARKETING_MEDIA_GATEWAY_BEARER_TOKEN: z.preprocess(
    (value) => value === '' ? undefined : value, z.string().min(32).max(512).optional(),
  ),
  MARKETING_AI_GATEWAY_ENDPOINT: z.preprocess(
    (value) => value === '' ? undefined : value, z.string().url().optional(),
  ),
  MARKETING_AI_GATEWAY_BEARER_TOKEN: z.preprocess(
    (value) => value === '' ? undefined : value, z.string().min(32).max(512).optional(),
  ),
  MARKETING_CAPTCHA_VERIFY_ENDPOINT: z.preprocess(
    (value) => value === '' ? undefined : value, z.string().url().optional(),
  ),
  MARKETING_CAPTCHA_BEARER_TOKEN: z.preprocess(
    (value) => value === '' ? undefined : value, z.string().min(32).max(512).optional(),
  ),
  MARKETING_NOTIFICATION_GATEWAY_ENDPOINT: z.preprocess(
    (value) => value === '' ? undefined : value, z.string().url().optional(),
  ),
  MARKETING_NOTIFICATION_GATEWAY_BEARER_TOKEN: z.preprocess(
    (value) => value === '' ? undefined : value, z.string().min(32).max(512).optional(),
  ),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  AUTH_ISSUER: z.string().url(),
  AUTH_AUDIENCE: z.string().min(1),
  AUTH_RESOURCE: z.string().url(),
  /** 额外受众资源，例如独立专业算薪 API；禁止与主资源重复。 */
  AUTH_ADDITIONAL_RESOURCES_JSON: z.string().default('[]'),
  AUTH_JWKS_URI: z.string().url(),
  /** 工资事实源固定为独立专业算薪系统；legacy 仅供非生产回溯测试。 */
  PAYROLL_SYSTEM_MODE: z.enum(['external', 'legacy']).default('external'),
  PAYROLL_WEB_ORIGIN: z.string().url().default('http://localhost:3100'),
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
  /** 简历对象只经隔离网关读取；网关完成归属校验、恶意文件扫描、提取与 PII 去除。 */
  RECRUITMENT_RESUME_SOURCE_ENDPOINT: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().url().optional(),
  ),
  RECRUITMENT_RESUME_SOURCE_BEARER_TOKEN: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(32).max(512).regex(/^[\x21-\x7e]+$/).optional(),
  ),
  /** AI 默认失败关闭；启用时模型和 API Key 必须由部署环境成套注入。 */
  RECRUITMENT_RESUME_AI_PROVIDER: z.enum(['disabled', 'openai']).default('disabled'),
  OPENAI_RESUME_API_KEY: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(32).max(512).optional(),
  ),
  OPENAI_RESUME_MODEL: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(2).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]+$/).optional(),
  ),
  /** 知识内容校验与评分使用独立 HTTPS 证据网关，不向 ERP 返回答卷或标准答案。 */
  KNOWLEDGE_EVIDENCE_GATEWAY_ENDPOINT: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().url().optional(),
  ),
  KNOWLEDGE_EVIDENCE_GATEWAY_BEARER_TOKEN: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(32).max(512).regex(/^[\x21-\x7e]+$/).optional(),
  ),
  KNOWLEDGE_EVIDENCE_GATEWAY_SIGNING_PUBLIC_KEY_BASE64: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(56).max(2_048).regex(/^[A-Za-z0-9+/]+={0,2}$/).optional(),
  ),
  KNOWLEDGE_EVIDENCE_GATEWAY_SIGNING_KEY_ID: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(3).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]+$/).optional(),
  ),
  /** 知识检索使用独立网关与签名信任域，禁止复用评分服务身份。 */
  KNOWLEDGE_SEARCH_GATEWAY_ENDPOINT: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().url().optional(),
  ),
  KNOWLEDGE_SEARCH_GATEWAY_BEARER_TOKEN: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(32).max(512).regex(/^[\x21-\x7e]+$/).optional(),
  ),
  KNOWLEDGE_SEARCH_GATEWAY_SIGNING_PUBLIC_KEY_BASE64: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(56).max(2_048).regex(/^[A-Za-z0-9+/]+={0,2}$/).optional(),
  ),
  KNOWLEDGE_SEARCH_GATEWAY_SIGNING_KEY_ID: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(3).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]+$/).optional(),
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
  /** 数据迁移附件隔离网关：网关负责来源拉取、恶意文件扫描与不可变归档。 */
  DATA_MIGRATION_ATTACHMENT_GATEWAY_ENDPOINT: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().url().optional(),
  ),
  DATA_MIGRATION_ATTACHMENT_GATEWAY_BEARER_TOKEN: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(32).max(512).regex(/^[\x21-\x7e]+$/).optional(),
  ),
  DATA_MIGRATION_ATTACHMENT_RETENTION_DAYS: z.coerce
    .number().int().min(2_555).max(36_500).default(2_555),
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
  /** production 仅在 Phase 6 独立授权域逐对象签发短时授权后可用。 */
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
  /** production 仅在 Phase 6 独立授权域逐对象签发短时授权后可用。 */
  TREASURY_BANK_SUBMISSION_MODE: z.enum(['sandbox', 'production']).default('sandbox'),
  /** Phase 6 独立授权域；只签发绑定发布物和业务对象的一次性短时生产执行授权。 */
  PHASE6_PRODUCTION_AUTHORIZATION_ENDPOINT: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().url().optional(),
  ),
  PHASE6_PRODUCTION_AUTHORIZATION_BEARER_TOKEN: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(32).max(512).regex(/^[\x21-\x7e]+$/).optional(),
  ),
  PHASE6_RELEASE_COMMIT_SHA: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().regex(/^[a-f0-9]{40}$/).optional(),
  ),
  PHASE6_DEPLOYMENT_MANIFEST_SHA256: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  ),
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
  /** OP 审批原始表单专用 AES-256-GCM 密钥环；不得复用经营摘要密钥。 */
  OP_APPROVAL_WEBHOOK_ENCRYPTION_KEYS: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(64).max(16_384).optional(),
  ),
  /** OP 组织下发 API 根地址；只允许标准 HTTPS 且不得携带凭据、query 或 fragment。 */
  OP_API_BASE_URL: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().url().optional(),
  ),
  /** OP SSO 使用独立 OAuth 客户端，不复用组织下发或 Webhook HMAC 凭据。 */
  OP_SSO_CLIENT_ID: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/).optional(),
  ),
  OP_SSO_CLIENT_SECRET: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(32).max(2_048).optional(),
  ),
  OP_SSO_REDIRECT_URI: z.preprocess(
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
    environment.NODE_ENV === 'production' &&
    environment.MARKETING_WEBSITE_ORIGIN === undefined
  ) {
    context.addIssue({
      code: 'custom',
      path: ['MARKETING_WEBSITE_ORIGIN'],
      message: '生产环境必须配置营销官网精确 HTTPS Origin',
    });
  }
  if (environment.MARKETING_WEBSITE_ORIGIN !== undefined) {
    const websiteOrigin = new URL(environment.MARKETING_WEBSITE_ORIGIN);
    const productionInvalid = environment.NODE_ENV === 'production' && (
      websiteOrigin.protocol !== 'https:' ||
      (websiteOrigin.port !== '' && websiteOrigin.port !== '443') ||
      isLoopbackHostname(websiteOrigin.hostname)
    );
    if (
      websiteOrigin.pathname !== '/' ||
      websiteOrigin.search !== '' ||
      websiteOrigin.hash !== '' ||
      websiteOrigin.username !== '' ||
      websiteOrigin.password !== '' ||
      productionInvalid ||
      websiteOrigin.origin === new URL(environment.WEB_ORIGIN).origin
    ) {
      context.addIssue({
        code: 'custom',
        path: ['MARKETING_WEBSITE_ORIGIN'],
        message: '营销官网必须为独立精确 Origin；生产仅允许标准 HTTPS 且禁止本地地址',
      });
    }
  }
  if (
    environment.NODE_ENV === 'production' &&
    (
      environment.MARKETING_CAPTCHA_VERIFY_ENDPOINT === undefined ||
      environment.MARKETING_CAPTCHA_BEARER_TOKEN === undefined
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['MARKETING_CAPTCHA_VERIFY_ENDPOINT'],
      message: '生产环境营销官网必须配置验证码校验端点与独立凭据',
    });
  }
  if (environment.NODE_ENV === 'production' && environment.PAYROLL_SYSTEM_MODE !== 'external') {
    context.addIssue({
      code: 'custom',
      path: ['PAYROLL_SYSTEM_MODE'],
      message: '生产环境工资事实源必须使用独立专业算薪系统',
    });
  }
  const migrationAttachmentInfrastructure = [
    environment.DATA_MIGRATION_ATTACHMENT_GATEWAY_ENDPOINT,
    environment.DATA_MIGRATION_ATTACHMENT_GATEWAY_BEARER_TOKEN,
  ];
  if (
    migrationAttachmentInfrastructure.some((value) => value !== undefined) &&
    migrationAttachmentInfrastructure.some((value) => value === undefined)
  ) context.addIssue({
    code: 'custom', path: ['DATA_MIGRATION_ATTACHMENT_GATEWAY_ENDPOINT'],
    message: '数据迁移附件网关端点与凭据必须成套配置',
  });
  if (environment.DATA_MIGRATION_ATTACHMENT_GATEWAY_ENDPOINT !== undefined) {
    const endpoint = new URL(environment.DATA_MIGRATION_ATTACHMENT_GATEWAY_ENDPOINT);
    const forbiddenOrigins = [
      issuer.origin,
      environment.TREASURY_WORM_ARCHIVE_ENDPOINT,
      environment.TREASURY_BANK_SUBMISSION_ENDPOINT,
      environment.TREASURY_BANK_RETURN_INBOX_ENDPOINT,
      environment.PAYROLL_TAX_WORM_ARCHIVE_ENDPOINT,
      environment.PAYROLL_TAX_GATEWAY_ENDPOINT,
      environment.ESIGN_MALWARE_SCAN_ENDPOINT,
      environment.ESIGN_WORM_ARCHIVE_ENDPOINT,
    ].filter((value): value is string => value !== undefined)
      .map((value) => new URL(value).origin);
    if (
      endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '' ||
      endpoint.search !== '' || endpoint.hash !== '' ||
      (endpoint.port !== '' && endpoint.port !== '443') || forbiddenOrigins.includes(endpoint.origin)
    ) context.addIssue({
      code: 'custom', path: ['DATA_MIGRATION_ATTACHMENT_GATEWAY_ENDPOINT'],
      message: '数据迁移附件网关必须为独立权限域标准 HTTPS，禁止凭据、query、fragment 和非标准端口',
    });
  }
  const resumeSourceInfrastructure = [
    environment.RECRUITMENT_RESUME_SOURCE_ENDPOINT,
    environment.RECRUITMENT_RESUME_SOURCE_BEARER_TOKEN,
  ];
  if (
    resumeSourceInfrastructure.some((value) => value !== undefined) &&
    resumeSourceInfrastructure.some((value) => value === undefined)
  ) context.addIssue({
    code: 'custom',
    path: ['RECRUITMENT_RESUME_SOURCE_ENDPOINT'],
    message: '简历隔离网关端点与凭据必须成套配置',
  });
  if (environment.RECRUITMENT_RESUME_SOURCE_ENDPOINT !== undefined) {
    const endpoint = new URL(environment.RECRUITMENT_RESUME_SOURCE_ENDPOINT);
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.username !== '' ||
      endpoint.password !== '' ||
      endpoint.search !== '' ||
      endpoint.hash !== '' ||
      (endpoint.port !== '' && endpoint.port !== '443') ||
      endpoint.origin === issuer.origin
    ) context.addIssue({
      code: 'custom',
      path: ['RECRUITMENT_RESUME_SOURCE_ENDPOINT'],
      message: '简历隔离网关必须为独立权限域标准 HTTPS，禁止凭据、query、fragment 和非标准端口',
    });
  }
  const resumeAiInfrastructure = [
    environment.OPENAI_RESUME_API_KEY,
    environment.OPENAI_RESUME_MODEL,
  ];
  if (
    environment.RECRUITMENT_RESUME_AI_PROVIDER === 'openai' &&
    (
      resumeAiInfrastructure.some((value) => value === undefined) ||
      resumeSourceInfrastructure.some((value) => value === undefined)
    )
  ) context.addIssue({
    code: 'custom',
    path: ['RECRUITMENT_RESUME_AI_PROVIDER'],
    message: '启用简历 AI 时必须配置隔离网关、OpenAI 模型与独立 API Key',
  });
  if (
    environment.RECRUITMENT_RESUME_AI_PROVIDER === 'disabled' &&
    resumeAiInfrastructure.some((value) => value !== undefined)
  ) context.addIssue({
    code: 'custom',
    path: ['RECRUITMENT_RESUME_AI_PROVIDER'],
    message: '简历 AI 关闭时禁止悬空注入模型或 API Key',
  });
  const knowledgeEvidenceInfrastructure = [
    environment.KNOWLEDGE_EVIDENCE_GATEWAY_ENDPOINT,
    environment.KNOWLEDGE_EVIDENCE_GATEWAY_BEARER_TOKEN,
    environment.KNOWLEDGE_EVIDENCE_GATEWAY_SIGNING_PUBLIC_KEY_BASE64,
    environment.KNOWLEDGE_EVIDENCE_GATEWAY_SIGNING_KEY_ID,
  ];
  if (
    knowledgeEvidenceInfrastructure.some((value) => value !== undefined) &&
    knowledgeEvidenceInfrastructure.some((value) => value === undefined)
  ) context.addIssue({
    code: 'custom',
    path: ['KNOWLEDGE_EVIDENCE_GATEWAY_ENDPOINT'],
    message: '知识证据网关端点与凭据必须成套配置',
  });
  if (environment.KNOWLEDGE_EVIDENCE_GATEWAY_ENDPOINT !== undefined) {
    const endpoint = new URL(environment.KNOWLEDGE_EVIDENCE_GATEWAY_ENDPOINT);
    if (
      endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '' ||
      endpoint.pathname !== '/' || endpoint.search !== '' || endpoint.hash !== '' ||
      (endpoint.port !== '' && endpoint.port !== '443') ||
      isLoopbackHostname(endpoint.hostname) || endpoint.origin === issuer.origin
    ) context.addIssue({
      code: 'custom',
      path: ['KNOWLEDGE_EVIDENCE_GATEWAY_ENDPOINT'],
      message: '知识证据网关必须为独立标准 HTTPS 根地址，禁止本地地址、凭据、路径、query、fragment 和非标准端口',
    });
  }
  if (environment.KNOWLEDGE_EVIDENCE_GATEWAY_SIGNING_PUBLIC_KEY_BASE64 !== undefined) {
    try {
      const publicKey = createPublicKey({
        key: Buffer.from(
          environment.KNOWLEDGE_EVIDENCE_GATEWAY_SIGNING_PUBLIC_KEY_BASE64,
          'base64',
        ),
        format: 'der',
        type: 'spki',
      });
      if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('KEY_TYPE_INVALID');
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['KNOWLEDGE_EVIDENCE_GATEWAY_SIGNING_PUBLIC_KEY_BASE64'],
        message: '知识证据网关签名公钥必须为有效 Ed25519 SPKI DER base64',
      });
    }
  }
  if (
    environment.KNOWLEDGE_EVIDENCE_GATEWAY_BEARER_TOKEN !== undefined &&
    [
      environment.RECRUITMENT_RESUME_SOURCE_BEARER_TOKEN,
      environment.DATA_MIGRATION_ATTACHMENT_GATEWAY_BEARER_TOKEN,
      environment.ESIGN_MALWARE_SCAN_BEARER_TOKEN,
      environment.ESIGN_WORM_ARCHIVE_BEARER_TOKEN,
      environment.MARKETING_MEDIA_GATEWAY_BEARER_TOKEN,
      environment.MARKETING_AI_GATEWAY_BEARER_TOKEN,
      environment.MARKETING_CAPTCHA_BEARER_TOKEN,
      environment.MARKETING_NOTIFICATION_GATEWAY_BEARER_TOKEN,
      environment.PAYROLL_TAX_WORM_ARCHIVE_BEARER_TOKEN,
      environment.PAYROLL_TAX_GATEWAY_BEARER_TOKEN,
      environment.TREASURY_WORM_ARCHIVE_BEARER_TOKEN,
      environment.TREASURY_BANK_SUBMISSION_BEARER_TOKEN,
      environment.TREASURY_BANK_RETURN_INBOX_BEARER_TOKEN,
      environment.PHASE6_PRODUCTION_AUTHORIZATION_BEARER_TOKEN,
      environment.METRICS_BEARER_TOKEN,
      environment.AUDIT_WORM_BEARER_TOKEN,
      environment.OPENAI_RESUME_API_KEY,
      environment.OP_SSO_CLIENT_SECRET,
      environment.DINGTALK_CLIENT_SECRET,
      environment.FEISHU_CLIENT_SECRET,
      environment.KNOWLEDGE_SEARCH_GATEWAY_BEARER_TOKEN,
    ].includes(environment.KNOWLEDGE_EVIDENCE_GATEWAY_BEARER_TOKEN)
  ) context.addIssue({
    code: 'custom',
    path: ['KNOWLEDGE_EVIDENCE_GATEWAY_BEARER_TOKEN'],
    message: '知识证据网关不得复用其他业务、平台或外部系统凭据',
  });
  const knowledgeSearchInfrastructure = [
    environment.KNOWLEDGE_SEARCH_GATEWAY_ENDPOINT,
    environment.KNOWLEDGE_SEARCH_GATEWAY_BEARER_TOKEN,
    environment.KNOWLEDGE_SEARCH_GATEWAY_SIGNING_PUBLIC_KEY_BASE64,
    environment.KNOWLEDGE_SEARCH_GATEWAY_SIGNING_KEY_ID,
  ];
  if (
    knowledgeSearchInfrastructure.some((value) => value !== undefined) &&
    knowledgeSearchInfrastructure.some((value) => value === undefined)
  ) context.addIssue({
    code: 'custom',
    path: ['KNOWLEDGE_SEARCH_GATEWAY_ENDPOINT'],
    message: '知识搜索网关端点、凭据、公钥与 Key ID 必须成套配置',
  });
  if (environment.KNOWLEDGE_SEARCH_GATEWAY_ENDPOINT !== undefined) {
    const endpoint = new URL(environment.KNOWLEDGE_SEARCH_GATEWAY_ENDPOINT);
    const evidenceEndpoint = environment.KNOWLEDGE_EVIDENCE_GATEWAY_ENDPOINT === undefined
      ? null
      : new URL(environment.KNOWLEDGE_EVIDENCE_GATEWAY_ENDPOINT);
    if (
      endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '' ||
      endpoint.pathname !== '/' || endpoint.search !== '' || endpoint.hash !== '' ||
      (endpoint.port !== '' && endpoint.port !== '443') ||
      isLoopbackHostname(endpoint.hostname) || endpoint.origin === issuer.origin ||
      endpoint.origin === evidenceEndpoint?.origin
    ) context.addIssue({
      code: 'custom',
      path: ['KNOWLEDGE_SEARCH_GATEWAY_ENDPOINT'],
      message: '知识搜索网关必须为独立标准 HTTPS 根地址，禁止与认证或评分网关共用 Origin',
    });
  }
  if (environment.KNOWLEDGE_SEARCH_GATEWAY_SIGNING_PUBLIC_KEY_BASE64 !== undefined) {
    try {
      const publicKey = createPublicKey({
        key: Buffer.from(
          environment.KNOWLEDGE_SEARCH_GATEWAY_SIGNING_PUBLIC_KEY_BASE64,
          'base64',
        ),
        format: 'der',
        type: 'spki',
      });
      if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('KEY_TYPE_INVALID');
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['KNOWLEDGE_SEARCH_GATEWAY_SIGNING_PUBLIC_KEY_BASE64'],
        message: '知识搜索网关签名公钥必须为有效 Ed25519 SPKI DER base64',
      });
    }
  }
  if (
    environment.KNOWLEDGE_SEARCH_GATEWAY_BEARER_TOKEN !== undefined &&
    environment.KNOWLEDGE_SEARCH_GATEWAY_BEARER_TOKEN ===
      environment.KNOWLEDGE_EVIDENCE_GATEWAY_BEARER_TOKEN
  ) context.addIssue({
    code: 'custom',
    path: ['KNOWLEDGE_SEARCH_GATEWAY_BEARER_TOKEN'],
    message: '知识搜索网关不得复用评分证据服务身份',
  });
  if (
    environment.KNOWLEDGE_SEARCH_GATEWAY_SIGNING_PUBLIC_KEY_BASE64 !== undefined &&
    environment.KNOWLEDGE_SEARCH_GATEWAY_SIGNING_PUBLIC_KEY_BASE64 ===
      environment.KNOWLEDGE_EVIDENCE_GATEWAY_SIGNING_PUBLIC_KEY_BASE64
  ) context.addIssue({
    code: 'custom',
    path: ['KNOWLEDGE_SEARCH_GATEWAY_SIGNING_PUBLIC_KEY_BASE64'],
    message: '知识搜索与评分证据网关必须使用独立签名信任域',
  });
  if (environment.DATA_MIGRATION_ATTACHMENT_GATEWAY_BEARER_TOKEN !== undefined && [
    environment.TREASURY_WORM_ARCHIVE_BEARER_TOKEN,
    environment.TREASURY_BANK_SUBMISSION_BEARER_TOKEN,
    environment.TREASURY_BANK_RETURN_INBOX_BEARER_TOKEN,
    environment.PAYROLL_TAX_WORM_ARCHIVE_BEARER_TOKEN,
    environment.PAYROLL_TAX_GATEWAY_BEARER_TOKEN,
    environment.ESIGN_MALWARE_SCAN_BEARER_TOKEN,
    environment.ESIGN_WORM_ARCHIVE_BEARER_TOKEN,
  ].includes(environment.DATA_MIGRATION_ATTACHMENT_GATEWAY_BEARER_TOKEN)) context.addIssue({
    code: 'custom', path: ['DATA_MIGRATION_ATTACHMENT_GATEWAY_BEARER_TOKEN'],
    message: '数据迁移附件网关不得复用资金、税务或合同证据凭据',
  });
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
    environment.RUNTIME_ROLE === 'api' &&
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
  const productionAuthorization = [
    environment.PHASE6_PRODUCTION_AUTHORIZATION_ENDPOINT,
    environment.PHASE6_PRODUCTION_AUTHORIZATION_BEARER_TOKEN,
    environment.PHASE6_RELEASE_COMMIT_SHA,
    environment.PHASE6_DEPLOYMENT_MANIFEST_SHA256,
  ];
  const productionExecutionEnabled =
    environment.TREASURY_BANK_SUBMISSION_MODE === 'production' ||
    environment.PAYROLL_TAX_GATEWAY_MODE === 'production';
  if (productionExecutionEnabled && environment.NODE_ENV !== 'production') context.addIssue({
    code: 'custom', path: ['TREASURY_BANK_SUBMISSION_MODE'],
    message: '真实银行或税务通道只能在 NODE_ENV=production 的受控运行时启用',
  });
  if (
    productionAuthorization.some((value) => value !== undefined) &&
    productionAuthorization.some((value) => value === undefined)
  ) context.addIssue({
    code: 'custom', path: ['PHASE6_PRODUCTION_AUTHORIZATION_ENDPOINT'],
    message: 'Phase 6 生产执行授权端点、凭据、发布 commit 与部署清单摘要必须成套配置',
  });
  if (productionExecutionEnabled && productionAuthorization.some((value) => value === undefined)) {
    context.addIssue({
      code: 'custom', path: ['PHASE6_PRODUCTION_AUTHORIZATION_ENDPOINT'],
      message: '生产银行或税务通道只能在 Phase 6 一次性授权域完整配置后启用',
    });
  }
  if (environment.PHASE6_PRODUCTION_AUTHORIZATION_ENDPOINT !== undefined) {
    const endpoint = new URL(environment.PHASE6_PRODUCTION_AUTHORIZATION_ENDPOINT);
    const forbiddenOrigins = new Set([
      issuer.origin,
      ...[
        environment.TREASURY_WORM_ARCHIVE_ENDPOINT,
        environment.TREASURY_BANK_SUBMISSION_ENDPOINT,
        environment.TREASURY_BANK_RETURN_INBOX_ENDPOINT,
        environment.PAYROLL_TAX_WORM_ARCHIVE_ENDPOINT,
        environment.PAYROLL_TAX_GATEWAY_ENDPOINT,
      ].filter((value): value is string => value !== undefined)
        .map((value) => new URL(value).origin),
    ]);
    if (
      endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '' ||
      endpoint.search !== '' || endpoint.hash !== '' ||
      (endpoint.port !== '' && endpoint.port !== '443') || forbiddenOrigins.has(endpoint.origin)
    ) context.addIssue({
      code: 'custom', path: ['PHASE6_PRODUCTION_AUTHORIZATION_ENDPOINT'],
      message: 'Phase 6 生产执行授权必须使用独立权限域标准 HTTPS',
    });
  }
  if (
    environment.PHASE6_PRODUCTION_AUTHORIZATION_BEARER_TOKEN !== undefined &&
    [
      ...treasuryTokens,
      environment.PAYROLL_TAX_WORM_ARCHIVE_BEARER_TOKEN,
      environment.PAYROLL_TAX_GATEWAY_BEARER_TOKEN,
    ].includes(environment.PHASE6_PRODUCTION_AUTHORIZATION_BEARER_TOKEN)
  ) context.addIssue({
    code: 'custom', path: ['PHASE6_PRODUCTION_AUTHORIZATION_BEARER_TOKEN'],
    message: 'Phase 6 生产执行授权不得复用资金、税务或 WORM 凭据',
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
  if (
    environment.NODE_ENV === 'production' &&
    environment.OP_APPROVAL_WEBHOOK_ENCRYPTION_KEYS === undefined
  ) {
    context.addIssue({
      code: 'custom',
      path: ['OP_APPROVAL_WEBHOOK_ENCRYPTION_KEYS'],
      message: '生产环境必须由 Secret Manager 注入 OP 审批 Webhook 独立加密密钥环',
    });
  }
  if (
    environment.OP_WEBHOOK_ENCRYPTION_KEYS !== undefined &&
    environment.OP_WEBHOOK_ENCRYPTION_KEYS === environment.OP_APPROVAL_WEBHOOK_ENCRYPTION_KEYS
  ) {
    context.addIssue({
      code: 'custom', path: ['OP_APPROVAL_WEBHOOK_ENCRYPTION_KEYS'],
      message: 'OP 审批 Webhook 不得复用经营摘要加密密钥环',
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
  const opSsoConfigured = [
    environment.OP_SSO_CLIENT_ID,
    environment.OP_SSO_CLIENT_SECRET,
    environment.OP_SSO_REDIRECT_URI,
  ].filter((value) => value !== undefined).length;
  if (opSsoConfigured !== 0 && opSsoConfigured !== 3) context.addIssue({
    code: 'custom', path: ['OP_SSO_CLIENT_ID'],
    message: 'OP SSO clientId、clientSecret 与 redirectUri 必须成套配置',
  });
  if (environment.NODE_ENV === 'production' && opSsoConfigured !== 3) context.addIssue({
    code: 'custom', path: ['OP_SSO_CLIENT_ID'],
    message: '生产环境必须由 Secret Manager 注入 OP SSO 独立客户端凭据',
  });
  if (environment.OP_SSO_REDIRECT_URI !== undefined) {
    const redirect = new URL(environment.OP_SSO_REDIRECT_URI);
    const expected = new URL('/api/auth/sso/op/callback', issuer).toString();
    if (
      redirect.protocol !== 'https:' || redirect.username !== '' || redirect.password !== '' ||
      redirect.search !== '' || redirect.hash !== '' || redirect.toString() !== expected
    ) context.addIssue({
      code: 'custom', path: ['OP_SSO_REDIRECT_URI'],
      message: 'OP SSO redirectUri 必须精确指向 ERP issuer 的 HTTPS 回调地址',
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
  if (
    environment.NODE_ENV === 'production' &&
    (
      environment.MARKETING_LEAD_ENCRYPTION_KEY_BASE64 === undefined ||
      environment.MARKETING_LEAD_BLIND_INDEX_KEY_BASE64 === undefined
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['MARKETING_LEAD_ENCRYPTION_KEY_BASE64'],
      message: '生产环境必须注入营销线索加密与盲索引密钥',
    });
  }
  if (environment.NODE_ENV === 'production' && environment.MARKETING_WEBSITE_ORIGIN === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['MARKETING_WEBSITE_ORIGIN'],
      message: '生产环境必须精确配置营销官网 HTTPS Origin',
    });
  }
  if (environment.MARKETING_WEBSITE_ORIGIN !== undefined) {
    const marketingOrigin = new URL(environment.MARKETING_WEBSITE_ORIGIN);
    if (
      (environment.NODE_ENV === 'production' && marketingOrigin.protocol !== 'https:') ||
      (environment.NODE_ENV === 'production' && (
        marketingOrigin.hostname === 'localhost' ||
        marketingOrigin.hostname === '127.0.0.1' ||
        ['::1', '[::1]'].includes(marketingOrigin.hostname) ||
        marketingOrigin.hostname.endsWith('.local')
      )) ||
      marketingOrigin.username !== '' ||
      marketingOrigin.password !== '' ||
      marketingOrigin.pathname !== '/' ||
      marketingOrigin.search !== '' ||
      marketingOrigin.hash !== '' ||
      (marketingOrigin.protocol === 'https:' &&
        marketingOrigin.port !== '' && marketingOrigin.port !== '443') ||
      (marketingOrigin.protocol === 'http:' &&
        marketingOrigin.port !== '' && marketingOrigin.port !== '80')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['MARKETING_WEBSITE_ORIGIN'],
        message: '营销官网 Origin 必须是无凭据、路径、query、fragment 或异常端口的标准根 Origin',
      });
    }
  }
  if (
    environment.MARKETING_LEAD_ENCRYPTION_KEY_BASE64 !== undefined &&
    environment.MARKETING_LEAD_ENCRYPTION_KEY_BASE64 ===
      environment.MARKETING_LEAD_BLIND_INDEX_KEY_BASE64
  ) {
    context.addIssue({
      code: 'custom',
      path: ['MARKETING_LEAD_BLIND_INDEX_KEY_BASE64'],
      message: '营销线索加密密钥与盲索引密钥禁止复用',
    });
  }
  for (const [endpointName, endpoint, tokenName, token] of [
    ['MARKETING_MEDIA_GATEWAY_ENDPOINT', environment.MARKETING_MEDIA_GATEWAY_ENDPOINT,
      'MARKETING_MEDIA_GATEWAY_BEARER_TOKEN', environment.MARKETING_MEDIA_GATEWAY_BEARER_TOKEN],
    ['MARKETING_AI_GATEWAY_ENDPOINT', environment.MARKETING_AI_GATEWAY_ENDPOINT,
      'MARKETING_AI_GATEWAY_BEARER_TOKEN', environment.MARKETING_AI_GATEWAY_BEARER_TOKEN],
    ['MARKETING_CAPTCHA_VERIFY_ENDPOINT', environment.MARKETING_CAPTCHA_VERIFY_ENDPOINT,
      'MARKETING_CAPTCHA_BEARER_TOKEN', environment.MARKETING_CAPTCHA_BEARER_TOKEN],
    ['MARKETING_NOTIFICATION_GATEWAY_ENDPOINT', environment.MARKETING_NOTIFICATION_GATEWAY_ENDPOINT,
      'MARKETING_NOTIFICATION_GATEWAY_BEARER_TOKEN',
      environment.MARKETING_NOTIFICATION_GATEWAY_BEARER_TOKEN],
  ] as const) {
    if ((endpoint === undefined) !== (token === undefined)) {
      context.addIssue({
        code: 'custom',
        path: [endpoint === undefined ? endpointName : tokenName],
        message: '营销外部网关端点与凭据必须成对配置',
      });
    }
    if (
      environment.NODE_ENV === 'production' &&
      endpoint !== undefined &&
      new URL(endpoint).protocol !== 'https:'
    ) {
      context.addIssue({
        code: 'custom',
        path: [endpointName],
        message: '生产环境营销外部网关必须使用 HTTPS',
      });
    }
    if (endpoint !== undefined) {
      const url = new URL(endpoint);
      if (
        url.username !== '' || url.password !== '' ||
        url.search !== '' || url.hash !== ''
      ) {
        context.addIssue({
          code: 'custom',
          path: [endpointName],
          message: '营销外部网关端点禁止内嵌凭据、query 或 fragment',
        });
      }
    }
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

  try {
    const additional = JSON.parse(result.data.AUTH_ADDITIONAL_RESOURCES_JSON) as unknown;
    const parsed = z.array(z.object({
      resource: z.string().url().max(2_048),
      audience: z.string().min(1).max(256),
    }).strict()).max(20).safeParse(additional);
    if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
    const seen = new Set([result.data.AUTH_RESOURCE]);
    for (const item of parsed.data) {
      const url = new URL(item.resource);
      if (
        url.username !== '' || url.password !== '' || url.hash !== '' ||
        seen.has(item.resource)
      ) throw new Error('授权资源禁止凭据、fragment 或重复配置');
      seen.add(item.resource);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '格式非法';
    throw new Error(`环境变量校验失败：AUTH_ADDITIONAL_RESOURCES_JSON ${message}`, { cause: error });
  }

  return result.data;
};

/**
 * Worker 不承载浏览器、OAuth 或 MCP 协议端点；使用不可路由占位 URI 完成共享配置解析，
 * 并通过 RUNTIME_ROLE 关闭仅属于 API 进程的签名私钥要求。
 */
export const validateWorkerEnvironment = (input: Record<string, unknown>): AppEnvironment =>
  validateEnvironment({
    ...input,
    RUNTIME_ROLE: 'worker',
    WEB_ORIGIN: 'https://worker.invalid',
    AUTH_ISSUER: 'https://worker.invalid',
    AUTH_AUDIENCE: 'worker-unused',
    AUTH_RESOURCE: 'https://worker.invalid/mcp',
    AUTH_ADDITIONAL_RESOURCES_JSON: '[]',
    AUTH_JWKS_URI: 'https://worker.invalid/.well-known/jwks.json',
    MCP_AUTHORIZATION_SERVER: 'https://worker.invalid',
    MCP_ALLOWED_ORIGINS: 'https://worker.invalid',
    MCP_OAUTH_CLIENTS_JSON: '[]',
    MCP_SERVICE_CLIENTS_JSON: '[]',
  });
