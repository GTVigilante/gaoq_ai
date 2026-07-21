import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';

import { OutboxRecord, type OutboxDocument } from '../org/persistence/outbox.schema.js';
import { calculateNextAttemptAt } from './org-delivery.policy.js';
import {
  RecruitmentChannelBindingRecord,
  type RecruitmentChannelBindingDocument,
  RecruitmentChannelPositionDeliveryRecord,
  type RecruitmentChannelPositionDeliveryDocument,
} from './recruitment-channel.schemas.js';

const LOCK_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_ATTEMPTS = 6;

interface ClaimedPositionEvent {
  readonly eventId: string;
  readonly tenantId: string;
  readonly positionId: string;
  readonly version: number;
  readonly eventType: string;
  readonly status: unknown;
  readonly attempts: number;
}

/** 把职位 Outbox 原子扇出为每个已启用招聘渠道的投递轨迹。 */
@Injectable()
export class RecruitmentChannelPositionRelayService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(OutboxRecord.name) private readonly outbox: Model<OutboxDocument>,
    @InjectModel(RecruitmentChannelBindingRecord.name)
    private readonly bindings: Model<RecruitmentChannelBindingDocument>,
    @InjectModel(RecruitmentChannelPositionDeliveryRecord.name)
    private readonly deliveries: Model<RecruitmentChannelPositionDeliveryDocument>,
  ) {}

  async relayBatch(workerId: string, limit = 50): Promise<number> {
    assertWorker(workerId, limit);
    let count = 0;
    for (let index = 0; index < limit; index += 1) {
      const event = await this.claim(workerId);
      if (event === null) break;
      try {
        await this.fanOut(workerId, event);
        count += 1;
      } catch (error) {
        await this.release(workerId, event, failureCode(error));
      }
    }
    return count;
  }

  private async claim(workerId: string): Promise<ClaimedPositionEvent | null> {
    const now = new Date();
    const record = await this.outbox.findOneAndUpdate(
      {
        aggregateType: 'recruitment.position', nextAttemptAt: { $lte: now },
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
    const status = typeof data === 'object' && data !== null
      ? (data as { status?: unknown }).status
      : undefined;
    return {
      eventId: record.eventId, tenantId: record.tenantId, positionId: record.aggregateId,
      version: record.aggregateVersion, eventType: record.eventType,
      status, attempts: record.attempts,
    };
  }

  private async fanOut(workerId: string, event: ClaimedPositionEvent): Promise<void> {
    const action = this.action(event);
    const targets = action === null ? [] : await this.bindings.find({
      tenantId: event.tenantId, status: 'active',
    }).lean().exec();
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        if (action !== null) {
          for (const binding of targets) await this.createDelivery(event, binding, action, session);
        }
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

  private action(event: ClaimedPositionEvent): 'publish' | 'close' | null {
    if (!['draft', 'open', 'paused', 'closed'].includes(String(event.status))) {
      throw new Error('RECRUITMENT_CHANNEL_POSITION_EVENT_INVALID');
    }
    if (event.eventType === 'cn.gaoq.erp.recruitment.position.created.v1') {
      if (event.status !== 'draft') throw new Error('RECRUITMENT_CHANNEL_POSITION_EVENT_INVALID');
      return null;
    }
    if (event.eventType !== 'cn.gaoq.erp.recruitment.position.status_changed.v1') {
      throw new Error('RECRUITMENT_CHANNEL_POSITION_EVENT_UNSUPPORTED');
    }
    return event.status === 'open' ? 'publish' : 'close';
  }

  private async createDelivery(
    event: ClaimedPositionEvent,
    binding: RecruitmentChannelBindingRecord,
    action: 'publish' | 'close',
    session: ClientSession,
  ): Promise<void> {
    await this.deliveries.updateOne(
      { tenantId: event.tenantId, eventId: event.eventId, bindingId: binding.id },
      { $setOnInsert: {
        eventId: event.eventId, tenantId: event.tenantId, bindingId: binding.id,
        channelCode: binding.channelCode, positionId: event.positionId,
        positionVersion: event.version, action, targetStatus: event.status,
        status: 'pending', attempts: 0, nextAttemptAt: new Date(),
        lockedAt: null, lockedBy: null, failureCode: null,
        receiptFingerprint: null, succeededAt: null,
      } },
      { upsert: true, session, timestamps: false, runValidators: true, setDefaultsOnInsert: true },
    );
  }

  private async release(
    workerId: string,
    event: ClaimedPositionEvent,
    code: string,
  ): Promise<void> {
    const attempts = event.attempts + 1;
    const now = new Date();
    await this.outbox.updateOne(
      { eventId: event.eventId, status: 'dispatching', lockedBy: workerId },
      { $set: {
        status: attempts >= MAX_ATTEMPTS ? 'dead' : 'pending', attempts,
        nextAttemptAt: attempts >= MAX_ATTEMPTS ? now : calculateNextAttemptAt(attempts, now),
        lockedAt: null, lockedBy: null, lastErrorCode: code,
      } },
      { timestamps: false },
    );
  }
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
    : 'RECRUITMENT_CHANNEL_POSITION_RELAY_FAILED';
}
