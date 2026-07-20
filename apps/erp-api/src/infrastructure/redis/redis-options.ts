import type { RedisOptions } from 'ioredis';

/** 将受校验的 Redis URL 转为 BullMQ 与 ioredis 共用连接参数。 */
export const toBullMqConnection = (redisUrl: string): RedisOptions => {
  const url = new URL(redisUrl);
  const databaseText = url.pathname.replace('/', '');
  const database = databaseText.length === 0 ? 0 : Number.parseInt(databaseText, 10);

  if (!Number.isInteger(database) || database < 0) {
    throw new Error('REDIS_URL 数据库编号无效');
  }

  return {
    host: url.hostname,
    port: url.port.length > 0 ? Number.parseInt(url.port, 10) : 6379,
    db: database,
    ...(url.username.length > 0 ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password.length > 0 ? { password: decodeURIComponent(url.password) } : {}),
    maxRetriesPerRequest: null,
  };
};
