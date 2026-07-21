import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { OrgModule } from '../org/org.module.js';
import { StrongAuthModule } from '../identity/strong-auth/strong-auth.module.js';
import { OutboxRecord, OutboxRecordSchema } from '../org/persistence/outbox.schema.js';
import { PayrollModule } from '../payroll/payroll.module.js';
import { TreasuryBankAccountService } from './application/treasury-bank-account.service.js';
import { TreasuryDisbursementService } from './application/treasury-disbursement.service.js';
import { HttpTreasuryBankSubmissionGateway } from './integration/treasury-bank-submission-http.adapter.js';
import { TreasuryBankSubmissionGateway } from './integration/treasury-bank-submission.ports.js';
import { HttpTreasuryImmutableArchive } from './integration/treasury-evidence-http.adapter.js';
import { TreasuryImmutableArchive } from './integration/treasury-evidence.ports.js';
import { TreasuryDataCryptoService } from './persistence/treasury-data-crypto.service.js';
import { TreasuryOutboxWriter } from './persistence/treasury-outbox.writer.js';
import {
  TreasuryBankAccountRecord,
  TreasuryBankAccountRecordSchema,
  TreasuryBankReturnRecord,
  TreasuryBankReturnRecordSchema,
  TreasuryDisbursementBatchRecord,
  TreasuryDisbursementBatchRecordSchema,
  TreasuryPaymentInstructionRecord,
  TreasuryPaymentInstructionRecordSchema,
} from './persistence/treasury.schemas.js';
import { TreasuryController } from './treasury.controller.js';

@Module({
  imports: [
    IdempotencyModule,
    OrgModule,
    PayrollModule,
    StrongAuthModule,
    MongooseModule.forFeature([
      { name: TreasuryBankAccountRecord.name, schema: TreasuryBankAccountRecordSchema },
      { name: TreasuryPaymentInstructionRecord.name, schema: TreasuryPaymentInstructionRecordSchema },
      { name: TreasuryDisbursementBatchRecord.name, schema: TreasuryDisbursementBatchRecordSchema },
      { name: TreasuryBankReturnRecord.name, schema: TreasuryBankReturnRecordSchema },
      { name: OutboxRecord.name, schema: OutboxRecordSchema },
    ]),
  ],
  controllers: [TreasuryController],
  providers: [
    TreasuryBankAccountService,
    TreasuryDisbursementService,
    TreasuryDataCryptoService,
    TreasuryOutboxWriter,
    HttpTreasuryBankSubmissionGateway,
    HttpTreasuryImmutableArchive,
    { provide: TreasuryBankSubmissionGateway, useExisting: HttpTreasuryBankSubmissionGateway },
    { provide: TreasuryImmutableArchive, useExisting: HttpTreasuryImmutableArchive },
  ],
  exports: [TreasuryBankAccountService, TreasuryDisbursementService, TreasuryDataCryptoService],
})
export class TreasuryModule {}
