import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  MONGODB_URI: z.string().url().startsWith('mongodb://'),
  REDIS_URL: z.string().url().startsWith('redis://'),
  WEB_ORIGIN: z.string().url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
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
