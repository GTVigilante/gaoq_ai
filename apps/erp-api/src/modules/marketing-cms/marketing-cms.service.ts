import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import { randomUUID } from 'node:crypto';
import type { ClientSession, Model } from 'mongoose';
import type { Queue } from 'bullmq';
import type { AppEnvironment } from '../../config/environment.js';
import { IdempotencyService } from '../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { OutboxRecord } from '../org/persistence/outbox.schema.js';
import {
  MarketingContentRecord,
  MarketingContentRevisionRecord,
  MarketingLeadRecord,
  MarketingMediaRecord,
  MarketingAiGenerationRecord,
  type MarketingContentDocument,
} from './marketing-cms.schemas.js';
import {
  MARKETING_CONTENT_TYPES,
  MARKETING_LOCALES,
  MARKETING_PUBLISHED_EVENT_TYPE,
  type MarketingContentType,
  type MarketingLocale,
  type MarketingStatus,
  parseContentInput,
} from './marketing-cms.types.js';
import { MarketingLeadCryptoService } from './marketing-lead-crypto.service.js';
import { MarketingAiGateway, MarketingMediaGateway } from './marketing-gateways.service.js';
import {
  MARKETING_NOTIFICATION_QUEUE,
  type MarketingNotificationJob,
} from './marketing-notification.queue.js';
import {
  MARKETING_AUTOMATION_QUEUE,
  type MarketingPublishJob,
} from './marketing-automation.queue.js';

export type MarketingContentView = Readonly<Record<string, unknown>>;
const TRANSITIONS: Readonly<Record<MarketingStatus, readonly MarketingStatus[]>> = {
  draft: ['in_review'], in_review: ['draft', 'approved'], approved: ['draft', 'published', 'scheduled'],
  scheduled: ['draft', 'published'], published: ['archived'], archived: ['draft'],
};

@Injectable()
export class MarketingCmsService {
  private readonly logger = new Logger(MarketingCmsService.name);

  constructor(
    @InjectModel(MarketingContentRecord.name) private readonly contents: Model<MarketingContentRecord>,
    @InjectModel(MarketingContentRevisionRecord.name)
    private readonly revisions: Model<MarketingContentRevisionRecord>,
    @InjectModel(MarketingLeadRecord.name) private readonly leads: Model<MarketingLeadRecord>,
    @InjectModel(MarketingMediaRecord.name) private readonly media: Model<MarketingMediaRecord>,
    @InjectModel(MarketingAiGenerationRecord.name)
    private readonly generations: Model<MarketingAiGenerationRecord>,
    @InjectModel(OutboxRecord.name) private readonly outbox: Model<OutboxRecord>,
    private readonly context: TenantContextService,
    private readonly idempotency: IdempotencyService,
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly leadCrypto: MarketingLeadCryptoService,
    private readonly mediaGateway: MarketingMediaGateway,
    private readonly aiGateway: MarketingAiGateway,
    @InjectQueue(MARKETING_NOTIFICATION_QUEUE)
    private readonly notificationQueue: Queue<MarketingNotificationJob>,
    @InjectQueue(MARKETING_AUTOMATION_QUEUE)
    private readonly automationQueue: Queue<MarketingPublishJob>,
  ) {}

  async create(key: string, raw: unknown): Promise<{ readonly content: MarketingContentView }> {
    const input = parseContentInput(raw);
    return this.idempotency.execute('marketing.content.create', key, input, async (session) => {
      const trusted = this.context.getRequired();
      await this.assertMediaReady(input, trusted.tenant.tenantId, session);
      const record = {
        id: randomUUID(), tenantId: trusted.tenant.tenantId, ...input,
        blocks: [...input.blocks], summary: input.summary ?? '', seo: { ...(input.seo ?? {}) }, status: 'draft' as const,
        revision: 1, version: 1, publishedAt: null, scheduledAt: null,
        updatedBy: trusted.actor.actorId,
      };
      await this.contents.create([record], { session });
      await this.snapshot(record, session);
      return { content: view(record) };
    });
  }

  async list(): Promise<{ readonly items: readonly MarketingContentView[] }> {
    const tenantId = this.context.getTenantRequired().tenantId;
    const items = await this.contents.find({ tenantId }).sort({ updatedAt: -1 }).lean().exec();
    return { items: items.map((item) => view(item)) };
  }

  async get(id: string): Promise<MarketingContentView> {
    const record = await this.owned(id);
    return view(record);
  }

  async update(
    id: string, expectedVersion: number, key: string, raw: unknown,
  ): Promise<{ readonly content: MarketingContentView }> {
    const input = parseContentInput(raw);
    return this.idempotency.execute('marketing.content.update', key, { id, expectedVersion, input }, async (session) => {
      const current = await this.owned(id, session);
      await this.assertMediaReady(input, current.tenantId, session);
      if (current.version !== expectedVersion) throw versionConflict();
      if (!['draft', 'in_review', 'approved'].includes(current.status)) {
        throw new ConflictException({ code: 'CMS_CONTENT_IMMUTABLE', message: '当前状态不可编辑' });
      }
      const actor = this.context.getActorRequired();
      const next = await this.contents.findOneAndUpdate(
        { tenantId: current.tenantId, id, version: expectedVersion },
        { $set: { ...input, summary: input.summary ?? '', seo: input.seo ?? {}, status: 'draft', updatedBy: actor.actorId },
          $inc: { version: 1, revision: 1 } },
        { returnDocument: 'after', session, lean: true },
      ).exec();
      if (next === null) throw versionConflict();
      await this.snapshot(next, session);
      return { content: view(next) };
    });
  }

  async transition(
    id: string, expectedVersion: number, key: string, target: MarketingStatus,
  ): Promise<{ readonly content: MarketingContentView }> {
    return this.idempotency.execute(`marketing.content.${target}`, key, { id, expectedVersion }, async (session) => {
      const current = await this.owned(id, session);
      if (current.version !== expectedVersion) throw versionConflict();
      if (!TRANSITIONS[current.status].includes(target)) {
        throw new ConflictException({ code: 'CMS_STATUS_TRANSITION_INVALID', message: '内容状态迁移不合法' });
      }
      const now = new Date();
      const next = await this.contents.findOneAndUpdate(
        { tenantId: current.tenantId, id, version: expectedVersion },
        { $set: {
          status: target,
          publishedAt: target === 'published' ? now : current.publishedAt,
          updatedBy: this.context.getActorRequired().actorId,
        }, $inc: { version: 1, revision: 1 } },
        { returnDocument: 'after', session, lean: true },
      ).exec();
      if (next === null) throw versionConflict();
      await this.snapshot(next, session);
      if (target === 'published') await this.publishEvent(view(next), session, now);
      return { content: view(next) };
    });
  }

  async schedule(
    id: string,
    expectedVersion: number,
    key: string,
    scheduledAtValue: string,
  ): Promise<{ readonly content: MarketingContentView }> {
    const scheduledAt = new Date(scheduledAtValue);
    const now = Date.now();
    if (
      Number.isNaN(scheduledAt.getTime()) ||
      scheduledAt.getTime() < now + 60_000 ||
      scheduledAt.getTime() > now + 366 * 86_400_000
    ) throw new BadRequestException({
      code: 'CMS_SCHEDULE_TIME_INVALID',
      message: '发布时间必须在 1 分钟至 366 天内',
    });
    const result = await this.idempotency.execute(
      'marketing.content.schedule', key, { id, expectedVersion, scheduledAt: scheduledAt.toISOString() },
      async (session) => {
        const current = await this.owned(id, session);
        if (current.version !== expectedVersion) throw versionConflict();
        if (current.status !== 'approved') throw new ConflictException({
          code: 'CMS_STATUS_TRANSITION_INVALID', message: '只有已批准内容可以排期',
        });
        const next = await this.contents.findOneAndUpdate(
          { tenantId: current.tenantId, id, version: expectedVersion, status: 'approved' },
          {
            $set: {
              status: 'scheduled', scheduledAt,
              updatedBy: this.context.getActorRequired().actorId,
            },
            $inc: { version: 1, revision: 1 },
          },
          { returnDocument: 'after', session, lean: true },
        ).exec();
        if (next === null) throw versionConflict();
        await this.snapshot(next, session);
        return { content: view(next) };
      },
    );
    const content = result.content;
    try {
      await this.automationQueue.add(
        'publish:scheduled',
        { tenantId: String(content.tenantId), contentId: id },
        {
          jobId: `${String(content.tenantId)}:${id}:${String(content.revision)}`,
          delay: Math.max(0, scheduledAt.getTime() - Date.now()),
          attempts: 5,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: 1_000,
          removeOnFail: 5_000,
        },
      );
    } catch {
      this.logger.error({ code: 'MARKETING_SCHEDULE_ENQUEUE_FAILED', contentId: id });
    }
    return result;
  }

  async publicContent(
    locale: string, type: string, slug: string,
  ): Promise<MarketingContentView> {
    if (
      !MARKETING_LOCALES.includes(locale as MarketingLocale) ||
      !MARKETING_CONTENT_TYPES.includes(type as MarketingContentType)
    ) throw new BadRequestException({ code: 'CMS_PUBLIC_QUERY_INVALID', message: '公开内容查询参数无效' });
    const filter = {
      tenantId: this.publicTenantId(), siteId: this.publicSiteId(), locale, type, slug, status: 'published',
    } as never;
    const record = await this.contents.findOne(filter).lean().exec();
    if (record === null) throw new NotFoundException({
      code: 'CMS_PUBLIC_CONTENT_NOT_FOUND', message: '内容不存在',
    });
    return view(record, true);
  }

  async publicList(locale: string, type: string): Promise<{ readonly items: readonly MarketingContentView[] }> {
    if (
      !MARKETING_LOCALES.includes(locale as MarketingLocale) ||
      !MARKETING_CONTENT_TYPES.includes(type as MarketingContentType)
    ) throw new BadRequestException({ code: 'CMS_PUBLIC_QUERY_INVALID', message: '公开内容查询参数无效' });
    const filter = {
      tenantId: this.publicTenantId(), siteId: this.publicSiteId(), locale, type, status: 'published',
    } as never;
    const items = await this.contents.find(filter).sort({ publishedAt: -1 }).lean().exec();
    return { items: items.map((item) => view(item, true)) };
  }

  async submitLead(raw: unknown): Promise<{
    readonly leadId: string;
    readonly duplicate: boolean;
  }> {
    const input = parseLead(raw);
    const tenantId = this.publicTenantId();
    const id = randomUUID();
    const dedupeDigest = this.leadCrypto.blindIndex(tenantId, input.contact);
    const duplicate = await this.leads.findOne({
      tenantId, dedupeDigest,
      createdAt: { $gte: new Date(Date.now() - 30 * 86_400_000) },
      status: { $ne: 'closed' },
    }).select('id').lean().exec();
    if (duplicate !== null) return { leadId: duplicate.id, duplicate: true };
    const protectedContact = this.leadCrypto.protect(tenantId, id, input.contact);
    await this.leads.create({
      id, tenantId, siteId: this.publicSiteId(), audience: input.audience,
      name: input.name, requestSummary: input.requestSummary, attribution: input.attribution,
      contactIv: protectedContact.iv, contactCiphertext: protectedContact.ciphertext,
      contactAuthTag: protectedContact.authTag, dedupeDigest,
      consentedAt: new Date(), status: 'new',
    });
    const notifications = await Promise.allSettled((['email', 'feishu'] as const).map(
      (channel) => this.notificationQueue.add(
        `lead:${channel}`,
        { tenantId, leadId: id, channel },
        {
          jobId: `${tenantId}:${id}:${channel}`,
          attempts: 6,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: 1_000,
          removeOnFail: 5_000,
        },
      ),
    ));
    if (notifications.some((result) => result.status === 'rejected')) {
      this.logger.error({ code: 'MARKETING_NOTIFICATION_ENQUEUE_FAILED', leadId: id });
    }
    return { leadId: id, duplicate: false };
  }

  async revisionsFor(id: string): Promise<{ readonly items: readonly Record<string, unknown>[] }> {
    await this.owned(id);
    const tenantId = this.context.getTenantRequired().tenantId;
    const items = await this.revisions.find({ tenantId, contentId: id })
      .sort({ revision: -1 }).lean().exec();
    return { items: items.map((item) => ({
      revision: item.revision, actorId: item.actorId, createdAt: item.createdAt,
      snapshot: item.snapshot,
    })) };
  }

  async rollback(
    id: string,
    revision: number,
    expectedVersion: number,
    key: string,
  ): Promise<{ readonly content: MarketingContentView }> {
    return this.idempotency.execute(
      'marketing.content.rollback', key, { id, revision, expectedVersion },
      async (session) => {
        const current = await this.owned(id, session);
        if (current.version !== expectedVersion) throw versionConflict();
        const source = await this.revisions.findOne({
          tenantId: current.tenantId, contentId: id, revision,
        }).session(session).lean().exec();
        if (source === null) throw new NotFoundException({
          code: 'CMS_REVISION_NOT_FOUND', message: '历史版本不存在',
        });
        const input = snapshotContentInput(source.snapshot);
        const next = await this.contents.findOneAndUpdate(
          { tenantId: current.tenantId, id, version: expectedVersion },
          {
            $set: {
              ...input, blocks: [...input.blocks], seo: { ...(input.seo ?? {}) },
              summary: input.summary ?? '', status: 'draft', publishedAt: current.publishedAt,
              scheduledAt: null, updatedBy: this.context.getActorRequired().actorId,
            },
            $inc: { version: 1, revision: 1 },
          },
          { returnDocument: 'after', session, lean: true },
        ).exec();
        if (next === null) throw versionConflict();
        await this.snapshot(next, session);
        return { content: view(next) };
      },
    );
  }

  async listLeads(): Promise<{ readonly items: readonly Record<string, unknown>[] }> {
    const tenantId = this.context.getTenantRequired().tenantId;
    const records = await this.leads.find({ tenantId })
      .select('+contactIv +contactCiphertext +contactAuthTag')
      .sort({ createdAt: -1 }).limit(500).lean().exec();
    return { items: records.map((record) => ({
      id: record.id, audience: record.audience, name: record.name,
      contact: this.leadCrypto.unprotect(tenantId, record.id, {
        iv: record.contactIv, ciphertext: record.contactCiphertext, authTag: record.contactAuthTag,
      }),
      requestSummary: record.requestSummary, status: record.status,
      attribution: record.attribution, consentedAt: record.consentedAt,
      assigneeId: record.assigneeId, notes: record.notes,
      version: record.version, createdAt: record.createdAt,
    })) };
  }

  async exportLeadsCsv(): Promise<string> {
    const { items } = await this.listLeads();
    const headers = ['id', 'audience', 'name', 'contact', 'status', 'assigneeId', 'requestSummary', 'createdAt'];
    const rows = items.map((item) => headers.map((header) => csvCell(item[header])).join(','));
    return `\uFEFF${headers.join(',')}\n${rows.join('\n')}\n`;
  }

  async updateLeadStatus(
    id: string,
    status: string,
    expectedVersion: number,
  ): Promise<Record<string, unknown>> {
    const allowed = ['new', 'contacted', 'qualified', 'unqualified', 'converted', 'closed'];
    if (!allowed.includes(status)) throw new BadRequestException({
      code: 'MARKETING_LEAD_STATUS_INVALID', message: '线索状态无效',
    });
    const tenantId = this.context.getTenantRequired().tenantId;
    const record = await this.leads.findOneAndUpdate(
      { tenantId, id, version: expectedVersion },
      { $set: { status }, $inc: { version: 1 } },
      { returnDocument: 'after', lean: true },
    ).exec();
    if (record === null) throw versionConflict();
    return { id: record.id, status: record.status, version: record.version };
  }

  async assignLead(id: string, assigneeId: string, expectedVersion: number) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(assigneeId)) throw new BadRequestException({
      code: 'MARKETING_LEAD_ASSIGNEE_INVALID', message: '负责人标识无效',
    });
    const tenantId = this.context.getTenantRequired().tenantId;
    const record = await this.leads.findOneAndUpdate(
      { tenantId, id, version: expectedVersion },
      { $set: { assigneeId }, $inc: { version: 1 } },
      { returnDocument: 'after', lean: true },
    ).exec();
    if (record === null) throw versionConflict();
    return { id: record.id, assigneeId: record.assigneeId, version: record.version };
  }

  async addLeadNote(id: string, body: string, expectedVersion: number) {
    if (body.trim().length < 1 || body.length > 2000) throw new BadRequestException({
      code: 'MARKETING_LEAD_NOTE_INVALID', message: '跟进备注不符合要求',
    });
    const tenantId = this.context.getTenantRequired().tenantId;
    const note = {
      actorId: this.context.getActorRequired().actorId,
      body: body.trim(),
      createdAt: new Date().toISOString(),
    };
    const record = await this.leads.findOneAndUpdate(
      { tenantId, id, version: expectedVersion },
      { $push: { notes: { $each: [note], $slice: -100 } }, $inc: { version: 1 } },
      { returnDocument: 'after', lean: true },
    ).exec();
    if (record === null) throw versionConflict();
    return { id: record.id, note, version: record.version };
  }

  async createMediaUpload(raw: unknown): Promise<Record<string, unknown>> {
    const input = parseMediaInput(raw);
    const trusted = this.context.getRequired();
    const id = randomUUID();
    const ticket = await this.mediaGateway.createUpload({
      tenantId: trusted.tenant.tenantId, siteId: input.siteId, mediaId: id,
      fileName: input.fileName, mimeType: input.mimeType, sizeBytes: input.sizeBytes,
    });
    await this.media.create({
      id, tenantId: trusted.tenant.tenantId, siteId: input.siteId,
      fileName: input.fileName, mimeType: input.mimeType, sizeBytes: input.sizeBytes,
      objectRef: ticket.objectRef, status: 'uploading', checksum: null,
      scanEvidenceId: null, variants: {}, altText: input.altText,
      copyrightSource: input.copyrightSource, version: 1,
    });
    return { id, uploadUrl: ticket.uploadUrl, expiresAt: ticket.expiresAt, version: 1 };
  }

  async verifyMedia(id: string, expectedVersion: number): Promise<Record<string, unknown>> {
    const tenantId = this.context.getTenantRequired().tenantId;
    const record = await this.media.findOne({ tenantId, id }).lean().exec();
    if (record === null) throw new NotFoundException({ code: 'CMS_MEDIA_NOT_FOUND', message: '媒体不存在' });
    if (record.version !== expectedVersion || record.status !== 'uploading') throw versionConflict();
    const receipt = await this.mediaGateway.verifyUpload({
      tenantId, mediaId: id, objectRef: record.objectRef,
    });
    if (receipt.objectRef !== record.objectRef) throw new ConflictException({
      code: 'CMS_MEDIA_OBJECT_MISMATCH', message: '媒体对象回执不匹配',
    });
    const next = await this.media.findOneAndUpdate(
      { tenantId, id, version: expectedVersion, status: 'uploading' },
      { $set: {
        status: 'ready', checksum: receipt.checksum,
        scanEvidenceId: receipt.scanEvidenceId, variants: receipt.variants,
      }, $inc: { version: 1 } },
      { returnDocument: 'after', lean: true },
    ).exec();
    if (next === null) throw versionConflict();
    return mediaView(next);
  }

  async listMedia(): Promise<{ readonly items: readonly Record<string, unknown>[] }> {
    const tenantId = this.context.getTenantRequired().tenantId;
    const items = await this.media.find({ tenantId }).sort({ createdAt: -1 }).lean().exec();
    return { items: items.map(mediaView) };
  }

  async generateAiDraft(contentId: string, raw: unknown): Promise<Record<string, unknown>> {
    const input = parseAiInput(raw);
    const content = await this.owned(contentId);
    const trusted = this.context.getRequired();
    const result = await this.aiGateway.generate({
      action: input.action, targetLocale: input.targetLocale,
      content: view(content, true), instruction: input.instruction,
    });
    const id = randomUUID();
    await this.generations.create({
      id, tenantId: trusted.tenant.tenantId, actorId: trusted.actor.actorId,
      contentId, action: input.action, modelId: result.modelId,
      promptVersion: result.promptVersion, output: result.output, status: 'pending_review',
    });
    return { id, status: 'pending_review', ...result };
  }

  async reviewAiDraft(
    id: string,
    decision: 'accepted' | 'rejected',
  ): Promise<Record<string, unknown>> {
    const tenantId = this.context.getTenantRequired().tenantId;
    const record = await this.generations.findOneAndUpdate(
      { tenantId, id, status: 'pending_review' },
      { $set: { status: decision } },
      { returnDocument: 'after', lean: true },
    ).exec();
    if (record === null) throw new ConflictException({
      code: 'CMS_AI_REVIEW_CONFLICT', message: 'AI 草稿不存在或已完成审核',
    });
    return {
      id: record.id, contentId: record.contentId, action: record.action,
      status: record.status, modelId: record.modelId,
      promptVersion: record.promptVersion, output: record.output,
    };
  }

  private async owned(id: string, session?: ClientSession): Promise<MarketingContentDocument> {
    const tenantId = this.context.getTenantRequired().tenantId;
    const query = this.contents.findOne({ tenantId, id });
    if (session !== undefined) query.session(session);
    const record = await query.exec();
    if (record === null) throw new NotFoundException({ code: 'CMS_CONTENT_NOT_FOUND', message: '内容不存在' });
    return record;
  }

  private async assertMediaReady(
    input: ReturnType<typeof parseContentInput>,
    tenantId: string,
    session: ClientSession,
  ): Promise<void> {
    const ids = [...collectMediaIds({ blocks: input.blocks, seo: input.seo ?? {} })];
    if (ids.length === 0) return;
    const count = await this.media.countDocuments({
      tenantId, id: { $in: ids }, status: 'ready',
    }).session(session).exec();
    if (count !== ids.length) throw new ConflictException({
      code: 'CMS_MEDIA_NOT_READY',
      message: '内容引用的媒体不存在、跨租户或尚未通过安全扫描',
    });
  }

  private async snapshot(record: object, session: ClientSession): Promise<void> {
    const value = view(record);
    await this.revisions.create([{
      tenantId: String(value.tenantId), contentId: String(value.id), revision: Number(value.revision),
      snapshot: value, actorId: this.context.getActorRequired().actorId,
    }], { session });
  }

  private async publishEvent(record: Record<string, unknown>, session: ClientSession, now: Date): Promise<void> {
    const eventId = createEventId(now);
    const eventType = MARKETING_PUBLISHED_EVENT_TYPE;
    const data = {
      siteId: record.siteId, contentId: record.id, contentType: record.type,
      locale: record.locale, slug: record.slug, revision: record.revision,
    };
    await this.outbox.create([{
      eventId, tenantId: record.tenantId, aggregateType: 'marketing.content',
      aggregateId: record.id, aggregateVersion: record.version, eventType,
      envelope: {
        specversion: '1.0', id: eventId, source: '//gaoq-erp/marketing-cms',
        type: eventType, subject: `tenant/${String(record.tenantId)}/marketing.content/${String(record.id)}`,
        time: now.toISOString(), datacontenttype: 'application/json',
        tenantId: record.tenantId, traceId: this.context.getActorRequired().traceId,
        idempotencyKey: `${String(record.tenantId)}:${eventType}:${String(record.id)}:${String(record.version)}`,
        schemaVersion: '1', data,
      },
      status: 'pending', attempts: 0, nextAttemptAt: now,
    } as unknown as OutboxRecord], { session });
  }

  private publicTenantId(): string {
    return this.config.get('MARKETING_PUBLIC_TENANT_ID', { infer: true });
  }

  private publicSiteId(): string {
    return this.config.get('MARKETING_PUBLIC_SITE_ID', { infer: true });
  }
}

function view(record: Record<string, unknown> | object, publicOnly = false): MarketingContentView {
  const source = typeof (record as { toObject?: unknown }).toObject === 'function'
    ? (record as { toObject: () => Record<string, unknown> }).toObject()
    : record as Record<string, unknown>;
  const result = {
    id: source.id, tenantId: source.tenantId, siteId: source.siteId, type: source.type,
    locale: source.locale, slug: source.slug, title: source.title, summary: source.summary,
    blocks: source.blocks, seo: source.seo, status: source.status, revision: source.revision,
    version: source.version, publishedAt: source.publishedAt ?? null,
    scheduledAt: source.scheduledAt ?? null,
  };
  if (publicOnly) {
    return Object.freeze({
      id: result.id, siteId: result.siteId, type: result.type, locale: result.locale,
      slug: result.slug, title: result.title, summary: result.summary, blocks: result.blocks,
      seo: result.seo, revision: result.revision, publishedAt: result.publishedAt,
    });
  }
  return Object.freeze(result);
}

function parseLead(value: unknown): {
  audience: 'creator' | 'brand'; name: string; contact: string; requestSummary: string;
  attribution: Record<string, string>;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw leadInvalid();
  const record = value as Record<string, unknown>;
  const allowed = new Set(['audience', 'name', 'contact', 'requestSummary', 'privacyAccepted', 'website', 'utmSource', 'utmCampaign']);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) || record.website !== '' ||
    !['creator', 'brand'].includes(String(record.audience)) ||
    typeof record.name !== 'string' || record.name.length < 1 || record.name.length > 100 ||
    typeof record.contact !== 'string' || record.contact.length < 5 || record.contact.length > 254 ||
    typeof record.requestSummary !== 'string' || record.requestSummary.length < 10 ||
    record.requestSummary.length > 2000 || record.privacyAccepted !== true ||
    /<\s*script|javascript:|on[a-z]+\s*=/iu.test(JSON.stringify(record))
  ) throw leadInvalid();
  return {
    audience: record.audience as 'creator' | 'brand', name: record.name.trim(),
    contact: record.contact.trim(), requestSummary: record.requestSummary.trim(),
    attribution: Object.fromEntries(
      [['utmSource', record.utmSource], ['utmCampaign', record.utmCampaign]]
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length <= 128),
    ),
  };
}

function snapshotContentInput(value: Record<string, unknown>) {
  return parseContentInput({
    siteId: value.siteId,
    type: value.type,
    locale: value.locale,
    slug: value.slug,
    title: value.title,
    summary: value.summary,
    blocks: value.blocks,
    seo: value.seo,
  });
}

function parseMediaInput(value: unknown): {
  siteId: string; fileName: string; mimeType: string; sizeBytes: number;
  altText: Record<string, string>; copyrightSource: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw mediaInvalid();
  const record = value as Record<string, unknown>;
  const allowed = new Set(['siteId', 'fileName', 'mimeType', 'sizeBytes', 'altText', 'copyrightSource']);
  const mime = typeof record.mimeType === 'string' ? record.mimeType : '';
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    typeof record.siteId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(record.siteId) ||
    typeof record.fileName !== 'string' || !/^[^/\\\0]{1,180}$/u.test(record.fileName) ||
    !['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'application/pdf'].includes(mime) ||
    typeof record.sizeBytes !== 'number' || !Number.isSafeInteger(record.sizeBytes) ||
    record.sizeBytes < 1 || record.sizeBytes > 20_971_520 ||
    typeof record.altText !== 'object' || record.altText === null || Array.isArray(record.altText) ||
    typeof record.copyrightSource !== 'string' || record.copyrightSource.length > 500
  ) throw mediaInvalid();
  const altText = record.altText as Record<string, unknown>;
  if (
    Object.keys(altText).some((key) => key !== 'zh-CN' && key !== 'en') ||
    Object.values(altText).some((item) => typeof item !== 'string' || item.length > 500)
  ) throw mediaInvalid();
  return {
    siteId: record.siteId, fileName: record.fileName, mimeType: mime,
    sizeBytes: record.sizeBytes, altText: altText as Record<string, string>,
    copyrightSource: record.copyrightSource,
  };
}

function parseAiInput(value: unknown): {
  action: 'translate' | 'rewrite' | 'outline' | 'seo' | 'alt_text';
  targetLocale: 'zh-CN' | 'en';
  instruction: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw aiInvalid();
  const record = value as Record<string, unknown>;
  const actions = ['translate', 'rewrite', 'outline', 'seo', 'alt_text'];
  if (
    Object.keys(record).some((key) => !['action', 'targetLocale', 'instruction'].includes(key)) ||
    !actions.includes(String(record.action)) ||
    !['zh-CN', 'en'].includes(String(record.targetLocale)) ||
    typeof record.instruction !== 'string' || record.instruction.length > 1000
  ) throw aiInvalid();
  return {
    action: record.action as 'translate' | 'rewrite' | 'outline' | 'seo' | 'alt_text',
    targetLocale: record.targetLocale as 'zh-CN' | 'en',
    instruction: record.instruction,
  };
}

function mediaView(record: MarketingMediaRecord): Record<string, unknown> {
  return {
    id: record.id, siteId: record.siteId, fileName: record.fileName,
    mimeType: record.mimeType, sizeBytes: record.sizeBytes, objectRef: record.objectRef,
    status: record.status, checksum: record.checksum, scanEvidenceId: record.scanEvidenceId,
    variants: record.variants, altText: record.altText,
    copyrightSource: record.copyrightSource, version: record.version,
  };
}

function leadInvalid(): BadRequestException {
  return new BadRequestException({ code: 'MARKETING_LEAD_INVALID', message: '预约信息不符合要求' });
}

function mediaInvalid(): BadRequestException {
  return new BadRequestException({ code: 'CMS_MEDIA_INVALID', message: '媒体元数据不符合要求' });
}

function aiInvalid(): BadRequestException {
  return new BadRequestException({ code: 'CMS_AI_REQUEST_INVALID', message: 'AI 辅助请求不符合要求' });
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' :
    typeof value === 'object' ? JSON.stringify(value) :
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value) : '';
  if (/^[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function collectMediaIds(value: unknown, result = new Set<string>(), depth = 0): Set<string> {
  if (depth > 12 || value === null || typeof value !== 'object') return result;
  if (Array.isArray(value)) {
    for (const item of value) collectMediaIds(item, result, depth + 1);
    return result;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'mediaId' && typeof item === 'string') result.add(item);
    else collectMediaIds(item, result, depth + 1);
  }
  return result;
}

function versionConflict(): ConflictException {
  return new ConflictException({ code: 'CMS_VERSION_CONFLICT', message: '内容版本已更新，请刷新后重试' });
}
