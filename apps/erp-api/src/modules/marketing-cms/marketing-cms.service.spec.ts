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

  it('撤销排期时在同一事务清理时间并把待发布副作用置为 cancelled', async () => {
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
      status: 'scheduled',
      revision: 3,
      version: 3,
      publishedAt: null,
      scheduledAt: new Date(Date.now() + 120_000),
    };
    const contents = {
      findOne: vi.fn().mockReturnValue({
        session: vi.fn(),
        exec: vi.fn().mockResolvedValue(current),
      }),
      findOneAndUpdate: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          ...current,
          status: 'draft',
          version: 4,
          revision: 4,
          scheduledAt: null,
        }),
      }),
    };
    const updateSideEffect = vi
      .fn<
        (
          filter: Record<string, unknown>,
          update: Record<string, unknown>,
          options: Record<string, unknown>,
        ) => Promise<{ matchedCount: number }>
      >()
      .mockResolvedValue({ matchedCount: 1 });
    const sideEffects = {
      updateOne: updateSideEffect,
    };
    const service = createService({
      contents,
      revisions: { create: vi.fn().mockResolvedValue(undefined) },
      sideEffects,
    });
    await service.transition('content-001', 3, 'withdraw-schedule-001', 'draft');
    expect(contents.findOneAndUpdate.mock.calls[0]?.[1]).toMatchObject({
      $set: { status: 'draft', scheduledAt: null },
    });
    const [filter, update, options] = updateSideEffect.mock.calls[0] ?? [];
    expect(filter).toMatchObject({
      tenantId: 'tenant-001',
      aggregateId: 'content-001',
      aggregateVersion: 3,
    });
    expect(update).toMatchObject({ $set: { status: 'cancelled' } });
    expect(options).toEqual({ session: SESSION, timestamps: false });
  });

  it('人工重放严格绑定可信租户且拒绝跨租户或非死信记录', async () => {
    const sideEffects = {
      findOneAndUpdate: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue(null),
      }),
    };
    const service = createService({ sideEffects });
    await expect(service.replaySideEffect('01J8ZQK7V0A2M4N6P8R0T2W4Y0'))
      .rejects.toMatchObject({
        response: { code: 'MARKETING_SIDE_EFFECT_NOT_REPLAYABLE' },
      });
    expect(sideEffects.findOneAndUpdate.mock.calls[0]?.[0]).toEqual({
      tenantId: 'tenant-001',
      eventId: '01J8ZQK7V0A2M4N6P8R0T2W4Y0',
      status: 'dead',
    });
  });

  it('副作用状态查询只返回当前租户的非 PII 可靠性投影', async () => {
    const findOne = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue({
            eventId: '01J8ZQK7V0A2M4N6P8R0T2W4Y0',
            tenantId: 'tenant-001',
            kind: 'lead_notification',
            aggregateId: 'lead-001',
            aggregateVersion: 1,
            channel: 'email',
            status: 'dead',
            attempts: 1,
            deliveryAttempts: 6,
            nextAttemptAt: new Date('2026-07-27T00:00:00.000Z'),
            dispatchedAt: new Date('2026-07-27T00:00:01.000Z'),
            completedAt: new Date('2026-07-27T00:01:00.000Z'),
            lastErrorCode: 'MARKETING_NOTIFICATION_GATEWAY_FAILED',
            contactCiphertext: 'forbidden',
          }),
        }),
      }),
    });
    const service = createService({ sideEffects: { findOne } });
    const result = await service.getSideEffectStatus(
      '01J8ZQK7V0A2M4N6P8R0T2W4Y0',
    );
    expect(findOne).toHaveBeenCalledWith({
      tenantId: 'tenant-001',
      eventId: '01J8ZQK7V0A2M4N6P8R0T2W4Y0',
    });
    expect(result).toMatchObject({
      status: 'dead',
      deliveryAttempts: 6,
      completedAt: '2026-07-27T00:01:00.000Z',
    });
    expect(JSON.stringify(result)).not.toMatch(/tenantId|contactCiphertext/u);
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
