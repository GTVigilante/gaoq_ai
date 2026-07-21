import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

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
    MongooseModule.forFeature([
      { name: OrgDepartmentRecord.name, schema: OrgDepartmentRecordSchema },
      { name: OrgEmployeeRecord.name, schema: OrgEmployeeRecordSchema },
      { name: OrgPositionRecord.name, schema: OrgPositionRecordSchema },
      { name: OrgJobLevelRecord.name, schema: OrgJobLevelRecordSchema },
      { name: OutboxRecord.name, schema: OutboxRecordSchema },
    ]),
  ],
  providers: [
    DepartmentRepository,
    EmployeeRepository,
    PositionRepository,
    JobLevelRepository,
    OrgOutboxWriter,
  ],
  exports: [
    DepartmentRepository,
    EmployeeRepository,
    PositionRepository,
    JobLevelRepository,
    OrgOutboxWriter,
  ],
})
export class OrgModule {}
