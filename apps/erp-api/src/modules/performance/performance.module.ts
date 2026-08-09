import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { TenantContextModule } from '../../core/tenant/tenant-context.module.js';
import { IdentityPersistenceModule } from '../identity/identity-persistence.module.js';
import { OrgCoreModule } from '../org/org-core.module.js';
import { OutboxRecord, OutboxRecordSchema } from '../org/persistence/outbox.schema.js';
import { WorkforceModule } from '../workforce/workforce.module.js';
import { PerformanceService } from './application/performance.service.js';
import { PerformanceController } from './performance.controller.js';
import { PerformanceOutboxWriter } from './persistence/performance-outbox.writer.js';
import { PerformanceRepository } from './persistence/performance.repositories.js';
import { PerformanceAssignmentRecord, PerformanceAssignmentRecordSchema, PerformanceCycleRecord, PerformanceCycleRecordSchema, PerformancePayrollSnapshotRecord, PerformancePayrollSnapshotRecordSchema, PerformanceTemplateRecord, PerformanceTemplateRecordSchema } from './persistence/performance.schemas.js';

@Module({
  imports: [IdempotencyModule, TenantContextModule, IdentityPersistenceModule, OrgCoreModule, WorkforceModule, MongooseModule.forFeature([
    { name: PerformanceTemplateRecord.name, schema: PerformanceTemplateRecordSchema },
    { name: PerformanceCycleRecord.name, schema: PerformanceCycleRecordSchema },
    { name: PerformanceAssignmentRecord.name, schema: PerformanceAssignmentRecordSchema },
    { name: PerformancePayrollSnapshotRecord.name, schema: PerformancePayrollSnapshotRecordSchema },
    { name: OutboxRecord.name, schema: OutboxRecordSchema },
  ])],
  controllers: [PerformanceController],
  providers: [PerformanceService, PerformanceRepository, PerformanceOutboxWriter],
  exports: [PerformanceService],
})
export class PerformanceModule {}
