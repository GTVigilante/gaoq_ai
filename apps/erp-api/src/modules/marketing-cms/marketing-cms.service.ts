import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import { createHash, randomUUID } from 'node:crypto';
import type { ClientSession, Connection, Model } from 'mongoose';
import type { AppEnvironment } from '../../config/environment.js';
import {
  marketingAiDraftRequestSchema,
  marketingLeadInputRequestSchema,
  marketingMediaUploadRequestSchema,
} from '../../contracts/rest-request-contracts.js';
import { IdempotencyService } from '../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { OutboxRecord } from '../org/persistence/outbox.schema.js';
import {
  MarketingContentRecord,
  MarketingContentRevisionRecord,
  MarketingLeadRecord,
  MarketingSideEffectRecord,
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
import {
  MarketingAiGateway,
  MarketingMediaGateway,
  safeMarketingAiOutput,
} from './marketing-gateways.service.js';

export type MarketingContentView = Readonly<Record<string, unknown>>;
const TRANSITIONS: Readonly<Record<MarketingStatus, readonly MarketingStatus[]>> = {
  draft: ['in_review'], in_review: ['draft', 'approved'], approved: ['draft', 'published', 'scheduled'],
  scheduled: ['draft', 'published'], published: ['archived'], archived: ['draft'],
};
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/u;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PUBLIC_SLUG = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*)$/u;
const PUBLIC_DANGEROUS =
  /<\s*(?:script|iframe|object|embed|style)|javascript:|vbscript:|data:text\/html|on[a-z]+\s*=|expression\s*\(/iu;
const PUBLIC_CONTENT_SUMMARY_FIELDS =
  'id siteId type locale slug title summary revision publishedAt';
const PUBLIC_CONTENT_DETAIL_FIELDS =
  'id siteId type locale slug title summary blocks seo revision publishedAt';
const DUPLICATE_KEY_CODE = 11000;

@Injectable()
export class MarketingCmsService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(MarketingContentRecord.name) private readonly contents: Model<MarketingContentRecord>,
    @InjectModel(MarketingContentRevisionRecord.name)
    private readonly revisions: Model<MarketingContentRevisionRecord>,
    @InjectModel(MarketingLeadRecord.name) private readonly leads: Model<MarketingLeadRecord>,
    @InjectModel(MarketingSideEffectRecord.name)
    private readonly sideEffects: Model<MarketingSideEffectRecord>,
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
          scheduledAt:
            current.status === 'scheduled' &&
              (target === 'draft' || target === 'published')
              ? null
              : current.scheduledAt,
          updatedBy: this.context.getActorRequired().actorId,
        }, $inc: { version: 1, revision: 1 } },
        { returnDocument: 'after', session, lean: true },
      ).exec();
      if (next === null) throw versionConflict();
      if (
        current.status === 'scheduled' &&
        (target === 'draft' || target === 'published')
      ) {
        await this.cancelScheduledSideEffect(current, session, now);
      }
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
        await this.sideEffects.create([{
          eventId: createEventId(),
          tenantId: next.tenantId,
          kind: 'scheduled_publish',
          aggregateId: next.id,
          aggregateVersion: next.version,
          channel: null,
          dueAt: scheduledAt,
          status: 'pending',
          attempts: 0,
          nextAttemptAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          dispatchedAt: null,
          deliveryAttempts: 0,
          completedAt: null,
          lastErrorCode: null,
        }], { session });
        return { content: view(next) };
      },
    );
    return result;
  }

  async publicContent(
    locale: string, type: string, slug: string,
  ): Promise<MarketingContentView> {
    if (
      !MARKETING_LOCALES.includes(locale as MarketingLocale) ||
      !MARKETING_CONTENT_TYPES.includes(type as MarketingContentType) ||
      !PUBLIC_SLUG.test(slug)
    ) throw new BadRequestException({ code: 'CMS_PUBLIC_QUERY_INVALID', message: '公开内容查询参数无效' });
    const filter = {
      tenantId: this.publicTenantId(), siteId: this.publicSiteId(), locale, type, slug, status: 'published',
    } as never;
    const record = await this.contents.findOne(filter)
      .select(PUBLIC_CONTENT_DETAIL_FIELDS).lean().exec();
    if (record === null) throw new NotFoundException({
      code: 'CMS_PUBLIC_CONTENT_NOT_FOUND', message: '内容不存在',
    });
    return marketingPublishedContentView(record, {
      siteId: this.publicSiteId(),
      locale: locale as MarketingLocale,
      type: type as MarketingContentType,
      slug,
    });
  }

  async publicList(locale: string, type: string): Promise<{ readonly items: readonly MarketingContentView[] }> {
    if (
      !MARKETING_LOCALES.includes(locale as MarketingLocale) ||
      !MARKETING_CONTENT_TYPES.includes(type as MarketingContentType)
    ) throw new BadRequestException({ code: 'CMS_PUBLIC_QUERY_INVALID', message: '公开内容查询参数无效' });
    const filter = {
      tenantId: this.publicTenantId(), siteId: this.publicSiteId(), locale, type, status: 'published',
    } as never;
    const items = await this.contents.find(filter)
      .select(PUBLIC_CONTENT_SUMMARY_FIELDS)
      .sort({ publishedAt: -1 })
      .limit(500)
      .lean()
      .exec();
    const expected = {
      siteId: this.publicSiteId(),
      locale: locale as MarketingLocale,
      type: type as MarketingContentType,
    };
    return {
      items: Object.freeze(items.map((item) =>
        marketingPublishedContentSummaryView(item, expected))),
    };
  }

  async submitLead(idempotencyKey: string, raw: unknown): Promise<{
    readonly leadId: string;
    readonly duplicate: boolean;
  }> {
    assertIdempotencyKey(idempotencyKey);
    const input = parseLead(raw);
    const tenantId = this.publicTenantId();
    const id = stableId('lead', tenantId, idempotencyKey);
    const dedupeDigest = this.leadCrypto.blindIndex(tenantId, input.contact);
    try {
      return await this.connection.transaction(async (session) => {
        const sameKey = await this.leads.findOne({ tenantId, id })
          .select('id audience name requestSummary attribution dedupeDigest')
          .session(session).lean().exec();
        if (sameKey !== null) {
          assertSameLeadSubmission(sameKey, input, dedupeDigest);
          return { leadId: sameKey.id, duplicate: true };
        }
        const duplicate = await this.leads.findOne({
          tenantId, dedupeDigest,
          createdAt: { $gte: new Date(Date.now() - 30 * 86_400_000) },
          status: { $ne: 'closed' },
        }).select('id').session(session).lean().exec();
        if (duplicate !== null) return { leadId: duplicate.id, duplicate: true };
        const protectedContact = this.leadCrypto.protect(tenantId, id, input.contact);
        await this.leads.create([{
          id, tenantId, siteId: this.publicSiteId(), audience: input.audience,
          name: input.name, requestSummary: input.requestSummary, attribution: input.attribution,
          contactIv: protectedContact.iv, contactCiphertext: protectedContact.ciphertext,
          contactAuthTag: protectedContact.authTag, dedupeDigest,
          consentedAt: new Date(), status: 'new',
        }], { session });
        const now = new Date();
        await this.sideEffects.create((['email', 'feishu'] as const).map((channel) => ({
          eventId: createEventId(),
          tenantId,
          kind: 'lead_notification',
          aggregateId: id,
          aggregateVersion: 1,
          channel,
          dueAt: now,
          status: 'pending',
          attempts: 0,
          nextAttemptAt: now,
          lockedAt: null,
          lockedBy: null,
          dispatchedAt: null,
          deliveryAttempts: 0,
          completedAt: null,
          lastErrorCode: null,
        })), { session });
        return { leadId: id, duplicate: false };
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const sameKey = await this.leads.findOne({ tenantId, id })
        .select('id audience name requestSummary attribution dedupeDigest').lean().exec();
      if (sameKey === null) throw error;
      assertSameLeadSubmission(sameKey, input, dedupeDigest);
      return { leadId: sameKey.id, duplicate: true };
    }
  }

  async replaySideEffect(
    idempotencyKey: string,
    eventId: string,
  ): Promise<Record<string, unknown>> {
    return this.idempotency.execute(
      'marketing.side_effect.replay',
      idempotencyKey,
      { eventId },
      async (session) => {
        const tenantId = this.context.getTenantRequired().tenantId;
        const record = await this.sideEffects.findOneAndUpdate(
          { tenantId, eventId, status: 'dead' },
          {
            $set: {
              status: 'pending',
              attempts: 0,
              nextAttemptAt: new Date(),
              lockedAt: null,
              lockedBy: null,
              dispatchedAt: null,
              deliveryAttempts: 0,
              completedAt: null,
              lastErrorCode: null,
            },
          },
          { returnDocument: 'after', lean: true, session },
        ).exec();
        if (record === null) throw new ConflictException({
          code: 'MARKETING_SIDE_EFFECT_NOT_REPLAYABLE',
          message: '副作用记录不存在、跨租户或不处于死信状态',
        });
        return {
          eventId: record.eventId,
          kind: record.kind,
          status: record.status,
          attempts: record.attempts,
        };
      },
    );
  }

  async getSideEffectStatus(eventId: string): Promise<Record<string, unknown>> {
    const tenantId = this.context.getTenantRequired().tenantId;
    const record = await this.sideEffects.findOne({ tenantId, eventId })
      .select(
        'eventId kind aggregateId aggregateVersion channel status attempts ' +
        'deliveryAttempts nextAttemptAt dispatchedAt completedAt lastErrorCode',
      )
      .lean().exec();
    if (record === null) throw new NotFoundException({
      code: 'MARKETING_SIDE_EFFECT_NOT_FOUND',
      message: '副作用记录不存在或不属于当前租户',
    });
    return {
      eventId: record.eventId,
      kind: record.kind,
      aggregateId: record.aggregateId,
      aggregateVersion: record.aggregateVersion,
      channel: record.channel,
      status: record.status,
      attempts: record.attempts,
      deliveryAttempts: record.deliveryAttempts,
      nextAttemptAt: record.nextAttemptAt.toISOString(),
      dispatchedAt: record.dispatchedAt?.toISOString() ?? null,
      completedAt: record.completedAt?.toISOString() ?? null,
      lastErrorCode: record.lastErrorCode,
    };
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
        if (current.status === 'scheduled') {
          await this.cancelScheduledSideEffect(current, session, new Date());
        }
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
    idempotencyKey: string,
    id: string,
    status: string,
    expectedVersion: number,
  ): Promise<Record<string, unknown>> {
    const allowed = ['new', 'contacted', 'qualified', 'unqualified', 'converted', 'closed'];
    if (!allowed.includes(status)) throw new BadRequestException({
      code: 'MARKETING_LEAD_STATUS_INVALID', message: '线索状态无效',
    });
    return this.idempotency.execute(
      'marketing.lead.status.update',
      idempotencyKey,
      { id, status, expectedVersion },
      async (session) => {
        const tenantId = this.context.getTenantRequired().tenantId;
        const record = await this.leads.findOneAndUpdate(
          { tenantId, id, version: expectedVersion },
          { $set: { status }, $inc: { version: 1 } },
          { returnDocument: 'after', lean: true, session },
        ).exec();
        if (record === null) throw versionConflict();
        return { id: record.id, status: record.status, version: record.version };
      },
    );
  }

  async assignLead(
    idempotencyKey: string,
    id: string,
    assigneeId: string,
    expectedVersion: number,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(assigneeId)) throw new BadRequestException({
      code: 'MARKETING_LEAD_ASSIGNEE_INVALID', message: '负责人标识无效',
    });
    return this.idempotency.execute(
      'marketing.lead.assignee.update',
      idempotencyKey,
      { id, assigneeId, expectedVersion },
      async (session) => {
        const tenantId = this.context.getTenantRequired().tenantId;
        const record = await this.leads.findOneAndUpdate(
          { tenantId, id, version: expectedVersion },
          { $set: { assigneeId }, $inc: { version: 1 } },
          { returnDocument: 'after', lean: true, session },
        ).exec();
        if (record === null) throw versionConflict();
        return { id: record.id, assigneeId: record.assigneeId, version: record.version };
      },
    );
  }

  async addLeadNote(
    idempotencyKey: string,
    id: string,
    body: string,
    expectedVersion: number,
  ) {
    if (body.trim().length < 1 || body.length > 2000) throw new BadRequestException({
      code: 'MARKETING_LEAD_NOTE_INVALID', message: '跟进备注不符合要求',
    });
    return this.idempotency.execute(
      'marketing.lead.note.add',
      idempotencyKey,
      { id, body: body.trim(), expectedVersion },
      async (session) => {
        const tenantId = this.context.getTenantRequired().tenantId;
        const note = {
          actorId: this.context.getActorRequired().actorId,
          body: body.trim(),
          createdAt: new Date().toISOString(),
        };
        const record = await this.leads.findOneAndUpdate(
          { tenantId, id, version: expectedVersion },
          { $push: { notes: { $each: [note], $slice: -100 } }, $inc: { version: 1 } },
          { returnDocument: 'after', lean: true, session },
        ).exec();
        if (record === null) throw versionConflict();
        return { id: record.id, note, version: record.version };
      },
    );
  }

  async createMediaUpload(
    idempotencyKey: string,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    const input = parseMediaInput(raw);
    const trusted = this.context.getRequired();
    const id = stableId('media', trusted.tenant.tenantId, idempotencyKey);
    const gatewayInput = {
      tenantId: trusted.tenant.tenantId, siteId: input.siteId, mediaId: id,
      fileName: input.fileName, mimeType: input.mimeType, sizeBytes: input.sizeBytes,
    };
    return this.idempotency.executeWithEphemeralResult(
      'marketing.media.upload.create',
      idempotencyKey,
      { input },
      async (session) => {
        const ticket = await this.mediaGateway.createUpload(gatewayInput, idempotencyKey);
        await this.media.create([{
          id, tenantId: trusted.tenant.tenantId, siteId: input.siteId,
          fileName: input.fileName, mimeType: input.mimeType, sizeBytes: input.sizeBytes,
          objectRef: ticket.objectRef, status: 'uploading', checksum: null,
          scanEvidenceId: null, variants: {}, altText: input.altText,
          copyrightSource: input.copyrightSource, version: 1,
        }], { session });
        return {
          stored: { id, objectRef: ticket.objectRef, version: 1 },
          result: {
            id, uploadUrl: ticket.uploadUrl, expiresAt: ticket.expiresAt, version: 1,
          },
        };
      },
      async (stored) => {
        const ticket = await this.mediaGateway.createUpload(gatewayInput, idempotencyKey);
        if (ticket.objectRef !== stored.objectRef) throw new ConflictException({
          code: 'CMS_MEDIA_OBJECT_MISMATCH',
          message: '媒体对象回执不匹配',
        });
        return {
          id: stored.id,
          uploadUrl: ticket.uploadUrl,
          expiresAt: ticket.expiresAt,
          version: stored.version,
        };
      },
    );
  }

  async verifyMedia(
    idempotencyKey: string,
    id: string,
    expectedVersion: number,
  ): Promise<Record<string, unknown>> {
    return this.idempotency.execute(
      'marketing.media.upload.verify',
      idempotencyKey,
      { id, expectedVersion },
      async (session) => {
        const tenantId = this.context.getTenantRequired().tenantId;
        const record = await this.media.findOne({ tenantId, id }).session(session).lean().exec();
        if (record === null) throw new NotFoundException({
          code: 'CMS_MEDIA_NOT_FOUND', message: '媒体不存在',
        });
        if (record.version !== expectedVersion || record.status !== 'uploading') {
          throw versionConflict();
        }
        const receipt = await this.mediaGateway.verifyUpload({
          tenantId, mediaId: id, objectRef: record.objectRef,
        }, idempotencyKey);
        if (receipt.objectRef !== record.objectRef) throw new ConflictException({
          code: 'CMS_MEDIA_OBJECT_MISMATCH', message: '媒体对象回执不匹配',
        });
        const next = await this.media.findOneAndUpdate(
          { tenantId, id, version: expectedVersion, status: 'uploading' },
          { $set: {
            status: 'ready', checksum: receipt.checksum,
            scanEvidenceId: receipt.scanEvidenceId, variants: receipt.variants,
          }, $inc: { version: 1 } },
          { returnDocument: 'after', lean: true, session },
        ).exec();
        if (next === null) throw versionConflict();
        return mediaView(next);
      },
    );
  }

  async listMedia(): Promise<{ readonly items: readonly Record<string, unknown>[] }> {
    const tenantId = this.context.getTenantRequired().tenantId;
    const items = await this.media.find({ tenantId }).sort({ createdAt: -1 }).lean().exec();
    return { items: items.map(mediaView) };
  }

  async generateAiDraft(
    idempotencyKey: string,
    contentId: string,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    const input = parseAiInput(raw);
    return this.idempotency.execute(
      'marketing.ai.draft.generate',
      idempotencyKey,
      { contentId, input },
      async (session) => {
        const content = await this.owned(contentId, session);
        const trusted = this.context.getRequired();
        const result = await this.aiGateway.generate({
          action: input.action, targetLocale: input.targetLocale,
          content: view(content, true), instruction: input.instruction,
        }, idempotencyKey);
        const id = randomUUID();
        await this.generations.create([{
          id, tenantId: trusted.tenant.tenantId, actorId: trusted.actor.actorId,
          contentId, action: input.action, modelId: result.modelId,
          promptVersion: result.promptVersion, output: result.output, status: 'pending_review',
        }], { session });
        return { id, status: 'pending_review', ...result };
      },
    );
  }

  async reviewAiDraft(
    idempotencyKey: string,
    id: string,
    decision: 'accepted' | 'rejected',
  ): Promise<Record<string, unknown>> {
    return this.idempotency.execute(
      'marketing.ai.draft.review',
      idempotencyKey,
      { id, decision },
      async (session) => {
        const tenantId = this.context.getTenantRequired().tenantId;
        const record = await this.generations.findOneAndUpdate(
          { tenantId, id, status: 'pending_review' },
          { $set: { status: decision } },
          { returnDocument: 'after', lean: true, session },
        ).exec();
        if (record === null) throw new ConflictException({
          code: 'CMS_AI_REVIEW_CONFLICT', message: 'AI 草稿不存在或已完成审核',
        });
        return {
          id: record.id, contentId: record.contentId, action: record.action,
          status: record.status, modelId: record.modelId,
          promptVersion: record.promptVersion, output: record.output,
        };
      },
    );
  }

  private async cancelScheduledSideEffect(
    content: MarketingContentDocument,
    session: ClientSession,
    now: Date,
  ): Promise<void> {
    const cancelled = await this.sideEffects.updateOne(
      {
        tenantId: content.tenantId,
        kind: 'scheduled_publish',
        aggregateId: content.id,
        aggregateVersion: content.version,
        channel: null,
        status: { $in: ['pending', 'dispatching', 'dispatched', 'dead'] },
      },
      {
        $set: {
          status: 'cancelled',
          lockedAt: null,
          lockedBy: null,
          completedAt: now,
          lastErrorCode: null,
        },
      },
      { session, timestamps: false },
    );
    if (cancelled.matchedCount !== 1) {
      throw new Error('MARKETING_SCHEDULED_SIDE_EFFECT_MISSING');
    }
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
  const parsed = marketingLeadInputRequestSchema.safeParse(value);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    !parsed.success ||
    /<\s*script|javascript:|on[a-z]+\s*=/iu.test(JSON.stringify(record))
  ) throw leadInvalid();
  return {
    audience: parsed.data.audience,
    name: parsed.data.name,
    contact: parsed.data.contact,
    requestSummary: parsed.data.requestSummary,
    attribution: Object.fromEntries(
      [['utmSource', parsed.data.utmSource], ['utmCampaign', parsed.data.utmCampaign]]
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
  const parsed = marketingMediaUploadRequestSchema.safeParse(value);
  if (!parsed.success) throw mediaInvalid();
  const altText = Object.fromEntries(
    Object.entries(parsed.data.altText)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  return {
    siteId: parsed.data.siteId,
    fileName: parsed.data.fileName,
    mimeType: parsed.data.mimeType,
    sizeBytes: parsed.data.sizeBytes,
    altText,
    copyrightSource: parsed.data.copyrightSource,
  };
}

function parseAiInput(value: unknown): {
  action: 'translate' | 'rewrite' | 'outline' | 'seo' | 'alt_text';
  targetLocale: 'zh-CN' | 'en';
  instruction: string;
} {
  const parsed = marketingAiDraftRequestSchema.safeParse(value);
  if (!parsed.success) throw aiInvalid();
  return parsed.data;
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

interface PublishedContentExpectation {
  readonly siteId: string;
  readonly locale: MarketingLocale;
  readonly type: MarketingContentType;
  readonly slug?: string;
}

/**
 * 官网内容列表只公开建立 URL 和更新时间所需的摘要。
 * 正文区块与 SEO 必须通过详情接口按 slug 获取。
 */
export function marketingPublishedContentSummaryView(
  value: unknown,
  expected: PublishedContentExpectation,
): Readonly<Record<string, unknown>> {
  const source = recordView(value);
  const base = publishedContentBase(source, expected);
  return Object.freeze(base);
}

/** 官网内容详情在服务端重新校验受控 CMS 契约并深复制区块。 */
export function marketingPublishedContentView(
  value: unknown,
  expected: PublishedContentExpectation,
): Readonly<Record<string, unknown>> {
  const source = recordView(value);
  const base = publishedContentBase(source, expected);
  let parsed: ReturnType<typeof parseContentInput>;
  try {
    parsed = parseContentInput({
      siteId: source.siteId,
      type: source.type,
      locale: source.locale,
      slug: source.slug,
      title: source.title,
      summary: source.summary,
      blocks: source.blocks,
      seo: source.seo,
    });
  } catch {
    throw new Error('MARKETING_PUBLIC_CONTENT_RECORD_INVALID');
  }
  return Object.freeze({
    ...base,
    blocks: parsed.blocks,
    seo: parsed.seo ?? Object.freeze({}),
  });
}

/** 官网线索确认只返回稳定标识与去重结果。 */
export function marketingPublicLeadSubmissionView(
  value: unknown,
): Readonly<{ leadId: string; duplicate: boolean }> {
  const source = recordView(value);
  if (
    typeof source.leadId !== 'string' ||
    !PUBLIC_ID.test(source.leadId) ||
    typeof source.duplicate !== 'boolean'
  ) {
    throw new Error('MARKETING_PUBLIC_LEAD_RESULT_INVALID');
  }
  return Object.freeze({ leadId: source.leadId, duplicate: source.duplicate });
}

/**
 * 管理端内容列表与写入结果的最小公开视图。
 * 服务内部仍可使用含 tenantId 的 view() 完成事件和快照处理。
 */
export function marketingContentSummaryView(value: unknown): Readonly<Record<string, unknown>> {
  const source = recordView(value);
  return Object.freeze({
    id: source.id,
    siteId: source.siteId,
    type: source.type,
    locale: source.locale,
    slug: source.slug,
    title: source.title,
    summary: source.summary,
    status: source.status,
    revision: source.revision,
    version: source.version,
  });
}

/** 管理端内容详情视图，显式排除租户和维护者字段。 */
export function marketingContentDetailView(value: unknown): Readonly<Record<string, unknown>> {
  const source = recordView(value);
  return Object.freeze({
    ...marketingContentSummaryView(source),
    blocks: source.blocks,
    seo: source.seo,
    publishedAt: isoOrNull(source.publishedAt),
    scheduledAt: isoOrNull(source.scheduledAt),
  });
}

/** 历史版本只公开业务快照，不公开租户和内部维护者。 */
export function marketingRevisionListView(
  value: unknown,
): { readonly items: readonly Readonly<Record<string, unknown>>[] } {
  const source = recordView(value);
  const items = Array.isArray(source.items) ? source.items : [];
  return Object.freeze({
    items: Object.freeze(items.map((item) => {
      const revision = recordView(item);
      return Object.freeze({
        revision: revision.revision,
        createdAt: isoOrNull(revision.createdAt),
        snapshot: marketingContentDetailView(revision.snapshot),
      });
    })),
  });
}

/** 含联系信息的 R1 线索视图；不公开归因、备注和负责人。 */
export function marketingLeadConsoleView(value: unknown): Readonly<Record<string, unknown>> {
  const source = recordView(value);
  return Object.freeze({
    id: source.id,
    audience: source.audience,
    name: source.name,
    contact: source.contact,
    requestSummary: source.requestSummary,
    status: source.status,
    version: source.version,
    createdAt: isoOrNull(source.createdAt),
  });
}

/** 线索状态写入只返回目标、状态与新版本。 */
export function marketingLeadStatusView(value: unknown): Readonly<Record<string, unknown>> {
  const source = recordView(value);
  return Object.freeze({ id: source.id, status: source.status, version: source.version });
}

/** 媒体管理视图；对象引用、摘要和扫描证据只留在服务端。 */
export function marketingMediaConsoleView(value: unknown): Readonly<Record<string, unknown>> {
  const source = recordView(value);
  return Object.freeze({
    id: source.id,
    fileName: source.fileName,
    mimeType: source.mimeType,
    status: source.status,
    version: source.version,
    variants: source.variants,
  });
}

/** 上传票据只公开完成直传所需的短期能力。 */
export function marketingUploadTicketView(value: unknown): Readonly<Record<string, unknown>> {
  const source = recordView(value);
  return Object.freeze({
    id: source.id,
    uploadUrl: source.uploadUrl,
    expiresAt: isoOrNull(source.expiresAt),
    version: source.version,
  });
}

/** AI 草稿不公开模型和提示词内部版本。 */
export function marketingAiDraftView(value: unknown): Readonly<Record<string, unknown>> {
  const source = recordView(value);
  return Object.freeze({
    id: source.id,
    status: source.status,
    output: safeMarketingAiOutput(source.output),
  });
}

/** AI 人工复核结果不回传原始生成内容和模型元数据。 */
export function marketingAiReviewView(value: unknown): Readonly<Record<string, unknown>> {
  const source = recordView(value);
  return Object.freeze({
    id: source.id,
    contentId: source.contentId,
    action: source.action,
    status: source.status,
  });
}

function recordView(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('MARKETING_VIEW_SOURCE_INVALID');
  }
  return value as Readonly<Record<string, unknown>>;
}

function publishedContentBase(
  source: Readonly<Record<string, unknown>>,
  expected: PublishedContentExpectation,
): Readonly<Record<string, unknown>> {
  const publishedAt = isoOrNull(source.publishedAt);
  if (
    typeof source.id !== 'string' ||
    !PUBLIC_ID.test(source.id) ||
    source.siteId !== expected.siteId ||
    source.locale !== expected.locale ||
    source.type !== expected.type ||
    typeof source.slug !== 'string' ||
    !PUBLIC_SLUG.test(source.slug) ||
    (expected.slug !== undefined && source.slug !== expected.slug) ||
    typeof source.title !== 'string' ||
    source.title.length < 1 ||
    source.title.length > 160 ||
    PUBLIC_DANGEROUS.test(source.title) ||
    typeof source.summary !== 'string' ||
    source.summary.length > 500 ||
    PUBLIC_DANGEROUS.test(source.summary) ||
    typeof source.revision !== 'number' ||
    !Number.isSafeInteger(source.revision) ||
    source.revision < 1 ||
    publishedAt === null
  ) {
    throw new Error('MARKETING_PUBLIC_CONTENT_RECORD_INVALID');
  }
  return Object.freeze({
    id: source.id,
    siteId: source.siteId,
    type: source.type,
    locale: source.locale,
    slug: source.slug,
    title: source.title,
    summary: source.summary,
    revision: source.revision,
    publishedAt,
  });
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  throw new Error('MARKETING_VIEW_DATE_INVALID');
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

function assertIdempotencyKey(value: string): void {
  if (!IDEMPOTENCY_KEY.test(value)) {
    throw new BadRequestException({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: '写接口必须提供 8..128 位合法 Idempotency-Key',
    });
  }
}

function stableId(prefix: string, tenantId: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(`${prefix}\0${tenantId}\0${idempotencyKey}`, 'utf8')
    .digest('hex');
  return `${prefix}-${digest}`;
}

function isDuplicateKeyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === DUPLICATE_KEY_CODE ||
    (error instanceof Error && error.message.includes('E11000'));
}

function assertSameLeadSubmission(
  existing: {
    readonly audience?: unknown;
    readonly name?: unknown;
    readonly requestSummary?: unknown;
    readonly attribution?: unknown;
    readonly dedupeDigest?: unknown;
  },
  input: ReturnType<typeof parseLead>,
  dedupeDigest: string,
): void {
  const attribution = existing.attribution;
  const sameAttribution =
    typeof attribution === 'object' &&
    attribution !== null &&
    !Array.isArray(attribution) &&
    sameStringRecord(attribution as Readonly<Record<string, unknown>>, input.attribution);
  if (
    existing.audience !== input.audience ||
    existing.name !== input.name ||
    existing.requestSummary !== input.requestSummary ||
    existing.dedupeDigest !== dedupeDigest ||
    !sameAttribution
  ) {
    throw new ConflictException({
      code: 'IDEMPOTENCY_KEY_REUSED',
      message: '幂等键已被不同预约请求占用',
    });
  }
}

function sameStringRecord(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && typeof left[key] === 'string' && left[key] === right[key],
    );
}
