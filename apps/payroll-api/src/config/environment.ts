import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3101),
  MONGODB_URI: z.string().startsWith('mongodb://'),
  WEB_ORIGIN: z.string().url(),
  AUTH_ISSUER: z.string().url(),
  AUTH_AUDIENCE: z.string().min(1).default('gaoq-payroll-api'),
  AUTH_RESOURCE: z.string().url(),
  AUTH_JWKS_URI: z.string().url(),
  MCP_ALLOWED_ORIGINS: z.string().min(1),
  /** 薪酬 L4 数据 AES-256-GCM 密钥环，只能由 Secret Manager 注入。 */
  PAYROLL_DATA_ENCRYPTION_KEYS: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(64).max(16_384).optional(),
  ),
  /** 员工精确检索 HMAC 盲索引密钥环，不得复用数据加密密钥。 */
  PAYROLL_BLIND_INDEX_KEYS: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(64).max(16_384).optional(),
  ),
}).superRefine((environment, context) => {
  const allowedOrigins = environment.MCP_ALLOWED_ORIGINS.split(',')
    .map((value) => value.trim()).filter(Boolean);
  if (allowedOrigins.length === 0 || allowedOrigins.length > 10) {
    context.addIssue({ code: 'custom', path: ['MCP_ALLOWED_ORIGINS'], message: 'MCP Origin 数量非法' });
  }
  for (const origin of allowedOrigins) {
    try {
      const parsed = new URL(origin);
      if (
        parsed.toString() !== `${parsed.origin}/` ||
        (environment.NODE_ENV === 'production' && parsed.protocol !== 'https:')
      ) throw new Error('MCP_ORIGIN_INVALID');
    } catch {
      context.addIssue({ code: 'custom', path: ['MCP_ALLOWED_ORIGINS'], message: 'MCP Origin 必须是精确标准 Origin' });
    }
  }
  if (environment.NODE_ENV === 'production' && !allowedOrigins.includes(environment.WEB_ORIGIN)) {
    context.addIssue({ code: 'custom', path: ['MCP_ALLOWED_ORIGINS'], message: '生产 MCP Origin 必须包含算薪 Web Origin' });
  }
  if (
    environment.NODE_ENV === 'production' &&
    (environment.PAYROLL_DATA_ENCRYPTION_KEYS === undefined ||
      environment.PAYROLL_BLIND_INDEX_KEYS === undefined)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['PAYROLL_DATA_ENCRYPTION_KEYS'],
      message: '生产环境必须注入薪酬数据加密与盲索引独立密钥环',
    });
  }
  if (
    environment.PAYROLL_DATA_ENCRYPTION_KEYS !== undefined &&
    environment.PAYROLL_DATA_ENCRYPTION_KEYS === environment.PAYROLL_BLIND_INDEX_KEYS
  ) {
    context.addIssue({
      code: 'custom',
      path: ['PAYROLL_BLIND_INDEX_KEYS'],
      message: '薪酬数据加密与盲索引不得复用同一密钥环',
    });
  }
});

export type AppEnvironment = z.infer<typeof environmentSchema>;

/** 启动时校验全部安全关键配置，禁止生产环境使用隐式默认凭据。 */
export const validateEnvironment = (value: Record<string, unknown>): AppEnvironment =>
  environmentSchema.parse(value);
