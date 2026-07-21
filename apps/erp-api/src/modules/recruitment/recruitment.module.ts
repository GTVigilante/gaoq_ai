import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { TenantContextModule } from '../../core/tenant/tenant-context.module.js';
import { OrgModule } from '../org/org.module.js';
import { ApprovalModule } from '../approval/approval.module.js';
import { OutboxRecord, OutboxRecordSchema } from '../org/persistence/outbox.schema.js';
import { RecruitmentDataCryptoService } from './persistence/recruitment-data-crypto.service.js';
import { RecruitmentOutboxWriter } from './persistence/recruitment-outbox.writer.js';
import { RecruitmentApplicationService } from './application/recruitment-application.service.js';
import { RecruitmentManagementService } from './application/recruitment-management.service.js';
import { RecruitmentController } from './recruitment.controller.js';
import { RecruitmentManagementController } from './recruitment-management.controller.js';
import {
  CandidateApplicationRepository,
  CandidateApplicationStageRepository,
  CandidateConsentEvidenceRepository,
  RecruitmentCandidateRepository,
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
  RecruitmentPositionRecord,
  RecruitmentPositionRecordSchema,
  RecruitmentRequisitionRecord,
  RecruitmentRequisitionRecordSchema,
} from './persistence/recruitment.schemas.js';

/** Phase 3 招聘模块；候选人密文、职位申请和状态事件共享租户与事务底座。 */
@Module({
  imports: [
    IdempotencyModule,
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
    RecruitmentApplicationService,
    RecruitmentManagementService,
  ],
  controllers: [RecruitmentController, RecruitmentManagementController],
  exports: [
    RecruitmentDataCryptoService,
    RecruitmentOutboxWriter,
    RecruitmentCandidateRepository,
    RecruitmentPositionRepository,
    RecruitmentRequisitionRepository,
    CandidateApplicationRepository,
    RecruitmentApplicationService,
    RecruitmentManagementService,
  ],
})
export class RecruitmentModule {}
