import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';

import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { ApprovalCoreModule } from '../approval/approval-core.module.js';
import { IdentityPersistenceModule } from '../identity/identity-persistence.module.js';
import { OrgCoreModule } from '../org/org-core.module.js';
import { OutboxRecord, OutboxRecordSchema } from '../org/persistence/outbox.schema.js';
import { CareApplicationService } from './application/care-application.service.js';
import { CareOccasionApplicationService } from './application/care-occasion-application.service.js';
import { CareOccasionPolicyService } from './application/care-occasion-policy.service.js';
import { CareTalentSourceService } from './application/care-talent-source.service.js';
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
  CareOccasionPreferenceRepository,
  CareOccasionTaskRepository,
  CareOccasionTenantRepository,
  CareTaskEvidenceRepository,
} from './persistence/care.repositories.js';
import {
  CareAlumniConsentRecord,
  CareAlumniConsentRecordSchema,
  CareCaseRecord,
  CareCaseRecordSchema,
  CareOccasionPreferenceRecord,
  CareOccasionPreferenceRecordSchema,
  CareOccasionTaskRecord,
  CareOccasionTaskRecordSchema,
  CareOccasionTenantRecord,
  CareOccasionTenantRecordSchema,
  CareTaskEvidenceRecord,
  CareTaskEvidenceRecordSchema,
} from './persistence/care.schemas.js';
import { CareOccasionNotificationPort } from './integration/care-occasion-notification.port.js';
import { CareOccasionNotificationHttpAdapter } from './integration/care-occasion-notification-http.adapter.js';

@Module({
  imports: [
    IdempotencyModule,
    ApprovalCoreModule,
    IdentityPersistenceModule,
    OrgCoreModule,
    BullModule.registerQueue({ name: CARE_EXECUTION_QUEUE }),
    MongooseModule.forFeature([
      { name: CareCaseRecord.name, schema: CareCaseRecordSchema },
      { name: CareTaskEvidenceRecord.name, schema: CareTaskEvidenceRecordSchema },
      { name: CareAlumniConsentRecord.name, schema: CareAlumniConsentRecordSchema },
      {
        name: CareOccasionPreferenceRecord.name,
        schema: CareOccasionPreferenceRecordSchema,
      },
      { name: CareOccasionTaskRecord.name, schema: CareOccasionTaskRecordSchema },
      { name: CareOccasionTenantRecord.name, schema: CareOccasionTenantRecordSchema },
      { name: OutboxRecord.name, schema: OutboxRecordSchema },
    ]),
  ],
  providers: [
    CareApplicationService,
    CareOccasionApplicationService,
    CareOccasionPolicyService,
    CareTalentSourceService,
    CareCaseRepository,
    CareTaskEvidenceRepository,
    CareAlumniConsentRepository,
    CareOccasionPreferenceRepository,
    CareOccasionTaskRepository,
    CareOccasionTenantRepository,
    CareOutboxWriter,
    CareExecutionQueueService,
    CareOccasionNotificationHttpAdapter,
    {
      provide: CareOccasionNotificationPort,
      useExisting: CareOccasionNotificationHttpAdapter,
    },
    UnconfiguredCareTaskEvidenceVerifier,
    { provide: CareTaskEvidenceVerificationPort, useExisting: UnconfiguredCareTaskEvidenceVerifier },
    UnconfiguredAlumniConsentVerifier,
    { provide: AlumniConsentVerificationPort, useExisting: UnconfiguredAlumniConsentVerifier },
  ],
  exports: [
    CareApplicationService,
    CareOccasionApplicationService,
    CareTalentSourceService,
    CareOccasionPreferenceRepository,
    CareOccasionTaskRepository,
    CareOccasionTenantRepository,
    CareExecutionQueueService,
  ],
})
export class CareCoreModule {}
