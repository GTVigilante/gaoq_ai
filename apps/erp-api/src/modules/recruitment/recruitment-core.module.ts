import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';

import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { TenantContextModule } from '../../core/tenant/tenant-context.module.js';
import { IdentityPersistenceModule } from '../identity/identity-persistence.module.js';
import { OrgCoreModule } from '../org/org-core.module.js';
import { ApprovalCoreModule } from '../approval/approval-core.module.js';
import { OutboxRecord, OutboxRecordSchema } from '../org/persistence/outbox.schema.js';
import { RecruitmentDataCryptoService } from './persistence/recruitment-data-crypto.service.js';
import { RecruitmentOutboxWriter } from './persistence/recruitment-outbox.writer.js';
import { RecruitmentApplicationService } from './application/recruitment-application.service.js';
import { RecruitmentManagementService } from './application/recruitment-management.service.js';
import { RecruitmentInterviewService } from './application/recruitment-interview.service.js';
import { RecruitmentOfferService } from './application/recruitment-offer.service.js';
import {
  RecruitmentESignSourceService,
} from './application/recruitment-esign-source.service.js';
import { RecruitmentOnboardingBridgeService } from './application/recruitment-onboarding-bridge.service.js';
import { RecruitmentResumeService } from './application/recruitment-resume.service.js';
import { RecruitmentTalentSourceService } from './application/recruitment-talent-source.service.js';
import { RecruitmentWorkspaceService } from './application/recruitment-workspace.service.js';
import {
  RecruitmentResumeAiAnalyzer,
  RecruitmentResumeSourceGateway,
} from './application/recruitment-resume.ports.js';
import {
  HttpRecruitmentResumeSourceGateway,
  OpenAiRecruitmentResumeAnalyzer,
} from './integration/recruitment-resume.adapters.js';
import { RECRUITMENT_RESUME_QUEUE } from './recruitment-resume.queue.js';
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
import {
  RecruitmentResumeAnalysisRecord,
  RecruitmentResumeAnalysisRecordSchema,
} from './persistence/recruitment-resume.schemas.js';

/** Phase 3 招聘模块；候选人密文、职位申请和状态事件共享租户与事务底座。 */
@Module({
  imports: [
    IdempotencyModule,
    IdentityPersistenceModule,
    ApprovalCoreModule,
    TenantContextModule,
    OrgCoreModule,
    BullModule.registerQueue({ name: RECRUITMENT_RESUME_QUEUE }),
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
      {
        name: RecruitmentResumeAnalysisRecord.name,
        schema: RecruitmentResumeAnalysisRecordSchema,
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
    RecruitmentESignSourceService,
    RecruitmentOnboardingBridgeService,
    RecruitmentResumeService,
    RecruitmentTalentSourceService,
    RecruitmentWorkspaceService,
    HttpRecruitmentResumeSourceGateway,
    OpenAiRecruitmentResumeAnalyzer,
    {
      provide: RecruitmentResumeSourceGateway,
      useExisting: HttpRecruitmentResumeSourceGateway,
    },
    {
      provide: RecruitmentResumeAiAnalyzer,
      useExisting: OpenAiRecruitmentResumeAnalyzer,
    },
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
    RecruitmentESignSourceService,
    RecruitmentOnboardingBridgeService,
    RecruitmentResumeService,
    RecruitmentTalentSourceService,
    RecruitmentWorkspaceService,
  ],
})
export class RecruitmentCoreModule {}
