import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { ObservabilityModule } from '../observability/observability.module.js';
import { AuditIntegrityService } from './audit-integrity.service.js';
import { AuditChainVerificationService } from './audit-chain-verification.service.js';
import { AuditAnchorService } from './audit-anchor.service.js';
import { AuditAnchorSigner } from './audit-anchor-signer.js';
import {
  AuditAnchorReceiptRecord,
  AuditAnchorReceiptRecordSchema,
  AuditChainHeadRecord,
  AuditChainHeadRecordSchema,
  AuditEventRecord,
  AuditEventRecordSchema,
} from './audit.schema.js';
import { AuditWormClient, HttpAuditWormClient } from './audit-worm.client.js';
import { AuditService } from './audit.service.js';
import { AuditEventSink } from './audit.types.js';
import { MongoAuditEventSink } from './mongo-audit-event.sink.js';

@Global()
@Module({
  imports: [
    ObservabilityModule,
    MongooseModule.forFeature([
      { name: AuditAnchorReceiptRecord.name, schema: AuditAnchorReceiptRecordSchema },
      { name: AuditEventRecord.name, schema: AuditEventRecordSchema },
      { name: AuditChainHeadRecord.name, schema: AuditChainHeadRecordSchema },
    ]),
  ],
  providers: [
    AuditService,
    AuditIntegrityService,
    AuditChainVerificationService,
    AuditAnchorService,
    AuditAnchorSigner,
    HttpAuditWormClient,
    { provide: AuditWormClient, useExisting: HttpAuditWormClient },
    MongoAuditEventSink,
    {
      provide: AuditEventSink,
      useExisting: MongoAuditEventSink,
    },
  ],
  exports: [AuditService, AuditChainVerificationService, AuditAnchorService],
})
export class AuditModule {}
