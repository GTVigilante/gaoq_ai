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
        .toBe('marketing-side-effect:01J8ZQK7V0A2M4N6P8R0T2W4Y0');
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

  it('已送达或已取消的副作用直接跳过，不读取或解密线索', async () => {
    const leads = { findOne: vi.fn() };
    const crypto = { unprotect: vi.fn() };
    const delivery = {
      assertDispatchable: vi.fn().mockResolvedValue(false),
      markDelivered: vi.fn(),
      markFailure: vi.fn(),
    };
    const processor = new MarketingNotificationProcessor(
      leads as never,
      crypto as never,
      { get: vi.fn() } as never,
      delivery as never,
    );
    await expect(processor.process(notificationJob())).resolves.toBeUndefined();
    expect(leads.findOne).not.toHaveBeenCalled();
    expect(crypto.unprotect).not.toHaveBeenCalled();
    expect(delivery.markDelivered).not.toHaveBeenCalled();
  });

  it.each([
    [
      new Error('MARKETING_SIDE_EFFECT_STORE_UNAVAILABLE'),
      'MARKETING_SIDE_EFFECT_STORE_UNAVAILABLE',
    ],
    [
      new Error('mongodb details'),
      'MARKETING_NOTIFICATION_DELIVERY_STATE_UNAVAILABLE',
    ],
    [
      new Error('MARKETING_SIDE_EFFECT_IDENTITY_INVALID'),
      'MARKETING_SIDE_EFFECT_ROUTE_MISMATCH',
    ],
  ])('路由状态读取失败使用受控错误码 %#', async (caught, expected) => {
    const processor = new MarketingNotificationProcessor(
      { findOne: vi.fn() } as never,
      { unprotect: vi.fn() } as never,
      { get: vi.fn() } as never,
      {
        assertDispatchable: vi.fn().mockRejectedValue(caught),
      } as never,
    );
    await expect(processor.process(notificationJob())).rejects.toThrow(expected);
  });

  it('网关成功后送达终态写入失败时不反向登记通知失败', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const delivery = {
      assertDispatchable: vi.fn().mockResolvedValue(true),
      markDelivered: vi.fn().mockRejectedValue(
        new Error('MARKETING_SIDE_EFFECT_STORE_UNAVAILABLE'),
      ),
      markFailure: vi.fn(),
    };
    const processor = new MarketingNotificationProcessor(
      leadModel() as never,
      { unprotect: vi.fn().mockReturnValue('contact@example.com') } as never,
      validConfig() as never,
      delivery as never,
    );
    await expect(processor.process(notificationJob())).rejects.toThrow(
      'MARKETING_SIDE_EFFECT_STORE_UNAVAILABLE',
    );
    expect(delivery.markFailure).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 't'.repeat(40)],
    ['https://notification.example.net', undefined],
  ])('网关配置缺失时失败关闭 %#', async (endpoint, token) => {
    const delivery = deliveryFixture();
    const processor = new MarketingNotificationProcessor(
      leadModel() as never,
      { unprotect: vi.fn().mockReturnValue('contact@example.com') } as never,
      {
        get: (name: string) => name.endsWith('ENDPOINT') ? endpoint : token,
      } as never,
      delivery as never,
    );
    await expect(processor.process(notificationJob({
      opts: {},
    }))).rejects.toThrow('MARKETING_NOTIFICATION_GATEWAY_UNAVAILABLE');
    expect(delivery.markFailure).toHaveBeenCalledWith(
      expect.any(Object),
      1,
      true,
      'MARKETING_NOTIFICATION_GATEWAY_UNAVAILABLE',
    );
  });

  it('线索不存在时不调用网关并登记可重试失败', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const delivery = deliveryFixture();
    const processor = new MarketingNotificationProcessor(
      leadModel(null) as never,
      { unprotect: vi.fn() } as never,
      validConfig() as never,
      delivery as never,
    );
    await expect(processor.process(notificationJob())).rejects.toThrow(
      'MARKETING_NOTIFICATION_LEAD_NOT_FOUND',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(delivery.markFailure).toHaveBeenCalledWith(
      expect.any(Object),
      1,
      false,
      'MARKETING_NOTIFICATION_LEAD_NOT_FOUND',
    );
  });

  it('网络异常归一化为网关失败，非受控处理异常不泄漏明文', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket details')));
    const networkDelivery = deliveryFixture();
    const network = new MarketingNotificationProcessor(
      leadModel() as never,
      { unprotect: vi.fn().mockReturnValue('contact@example.com') } as never,
      validConfig() as never,
      networkDelivery as never,
    );
    await expect(network.process(notificationJob())).rejects.toThrow(
      'MARKETING_NOTIFICATION_GATEWAY_FAILED',
    );

    const processingDelivery = deliveryFixture();
    const processing = new MarketingNotificationProcessor(
      leadModel() as never,
      {
        unprotect: vi.fn().mockImplementation(() => {
          throw new Error('raw details');
        }),
      } as never,
      validConfig() as never,
      processingDelivery as never,
    );
    await expect(processing.process(notificationJob({
      attemptsMade: 5,
      opts: { attempts: 0 },
    }))).rejects.toThrow('MARKETING_NOTIFICATION_PROCESSING_FAILED');
    expect(processingDelivery.markFailure).toHaveBeenCalledWith(
      expect.any(Object),
      6,
      true,
      'MARKETING_NOTIFICATION_PROCESSING_FAILED',
    );
  });
});

const validLead = {
  id: 'lead-001',
  tenantId: 'tenant-001',
  audience: 'brand',
  name: '测试联系人',
  requestSummary: '希望获取整合营销服务方案',
  contactIv: 'iv',
  contactCiphertext: 'ciphertext',
  contactAuthTag: 'tag',
};

function notificationJob(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      sideEffectEventId: '01J8ZQK7V0A2M4N6P8R0T2W4Y0',
      tenantId: 'tenant-001',
      leadId: 'lead-001',
      aggregateVersion: 1,
      channel: 'email',
    },
    attemptsMade: 0,
    opts: { attempts: 6 },
    ...overrides,
  } as never;
}

function leadModel(value: object | null = validLead) {
  return {
    findOne: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue(value),
        }),
      }),
    }),
  };
}

function validConfig() {
  return {
    get: (name: string) => name.endsWith('ENDPOINT')
      ? 'https://notification.example.net'
      : 't'.repeat(40),
  };
}

function deliveryFixture() {
  return {
    assertDispatchable: vi.fn().mockResolvedValue(true),
    markDelivered: vi.fn().mockResolvedValue(undefined),
    markFailure: vi.fn().mockResolvedValue(undefined),
  };
}
