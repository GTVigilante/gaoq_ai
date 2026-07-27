import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { IdempotencyService } from '../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import {
  OrgDeliveryRecord,
  type OrgDeliveryChannel,
  type OrgDeliveryDocument,
  type OrgDeliveryStatus,
} from './org-delivery.schemas.js';

export type OrgDeliveryRetryReason =
  | 'credentials_fixed'
  | 'mapping_fixed'
  | 'provider_recovered'
  | 'approved_exception';

export interface OrgDeliverySummary {
  readonly eventId: string;
  readonly channel: OrgDeliveryChannel;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly status: OrgDeliveryStatus;
  readonly attempts: number;
  readonly operatorRetryCount: number;
  readonly lastErrorCode: string | null;
  readonly lastErrorCategory: string | null;
  readonly updatedAt: string;
}
/** 人工投递运维应用服务；所有查询由可信租户上下文强制加 tenantId。 */
@Injectable()
export class OrgDeliveryOperationsService {
  constructor(
    @InjectModel(OrgDeliveryRecord.name)
    private readonly deliveries: Model<OrgDeliveryDocument>,
    private readonly context: TenantContextService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async listTerminal(input: {
    readonly status: 'manual_review' | 'dead';
    readonly channel?: OrgDeliveryChannel;
    readonly beforeEventId?: string;
    readonly limit: number;
  }): Promise<{ readonly items: readonly OrgDeliverySummary[]; readonly nextCursor: string | null }> {
    const tenantId = this.context.getTenantRequired().tenantId;
    const records = await this.deliveries.find(
      {
        tenantId,
        status: input.status,
        ...(input.channel === undefined ? {} : { channel: input.channel }),
        ...(input.beforeEventId === undefined ? {} : { eventId: { $lt: input.beforeEventId } }),
      },
      {
        eventId: 1, channel: 1, aggregateType: 1, aggregateId: 1, aggregateVersion: 1,
        status: 1, attempts: 1, operatorRetryCount: 1,
        lastErrorCode: 1, lastErrorCategory: 1, updatedAt: 1, _id: 0,
      },
    ).sort({ eventId: -1 }).limit(input.limit + 1).lean().exec();
    const hasMore = records.length > input.limit;
    const page = records.slice(0, input.limit);
    return {
      items: page.map((item) => Object.freeze({
        eventId: item.eventId,
        channel: item.channel,
        aggregateType: item.aggregateType,
        aggregateId: item.aggregateId,
        aggregateVersion: item.aggregateVersion,
        status: item.status,
        attempts: item.attempts,
        operatorRetryCount: item.operatorRetryCount,
        lastErrorCode: item.lastErrorCode,
        lastErrorCategory: item.lastErrorCategory,
        updatedAt: item.updatedAt.toISOString(),
      })),
      nextCursor: hasMore ? page.at(-1)?.eventId ?? null : null,
    };
  }

  async retry(
    eventId: string,
    channel: OrgDeliveryChannel,
    reason: OrgDeliveryRetryReason,
    idempotencyKey: string,
  ): Promise<{ readonly delivery: { readonly eventId: string; readonly channel: OrgDeliveryChannel; readonly status: 'pending'; readonly reason: OrgDeliveryRetryReason } }> {
    const tenantId = this.context.getTenantRequired().tenantId;
    return this.idempotency.execute(
      'integration.org_delivery.retry',
      idempotencyKey,
      { eventId, channel, reason },
      async (session) => {
        const updated = await this.deliveries.findOneAndUpdate(
          {
            tenantId,
            eventId,
            channel,
            status: { $in: ['manual_review', 'dead'] },
            ...(reason === 'approved_exception'
              ? {}
              : { lastErrorCode: { $ne: 'ORG_DELIVERY_RESULT_INDETERMINATE' } }),
          },
          {
            $set: {
              status: 'pending', attempts: 0, nextAttemptAt: new Date(),
              lockedAt: null, lockedBy: null, succeededAt: null,
            },
            $inc: { operatorRetryCount: 1 },
          },
          { session, returnDocument: 'after', timestamps: false },
        ).lean().exec();
        if (updated === null) {
          throw new NotFoundException({
            code: 'ORG_DELIVERY_NOT_RETRYABLE',
            message: '投递不存在或当前状态不可重试',
          });
        }
        return { delivery: { eventId, channel, status: 'pending' as const, reason } };
      },
    );
  }
}
