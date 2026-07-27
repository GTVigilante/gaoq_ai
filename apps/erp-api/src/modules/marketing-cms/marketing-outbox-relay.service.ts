import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import type { Model } from 'mongoose';
import {
  MarketingSideEffectRecord,
  type MarketingSideEffectDocument,
  type MarketingSideEffectKind,
} from './marketing-cms.schemas.js';
import {
  MARKETING_AUTOMATION_QUEUE,
  type MarketingPublishJob,
} from './marketing-automation.queue.js';
import {
  MARKETING_NOTIFICATION_QUEUE,
  type MarketingNotificationChannel,
  type MarketingNotificationJob,
} from './marketing-notification.queue.js';

const LOCK_TIMEOUT_MS = 5 * 60_000;
const MAX_ATTEMPTS = 8;

interface ClaimedSideEffect {
  readonly eventId: string;
  readonly tenantId: string;
  readonly kind: MarketingSideEffectKind;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly channel: MarketingNotificationChannel | null;
  readonly dueAt: Date;
  readonly attempts: number;
}

/** 将事务 Outbox 至少一次投递到 BullMQ；稳定 Job ID 与下游幂等键共同防重。 */
@Injectable()
export class MarketingOutboxRelayService {
  private readonly logger = new Logger(MarketingOutboxRelayService.name);

  constructor(
    @InjectModel(MarketingSideEffectRecord.name)
    private readonly records: Model<MarketingSideEffectDocument>,
    @InjectQueue(MARKETING_NOTIFICATION_QUEUE)
    private readonly notifications: Queue<MarketingNotificationJob>,
    @InjectQueue(MARKETING_AUTOMATION_QUEUE)
    private readonly automation: Queue<MarketingPublishJob>,
  ) {}

  async relayBatch(workerId: string, limit = 100): Promise<number> {
    assertWorker(workerId, limit);
    let dispatched = 0;
    for (let index = 0; index < limit; index += 1) {
      const record = await this.claim(workerId);
      if (record === null) break;
      try {
        await this.enqueue(record);
        const updated = await this.records.updateOne(
          { eventId: record.eventId, status: 'dispatching', lockedBy: workerId },
          {
            $set: {
              status: 'dispatched',
              dispatchedAt: new Date(),
              lockedAt: null,
              lockedBy: null,
              lastErrorCode: null,
            },
          },
          { timestamps: false },
        );
        if (updated.matchedCount !== 1) throw new Error('MARKETING_OUTBOX_CLAIM_LOST');
        dispatched += 1;
      } catch (caught) {
        await this.release(workerId, record, failureCode(caught));
      }
    }
    return dispatched;
  }

  private async claim(workerId: string): Promise<ClaimedSideEffect | null> {
    const now = new Date();
    const record = await this.records.findOneAndUpdate(
      {
        nextAttemptAt: { $lte: now },
        $or: [
          { status: 'pending' },
          {
            status: 'dispatching',
            lockedAt: { $lt: new Date(now.getTime() - LOCK_TIMEOUT_MS) },
          },
        ],
      },
      { $set: { status: 'dispatching', lockedAt: now, lockedBy: workerId } },
      { sort: { createdAt: 1 }, returnDocument: 'after', lean: true },
    ).exec();
    if (record === null) return null;
    return {
      eventId: record.eventId,
      tenantId: record.tenantId,
      kind: record.kind,
      aggregateId: record.aggregateId,
      aggregateVersion: record.aggregateVersion,
      channel: record.channel,
      dueAt: record.dueAt,
      attempts: record.attempts,
    };
  }

  private async enqueue(record: ClaimedSideEffect): Promise<void> {
    const options = {
      jobId: `marketing-side-effect:${record.eventId}`,
      attempts: 6,
      backoff: { type: 'exponential' as const, delay: 5_000 },
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
    };
    if (record.kind === 'lead_notification') {
      if (record.channel === null) throw new Error('MARKETING_OUTBOX_ROUTE_INVALID');
      await this.notifications.add(
        `lead:${record.channel}`,
        {
          sideEffectEventId: record.eventId,
          tenantId: record.tenantId,
          leadId: record.aggregateId,
          aggregateVersion: record.aggregateVersion,
          channel: record.channel,
        },
        options,
      );
      return;
    }
    if (record.kind === 'scheduled_publish' && record.channel === null) {
      await this.automation.add(
        'publish:scheduled',
        {
          sideEffectEventId: record.eventId,
          tenantId: record.tenantId,
          contentId: record.aggregateId,
          aggregateVersion: record.aggregateVersion,
        },
        {
          ...options,
          delay: Math.max(0, record.dueAt.getTime() - Date.now()),
        },
      );
      return;
    }
    throw new Error('MARKETING_OUTBOX_ROUTE_INVALID');
  }

  private async release(
    workerId: string,
    record: ClaimedSideEffect,
    errorCode: string,
  ): Promise<void> {
    const attempts = record.attempts + 1;
    const dead = attempts >= MAX_ATTEMPTS;
    await this.records.updateOne(
      { eventId: record.eventId, status: 'dispatching', lockedBy: workerId },
      {
        $set: {
          status: dead ? 'dead' : 'pending',
          attempts,
          nextAttemptAt: dead
            ? new Date()
            : new Date(Date.now() + Math.min(300_000, 1_000 * (2 ** attempts))),
          lockedAt: null,
          lockedBy: null,
          completedAt: dead ? new Date() : null,
          lastErrorCode: errorCode,
        },
      },
      { timestamps: false },
    );
    if (dead) {
      this.logger.error({
        code: 'MARKETING_SIDE_EFFECT_DEAD_LETTERED',
        eventId: record.eventId,
        kind: record.kind,
        attempts,
        failureCode: errorCode,
      });
    }
  }
}

function assertWorker(workerId: string, limit: number): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(workerId)) {
    throw new Error('MARKETING_OUTBOX_WORKER_INVALID');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('MARKETING_OUTBOX_LIMIT_INVALID');
  }
}

function failureCode(caught: unknown): string {
  return caught instanceof Error && /^[A-Z0-9_]{3,128}$/u.test(caught.message)
    ? caught.message
    : 'MARKETING_OUTBOX_ENQUEUE_FAILED';
}
