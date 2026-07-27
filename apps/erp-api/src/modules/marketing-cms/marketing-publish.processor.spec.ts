import { describe, expect, it, vi } from 'vitest';
import { MarketingPublishProcessor } from './marketing-publish.processor.js';
import { MARKETING_PUBLISHED_EVENT_TYPE } from './marketing-cms.types.js';

describe('MarketingPublishProcessor', () => {
  it('到期内容在同一事务发布、留存快照并写 Outbox', async () => {
    const record = {
      id: 'content-001', tenantId: 'tenant-001', siteId: 'gaoq',
      type: 'page', locale: 'zh-CN', slug: 'home', title: '首页', summary: '',
      blocks: [], seo: {}, status: 'scheduled', scheduledAt: new Date(),
      publishedAt: null, version: 3, revision: 3, updatedBy: 'actor-001',
      save: vi.fn().mockResolvedValue(undefined),
    };
    const contents = {
      findOne: vi.fn().mockReturnValue({
        session: () => ({ exec: () => Promise.resolve(record) }),
      }),
    };
    const revisions = { create: vi.fn().mockResolvedValue(undefined) };
    const outbox = { create: vi.fn().mockResolvedValue(undefined) };
    const connection = {
      transaction: (handler: (session: object) => Promise<void>) => handler({}),
    };
    const processor = new MarketingPublishProcessor(
      connection as never, contents as never, revisions as never, outbox as never,
      {} as never,
      { add: vi.fn() } as never,
      {
        assertDispatchable: vi.fn().mockResolvedValue(true),
        markDelivered: vi.fn().mockResolvedValue(undefined),
        markFailure: vi.fn().mockResolvedValue(undefined),
      } as never,
      { recordSystem: vi.fn().mockResolvedValue(undefined) } as never,
    );
    await processor.process({
      data: {
        sideEffectEventId: '01J8ZQK7V0A2M4N6P8R0T2W4Y0',
        tenantId: 'tenant-001',
        contentId: 'content-001',
        aggregateVersion: 3,
      },
      attemptsMade: 0,
      opts: { attempts: 6 },
    } as never);
    expect(record.status).toBe('published');
    expect(record.version).toBe(4);
    expect(record.revision).toBe(4);
    expect(record.save).toHaveBeenCalledOnce();
    expect(revisions.create).toHaveBeenCalledOnce();
    expect(outbox.create).toHaveBeenCalledOnce();
    expect(JSON.stringify(outbox.create.mock.calls[0])).toContain(MARKETING_PUBLISHED_EVENT_TYPE);
  });

  it('记录已撤回或尚未到期时幂等跳过', async () => {
    const revisions = { create: vi.fn() };
    const outbox = { create: vi.fn() };
    const processor = new MarketingPublishProcessor(
      { transaction: (handler: (session: object) => Promise<void>) => handler({}) } as never,
      { findOne: () => ({ session: () => ({ exec: () => Promise.resolve(null) }) }) } as never,
      revisions as never,
      outbox as never,
      {} as never,
      { add: vi.fn() } as never,
      {
        assertDispatchable: vi.fn().mockResolvedValue(false),
        markDelivered: vi.fn(),
        markFailure: vi.fn(),
      } as never,
      { recordSystem: vi.fn() } as never,
    );
    await processor.process({
      data: {
        sideEffectEventId: '01J8ZQK7V0A2M4N6P8R0T2W4Y0',
        tenantId: 'tenant-001',
        contentId: 'content-001',
        aggregateVersion: 3,
      },
      attemptsMade: 0,
      opts: { attempts: 6 },
    } as never);
    expect(revisions.create).not.toHaveBeenCalled();
    expect(outbox.create).not.toHaveBeenCalled();
  });

  it('周期扫描只从已投递数据库 Outbox 重建无 PII 修复任务', async () => {
    const sideEffect = {
      eventId: '01J8ZQK7V0A2M4N6P8R0T2W4Y0',
      tenantId: 'tenant-001',
      aggregateId: 'content-001',
      aggregateVersion: 3,
    };
    const sideEffects = {
      find: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              lean: vi.fn().mockReturnValue({
                exec: vi.fn().mockResolvedValue([sideEffect]),
              }),
            }),
          }),
        }),
      }),
    };
    const automation = { add: vi.fn().mockResolvedValue(undefined) };
    const processor = new MarketingPublishProcessor(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      sideEffects as never,
      automation as never,
      {} as never,
      {} as never,
    );
    await processor.process({
      name: 'scan:scheduled',
      data: {},
    } as never);
    expect(automation.add).toHaveBeenCalledWith(
      'publish:repair',
      {
        sideEffectEventId: sideEffect.eventId,
        tenantId: sideEffect.tenantId,
        contentId: sideEffect.aggregateId,
        aggregateVersion: sideEffect.aggregateVersion,
      },
      expect.objectContaining({
        jobId: `marketing-publish-repair:${sideEffect.eventId}`,
        attempts: 6,
      }),
    );
    expect(JSON.stringify(automation.add.mock.calls)).not.toContain('contact');
  });

  it('发布事务在最终重试失败时登记 side effect dead 终态', async () => {
    const delivery = {
      assertDispatchable: vi.fn().mockResolvedValue(true),
      markDelivered: vi.fn(),
      markFailure: vi.fn().mockResolvedValue(undefined),
    };
    const processor = new MarketingPublishProcessor(
      {
        transaction: vi.fn().mockRejectedValue(
          new Error('MARKETING_PUBLISH_DATABASE_UNAVAILABLE'),
        ),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { add: vi.fn() } as never,
      delivery as never,
      { recordSystem: vi.fn() } as never,
    );
    await expect(processor.process({
      data: {
        sideEffectEventId: '01J8ZQK7V0A2M4N6P8R0T2W4Y0',
        tenantId: 'tenant-001',
        contentId: 'content-001',
        aggregateVersion: 3,
      },
      attemptsMade: 5,
      opts: { attempts: 6 },
    } as never)).rejects.toThrow('MARKETING_PUBLISH_DATABASE_UNAVAILABLE');
    expect(delivery.markFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-001',
        aggregateId: 'content-001',
      }),
      6,
      true,
      'MARKETING_PUBLISH_DATABASE_UNAVAILABLE',
    );
  });
});
