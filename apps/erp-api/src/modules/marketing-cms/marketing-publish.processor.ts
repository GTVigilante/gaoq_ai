import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { Job } from 'bullmq';
import type { Connection, Model } from 'mongoose';
import { OutboxRecord } from '../org/persistence/outbox.schema.js';
import { AuditService } from '../../core/audit/audit.service.js';
import {
  MarketingContentRecord,
  MarketingContentRevisionRecord,
  type MarketingContentDocument,
} from './marketing-cms.schemas.js';
import { MARKETING_PUBLISHED_EVENT_TYPE } from './marketing-cms.types.js';
import {
  MARKETING_AUTOMATION_QUEUE,
  type MarketingPublishJob,
} from './marketing-automation.queue.js';

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
    private readonly audit: AuditService,
  ) { super(); }

  override async process(job: Job<MarketingPublishJob | Record<string, never>>): Promise<void> {
    if (job.name === 'scan:scheduled') {
      const due = await this.contents.find({
        status: 'scheduled', scheduledAt: { $lte: new Date() },
      }).select('tenantId id').sort({ scheduledAt: 1 }).limit(100).lean().exec();
      for (const item of due) {
        await this.publishOne({ tenantId: item.tenantId, contentId: item.id }, `repair:${item.id}`);
      }
      return;
    }
    const data = job.data as MarketingPublishJob;
    await this.publishOne(data, String(job.id ?? 'delayed'));
  }

  private async publishOne(data: MarketingPublishJob, jobId: string): Promise<void> {
    const now = new Date();
    let publishedVersion: number | null = null;
    await this.connection.transaction(async (session) => {
      const record: MarketingContentDocument | null = await this.contents.findOne({
        tenantId: data.tenantId, id: data.contentId,
        status: 'scheduled', scheduledAt: { $lte: now },
      } as never).session(session).exec();
      if (record === null) return;
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
