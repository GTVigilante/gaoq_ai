import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { TenantContextModule } from '../../core/tenant/tenant-context.module.js';
import { OrgCoreModule } from '../org/org-core.module.js';
import { WorkforceService } from './application/workforce.service.js';
import { HrbpAssignmentRepository, ReportingLineRepository } from './persistence/workforce.repositories.js';
import { HrbpAssignmentRecord, HrbpAssignmentRecordSchema, ReportingLineRecord, ReportingLineRecordSchema } from './persistence/workforce.schemas.js';
import { WorkforceController } from './workforce.controller.js';

@Module({
  imports: [
    IdempotencyModule,
    TenantContextModule,
    OrgCoreModule,
    MongooseModule.forFeature([
      { name: ReportingLineRecord.name, schema: ReportingLineRecordSchema },
      { name: HrbpAssignmentRecord.name, schema: HrbpAssignmentRecordSchema },
    ]),
  ],
  controllers: [WorkforceController],
  providers: [WorkforceService, ReportingLineRepository, HrbpAssignmentRepository],
  exports: [WorkforceService, ReportingLineRepository, HrbpAssignmentRepository],
})
export class WorkforceModule {}
