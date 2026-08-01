import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  MarketingContentRecord,
  MarketingContentRecordSchema,
  MarketingContentRevisionRecord,
  MarketingContentRevisionRecordSchema,
  MarketingLeadRecord,
  MarketingLeadRecordSchema,
  MarketingSideEffectRecord,
  MarketingSideEffectRecordSchema,
} from './marketing-cms.schemas.js';
import { MarketingLeadCryptoService } from './marketing-lead-crypto.service.js';
import { MarketingNotificationProcessor } from './marketing-notification.processor.js';
import { MARKETING_NOTIFICATION_QUEUE } from './marketing-notification.queue.js';
import { MARKETING_AUTOMATION_QUEUE } from './marketing-automation.queue.js';
import { MarketingPublishProcessor } from './marketing-publish.processor.js';
import { MarketingPublishScheduler } from './marketing-publish.scheduler.js';
import { OutboxRecord, OutboxRecordSchema } from '../org/persistence/outbox.schema.js';
import { MARKETING_OUTBOX_QUEUE } from './marketing-outbox.queue.js';
import { MarketingOutboxProcessor } from './marketing-outbox.processor.js';
import { MarketingOutboxRelayService } from './marketing-outbox-relay.service.js';
import { MarketingOutboxScheduler } from './marketing-outbox.scheduler.js';
import { MarketingSideEffectDeliveryService } from './marketing-side-effect-delivery.service.js';

/** CMS Worker 仅装配通知、排期、可靠性终态所需模型、密钥服务与队列。 */
@Module({
  imports: [
    BullModule.registerQueue({ name: MARKETING_NOTIFICATION_QUEUE }),
    BullModule.registerQueue({ name: MARKETING_AUTOMATION_QUEUE }),
    BullModule.registerQueue({ name: MARKETING_OUTBOX_QUEUE }),
    MongooseModule.forFeature([
      { name: MarketingLeadRecord.name, schema: MarketingLeadRecordSchema },
      { name: MarketingSideEffectRecord.name, schema: MarketingSideEffectRecordSchema },
      { name: MarketingContentRecord.name, schema: MarketingContentRecordSchema },
      { name: MarketingContentRevisionRecord.name, schema: MarketingContentRevisionRecordSchema },
      { name: OutboxRecord.name, schema: OutboxRecordSchema },
    ]),
  ],
  providers: [
    MarketingLeadCryptoService,
    MarketingNotificationProcessor,
    MarketingPublishProcessor,
    MarketingPublishScheduler,
    MarketingOutboxRelayService,
    MarketingOutboxProcessor,
    MarketingOutboxScheduler,
    MarketingSideEffectDeliveryService,
  ],
})
export class MarketingCmsWorkerModule {}
