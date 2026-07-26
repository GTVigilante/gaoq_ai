import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Job } from 'bullmq';
import type { Model } from 'mongoose';
import type { AppEnvironment } from '../../config/environment.js';
import { MarketingLeadRecord } from './marketing-cms.schemas.js';
import { MarketingLeadCryptoService } from './marketing-lead-crypto.service.js';
import {
  MARKETING_NOTIFICATION_QUEUE,
  type MarketingNotificationJob,
} from './marketing-notification.queue.js';

/** 营销线索通知 Worker；失败由 BullMQ 指数退避并最终进入失败任务清单。 */
@Processor(MARKETING_NOTIFICATION_QUEUE, { concurrency: 4, limiter: { max: 10, duration: 1_000 } })
export class MarketingNotificationProcessor extends WorkerHost {
  constructor(
    @InjectModel(MarketingLeadRecord.name) private readonly leads: Model<MarketingLeadRecord>,
    private readonly crypto: MarketingLeadCryptoService,
    private readonly config: ConfigService<AppEnvironment, true>,
  ) { super(); }

  override async process(job: Job<MarketingNotificationJob>): Promise<void> {
    const endpoint = this.config.get('MARKETING_NOTIFICATION_GATEWAY_ENDPOINT', { infer: true });
    const token = this.config.get('MARKETING_NOTIFICATION_GATEWAY_BEARER_TOKEN', { infer: true });
    if (endpoint === undefined || token === undefined) throw new Error('营销通知网关未配置');
    const lead = await this.leads.findOne({ tenantId: job.data.tenantId, id: job.data.leadId })
      .select('+contactIv +contactCiphertext +contactAuthTag').lean().exec();
    if (lead === null) throw new Error('营销线索不存在');
    const contact = this.crypto.unprotect(job.data.tenantId, job.data.leadId, {
      iv: lead.contactIv, ciphertext: lead.contactCiphertext, authTag: lead.contactAuthTag,
    });
    const response = await fetch(new URL('/v1/notify', endpoint), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        channel: job.data.channel, leadId: lead.id, audience: lead.audience,
        name: lead.name, contact, requestSummary: lead.requestSummary,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('营销通知发送失败');
  }
}
