import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuditModule } from '../../core/audit/audit.module.js';
import { TenantContextModule } from '../../core/tenant/tenant-context.module.js';
import { OrgModule } from '../org/org.module.js';
import { DataMigrationService } from './application/data-migration.service.js';
import { DataMigrationController } from './data-migration.controller.js';
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
    AuditModule, TenantContextModule, OrgModule,
    MongooseModule.forFeature([
      { name: DataMigrationRunRecord.name, schema: DataMigrationRunRecordSchema },
      { name: DataMigrationItemRecord.name, schema: DataMigrationItemRecordSchema },
      { name: DataMigrationMappingRecord.name, schema: DataMigrationMappingRecordSchema },
      { name: DataMigrationAssociationRecord.name, schema: DataMigrationAssociationRecordSchema },
      { name: DataMigrationAttachmentRecord.name, schema: DataMigrationAttachmentRecordSchema },
    ]),
  ],
  controllers: [DataMigrationController],
  providers: [DataMigrationService],
  exports: [DataMigrationService],
})
export class DataMigrationModule {}
