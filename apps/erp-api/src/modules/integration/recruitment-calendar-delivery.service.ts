import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { Model } from 'mongoose';

import { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { RecruitmentInterviewService } from '../recruitment/application/recruitment-interview.service.js';
import { calculateNextAttemptAt } from './org-delivery.policy.js';
import { OrgExternalIdentityResolver } from './org-external-identity.resolver.js';
import { OrgPushError } from './org-push.adapter.js';
import {
  RecruitmentCalendarAdapterRegistry,
  RecruitmentCalendarError,
  assertRecruitmentCalendarExternalEventId,
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
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CALENDAR_ID_PATTERN = /^[\x21-\x7E]{1,256}$/;
const EXTERNAL_EVENT_ID_PATTERN = /^[\x21-\x7E]{1,512}$/;
const ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,128}$/;

/** 平台或本地终态可能已经提交；禁止进入通用失败回写或自动重放。 */
class RecruitmentCalendarPostCommitError extends Error {}

interface ClaimedCalendarDelivery {
  readonly eventId: string;
  readonly tenantId: string;
  readonly channel: RecruitmentCalendarChannel;
  readonly externalCalendarId: string;
  readonly interviewId: string;
  readonly interviewVersion: number;
  readonly action: RecruitmentCalendarDeliveryAction;
  readonly attempts: number;
  readonly externalEventId: string | null;
}

interface CalendarDeliveryOutcome {
  readonly externalEventId: string | null;
  readonly platformCommitted: boolean;
  readonly result: 'succeeded' | 'superseded' | 'skipped';
}

/** 日历投递消费者；平台失败不修改 Recruitment 权威排期。 */
@Injectable()
export class RecruitmentCalendarDeliveryService {
  constructor(
    @InjectModel(RecruitmentCalendarDeliveryRecord.name)
    private readonly deliveries: Model<RecruitmentCalendarDeliveryDocument>,
    private readonly context: TenantContextService,
    private readonly audit: AuditService,
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
    await this.quarantineStaleProcessing(channel, new Date());
    let succeeded = 0;
    for (let index = 0; index < limit; index += 1) {
      const delivery = await this.claimNext(channel, workerId, new Date());
      if (delivery === null) break;
      try {
        this.assertClaim(delivery, channel);
        const outcome = await this.context.run(
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
        try {
          await this.markSucceeded(delivery, workerId, outcome.externalEventId, new Date());
        } catch {
          if (outcome.platformCommitted) {
            try {
              await this.markOutcomeUnknown(
                delivery,
                workerId,
                outcome.externalEventId,
                new Date(),
                'CALENDAR_DELIVERY_STATE_UNAVAILABLE',
              );
            } catch {
              // 原租约或数据库均可能不可用；只允许停止批次，禁止再执行通用失败回写。
            }
          }
          throw new RecruitmentCalendarPostCommitError('日历投递终态无法确认');
        }
        succeeded += 1;
        try {
          await this.auditSuccess(delivery, outcome.result);
        } catch {
          throw new RecruitmentCalendarPostCommitError('日历投递已提交但审计不可用');
        }
      } catch (error) {
        if (error instanceof RecruitmentCalendarPostCommitError) throw error;
        await this.markFailed(delivery, workerId, error, new Date());
        try {
          await this.auditFailure(delivery, error);
        } catch {
          throw new RecruitmentCalendarPostCommitError('日历投递失败终态已提交但审计不可用');
        }
      }
    }
    return succeeded;
  }

  private async claimNext(
    channel: RecruitmentCalendarChannel,
    workerId: string,
    now: Date,
  ): Promise<ClaimedCalendarDelivery | null> {
    const record = await this.deliveries.findOneAndUpdate(
      {
        channel,
        status: 'pending',
        nextAttemptAt: { $lte: now },
      },
      { $set: { status: 'processing', lockedAt: now, lockedBy: workerId } },
      { sort: { createdAt: 1 }, returnDocument: 'after', runValidators: true },
    ).lean().exec();
    return record === null ? null : {
      eventId: record.eventId, tenantId: record.tenantId, channel: record.channel,
      externalCalendarId: record.externalCalendarId,
      interviewId: record.interviewId, interviewVersion: record.interviewVersion,
      action: record.action, attempts: record.attempts,
      externalEventId: record.externalEventId ?? null,
    };
  }

  private async deliver(delivery: ClaimedCalendarDelivery): Promise<CalendarDeliveryOutcome> {
    const projection = await this.interviews.getCalendarProjectionForIntegration(
      delivery.interviewId,
    );
    const currentExternalEventId = await this.findCurrentExternalEventId(delivery);
    this.assertProjectionIdentity(delivery, projection);
    if (projection.version > delivery.interviewVersion) {
      return {
        externalEventId: currentExternalEventId,
        platformCommitted: false,
        result: 'superseded',
      };
    }
    if (projection.version < delivery.interviewVersion) {
      throw new RecruitmentCalendarError(
        'CALENDAR_PROJECTION_VERSION_INVALID',
        'conflict',
        '日历投影版本落后于投递版本',
      );
    }
    if (delivery.action === 'cancel') {
      if (currentExternalEventId === null) {
        return { externalEventId: null, platformCommitted: false, result: 'skipped' };
      }
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
      return {
        externalEventId: this.externalId(result.externalEventId),
        platformCommitted: true,
        result: 'succeeded',
      };
    }
    if (projection.status !== 'scheduled') {
      return {
        externalEventId: currentExternalEventId,
        platformCommitted: false,
        result: 'skipped',
      };
    }
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
    return {
      externalEventId: this.externalId(result.externalEventId),
      platformCommitted: true,
      result: 'succeeded',
    };
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
    if (delivery.externalEventId !== null) return this.externalId(delivery.externalEventId);
    const previous = await this.deliveries.findOne({
      tenantId: delivery.tenantId, channel: delivery.channel,
      externalCalendarId: delivery.externalCalendarId,
      interviewId: delivery.interviewId, action: 'upsert', status: 'succeeded',
      externalEventId: { $ne: null },
    }).sort({ interviewVersion: -1, succeededAt: -1 }).lean().exec();
    const externalEventId = previous?.externalEventId ?? null;
    return externalEventId === null ? null : this.externalId(externalEventId);
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
    const attempts = this.nextAttempts(delivery.attempts);
    const retryable = failure.category === 'retryable' && attempts < MAX_ATTEMPTS;
    const status = retryable
      ? 'pending'
      : failure.category === 'retryable' ? 'dead' : 'manual_review';
    const result = await this.deliveries.updateOne(
      { tenantId: delivery.tenantId, eventId: delivery.eventId, channel: delivery.channel,
        externalCalendarId: delivery.externalCalendarId,
        status: 'processing', lockedBy: workerId },
      { $set: {
        status, attempts,
        nextAttemptAt: retryable ? calculateNextAttemptAt(attempts, now) : now,
        lockedAt: null, lockedBy: null,
        lastErrorCode: this.safeErrorCode(failure.code), lastErrorCategory: failure.category,
        ...(error instanceof RecruitmentCalendarError && error.externalEventId !== undefined
          ? { externalEventId: this.externalId(error.externalEventId) }
          : {}),
      } },
      { timestamps: false },
    );
    if (result.matchedCount !== 1) throw new Error('CALENDAR_DELIVERY_CLAIM_LOST');
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
    return assertRecruitmentCalendarExternalEventId(value);
  }

  private async quarantineStaleProcessing(
    channel: RecruitmentCalendarChannel,
    now: Date,
  ): Promise<void> {
    await this.deliveries.updateMany(
      {
        channel,
        status: 'processing',
        lockedAt: { $lt: new Date(now.getTime() - LOCK_TIMEOUT_MS) },
      },
      {
        $set: {
          status: 'manual_review',
          nextAttemptAt: now,
          lockedAt: null,
          lockedBy: null,
          lastErrorCode: 'CALENDAR_DELIVERY_OUTCOME_UNKNOWN',
          lastErrorCategory: 'conflict',
        },
      },
      { timestamps: false },
    );
  }

  private async markOutcomeUnknown(
    delivery: ClaimedCalendarDelivery,
    workerId: string,
    externalEventId: string | null,
    now: Date,
    code: string,
  ): Promise<void> {
    const result = await this.deliveries.updateOne(
      {
        tenantId: delivery.tenantId,
        eventId: delivery.eventId,
        channel: delivery.channel,
        externalCalendarId: delivery.externalCalendarId,
        status: 'processing',
        lockedBy: workerId,
      },
      {
        $set: {
          status: 'manual_review',
          attempts: this.nextAttempts(delivery.attempts),
          nextAttemptAt: now,
          lockedAt: null,
          lockedBy: null,
          externalEventId,
          lastErrorCode: code,
          lastErrorCategory: 'conflict',
        },
      },
      { timestamps: false },
    );
    if (result.matchedCount !== 1) throw new Error('CALENDAR_DELIVERY_CLAIM_LOST');
  }

  private assertClaim(
    delivery: ClaimedCalendarDelivery,
    requestedChannel: RecruitmentCalendarChannel,
  ): void {
    if (
      !ULID_PATTERN.test(delivery.eventId) ||
      !ID_PATTERN.test(delivery.tenantId) ||
      delivery.channel !== requestedChannel ||
      (delivery.channel !== 'dingtalk' && delivery.channel !== 'feishu') ||
      !CALENDAR_ID_PATTERN.test(delivery.externalCalendarId) ||
      !ULID_PATTERN.test(delivery.interviewId) ||
      !Number.isSafeInteger(delivery.interviewVersion) ||
      delivery.interviewVersion < 1 ||
      (delivery.action !== 'upsert' && delivery.action !== 'cancel') ||
      !Number.isInteger(delivery.attempts) ||
      delivery.attempts < 0 ||
      delivery.attempts >= MAX_ATTEMPTS ||
      (delivery.externalEventId !== null &&
        !EXTERNAL_EVENT_ID_PATTERN.test(delivery.externalEventId))
    ) {
      throw new RecruitmentCalendarError(
        'CALENDAR_DELIVERY_RECORD_INVALID',
        'business',
        '招聘日历投递记录无效',
      );
    }
  }

  private assertProjectionIdentity(
    delivery: ClaimedCalendarDelivery,
    projection: {
      readonly interviewId: string;
      readonly version: number;
      readonly status: string;
      readonly interviewerIds: readonly string[];
    },
  ): void {
    if (
      projection.interviewId !== delivery.interviewId ||
      !Number.isSafeInteger(projection.version) ||
      projection.version < 1 ||
      !['scheduled', 'completed', 'cancelled'].includes(projection.status) ||
      !Array.isArray(projection.interviewerIds) ||
      projection.interviewerIds.length < 1 ||
      projection.interviewerIds.length > 100 ||
      projection.interviewerIds.some(
        (employeeId: unknown) => typeof employeeId !== 'string' || !ID_PATTERN.test(employeeId),
      ) ||
      new Set(projection.interviewerIds).size !== projection.interviewerIds.length
    ) {
      throw new RecruitmentCalendarError(
        'CALENDAR_PROJECTION_INVALID',
        'conflict',
        '招聘日历投影无效',
      );
    }
  }

  private nextAttempts(value: number): number {
    const attempts = Number.isInteger(value) && value >= 0 && value < MAX_ATTEMPTS
      ? value
      : MAX_ATTEMPTS - 1;
    return Math.min(attempts + 1, MAX_ATTEMPTS);
  }

  private safeErrorCode(value: string): string {
    return ERROR_CODE_PATTERN.test(value) ? value : 'CALENDAR_DELIVERY_FAILED';
  }

  private async auditSuccess(
    delivery: ClaimedCalendarDelivery,
    result: CalendarDeliveryOutcome['result'],
  ): Promise<void> {
    await this.audit.recordSystem(delivery.tenantId, {
      action: 'integration.recruitment_calendar.deliver',
      resourceType: 'recruitment_interview',
      resourceId: delivery.interviewId,
      riskLevel: 'R2',
      outcome: 'success',
      traceId: delivery.eventId,
      metadata: {
        channel: delivery.channel,
        action: delivery.action,
        interviewVersion: delivery.interviewVersion,
        result,
      },
    });
  }

  private async auditFailure(
    delivery: ClaimedCalendarDelivery,
    error: unknown,
  ): Promise<void> {
    const failure = this.failure(error);
    await this.audit.recordSystem(delivery.tenantId, {
      action: 'integration.recruitment_calendar.deliver',
      resourceType: 'recruitment_interview',
      resourceId: delivery.interviewId,
      riskLevel: 'R2',
      outcome: 'failure',
      traceId: delivery.eventId,
      metadata: {
        channel: delivery.channel,
        action: delivery.action,
        interviewVersion: delivery.interviewVersion,
        failureCode: this.safeErrorCode(failure.code),
        failureCategory: failure.category,
      },
    });
  }

  private assertWorker(workerId: string, limit: number): void {
    if (!WORKER_ID_PATTERN.test(workerId)) throw new Error('calendar workerId 非法');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('calendar batch limit 必须为 1..100 的整数');
    }
  }
}
