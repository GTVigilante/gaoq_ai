import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuditModule } from '../../core/audit/audit.module.js';
import { TenantContextModule } from '../../core/tenant/tenant-context.module.js';
import { OutboxRecord, OutboxRecordSchema } from '../org/persistence/outbox.schema.js';
import { OpOperatingSummaryService } from './application/op-operating-summary.service.js';
import { OpController } from './op.controller.js';
import { OP_OPERATING_SUMMARY_QUEUE } from './op-operating-summary.queue.js';
import { OpWebhookController } from './op-webhook.controller.js';
import { OpWebhookCryptoService } from './op-webhook-crypto.service.js';
import { OpWebhookSecretResolver, OpWebhookService } from './op-webhook.service.js';
import { OpOutboxWriter } from './persistence/op-outbox.writer.js';
import {
  OpClientBindingRecord,
  OpClientBindingRecordSchema,
  OpOperatingSummaryInboxRecord,
  OpOperatingSummaryInboxRecordSchema,
  OpOperatingSummaryRecord,
  OpOperatingSummaryRecordSchema,
} from './persistence/op.schemas.js';

/** Phase 5 OP 外部系统边界与只读经营摘要模块。 */
@Module({
  imports: [
    AuditModule,
    TenantContextModule,
    BullModule.registerQueue({ name: OP_OPERATING_SUMMARY_QUEUE }),
    MongooseModule.forFeature([
      { name: OpClientBindingRecord.name, schema: OpClientBindingRecordSchema },
      { name: OpOperatingSummaryInboxRecord.name, schema: OpOperatingSummaryInboxRecordSchema },
      { name: OpOperatingSummaryRecord.name, schema: OpOperatingSummaryRecordSchema },
      { name: OutboxRecord.name, schema: OutboxRecordSchema },
    ]),
  ],
  controllers: [OpWebhookController, OpController],
  providers: [
    OpWebhookSecretResolver, OpWebhookCryptoService, OpWebhookService,
    OpOperatingSummaryService, OpOutboxWriter,
  ],
  exports: [OpOperatingSummaryService, OpWebhookCryptoService],
})
export class OpModule {}
