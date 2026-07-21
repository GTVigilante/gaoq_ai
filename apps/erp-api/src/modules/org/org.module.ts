import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OrgApplicationService } from './application/org-application.service.js';
import { OrgController } from './org.controller.js';

import {
  OrgDepartmentRecord,
  OrgDepartmentRecordSchema,
  OrgEmployeeRecord,
  OrgEmployeeRecordSchema,
  OrgJobLevelRecord,
  OrgJobLevelRecordSchema,
  OrgPositionRecord,
  OrgPositionRecordSchema,
} from './persistence/org.schemas.js';
import {
  DepartmentRepository,
  EmployeeRepository,
  JobLevelRepository,
  PositionRepository,
} from './persistence/org.repositories.js';
import { OutboxRecord, OutboxRecordSchema } from './persistence/outbox.schema.js';
import { OrgOutboxWriter } from './persistence/outbox.writer.js';

@Module({
  imports: [
    IdempotencyModule,
    IdentityModule,
    MongooseModule.forFeature([
      { name: OrgDepartmentRecord.name, schema: OrgDepartmentRecordSchema },
      { name: OrgEmployeeRecord.name, schema: OrgEmployeeRecordSchema },
      { name: OrgPositionRecord.name, schema: OrgPositionRecordSchema },
      { name: OrgJobLevelRecord.name, schema: OrgJobLevelRecordSchema },
      { name: OutboxRecord.name, schema: OutboxRecordSchema },
    ]),
  ],
  providers: [
    OrgApplicationService,
    DepartmentRepository,
    EmployeeRepository,
    PositionRepository,
    JobLevelRepository,
    OrgOutboxWriter,
  ],
  controllers: [OrgController],
  exports: [
    OrgApplicationService,
    DepartmentRepository,
    EmployeeRepository,
    PositionRepository,
    JobLevelRepository,
    OrgOutboxWriter,
  ],
})
export class OrgModule {}
