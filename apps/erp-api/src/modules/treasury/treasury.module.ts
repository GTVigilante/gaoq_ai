import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { TreasuryDataCryptoService } from './persistence/treasury-data-crypto.service.js';
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

@Module({
  imports: [MongooseModule.forFeature([
    { name: TreasuryBankAccountRecord.name, schema: TreasuryBankAccountRecordSchema },
    { name: TreasuryPaymentInstructionRecord.name, schema: TreasuryPaymentInstructionRecordSchema },
    { name: TreasuryDisbursementBatchRecord.name, schema: TreasuryDisbursementBatchRecordSchema },
    { name: TreasuryBankReturnRecord.name, schema: TreasuryBankReturnRecordSchema },
  ])],
  providers: [TreasuryDataCryptoService],
  exports: [TreasuryDataCryptoService],
})
export class TreasuryModule {}
