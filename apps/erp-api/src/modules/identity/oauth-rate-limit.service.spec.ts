import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

import { OAuthRateLimitService } from './oauth-rate-limit.service.js';

describe('OAuthRateLimitService', () => {
  it('使用摘要键执行原子计数与过期，并允许窗口内请求', async () => {
    const evalCommand = vi.fn().mockResolvedValue([1, 60]);
    const service = new OAuthRateLimitService({ eval: evalCommand } as unknown as Redis);

    await expect(service.assertAllowed('authorize_ip', '203.0.113.10')).resolves.toBeUndefined();

    expect(evalCommand).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('INCR'"),
      1,
      expect.stringMatching(/^gaoq:oauth:rate:authorize_ip:[a-f0-9]{64}$/),
      60,
    );
    expect(evalCommand.mock.calls[0]?.[2]).not.toContain('203.0.113.10');
  });

  it('超限返回 429 与窗口剩余秒数', async () => {
    const service = new OAuthRateLimitService({
      eval: vi.fn().mockResolvedValue([61, 17]),
    } as unknown as Redis);

    try {
      await service.assertAllowed('authorize_ip', '203.0.113.10');
      throw new Error('预期限流异常');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
      expect((error as HttpException).getResponse()).toMatchObject({ retryAfter: 17 });
    }
  });

  it('Redis 异常或返回结构异常时失败关闭', async () => {
    const redisFailure = new OAuthRateLimitService({
      eval: vi.fn().mockRejectedValue(new Error('redis unavailable')),
    } as unknown as Redis);
    const malformedResult = new OAuthRateLimitService({
      eval: vi.fn().mockResolvedValue('unexpected'),
    } as unknown as Redis);

    await expect(redisFailure.assertAllowed('token_ip', '203.0.113.10'))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(malformedResult.assertAllowed('token_ip', '203.0.113.10'))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
