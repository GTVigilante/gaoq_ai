import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { ApprovalModule } from '../approval/approval.module.js';
import { StrongAuthModule } from '../identity/strong-auth/strong-auth.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { AttendanceMonthlySnapshotRecord, AttendanceMonthlySnapshotRecordSchema } from '../attendance/persistence/attendance.schemas.js';
import { OrgModule } from '../org/org.module.js';
import { OutboxRecord, OutboxRecordSchema } from '../org/persistence/outbox.schema.js';
import { PayrollMasterDataService } from './application/payroll-master-data.service.js';
import { PayrollApprovalService } from './application/payroll-approval.service.js';
import { PayrollRunService } from './application/payroll-run.service.js';
import { PayrollPayslipService } from './application/payroll-payslip.service.js';
import { PayrollTaxFilingService } from './application/payroll-tax-filing.service.js';
import { PayrollReconciliationService } from './application/payroll-reconciliation.service.js';
import { PayrollShadowService } from './application/payroll-shadow.service.js';
import { HttpPayrollTaxImmutableArchive } from './integration/payroll-tax-archive-http.adapter.js';
import { HttpPayrollTaxGateway } from './integration/payroll-tax-gateway-http.adapter.js';
import { PayrollTaxGateway, PayrollTaxImmutableArchive } from './integration/payroll-tax.ports.js';
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
  PayrollPeriodApprovalEvidenceRecord,
  PayrollPeriodApprovalEvidenceRecordSchema,
  PayrollPeriodLockEvidenceRecord,
  PayrollPeriodLockEvidenceRecordSchema,
  PayrollRulePackRecord,
  PayrollRulePackRecordSchema,
  PayrollReconciliationRecord,
  PayrollReconciliationRecordSchema,
  PayrollTaxFilingRecord,
  PayrollTaxFilingRecordSchema,
  PayrollShadowCycleRecord,
  PayrollShadowCycleRecordSchema,
  PayrollShadowDifferenceRecord,
  PayrollShadowDifferenceRecordSchema,
  PayrollShadowExplanationRecord,
  PayrollShadowExplanationRecordSchema,
  PayrollShadowSignoffRecord,
  PayrollShadowSignoffRecordSchema,
  PayrollCutoverReadinessRecord,
  PayrollCutoverReadinessRecordSchema,
} from './persistence/payroll.schemas.js';

@Module({
  imports: [
    IdempotencyModule,
    ApprovalModule,
    StrongAuthModule,
    IdentityModule,
    OrgModule,
    MongooseModule.forFeature([
      { name: PayrollRulePackRecord.name, schema: PayrollRulePackRecordSchema },
      { name: PayrollCompensationProfileRecord.name, schema: PayrollCompensationProfileRecordSchema },
      { name: PayrollPeriodRecord.name, schema: PayrollPeriodRecordSchema },
      {
        name: PayrollPeriodApprovalEvidenceRecord.name,
        schema: PayrollPeriodApprovalEvidenceRecordSchema,
      },
      { name: PayrollPeriodLockEvidenceRecord.name, schema: PayrollPeriodLockEvidenceRecordSchema },
      { name: PayrollCalculationRunRecord.name, schema: PayrollCalculationRunRecordSchema },
      { name: PayrollInputSnapshotRecord.name, schema: PayrollInputSnapshotRecordSchema },
      { name: PayrollCalculationLineRecord.name, schema: PayrollCalculationLineRecordSchema },
      { name: PayrollTaxFilingRecord.name, schema: PayrollTaxFilingRecordSchema },
      { name: PayrollReconciliationRecord.name, schema: PayrollReconciliationRecordSchema },
      { name: PayrollShadowCycleRecord.name, schema: PayrollShadowCycleRecordSchema },
      { name: PayrollShadowDifferenceRecord.name, schema: PayrollShadowDifferenceRecordSchema },
      { name: PayrollShadowExplanationRecord.name, schema: PayrollShadowExplanationRecordSchema },
      { name: PayrollShadowSignoffRecord.name, schema: PayrollShadowSignoffRecordSchema },
      { name: PayrollCutoverReadinessRecord.name, schema: PayrollCutoverReadinessRecordSchema },
      { name: AttendanceMonthlySnapshotRecord.name, schema: AttendanceMonthlySnapshotRecordSchema },
      { name: OutboxRecord.name, schema: OutboxRecordSchema },
    ]),
  ],
  controllers: [PayrollController],
  providers: [
    PayrollRunService,
    PayrollPayslipService,
    PayrollApprovalService,
    PayrollMasterDataService,
    PayrollTaxFilingService,
    PayrollReconciliationService,
    PayrollShadowService,
    PayrollDataCryptoService,
    PayrollOutboxWriter,
    HttpPayrollTaxImmutableArchive,
    HttpPayrollTaxGateway,
    { provide: PayrollTaxImmutableArchive, useExisting: HttpPayrollTaxImmutableArchive },
    { provide: PayrollTaxGateway, useExisting: HttpPayrollTaxGateway },
  ],
  exports: [
    PayrollRunService, PayrollPayslipService,
    PayrollApprovalService,
    PayrollMasterDataService,
    PayrollTaxFilingService, PayrollReconciliationService,
    PayrollShadowService,
  ],
})
export class PayrollModule {}
