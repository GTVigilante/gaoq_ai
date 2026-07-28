import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuditModule } from '../../core/audit/audit.module.js';
import { TenantContextModule } from '../../core/tenant/tenant-context.module.js';
import {
  ApprovalActionRecord,
  ApprovalActionRecordSchema,
  ApprovalInstanceRecord,
  ApprovalInstanceRecordSchema,
} from '../approval/persistence/approval.schemas.js';
import { KnowledgeTrainingAssignmentRecord, KnowledgeTrainingAssignmentRecordSchema } from '../knowledge/persistence/knowledge.schemas.js';
import { OpOperatingSummaryRecord, OpOperatingSummaryRecordSchema } from '../op/persistence/op.schemas.js';
import { OrgEmployeeRecord, OrgEmployeeRecordSchema } from '../org/persistence/org.schemas.js';
import { PayrollPeriodRecord, PayrollPeriodRecordSchema } from '../payroll/persistence/payroll.schemas.js';
import {
  CandidateApplicationRecord, CandidateApplicationRecordSchema,
  RecruitmentPositionRecord, RecruitmentPositionRecordSchema,
} from '../recruitment/persistence/recruitment.schemas.js';
import { ANALYTICS_EXPORT_QUEUE } from './analytics-export.queue.js';
import { AnalyticsExportService } from './application/analytics-export.service.js';
import { ManagementDashboardService } from './application/management-dashboard.service.js';
import {
  AnalyticsManagementExportRecord,
  AnalyticsManagementExportRecordSchema,
} from './persistence/analytics.schemas.js';

@Module({
  imports: [
    AuditModule, TenantContextModule,
    BullModule.registerQueue({ name: ANALYTICS_EXPORT_QUEUE }),
    MongooseModule.forFeature([
      { name: OrgEmployeeRecord.name, schema: OrgEmployeeRecordSchema },
      { name: ApprovalInstanceRecord.name, schema: ApprovalInstanceRecordSchema },
      { name: ApprovalActionRecord.name, schema: ApprovalActionRecordSchema },
      { name: RecruitmentPositionRecord.name, schema: RecruitmentPositionRecordSchema },
      { name: CandidateApplicationRecord.name, schema: CandidateApplicationRecordSchema },
      { name: KnowledgeTrainingAssignmentRecord.name, schema: KnowledgeTrainingAssignmentRecordSchema },
      { name: PayrollPeriodRecord.name, schema: PayrollPeriodRecordSchema },
      { name: OpOperatingSummaryRecord.name, schema: OpOperatingSummaryRecordSchema },
      { name: AnalyticsManagementExportRecord.name, schema: AnalyticsManagementExportRecordSchema },
    ]),
  ],
  providers: [ManagementDashboardService, AnalyticsExportService],
  exports: [ManagementDashboardService, AnalyticsExportService],
})
export class AnalyticsCoreModule {}
