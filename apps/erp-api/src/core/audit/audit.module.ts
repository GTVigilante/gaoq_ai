import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuditIntegrityService } from './audit-integrity.service.js';
import { AuditChainVerificationService } from './audit-chain-verification.service.js';
import {
  AuditChainHeadRecord,
  AuditChainHeadRecordSchema,
  AuditEventRecord,
  AuditEventRecordSchema,
} from './audit.schema.js';
import { AuditService } from './audit.service.js';
import { AuditEventSink } from './audit.types.js';
import { MongoAuditEventSink } from './mongo-audit-event.sink.js';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AuditEventRecord.name, schema: AuditEventRecordSchema },
      { name: AuditChainHeadRecord.name, schema: AuditChainHeadRecordSchema },
    ]),
  ],
  providers: [
    AuditService,
    AuditIntegrityService,
    AuditChainVerificationService,
    MongoAuditEventSink,
    {
      provide: AuditEventSink,
      useExisting: MongoAuditEventSink,
    },
  ],
  exports: [AuditService, AuditChainVerificationService],
})
export class AuditModule {}
