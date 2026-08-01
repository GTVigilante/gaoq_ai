import { createHash } from 'node:crypto';

import { HttpException, HttpStatus, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS_CLIENT } from '../../infrastructure/redis/redis.constants.js';

const RATE_LIMIT_KEY_PREFIX = 'gaoq:oauth:rate:';
const WINDOW_SECONDS = 60;

export type OAuthRateLimitBucket = 'authorize_ip' | 'authorize_client' | 'token_ip' | 'token_client';

const LIMITS: Readonly<Record<OAuthRateLimitBucket, number>> = Object.freeze({
  authorize_ip: 60,
  authorize_client: 120,
  token_ip: 120,
  token_client: 120,
});

/** OAuth 公共端点固定窗口限流；键仅保存主体摘要，不保存 IP 或 clientId 原文。 */
@Injectable()
export class OAuthRateLimitService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async assertAllowed(bucket: OAuthRateLimitBucket, subject: string): Promise<void> {
    if (subject.length === 0 || subject.length > 2_048) {
      throw new HttpException(
        { code: 'OAUTH_RATE_LIMITED', message: '请求过于频繁', retryAfter: WINDOW_SECONDS },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const digest = createHash('sha256').update(subject, 'utf8').digest('hex');
    const key = `${RATE_LIMIT_KEY_PREFIX}${bucket}:${digest}`;
    let result: unknown;
    try {
      result = await this.redis.eval(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; local ttl=redis.call('TTL',KEYS[1]); return {n,ttl}",
        1,
        key,
        WINDOW_SECONDS,
      );
    } catch {
      throw new ServiceUnavailableException({
        code: 'OAUTH_RATE_LIMIT_UNAVAILABLE',
        message: '授权服务暂时不可用',
      });
    }
    if (!Array.isArray(result) || result.length !== 2) {
      throw new ServiceUnavailableException({
        code: 'OAUTH_RATE_LIMIT_UNAVAILABLE',
        message: '授权服务暂时不可用',
      });
    }
    const count = Number(result[0]);
    const ttl = Math.max(1, Number(result[1]));
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(ttl)) {
      throw new ServiceUnavailableException({
        code: 'OAUTH_RATE_LIMIT_UNAVAILABLE',
        message: '授权服务暂时不可用',
      });
    }
    if (count > LIMITS[bucket]) {
      throw new HttpException(
        { code: 'OAUTH_RATE_LIMITED', message: '请求过于频繁', retryAfter: ttl },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
