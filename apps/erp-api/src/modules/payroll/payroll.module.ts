import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { AttendanceMonthlySnapshotRecord, AttendanceMonthlySnapshotRecordSchema } from '../attendance/persistence/attendance.schemas.js';
import { OrgModule } from '../org/org.module.js';
import { OutboxRecord, OutboxRecordSchema } from '../org/persistence/outbox.schema.js';
import { PayrollMasterDataService } from './application/payroll-master-data.service.js';
import { PayrollRunService } from './application/payroll-run.service.js';
import { PayrollController } from './payroll.controller.js';
import { PayrollDataCryptoService } from './persistence/payroll-data-crypto.service.js';
import { PayrollOutboxWriter } from './persistence/payroll-outbox.writer.js';
import {
  PayrollCalculationLineRecord,
  PayrollCalculationLineRecordSchema,
  PayrollCalculationRunRecord,
  PayrollCalculationRunRecordSchema,
  PayrollCompensationProfileRecord,
  PayrollCompensationProfileRecordSchema,
  PayrollInputSnapshotRecord,
  PayrollInputSnapshotRecordSchema,
  PayrollPeriodRecord,
  PayrollPeriodRecordSchema,
  PayrollRulePackRecord,
  PayrollRulePackRecordSchema,
} from './persistence/payroll.schemas.js';

@Module({
  imports: [
    IdempotencyModule,
    OrgModule,
    MongooseModule.forFeature([
      { name: PayrollRulePackRecord.name, schema: PayrollRulePackRecordSchema },
      { name: PayrollCompensationProfileRecord.name, schema: PayrollCompensationProfileRecordSchema },
      { name: PayrollPeriodRecord.name, schema: PayrollPeriodRecordSchema },
      { name: PayrollCalculationRunRecord.name, schema: PayrollCalculationRunRecordSchema },
      { name: PayrollInputSnapshotRecord.name, schema: PayrollInputSnapshotRecordSchema },
      { name: PayrollCalculationLineRecord.name, schema: PayrollCalculationLineRecordSchema },
      { name: AttendanceMonthlySnapshotRecord.name, schema: AttendanceMonthlySnapshotRecordSchema },
      { name: OutboxRecord.name, schema: OutboxRecordSchema },
    ]),
  ],
  controllers: [PayrollController],
  providers: [
    PayrollRunService,
    PayrollMasterDataService,
    PayrollDataCryptoService,
    PayrollOutboxWriter,
  ],
  exports: [PayrollRunService],
})
export class PayrollModule {}
