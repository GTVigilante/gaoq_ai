import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { IdempotencyService } from '../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import {
  RecruitmentCalendarDeliveryRecord,
  type RecruitmentCalendarDeliveryAction,
  type RecruitmentCalendarDeliveryDocument,
} from './recruitment-calendar-delivery.schema.js';
import type { RecruitmentCalendarChannel } from './recruitment-calendar.adapter.js';

export type RecruitmentCalendarResolutionReason =
  | 'credentials_fixed'
  | 'identity_fixed'
  | 'provider_recovered'
  | 'approved_exception';

export type RecruitmentCalendarResolutionDecision = 'retry' | 'accept_succeeded';

const OUTCOME_UNKNOWN_CODES = Object.freeze([
  'CALENDAR_DELIVERY_OUTCOME_UNKNOWN',
  'CALENDAR_DELIVERY_STATE_UNAVAILABLE',
  'CALENDAR_EXTERNAL_EVENT_ID_INVALID',
  'DINGTALK_CALENDAR_RESULT_UNKNOWN',
  'FEISHU_CALENDAR_RESULT_UNKNOWN',
  'FEISHU_CALENDAR_ATTENDEES_OUTCOME_UNKNOWN',
]);

export interface RecruitmentCalendarDeliverySummary {
  readonly eventId: string;
  readonly channel: RecruitmentCalendarChannel;
  readonly externalCalendarId: string;
  readonly interviewId: string;
  readonly interviewVersion: number;
  readonly action: RecruitmentCalendarDeliveryAction;
  readonly status: 'manual_review' | 'dead';
  readonly attempts: number;
  readonly operatorResolutionCount: number;
  readonly lastErrorCode: string | null;
  readonly lastErrorCategory: string | null;
  readonly hasExternalEventId: boolean;
  readonly updatedAt: string;
}

/** 招聘日历人工处置服务；只返回核验所需元数据，不返回地点、参与人或平台凭据。 */
@Injectable()
export class RecruitmentCalendarOperationsService {
  constructor(
    @InjectModel(RecruitmentCalendarDeliveryRecord.name)
    private readonly deliveries: Model<RecruitmentCalendarDeliveryDocument>,
    private readonly context: TenantContextService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async listTerminal(input: {
    readonly status: 'manual_review' | 'dead';
    readonly channel?: RecruitmentCalendarChannel;
    readonly beforeEventId?: string;
    readonly limit: number;
  }): Promise<{
    readonly items: readonly RecruitmentCalendarDeliverySummary[];
    readonly nextCursor: string | null;
  }> {
    const tenantId = this.context.getTenantRequired().tenantId;
    const records = await this.deliveries.find(
      {
        tenantId,
        status: input.status,
        ...(input.channel === undefined ? {} : { channel: input.channel }),
        ...(input.beforeEventId === undefined ? {} : { eventId: { $lt: input.beforeEventId } }),
      },
      {
        eventId: 1, channel: 1, externalCalendarId: 1, interviewId: 1,
        interviewVersion: 1, action: 1, status: 1, attempts: 1,
        operatorResolutionCount: 1, lastErrorCode: 1, lastErrorCategory: 1,
        externalEventId: 1, updatedAt: 1, _id: 0,
      },
    ).sort({ eventId: -1 }).limit(input.limit + 1).lean().exec();
    const hasMore = records.length > input.limit;
    const page = records.slice(0, input.limit);
    return {
      items: page.map((record) => Object.freeze({
        eventId: record.eventId,
        channel: record.channel,
        externalCalendarId: record.externalCalendarId,
        interviewId: record.interviewId,
        interviewVersion: record.interviewVersion,
        action: record.action,
        status: record.status as 'manual_review' | 'dead',
        attempts: record.attempts,
        operatorResolutionCount: record.operatorResolutionCount ?? 0,
        lastErrorCode: record.lastErrorCode,
        lastErrorCategory: record.lastErrorCategory,
        hasExternalEventId: record.externalEventId !== null,
        updatedAt: record.updatedAt.toISOString(),
      })),
      nextCursor: hasMore ? page.at(-1)?.eventId ?? null : null,
    };
  }

  async resolve(input: {
    readonly eventId: string;
    readonly channel: RecruitmentCalendarChannel;
    readonly externalCalendarId: string;
    readonly decision: RecruitmentCalendarResolutionDecision;
    readonly reason: RecruitmentCalendarResolutionReason;
    readonly externalEventId?: string;
    readonly idempotencyKey: string;
  }): Promise<{
    readonly delivery: {
      readonly eventId: string;
      readonly channel: RecruitmentCalendarChannel;
      readonly decision: RecruitmentCalendarResolutionDecision;
      readonly status: 'pending' | 'succeeded';
      readonly reason: RecruitmentCalendarResolutionReason;
    };
  }> {
    if (input.decision === 'accept_succeeded' && input.externalEventId === undefined) {
      throw new BadRequestException({
        code: 'RECRUITMENT_CALENDAR_EXTERNAL_EVENT_ID_REQUIRED',
        message: '确认平台成功必须提供外部事件标识',
      });
    }
    const tenantId = this.context.getTenantRequired().tenantId;
    const status = input.decision === 'retry' ? 'pending' as const : 'succeeded' as const;
    return this.idempotency.execute(
      'integration.recruitment_calendar.resolve',
      input.idempotencyKey,
      {
        eventId: input.eventId,
        channel: input.channel,
        externalCalendarId: input.externalCalendarId,
        decision: input.decision,
        reason: input.reason,
        ...(input.externalEventId === undefined ? {} : { externalEventId: input.externalEventId }),
      },
      async (session) => {
        const now = new Date();
        const updated = await this.deliveries.findOneAndUpdate(
          {
            tenantId,
            eventId: input.eventId,
            channel: input.channel,
            externalCalendarId: input.externalCalendarId,
            status: { $in: ['manual_review', 'dead'] },
            ...(input.reason === 'approved_exception'
              ? {}
              : { lastErrorCode: { $nin: OUTCOME_UNKNOWN_CODES } }),
          },
          input.decision === 'retry'
            ? {
                $set: {
                  status,
                  attempts: 0,
                  nextAttemptAt: now,
                  lockedAt: null,
                  lockedBy: null,
                  succeededAt: null,
                  operatorResolvedAt: now,
                },
                $inc: { operatorResolutionCount: 1 },
              }
            : {
                $set: {
                  status,
                  externalEventId: input.externalEventId,
                  succeededAt: now,
                  lockedAt: null,
                  lockedBy: null,
                  lastErrorCode: null,
                  lastErrorCategory: null,
                  operatorResolvedAt: now,
                },
                $inc: { operatorResolutionCount: 1 },
              },
          { session, returnDocument: 'after', runValidators: true, timestamps: false },
        ).lean().exec();
        if (updated === null) {
          throw new NotFoundException({
            code: 'RECRUITMENT_CALENDAR_DELIVERY_NOT_RESOLVABLE',
            message: '日历投递不存在、状态不可处置或结果不确定任务缺少批准例外',
          });
        }
        return {
          delivery: {
            eventId: input.eventId,
            channel: input.channel,
            decision: input.decision,
            status,
            reason: input.reason,
          },
        };
      },
    );
  }
}
