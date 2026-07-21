import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';

import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { ApprovalModule } from '../approval/approval.module.js';
import { OrgModule } from '../org/org.module.js';
import { OutboxRecord, OutboxRecordSchema } from '../org/persistence/outbox.schema.js';
import { CareApplicationService } from './application/care-application.service.js';
import { CareController } from './care.controller.js';
import { CARE_EXECUTION_QUEUE } from './care-execution.queue.js';
import { CareExecutionQueueService } from './care-execution-queue.service.js';
import {
  AlumniConsentVerificationPort,
  CareTaskEvidenceVerificationPort,
  UnconfiguredAlumniConsentVerifier,
  UnconfiguredCareTaskEvidenceVerifier,
} from './application/care-ports.js';
import { CareOutboxWriter } from './persistence/care-outbox.writer.js';
import {
  CareAlumniConsentRepository,
  CareCaseRepository,
  CareTaskEvidenceRepository,
} from './persistence/care.repositories.js';
import {
  CareAlumniConsentRecord,
  CareAlumniConsentRecordSchema,
  CareCaseRecord,
  CareCaseRecordSchema,
  CareTaskEvidenceRecord,
  CareTaskEvidenceRecordSchema,
} from './persistence/care.schemas.js';

@Module({
  imports: [
    IdempotencyModule,
    ApprovalModule,
    OrgModule,
    BullModule.registerQueue({ name: CARE_EXECUTION_QUEUE }),
    MongooseModule.forFeature([
      { name: CareCaseRecord.name, schema: CareCaseRecordSchema },
      { name: CareTaskEvidenceRecord.name, schema: CareTaskEvidenceRecordSchema },
      { name: CareAlumniConsentRecord.name, schema: CareAlumniConsentRecordSchema },
      { name: OutboxRecord.name, schema: OutboxRecordSchema },
    ]),
  ],
  providers: [
    CareApplicationService,
    CareCaseRepository,
    CareTaskEvidenceRepository,
    CareAlumniConsentRepository,
    CareOutboxWriter,
    CareExecutionQueueService,
    UnconfiguredCareTaskEvidenceVerifier,
    { provide: CareTaskEvidenceVerificationPort, useExisting: UnconfiguredCareTaskEvidenceVerifier },
    UnconfiguredAlumniConsentVerifier,
    { provide: AlumniConsentVerificationPort, useExisting: UnconfiguredAlumniConsentVerifier },
  ],
  controllers: [CareController],
  exports: [CareApplicationService],
})
export class CareModule {}
