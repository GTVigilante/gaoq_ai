import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { DATA_MIGRATION_ATTACHMENT_QUEUE } from './data-migration-attachment.queue.js';
import { DataMigrationAttachmentProcessor } from './data-migration-attachment.processor.js';
import { DataMigrationAttachmentCoreModule } from './data-migration-attachment-core.module.js';

/** 数据迁移独立 Worker 装配；附件正文永不进入 API 或 Worker 进程。 */
@Module({
  imports: [
    DataMigrationAttachmentCoreModule,
    BullModule.registerQueue({ name: DATA_MIGRATION_ATTACHMENT_QUEUE }),
  ],
  providers: [DataMigrationAttachmentProcessor],
})
export class DataMigrationWorkerModule {}
