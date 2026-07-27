import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { Redis } from 'ioredis';

const EDGE_SECRET = /^[\x21-\x7E]{32,256}$/u;
const ALLOWED_IP_HEADERS = new Set(['x-real-ip', 'cf-connecting-ip', 'true-client-ip']);
const WINDOW_SECONDS = 10 * 60;
const MAX_REQUESTS = 5;

let redis: Redis | undefined;

export class RecruitmentPortalProtectionError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = 'RecruitmentPortalProtectionError';
  }
}

/**
 * 校验公开域名与入口注入的验证头，并使用共享 Redis 执行失败关闭限流。
 *
 * 入口层必须先删除客户端同名头，再注入 `x-gaoq-edge-verification` 与受控来源地址头。
 */
export async function assertRecruitmentPortalRequestAllowed(request: Request): Promise<void> {
  const origin = request.headers.get('origin');
  const expectedOrigin = portalOrigin();
  if (origin !== expectedOrigin) {
    throw new RecruitmentPortalProtectionError('CAREERS_ORIGIN_DENIED', 403);
  }

  const clientIp = trustedClientAddress(request);
  const subject = createHash('sha256').update(clientIp).digest('hex');
  const client = await rateLimitRedis();
  let count: number;
  try {
    const result = await client.eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",
      1,
      `gaoq:careers:application-rate:${subject}`,
      WINDOW_SECONDS,
    );
    count = Number(result);
  } catch {
    throw new RecruitmentPortalProtectionError('CAREERS_PROTECTION_UNAVAILABLE', 503);
  }
  if (!Number.isSafeInteger(count)) {
    throw new RecruitmentPortalProtectionError('CAREERS_PROTECTION_UNAVAILABLE', 503);
  }
  if (count > MAX_REQUESTS) {
    throw new RecruitmentPortalProtectionError('CAREERS_RATE_LIMITED', 429);
  }
}

function trustedClientAddress(request: Request): string {
  if (process.env.NODE_ENV !== 'production') {
    return normalizeIp(request.headers.get('x-real-ip')) ?? 'local-development';
  }
  const expectedSecret = process.env.CAREERS_EDGE_VERIFICATION_SECRET ?? '';
  const suppliedSecret = request.headers.get('x-gaoq-edge-verification') ?? '';
  if (!EDGE_SECRET.test(expectedSecret) || !safeEqual(suppliedSecret, expectedSecret)) {
    throw new RecruitmentPortalProtectionError('CAREERS_EDGE_UNVERIFIED', 403);
  }
  const header = (process.env.CAREERS_CLIENT_IP_HEADER ?? '').toLowerCase();
  if (!ALLOWED_IP_HEADERS.has(header)) {
    throw new RecruitmentPortalProtectionError('CAREERS_PROTECTION_UNAVAILABLE', 503);
  }
  const value = normalizeIp(request.headers.get(header));
  if (value === undefined) {
    throw new RecruitmentPortalProtectionError('CAREERS_EDGE_CLIENT_IP_INVALID', 403);
  }
  return value;
}

function portalOrigin(): string {
  const raw = process.env.CAREERS_PUBLIC_ORIGIN ??
    (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3000');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new RecruitmentPortalProtectionError('CAREERS_PROTECTION_UNAVAILABLE', 503);
  }
  const production = process.env.NODE_ENV === 'production';
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (production && (
      parsed.protocol !== 'https:' ||
      isLocalHostname(parsed.hostname) ||
      (parsed.port !== '' && parsed.port !== '443')
    )) ||
    (!production && !['http:', 'https:'].includes(parsed.protocol))
  ) {
    throw new RecruitmentPortalProtectionError('CAREERS_PROTECTION_UNAVAILABLE', 503);
  }
  return parsed.origin;
}

async function rateLimitRedis(): Promise<Redis> {
  if (redis !== undefined) {
    if (redis.status === 'wait') await redis.connect();
    return redis;
  }
  const url = process.env.CAREERS_RATE_LIMIT_REDIS_URL;
  if (url === undefined || !/^rediss?:\/\//u.test(url)) {
    throw new RecruitmentPortalProtectionError('CAREERS_PROTECTION_UNAVAILABLE', 503);
  }
  redis = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: 2_000,
    retryStrategy: () => null,
  });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
  } catch {
    redis.disconnect();
    redis = undefined;
    throw new RecruitmentPortalProtectionError('CAREERS_PROTECTION_UNAVAILABLE', 503);
  }
  return redis;
}

function normalizeIp(value: string | null): string | undefined {
  if (value === null || value.includes(',')) return undefined;
  const normalized = value.trim();
  return isIP(normalized) === 0 ? undefined : normalized.toLowerCase();
}

function safeEqual(left: string, right: string): boolean {
  const first = Buffer.from(left);
  const second = Buffer.from(right);
  return first.length === second.length && timingSafeEqual(first, second);
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    ['::1', '[::1]'].includes(hostname) ||
    hostname.endsWith('.local');
}

/** 仅供单元测试释放连接，生产流程不得调用。 */
export function resetRecruitmentPortalProtectionForTests(): void {
  redis?.disconnect();
  redis = undefined;
}
