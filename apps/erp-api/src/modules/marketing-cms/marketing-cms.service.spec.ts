import { describe, expect, it, vi } from 'vitest';
import {
  MarketingCmsService,
  marketingAiDraftView,
  marketingAiReviewView,
  marketingContentDetailView,
  marketingContentSummaryView,
  marketingLeadConsoleView,
  marketingMediaConsoleView,
  marketingRevisionListView,
  marketingUploadTicketView,
} from './marketing-cms.service.js';

const SESSION = { id: 'session-001' };
const NOW = '2026-07-27T00:00:00.000Z';

function contentRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    status: 'draft',
    revision: 1,
    version: 1,
    publishedAt: null,
    scheduledAt: null,
    updatedBy: 'actor-001',
    ...overrides,
  };
}

function validContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    siteId: 'gaoq',
    type: 'page',
    locale: 'zh-CN',
    slug: 'home',
    title: '首页',
    blocks: [],
    ...overrides,
  };
}

function chain(value: unknown): Record<string, ReturnType<typeof vi.fn>> {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ['select', 'session', 'lean', 'sort', 'limit']) {
    query[method] = vi.fn().mockReturnValue(query);
  }
  query.exec = vi.fn().mockResolvedValue(value);
  return query;
}

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

    await expect(service.submitLead('lead-submit-key-001', {
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
    await expect(service.replaySideEffect(
      'side-effect-replay-key-001',
      '01J8ZQK7V0A2M4N6P8R0T2W4Y0',
    ))
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

describe('MarketingCmsService 管理端公开投影', () => {
  it('内容摘要、详情和历史版本逐字段投影且不泄露租户与维护者', () => {
    const source = contentRecord({
      blocks: [{ type: 'hero', data: { title: '首页' } }],
      seo: { title: '首页' },
      publishedAt: new Date('2026-07-27T00:00:00.000Z'),
      scheduledAt: null,
      secret: 'internal',
    });
    const summary = marketingContentSummaryView(source);
    const detail = marketingContentDetailView(source);
    const revisions = marketingRevisionListView({
      items: [{
        revision: 1,
        actorId: 'actor-private',
        createdAt: new Date('2026-07-27T01:00:00.000Z'),
        snapshot: source,
      }],
    });

    expect(summary).toEqual({
      id: 'content-001',
      siteId: 'gaoq',
      type: 'page',
      locale: 'zh-CN',
      slug: 'home',
      title: '首页',
      summary: '',
      status: 'draft',
      revision: 1,
      version: 1,
    });
    expect(detail).toEqual({
      ...summary,
      blocks: source.blocks,
      seo: source.seo,
      publishedAt: '2026-07-27T00:00:00.000Z',
      scheduledAt: null,
    });
    expect(revisions).toEqual({
      items: [{
        revision: 1,
        createdAt: '2026-07-27T01:00:00.000Z',
        snapshot: detail,
      }],
    });
    expect(JSON.stringify({ summary, detail, revisions })).not.toMatch(
      /tenant-001|actor-private|updatedBy|internal/u,
    );
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(detail)).toBe(true);
    expect(Object.isFrozen(revisions.items)).toBe(true);
  });

  it('线索、媒体、上传票据和 AI 结果仅公开浏览器所需字段', () => {
    const lead = marketingLeadConsoleView({
      id: 'lead-001',
      tenantId: 'tenant-001',
      audience: 'brand',
      name: '品牌联系人',
      contact: 'brand@example.com',
      requestSummary: '需要完整品牌营销与内容合作方案',
      status: 'new',
      version: 1,
      createdAt: new Date('2026-07-27T00:00:00.000Z'),
      attribution: { secret: true },
      notes: [{ body: 'internal-note' }],
    });
    const media = marketingMediaConsoleView({
      id: 'media-001',
      fileName: 'hero.png',
      mimeType: 'image/png',
      status: 'ready',
      version: 2,
      variants: {},
      objectRef: 'private/object',
      checksum: 'private-checksum',
      scanEvidenceId: 'private-evidence',
    });
    const ticket = marketingUploadTicketView({
      id: 'media-001',
      uploadUrl: 'https://upload.example.invalid/signed',
      expiresAt: new Date('2026-07-27T00:10:00.000Z'),
      version: 1,
      objectRef: 'private/object',
    });
    const draft = marketingAiDraftView({
      id: 'generation-001',
      status: 'pending_review',
      output: { title: '草稿' },
      modelId: 'private-model',
      promptVersion: 'private-prompt',
    });
    const review = marketingAiReviewView({
      id: 'generation-001',
      contentId: 'content-001',
      action: 'translate',
      status: 'accepted',
      output: { title: '草稿' },
      modelId: 'private-model',
      promptVersion: 'private-prompt',
    });

    expect(lead).toEqual({
      id: 'lead-001',
      audience: 'brand',
      name: '品牌联系人',
      contact: 'brand@example.com',
      requestSummary: '需要完整品牌营销与内容合作方案',
      status: 'new',
      version: 1,
      createdAt: '2026-07-27T00:00:00.000Z',
    });
    expect(media).toEqual({
      id: 'media-001',
      fileName: 'hero.png',
      mimeType: 'image/png',
      status: 'ready',
      version: 2,
      variants: {},
    });
    expect(ticket).toEqual({
      id: 'media-001',
      uploadUrl: 'https://upload.example.invalid/signed',
      expiresAt: '2026-07-27T00:10:00.000Z',
      version: 1,
    });
    expect(draft).toEqual({
      id: 'generation-001',
      status: 'pending_review',
      output: { title: '草稿' },
    });
    expect(review).toEqual({
      id: 'generation-001',
      contentId: 'content-001',
      action: 'translate',
      status: 'accepted',
    });
    expect(JSON.stringify({ lead, media, ticket, draft, review })).not.toMatch(
      /tenant-001|private\/object|private-checksum|private-evidence|private-model|private-prompt|internal-note/u,
    );
  });
});

describe('MarketingCmsService 内容生命周期', () => {
  it('创建内容时使用可信租户、默认字段并保存首个快照', async () => {
    const contents = { create: vi.fn().mockResolvedValue(undefined) };
    const revisions = { create: vi.fn().mockResolvedValue(undefined) };
    const service = createService({ contents, revisions });

    const result = await service.create('create-001', validContent());

    expect(result.content).toMatchObject({
      tenantId: 'tenant-001',
      summary: '',
      seo: {},
      status: 'draft',
      revision: 1,
      version: 1,
    });
    expect(contents.create).toHaveBeenCalledWith(
      [expect.objectContaining({ tenantId: 'tenant-001', updatedBy: 'actor-001' })],
      { session: SESSION },
    );
    expect(revisions.create).toHaveBeenCalledWith(
      [expect.objectContaining({ tenantId: 'tenant-001', actorId: 'actor-001' })],
      { session: SESSION },
    );
  });

  it('内容引用媒体时要求所有媒体属于可信租户且已安全就绪', async () => {
    const mediaQuery = chain(2);
    const countDocuments = vi.fn().mockReturnValue(mediaQuery);
    const contents = { create: vi.fn().mockResolvedValue(undefined) };
    const service = createService({
      contents,
      revisions: { create: vi.fn().mockResolvedValue(undefined) },
      media: { countDocuments },
    });
    const raw = validContent({
      blocks: [{
        type: 'hero',
        data: {
          mediaId: 'media-001',
          nested: [{ mediaId: 'media-002' }, { mediaId: 'media-001' }],
        },
      }],
      seo: { imageRef: 'plain-ref' },
    });

    await service.create('create-with-media', raw);

    expect(countDocuments).toHaveBeenCalledWith({
      tenantId: 'tenant-001',
      id: { $in: ['media-001', 'media-002'] },
      status: 'ready',
    });
    expect(mediaQuery.session).toHaveBeenCalledWith(SESSION);
  });

  it('媒体缺失或未完成安全扫描时拒绝内容写入', async () => {
    const countDocuments = vi.fn().mockReturnValue(chain(0));
    const contents = { create: vi.fn() };
    const service = createService({
      contents,
      media: { countDocuments },
    });

    await expect(service.create('create-missing-media', validContent({
      blocks: [{ type: 'hero', data: { mediaId: 'media-001' } }],
    }))).rejects.toMatchObject({ response: { code: 'CMS_MEDIA_NOT_READY' } });
    expect(contents.create).not.toHaveBeenCalled();
  });

  it('列出和读取当前租户内容并支持 Mongoose 文档投影', async () => {
    const listed = [contentRecord({ publishedAt: new Date(NOW) })];
    const listQuery = chain(listed);
    const document = {
      toObject: vi.fn().mockReturnValue(contentRecord({ title: '文档首页' })),
    };
    const getQuery = chain(document);
    const contents = {
      find: vi.fn().mockReturnValue(listQuery),
      findOne: vi.fn().mockReturnValue(getQuery),
    };
    const service = createService({ contents });

    await expect(service.list()).resolves.toEqual({
      items: [expect.objectContaining({ id: 'content-001' })],
    });
    await expect(service.get('content-001')).resolves.toMatchObject({ title: '文档首页' });
    expect(contents.find).toHaveBeenCalledWith({ tenantId: 'tenant-001' });
    expect(listQuery.sort).toHaveBeenCalledWith({ updatedAt: -1 });
    expect(document.toObject).toHaveBeenCalled();
  });

  it('不存在的内容失败关闭', async () => {
    const service = createService({
      contents: { findOne: vi.fn().mockReturnValue(chain(null)) },
    });

    await expect(service.get('missing')).rejects.toMatchObject({
      response: { code: 'CMS_CONTENT_NOT_FOUND' },
    });
  });

  it('更新可编辑内容并重置为草稿和新增快照', async () => {
    const current = contentRecord({
      status: 'approved',
      version: 2,
      revision: 2,
      summary: '旧摘要',
    });
    const next = contentRecord({
      title: '新首页',
      status: 'draft',
      version: 3,
      revision: 3,
    });
    const contents = {
      findOne: vi.fn().mockReturnValue(chain(current)),
      findOneAndUpdate: vi.fn().mockReturnValue(chain(next)),
    };
    const revisions = { create: vi.fn().mockResolvedValue(undefined) };
    const service = createService({ contents, revisions });

    const result = await service.update(
      'content-001',
      2,
      'update-001',
      validContent({ title: '新首页', summary: undefined, seo: undefined }),
    );
    expect(result.content).toMatchObject({ title: '新首页' });
    expect(contents.findOneAndUpdate.mock.calls[0]?.[0]).toEqual({
      tenantId: 'tenant-001',
      id: 'content-001',
      version: 2,
    });
    expect(contents.findOneAndUpdate.mock.calls[0]?.[1]).toMatchObject({
      $set: {
        summary: '',
        seo: {},
        status: 'draft',
        updatedBy: 'actor-001',
      },
    });
    expect(contents.findOneAndUpdate.mock.calls[0]?.[2]).toEqual({
      returnDocument: 'after',
      session: SESSION,
      lean: true,
    });
  });

  it('拒绝错误版本、不可编辑状态及更新竞争', async () => {
    const versionService = createService({
      contents: { findOne: vi.fn().mockReturnValue(chain(contentRecord({ version: 2 }))) },
    });
    await expect(versionService.update('content-001', 1, 'update-version', validContent()))
      .rejects.toMatchObject({ response: { code: 'CMS_VERSION_CONFLICT' } });

    const immutableService = createService({
      contents: {
        findOne: vi.fn().mockReturnValue(chain(contentRecord({ status: 'published' }))),
      },
    });
    await expect(immutableService.update('content-001', 1, 'update-immutable', validContent()))
      .rejects.toMatchObject({ response: { code: 'CMS_CONTENT_IMMUTABLE' } });

    const conflictService = createService({
      contents: {
        findOne: vi.fn().mockReturnValue(chain(contentRecord())),
        findOneAndUpdate: vi.fn().mockReturnValue(chain(null)),
      },
    });
    await expect(conflictService.update('content-001', 1, 'update-conflict', validContent()))
      .rejects.toMatchObject({ response: { code: 'CMS_VERSION_CONFLICT' } });
  });

  it('发布内容时写快照和标准事件 Outbox', async () => {
    const current = contentRecord({ status: 'approved', version: 2, revision: 2 });
    const next = contentRecord({
      status: 'published',
      version: 3,
      revision: 3,
      publishedAt: new Date(NOW),
    });
    const contents = {
      findOne: vi.fn().mockReturnValue(chain(current)),
      findOneAndUpdate: vi.fn().mockReturnValue(chain(next)),
    };
    const outbox = { create: vi.fn().mockResolvedValue(undefined) };
    const service = createService({
      contents,
      revisions: { create: vi.fn().mockResolvedValue(undefined) },
      outbox,
    });

    await service.transition('content-001', 2, 'publish-001', 'published');

    expect(outbox.create.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        tenantId: 'tenant-001',
        aggregateType: 'marketing.content',
        aggregateId: 'content-001',
        aggregateVersion: 3,
        eventType: 'cn.gaoq.erp.marketing.content.published.v1',
      }),
    ]);
    expect(outbox.create.mock.calls[0]?.[0]).toMatchObject([{
      envelope: {
        tenantId: 'tenant-001',
        traceId: 'trace-001',
        data: { contentId: 'content-001' },
      },
    }]);
    expect(outbox.create.mock.calls[0]?.[1]).toEqual({ session: SESSION });
  });

  it('状态迁移拒绝错误版本、非法边和写竞争', async () => {
    const versionService = createService({
      contents: {
        findOne: vi.fn().mockReturnValue(chain(contentRecord({ status: 'draft', version: 2 }))),
      },
    });
    await expect(versionService.transition('content-001', 1, 'transition-version', 'in_review'))
      .rejects.toMatchObject({ response: { code: 'CMS_VERSION_CONFLICT' } });

    const invalidService = createService({
      contents: {
        findOne: vi.fn().mockReturnValue(chain(contentRecord({ status: 'draft' }))),
      },
    });
    await expect(invalidService.transition('content-001', 1, 'transition-invalid', 'published'))
      .rejects.toMatchObject({ response: { code: 'CMS_STATUS_TRANSITION_INVALID' } });

    const conflictService = createService({
      contents: {
        findOne: vi.fn().mockReturnValue(chain(contentRecord({ status: 'draft' }))),
        findOneAndUpdate: vi.fn().mockReturnValue(chain(null)),
      },
    });
    await expect(conflictService.transition('content-001', 1, 'transition-conflict', 'in_review'))
      .rejects.toMatchObject({ response: { code: 'CMS_VERSION_CONFLICT' } });
  });

  it('非排期内容正常回退且不会取消不存在的排期副作用', async () => {
    const current = contentRecord({ status: 'in_review' });
    const contents = {
      findOne: vi.fn().mockReturnValue(chain(current)),
      findOneAndUpdate: vi.fn().mockReturnValue(chain(contentRecord({ version: 2 }))),
    };
    const sideEffects = { updateOne: vi.fn() };
    const service = createService({
      contents,
      sideEffects,
      revisions: { create: vi.fn().mockResolvedValue(undefined) },
    });

    await service.transition('content-001', 1, 'back-to-draft', 'draft');
    expect(sideEffects.updateOne).not.toHaveBeenCalled();
  });

  it('取消排期副作用缺失时失败关闭', async () => {
    const current = contentRecord({
      status: 'scheduled',
      version: 3,
      revision: 3,
      scheduledAt: new Date(Date.now() + 120_000),
    });
    const service = createService({
      contents: {
        findOne: vi.fn().mockReturnValue(chain(current)),
        findOneAndUpdate: vi.fn().mockReturnValue(chain(contentRecord({
          status: 'draft',
          version: 4,
          revision: 4,
        }))),
      },
      revisions: { create: vi.fn().mockResolvedValue(undefined) },
      sideEffects: { updateOne: vi.fn().mockResolvedValue({ matchedCount: 0 }) },
    });

    await expect(service.transition('content-001', 3, 'cancel-missing', 'draft'))
      .rejects.toThrow('MARKETING_SCHEDULED_SIDE_EFFECT_MISSING');
  });

  it('排期参数逐项失败关闭', async () => {
    const service = createService({});
    const dates = [
      'invalid',
      new Date(Date.now() + 30_000).toISOString(),
      new Date(Date.now() + 367 * 86_400_000).toISOString(),
    ];

    for (const [index, value] of dates.entries()) {
      await expect(service.schedule('content-001', 1, `schedule-invalid-${index}`, value))
        .rejects.toMatchObject({ response: { code: 'CMS_SCHEDULE_TIME_INVALID' } });
    }
  });

  it('排期拒绝错误版本、非批准状态和写竞争', async () => {
    const future = new Date(Date.now() + 120_000).toISOString();
    const versionService = createService({
      contents: {
        findOne: vi.fn().mockReturnValue(chain(contentRecord({ status: 'approved', version: 2 }))),
      },
    });
    await expect(versionService.schedule('content-001', 1, 'schedule-version', future))
      .rejects.toMatchObject({ response: { code: 'CMS_VERSION_CONFLICT' } });

    const statusService = createService({
      contents: { findOne: vi.fn().mockReturnValue(chain(contentRecord())) },
    });
    await expect(statusService.schedule('content-001', 1, 'schedule-status', future))
      .rejects.toMatchObject({ response: { code: 'CMS_STATUS_TRANSITION_INVALID' } });

    const conflictService = createService({
      contents: {
        findOne: vi.fn().mockReturnValue(chain(contentRecord({ status: 'approved' }))),
        findOneAndUpdate: vi.fn().mockReturnValue(chain(null)),
      },
    });
    await expect(conflictService.schedule('content-001', 1, 'schedule-conflict', future))
      .rejects.toMatchObject({ response: { code: 'CMS_VERSION_CONFLICT' } });
  });

  it('公开查询只使用固定租户、站点和发布状态', async () => {
    const publicRecord = contentRecord({
      tenantId: 'tenant-marketing',
      publishedAt: new Date(NOW),
      status: 'published',
    });
    const oneQuery = chain(publicRecord);
    const listQuery = chain([publicRecord]);
    const contents = {
      findOne: vi.fn().mockReturnValue(oneQuery),
      find: vi.fn().mockReturnValue(listQuery),
    };
    const service = createService({ contents });

    const one = await service.publicContent('zh-CN', 'page', 'home');
    const listed = await service.publicList('en', 'article');

    expect(one).not.toHaveProperty('tenantId');
    expect(listed.items[0]).not.toHaveProperty('tenantId');
    expect(contents.findOne).toHaveBeenCalledWith({
      tenantId: 'tenant-marketing',
      siteId: 'gaoq',
      locale: 'zh-CN',
      type: 'page',
      slug: 'home',
      status: 'published',
    });
    expect(listQuery.sort).toHaveBeenCalledWith({ publishedAt: -1 });
  });

  it('公开查询拒绝非法枚举和不存在内容', async () => {
    const service = createService({
      contents: { findOne: vi.fn().mockReturnValue(chain(null)) },
    });

    await expect(service.publicContent('fr', 'page', 'home'))
      .rejects.toMatchObject({ response: { code: 'CMS_PUBLIC_QUERY_INVALID' } });
    await expect(service.publicContent('zh-CN', 'unknown', 'home'))
      .rejects.toMatchObject({ response: { code: 'CMS_PUBLIC_QUERY_INVALID' } });
    await expect(service.publicList('fr', 'page'))
      .rejects.toMatchObject({ response: { code: 'CMS_PUBLIC_QUERY_INVALID' } });
    await expect(service.publicList('zh-CN', 'unknown'))
      .rejects.toMatchObject({ response: { code: 'CMS_PUBLIC_QUERY_INVALID' } });
    await expect(service.publicContent('zh-CN', 'page', 'missing'))
      .rejects.toMatchObject({ response: { code: 'CMS_PUBLIC_CONTENT_NOT_FOUND' } });
  });

  it('列出历史版本并执行排期内容回滚', async () => {
    const current = contentRecord({
      status: 'scheduled',
      version: 3,
      revision: 3,
      scheduledAt: new Date(Date.now() + 120_000),
    });
    const source = {
      revision: 1,
      actorId: 'actor-old',
      createdAt: new Date(NOW),
      snapshot: validContent({ summary: undefined, seo: undefined }),
    };
    const revisionsFind = chain([source]);
    const revisionsFindOne = chain(source);
    const contents = {
      findOne: vi.fn().mockReturnValue(chain(current)),
      findOneAndUpdate: vi.fn().mockReturnValue(chain(contentRecord({
        title: '首页',
        status: 'draft',
        version: 4,
        revision: 4,
      }))),
    };
    const revisions = {
      find: vi.fn().mockReturnValue(revisionsFind),
      findOne: vi.fn().mockReturnValue(revisionsFindOne),
      create: vi.fn().mockResolvedValue(undefined),
    };
    const sideEffects = { updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }) };
    const service = createService({ contents, revisions, sideEffects });

    await expect(service.revisionsFor('content-001')).resolves.toEqual({
      items: [expect.objectContaining({ revision: 1, actorId: 'actor-old' })],
    });
    const rollback = await service.rollback('content-001', 1, 3, 'rollback-001');
    expect(rollback.content).toMatchObject({ status: 'draft' });
    expect(revisionsFind.sort).toHaveBeenCalledWith({ revision: -1 });
    expect(revisionsFindOne.session).toHaveBeenCalledWith(SESSION);
    expect(sideEffects.updateOne).toHaveBeenCalled();
  });

  it('回滚拒绝错误版本、缺失历史版本和写竞争', async () => {
    const versionService = createService({
      contents: { findOne: vi.fn().mockReturnValue(chain(contentRecord({ version: 2 }))) },
    });
    await expect(versionService.rollback('content-001', 1, 1, 'rollback-version'))
      .rejects.toMatchObject({ response: { code: 'CMS_VERSION_CONFLICT' } });

    const missingService = createService({
      contents: { findOne: vi.fn().mockReturnValue(chain(contentRecord())) },
      revisions: { findOne: vi.fn().mockReturnValue(chain(null)) },
    });
    await expect(missingService.rollback('content-001', 9, 1, 'rollback-missing'))
      .rejects.toMatchObject({ response: { code: 'CMS_REVISION_NOT_FOUND' } });

    const conflictService = createService({
      contents: {
        findOne: vi.fn().mockReturnValue(chain(contentRecord())),
        findOneAndUpdate: vi.fn().mockReturnValue(chain(null)),
      },
      revisions: {
        findOne: vi.fn().mockReturnValue(chain({
          snapshot: validContent(),
        })),
      },
    });
    await expect(conflictService.rollback('content-001', 1, 1, 'rollback-conflict'))
      .rejects.toMatchObject({ response: { code: 'CMS_VERSION_CONFLICT' } });
  });
});

describe('MarketingCmsService 线索安全与可靠性', () => {
  const validLead = {
    audience: 'brand',
    name: ' 测试联系人 ',
    contact: ' contact@example.com ',
    requestSummary: ' 需要完整营销咨询与交付方案 ',
    privacyAccepted: true,
    website: '',
    utmSource: 'search',
    utmCampaign: 'summer',
  };

  it('30 天内未关闭的相同联系人幂等返回且不重复保存 PII', async () => {
    const leads = {
      findOne: vi.fn()
        .mockReturnValueOnce(chain(null))
        .mockReturnValueOnce(chain({ id: 'lead-existing' })),
      create: vi.fn(),
    };
    const sideEffects = { create: vi.fn() };
    const service = createService({ leads, sideEffects });

    await expect(service.submitLead('lead-submit-key-002', validLead))
      .resolves.toEqual({ leadId: 'lead-existing', duplicate: true });
    expect(leads.create).not.toHaveBeenCalled();
    expect(sideEffects.create).not.toHaveBeenCalled();
  });

  it('相同预约幂等键和相同业务请求直接返回稳定线索标识', async () => {
    const existing = {
      id: 'lead-stable-001',
      audience: 'brand',
      name: '测试联系人',
      requestSummary: '需要完整营销咨询与交付方案',
      attribution: { utmSource: 'search', utmCampaign: 'summer' },
      dedupeDigest: 'd'.repeat(43),
    };
    const leads = {
      findOne: vi.fn().mockReturnValue(chain(existing)),
      create: vi.fn(),
    };
    const service = createService({ leads });

    await expect(service.submitLead('lead-submit-key-005', validLead))
      .resolves.toEqual({ leadId: 'lead-stable-001', duplicate: true });

    expect(leads.findOne).toHaveBeenCalledOnce();
    expect(leads.create).not.toHaveBeenCalled();
  });

  it.each([
    { audience: 'creator' },
    { name: '其他联系人' },
    { requestSummary: '不同的业务请求摘要' },
    { dedupeDigest: 'x'.repeat(43) },
    { attribution: null },
    { attribution: [] },
    { attribution: { utmSource: 'other', utmCampaign: 'summer' } },
    { attribution: { utmSource: 1, utmCampaign: 'summer' } },
    { attribution: { utmSource: 'search' } },
  ])('相同预约幂等键被不同业务请求复用时冲突 %#', async (override) => {
    const existing = {
      id: 'lead-stable-001',
      audience: 'brand',
      name: '测试联系人',
      requestSummary: '需要完整营销咨询与交付方案',
      attribution: { utmSource: 'search', utmCampaign: 'summer' },
      dedupeDigest: 'd'.repeat(43),
      ...override,
    };
    const service = createService({
      leads: { findOne: vi.fn().mockReturnValue(chain(existing)) },
    });

    await expect(service.submitLead('lead-submit-key-006', validLead))
      .rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REUSED' } });
  });

  it('并发预约唯一键冲突后重读裁决同请求重放', async () => {
    const existing = {
      id: 'lead-stable-002',
      audience: 'brand',
      name: '测试联系人',
      requestSummary: '需要完整营销咨询与交付方案',
      attribution: { utmSource: 'search', utmCampaign: 'summer' },
      dedupeDigest: 'd'.repeat(43),
    };
    const connection = {
      transaction: vi.fn().mockRejectedValue({ code: 11000 }),
    };
    const service = createService({
      connection,
      leads: { findOne: vi.fn().mockReturnValue(chain(existing)) },
    });

    await expect(service.submitLead('lead-submit-key-007', validLead))
      .resolves.toEqual({ leadId: 'lead-stable-002', duplicate: true });
  });

  it('预约唯一键冲突重读缺失时保留原错误，非唯一键错误不误判', async () => {
    const duplicate = new Error('E11000 duplicate key');
    const duplicateService = createService({
      connection: { transaction: vi.fn().mockRejectedValue(duplicate) },
      leads: { findOne: vi.fn().mockReturnValue(chain(null)) },
    });
    await expect(duplicateService.submitLead('lead-submit-key-008', validLead))
      .rejects.toBe(duplicate);

    const primitiveService = createService({
      connection: { transaction: vi.fn().mockRejectedValue('transaction failed') },
    });
    await expect(primitiveService.submitLead('lead-submit-key-009', validLead))
      .rejects.toBe('transaction failed');
  });

  it('公开预约服务自身拒绝非法幂等键', async () => {
    const service = createService({});

    await expect(service.submitLead('bad key', validLead))
      .rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
  });

  it('线索输入每项约束均失败关闭', async () => {
    const invalidValues: readonly unknown[] = [
      null,
      [],
      { ...validLead, unexpected: true },
      { ...validLead, website: 'bot' },
      { ...validLead, audience: 'other' },
      { ...validLead, name: 1 },
      { ...validLead, name: '' },
      { ...validLead, name: 'a'.repeat(101) },
      { ...validLead, contact: 1 },
      { ...validLead, contact: '1234' },
      { ...validLead, contact: 'a'.repeat(255) },
      { ...validLead, requestSummary: 1 },
      { ...validLead, requestSummary: 'short' },
      { ...validLead, requestSummary: 'a'.repeat(2001) },
      { ...validLead, privacyAccepted: false },
      { ...validLead, requestSummary: '<script>alert(1)</script>' },
    ];
    const service = createService({});

    for (const value of invalidValues) {
      await expect(service.submitLead('lead-submit-key-003', value))
        .rejects.toMatchObject({ response: { code: 'MARKETING_LEAD_INVALID' } });
    }
  });

  it('仅保留合法且长度受控的营销归因字段', async () => {
    const leads = {
      findOne: vi.fn().mockReturnValue(chain(null)),
      create: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService({
      leads,
      sideEffects: { create: vi.fn().mockResolvedValue(undefined) },
    });

    await service.submitLead('lead-submit-key-004', {
      ...validLead,
      utmSource: 1,
      utmCampaign: 'x'.repeat(129),
    });

    expect(leads.create).toHaveBeenCalledWith(
      [expect.objectContaining({ attribution: {} })],
      { session: SESSION },
    );
  });

  it('重放死信恢复所有可靠性字段并返回无 PII 投影', async () => {
    const record = {
      eventId: 'event-001',
      kind: 'lead_notification',
      status: 'pending',
      attempts: 0,
      contactCiphertext: 'forbidden',
    };
    const findOneAndUpdate = vi.fn().mockReturnValue(chain(record));
    const service = createService({ sideEffects: { findOneAndUpdate } });

    await expect(service.replaySideEffect(
      'side-effect-replay-key-002',
      'event-001',
    )).resolves.toEqual({
      eventId: 'event-001',
      kind: 'lead_notification',
      status: 'pending',
      attempts: 0,
    });
    expect(findOneAndUpdate.mock.calls[0]?.[0]).toEqual({
      tenantId: 'tenant-001',
      eventId: 'event-001',
      status: 'dead',
    });
    expect(findOneAndUpdate.mock.calls[0]?.[1]).toMatchObject({
      $set: {
        status: 'pending',
        attempts: 0,
        deliveryAttempts: 0,
        lastErrorCode: null,
      },
    });
    expect(findOneAndUpdate.mock.calls[0]?.[2]).toEqual({
      returnDocument: 'after',
      lean: true,
      session: SESSION,
    });
  });

  it('副作用状态缺失时拒绝，未投递时间保持 null', async () => {
    const missingService = createService({
      sideEffects: { findOne: vi.fn().mockReturnValue(chain(null)) },
    });
    await expect(missingService.getSideEffectStatus('missing'))
      .rejects.toMatchObject({ response: { code: 'MARKETING_SIDE_EFFECT_NOT_FOUND' } });

    const pending = {
      eventId: 'event-pending',
      kind: 'scheduled_publish',
      aggregateId: 'content-001',
      aggregateVersion: 2,
      channel: null,
      status: 'pending',
      attempts: 0,
      deliveryAttempts: 0,
      nextAttemptAt: new Date(NOW),
      dispatchedAt: null,
      completedAt: null,
      lastErrorCode: null,
    };
    const service = createService({
      sideEffects: { findOne: vi.fn().mockReturnValue(chain(pending)) },
    });
    await expect(service.getSideEffectStatus('event-pending')).resolves.toMatchObject({
      dispatchedAt: null,
      completedAt: null,
    });
  });

  it('线索列表解密联系人且 CSV 防公式注入并正确转义', async () => {
    const records = [
      {
        id: 'lead-001',
        audience: 'brand',
        name: '=IMPORTXML("x")',
        contactIv: 'iv',
        contactCiphertext: 'ciphertext',
        contactAuthTag: 'tag',
        requestSummary: '含有"引号"',
        status: 'new',
        attribution: { source: 'search' },
        consentedAt: new Date(NOW),
        assigneeId: null,
        notes: [{ body: '备注' }],
        version: 1,
        createdAt: new Date(NOW),
      },
      {
        id: 'lead-002',
        audience: 'creator',
        name: '普通联系人',
        contactIv: 'iv',
        contactCiphertext: 'ciphertext',
        contactAuthTag: 'tag',
        requestSummary: '正常摘要',
        status: 'contacted',
        attribution: {},
        consentedAt: new Date(NOW),
        assigneeId: 'actor-002',
        notes: [],
        version: 2,
        createdAt: new Date(NOW),
      },
    ];
    const leads = { find: vi.fn().mockReturnValue(chain(records)) };
    const leadCrypto = {
      unprotect: vi.fn()
        .mockReturnValueOnce('+8613800000000')
        .mockReturnValueOnce(undefined),
    };
    const service = createService({ leads, leadCrypto });

    const listed = await service.listLeads();
    const csv = await service.exportLeadsCsv();

    expect(listed.items[0]).toMatchObject({ contact: '+8613800000000' });
    expect(leadCrypto.unprotect).toHaveBeenCalledWith(
      'tenant-001',
      'lead-001',
      { iv: 'iv', ciphertext: 'ciphertext', authTag: 'tag' },
    );
    expect(csv).toContain('"\'=IMPORTXML(""x"")"');
    expect(csv).toContain('"含有""引号"""');
    expect(csv.startsWith('\uFEFF')).toBe(true);
  });

  it('更新线索状态时执行白名单和乐观锁', async () => {
    const success = { id: 'lead-001', status: 'qualified', version: 2 };
    const findOneAndUpdate = vi.fn()
      .mockReturnValueOnce(chain(success))
      .mockReturnValueOnce(chain(null));
    const service = createService({ leads: { findOneAndUpdate } });

    await expect(service.updateLeadStatus('lead-status-key-001', 'lead-001', 'qualified', 1))
      .resolves.toEqual(success);
    await expect(service.updateLeadStatus('lead-status-key-002', 'lead-001', 'invalid', 1))
      .rejects.toMatchObject({ response: { code: 'MARKETING_LEAD_STATUS_INVALID' } });
    await expect(service.updateLeadStatus('lead-status-key-003', 'lead-001', 'closed', 1))
      .rejects.toMatchObject({ response: { code: 'CMS_VERSION_CONFLICT' } });
  });

  it('分配负责人时校验标识并执行乐观锁', async () => {
    const success = { id: 'lead-001', assigneeId: 'actor:002', version: 2 };
    const findOneAndUpdate = vi.fn()
      .mockReturnValueOnce(chain(success))
      .mockReturnValueOnce(chain(null));
    const service = createService({ leads: { findOneAndUpdate } });

    await expect(service.assignLead(
      'lead-assignee-key-001', 'lead-001', 'actor:002', 1,
    )).resolves.toEqual(success);
    for (const value of ['', 'bad id', 'a'.repeat(129)]) {
      await expect(service.assignLead('lead-assignee-key-002', 'lead-001', value, 1))
        .rejects.toMatchObject({ response: { code: 'MARKETING_LEAD_ASSIGNEE_INVALID' } });
    }
    await expect(service.assignLead('lead-assignee-key-003', 'lead-001', 'actor-003', 1))
      .rejects.toMatchObject({ response: { code: 'CMS_VERSION_CONFLICT' } });
  });

  it('追加备注时规范化文本、限制数量并执行乐观锁', async () => {
    const findOneAndUpdate = vi.fn()
      .mockReturnValueOnce(chain({ id: 'lead-001', version: 2 }))
      .mockReturnValueOnce(chain(null));
    const service = createService({ leads: { findOneAndUpdate } });

    const result = await service.addLeadNote(
      'lead-note-key-001', 'lead-001', '  已电话联系  ', 1,
    );
    expect(result).toMatchObject({
      id: 'lead-001',
      note: { actorId: 'actor-001', body: '已电话联系' },
      version: 2,
    });
    expect(findOneAndUpdate).toHaveBeenNthCalledWith(
      1,
      { tenantId: 'tenant-001', id: 'lead-001', version: 1 },
      {
        $push: {
          notes: {
            $each: [expect.objectContaining({ body: '已电话联系' })],
            $slice: -100,
          },
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', lean: true, session: SESSION },
    );
    for (const value of [' ', 'a'.repeat(2001)]) {
      await expect(service.addLeadNote('lead-note-key-002', 'lead-001', value, 1))
        .rejects.toMatchObject({ response: { code: 'MARKETING_LEAD_NOTE_INVALID' } });
    }
    await expect(service.addLeadNote('lead-note-key-003', 'lead-001', '再次联系', 1))
      .rejects.toMatchObject({ response: { code: 'CMS_VERSION_CONFLICT' } });
  });
});

describe('MarketingCmsService 媒体与 AI 人工复核', () => {
  const validMedia = {
    siteId: 'gaoq',
    fileName: 'hero.png',
    mimeType: 'image/png',
    sizeBytes: 1024,
    altText: { 'zh-CN': '首页主图', en: 'Hero image' },
    copyrightSource: '内部原创',
  };

  it('创建媒体上传票据但不接受客户端对象引用', async () => {
    const mediaGateway = {
      createUpload: vi.fn().mockResolvedValue({
        objectRef: 'object-001',
        uploadUrl: 'https://upload.invalid/object-001',
        expiresAt: NOW,
      }),
    };
    const media = { create: vi.fn().mockResolvedValue(undefined) };
    const service = createService({ mediaGateway, media });

    await expect(service.createMediaUpload(
      'media-upload-key-001', validMedia,
    )).resolves.toMatchObject({
      uploadUrl: 'https://upload.invalid/object-001',
      expiresAt: NOW,
      version: 1,
    });
    expect(mediaGateway.createUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-001',
        siteId: 'gaoq',
        fileName: 'hero.png',
      }),
      'media-upload-key-001',
    );
    expect(media.create).toHaveBeenCalledWith(
      [expect.objectContaining({
        tenantId: 'tenant-001',
        objectRef: 'object-001',
        status: 'uploading',
      })],
      { session: SESSION },
    );
  });

  it('媒体上传幂等重放以安全快照重新签发短时 URL', async () => {
    const replay = vi.fn(async (
      _operation: string,
      _key: string,
      _request: unknown,
      _handler: unknown,
      restore: (
        stored: Readonly<Record<string, unknown>>,
      ) => Promise<Record<string, unknown>>,
    ) => restore({
      id: 'media-stable-001',
      objectRef: 'object-ref-001',
      version: 1,
    }));
    const mediaGateway = {
      createUpload: vi.fn().mockResolvedValue({
        objectRef: 'object-ref-001',
        uploadUrl: 'https://upload.invalid/refreshed',
        expiresAt: NOW,
      }),
    };
    const service = createService({
      idempotency: { executeWithEphemeralResult: replay },
      mediaGateway,
    });

    await expect(service.createMediaUpload('media-upload-key-004', validMedia))
      .resolves.toEqual({
        id: 'media-stable-001',
        uploadUrl: 'https://upload.invalid/refreshed',
        expiresAt: NOW,
        version: 1,
      });
    const gatewayInput = mediaGateway.createUpload.mock.calls[0]?.[0] as unknown as {
      readonly mediaId?: unknown;
    };
    expect(typeof gatewayInput.mediaId).toBe('string');
    expect(String(gatewayInput.mediaId)).toMatch(/^media-/u);
    expect(mediaGateway.createUpload.mock.calls[0]?.[1]).toBe('media-upload-key-004');
  });

  it('媒体上传幂等重放拒绝网关替换对象引用', async () => {
    const idempotency = {
      executeWithEphemeralResult: vi.fn(async (
        _operation: string,
        _key: string,
        _request: unknown,
        _handler: unknown,
        replay: (
          stored: Readonly<Record<string, unknown>>,
        ) => Promise<Record<string, unknown>>,
      ) => replay({
        id: 'media-stable-001',
        objectRef: 'object-ref-001',
        version: 1,
      })),
    };
    const service = createService({
      idempotency,
      mediaGateway: {
        createUpload: vi.fn().mockResolvedValue({
          objectRef: 'object-ref-replaced',
          uploadUrl: 'https://upload.invalid/replaced',
          expiresAt: NOW,
        }),
      },
    });

    await expect(service.createMediaUpload('media-upload-key-005', validMedia))
      .rejects.toMatchObject({ response: { code: 'CMS_MEDIA_OBJECT_MISMATCH' } });
  });

  it('媒体元数据每项约束均失败关闭', async () => {
    const invalidValues: readonly unknown[] = [
      null,
      [],
      { ...validMedia, unexpected: true },
      { ...validMedia, siteId: 1 },
      { ...validMedia, siteId: 'bad id' },
      { ...validMedia, fileName: 1 },
      { ...validMedia, fileName: '../secret' },
      { ...validMedia, mimeType: 1 },
      { ...validMedia, mimeType: 'text/html' },
      { ...validMedia, sizeBytes: '1' },
      { ...validMedia, sizeBytes: 1.5 },
      { ...validMedia, sizeBytes: 0 },
      { ...validMedia, sizeBytes: 20_971_521 },
      { ...validMedia, altText: null },
      { ...validMedia, altText: [] },
      { ...validMedia, copyrightSource: 1 },
      { ...validMedia, copyrightSource: 'a'.repeat(501) },
      { ...validMedia, altText: { fr: 'image' } },
      { ...validMedia, altText: { en: 1 } },
      { ...validMedia, altText: { en: 'a'.repeat(501) } },
    ];
    const service = createService({});

    for (const value of invalidValues) {
      await expect(service.createMediaUpload('media-upload-key-002', value))
        .rejects.toMatchObject({ response: { code: 'CMS_MEDIA_INVALID' } });
    }
  });

  it('媒体上传回执匹配后保存扫描证据和衍生版本', async () => {
    const record = {
      id: 'media-001',
      tenantId: 'tenant-001',
      siteId: 'gaoq',
      fileName: 'hero.png',
      mimeType: 'image/png',
      sizeBytes: 1024,
      objectRef: 'object-001',
      status: 'uploading',
      checksum: null,
      scanEvidenceId: null,
      variants: {},
      altText: {},
      copyrightSource: '',
      version: 1,
    };
    const next = {
      ...record,
      status: 'ready',
      checksum: 'checksum-001',
      scanEvidenceId: 'scan-001',
      variants: { thumbnail: 'object-thumb' },
      version: 2,
    };
    const media = {
      findOne: vi.fn().mockReturnValue(chain(record)),
      findOneAndUpdate: vi.fn().mockReturnValue(chain(next)),
    };
    const mediaGateway = {
      verifyUpload: vi.fn().mockResolvedValue({
        objectRef: 'object-001',
        checksum: 'checksum-001',
        scanEvidenceId: 'scan-001',
        variants: { thumbnail: 'object-thumb' },
      }),
    };
    const service = createService({ media, mediaGateway });

    await expect(service.verifyMedia('media-verify-key-001', 'media-001', 1))
      .resolves.toMatchObject({
      id: 'media-001',
      status: 'ready',
      scanEvidenceId: 'scan-001',
      version: 2,
    });
  });

  it('媒体验证拒绝缺失、状态版本错配、对象替换和写竞争', async () => {
    const missingService = createService({
      media: { findOne: vi.fn().mockReturnValue(chain(null)) },
    });
    await expect(missingService.verifyMedia('media-verify-key-002', 'missing', 1))
      .rejects.toMatchObject({ response: { code: 'CMS_MEDIA_NOT_FOUND' } });

    const wrongState = {
      id: 'media-001',
      tenantId: 'tenant-001',
      objectRef: 'object-001',
      status: 'ready',
      version: 2,
    };
    const stateService = createService({
      media: { findOne: vi.fn().mockReturnValue(chain(wrongState)) },
    });
    await expect(stateService.verifyMedia('media-verify-key-003', 'media-001', 1))
      .rejects.toMatchObject({ response: { code: 'CMS_VERSION_CONFLICT' } });

    const uploading = { ...wrongState, status: 'uploading', version: 1 };
    const mismatchService = createService({
      media: { findOne: vi.fn().mockReturnValue(chain(uploading)) },
      mediaGateway: {
        verifyUpload: vi.fn().mockResolvedValue({ objectRef: 'object-other' }),
      },
    });
    await expect(mismatchService.verifyMedia('media-verify-key-004', 'media-001', 1))
      .rejects.toMatchObject({ response: { code: 'CMS_MEDIA_OBJECT_MISMATCH' } });

    const conflictService = createService({
      media: {
        findOne: vi.fn().mockReturnValue(chain(uploading)),
        findOneAndUpdate: vi.fn().mockReturnValue(chain(null)),
      },
      mediaGateway: {
        verifyUpload: vi.fn().mockResolvedValue({
          objectRef: 'object-001',
          checksum: 'checksum',
          scanEvidenceId: 'scan',
          variants: {},
        }),
      },
    });
    await expect(conflictService.verifyMedia('media-verify-key-005', 'media-001', 1))
      .rejects.toMatchObject({ response: { code: 'CMS_VERSION_CONFLICT' } });
  });

  it('媒体列表只查询当前租户并返回受控投影', async () => {
    const record = {
      id: 'media-001',
      siteId: 'gaoq',
      fileName: 'hero.png',
      mimeType: 'image/png',
      sizeBytes: 1024,
      objectRef: 'object-001',
      status: 'ready',
      checksum: 'checksum',
      scanEvidenceId: 'scan',
      variants: {},
      altText: {},
      copyrightSource: '',
      version: 2,
      secret: 'forbidden',
    };
    const query = chain([record]);
    const media = { find: vi.fn().mockReturnValue(query) };
    const service = createService({ media });

    const result = await service.listMedia();
    expect(result.items[0]).not.toHaveProperty('secret');
    expect(media.find).toHaveBeenCalledWith({ tenantId: 'tenant-001' });
    expect(query.sort).toHaveBeenCalledWith({ createdAt: -1 });
  });

  it('AI 生成仅保存模型证据并保持 pending_review', async () => {
    const aiGateway = {
      generate: vi.fn().mockResolvedValue({
        modelId: 'model-001',
        promptVersion: 'prompt-v1',
        output: { title: '生成标题' },
      }),
    };
    const generations = { create: vi.fn().mockResolvedValue(undefined) };
    const service = createService({
      contents: { findOne: vi.fn().mockReturnValue(chain(contentRecord())) },
      aiGateway,
      generations,
    });

    await expect(service.generateAiDraft('ai-generate-key-001', 'content-001', {
      action: 'rewrite',
      targetLocale: 'zh-CN',
      instruction: '更简洁',
    })).resolves.toMatchObject({
      status: 'pending_review',
      modelId: 'model-001',
      promptVersion: 'prompt-v1',
    });
    expect(aiGateway.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'rewrite',
        targetLocale: 'zh-CN',
        instruction: '更简洁',
      }),
      'ai-generate-key-001',
    );
    expect(generations.create).toHaveBeenCalledWith(
      [expect.objectContaining({
        tenantId: 'tenant-001',
        actorId: 'actor-001',
        contentId: 'content-001',
        status: 'pending_review',
      })],
      { session: SESSION },
    );
  });

  it('AI 请求每项约束均失败关闭', async () => {
    const invalidValues: readonly unknown[] = [
      null,
      [],
      { action: 'rewrite', targetLocale: 'zh-CN', instruction: '', extra: true },
      { action: 'unknown', targetLocale: 'zh-CN', instruction: '' },
      { action: 'rewrite', targetLocale: 'fr', instruction: '' },
      { action: 'rewrite', targetLocale: 'zh-CN', instruction: 1 },
      { action: 'rewrite', targetLocale: 'zh-CN', instruction: 'a'.repeat(1001) },
    ];
    const service = createService({});

    for (const value of invalidValues) {
      await expect(service.generateAiDraft('ai-generate-key-002', 'content-001', value))
        .rejects.toMatchObject({ response: { code: 'CMS_AI_REQUEST_INVALID' } });
    }
  });

  it('AI 草稿必须由人工明确接受或拒绝且不可重复审核', async () => {
    const accepted = {
      id: 'generation-001',
      contentId: 'content-001',
      action: 'rewrite',
      status: 'accepted',
      modelId: 'model-001',
      promptVersion: 'prompt-v1',
      output: { title: '生成标题' },
    };
    const findOneAndUpdate = vi.fn()
      .mockReturnValueOnce(chain(accepted))
      .mockReturnValueOnce(chain(null));
    const service = createService({ generations: { findOneAndUpdate } });

    await expect(service.reviewAiDraft(
      'ai-review-key-001', 'generation-001', 'accepted',
    )).resolves.toEqual(accepted);
    await expect(service.reviewAiDraft('ai-review-key-002', 'generation-001', 'rejected'))
      .rejects.toMatchObject({ response: { code: 'CMS_AI_REVIEW_CONFLICT' } });
  });
});

function createService(overrides: Record<string, unknown>): MarketingCmsService {
  const context = {
    getTenantRequired: () => ({ tenantId: 'tenant-001' }),
    getActorRequired: () => ({ actorId: 'actor-001', traceId: 'trace-001' }),
    getRequired: () => ({
      tenant: { tenantId: 'tenant-001' },
      actor: { actorId: 'actor-001', traceId: 'trace-001' },
    }),
  };
  const idempotency = {
    execute: vi.fn(async (
      _operation: string,
      _key: string,
      _input: unknown,
      work: (session: typeof SESSION) => Promise<unknown>,
    ) => work(SESSION)),
    executeWithEphemeralResult: vi.fn(async (
      _operation: string,
      _key: string,
      _input: unknown,
      work: (
        session: typeof SESSION,
      ) => Promise<{ readonly stored: unknown; readonly result: unknown }>,
    ) => (await work(SESSION)).result),
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
    (overrides.media ?? {}) as never,
    (overrides.generations ?? {}) as never,
    (overrides.outbox ?? {}) as never,
    context as never,
    (overrides.idempotency ?? idempotency) as never,
    config as never,
    (overrides.leadCrypto ?? {
      blindIndex: vi.fn().mockReturnValue('d'.repeat(43)),
      protect: vi.fn().mockReturnValue({
        iv: 'i'.repeat(16),
        ciphertext: 'ciphertext',
        authTag: 'a'.repeat(22),
      }),
      unprotect: vi.fn().mockReturnValue('contact@example.com'),
    }) as never,
    (overrides.mediaGateway ?? {}) as never,
    (overrides.aiGateway ?? {}) as never,
  );
}
