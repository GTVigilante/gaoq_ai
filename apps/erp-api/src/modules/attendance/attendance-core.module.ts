import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';

import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { ApprovalCoreModule } from '../approval/approval-core.module.js';
import { IdentityPersistenceModule } from '../identity/identity-persistence.module.js';
import { OrgCoreModule } from '../org/org-core.module.js';
import {
  AttendanceProviderEmployeeMappingRecord,
  AttendanceProviderEmployeeMappingRecordSchema,
  AttendanceProviderInboxRecord,
  AttendanceProviderInboxRecordSchema,
  AttendanceProviderStateRecord,
  AttendanceProviderStateRecordSchema,
} from '../integration/attendance-provider.schemas.js';
import { OutboxRecord, OutboxRecordSchema } from '../org/persistence/outbox.schema.js';
import { AttendanceApplicationService } from './application/attendance-application.service.js';
import { AttendanceRuleApplicationService } from './application/attendance-rule-application.service.js';
import { AttendanceShiftApplicationService } from './application/attendance-shift-application.service.js';
import { AttendanceShiftQueueService } from './attendance-shift-queue.service.js';
import { ATTENDANCE_SHIFT_QUEUE } from './attendance-shift.queue.js';
import { AttendanceDataCryptoService } from './persistence/attendance-data-crypto.service.js';
import { AttendanceOutboxWriter } from './persistence/attendance-outbox.writer.js';
import { AttendanceSourceReadinessRepository } from './persistence/attendance-source-readiness.repository.js';
import {
  AttendanceCorrectionRepository,
  AttendanceMonthlySnapshotRepository,
  AttendanceShiftPlanRepository,
  AttendanceSourceFactRepository,
} from './persistence/attendance.repositories.js';
import {
  AttendanceProviderCoverageRepository,
  AttendanceShiftAssignmentRepository,
  AttendanceShiftRuleRepository,
} from './persistence/attendance-rules.repositories.js';
import {
  AttendanceProviderCoverageRecord,
  AttendanceProviderCoverageRecordSchema,
  AttendanceShiftAssignmentGuardRecord,
  AttendanceShiftAssignmentGuardRecordSchema,
  AttendanceShiftAssignmentRecord,
  AttendanceShiftAssignmentRecordSchema,
  AttendanceShiftRuleRecord,
  AttendanceShiftRuleRecordSchema,
} from './persistence/attendance-rules.schemas.js';
import {
  AttendanceCorrectionRecord,
  AttendanceCorrectionRecordSchema,
  AttendanceMonthlySnapshotRecord,
  AttendanceMonthlySnapshotRecordSchema,
  AttendanceSourceFactRecord,
  AttendanceSourceFactRecordSchema,
  AttendanceShiftPlanRecord,
  AttendanceShiftPlanRecordSchema,
} from './persistence/attendance.schemas.js';

@Module({
  imports: [
    IdempotencyModule,
    ApprovalCoreModule,
    IdentityPersistenceModule,
    OrgCoreModule,
    BullModule.registerQueue({ name: ATTENDANCE_SHIFT_QUEUE }),
    MongooseModule.forFeature([
      { name: AttendanceSourceFactRecord.name, schema: AttendanceSourceFactRecordSchema },
      { name: AttendanceShiftPlanRecord.name, schema: AttendanceShiftPlanRecordSchema },
      { name: AttendanceCorrectionRecord.name, schema: AttendanceCorrectionRecordSchema },
      { name: AttendanceMonthlySnapshotRecord.name, schema: AttendanceMonthlySnapshotRecordSchema },
      { name: AttendanceShiftRuleRecord.name, schema: AttendanceShiftRuleRecordSchema },
      {
        name: AttendanceShiftAssignmentRecord.name,
        schema: AttendanceShiftAssignmentRecordSchema,
      },
      {
        name: AttendanceShiftAssignmentGuardRecord.name,
        schema: AttendanceShiftAssignmentGuardRecordSchema,
      },
      {
        name: AttendanceProviderCoverageRecord.name,
        schema: AttendanceProviderCoverageRecordSchema,
      },
      {
        name: AttendanceProviderEmployeeMappingRecord.name,
        schema: AttendanceProviderEmployeeMappingRecordSchema,
      },
      { name: AttendanceProviderStateRecord.name, schema: AttendanceProviderStateRecordSchema },
      { name: AttendanceProviderInboxRecord.name, schema: AttendanceProviderInboxRecordSchema },
      { name: OutboxRecord.name, schema: OutboxRecordSchema },
    ]),
  ],
  providers: [
    AttendanceApplicationService,
    AttendanceRuleApplicationService,
    AttendanceShiftApplicationService,
    AttendanceShiftQueueService,
    AttendanceDataCryptoService,
    AttendanceSourceFactRepository,
    AttendanceShiftPlanRepository,
    AttendanceCorrectionRepository,
    AttendanceMonthlySnapshotRepository,
    AttendanceShiftRuleRepository,
    AttendanceShiftAssignmentRepository,
    AttendanceProviderCoverageRepository,
    AttendanceSourceReadinessRepository,
    AttendanceOutboxWriter,
  ],
  exports: [
    AttendanceApplicationService,
    AttendanceRuleApplicationService,
    AttendanceShiftApplicationService,
    AttendanceShiftQueueService,
    AttendanceDataCryptoService,
  ],
})
export class AttendanceCoreModule {}
