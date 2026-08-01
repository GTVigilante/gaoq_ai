import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';

import { OutboxRecord, type OutboxDocument } from '../org/persistence/outbox.schema.js';
import { calculateNextAttemptAt } from './org-delivery.policy.js';
import {
  RecruitmentChannelStageDeliveryRecord,
  type RecruitmentChannelStageDeliveryDocument,
} from './recruitment-channel.schemas.js';

const LOCK_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_ATTEMPTS = 6;

interface ClaimedStageEvent {
  readonly eventId: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly version: number;
  readonly eventType: string;
  readonly targetStage: unknown;
  readonly attempts: number;
}

/** 把申请阶段 Outbox 原子转成渠道回执轨迹；事件中不复制候选人身份和内部原因。 */
@Injectable()
export class RecruitmentChannelStageRelayService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(OutboxRecord.name) private readonly outbox: Model<OutboxDocument>,
    @InjectModel(RecruitmentChannelStageDeliveryRecord.name)
    private readonly deliveries: Model<RecruitmentChannelStageDeliveryDocument>,
  ) {}

  async relayBatch(workerId: string, limit = 50): Promise<number> {
    assertWorker(workerId, limit);
    let count = 0;
    for (let index = 0; index < limit; index += 1) {
      const event = await this.claim(workerId);
      if (event === null) break;
      try {
        await this.project(workerId, event);
        count += 1;
      } catch (error) {
        await this.release(workerId, event, failureCode(error));
      }
    }
    return count;
  }

  private async claim(workerId: string): Promise<ClaimedStageEvent | null> {
    const now = new Date();
    const record = await this.outbox.findOneAndUpdate(
      {
        aggregateType: 'recruitment.application', nextAttemptAt: { $lte: now },
        $or: [
          { status: 'pending' },
          { status: 'dispatching', lockedAt: { $lt: new Date(now.getTime() - LOCK_TIMEOUT_MS) } },
        ],
      },
      { $set: { status: 'dispatching', lockedAt: now, lockedBy: workerId } },
      { sort: { createdAt: 1 }, returnDocument: 'after' },
    ).lean().exec();
    if (record === null) return null;
    const data = record.envelope.data;
    const targetStage = typeof data === 'object' && data !== null
      ? (data as { to?: unknown }).to
      : undefined;
    return {
      eventId: record.eventId, tenantId: record.tenantId,
      applicationId: record.aggregateId, version: record.aggregateVersion,
      eventType: record.eventType, targetStage, attempts: record.attempts,
    };
  }

  private async project(workerId: string, event: ClaimedStageEvent): Promise<void> {
    const stage = channelStage(event);
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        if (stage !== null) await this.createDelivery(event, stage, session);
        const updated = await this.outbox.updateOne(
          { eventId: event.eventId, status: 'dispatching', lockedBy: workerId },
          { $set: {
            status: 'dispatched', dispatchedAt: new Date(), lockedAt: null, lockedBy: null,
            lastErrorCode: null,
          } },
          { session, timestamps: false },
        );
        if (updated.matchedCount !== 1) throw new Error('RECRUITMENT_CHANNEL_OUTBOX_CLAIM_LOST');
      });
    } finally {
      await session.endSession();
    }
  }

  private async createDelivery(
    event: ClaimedStageEvent,
    stage: RecruitmentChannelStageDeliveryRecord['stage'],
    session: ClientSession,
  ): Promise<void> {
    await this.deliveries.updateOne(
      { tenantId: event.tenantId, eventId: event.eventId },
      { $setOnInsert: {
        eventId: event.eventId, tenantId: event.tenantId,
        applicationId: event.applicationId, applicationVersion: event.version, stage,
        status: 'pending', attempts: 0, nextAttemptAt: new Date(),
        lockedAt: null, lockedBy: null, failureCode: null,
        receiptFingerprint: null, succeededAt: null,
      } },
      { upsert: true, session, timestamps: false, runValidators: true, setDefaultsOnInsert: true },
    );
  }

  private async release(workerId: string, event: ClaimedStageEvent, code: string): Promise<void> {
    const attempts = event.attempts + 1;
    const now = new Date();
    const updated = await this.outbox.updateOne(
      { eventId: event.eventId, status: 'dispatching', lockedBy: workerId },
      { $set: {
        status: attempts >= MAX_ATTEMPTS ? 'dead' : 'pending', attempts,
        nextAttemptAt: attempts >= MAX_ATTEMPTS ? now : calculateNextAttemptAt(attempts, now),
        lockedAt: null, lockedBy: null, lastErrorCode: code,
      } },
      { timestamps: false },
    );
    if (updated.matchedCount !== 1) {
      throw new Error('RECRUITMENT_CHANNEL_STAGE_RELEASE_LEASE_LOST');
    }
  }
}

function channelStage(
  event: ClaimedStageEvent,
): RecruitmentChannelStageDeliveryRecord['stage'] | null {
  if (event.eventType === 'cn.gaoq.erp.recruitment.application.created.v1') return null;
  if (event.eventType !== 'cn.gaoq.erp.recruitment.application.stage_changed.v1') {
    throw new Error('RECRUITMENT_CHANNEL_STAGE_EVENT_UNSUPPORTED');
  }
  if (event.version < 2 || typeof event.targetStage !== 'string') {
    throw new Error('RECRUITMENT_CHANNEL_STAGE_EVENT_INVALID');
  }
  const mapping: Readonly<Record<string, RecruitmentChannelStageDeliveryRecord['stage']>> = {
    screening: 'screening', interview: 'interview', offer_approval: 'offer',
    offer_sent: 'offer', offer_accepted: 'offer', preboarding: 'offer',
    hired: 'hired', rejected: 'rejected', withdrawn: 'withdrawn',
  };
  const stage = mapping[event.targetStage];
  if (stage === undefined) throw new Error('RECRUITMENT_CHANNEL_STAGE_EVENT_INVALID');
  return stage;
}

function assertWorker(workerId: string, limit: number): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(workerId)) throw new Error('RECRUITMENT_CHANNEL_WORKER_INVALID');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('RECRUITMENT_CHANNEL_BATCH_LIMIT_INVALID');
  }
}

function failureCode(error: unknown): string {
  return error instanceof Error && /^[A-Z0-9_]{3,128}$/.test(error.message)
    ? error.message
    : 'RECRUITMENT_CHANNEL_STAGE_RELAY_FAILED';
}
