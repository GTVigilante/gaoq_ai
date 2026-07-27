import { describe, expect, it, vi } from 'vitest';
import { MarketingCmsService } from './marketing-cms.service.js';

const SESSION = { id: 'session-001' };

describe('MarketingCmsService 事务副作用', () => {
  it('线索和两个通知 Outbox 在同一 Mongo 事务提交', async () => {
    const leads = {
      findOne: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          session: vi.fn().mockReturnValue({
            lean: vi.fn().mockReturnValue({
              exec: vi.fn().mockResolvedValue(null),
            }),
          }),
        }),
      }),
      create: vi.fn().mockResolvedValue(undefined),
    };
    const sideEffects = { create: vi.fn().mockResolvedValue(undefined) };
    const connection = {
      transaction: vi.fn(async (work: (session: typeof SESSION) => Promise<unknown>) =>
        work(SESSION)),
    };
    const service = createService({ connection, leads, sideEffects });

    await expect(service.submitLead({
      audience: 'brand',
      name: '测试联系人',
      contact: 'contact@example.com',
      requestSummary: '需要完整营销咨询与交付方案',
      privacyAccepted: true,
      website: '',
    })).resolves.toMatchObject({ duplicate: false });
    expect(leads.create).toHaveBeenCalledWith(
      [expect.objectContaining({ tenantId: 'tenant-marketing', status: 'new' })],
      { session: SESSION },
    );
    expect(sideEffects.create).toHaveBeenCalledWith([
      expect.objectContaining({ kind: 'lead_notification', channel: 'email' }),
      expect.objectContaining({ kind: 'lead_notification', channel: 'feishu' }),
    ], { session: SESSION });
  });

  it('排期状态、版本快照与发布 Outbox 使用同一幂等事务 Session', async () => {
    const current = {
      id: 'content-001',
      tenantId: 'tenant-001',
      siteId: 'gaoq',
      type: 'page',
      locale: 'zh-CN',
      slug: 'home',
      title: '首页',
      summary: '',
      blocks: [],
      seo: {},
      status: 'approved',
      revision: 2,
      version: 2,
      publishedAt: null,
      scheduledAt: null,
    };
    const contents = {
      findOne: vi.fn().mockReturnValue({
        session: vi.fn(),
        exec: vi.fn().mockResolvedValue(current),
      }),
      findOneAndUpdate: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          ...current,
          status: 'scheduled',
          version: 3,
          revision: 3,
          scheduledAt: new Date(Date.now() + 120_000),
        }),
      }),
    };
    const revisions = { create: vi.fn().mockResolvedValue(undefined) };
    const sideEffects = { create: vi.fn().mockResolvedValue(undefined) };
    const service = createService({ contents, revisions, sideEffects });

    await service.schedule(
      'content-001',
      2,
      'schedule-request-001',
      new Date(Date.now() + 120_000).toISOString(),
    );
    expect(revisions.create).toHaveBeenCalledWith(
      expect.any(Array),
      { session: SESSION },
    );
    expect(sideEffects.create).toHaveBeenCalledWith([
      expect.objectContaining({
        kind: 'scheduled_publish',
        aggregateId: 'content-001',
        aggregateVersion: 3,
        channel: null,
      }),
    ], { session: SESSION });
  });
});

function createService(overrides: Record<string, unknown>): MarketingCmsService {
  const context = {
    getTenantRequired: () => ({ tenantId: 'tenant-001' }),
    getActorRequired: () => ({ actorId: 'actor-001', traceId: 'trace-001' }),
  };
  const idempotency = {
    execute: vi.fn(async (
      _operation: string,
      _key: string,
      _input: unknown,
      work: (session: typeof SESSION) => Promise<unknown>,
    ) => work(SESSION)),
  };
  const config = {
    get: (name: string) => name === 'MARKETING_PUBLIC_TENANT_ID'
      ? 'tenant-marketing'
      : 'gaoq',
  };
  return new MarketingCmsService(
    (overrides.connection ?? { transaction: (work: (session: typeof SESSION) => unknown) => work(SESSION) }) as never,
    (overrides.contents ?? {}) as never,
    (overrides.revisions ?? {}) as never,
    (overrides.leads ?? {}) as never,
    (overrides.sideEffects ?? {}) as never,
    {} as never,
    {} as never,
    {} as never,
    context as never,
    idempotency as never,
    config as never,
    {
      blindIndex: vi.fn().mockReturnValue('d'.repeat(43)),
      protect: vi.fn().mockReturnValue({
        iv: 'i'.repeat(16),
        ciphertext: 'ciphertext',
        authTag: 'a'.repeat(22),
      }),
    } as never,
    {} as never,
    {} as never,
  );
}
