import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { TenantContextModule } from '../../core/tenant/tenant-context.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OrgModule } from '../org/org.module.js';
import { ApprovalModule } from '../approval/approval.module.js';
import { OutboxRecord, OutboxRecordSchema } from '../org/persistence/outbox.schema.js';
import { RecruitmentDataCryptoService } from './persistence/recruitment-data-crypto.service.js';
import { RecruitmentOutboxWriter } from './persistence/recruitment-outbox.writer.js';
import { RecruitmentApplicationService } from './application/recruitment-application.service.js';
import { RecruitmentManagementService } from './application/recruitment-management.service.js';
import { RecruitmentInterviewService } from './application/recruitment-interview.service.js';
import { RecruitmentOfferService } from './application/recruitment-offer.service.js';
import { RecruitmentOnboardingBridgeService } from './application/recruitment-onboarding-bridge.service.js';
import { RecruitmentController } from './recruitment.controller.js';
import { RecruitmentManagementController } from './recruitment-management.controller.js';
import { RecruitmentInterviewController } from './recruitment-interview.controller.js';
import { RecruitmentOfferController } from './recruitment-offer.controller.js';
import {
  CandidateApplicationRepository,
  CandidateApplicationStageRepository,
  CandidateConsentEvidenceRepository,
  RecruitmentCandidateRepository,
  RecruitmentInterviewFeedbackRepository,
  RecruitmentInterviewRepository,
  RecruitmentOfferRepository,
  RecruitmentOfferEvidenceRepository,
  RecruitmentPositionRepository,
  RecruitmentRequisitionRepository,
} from './persistence/recruitment.repositories.js';
import {
  CandidateApplicationRecord,
  CandidateApplicationRecordSchema,
  CandidateApplicationStageRecord,
  CandidateApplicationStageRecordSchema,
  CandidateConsentEvidenceRecord,
  CandidateConsentEvidenceRecordSchema,
  RecruitmentCandidateRecord,
  RecruitmentCandidateRecordSchema,
  RecruitmentInterviewFeedbackRecord,
  RecruitmentInterviewFeedbackRecordSchema,
  RecruitmentInterviewRecord,
  RecruitmentInterviewRecordSchema,
  RecruitmentOfferRecord,
  RecruitmentOfferRecordSchema,
  RecruitmentOfferEvidenceRecord,
  RecruitmentOfferEvidenceRecordSchema,
  RecruitmentPositionRecord,
  RecruitmentPositionRecordSchema,
  RecruitmentRequisitionRecord,
  RecruitmentRequisitionRecordSchema,
} from './persistence/recruitment.schemas.js';

/** Phase 3 招聘模块；候选人密文、职位申请和状态事件共享租户与事务底座。 */
@Module({
  imports: [
    IdempotencyModule,
    IdentityModule,
    ApprovalModule,
    TenantContextModule,
    OrgModule,
    MongooseModule.forFeature([
      { name: RecruitmentCandidateRecord.name, schema: RecruitmentCandidateRecordSchema },
      { name: CandidateConsentEvidenceRecord.name, schema: CandidateConsentEvidenceRecordSchema },
      { name: RecruitmentRequisitionRecord.name, schema: RecruitmentRequisitionRecordSchema },
      { name: RecruitmentPositionRecord.name, schema: RecruitmentPositionRecordSchema },
      { name: CandidateApplicationRecord.name, schema: CandidateApplicationRecordSchema },
      { name: CandidateApplicationStageRecord.name, schema: CandidateApplicationStageRecordSchema },
      { name: RecruitmentInterviewRecord.name, schema: RecruitmentInterviewRecordSchema },
      {
        name: RecruitmentInterviewFeedbackRecord.name,
        schema: RecruitmentInterviewFeedbackRecordSchema,
      },
      { name: RecruitmentOfferRecord.name, schema: RecruitmentOfferRecordSchema },
      {
        name: RecruitmentOfferEvidenceRecord.name,
        schema: RecruitmentOfferEvidenceRecordSchema,
      },
      { name: OutboxRecord.name, schema: OutboxRecordSchema },
    ]),
  ],
  providers: [
    RecruitmentDataCryptoService,
    RecruitmentOutboxWriter,
    RecruitmentCandidateRepository,
    CandidateConsentEvidenceRepository,
    RecruitmentPositionRepository,
    RecruitmentRequisitionRepository,
    CandidateApplicationRepository,
    CandidateApplicationStageRepository,
    RecruitmentInterviewRepository,
    RecruitmentInterviewFeedbackRepository,
    RecruitmentOfferRepository,
    RecruitmentOfferEvidenceRepository,
    RecruitmentApplicationService,
    RecruitmentManagementService,
    RecruitmentInterviewService,
    RecruitmentOfferService,
    RecruitmentOnboardingBridgeService,
  ],
  controllers: [
    RecruitmentController, RecruitmentManagementController, RecruitmentInterviewController,
    RecruitmentOfferController,
  ],
  exports: [
    RecruitmentDataCryptoService,
    RecruitmentOutboxWriter,
    RecruitmentCandidateRepository,
    RecruitmentPositionRepository,
    RecruitmentRequisitionRepository,
    CandidateApplicationRepository,
    RecruitmentInterviewRepository,
    RecruitmentOfferRepository,
    RecruitmentOfferEvidenceRepository,
    RecruitmentApplicationService,
    RecruitmentManagementService,
    RecruitmentInterviewService,
    RecruitmentOfferService,
    RecruitmentOnboardingBridgeService,
  ],
})
export class RecruitmentModule {}
