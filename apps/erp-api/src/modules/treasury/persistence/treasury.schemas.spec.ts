import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  TreasuryBankAccountRecordSchema,
  TreasuryBankReturnRecordSchema,
  TreasuryDisbursementBatchRecordSchema,
  TreasuryPaymentInstructionRecordSchema,
} from './treasury.schemas.js';
import type { TreasuryBankAccountRecord } from './treasury.schemas.js';

const mongoose = new Mongoose();
const AccountModel = mongoose.model<TreasuryBankAccountRecord>(
  'SpecTreasuryBankAccount', TreasuryBankAccountRecordSchema,
);

describe('Treasury 持久化契约', () => {
  it('银行账户不保存户名、账号或清算行号明文，并要求完整密文与盲索引', async () => {
    const document = new AccountModel({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4Y8', tenantId: 'tenant-001',
      ownerType: 'employee', ownerId: 'employee-001', version: 1,
      accountBlindIndexes: [`blind-key-001.${'a'.repeat(43)}`],
      approvalEvidenceId: 'approval-001', status: 'active',
      dataKeyId: 'treasury-key-001', dataIv: 'c'.repeat(16),
      dataCiphertext: 'd'.repeat(64), dataAuthTag: 'e'.repeat(22),
    });
    await expect(document.validate()).resolves.toBeUndefined();
    const stored = document.toObject();
    expect(stored).not.toHaveProperty('account');
    expect(stored).not.toHaveProperty('accountName');
    expect(stored).not.toHaveProperty('clearingCode');
    expect(stored).not.toHaveProperty('dataHash');
    await expect(new AccountModel({ ...stored, dataAuthTag: '' }).validate())
      .rejects.toThrow(/dataAuthTag/u);
  });

  it('所有身份、防重和业务唯一索引均以可信租户为首字段', () => {
    for (const schema of [
      TreasuryBankAccountRecordSchema,
      TreasuryPaymentInstructionRecordSchema,
      TreasuryDisbursementBatchRecordSchema,
      TreasuryBankReturnRecordSchema,
    ]) {
      for (const [key, options] of schema.indexes()) {
        if (options.unique === true) expect(Object.keys(key)[0]).toBe('tenantId');
      }
    }
    expect(TreasuryBankAccountRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, accountBlindIndexes: 1 }, expect.objectContaining({ unique: true }),
    ]);
    expect(TreasuryBankReturnRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, returnHash: 1 }, expect.objectContaining({ unique: true }),
    ]);
  });

  it('员工级支付指令金额没有明文字段，批次仅保留控制总额', () => {
    expect(TreasuryPaymentInstructionRecordSchema.path('amountMinor')).toBeUndefined();
    expect(TreasuryPaymentInstructionRecordSchema.path('creditorAccount')).toBeUndefined();
    expect(TreasuryDisbursementBatchRecordSchema.path('totalMinor')).toBeDefined();
    expect(TreasuryDisbursementBatchRecordSchema.path('payrollResultHash')).toBeDefined();
    expect(TreasuryDisbursementBatchRecordSchema.path('payableResultHash')).toBeDefined();
    expect(TreasuryDisbursementBatchRecordSchema.path('fileContent')).toBeUndefined();
    expect(TreasuryDisbursementBatchRecordSchema.path('dataCiphertext')).toBeDefined();
    expect(TreasuryBankReturnRecordSchema.path('lines')).toBeUndefined();
    expect(TreasuryBankReturnRecordSchema.path('dataCiphertext')).toBeDefined();
  });
});
