import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { IdempotencyService } from '../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import {
  RecruitmentChannelPositionDeliveryRecord,
  type RecruitmentChannelPositionDeliveryDocument,
  RecruitmentChannelStageDeliveryRecord,
  type RecruitmentChannelStageDeliveryDocument,
} from './recruitment-channel.schemas.js';

export type RecruitmentChannelDeliveryKind = 'position' | 'stage';
export type RecruitmentChannelResolutionReason =
  | 'credentials_fixed'
  | 'mapping_fixed'
  | 'provider_recovered'
  | 'approved_exception';

const OUTCOME_UNKNOWN_CODES = Object.freeze([
  'RECRUITMENT_CHANNEL_POSITION_OUTCOME_UNKNOWN',
  'RECRUITMENT_CHANNEL_POSITION_PUBLISH_OUTCOME_UNKNOWN',
  'RECRUITMENT_CHANNEL_POSITION_CLOSE_OUTCOME_UNKNOWN',
  'RECRUITMENT_CHANNEL_POSITION_PUBLISH_STATE_UNAVAILABLE',
  'RECRUITMENT_CHANNEL_POSITION_CLOSE_STATE_UNAVAILABLE',
  'RECRUITMENT_CHANNEL_POSITION_FINALIZE_UNAVAILABLE',
  'RECRUITMENT_CHANNEL_STAGE_OUTCOME_UNKNOWN',
  'RECRUITMENT_CHANNEL_STAGE_FINALIZE_UNAVAILABLE',
]);

export interface RecruitmentChannelDeliverySummary {
  readonly kind: RecruitmentChannelDeliveryKind;
  readonly eventId: string;
  readonly resourceId: string;
  readonly version: number;
  readonly operation: string;
  readonly status: 'manual_review' | 'dead';
  readonly attempts: number;
  readonly operatorResolutionCount: number;
  readonly failureCode: string | null;
  readonly updatedAt: string;
}

/** 招聘渠道人工处置；只允许经批准确认“未提交”后重新入队，不代替供应商对账。 */
@Injectable()
export class RecruitmentChannelOperationsService {
  constructor(
    @InjectModel(RecruitmentChannelPositionDeliveryRecord.name)
    private readonly positions: Model<RecruitmentChannelPositionDeliveryDocument>,
    @InjectModel(RecruitmentChannelStageDeliveryRecord.name)
    private readonly stages: Model<RecruitmentChannelStageDeliveryDocument>,
    private readonly context: TenantContextService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async listTerminal(input: {
    readonly kind: RecruitmentChannelDeliveryKind;
    readonly status: 'manual_review' | 'dead';
    readonly beforeEventId?: string;
    readonly limit: number;
  }): Promise<{
    readonly items: readonly RecruitmentChannelDeliverySummary[];
    readonly nextCursor: string | null;
  }> {
    const tenantId = this.context.getTenantRequired().tenantId;
    const filter = {
      tenantId,
      status: input.status,
      ...(input.beforeEventId === undefined ? {} : { eventId: { $lt: input.beforeEventId } }),
    };
    const records = input.kind === 'position'
      ? await this.positions.find(
          filter,
          {
            eventId: 1, positionId: 1, positionVersion: 1, action: 1, targetStatus: 1,
            status: 1, attempts: 1, operatorResolutionCount: 1, failureCode: 1,
            updatedAt: 1, _id: 0,
          },
        ).sort({ eventId: -1 }).limit(input.limit + 1).lean().exec()
      : await this.stages.find(
          filter,
          {
            eventId: 1, applicationId: 1, applicationVersion: 1, stage: 1,
            status: 1, attempts: 1, operatorResolutionCount: 1, failureCode: 1,
            updatedAt: 1, _id: 0,
          },
        ).sort({ eventId: -1 }).limit(input.limit + 1).lean().exec();
    const hasMore = records.length > input.limit;
    const page = records.slice(0, input.limit);
    const items = page.map((record) => input.kind === 'position'
      ? this.positionSummary(record as RecruitmentChannelPositionDeliveryRecord)
      : this.stageSummary(record as RecruitmentChannelStageDeliveryRecord));
    return {
      items: Object.freeze(items),
      nextCursor: hasMore ? page.at(-1)?.eventId ?? null : null,
    };
  }

  async retry(input: {
    readonly kind: RecruitmentChannelDeliveryKind;
    readonly eventId: string;
    readonly reason: RecruitmentChannelResolutionReason;
    readonly providerConfirmedNotCommitted: boolean;
    readonly idempotencyKey: string;
  }): Promise<{
    readonly delivery: {
      readonly kind: RecruitmentChannelDeliveryKind;
      readonly eventId: string;
      readonly status: 'pending';
      readonly reason: RecruitmentChannelResolutionReason;
    };
  }> {
    const tenantId = this.context.getTenantRequired().tenantId;
    return this.idempotency.execute(
      'integration.recruitment_channel.retry',
      input.idempotencyKey,
      {
        kind: input.kind,
        eventId: input.eventId,
        reason: input.reason,
        providerConfirmedNotCommitted: input.providerConfirmedNotCommitted,
      },
      async (session) => {
        const updated = input.kind === 'position'
          ? await this.retryPosition(tenantId, input, session)
          : await this.retryStage(tenantId, input, session);
        if (!updated) throw new NotFoundException({
          code: 'RECRUITMENT_CHANNEL_DELIVERY_NOT_RESOLVABLE',
          message: '投递不存在、状态不可处置，或结果未知任务缺少“供应商确认未提交”的批准例外',
        });
        return {
          delivery: {
            kind: input.kind,
            eventId: input.eventId,
            status: 'pending' as const,
            reason: input.reason,
          },
        };
      },
    );
  }

  private async retryPosition(
    tenantId: string,
    input: {
      readonly eventId: string;
      readonly reason: RecruitmentChannelResolutionReason;
      readonly providerConfirmedNotCommitted: boolean;
    },
    session: ClientSession,
  ): Promise<boolean> {
    const approvedUnknownRetry =
      input.reason === 'approved_exception' && input.providerConfirmedNotCommitted;
    const record = approvedUnknownRetry
      ? await this.positions.findOneAndUpdate(
          {
            tenantId, eventId: input.eventId,
            status: { $in: ['manual_review', 'dead'] },
          },
          this.retryUpdate(),
          { session, returnDocument: 'after', runValidators: true },
        ).lean().exec()
      : await this.positions.findOneAndUpdate(
          {
            tenantId, eventId: input.eventId, status: 'dead',
            failureCode: { $nin: [...OUTCOME_UNKNOWN_CODES] },
          },
          this.retryUpdate(),
          { session, returnDocument: 'after', runValidators: true },
        ).lean().exec();
    return record !== null;
  }

  private async retryStage(
    tenantId: string,
    input: {
      readonly eventId: string;
      readonly reason: RecruitmentChannelResolutionReason;
      readonly providerConfirmedNotCommitted: boolean;
    },
    session: ClientSession,
  ): Promise<boolean> {
    const approvedUnknownRetry =
      input.reason === 'approved_exception' && input.providerConfirmedNotCommitted;
    const record = approvedUnknownRetry
      ? await this.stages.findOneAndUpdate(
          {
            tenantId, eventId: input.eventId,
            status: { $in: ['manual_review', 'dead'] },
          },
          this.retryUpdate(),
          { session, returnDocument: 'after', runValidators: true },
        ).lean().exec()
      : await this.stages.findOneAndUpdate(
          {
            tenantId, eventId: input.eventId, status: 'dead',
            failureCode: { $nin: [...OUTCOME_UNKNOWN_CODES] },
          },
          this.retryUpdate(),
          { session, returnDocument: 'after', runValidators: true },
        ).lean().exec();
    return record !== null;
  }

  private retryUpdate() {
    const now = new Date();
    return {
      $set: {
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        lockedAt: null,
        lockedBy: null,
        succeededAt: null,
        operatorResolvedAt: now,
      },
      $inc: { operatorResolutionCount: 1 },
    };
  }

  private positionSummary(
    record: RecruitmentChannelPositionDeliveryRecord,
  ): RecruitmentChannelDeliverySummary {
    return Object.freeze({
      kind: 'position',
      eventId: record.eventId,
      resourceId: record.positionId,
      version: record.positionVersion,
      operation: `${record.action}:${record.targetStatus}`,
      status: record.status as 'manual_review' | 'dead',
      attempts: record.attempts,
      operatorResolutionCount: record.operatorResolutionCount ?? 0,
      failureCode: record.failureCode,
      updatedAt: record.updatedAt.toISOString(),
    });
  }

  private stageSummary(
    record: RecruitmentChannelStageDeliveryRecord,
  ): RecruitmentChannelDeliverySummary {
    return Object.freeze({
      kind: 'stage',
      eventId: record.eventId,
      resourceId: record.applicationId,
      version: record.applicationVersion,
      operation: record.stage,
      status: record.status as 'manual_review' | 'dead',
      attempts: record.attempts,
      operatorResolutionCount: record.operatorResolutionCount ?? 0,
      failureCode: record.failureCode,
      updatedAt: record.updatedAt.toISOString(),
    });
  }
}
