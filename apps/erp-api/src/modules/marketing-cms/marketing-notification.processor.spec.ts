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
    );
    const job = {
      data: { tenantId: 'tenant-001', leadId: 'lead-001', channel: 'email' },
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
});
