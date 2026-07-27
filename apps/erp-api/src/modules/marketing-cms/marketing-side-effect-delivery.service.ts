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
    const query = this.records.findOne(identityFilter(identity))
      .select('status').lean();
    if (session !== undefined) query.session(session);
    const record = await query.exec();
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
    const updated = await this.records.updateOne(
      { ...identityFilter(identity), status: 'dispatched' },
      {
        $set: {
          status: 'delivered',
          deliveryAttempts: deliveryAttempt,
          completedAt: new Date(),
          lastErrorCode: null,
        },
      },
      options,
    );
    if (updated.matchedCount === 1) return;
    if (!await this.isTerminal(identity, 'delivered', session)) {
      throw new Error('MARKETING_SIDE_EFFECT_DELIVERY_STATE_LOST');
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
    const updated = await this.records.updateOne(
      { ...identityFilter(identity), status: 'dispatched' },
      {
        $set: {
          status: finalAttempt ? 'dead' : 'dispatched',
          deliveryAttempts: deliveryAttempt,
          completedAt: finalAttempt ? new Date() : null,
          lastErrorCode: errorCode,
        },
      },
      { timestamps: false },
    );
    if (
      updated.matchedCount !== 1 &&
      !await this.isAnyTerminal(identity)
    ) {
      throw new Error('MARKETING_SIDE_EFFECT_DELIVERY_STATE_LOST');
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
      identity.kind === 'lead_notification' &&
      identity.channel !== 'email' &&
      identity.channel !== 'feishu'
    ) ||
    (identity.kind === 'scheduled_publish' && identity.channel !== null)
  ) {
    throw new Error('MARKETING_SIDE_EFFECT_IDENTITY_INVALID');
  }
};

const assertAttempt = (attempt: number): void => {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 100) {
    throw new Error('MARKETING_SIDE_EFFECT_ATTEMPT_INVALID');
  }
};
