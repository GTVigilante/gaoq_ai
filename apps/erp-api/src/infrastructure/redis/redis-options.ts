import type { RedisOptions } from 'ioredis';

const REDIS_DATABASE_PATTERN = /^\/(?:0|[1-9]\d*)?$/;
const REDIS_DATABASE_MAXIMUM = 1_000_000;

/** 将受校验的 Redis URL 转为 BullMQ 与 ioredis 共用连接参数。 */
export const toBullMqConnection = (redisUrl: string): RedisOptions => {
  let url: URL;
  try {
    url = new URL(redisUrl);
  } catch {
    throw new Error('REDIS_URL 格式无效');
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('REDIS_URL 协议无效');
  }
  if (
    url.hostname.length < 1 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    !REDIS_DATABASE_PATTERN.test(url.pathname)
  ) throw new Error('REDIS_URL 结构无效');

  const databaseText = url.pathname.slice(1);
  const database = databaseText.length === 0 ? 0 : Number.parseInt(databaseText, 10);

  if (!Number.isInteger(database) || database < 0 || database > REDIS_DATABASE_MAXIMUM) {
    throw new Error('REDIS_URL 数据库编号无效');
  }
  const port = url.port.length > 0 ? Number.parseInt(url.port, 10) : 6379;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('REDIS_URL 端口无效');
  }
  const username = decodeCredential(url.username, '用户名', 256);
  const password = decodeCredential(url.password, '密码', 512);

  return {
    host: url.hostname,
    port,
    db: database,
    ...(username.length > 0 ? { username } : {}),
    ...(password.length > 0 ? { password } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
};

function decodeCredential(value: string, field: string, maximumLength: number): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error(`REDIS_URL ${field}编码无效`);
  }
  if (
    decoded.length > maximumLength ||
    containsControlCharacter(decoded)
  ) throw new Error(`REDIS_URL ${field}无效`);
  return decoded;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}
