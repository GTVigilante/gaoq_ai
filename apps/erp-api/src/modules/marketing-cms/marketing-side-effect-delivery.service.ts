import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidEventId } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';
import {
  MarketingSideEffectRecord,
  type MarketingSideEffectDocument,
  type MarketingSideEffectKind,
} from './marketing-cms.schemas.js';
import type { MarketingNotificationChannel } from './marketing-notification.queue.js';

export interface MarketingSideEffectIdentity {
  readonly eventId: string;
  readonly tenantId: string;
  readonly kind: MarketingSideEffectKind;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly channel: MarketingNotificationChannel | null;
}

/** 校验队列路由并维护外部副作用的送达、死信终态。 */
@Injectable()
export class MarketingSideEffectDeliveryService {
  constructor(
    @InjectModel(MarketingSideEffectRecord.name)
    private readonly records: Model<MarketingSideEffectDocument>,
  ) {}

  async assertDispatchable(
    identity: MarketingSideEffectIdentity,
    session?: ClientSession,
  ): Promise<boolean> {
    assertIdentity(identity);
    let record: { readonly status?: string } | null;
    try {
      const query = this.records.findOne(identityFilter(identity))
        .select('status').lean();
      if (session !== undefined) query.session(session);
      record = await query.exec();
    } catch {
      throw new Error('MARKETING_SIDE_EFFECT_STORE_UNAVAILABLE');
    }
    if (record?.status === 'dispatched') return true;
    if (record?.status === 'delivered' || record?.status === 'cancelled') return false;
    throw new Error('MARKETING_SIDE_EFFECT_ROUTE_MISMATCH');
  }

  async markDelivered(
    identity: MarketingSideEffectIdentity,
    deliveryAttempt: number,
    session?: ClientSession,
  ): Promise<void> {
    assertIdentity(identity);
    assertAttempt(deliveryAttempt);
    const options = session === undefined
      ? { timestamps: false as const }
      : { timestamps: false as const, session };
    try {
      const updated = await this.records.updateOne(
        { ...identityFilter(identity), status: 'dispatched' },
        {
          $set: {
            status: 'delivered',
            completedAt: new Date(),
            lastErrorCode: null,
          },
          $max: { deliveryAttempts: deliveryAttempt },
        },
        options,
      );
      if (updated.matchedCount === 1) return;
      if (!await this.isTerminal(identity, 'delivered', session)) {
        throw new Error('MARKETING_SIDE_EFFECT_DELIVERY_STATE_LOST');
      }
    } catch (caught) {
      throw normalizeStoreError(caught);
    }
  }

  async markFailure(
    identity: MarketingSideEffectIdentity,
    deliveryAttempt: number,
    finalAttempt: boolean,
    errorCode: string,
  ): Promise<void> {
    assertIdentity(identity);
    assertAttempt(deliveryAttempt);
    if (!/^[A-Z0-9_]{3,128}$/u.test(errorCode)) {
      throw new Error('MARKETING_SIDE_EFFECT_ERROR_CODE_INVALID');
    }
    try {
      const updated = await this.records.updateOne(
        {
          ...identityFilter(identity),
          status: 'dispatched',
          deliveryAttempts: { $lte: deliveryAttempt },
        },
        {
          $set: {
            status: finalAttempt ? 'dead' : 'dispatched',
            completedAt: finalAttempt ? new Date() : null,
            lastErrorCode: errorCode,
          },
          $max: { deliveryAttempts: deliveryAttempt },
        },
        { timestamps: false },
      );
      if (updated.matchedCount === 1) return;
      if (
        !await this.isAnyTerminal(identity) &&
        !await this.isFailureAttemptRecorded(identity, deliveryAttempt)
      ) {
        throw new Error('MARKETING_SIDE_EFFECT_DELIVERY_STATE_LOST');
      }
    } catch (caught) {
      throw normalizeStoreError(caught);
    }
  }

  private async isTerminal(
    identity: MarketingSideEffectIdentity,
    status: 'delivered',
    session?: ClientSession,
  ): Promise<boolean> {
    const query = this.records.exists({ ...identityFilter(identity), status });
    if (session !== undefined) query.session(session);
    return await query.exec() !== null;
  }

  private async isAnyTerminal(identity: MarketingSideEffectIdentity): Promise<boolean> {
    return await this.records.exists({
      ...identityFilter(identity),
      status: { $in: ['delivered', 'cancelled', 'dead'] },
    }).exec() !== null;
  }

  private async isFailureAttemptRecorded(
    identity: MarketingSideEffectIdentity,
    deliveryAttempt: number,
  ): Promise<boolean> {
    return await this.records.exists({
      ...identityFilter(identity),
      status: 'dispatched',
      deliveryAttempts: { $gte: deliveryAttempt },
    }).exec() !== null;
  }
}

const identityFilter = (identity: MarketingSideEffectIdentity) => ({
  eventId: identity.eventId,
  tenantId: identity.tenantId,
  kind: identity.kind,
  aggregateId: identity.aggregateId,
  aggregateVersion: identity.aggregateVersion,
  channel: identity.channel,
});

const assertIdentity = (identity: MarketingSideEffectIdentity): void => {
  if (
    !isValidEventId(identity.eventId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(identity.tenantId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(identity.aggregateId) ||
    !Number.isSafeInteger(identity.aggregateVersion) ||
    identity.aggregateVersion < 1 ||
    (
      identity.kind !== 'lead_notification' &&
      identity.kind !== 'scheduled_publish'
    ) ||
    (
      identity.kind === 'lead_notification' &&
      identity.channel !== 'email' &&
      identity.channel !== 'feishu'
    ) ||
    (identity.kind === 'scheduled_publish' && identity.channel !== null)
  ) {
    throw new Error('MARKETING_SIDE_EFFECT_IDENTITY_INVALID');
  }
};

const normalizeStoreError = (caught: unknown): Error => {
  if (
    caught instanceof Error &&
    (
      caught.message === 'MARKETING_SIDE_EFFECT_DELIVERY_STATE_LOST' ||
      caught.message === 'MARKETING_SIDE_EFFECT_STORE_UNAVAILABLE'
    )
  ) {
    return caught;
  }
  return new Error('MARKETING_SIDE_EFFECT_STORE_UNAVAILABLE');
};

const assertAttempt = (attempt: number): void => {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 100) {
    throw new Error('MARKETING_SIDE_EFFECT_ATTEMPT_INVALID');
  }
};
