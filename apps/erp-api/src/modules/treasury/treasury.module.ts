import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { OrgModule } from '../org/org.module.js';
import { OutboxRecord, OutboxRecordSchema } from '../org/persistence/outbox.schema.js';
import { TreasuryBankAccountService } from './application/treasury-bank-account.service.js';
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
    MongooseModule.forFeature([
      { name: TreasuryBankAccountRecord.name, schema: TreasuryBankAccountRecordSchema },
      { name: TreasuryPaymentInstructionRecord.name, schema: TreasuryPaymentInstructionRecordSchema },
      { name: TreasuryDisbursementBatchRecord.name, schema: TreasuryDisbursementBatchRecordSchema },
      { name: TreasuryBankReturnRecord.name, schema: TreasuryBankReturnRecordSchema },
      { name: OutboxRecord.name, schema: OutboxRecordSchema },
    ]),
  ],
  controllers: [TreasuryController],
  providers: [TreasuryBankAccountService, TreasuryDataCryptoService, TreasuryOutboxWriter],
  exports: [TreasuryBankAccountService, TreasuryDataCryptoService],
})
export class TreasuryModule {}
