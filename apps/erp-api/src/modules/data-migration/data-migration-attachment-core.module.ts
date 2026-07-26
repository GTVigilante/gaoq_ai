import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuditModule } from '../../core/audit/audit.module.js';
import { TenantContextModule } from '../../core/tenant/tenant-context.module.js';
import { DocumentModule } from '../document/document.module.js';
import { DataMigrationAttachmentService } from './application/data-migration-attachment.service.js';
import { DATA_MIGRATION_ATTACHMENT_QUEUE } from './data-migration-attachment.queue.js';
import { HttpDataMigrationAttachmentGateway } from './integration/data-migration-attachment-http.adapter.js';
import { DataMigrationAttachmentGateway } from './integration/data-migration-attachment.ports.js';
import {
  DataMigrationAttachmentRecord,
  DataMigrationAttachmentRecordSchema,
  DataMigrationRunRecord,
  DataMigrationRunRecordSchema,
} from './persistence/data-migration.schemas.js';

/** 附件迁移最小运行核心；禁止为 Worker 引入完整迁移控制面和其他业务模块。 */
@Module({
  imports: [
    AuditModule,
    TenantContextModule,
    DocumentModule,
    BullModule.registerQueue({ name: DATA_MIGRATION_ATTACHMENT_QUEUE }),
    MongooseModule.forFeature([
      { name: DataMigrationRunRecord.name, schema: DataMigrationRunRecordSchema },
      { name: DataMigrationAttachmentRecord.name, schema: DataMigrationAttachmentRecordSchema },
    ]),
  ],
  providers: [
    DataMigrationAttachmentService,
    HttpDataMigrationAttachmentGateway,
    { provide: DataMigrationAttachmentGateway, useExisting: HttpDataMigrationAttachmentGateway },
  ],
  exports: [DataMigrationAttachmentService],
})
export class DataMigrationAttachmentCoreModule {}
