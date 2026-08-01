import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { Model, QueryFilter } from 'mongoose';

import { elapsedSeconds, MetricsService } from '../../../core/observability/metrics.service.js';
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
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EVENT_TYPES = new Set([
  'instance.submitted',
  'instance.decided',
  'instance.approver_transferred',
  'instance.approver_added',
  'instance.withdrawn',
]);

interface ClaimedApprovalNotification {
  readonly notificationId: string;
  readonly tenantId: string;
  readonly instanceId: string;
  readonly aggregateVersion: number;
  readonly eventType: string;
  readonly recipientActorId: string;
  readonly channel: ApprovalNotificationChannel;
  readonly riskLevel: 'R1' | 'R2';
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
    private readonly metrics: MetricsService,
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
      const now = new Date();
      if (
        channel === 'dingtalk' &&
        await this.quarantineIndeterminateDingTalk(now)
      ) {
        this.metrics.recordApprovalNotification(channel, 'dead', 0);
        continue;
      }
      const claimed = await this.claimNext(channel, workerId, now);
      if (claimed === null) break;
      const startedAt = process.hrtime.bigint();
      let externalMessageId: string;
      try {
        assertClaimedNotification(claimed, channel);
        externalMessageId = await this.deliver(claimed);
      } catch (error) {
        const outcome = await this.markFailure(claimed, workerId, error, new Date());
        this.metrics.recordApprovalNotification(channel, outcome, elapsedSeconds(startedAt));
        continue;
      }
      try {
        await this.markSent(claimed, workerId, externalMessageId, new Date());
      } catch (error) {
        this.metrics.recordApprovalNotification(
          channel,
          'state_unavailable',
          elapsedSeconds(startedAt),
        );
        throw error;
      }
      sent += 1;
      this.metrics.recordApprovalNotification(channel, 'sent', elapsedSeconds(startedAt));
    }
    return sent;
  }

  private async claimNext(
    channel: ApprovalNotificationChannel,
    workerId: string,
    now: Date,
  ): Promise<ClaimedApprovalNotification | null> {
    const staleBefore = new Date(now.getTime() - LEASE_MS);
    const filter: QueryFilter<ApprovalNotificationDocument> = {
      channel,
      nextAttemptAt: { $lte: now },
      $or: channel === 'feishu'
        ? [
            { status: 'pending' },
            { status: 'processing', lockedAt: { $lt: staleBefore } },
          ]
        : [{ status: 'pending' }],
    };
    let record: ApprovalNotificationDocument | null;
    try {
      record = await this.records.findOneAndUpdate(
        filter,
        { $set: { status: 'processing', lockedAt: now, lockedBy: workerId } },
        { sort: { nextAttemptAt: 1, createdAt: 1 }, returnDocument: 'after', runValidators: true },
      ).lean().exec();
    } catch {
      throw new Error('APPROVAL_NOTIFICATION_STORE_UNAVAILABLE');
    }
    if (record === null) return null;
    return {
      notificationId: record.notificationId,
      tenantId: record.tenantId,
      instanceId: record.instanceId,
      aggregateVersion: record.aggregateVersion,
      eventType: record.eventType,
      recipientActorId: record.recipientActorId,
      channel: record.channel,
      riskLevel: record.riskLevel,
      attempts: record.attempts,
    };
  }

  /**
   * 钉钉直连发送没有已验证的请求幂等契约。过期 processing 可能已完成平台发送，
   * 因此不得自动重领；必须进入结果不确定死信，经平台对账和 R2 人工例外后重试。
   */
  private async quarantineIndeterminateDingTalk(now: Date): Promise<boolean> {
    let record: ApprovalNotificationDocument | null;
    try {
      record = await this.records.findOneAndUpdate(
        {
          channel: 'dingtalk',
          status: 'processing',
          lockedAt: { $lt: new Date(now.getTime() - LEASE_MS) },
        },
        {
          $set: {
            status: 'dead',
            nextAttemptAt: now,
            lockedAt: null,
            lockedBy: null,
            externalMessageId: null,
            lastErrorCode: 'APPROVAL_NOTIFICATION_DELIVERY_INDETERMINATE',
            sentAt: null,
          },
        },
        {
          sort: { lockedAt: 1, createdAt: 1 },
          returnDocument: 'after',
          runValidators: true,
        },
      ).lean().exec();
    } catch {
      throw new Error('APPROVAL_NOTIFICATION_STORE_UNAVAILABLE');
    }
    return record !== null;
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
    let result: { readonly matchedCount: number };
    try {
      result = await this.records.updateOne(
        {
          notificationId: claimed.notificationId,
          status: 'processing',
          lockedBy: workerId,
          attempts: claimed.attempts,
        },
        {
          $set: {
            status: 'sent', sentAt: now, lockedAt: null, lockedBy: null,
            externalMessageId, lastErrorCode: null,
          },
        },
        { runValidators: true },
      );
    } catch {
      throw new Error('APPROVAL_NOTIFICATION_STORE_UNAVAILABLE');
    }
    if (result.matchedCount !== 1) {
      throw new Error('APPROVAL_NOTIFICATION_DELIVERY_LEASE_LOST');
    }
  }

  private async markFailure(
    claimed: ClaimedApprovalNotification,
    workerId: string,
    error: unknown,
    now: Date,
  ): Promise<'retry' | 'dead'> {
    const attempts = Number.isSafeInteger(claimed.attempts) && claimed.attempts >= 0
      ? Math.min(claimed.attempts + 1, APPROVAL_NOTIFICATION_MAX_ATTEMPTS)
      : APPROVAL_NOTIFICATION_MAX_ATTEMPTS;
    const indeterminate = claimed.channel === 'dingtalk' &&
      isIndeterminateDingTalkError(error);
    const business = error instanceof ApprovalNotificationDeliveryError ||
      (error instanceof OrgPushError && error.category === 'business' && error.status !== 401);
    const terminal = indeterminate || business ||
      attempts >= APPROVAL_NOTIFICATION_MAX_ATTEMPTS;
    let result: { readonly matchedCount: number };
    try {
      result = await this.records.updateOne(
        {
          notificationId: claimed.notificationId,
          status: 'processing',
          lockedBy: workerId,
          attempts: claimed.attempts,
        },
        {
          $set: {
            status: terminal ? 'dead' : 'pending',
            attempts,
            nextAttemptAt: terminal ? now : nextApprovalNotificationAttemptAt(attempts, now),
            lockedAt: null,
            lockedBy: null,
            externalMessageId: null,
            lastErrorCode: indeterminate
              ? 'APPROVAL_NOTIFICATION_DELIVERY_INDETERMINATE'
              : safeErrorCode(error),
            sentAt: null,
          },
        },
        { runValidators: true },
      );
    } catch {
      throw new Error('APPROVAL_NOTIFICATION_STORE_UNAVAILABLE');
    }
    if (result.matchedCount !== 1) {
      throw new Error('APPROVAL_NOTIFICATION_RELEASE_LEASE_LOST');
    }
    return terminal ? 'dead' : 'retry';
  }
}

function assertClaimedNotification(
  claimed: ClaimedApprovalNotification,
  expectedChannel: ApprovalNotificationChannel,
): void {
  if (
    !ULID_PATTERN.test(claimed.notificationId) ||
    !ID_PATTERN.test(claimed.tenantId) ||
    !ID_PATTERN.test(claimed.instanceId) ||
    !ID_PATTERN.test(claimed.recipientActorId) ||
    !Number.isSafeInteger(claimed.aggregateVersion) ||
    claimed.aggregateVersion < 1 ||
    !EVENT_TYPES.has(claimed.eventType) ||
    claimed.channel !== expectedChannel ||
    (claimed.riskLevel !== 'R1' && claimed.riskLevel !== 'R2') ||
    !Number.isSafeInteger(claimed.attempts) ||
    claimed.attempts < 0 ||
    claimed.attempts >= APPROVAL_NOTIFICATION_MAX_ATTEMPTS
  ) {
    throw new ApprovalNotificationDeliveryError('APPROVAL_NOTIFICATION_RECORD_INVALID');
  }
}

function isIndeterminateDingTalkError(error: unknown): boolean {
  return error instanceof OrgPushError &&
    (
      error.code === 'DINGTALK_APPROVAL_MESSAGE_RESPONSE_INVALID' ||
      (
        error.category === 'retryable' &&
        error.status !== 429
      )
    );
}

function safeErrorCode(error: unknown): string {
  const code = error instanceof ApprovalNotificationDeliveryError || error instanceof OrgPushError
    ? error.code
    : 'APPROVAL_NOTIFICATION_UNKNOWN_ERROR';
  return /^[A-Z0-9_]{1,128}$/.test(code) ? code : 'APPROVAL_NOTIFICATION_UNKNOWN_ERROR';
}
