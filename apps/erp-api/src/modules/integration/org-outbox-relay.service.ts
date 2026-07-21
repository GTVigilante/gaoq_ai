import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Injectable, Logger } from '@nestjs/common';
import type { ClientSession, Connection, Model } from 'mongoose';

import {
  OutboxRecord,
  type OutboxDocument,
} from '../org/persistence/outbox.schema.js';
import { calculateNextAttemptAt } from './org-delivery.policy.js';
import {
  OrgDeliveryRecord,
  type OrgDeliveryChannel,
  type OrgDeliveryDocument,
} from './org-delivery.schemas.js';

const LOCK_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_RELAY_ATTEMPTS = 6;
const WORKER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const CHANNELS: readonly OrgDeliveryChannel[] = ['dingtalk', 'feishu', 'op'];

interface ClaimedOutboxEvent {
  readonly eventId: string;
  readonly tenantId: string;
  readonly aggregateType:
    | 'org.department'
    | 'org.employee'
    | 'org.position'
    | 'org.job_level';
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly eventType: string;
  readonly envelope: Record<string, unknown>;
  readonly attempts: number;
}

/** 将组织 Outbox 事件原子扇出为钉钉、飞书、OP 三条独立投递任务。 */
@Injectable()
export class OrgOutboxRelayService {
  private readonly logger = new Logger(OrgOutboxRelayService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(OutboxRecord.name) private readonly outbox: Model<OutboxDocument>,
    @InjectModel(OrgDeliveryRecord.name)
    private readonly deliveries: Model<OrgDeliveryDocument>,
  ) {}

  /** 顺序抢占并扇出；部门类型按排序先于员工，避免半截组织树。 */
  async relayBatch(workerId: string, limit = 50): Promise<number> {
    this.assertWorker(workerId, limit);
    let relayed = 0;
    for (let index = 0; index < limit; index += 1) {
      const claimed = await this.claimNext(workerId, new Date());
      if (claimed === null) break;
      try {
        await this.fanOut(claimed, workerId);
        relayed += 1;
      } catch {
        this.logger.warn({
          code: 'ORG_RELAY_TRANSACTION_FAILED',
          eventId: claimed.eventId,
        });
        await this.releaseAfterFailure(claimed, workerId, new Date());
      }
    }
    return relayed;
  }

  private async claimNext(workerId: string, now: Date): Promise<ClaimedOutboxEvent | null> {
    const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);
    const event = await this.outbox.findOneAndUpdate(
      {
        aggregateType: {
          $in: ['org.department', 'org.employee', 'org.position', 'org.job_level'],
        },
        nextAttemptAt: { $lte: now },
        $or: [
          { status: 'pending' },
          { status: 'dispatching', lockedAt: { $lt: staleBefore } },
        ],
      },
      {
        $set: { status: 'dispatching', lockedAt: now, lockedBy: workerId },
      },
      {
        sort: { aggregateType: 1, createdAt: 1 },
        returnDocument: 'after',
      },
    ).lean().exec();
    if (event === null) return null;
    return {
      eventId: event.eventId,
      tenantId: event.tenantId,
      aggregateType: event.aggregateType as ClaimedOutboxEvent['aggregateType'],
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion,
      eventType: event.eventType,
      envelope: structuredClone(event.envelope),
      attempts: event.attempts,
    };
  }

  private async fanOut(event: ClaimedOutboxEvent, workerId: string): Promise<void> {
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const aggregateType = event.aggregateType;
        if (this.requiresExternalDelivery(aggregateType)) {
          for (const channel of CHANNELS) {
            await this.createDelivery({ ...event, aggregateType }, channel, session);
          }
        }
        const result = await this.outbox.updateOne(
          { eventId: event.eventId, status: 'dispatching', lockedBy: workerId },
          {
            $set: {
              status: 'dispatched',
              dispatchedAt: new Date(),
              lockedAt: null,
              lockedBy: null,
              lastErrorCode: null,
            },
          },
          { session, timestamps: false },
        );
        if (result.matchedCount !== 1) throw new Error('OUTBOX_CLAIM_LOST');
      });
    } finally {
      await session.endSession();
    }
  }

  private async createDelivery(
    event: ClaimedOutboxEvent & {
      readonly aggregateType: 'org.department' | 'org.employee';
    },
    channel: OrgDeliveryChannel,
    session: ClientSession,
  ): Promise<void> {
    await this.deliveries.updateOne(
      { eventId: event.eventId, channel },
      {
        $setOnInsert: {
          eventId: event.eventId,
          tenantId: event.tenantId,
          channel,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          aggregateVersion: event.aggregateVersion,
          eventType: event.eventType,
          envelope: structuredClone(event.envelope),
          status: 'pending',
          attempts: 0,
          operatorRetryCount: 0,
          nextAttemptAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          externalId: null,
          lastErrorCode: null,
          lastErrorCategory: null,
          succeededAt: null,
        },
      },
      {
        upsert: true,
        session,
        timestamps: false,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );
  }

  private requiresExternalDelivery(
    aggregateType: ClaimedOutboxEvent['aggregateType'],
  ): aggregateType is 'org.department' | 'org.employee' {
    return aggregateType === 'org.department' || aggregateType === 'org.employee';
  }

  private async releaseAfterFailure(
    event: ClaimedOutboxEvent,
    workerId: string,
    now: Date,
  ): Promise<void> {
    const attempts = event.attempts + 1;
    const exhausted = attempts >= MAX_RELAY_ATTEMPTS;
    await this.outbox.updateOne(
      { eventId: event.eventId, status: 'dispatching', lockedBy: workerId },
      {
        $set: {
          status: exhausted ? 'dead' : 'pending',
          attempts,
          nextAttemptAt: exhausted ? now : calculateNextAttemptAt(attempts, now),
          lockedAt: null,
          lockedBy: null,
          lastErrorCode: 'ORG_RELAY_TRANSACTION_FAILED',
        },
      },
      { timestamps: false },
    );
  }

  private assertWorker(workerId: string, limit: number): void {
    if (!WORKER_ID_PATTERN.test(workerId)) throw new Error('relay workerId 非法');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('relay batch limit 必须为 1..100 的整数');
    }
  }
}
