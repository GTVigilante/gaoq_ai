import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { ClientSession, Connection, Model } from 'mongoose';

import { OutboxRecord, type OutboxDocument } from '../org/persistence/outbox.schema.js';
import { calculateNextAttemptAt } from './org-delivery.policy.js';
import {
  OrgPlatformBinding,
  type OrgPlatformBindingDocument,
} from './org-platform-binding.schema.js';
import {
  RecruitmentCalendarBinding,
  type RecruitmentCalendarBindingDocument,
} from './recruitment-calendar-binding.schema.js';
import type { RecruitmentCalendarChannel } from './recruitment-calendar.adapter.js';
import {
  RecruitmentCalendarDeliveryRecord,
  type RecruitmentCalendarDeliveryAction,
  type RecruitmentCalendarDeliveryDocument,
} from './recruitment-calendar-delivery.schema.js';

const LOCK_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_RELAY_ATTEMPTS = 6;
const WORKER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CALENDAR_ID_PATTERN = /^[\x21-\x7E]{1,256}$/;
const EVENT_TYPE_PATTERN = /^cn\.gaoq\.erp\.recruitment\.interview\.(scheduled|cancelled|completed|migrated)\.v1$/;

/** Outbox 事务可能已经提交；禁止再释放为 pending 或重复扇出。 */
class RecruitmentCalendarRelayPostCommitError extends Error {}

interface ClaimedInterviewEvent {
  readonly eventId: string;
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly eventType: string;
  readonly attempts: number;
}

interface ActiveCalendarTarget {
  readonly channel: RecruitmentCalendarChannel;
  readonly externalCalendarId: string;
}

/** 将面试 Outbox 原子扇出为租户已启用平台的日历投递轨迹。 */
@Injectable()
export class RecruitmentCalendarOutboxRelayService {
  private readonly logger = new Logger(RecruitmentCalendarOutboxRelayService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(OutboxRecord.name) private readonly outbox: Model<OutboxDocument>,
    @InjectModel(RecruitmentCalendarDeliveryRecord.name)
    private readonly deliveries: Model<RecruitmentCalendarDeliveryDocument>,
    @InjectModel(OrgPlatformBinding.name)
    private readonly platformBindings: Model<OrgPlatformBindingDocument>,
    @InjectModel(RecruitmentCalendarBinding.name)
    private readonly calendarBindings: Model<RecruitmentCalendarBindingDocument>,
  ) {}

  async relayBatch(workerId: string, limit = 50): Promise<number> {
    this.assertWorker(workerId, limit);
    let relayed = 0;
    for (let index = 0; index < limit; index += 1) {
      const event = await this.claimNext(workerId, new Date());
      if (event === null) break;
      try {
        this.assertEvent(event);
        await this.fanOut(event, workerId);
        relayed += 1;
      } catch (error) {
        if (error instanceof RecruitmentCalendarRelayPostCommitError) throw error;
        this.logger.warn({ code: 'RECRUITMENT_CALENDAR_RELAY_FAILED', eventId: event.eventId });
        await this.releaseAfterFailure(event, workerId, new Date());
      }
    }
    return relayed;
  }

  private async claimNext(workerId: string, now: Date): Promise<ClaimedInterviewEvent | null> {
    const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);
    const event = await this.outbox.findOneAndUpdate(
      {
        aggregateType: 'recruitment.interview',
        nextAttemptAt: { $lte: now },
        $or: [
          { status: 'pending' },
          { status: 'dispatching', lockedAt: { $lt: staleBefore } },
        ],
      },
      { $set: { status: 'dispatching', lockedAt: now, lockedBy: workerId } },
      { sort: { createdAt: 1 }, returnDocument: 'after' },
    ).lean().exec();
    if (event === null) return null;
    return {
      eventId: event.eventId, tenantId: event.tenantId,
      aggregateId: event.aggregateId, aggregateVersion: event.aggregateVersion,
      eventType: event.eventType, attempts: event.attempts,
    };
  }

  private async fanOut(event: ClaimedInterviewEvent, workerId: string): Promise<void> {
    const action = this.action(event.eventType);
    const targets = action === null ? [] : await this.targetsFor(event, action);
    if (action === 'upsert' && targets.length === 0) throw new Error('CALENDAR_BINDING_MISSING');
    const session = await this.connection.startSession();
    let transactionFailed = false;
    let transactionError: unknown;
    try {
      await session.withTransaction(async () => {
        if (action !== null) {
          for (const target of targets) await this.createDelivery(event, target, action, session);
        }
        const updated = await this.outbox.updateOne(
          { eventId: event.eventId, status: 'dispatching', lockedBy: workerId },
          { $set: {
            status: 'dispatched', dispatchedAt: new Date(), lockedAt: null, lockedBy: null,
            lastErrorCode: null,
          } },
          { session, timestamps: false },
        );
        if (updated.matchedCount !== 1) throw new Error('OUTBOX_CLAIM_LOST');
      });
    } catch (error) {
      transactionFailed = true;
      transactionError = error;
    }
    let cleanupFailed = false;
    try {
      await session.endSession();
    } catch {
      cleanupFailed = true;
    }
    if (transactionFailed) throw transactionError;
    if (cleanupFailed) {
      throw new RecruitmentCalendarRelayPostCommitError('日历 Relay 已提交但会话清理失败');
    }
  }

  private async targetsFor(
    event: ClaimedInterviewEvent,
    action: RecruitmentCalendarDeliveryAction,
  ): Promise<readonly ActiveCalendarTarget[]> {
    if (action === 'upsert') return this.activeTargets(event.tenantId);
    const records = await this.deliveries.find(
      { tenantId: event.tenantId, interviewId: event.aggregateId, action: 'upsert' },
      { channel: 1, externalCalendarId: 1, _id: 0 },
    ).lean().exec();
    const unique = new Map<string, ActiveCalendarTarget>();
    for (const record of records) {
      this.assertTarget(record.channel, record.externalCalendarId);
      const key = `${record.channel}:${record.externalCalendarId}`;
      unique.set(key, Object.freeze({
        channel: record.channel,
        externalCalendarId: record.externalCalendarId,
      }));
    }
    return Object.freeze([...unique.values()].sort((left, right) =>
      left.channel.localeCompare(right.channel)));
  }

  private async activeTargets(tenantId: string): Promise<readonly ActiveCalendarTarget[]> {
    const [platformRecords, calendarRecords] = await Promise.all([
      this.platformBindings.find(
        { tenantId, status: 'active' },
        { channel: 1, _id: 0 },
      ).lean().exec(),
      this.calendarBindings.find(
        { tenantId, status: 'active' },
        { channel: 1, externalCalendarId: 1, _id: 0 },
      ).lean().exec(),
    ]);
    const enabledPlatforms = new Set(platformRecords.map((record) => record.channel));
    const targets: ActiveCalendarTarget[] = [];
    for (const record of calendarRecords) {
      if (!enabledPlatforms.has(record.channel)) continue;
      this.assertTarget(record.channel, record.externalCalendarId);
      targets.push(Object.freeze({
        channel: record.channel,
        externalCalendarId: record.externalCalendarId,
      }));
    }
    const unique = new Map(targets.map((target) => [
      `${target.channel}:${target.externalCalendarId}`,
      target,
    ]));
    return Object.freeze([...unique.values()]
      .sort((left, right) => left.channel.localeCompare(right.channel)));
  }

  private async createDelivery(
    event: ClaimedInterviewEvent,
    target: ActiveCalendarTarget,
    action: RecruitmentCalendarDeliveryAction,
    session: ClientSession,
  ): Promise<void> {
    const result = await this.deliveries.updateOne(
      {
        tenantId: event.tenantId,
        eventId: event.eventId,
        channel: target.channel,
        externalCalendarId: target.externalCalendarId,
      },
      { $setOnInsert: {
        eventId: event.eventId, tenantId: event.tenantId, channel: target.channel,
        externalCalendarId: target.externalCalendarId,
        interviewId: event.aggregateId, interviewVersion: event.aggregateVersion,
        action, status: 'pending', attempts: 0, nextAttemptAt: new Date(),
        lockedAt: null, lockedBy: null, externalEventId: null,
        lastErrorCode: null, lastErrorCategory: null, succeededAt: null,
      } },
      {
        upsert: true, session, timestamps: false, runValidators: true, setDefaultsOnInsert: true,
      },
    );
    if (!result.acknowledged) throw new Error('CALENDAR_DELIVERY_CREATE_UNACKNOWLEDGED');
  }

  private action(eventType: string): RecruitmentCalendarDeliveryAction | null {
    if (eventType === 'cn.gaoq.erp.recruitment.interview.scheduled.v1') return 'upsert';
    if (eventType === 'cn.gaoq.erp.recruitment.interview.cancelled.v1') return 'cancel';
    if (eventType === 'cn.gaoq.erp.recruitment.interview.completed.v1') return null;
    if (eventType === 'cn.gaoq.erp.recruitment.interview.migrated.v1') return null;
    throw new Error('RECRUITMENT_CALENDAR_EVENT_UNSUPPORTED');
  }

  private async releaseAfterFailure(
    event: ClaimedInterviewEvent,
    workerId: string,
    now: Date,
  ): Promise<void> {
    const attempts = Number.isInteger(event.attempts) &&
      event.attempts >= 0 &&
      event.attempts < MAX_RELAY_ATTEMPTS
      ? event.attempts + 1
      : MAX_RELAY_ATTEMPTS;
    const exhausted = attempts >= MAX_RELAY_ATTEMPTS;
    const result = await this.outbox.updateOne(
      { eventId: event.eventId, status: 'dispatching', lockedBy: workerId },
      { $set: {
        status: exhausted ? 'dead' : 'pending', attempts,
        nextAttemptAt: exhausted ? now : calculateNextAttemptAt(attempts, now),
        lockedAt: null, lockedBy: null, lastErrorCode: 'RECRUITMENT_CALENDAR_RELAY_FAILED',
      } },
      { timestamps: false },
    );
    if (result.matchedCount !== 1) throw new Error('RECRUITMENT_CALENDAR_RELAY_CLAIM_LOST');
  }

  private assertEvent(event: ClaimedInterviewEvent): void {
    if (
      !ULID_PATTERN.test(event.eventId) ||
      !ID_PATTERN.test(event.tenantId) ||
      !ULID_PATTERN.test(event.aggregateId) ||
      !Number.isSafeInteger(event.aggregateVersion) ||
      event.aggregateVersion < 1 ||
      !EVENT_TYPE_PATTERN.test(event.eventType) ||
      !Number.isInteger(event.attempts) ||
      event.attempts < 0 ||
      event.attempts >= MAX_RELAY_ATTEMPTS
    ) {
      throw new Error('RECRUITMENT_CALENDAR_OUTBOX_INVALID');
    }
  }

  private assertTarget(channel: string, externalCalendarId: string): void {
    if (
      (channel !== 'dingtalk' && channel !== 'feishu') ||
      !CALENDAR_ID_PATTERN.test(externalCalendarId)
    ) {
      throw new Error('RECRUITMENT_CALENDAR_BINDING_INVALID');
    }
  }

  private assertWorker(workerId: string, limit: number): void {
    if (!WORKER_ID_PATTERN.test(workerId)) throw new Error('calendar relay workerId 非法');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('calendar relay batch limit 必须为 1..100 的整数');
    }
  }
}
