import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { CareModule } from '../care/care.module.js';
import { OnboardingModule } from '../onboarding/onboarding.module.js';
import { OrgModule } from '../org/org.module.js';
import {
  OutboxRecord,
  OutboxRecordSchema,
} from '../org/persistence/outbox.schema.js';
import { RecruitmentModule } from '../recruitment/recruitment.module.js';
import { TalentLifecycleService } from './application/talent-lifecycle.service.js';
import { TalentLifecycleOutboxWriter } from './persistence/talent-lifecycle-outbox.writer.js';
import { TalentTouchpointRepository } from './persistence/talent-lifecycle.repository.js';
import {
  TalentTouchpointRecord,
  TalentTouchpointRecordSchema,
} from './persistence/talent-lifecycle.schemas.js';
import { TalentLifecycleController } from './talent-lifecycle.controller.js';

@Module({
  imports: [
    IdempotencyModule,
    RecruitmentModule,
    OnboardingModule,
    OrgModule,
    CareModule,
    MongooseModule.forFeature([
      { name: TalentTouchpointRecord.name, schema: TalentTouchpointRecordSchema },
      { name: OutboxRecord.name, schema: OutboxRecordSchema },
    ]),
  ],
  controllers: [TalentLifecycleController],
  providers: [
    TalentLifecycleService,
    TalentTouchpointRepository,
    TalentLifecycleOutboxWriter,
  ],
  exports: [TalentLifecycleService],
})
export class TalentLifecycleModule {}
