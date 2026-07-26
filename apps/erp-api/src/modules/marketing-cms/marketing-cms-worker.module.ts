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
} from './marketing-cms.schemas.js';
import { MarketingLeadCryptoService } from './marketing-lead-crypto.service.js';
import { MarketingNotificationProcessor } from './marketing-notification.processor.js';
import { MARKETING_NOTIFICATION_QUEUE } from './marketing-notification.queue.js';
import { MARKETING_AUTOMATION_QUEUE } from './marketing-automation.queue.js';
import { MarketingPublishProcessor } from './marketing-publish.processor.js';
import { MarketingPublishScheduler } from './marketing-publish.scheduler.js';
import { OutboxRecord, OutboxRecordSchema } from '../org/persistence/outbox.schema.js';

/** CMS Worker 仅装配线索通知所需模型、密钥服务与队列。 */
@Module({
  imports: [
    BullModule.registerQueue({ name: MARKETING_NOTIFICATION_QUEUE }),
    BullModule.registerQueue({ name: MARKETING_AUTOMATION_QUEUE }),
    MongooseModule.forFeature([
      { name: MarketingLeadRecord.name, schema: MarketingLeadRecordSchema },
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
  ],
})
export class MarketingCmsWorkerModule {}
