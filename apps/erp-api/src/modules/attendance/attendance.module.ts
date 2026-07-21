import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { ApprovalModule } from '../approval/approval.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OrgModule } from '../org/org.module.js';
import { OutboxRecord, OutboxRecordSchema } from '../org/persistence/outbox.schema.js';
import { AttendanceApplicationService } from './application/attendance-application.service.js';
import { AttendanceController } from './attendance.controller.js';
import { AttendanceDataCryptoService } from './persistence/attendance-data-crypto.service.js';
import { AttendanceOutboxWriter } from './persistence/attendance-outbox.writer.js';
import {
  AttendanceCorrectionRepository,
  AttendanceMonthlySnapshotRepository,
  AttendanceSourceFactRepository,
} from './persistence/attendance.repositories.js';
import {
  AttendanceCorrectionRecord,
  AttendanceCorrectionRecordSchema,
  AttendanceMonthlySnapshotRecord,
  AttendanceMonthlySnapshotRecordSchema,
  AttendanceSourceFactRecord,
  AttendanceSourceFactRecordSchema,
} from './persistence/attendance.schemas.js';

@Module({
  imports: [
    IdempotencyModule,
    ApprovalModule,
    IdentityModule,
    OrgModule,
    MongooseModule.forFeature([
      { name: AttendanceSourceFactRecord.name, schema: AttendanceSourceFactRecordSchema },
      { name: AttendanceCorrectionRecord.name, schema: AttendanceCorrectionRecordSchema },
      { name: AttendanceMonthlySnapshotRecord.name, schema: AttendanceMonthlySnapshotRecordSchema },
      { name: OutboxRecord.name, schema: OutboxRecordSchema },
    ]),
  ],
  controllers: [AttendanceController],
  providers: [
    AttendanceApplicationService,
    AttendanceDataCryptoService,
    AttendanceSourceFactRepository,
    AttendanceCorrectionRepository,
    AttendanceMonthlySnapshotRepository,
    AttendanceOutboxWriter,
  ],
  exports: [AttendanceApplicationService, AttendanceDataCryptoService],
})
export class AttendanceModule {}
