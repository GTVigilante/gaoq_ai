import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  ApprovalNotificationRecord,
  type ApprovalNotificationChannel,
  type ApprovalNotificationDocument,
  type ApprovalNotificationStatus,
} from './approval-notification.schema.js';

export type ApprovalNotificationRetryReason =
  | 'credentials_fixed'
  | 'identity_bound'
  | 'provider_recovered'
  | 'approved_exception';

export interface ApprovalNotificationSummary {
  readonly notificationId: string;
  readonly instanceId: string;
  readonly aggregateVersion: number;
  readonly eventType: string;
  readonly recipientActorId: string;
  readonly channel: ApprovalNotificationChannel;
  readonly riskLevel: 'R1' | 'R2';
  readonly attempts: number;
  readonly operatorRetryCount: number;
  readonly lastErrorCode: string | null;
  readonly updatedAt: string;
}

/** 审批通知运维服务；所有读写固定绑定可信租户，不返回平台回执或正文。 */
@Injectable()
export class ApprovalNotificationOperationsService {
  constructor(
    @InjectModel(ApprovalNotificationRecord.name)
    private readonly records: Model<ApprovalNotificationDocument>,
    private readonly context: TenantContextService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async listDead(input: {
    readonly channel?: ApprovalNotificationChannel;
    readonly beforeNotificationId?: string;
    readonly limit: number;
  }): Promise<{ readonly items: readonly ApprovalNotificationSummary[]; readonly nextCursor: string | null }> {
    const tenantId = this.context.getTenantRequired().tenantId;
    const records = await this.records.find(
      {
        tenantId,
        status: 'dead',
        ...(input.channel === undefined ? {} : { channel: input.channel }),
        ...(input.beforeNotificationId === undefined
          ? {}
          : { notificationId: { $lt: input.beforeNotificationId } }),
      },
      {
        notificationId: 1, instanceId: 1, aggregateVersion: 1, eventType: 1,
        recipientActorId: 1, channel: 1, riskLevel: 1, attempts: 1,
        operatorRetryCount: 1, lastErrorCode: 1, updatedAt: 1, _id: 0,
      },
    ).sort({ notificationId: -1 }).limit(input.limit + 1).lean().exec();
    const page = records.slice(0, input.limit);
    return {
      items: page.map((record) => Object.freeze({
        notificationId: record.notificationId,
        instanceId: record.instanceId,
        aggregateVersion: record.aggregateVersion,
        eventType: record.eventType,
        recipientActorId: record.recipientActorId,
        channel: record.channel,
        riskLevel: record.riskLevel,
        attempts: record.attempts,
        operatorRetryCount: record.operatorRetryCount,
        lastErrorCode: record.lastErrorCode,
        updatedAt: record.updatedAt.toISOString(),
      })),
      nextCursor: records.length > input.limit ? page.at(-1)?.notificationId ?? null : null,
    };
  }

  async retry(
    notificationId: string,
    reason: ApprovalNotificationRetryReason,
    idempotencyKey: string,
  ): Promise<{ readonly notification: {
    readonly notificationId: string;
    readonly status: 'pending';
    readonly reason: ApprovalNotificationRetryReason;
  } }> {
    const tenantId = this.context.getTenantRequired().tenantId;
    return this.idempotency.execute(
      'approval.notification.retry',
      idempotencyKey,
      { notificationId, reason },
      async (session) => {
        const updated = await this.records.findOneAndUpdate(
          {
            tenantId,
            notificationId,
            status: 'dead',
            ...(reason === 'approved_exception'
              ? { lastErrorCode: 'APPROVAL_NOTIFICATION_DELIVERY_INDETERMINATE' }
              : {
                  lastErrorCode: {
                    $ne: 'APPROVAL_NOTIFICATION_DELIVERY_INDETERMINATE',
                  },
                }),
          },
          {
            $set: {
              status: 'pending', attempts: 0, nextAttemptAt: new Date(),
              lockedAt: null, lockedBy: null, externalMessageId: null,
              lastErrorCode: null, sentAt: null,
            },
            $inc: { operatorRetryCount: 1 },
          },
          { session, returnDocument: 'after', timestamps: false, runValidators: true },
        ).lean().exec();
        if (updated === null) throw new NotFoundException({
          code: 'APPROVAL_NOTIFICATION_NOT_RETRYABLE',
          message: '通知不存在或当前状态不可重试',
        });
        return { notification: { notificationId, status: 'pending' as const, reason } };
      },
    );
  }

  async reconciliation(): Promise<{
    readonly counts: Readonly<Record<ApprovalNotificationChannel, Readonly<Record<ApprovalNotificationStatus, number>>>>;
    readonly oldestPendingAt: string | null;
  }> {
    const tenantId = this.context.getTenantRequired().tenantId;
    const channels = ['dingtalk', 'feishu'] as const;
    const statuses = ['pending', 'processing', 'sent', 'dead'] as const;
    const values = await Promise.all(channels.flatMap((channel) =>
      statuses.map(async (status) => ({
        channel,
        status,
        count: await this.records.countDocuments({ tenantId, channel, status }),
      })),
    ));
    const oldest = await this.records.findOne(
      { tenantId, status: { $in: ['pending', 'processing'] } },
      { createdAt: 1, _id: 0 },
    ).sort({ createdAt: 1 }).lean().exec();
    const counts = {
      dingtalk: { pending: 0, processing: 0, sent: 0, dead: 0 },
      feishu: { pending: 0, processing: 0, sent: 0, dead: 0 },
    };
    for (const value of values) counts[value.channel][value.status] = value.count;
    return Object.freeze({
      counts: Object.freeze({
        dingtalk: Object.freeze(counts.dingtalk),
        feishu: Object.freeze(counts.feishu),
      }),
      oldestPendingAt: oldest?.createdAt.toISOString() ?? null,
    });
  }
}
