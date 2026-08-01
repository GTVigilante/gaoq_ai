import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { TenantContextModule } from '../../core/tenant/tenant-context.module.js';
import { OutboxRecord, OutboxRecordSchema } from '../org/persistence/outbox.schema.js';
import { BusinessAttachmentService } from './application/business-attachment.service.js';
import { BusinessAttachmentOutboxWriter } from './persistence/business-attachment-outbox.writer.js';
import {
  BusinessAttachmentRecord,
  BusinessAttachmentRecordSchema,
} from './persistence/business-attachment.schemas.js';

@Module({
  imports: [
    IdempotencyModule,
    TenantContextModule,
    MongooseModule.forFeature([
      { name: BusinessAttachmentRecord.name, schema: BusinessAttachmentRecordSchema },
      { name: OutboxRecord.name, schema: OutboxRecordSchema },
    ]),
  ],
  providers: [BusinessAttachmentService, BusinessAttachmentOutboxWriter],
  exports: [BusinessAttachmentService],
})
export class DocumentModule {}
