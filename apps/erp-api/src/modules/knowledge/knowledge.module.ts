import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OnboardingModule } from '../onboarding/onboarding.module.js';
import { OrgModule } from '../org/org.module.js';
import { OutboxRecord, OutboxRecordSchema } from '../org/persistence/outbox.schema.js';
import { KnowledgeApplicationService } from './application/knowledge-application.service.js';
import {
  KnowledgeContentVerificationPort,
  KnowledgeGradingPort,
  KnowledgeSearchPort,
} from './application/knowledge-ports.js';
import {
  HttpKnowledgeContentVerificationAdapter,
  HttpKnowledgeGradingAdapter,
  HttpKnowledgeSearchAdapter,
  KnowledgeEvidenceHttpClient,
} from './integration/knowledge-evidence-http.adapters.js';
import { KnowledgeController } from './knowledge.controller.js';
import { KnowledgeOutboxWriter } from './persistence/knowledge-outbox.writer.js';
import { KnowledgeSearchIndexTaskWriter } from './persistence/knowledge-search-index-task.writer.js';
import {
  KnowledgeSearchIndexTaskRecord,
  KnowledgeSearchIndexTaskRecordSchema,
} from './persistence/knowledge-search.schemas.js';
import {
  CourseVersionRepository,
  ExamAttemptRepository,
  KnowledgeEvidenceRepository,
  TrainingAssignmentRepository,
} from './persistence/knowledge.repositories.js';
import {
  KnowledgeCourseVersionRecord,
  KnowledgeCourseVersionRecordSchema,
  KnowledgeExamAttemptRecord,
  KnowledgeExamAttemptRecordSchema,
  KnowledgeOnboardingAttestationRecord,
  KnowledgeOnboardingAttestationRecordSchema,
  KnowledgeProgressEventRecord,
  KnowledgeProgressEventRecordSchema,
  KnowledgeTrainingAssignmentRecord,
  KnowledgeTrainingAssignmentRecordSchema,
} from './persistence/knowledge.schemas.js';

@Module({
  imports: [
    IdempotencyModule,
    IdentityModule,
    OnboardingModule,
    OrgModule,
    MongooseModule.forFeature([
      { name: KnowledgeCourseVersionRecord.name, schema: KnowledgeCourseVersionRecordSchema },
      { name: KnowledgeTrainingAssignmentRecord.name, schema: KnowledgeTrainingAssignmentRecordSchema },
      { name: KnowledgeExamAttemptRecord.name, schema: KnowledgeExamAttemptRecordSchema },
      { name: KnowledgeProgressEventRecord.name, schema: KnowledgeProgressEventRecordSchema },
      {
        name: KnowledgeOnboardingAttestationRecord.name,
        schema: KnowledgeOnboardingAttestationRecordSchema,
      },
      {
        name: KnowledgeSearchIndexTaskRecord.name,
        schema: KnowledgeSearchIndexTaskRecordSchema,
      },
      { name: OutboxRecord.name, schema: OutboxRecordSchema },
    ]),
  ],
  providers: [
    KnowledgeApplicationService,
    CourseVersionRepository,
    TrainingAssignmentRepository,
    ExamAttemptRepository,
    KnowledgeEvidenceRepository,
    KnowledgeOutboxWriter,
    KnowledgeSearchIndexTaskWriter,
    KnowledgeEvidenceHttpClient,
    HttpKnowledgeGradingAdapter,
    { provide: KnowledgeGradingPort, useExisting: HttpKnowledgeGradingAdapter },
    HttpKnowledgeContentVerificationAdapter,
    {
      provide: KnowledgeContentVerificationPort,
      useExisting: HttpKnowledgeContentVerificationAdapter,
    },
    HttpKnowledgeSearchAdapter,
    { provide: KnowledgeSearchPort, useExisting: HttpKnowledgeSearchAdapter },
  ],
  controllers: [KnowledgeController],
  exports: [KnowledgeApplicationService],
})
export class KnowledgeModule {}
