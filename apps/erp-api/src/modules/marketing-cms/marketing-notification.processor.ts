import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { isValidEventId } from '@gaoq/shared-utils';
import type { Job } from 'bullmq';
import type { Model } from 'mongoose';
import type { AppEnvironment } from '../../config/environment.js';
import { MarketingLeadRecord } from './marketing-cms.schemas.js';
import { MarketingLeadCryptoService } from './marketing-lead-crypto.service.js';
import {
  MARKETING_NOTIFICATION_QUEUE,
  type MarketingNotificationJob,
} from './marketing-notification.queue.js';
import {
  MarketingSideEffectDeliveryService,
  type MarketingSideEffectIdentity,
} from './marketing-side-effect-delivery.service.js';

/** 营销线索通知 Worker；失败由 BullMQ 指数退避并最终进入失败任务清单。 */
@Processor(MARKETING_NOTIFICATION_QUEUE, { concurrency: 4, limiter: { max: 10, duration: 1_000 } })
export class MarketingNotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(MarketingNotificationProcessor.name);

  constructor(
    @InjectModel(MarketingLeadRecord.name) private readonly leads: Model<MarketingLeadRecord>,
    private readonly crypto: MarketingLeadCryptoService,
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly delivery: MarketingSideEffectDeliveryService,
  ) { super(); }

  override async process(job: Job<MarketingNotificationJob>): Promise<void> {
    const identity = notificationIdentity(job.data);
    const attempt = job.attemptsMade + 1;
    let dispatchable: boolean;
    try {
      dispatchable = await this.delivery.assertDispatchable(identity);
    } catch (caught) {
      const code = routeFailureCode(caught);
      this.logger.error({
        code: code === 'MARKETING_SIDE_EFFECT_ROUTE_MISMATCH'
          ? 'MARKETING_NOTIFICATION_ROUTE_REJECTED'
          : 'MARKETING_NOTIFICATION_DELIVERY_STATE_UNAVAILABLE',
        eventId: safeEventId(identity.eventId),
        attempt,
      });
      throw new Error(code, { cause: caught });
    }
    if (!dispatchable) return;
    try {
      await this.notify(job.data);
    } catch (caught) {
      const finalAttempt = attempt >= configuredAttempts(job);
      const code = failureCode(caught);
      await this.delivery.markFailure(identity, attempt, finalAttempt, code);
      if (finalAttempt) {
        this.logger.error({
          code: 'MARKETING_NOTIFICATION_DEAD_LETTERED',
          eventId: safeEventId(identity.eventId),
          channel: identity.channel,
          attempts: attempt,
          failureCode: code,
        });
      }
      throw new Error(code, { cause: caught });
    }
    await this.delivery.markDelivered(identity, attempt);
  }

  private async notify(data: MarketingNotificationJob): Promise<void> {
    const endpoint = this.config.get('MARKETING_NOTIFICATION_GATEWAY_ENDPOINT', { infer: true });
    const token = this.config.get('MARKETING_NOTIFICATION_GATEWAY_BEARER_TOKEN', { infer: true });
    if (endpoint === undefined || token === undefined) {
      throw new Error('MARKETING_NOTIFICATION_GATEWAY_UNAVAILABLE');
    }
    const lead = await this.leads.findOne({ tenantId: data.tenantId, id: data.leadId })
      .select('+contactIv +contactCiphertext +contactAuthTag').lean().exec();
    if (lead === null) throw new Error('MARKETING_NOTIFICATION_LEAD_NOT_FOUND');
    const contact = this.crypto.unprotect(data.tenantId, data.leadId, {
      iv: lead.contactIv, ciphertext: lead.contactCiphertext, authTag: lead.contactAuthTag,
    });
    const response = await fetch(new URL('/v1/notify', endpoint), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': `marketing-side-effect:${data.sideEffectEventId}`,
      },
      body: JSON.stringify({
        channel: data.channel, leadId: lead.id, audience: lead.audience,
        name: lead.name, contact, requestSummary: lead.requestSummary,
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (response?.ok !== true) throw new Error('MARKETING_NOTIFICATION_GATEWAY_FAILED');
  }
}

const notificationIdentity = (
  data: MarketingNotificationJob,
): MarketingSideEffectIdentity => ({
  eventId: data.sideEffectEventId,
  tenantId: data.tenantId,
  kind: 'lead_notification',
  aggregateId: data.leadId,
  aggregateVersion: data.aggregateVersion,
  channel: data.channel,
});

const configuredAttempts = (job: Job<MarketingNotificationJob>): number => {
  const attempts = job.opts.attempts ?? 1;
  return Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 1;
};

const failureCode = (caught: unknown): string =>
  caught instanceof Error && /^[A-Z0-9_]{3,128}$/u.test(caught.message)
    ? caught.message
    : 'MARKETING_NOTIFICATION_PROCESSING_FAILED';

const routeFailureCode = (caught: unknown): string => {
  if (
    caught instanceof Error &&
    (
      caught.message === 'MARKETING_SIDE_EFFECT_ROUTE_MISMATCH' ||
      caught.message === 'MARKETING_SIDE_EFFECT_IDENTITY_INVALID'
    )
  ) {
    return 'MARKETING_SIDE_EFFECT_ROUTE_MISMATCH';
  }
  if (
    caught instanceof Error &&
    caught.message === 'MARKETING_SIDE_EFFECT_STORE_UNAVAILABLE'
  ) {
    return caught.message;
  }
  return 'MARKETING_NOTIFICATION_DELIVERY_STATE_UNAVAILABLE';
};

const safeEventId = (eventId: string): string =>
  isValidEventId(eventId) ? eventId : 'invalid';
