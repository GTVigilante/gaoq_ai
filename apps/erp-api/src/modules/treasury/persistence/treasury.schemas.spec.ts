import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  TreasuryBankAccountRecordSchema,
  TreasuryBankReturnRecordSchema,
  TreasuryDisbursementBatchRecordSchema,
  TreasuryPaymentInstructionRecordSchema,
} from './treasury.schemas.js';
import type {
  TreasuryBankAccountRecord,
  TreasuryBankReturnRecord,
  TreasuryDisbursementBatchRecord,
} from './treasury.schemas.js';

const mongoose = new Mongoose();
const AccountModel = mongoose.model<TreasuryBankAccountRecord>(
  'SpecTreasuryBankAccount', TreasuryBankAccountRecordSchema,
);
const BatchModel = mongoose.model<TreasuryDisbursementBatchRecord>(
  'SpecTreasuryDisbursementBatch', TreasuryDisbursementBatchRecordSchema,
);
const ReturnModel = mongoose.model<TreasuryBankReturnRecord>(
  'SpecTreasuryBankReturn', TreasuryBankReturnRecordSchema,
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
    expect(stored.approvalReferenceType).toBe('approval_instance');
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
    expect(TreasuryBankAccountRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, migrationEvidenceRef: 1 }, expect.objectContaining({
        unique: true, partialFilterExpression: { migrationEvidenceRef: { $type: 'string' } },
      }),
    ]);
    expect(TreasuryBankReturnRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, returnHash: 1 }, expect.objectContaining({ unique: true }),
    ]);
    expect(TreasuryBankReturnRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, migrationEvidenceRef: 1 }, expect.objectContaining({
        unique: true, partialFilterExpression: { migrationEvidenceRef: { $type: 'string' } },
      }),
    ]);
    expect(TreasuryDisbursementBatchRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, recoverySourceBatchId: 1 }, expect.objectContaining({ unique: true }),
    ]);
    expect(TreasuryDisbursementBatchRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, migrationEvidenceRef: 1 }, expect.objectContaining({
        unique: true, partialFilterExpression: { migrationEvidenceRef: { $type: 'string' } },
      }),
    ]);
  });

  it('迁移代发批次必须成对绑定审批判别与迁移 WORM 证据', async () => {
    const base = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4B1', tenantId: 'tenant-001',
      payrollPeriodId: '01J8ZQK7V0A2M4N6P8R0T2W4P1',
      payrollRunId: '01J8ZQK7V0A2M4N6P8R0T2W4R1',
      payrollResultHash: 'p'.repeat(43), payableResultHash: 'q'.repeat(43),
      batchSequence: 1, parentBatchId: null, recoverySourceBatchId: null,
      purpose: 'regular', format: 'ISO20022_PAIN_001_001_03', fileHash: 'f'.repeat(43),
      lineCount: 1, totalMinor: 839_500, preparedBy: 'maker',
      payrollLockedBy: 'locker', exportApprovedBy: 'checker',
      strongAuthEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4H1',
      strongAuthReferenceType: 'migration_export_approval_evidence',
      objectEvidenceId: 'migration-object',
      objectRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/batch-001',
      bankSubmissionId: 'bank-submission', bankSubmissionEvidenceId: 'bank-evidence',
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/batch-001',
      migrationEvidenceChecksum: 'm'.repeat(43),
      status: 'submitted', version: 4,
      dataKeyId: 'treasury-key-001', dataIv: 'c'.repeat(16),
      dataCiphertext: 'd'.repeat(64), dataAuthTag: 'e'.repeat(22),
    };
    await expect(new BatchModel(base).validate()).resolves.toBeUndefined();
    await expect(new BatchModel({
      ...base, migrationEvidenceChecksum: null,
    }).validate()).rejects.toThrow('代发迁移证据引用与校验和必须成对出现');
    await expect(new BatchModel({
      ...base, strongAuthEvidenceId: null,
    }).validate()).rejects.toThrow('代发批准证据类型与标识必须成对出现');
  });

  it('历史审批账户必须成对绑定迁移 WORM 引用和摘要', async () => {
    const base = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4Z8', tenantId: 'tenant-001',
      ownerType: 'employee', ownerId: 'employee-001', version: 1,
      accountBlindIndexes: [`blind-key-001.${'a'.repeat(43)}`],
      approvalEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4H1',
      approvalReferenceType: 'legacy_history', status: 'active',
      dataKeyId: 'treasury-key-001', dataIv: 'c'.repeat(16),
      dataCiphertext: 'd'.repeat(64), dataAuthTag: 'e'.repeat(22),
    };
    await expect(new AccountModel(base).validate()).rejects.toThrow('必须绑定迁移证据');
    await expect(new AccountModel({
      ...base,
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/account-001',
      migrationEvidenceChecksum: 'm'.repeat(43),
    }).validate()).resolves.toBeUndefined();
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

  it('历史银行回盘必须绑定带判别的迁移证据', async () => {
    const base = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4R9', tenantId: 'tenant-001',
      batchId: '01J8ZQK7V0A2M4N6P8R0T2W4B9', bankSubmissionId: 'bank-submission',
      sequence: 1, returnHash: 'r'.repeat(43), objectEvidenceId: 'object-evidence',
      objectRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/return-001',
      signatureEvidenceId: 'signature-evidence', signatureVerified: true,
      malwareScanEvidenceId: 'scan-evidence', malwareClean: true,
      evidenceReferenceType: 'migration_return_evidence',
      successfulCount: 1, failedCount: 0, unknownCount: 0, duplicateCount: 0,
      lineAmountMismatchCount: 0, successfulMinor: 839_500, failedMinor: 0,
      outcome: 'accepted', receivedAt: new Date('2026-07-22T12:00:00.000Z'),
      dataKeyId: 'treasury-key-001', dataIv: 'c'.repeat(16),
      dataCiphertext: 'd'.repeat(64), dataAuthTag: 'e'.repeat(22),
    };
    await expect(new ReturnModel(base).validate()).rejects.toThrow(
      '历史银行回盘必须绑定迁移证据',
    );
    await expect(new ReturnModel({
      ...base, migrationEvidenceRef: base.objectRef,
      migrationEvidenceChecksum: 'm'.repeat(43),
    }).validate()).resolves.toBeUndefined();
  });
});
