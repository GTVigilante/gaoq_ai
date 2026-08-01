import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { MarketingPublicProtectionService } from './marketing-public-protection.service.js';

describe('MarketingPublicProtectionService', () => {
  it('验证码配置缺失时失败关闭且不放行匿名线索', async () => {
    const redis = { eval: vi.fn().mockResolvedValue(1) };
    const config = { get: vi.fn().mockReturnValue(undefined) };
    const service = new MarketingPublicProtectionService(
      redis as never,
      config as never,
    );
    await expect(service.assertAllowed('203.0.113.10', 'captcha-token-0001'))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('验证码网关拒绝、异常或返回非法结构时均不放行', async () => {
    const redis = { eval: vi.fn().mockResolvedValue(1) };
    const config = {
      get: vi.fn((name: string) => name.endsWith('_ENDPOINT')
        ? 'https://captcha.example.net/verify'
        : 'captcha-gateway-token-at-least-32-characters'),
    };
    const service = new MarketingPublicProtectionService(
      redis as never,
      config as never,
    );
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        json: vi.fn().mockResolvedValue({ success: false }),
      });
      await expect(service.assertAllowed('203.0.113.10', 'captcha-token-0001'))
        .rejects.toBeInstanceOf(HttpException);
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('network'));
      await expect(service.assertAllowed('203.0.113.10', 'captcha-token-0001'))
        .rejects.toBeInstanceOf(HttpException);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ success: 'true' }),
      });
      await expect(service.assertAllowed('203.0.113.10', 'captcha-token-0001'))
        .rejects.toBeInstanceOf(HttpException);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ success: true, hostname: 'unexpected' }),
      });
      await expect(service.assertAllowed('203.0.113.10', 'captcha-token-0001'))
        .rejects.toBeInstanceOf(HttpException);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockRejectedValue(new SyntaxError('invalid json secret')),
      });
      await expect(service.assertAllowed('203.0.113.10', 'captcha-token-0001'))
        .rejects.toBeInstanceOf(HttpException);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('仅接受隔离验证码网关的精确成功响应并发送最小请求', async () => {
    const redis = { eval: vi.fn().mockResolvedValue(1) };
    const config = {
      get: vi.fn((name: string) => name.endsWith('_ENDPOINT')
        ? 'https://captcha.example.net/verify'
        : 'captcha-gateway-token-at-least-32-characters'),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ success: true }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      const service = new MarketingPublicProtectionService(
        redis as never,
        config as never,
      );

      await expect(service.assertAllowed(
        '203.0.113.10',
        'captcha-token-0001',
      )).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledWith(
        'https://captcha.example.net/verify',
        expect.objectContaining({
          method: 'POST',
          headers: {
            accept: 'application/json',
            authorization: 'Bearer captcha-gateway-token-at-least-32-characters',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            token: 'captcha-token-0001',
            remoteIp: '203.0.113.10',
          }),
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('Redis 限流不可用或超限时在调用验证码前失败关闭', async () => {
    const config = { get: vi.fn() };
    const failedRedis = { eval: vi.fn().mockRejectedValue(new Error('down')) };
    await expect(new MarketingPublicProtectionService(
      failedRedis as never,
      config as never,
    ).assertAllowed('203.0.113.10', 'captcha-token-0001'))
      .rejects.toBeInstanceOf(ServiceUnavailableException);

    const limitedRedis = { eval: vi.fn().mockResolvedValue(11) };
    await expect(new MarketingPublicProtectionService(
      limitedRedis as never,
      config as never,
    ).assertAllowed('203.0.113.10', 'captcha-token-0001'))
      .rejects.toMatchObject({ status: 429 });
    expect(config.get).not.toHaveBeenCalled();
  });
});
