import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarketingNotificationProcessor } from './marketing-notification.processor.js';

afterEach(() => vi.unstubAllGlobals());

describe('营销通知 Worker', () => {
  it('每次重试向网关发送稳定幂等键', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const lead = {
      id: 'lead-001',
      tenantId: 'tenant-001',
      audience: 'brand',
      name: '测试联系人',
      requestSummary: '希望获取整合营销服务方案',
      contactIv: 'iv',
      contactCiphertext: 'ciphertext',
      contactAuthTag: 'tag',
    };
    const leads = {
      findOne: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockReturnValue({
            exec: vi.fn().mockResolvedValue(lead),
          }),
        }),
      }),
    };
    const processor = new MarketingNotificationProcessor(
      leads as never,
      { unprotect: vi.fn().mockReturnValue('contact@example.com') } as never,
      {
        get: (name: string) => name.endsWith('ENDPOINT')
          ? 'https://notification.example.net'
          : 't'.repeat(40),
      } as never,
      {
        assertDispatchable: vi.fn().mockResolvedValue(true),
        markDelivered: vi.fn().mockResolvedValue(undefined),
        markFailure: vi.fn().mockResolvedValue(undefined),
      } as never,
    );
    const job = {
      data: {
        sideEffectEventId: '01J8ZQK7V0A2M4N6P8R0T2W4Y0',
        tenantId: 'tenant-001',
        leadId: 'lead-001',
        aggregateVersion: 1,
        channel: 'email',
      },
      attemptsMade: 0,
      opts: { attempts: 6 },
    };

    await processor.process(job as never);
    await processor.process(job as never);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect(new Headers(init?.headers).get('idempotency-key'))
        .toBe('marketing:tenant-001:lead-001:email:v1');
    }
  });

  it('副作用路由与租户不匹配时在解密和调用网关前拒绝', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const leads = { findOne: vi.fn() };
    const processor = new MarketingNotificationProcessor(
      leads as never,
      { unprotect: vi.fn() } as never,
      { get: vi.fn() } as never,
      {
        assertDispatchable: vi.fn().mockRejectedValue(
          new Error('MARKETING_SIDE_EFFECT_ROUTE_MISMATCH'),
        ),
      } as never,
    );
    await expect(processor.process({
      data: {
        sideEffectEventId: '01J8ZQK7V0A2M4N6P8R0T2W4Y0',
        tenantId: 'tenant-other',
        leadId: 'lead-001',
        aggregateVersion: 1,
        channel: 'email',
      },
      attemptsMade: 0,
      opts: { attempts: 6 },
    } as never)).rejects.toThrow('MARKETING_SIDE_EFFECT_ROUTE_MISMATCH');
    expect(leads.findOne).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('通知网关在最终重试仍失败时原子登记 dead 终态', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const leads = {
      findOne: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockReturnValue({
            exec: vi.fn().mockResolvedValue({
              id: 'lead-001',
              tenantId: 'tenant-001',
              audience: 'brand',
              name: '测试联系人',
              requestSummary: '测试方案',
              contactIv: 'iv',
              contactCiphertext: 'ciphertext',
              contactAuthTag: 'tag',
            }),
          }),
        }),
      }),
    };
    const delivery = {
      assertDispatchable: vi.fn().mockResolvedValue(true),
      markDelivered: vi.fn(),
      markFailure: vi.fn().mockResolvedValue(undefined),
    };
    const processor = new MarketingNotificationProcessor(
      leads as never,
      { unprotect: vi.fn().mockReturnValue('contact@example.com') } as never,
      {
        get: (name: string) => name.endsWith('ENDPOINT')
          ? 'https://notification.example.net'
          : 't'.repeat(40),
      } as never,
      delivery as never,
    );
    await expect(processor.process({
      data: {
        sideEffectEventId: '01J8ZQK7V0A2M4N6P8R0T2W4Y0',
        tenantId: 'tenant-001',
        leadId: 'lead-001',
        aggregateVersion: 1,
        channel: 'email',
      },
      attemptsMade: 5,
      opts: { attempts: 6 },
    } as never)).rejects.toThrow('MARKETING_NOTIFICATION_GATEWAY_FAILED');
    expect(delivery.markFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-001',
        aggregateId: 'lead-001',
      }),
      6,
      true,
      'MARKETING_NOTIFICATION_GATEWAY_FAILED',
    );
    expect(delivery.markDelivered).not.toHaveBeenCalled();
  });
});
