import { describe, expect, it } from 'vitest';

import {
  applyBankReturn,
  approveDisbursementExport,
  createDisbursementBatch,
  recordBankSubmission,
} from './disbursement-batch.js';

const now = new Date('2026-07-31T10:00:00.000Z');

function submitted() {
  const batch = createDisbursementBatch({
    id: 'batch-001', tenantId: 'tenant-001', payrollPeriodId: 'period-001',
    payrollRunId: 'run-001', fileHash: 'a'.repeat(43), lineCount: 2,
    totalMinor: 1_839_600, preparedBy: 'treasury-maker', payrollLockedBy: 'payroll-locker',
  }, now);
  const exported = approveDisbursementExport(batch, {
    tenantId: batch.tenantId, expectedVersion: 1, approvedBy: 'treasury-checker',
    strongAuthEvidenceId: 'evidence-001', objectEvidenceId: 'object-001',
  }, now);
  return recordBankSubmission(exported, {
    tenantId: batch.tenantId, expectedVersion: 2, bankSubmissionId: 'bank-001',
    bankSubmissionEvidenceId: 'submission-001', trustedConnector: true,
  }, now);
}

describe('代发批次状态机', () => {
  const batchInput = {
    id: 'batch-001', tenantId: 'tenant-001', payrollPeriodId: 'period-001',
    payrollRunId: 'run-001', fileHash: 'a'.repeat(43), lineCount: 1,
    totalMinor: 100, preparedBy: 'maker', payrollLockedBy: 'locker',
  };

  it('强制工资锁定、制备、导出批准三方分离', () => {
    expect(() => createDisbursementBatch({
      id: 'batch-001', tenantId: 'tenant-001', payrollPeriodId: 'period-001',
      payrollRunId: 'run-001', fileHash: 'a'.repeat(43), lineCount: 1,
      totalMinor: 100, preparedBy: 'same-user', payrollLockedBy: 'same-user',
    }, now)).toThrow(/锁定人/u);
    const batch = createDisbursementBatch({
      id: 'batch-001', tenantId: 'tenant-001', payrollPeriodId: 'period-001',
      payrollRunId: 'run-001', fileHash: 'a'.repeat(43), lineCount: 1,
      totalMinor: 100, preparedBy: 'maker', payrollLockedBy: 'locker',
    }, now);
    expect(() => approveDisbursementExport(batch, {
      tenantId: batch.tenantId, expectedVersion: 1, approvedBy: 'maker',
      strongAuthEvidenceId: 'evidence-001', objectEvidenceId: 'object-001',
    }, now)).toThrow(/必须独立/u);
    expect(() => approveDisbursementExport(batch, {
      tenantId: batch.tenantId, expectedVersion: 1, approvedBy: 'locker',
      strongAuthEvidenceId: 'evidence-001', objectEvidenceId: 'object-001',
    }, now)).toThrow(/工资锁定人/u);
  });

  it('完整成功回盘进入对账，不能直接宣告已对账', () => {
    const batch = submitted();
    const returned = applyBankReturn(batch, {
      tenantId: batch.tenantId, expectedVersion: 3, returnHash: 'b'.repeat(43),
      signatureVerified: true, fileProtectionPassed: true, successfulCount: 2, failedCount: 0,
      unknownCount: 0, duplicateCount: 0, successfulMinor: 1_839_600, failedMinor: 0,
      lineAmountMismatchCount: 0,
    }, now);
    expect(returned).toMatchObject({ status: 'reconciling', freezeReason: null, version: 4 });
  });

  it.each([
    ['部分成功', { successfulCount: 1, failedCount: 1, successfulMinor: 1_000_000, failedMinor: 839_600 }],
    ['未知行', { unknownCount: 1 }],
    ['重复行', { duplicateCount: 1 }],
    ['行金额错位', { lineAmountMismatchCount: 1 }],
    ['签名失败', { signatureVerified: false }],
    ['恶意文件', { fileProtectionPassed: false }],
    ['总额不守恒', { successfulMinor: 1_839_599 }],
  ])('%s 回盘冻结批次', (_label, changes) => {
    const batch = submitted();
    const returned = applyBankReturn(batch, {
      tenantId: batch.tenantId, expectedVersion: 3, returnHash: 'b'.repeat(43),
      signatureVerified: true, fileProtectionPassed: true, successfulCount: 2, failedCount: 0,
      unknownCount: 0, duplicateCount: 0, successfulMinor: 1_839_600, failedMinor: 0,
      lineAmountMismatchCount: 0,
      ...changes,
    }, now);
    expect(returned.status).toBe('frozen');
    expect(returned.freezeReason).not.toBeNull();
  });

  it.each([
    ['标识', { id: '<invalid>' }, /标识非法/u],
    ['摘要', { fileHash: 'short' }, /摘要非法/u],
    ['零行', { lineCount: 0 }, /行数非法/u],
    ['超大行数', { lineCount: 5_001 }, /行数非法/u],
    ['非整数行数', { lineCount: 1.5 }, /行数非法/u],
    ['零金额', { totalMinor: 0 }, /金额非法/u],
    ['非安全金额', { totalMinor: Number.MAX_SAFE_INTEGER + 1 }, /金额非法/u],
  ])('拒绝非法批次%s', (_label, changes, expected) => {
    expect(() => createDisbursementBatch({ ...batchInput, ...changes }, now)).toThrow(expected);
  });

  it('拒绝非法时间与命令上下文，并保持不可变状态', () => {
    expect(() => createDisbursementBatch(batchInput, new Date('invalid'))).toThrow(/时间非法/u);
    const batch = createDisbursementBatch(batchInput, now);
    expect(Object.isFrozen(batch)).toBe(true);
    const command = {
      tenantId: batch.tenantId, expectedVersion: 1, approvedBy: 'checker',
      strongAuthEvidenceId: 'evidence-001', objectEvidenceId: 'object-001',
    };
    expect(() => approveDisbursementExport(batch, {
      ...command, tenantId: 'tenant-other',
    }, now)).toThrow(/租户不匹配/u);
    expect(() => approveDisbursementExport(batch, {
      ...command, expectedVersion: 2,
    }, now)).toThrow(/版本冲突/u);
    expect(() => recordBankSubmission(batch, {
      tenantId: batch.tenantId, expectedVersion: 1, bankSubmissionId: 'bank-001',
      bankSubmissionEvidenceId: 'submission-001', trustedConnector: true,
    }, now)).toThrow(/状态迁移无效/u);
    expect(() => approveDisbursementExport(batch, {
      ...command, approvedBy: '<invalid>',
    }, now)).toThrow(/标识非法/u);
  });

  it('拒绝不可信提交、非法回盘控制量和汇总溢出', () => {
    const batch = createDisbursementBatch(batchInput, now);
    const exported = approveDisbursementExport(batch, {
      tenantId: batch.tenantId, expectedVersion: 1, approvedBy: 'checker',
      strongAuthEvidenceId: 'evidence-001', objectEvidenceId: 'object-001',
    }, now);
    expect(() => recordBankSubmission(exported, {
      tenantId: batch.tenantId, expectedVersion: 2, bankSubmissionId: 'bank-001',
      bankSubmissionEvidenceId: 'submission-001', trustedConnector: false,
    }, now)).toThrow(/不可信/u);
    const bankSubmitted = recordBankSubmission(exported, {
      tenantId: batch.tenantId, expectedVersion: 2, bankSubmissionId: 'bank-001',
      bankSubmissionEvidenceId: 'submission-001', trustedConnector: true,
    }, now);
    const baseReturn = {
      tenantId: batch.tenantId, expectedVersion: 3, returnHash: 'b'.repeat(43),
      signatureVerified: true, fileProtectionPassed: true, successfulCount: 1, failedCount: 0,
      unknownCount: 0, duplicateCount: 0, successfulMinor: 100, failedMinor: 0,
      lineAmountMismatchCount: 0,
    };
    expect(() => applyBankReturn(bankSubmitted, {
      ...baseReturn, returnHash: 'short',
    }, now)).toThrow(/摘要非法/u);
    for (const changes of [
      { successfulCount: -1 }, { failedCount: 0.5 }, { unknownCount: Number.NaN },
    ]) {
      expect(() => applyBankReturn(bankSubmitted, {
        ...baseReturn, ...changes,
      }, now)).toThrow(/行数非法/u);
    }
    expect(() => applyBankReturn(bankSubmitted, {
      ...baseReturn, successfulMinor: -1,
    }, now)).toThrow(/金额非法/u);
    expect(applyBankReturn(bankSubmitted, {
      ...baseReturn, successfulCount: 0, failedCount: 0,
      successfulMinor: Number.MAX_SAFE_INTEGER, failedMinor: 1,
    }, now)).toMatchObject({ status: 'frozen', freezeReason: 'COUNT_MISMATCH' });
  });
});
