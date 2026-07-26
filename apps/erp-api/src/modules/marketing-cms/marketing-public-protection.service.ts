import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { AppEnvironment } from '../../config/environment.js';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis.constants.js';

const captchaResponse = z.object({ success: z.literal(true) }).passthrough();

/** 官网公开表单防滥用：Redis 限流失败关闭，并通过隔离验证码网关校验。 */
@Injectable()
export class MarketingPublicProtectionService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService<AppEnvironment, true>,
  ) {}

  async assertAllowed(ip: string, captchaToken: string): Promise<void> {
    await this.rateLimit(ip);
    const endpoint = this.config.get('MARKETING_CAPTCHA_VERIFY_ENDPOINT', { infer: true });
    const secret = this.config.get('MARKETING_CAPTCHA_BEARER_TOKEN', { infer: true });
    if (endpoint === undefined || secret === undefined) throw unavailable();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ token: captchaToken, remoteIp: ip }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
    if (response?.ok !== true || !captchaResponse.safeParse(await response.json()).success) {
      throw new HttpException(
        { code: 'MARKETING_CAPTCHA_INVALID', message: '人机验证未通过' },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async rateLimit(ip: string): Promise<void> {
    const digest = createHash('sha256').update(ip).digest('hex');
    const key = `gaoq:marketing:lead-rate:${digest}`;
    let count: number;
    try {
      const result = await this.redis.eval(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",
        1, key, 3600,
      );
      count = Number(result);
    } catch {
      throw unavailable();
    }
    if (!Number.isSafeInteger(count) || count > 10) throw new HttpException(
      { code: 'MARKETING_LEAD_RATE_LIMITED', message: '提交过于频繁', retryAfter: 3600 },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'MARKETING_PUBLIC_PROTECTION_UNAVAILABLE',
    message: '预约保护服务暂时不可用',
  });
}
