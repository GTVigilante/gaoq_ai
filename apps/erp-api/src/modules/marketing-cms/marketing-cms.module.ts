import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';
import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { OutboxRecord, OutboxRecordSchema } from '../org/persistence/outbox.schema.js';
import { MarketingCmsController, MarketingPublicController } from './marketing-cms.controller.js';
import {
  MarketingContentRecord,
  MarketingContentRecordSchema,
  MarketingContentRevisionRecord,
  MarketingContentRevisionRecordSchema,
  MarketingLeadRecord,
  MarketingLeadRecordSchema,
  MarketingMediaRecord,
  MarketingMediaRecordSchema,
  MarketingAiGenerationRecord,
  MarketingAiGenerationRecordSchema,
} from './marketing-cms.schemas.js';
import { MarketingCmsService } from './marketing-cms.service.js';
import { MarketingLeadCryptoService } from './marketing-lead-crypto.service.js';
import { MarketingAiGateway, MarketingMediaGateway } from './marketing-gateways.service.js';
import { MarketingPublicProtectionService } from './marketing-public-protection.service.js';
import { MARKETING_NOTIFICATION_QUEUE } from './marketing-notification.queue.js';
import { MARKETING_AUTOMATION_QUEUE } from './marketing-automation.queue.js';

@Module({
  imports: [
    IdempotencyModule,
    BullModule.registerQueue({ name: MARKETING_NOTIFICATION_QUEUE }),
    BullModule.registerQueue({ name: MARKETING_AUTOMATION_QUEUE }),
    MongooseModule.forFeature([
      { name: MarketingContentRecord.name, schema: MarketingContentRecordSchema },
      { name: MarketingContentRevisionRecord.name, schema: MarketingContentRevisionRecordSchema },
      { name: MarketingLeadRecord.name, schema: MarketingLeadRecordSchema },
      { name: MarketingMediaRecord.name, schema: MarketingMediaRecordSchema },
      { name: MarketingAiGenerationRecord.name, schema: MarketingAiGenerationRecordSchema },
      { name: OutboxRecord.name, schema: OutboxRecordSchema },
    ]),
  ],
  providers: [
    MarketingCmsService,
    MarketingLeadCryptoService,
    MarketingMediaGateway,
    MarketingAiGateway,
    MarketingPublicProtectionService,
  ],
  controllers: [MarketingCmsController, MarketingPublicController],
  exports: [MarketingCmsService],
})
export class MarketingCmsModule {}
