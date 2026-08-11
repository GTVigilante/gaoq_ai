import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuditModule } from '../../core/audit/audit.module.js';
import { SupplierQualificationScanRepository } from './persistence/supplier-qualification-scan.repository.js';
import { SupplierRelationshipRecord, SupplierRelationshipRecordSchema } from './persistence/supplier.schemas.js';
import { SUPPLIER_QUALIFICATION_QUEUE } from './supplier-qualification.queue.js';
import { SupplierQualificationProcessor } from './supplier-qualification.processor.js';
import { SupplierQualificationQueueService } from './supplier-qualification-queue.service.js';
import { SupplierQualificationScheduleBootstrap } from './supplier-qualification-schedule.bootstrap.js';
import { SupplierModule } from './supplier.module.js';

@Module({
  imports: [
    AuditModule,
    SupplierModule,
    MongooseModule.forFeature([
      { name: SupplierRelationshipRecord.name, schema: SupplierRelationshipRecordSchema },
    ]),
    BullModule.registerQueue({ name: SUPPLIER_QUALIFICATION_QUEUE }),
  ],
  providers: [
    SupplierQualificationScanRepository,
    SupplierQualificationQueueService,
    SupplierQualificationScheduleBootstrap,
    SupplierQualificationProcessor,
  ],
})
export class SupplierWorkerModule {}
