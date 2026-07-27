import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { IdentityPersistenceModule } from '../identity/identity-persistence.module.js';
import { OrgApplicationService } from './application/org-application.service.js';
import { OrgTalentSourceService } from './application/org-talent-source.service.js';

import {
  OrgDepartmentRecord,
  OrgDepartmentRecordSchema,
  OrgEmployeeRecord,
  OrgEmployeeRecordSchema,
  OrgJobLevelRecord,
  OrgJobLevelRecordSchema,
  OrgPositionRecord,
  OrgPositionRecordSchema,
  OrgPersonRecord,
  OrgPersonRecordSchema,
  OrgEmploymentRecord,
  OrgEmploymentRecordSchema,
  OrgEmployeeNumberSequenceRecord,
  OrgEmployeeNumberSequenceRecordSchema,
} from './persistence/org.schemas.js';
import {
  DepartmentRepository,
  EmployeeRepository,
  JobLevelRepository,
  PositionRepository,
  PersonRepository,
  EmploymentRepository,
  EmployeeNumberSequenceRepository,
} from './persistence/org.repositories.js';
import { OutboxRecord, OutboxRecordSchema } from './persistence/outbox.schema.js';
import { OrgOutboxWriter } from './persistence/outbox.writer.js';

@Module({
  imports: [
    IdempotencyModule,
    IdentityPersistenceModule,
    MongooseModule.forFeature([
      { name: OrgDepartmentRecord.name, schema: OrgDepartmentRecordSchema },
      { name: OrgEmployeeRecord.name, schema: OrgEmployeeRecordSchema },
      { name: OrgPositionRecord.name, schema: OrgPositionRecordSchema },
      { name: OrgJobLevelRecord.name, schema: OrgJobLevelRecordSchema },
      { name: OrgPersonRecord.name, schema: OrgPersonRecordSchema },
      { name: OrgEmploymentRecord.name, schema: OrgEmploymentRecordSchema },
      {
        name: OrgEmployeeNumberSequenceRecord.name,
        schema: OrgEmployeeNumberSequenceRecordSchema,
      },
      { name: OutboxRecord.name, schema: OutboxRecordSchema },
    ]),
  ],
  providers: [
    OrgApplicationService,
    OrgTalentSourceService,
    DepartmentRepository,
    EmployeeRepository,
    PositionRepository,
    JobLevelRepository,
    OrgOutboxWriter,
    PersonRepository,
    EmploymentRepository,
    EmployeeNumberSequenceRepository,
  ],
  exports: [
    OrgApplicationService,
    OrgTalentSourceService,
    DepartmentRepository,
    EmployeeRepository,
    PositionRepository,
    JobLevelRepository,
    OrgOutboxWriter,
    PersonRepository,
    EmploymentRepository,
    EmployeeNumberSequenceRepository,
  ],
})
export class OrgCoreModule {}
