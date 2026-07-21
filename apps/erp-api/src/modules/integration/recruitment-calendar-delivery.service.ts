import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { RecruitmentInterviewService } from '../recruitment/application/recruitment-interview.service.js';
import { calculateNextAttemptAt } from './org-delivery.policy.js';
import { OrgExternalIdentityResolver } from './org-external-identity.resolver.js';
import { OrgPushError } from './org-push.adapter.js';
import {
  RecruitmentCalendarAdapterRegistry,
  RecruitmentCalendarError,
  type RecruitmentCalendarChannel,
  type RecruitmentCalendarFailureCategory,
} from './recruitment-calendar.adapter.js';
import {
  RecruitmentCalendarDeliveryRecord,
  type RecruitmentCalendarDeliveryAction,
  type RecruitmentCalendarDeliveryDocument,
} from './recruitment-calendar-delivery.schema.js';

const LOCK_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_ATTEMPTS = 8;
const WORKER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

interface ClaimedCalendarDelivery {
  readonly eventId: string;
  readonly tenantId: string;
  readonly channel: RecruitmentCalendarChannel;
  readonly externalCalendarId: string;
  readonly interviewId: string;
  readonly interviewVersion: number;
  readonly action: RecruitmentCalendarDeliveryAction;
  readonly attempts: number;
}

/** 日历投递消费者；平台失败不修改 Recruitment 权威排期。 */
@Injectable()
export class RecruitmentCalendarDeliveryService {
  constructor(
    @InjectModel(RecruitmentCalendarDeliveryRecord.name)
    private readonly deliveries: Model<RecruitmentCalendarDeliveryDocument>,
    private readonly context: TenantContextService,
    private readonly interviews: RecruitmentInterviewService,
    private readonly identities: OrgExternalIdentityResolver,
    private readonly adapters: RecruitmentCalendarAdapterRegistry,
  ) {}

  async processBatch(
    channel: RecruitmentCalendarChannel,
    workerId: string,
    limit = 25,
  ): Promise<number> {
    this.assertWorker(workerId, limit);
    let succeeded = 0;
    for (let index = 0; index < limit; index += 1) {
      const delivery = await this.claimNext(channel, workerId, new Date());
      if (delivery === null) break;
      try {
        const externalEventId = await this.context.run(
          {
            tenant: { tenantId: delivery.tenantId, source: 'service_identity' },
            actor: {
              actorType: 'system_job', actorId: `calendar-delivery:${channel}`,
              tenantId: delivery.tenantId, roleCodes: [],
              scopes: ['erp:integration:calendar:deliver'], departmentIds: [],
              traceId: `calendar:${delivery.eventId}:${delivery.attempts + 1}`,
            },
          },
          () => this.deliver(delivery),
        );
        await this.markSucceeded(delivery, workerId, externalEventId, new Date());
        succeeded += 1;
      } catch (error) {
        await this.markFailed(delivery, workerId, error, new Date());
      }
    }
    return succeeded;
  }

  private async claimNext(
    channel: RecruitmentCalendarChannel,
    workerId: string,
    now: Date,
  ): Promise<ClaimedCalendarDelivery | null> {
    const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);
    const record = await this.deliveries.findOneAndUpdate(
      {
        channel, nextAttemptAt: { $lte: now },
        $or: [
          { status: 'pending' },
          { status: 'processing', lockedAt: { $lt: staleBefore } },
        ],
      },
      { $set: { status: 'processing', lockedAt: now, lockedBy: workerId } },
      { sort: { createdAt: 1 }, returnDocument: 'after' },
    ).lean().exec();
    return record === null ? null : {
      eventId: record.eventId, tenantId: record.tenantId, channel: record.channel,
      externalCalendarId: record.externalCalendarId,
      interviewId: record.interviewId, interviewVersion: record.interviewVersion,
      action: record.action, attempts: record.attempts,
    };
  }

  private async deliver(delivery: ClaimedCalendarDelivery): Promise<string | null> {
    const projection = await this.interviews.getCalendarProjectionForIntegration(
      delivery.interviewId,
    );
    const currentExternalEventId = await this.findCurrentExternalEventId(delivery);
    if (delivery.action === 'cancel') {
      if (currentExternalEventId === null) return null;
      const organizerExternalId = await this.requireExternalIdentity(
        delivery, projection.interviewerIds[0],
      );
      const result = await this.adapters.get(delivery.channel).cancel({
        tenantId: delivery.tenantId, interviewId: delivery.interviewId,
        externalCalendarId: delivery.externalCalendarId,
        version: delivery.interviewVersion, organizerExternalId,
        externalEventId: currentExternalEventId,
        idempotencyKey: this.idempotencyKey(delivery),
      });
      return this.externalId(result.externalEventId);
    }
    if (projection.status !== 'scheduled') return currentExternalEventId;
    const attendeeExternalIds: string[] = [];
    for (const employeeId of projection.interviewerIds) {
      attendeeExternalIds.push(await this.requireExternalIdentity(delivery, employeeId));
    }
    const organizerExternalId = attendeeExternalIds[0];
    if (organizerExternalId === undefined) throw new RecruitmentCalendarError(
      'CALENDAR_ORGANIZER_MISSING', 'business', '日历组织者缺失',
    );
    const result = await this.adapters.get(delivery.channel).upsert({
      tenantId: delivery.tenantId, interviewId: delivery.interviewId,
      externalCalendarId: delivery.externalCalendarId,
      version: delivery.interviewVersion, startsAt: projection.startsAt,
      endsAt: projection.endsAt, timezone: projection.timezone,
      organizerExternalId,
      attendeeExternalIds: Object.freeze(attendeeExternalIds), location: projection.location,
      currentExternalEventId, idempotencyKey: this.idempotencyKey(delivery),
    });
    return this.externalId(result.externalEventId);
  }

  private async requireExternalIdentity(
    delivery: ClaimedCalendarDelivery,
    employeeId: string | undefined,
  ): Promise<string> {
    if (employeeId === undefined) throw new RecruitmentCalendarError(
      'CALENDAR_ORGANIZER_MISSING', 'business', '日历组织者缺失',
    );
    const externalId = await this.identities.findBoundExternalUserId(
      delivery.tenantId, delivery.channel, employeeId,
    );
    if (externalId === null) throw new RecruitmentCalendarError(
      'CALENDAR_EXTERNAL_IDENTITY_PENDING', 'retryable', '日历参与人外部身份尚未就绪',
    );
    return externalId;
  }

  private async findCurrentExternalEventId(
    delivery: ClaimedCalendarDelivery,
  ): Promise<string | null> {
    const previous = await this.deliveries.findOne({
      tenantId: delivery.tenantId, channel: delivery.channel,
      externalCalendarId: delivery.externalCalendarId,
      interviewId: delivery.interviewId, action: 'upsert', status: 'succeeded',
      externalEventId: { $ne: null },
    }).sort({ interviewVersion: -1, succeededAt: -1 }).lean().exec();
    return previous?.externalEventId ?? null;
  }

  private async markSucceeded(
    delivery: ClaimedCalendarDelivery,
    workerId: string,
    externalEventId: string | null,
    now: Date,
  ): Promise<void> {
    const result = await this.deliveries.updateOne(
      { tenantId: delivery.tenantId, eventId: delivery.eventId, channel: delivery.channel,
        externalCalendarId: delivery.externalCalendarId,
        status: 'processing', lockedBy: workerId },
      { $set: {
        status: 'succeeded', externalEventId, succeededAt: now,
        lockedAt: null, lockedBy: null, lastErrorCode: null, lastErrorCategory: null,
      } },
      { timestamps: false },
    );
    if (result.matchedCount !== 1) throw new Error('CALENDAR_DELIVERY_CLAIM_LOST');
  }

  private async markFailed(
    delivery: ClaimedCalendarDelivery,
    workerId: string,
    error: unknown,
    now: Date,
  ): Promise<void> {
    const failure = this.failure(error);
    const attempts = delivery.attempts + 1;
    const retryable = failure.category === 'retryable' && attempts < MAX_ATTEMPTS;
    await this.deliveries.updateOne(
      { tenantId: delivery.tenantId, eventId: delivery.eventId, channel: delivery.channel,
        externalCalendarId: delivery.externalCalendarId,
        status: 'processing', lockedBy: workerId },
      { $set: {
        status: retryable ? 'pending' : 'manual_review', attempts,
        nextAttemptAt: retryable ? calculateNextAttemptAt(attempts, now) : now,
        lockedAt: null, lockedBy: null,
        lastErrorCode: failure.code, lastErrorCategory: failure.category,
      } },
      { timestamps: false },
    );
  }

  private failure(error: unknown): {
    readonly code: string; readonly category: RecruitmentCalendarFailureCategory;
  } {
    if (error instanceof RecruitmentCalendarError) {
      return { code: error.code, category: error.category };
    }
    if (error instanceof OrgPushError) return { code: error.code, category: error.category };
    return { code: 'CALENDAR_DELIVERY_UNEXPECTED', category: 'retryable' };
  }

  private idempotencyKey(delivery: ClaimedCalendarDelivery): string {
    return [
      delivery.tenantId, 'calendar', delivery.channel, delivery.interviewId,
      delivery.interviewVersion, delivery.action,
    ].join(':');
  }

  private externalId(value: string): string {
    if (value.length < 1 || value.length > 512) throw new RecruitmentCalendarError(
      'CALENDAR_EXTERNAL_EVENT_ID_INVALID', 'business', '日历外部事件标识无效',
    );
    return value;
  }

  private assertWorker(workerId: string, limit: number): void {
    if (!WORKER_ID_PATTERN.test(workerId)) throw new Error('calendar workerId 非法');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('calendar batch limit 必须为 1..100 的整数');
    }
  }
}
