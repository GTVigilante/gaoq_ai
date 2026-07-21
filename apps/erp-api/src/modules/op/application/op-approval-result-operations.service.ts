import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  OpApprovalResultDeliveryRecord,
  type OpApprovalResultDeliveryDocument,
} from '../persistence/op.schemas.js';

export type OpApprovalResultRetryReason =
  | 'credentials_fixed'
  | 'route_fixed'
  | 'provider_recovered'
  | 'approved_exception';

export interface OpApprovalResultDeliveryView {
  readonly eventId: string;
  readonly externalEventId: string;
  readonly sourceDocumentType: string;
  readonly sourceDocumentId: string;
  readonly approvalInstanceId: string;
  readonly approvalVersion: number;
  readonly result: 'approved' | 'rejected' | 'withdrawn';
  readonly status: 'manual_review' | 'dead';
  readonly attempts: number;
  readonly operatorRetryCount: number;
  readonly lastErrorCode: string | null;
  readonly updatedAt: string;
}

/** OP 审批结果投递运维服务；查询与重试均绑定可信租户上下文。 */
@Injectable()
export class OpApprovalResultOperationsService {
  constructor(
    @InjectModel(OpApprovalResultDeliveryRecord.name)
    private readonly deliveries: Model<OpApprovalResultDeliveryDocument>,
    private readonly context: TenantContextService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async listTerminal(input: {
    readonly status: 'manual_review' | 'dead';
    readonly beforeEventId?: string;
    readonly limit: number;
  }): Promise<{ readonly items: readonly OpApprovalResultDeliveryView[]; readonly nextCursor: string | null }> {
    const tenantId = this.context.getTenantRequired().tenantId;
    const records = await this.deliveries.find({
      tenantId, status: input.status,
      ...(input.beforeEventId === undefined ? {} : { eventId: { $lt: input.beforeEventId } }),
    }, {
      eventId: 1, externalEventId: 1, sourceDocumentType: 1, sourceDocumentId: 1,
      approvalInstanceId: 1, approvalVersion: 1, result: 1, status: 1, attempts: 1,
      operatorRetryCount: 1, lastErrorCode: 1, updatedAt: 1, _id: 0,
    }).sort({ eventId: -1 }).limit(input.limit + 1).lean().exec();
    const page = records.slice(0, input.limit);
    return Object.freeze({
      items: page.map((record) => Object.freeze({
        eventId: record.eventId,
        externalEventId: record.externalEventId,
        sourceDocumentType: record.sourceDocumentType,
        sourceDocumentId: record.sourceDocumentId,
        approvalInstanceId: record.approvalInstanceId,
        approvalVersion: record.approvalVersion,
        result: record.result,
        status: record.status as 'manual_review' | 'dead',
        attempts: record.attempts,
        operatorRetryCount: record.operatorRetryCount,
        lastErrorCode: record.lastErrorCode,
        updatedAt: record.updatedAt.toISOString(),
      })),
      nextCursor: records.length > input.limit ? page.at(-1)?.eventId ?? null : null,
    });
  }

  async retry(
    eventId: string,
    reason: OpApprovalResultRetryReason,
    idempotencyKey: string,
  ): Promise<{ readonly delivery: { readonly eventId: string; readonly status: 'pending'; readonly reason: OpApprovalResultRetryReason } }> {
    const tenantId = this.context.getTenantRequired().tenantId;
    return this.idempotency.execute(
      'op.approval_result.retry', idempotencyKey, { eventId, reason }, async (session) => {
        const updated = await this.deliveries.findOneAndUpdate({
          tenantId, eventId, status: { $in: ['manual_review', 'dead'] },
        }, {
          $set: {
            status: 'pending', attempts: 0, nextAttemptAt: new Date(),
            lockedAt: null, lockedBy: null, succeededAt: null, lastErrorCode: null,
          },
          $inc: { operatorRetryCount: 1 },
        }, {
          session, returnDocument: 'after', timestamps: false, runValidators: true,
        }).lean().exec();
        if (updated === null) throw new NotFoundException({
          code: 'OP_APPROVAL_RESULT_NOT_RETRYABLE',
          message: 'OP 审批结果投递不存在或当前状态不可重试',
        });
        return { delivery: { eventId, status: 'pending' as const, reason } };
      },
    );
  }
}
