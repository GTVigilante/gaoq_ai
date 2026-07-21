import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { AccessProfileRepository } from '../../identity/access-profile.repository.js';
import { ExternalIdentityRepository } from '../../identity/external-identity.repository.js';
import { OrgPlatformTokenService } from '../../integration/org-platform-token.service.js';
import { OrgPushError } from '../../integration/org-push.adapter.js';
import { ApprovalNotificationAdapterRegistry } from './approval-notification.adapter.js';
import {
  APPROVAL_NOTIFICATION_MAX_ATTEMPTS,
  nextApprovalNotificationAttemptAt,
} from './approval-notification.policy.js';
import {
  ApprovalNotificationRecord,
  type ApprovalNotificationChannel,
  type ApprovalNotificationDocument,
} from './approval-notification.schema.js';

const LEASE_MS = 5 * 60 * 1_000;
const WORKER_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

interface ClaimedApprovalNotification {
  readonly notificationId: string;
  readonly tenantId: string;
  readonly instanceId: string;
  readonly eventType: string;
  readonly recipientActorId: string;
  readonly channel: ApprovalNotificationChannel;
  readonly attempts: number;
}

class ApprovalNotificationDeliveryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ApprovalNotificationDeliveryError';
  }
}

/** 租约式通知投递；本服务不依赖审批聚合仓储，因此失败不可能修改审批业务状态。 */
@Injectable()
export class ApprovalNotificationDeliveryService {
  constructor(
    @InjectModel(ApprovalNotificationRecord.name)
    private readonly records: Model<ApprovalNotificationDocument>,
    private readonly profiles: AccessProfileRepository,
    private readonly identities: ExternalIdentityRepository,
    private readonly tokens: OrgPlatformTokenService,
    private readonly adapters: ApprovalNotificationAdapterRegistry,
  ) {}

  async processBatch(
    channel: ApprovalNotificationChannel,
    workerId: string,
    limit = 25,
  ): Promise<number> {
    if (!WORKER_PATTERN.test(workerId) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('审批通知 Worker 参数非法');
    }
    let sent = 0;
    for (let index = 0; index < limit; index += 1) {
      const claimed = await this.claimNext(channel, workerId, new Date());
      if (claimed === null) break;
      try {
        const externalMessageId = await this.deliver(claimed);
        await this.markSent(claimed, workerId, externalMessageId, new Date());
        sent += 1;
      } catch (error) {
        await this.markFailure(claimed, workerId, error, new Date());
      }
    }
    return sent;
  }

  private async claimNext(
    channel: ApprovalNotificationChannel,
    workerId: string,
    now: Date,
  ): Promise<ClaimedApprovalNotification | null> {
    const staleBefore = new Date(now.getTime() - LEASE_MS);
    const record = await this.records.findOneAndUpdate(
      {
        channel,
        nextAttemptAt: { $lte: now },
        $or: [
          { status: 'pending' },
          { status: 'processing', lockedAt: { $lt: staleBefore } },
        ],
      },
      { $set: { status: 'processing', lockedAt: now, lockedBy: workerId } },
      { sort: { nextAttemptAt: 1, createdAt: 1 }, returnDocument: 'after', runValidators: true },
    ).lean().exec();
    if (record === null) return null;
    return {
      notificationId: record.notificationId,
      tenantId: record.tenantId,
      instanceId: record.instanceId,
      eventType: record.eventType,
      recipientActorId: record.recipientActorId,
      channel: record.channel,
      attempts: record.attempts,
    };
  }

  private async deliver(claimed: ClaimedApprovalNotification): Promise<string> {
    const profile = await this.profiles.resolveActive(claimed.tenantId, claimed.recipientActorId);
    if (profile === null) throw new ApprovalNotificationDeliveryError('APPROVAL_RECIPIENT_INACTIVE');
    const access = await this.tokens.getAccess(claimed.tenantId, claimed.channel);
    const identity = await this.identities.findBoundByEmployee(
      claimed.tenantId,
      claimed.channel,
      access.externalTenantId,
      profile.employeeId,
    );
    if (identity === null || identity.actorId !== claimed.recipientActorId) {
      throw new ApprovalNotificationDeliveryError('APPROVAL_RECIPIENT_IDENTITY_UNBOUND');
    }
    try {
      const result = await this.adapters.get(claimed.channel).send({
        tenantId: claimed.tenantId,
        notificationId: claimed.notificationId,
        instanceId: claimed.instanceId,
        eventType: claimed.eventType,
        externalUserId: identity.externalUserId,
        access,
      });
      return result.externalMessageId;
    } catch (error) {
      if (error instanceof OrgPushError && error.status === 401) {
        this.tokens.invalidate(claimed.tenantId, claimed.channel, access.accessToken);
      }
      throw error;
    }
  }

  private async markSent(
    claimed: ClaimedApprovalNotification,
    workerId: string,
    externalMessageId: string,
    now: Date,
  ): Promise<void> {
    const result = await this.records.updateOne(
      { notificationId: claimed.notificationId, status: 'processing', lockedBy: workerId },
      {
        $set: {
          status: 'sent', sentAt: now, lockedAt: null, lockedBy: null,
          externalMessageId, lastErrorCode: null,
        },
      },
      { runValidators: true },
    );
    if (result.modifiedCount !== 1) throw new Error('审批通知租约已失效');
  }

  private async markFailure(
    claimed: ClaimedApprovalNotification,
    workerId: string,
    error: unknown,
    now: Date,
  ): Promise<void> {
    const attempts = Math.min(claimed.attempts + 1, APPROVAL_NOTIFICATION_MAX_ATTEMPTS);
    const business = error instanceof ApprovalNotificationDeliveryError ||
      (error instanceof OrgPushError && error.category === 'business' && error.status !== 401);
    const terminal = business || attempts >= APPROVAL_NOTIFICATION_MAX_ATTEMPTS;
    await this.records.updateOne(
      { notificationId: claimed.notificationId, status: 'processing', lockedBy: workerId },
      {
        $set: {
          status: terminal ? 'dead' : 'pending',
          attempts,
          nextAttemptAt: terminal ? now : nextApprovalNotificationAttemptAt(attempts, now),
          lockedAt: null,
          lockedBy: null,
          externalMessageId: null,
          lastErrorCode: safeErrorCode(error),
          sentAt: null,
        },
      },
      { runValidators: true },
    );
  }
}

function safeErrorCode(error: unknown): string {
  const code = error instanceof ApprovalNotificationDeliveryError || error instanceof OrgPushError
    ? error.code
    : 'APPROVAL_NOTIFICATION_UNKNOWN_ERROR';
  return /^[A-Z0-9_]{1,128}$/.test(code) ? code : 'APPROVAL_NOTIFICATION_UNKNOWN_ERROR';
}
