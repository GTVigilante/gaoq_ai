import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { OrgModule } from '../org/org.module.js';
import { OutboxRecord, OutboxRecordSchema } from '../org/persistence/outbox.schema.js';
import { RecruitmentModule } from '../recruitment/recruitment.module.js';
import { OnboardingApplicationService } from './application/onboarding-application.service.js';
import { OnboardingTalentSourceService } from './application/onboarding-talent-source.service.js';
import { OnboardingController } from './onboarding.controller.js';
import { OnboardingOutboxWriter } from './persistence/onboarding-outbox.writer.js';
import {
  OnboardingInstanceRepository,
  OnboardingTaskEvidenceRepository,
} from './persistence/onboarding.repositories.js';
import {
  OnboardingInstanceRecord,
  OnboardingInstanceRecordSchema,
  OnboardingTaskEvidenceRecord,
  OnboardingTaskEvidenceRecordSchema,
} from './persistence/onboarding.schemas.js';

@Module({
  imports: [
    IdempotencyModule,
    OrgModule,
    RecruitmentModule,
    MongooseModule.forFeature([
      { name: OnboardingInstanceRecord.name, schema: OnboardingInstanceRecordSchema },
      { name: OnboardingTaskEvidenceRecord.name, schema: OnboardingTaskEvidenceRecordSchema },
      { name: OutboxRecord.name, schema: OutboxRecordSchema },
    ]),
  ],
  providers: [
    OnboardingApplicationService,
    OnboardingTalentSourceService,
    OnboardingInstanceRepository,
    OnboardingTaskEvidenceRepository,
    OnboardingOutboxWriter,
  ],
  controllers: [OnboardingController],
  exports: [OnboardingApplicationService, OnboardingTalentSourceService],
})
export class OnboardingModule {}
