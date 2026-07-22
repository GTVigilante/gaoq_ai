import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuditModule } from '../../core/audit/audit.module.js';
import { TenantContextModule } from '../../core/tenant/tenant-context.module.js';
import { OrgModule } from '../org/org.module.js';
import { ApprovalModule } from '../approval/approval.module.js';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { PayrollModule } from '../payroll/payroll.module.js';
import { RecruitmentModule } from '../recruitment/recruitment.module.js';
import { DataMigrationAttachmentService } from './application/data-migration-attachment.service.js';
import { DataMigrationService } from './application/data-migration.service.js';
import { DATA_MIGRATION_ATTACHMENT_QUEUE } from './data-migration-attachment.queue.js';
import { DataMigrationController } from './data-migration.controller.js';
import { HttpDataMigrationAttachmentGateway } from './integration/data-migration-attachment-http.adapter.js';
import { DataMigrationAttachmentGateway } from './integration/data-migration-attachment.ports.js';
import {
  DataMigrationAssociationRecord,
  DataMigrationAssociationRecordSchema,
  DataMigrationAttachmentRecord,
  DataMigrationAttachmentRecordSchema,
  DataMigrationItemRecord,
  DataMigrationItemRecordSchema,
  DataMigrationMappingRecord,
  DataMigrationMappingRecordSchema,
  DataMigrationRunRecord,
  DataMigrationRunRecordSchema,
} from './persistence/data-migration.schemas.js';

@Module({
  imports: [
    AuditModule, TenantContextModule, OrgModule, ApprovalModule, RecruitmentModule,
    AttendanceModule,
    PayrollModule,
    BullModule.registerQueue({ name: DATA_MIGRATION_ATTACHMENT_QUEUE }),
    MongooseModule.forFeature([
      { name: DataMigrationRunRecord.name, schema: DataMigrationRunRecordSchema },
      { name: DataMigrationItemRecord.name, schema: DataMigrationItemRecordSchema },
      { name: DataMigrationMappingRecord.name, schema: DataMigrationMappingRecordSchema },
      { name: DataMigrationAssociationRecord.name, schema: DataMigrationAssociationRecordSchema },
      { name: DataMigrationAttachmentRecord.name, schema: DataMigrationAttachmentRecordSchema },
    ]),
  ],
  controllers: [DataMigrationController],
  providers: [
    DataMigrationService,
    DataMigrationAttachmentService,
    HttpDataMigrationAttachmentGateway,
    { provide: DataMigrationAttachmentGateway, useExisting: HttpDataMigrationAttachmentGateway },
  ],
  exports: [DataMigrationService, DataMigrationAttachmentService],
})
export class DataMigrationModule {}
