import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
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
