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
      { recordSystem: vi.fn().mockResolvedValue(undefined) } as never,
    );
    await processor.process({
      data: { tenantId: 'tenant-001', contentId: 'content-001' },
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
      { recordSystem: vi.fn() } as never,
    );
    await processor.process({
      data: { tenantId: 'tenant-001', contentId: 'content-001' },
    } as never);
    expect(revisions.create).not.toHaveBeenCalled();
    expect(outbox.create).not.toHaveBeenCalled();
  });
});
