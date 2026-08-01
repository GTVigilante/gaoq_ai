import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { Job, Queue } from 'bullmq';
import type { Connection, Model } from 'mongoose';
import { OutboxRecord } from '../org/persistence/outbox.schema.js';
import { AuditService } from '../../core/audit/audit.service.js';
import {
  MarketingContentRecord,
  MarketingContentRevisionRecord,
  MarketingSideEffectRecord,
  type MarketingContentDocument,
  type MarketingSideEffectDocument,
} from './marketing-cms.schemas.js';
import { MARKETING_PUBLISHED_EVENT_TYPE } from './marketing-cms.types.js';
import {
  MARKETING_AUTOMATION_QUEUE,
  type MarketingPublishJob,
} from './marketing-automation.queue.js';
import {
  MarketingSideEffectDeliveryService,
  type MarketingSideEffectIdentity,
} from './marketing-side-effect-delivery.service.js';

/** 到期发布 Worker；仅在记录仍处于 scheduled 且时间已到时提交发布与 Outbox。 */
@Processor(MARKETING_AUTOMATION_QUEUE, { concurrency: 2 })
export class MarketingPublishProcessor extends WorkerHost {
  private readonly logger = new Logger(MarketingPublishProcessor.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(MarketingContentRecord.name) private readonly contents: Model<MarketingContentRecord>,
    @InjectModel(MarketingContentRevisionRecord.name)
    private readonly revisions: Model<MarketingContentRevisionRecord>,
    @InjectModel(OutboxRecord.name) private readonly outbox: Model<OutboxRecord>,
    @InjectModel(MarketingSideEffectRecord.name)
    private readonly sideEffects: Model<MarketingSideEffectDocument>,
    @InjectQueue(MARKETING_AUTOMATION_QUEUE)
    private readonly automation: Queue<MarketingPublishJob>,
    private readonly delivery: MarketingSideEffectDeliveryService,
    private readonly audit: AuditService,
  ) { super(); }

  override async process(job: Job<MarketingPublishJob | Record<string, never>>): Promise<void> {
    if (job.name === 'scan:scheduled') {
      await this.rebuildDueJobs();
      return;
    }
    const data = job.data as MarketingPublishJob;
    const identity = publishIdentity(data);
    const attempt = job.attemptsMade + 1;
    try {
      await this.publishOne(data, identity, attempt, String(job.id ?? 'delayed'));
    } catch (caught) {
      const finalAttempt = attempt >= configuredAttempts(job);
      const code = failureCode(caught);
      await this.delivery.markFailure(identity, attempt, finalAttempt, code);
      if (finalAttempt) {
        this.logger.error({
          code: 'MARKETING_SCHEDULED_PUBLISH_DEAD_LETTERED',
          eventId: identity.eventId,
          attempts: attempt,
          failureCode: code,
        });
      }
      throw new Error(code, { cause: caught });
    }
  }

  private async rebuildDueJobs(): Promise<void> {
    const due = await this.sideEffects.find({
      kind: 'scheduled_publish',
      channel: null,
      status: 'dispatched',
      dueAt: { $lte: new Date() },
    }).select('eventId tenantId aggregateId aggregateVersion')
      .sort({ dueAt: 1 }).limit(100).lean().exec();
    for (const item of due) {
      await this.automation.add(
        'publish:repair',
        {
          sideEffectEventId: item.eventId,
          tenantId: item.tenantId,
          contentId: item.aggregateId,
          aggregateVersion: item.aggregateVersion,
        },
        {
          jobId: `marketing-publish-repair:${item.eventId}`,
          attempts: 6,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: 1_000,
          removeOnFail: 5_000,
        },
      );
    }
  }

  private async publishOne(
    data: MarketingPublishJob,
    identity: MarketingSideEffectIdentity,
    attempt: number,
    jobId: string,
  ): Promise<void> {
    const now = new Date();
    let publishedVersion: number | null = null;
    await this.connection.transaction(async (session) => {
      if (!await this.delivery.assertDispatchable(identity, session)) return;
      const record: MarketingContentDocument | null = await this.contents.findOne({
        tenantId: data.tenantId, id: data.contentId,
        version: data.aggregateVersion,
        status: 'scheduled', scheduledAt: { $lte: now },
      } as never).session(session).exec();
      if (record === null) {
        throw new Error('MARKETING_SCHEDULED_CONTENT_NOT_PUBLISHABLE');
      }
      record.status = 'published';
      record.publishedAt = now;
      record.scheduledAt = null;
      record.version += 1;
      record.revision += 1;
      record.updatedBy = 'system:marketing-scheduler';
      await record.save({ session });
      const snapshot = {
        id: record.id, tenantId: record.tenantId, siteId: record.siteId,
        type: record.type, locale: record.locale, slug: record.slug, title: record.title,
        summary: record.summary, blocks: record.blocks, seo: record.seo,
        status: record.status, revision: record.revision, version: record.version,
        publishedAt: record.publishedAt,
      };
      await this.revisions.create([{
        tenantId: record.tenantId, contentId: record.id, revision: record.revision,
        snapshot, actorId: 'system:marketing-scheduler',
      }], { session });
      const eventId = createEventId(now);
      const eventData = {
        siteId: record.siteId, contentId: record.id, contentType: record.type,
        locale: record.locale, slug: record.slug, revision: record.revision,
      };
      await this.outbox.create([{
        eventId, tenantId: record.tenantId, aggregateType: 'marketing.content',
        aggregateId: record.id, aggregateVersion: record.version,
        eventType: MARKETING_PUBLISHED_EVENT_TYPE,
        envelope: {
          specversion: '1.0', id: eventId, source: '//gaoq-erp/marketing-cms',
          type: MARKETING_PUBLISHED_EVENT_TYPE,
          subject: `tenant/${record.tenantId}/marketing.content/${record.id}`,
          time: now.toISOString(), datacontenttype: 'application/json',
          tenantId: record.tenantId, traceId: `marketing-scheduler:${eventId}`,
          idempotencyKey: `${record.tenantId}:${MARKETING_PUBLISHED_EVENT_TYPE}:${record.id}:${record.version}`,
          schemaVersion: '1', data: eventData,
        },
        status: 'pending', attempts: 0, nextAttemptAt: now,
      }], { session });
      await this.delivery.markDelivered(identity, attempt, session);
      publishedVersion = record.version;
    });
    if (publishedVersion === null) return;
    try {
      await this.audit.recordSystem(data.tenantId, {
        action: 'marketing.content.publish.scheduled',
        resourceType: 'marketing_content',
        resourceId: data.contentId,
        riskLevel: 'R2',
        outcome: 'success',
        traceId: `marketing-scheduler:${jobId}`,
        metadata: { version: publishedVersion },
      });
    } catch {
      this.logger.error({
        code: 'MARKETING_SCHEDULED_PUBLISH_AUDIT_FAILED',
        contentId: data.contentId,
        version: publishedVersion,
      });
    }
  }
}

const publishIdentity = (data: MarketingPublishJob): MarketingSideEffectIdentity => ({
  eventId: data.sideEffectEventId,
  tenantId: data.tenantId,
  kind: 'scheduled_publish',
  aggregateId: data.contentId,
  aggregateVersion: data.aggregateVersion,
  channel: null,
});

const configuredAttempts = (
  job: Job<MarketingPublishJob | Record<string, never>>,
): number => {
  const attempts = job.opts.attempts ?? 1;
  return Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 1;
};

const failureCode = (caught: unknown): string =>
  caught instanceof Error && /^[A-Z0-9_]{3,128}$/u.test(caught.message)
    ? caught.message
    : 'MARKETING_SCHEDULED_PUBLISH_FAILED';
