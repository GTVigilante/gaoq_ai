import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  PayrollCompensationProfileRecordSchema,
  PayrollPeriodRecordSchema,
  PayrollReconciliationRecordSchema,
  PayrollRulePackRecordSchema,
  PayrollTaxFilingRecordSchema,
  type PayrollCompensationProfileRecord,
  type PayrollReconciliationRecord,
  type PayrollTaxFilingRecord,
} from './payroll.schemas.js';

const mongoose = new Mongoose();
const ProfileModel = mongoose.model<PayrollCompensationProfileRecord>(
  'SpecPayrollCompensationProfile', PayrollCompensationProfileRecordSchema,
);
const TaxFilingModel = mongoose.model<PayrollTaxFilingRecord>(
  'SpecPayrollTaxFiling', PayrollTaxFilingRecordSchema,
);
const ReconciliationModel = mongoose.model<PayrollReconciliationRecord>(
  'SpecPayrollReconciliation', PayrollReconciliationRecordSchema,
);

describe('Payroll 持久化契约', () => {
  it('薪酬档案不保存金额明文，并要求完整独立密文', async () => {
    const document = new ProfileModel({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4Y6', tenantId: 'tenant-001',
      employeeId: 'employee-001', version: 1, effectiveFrom: '2026-01-01',
      effectiveTo: null, approvalEvidenceId: 'approval-001', status: 'active',
      profileHash: 'a'.repeat(43), dataKeyId: 'payroll-key-001', dataIv: 'b'.repeat(16),
      dataCiphertext: 'c'.repeat(32), dataAuthTag: 'd'.repeat(22),
    });
    await expect(document.validate()).resolves.toBeUndefined();
    expect(document.toObject()).not.toHaveProperty('baseSalaryMinor');
    await expect(new ProfileModel({ ...document.toObject(), dataAuthTag: '' }).validate())
      .rejects.toThrow(/dataAuthTag/);
  });

  it('规则、周期与薪酬版本唯一约束均包含租户前缀', () => {
    expect(PayrollRulePackRecordSchema.indexes()).toEqual(expect.arrayContaining([
      [{ tenantId: 1, code: 1, version: 1 }, expect.objectContaining({ unique: true })],
      [
        { tenantId: 1, jurisdictionCode: 1, version: 1 },
        expect.objectContaining({ unique: true }),
      ],
    ]));
    expect(PayrollCompensationProfileRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, employeeId: 1, version: 1 }, expect.objectContaining({ unique: true }),
    ]);
    expect(PayrollPeriodRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, period: 1 }, expect.objectContaining({ unique: true }),
    ]);
    expect(PayrollTaxFilingRecordSchema.indexes()).toEqual(expect.arrayContaining([
      [{ tenantId: 1, periodId: 1 }, expect.objectContaining({ unique: true })],
      [{ tenantId: 1, taxSubmissionId: 1 }, expect.objectContaining({ unique: true })],
    ]));
    for (const field of ['periodId', 'payrollRunId', 'batchId']) {
      expect(PayrollReconciliationRecordSchema.indexes()).toContainEqual([
        { tenantId: 1, [field]: 1 }, expect.objectContaining({ unique: true }),
      ]);
    }
  });

  it('个税清单只保存密文和控制摘要且限制安全整数', async () => {
    const document = new TaxFilingModel({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4F1', tenantId: 'tenant-001',
      periodId: '01J8ZQK7V0A2M4N6P8R0T2W4P1',
      payrollRunId: '01J8ZQK7V0A2M4N6P8R0T2W4R1', payrollResultHash: 'a'.repeat(43),
      format: 'CN_IIT_WITHHOLDING_MANIFEST_V1', contentHash: 'b'.repeat(43),
      employeeCount: 1, totalTaxableEarningsMinor: 1_000_000,
      totalWithholdingTaxMinor: 10_500, preparedBy: 'tax-maker', status: 'archiving',
      version: 1, dataKeyId: 'payroll-key-001', dataIv: 'c'.repeat(16),
      dataCiphertext: 'd'.repeat(32), dataAuthTag: 'e'.repeat(22),
    });
    await expect(document.validate()).resolves.toBeUndefined();
    expect(document.toObject()).not.toHaveProperty('lines');
    expect(document.toObject()).not.toHaveProperty('identityEvidenceId');
    const unsafe = new TaxFilingModel({
      ...document.toObject(), totalTaxableEarningsMinor: Number.MAX_SAFE_INTEGER + 1,
    });
    await expect(unsafe.validate()).rejects.toThrow(/totalTaxableEarningsMinor/);
  });

  it('四方对账快照固化完整证据引用且拒绝未知差异码', async () => {
    const base = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4C1', tenantId: 'tenant-001',
      periodId: '01J8ZQK7V0A2M4N6P8R0T2W4P1',
      payrollRunId: '01J8ZQK7V0A2M4N6P8R0T2W4R1', payrollResultHash: 'a'.repeat(43),
      batchId: '01J8ZQK7V0A2M4N6P8R0T2W4B1', bankReturnId: '01J8ZQK7V0A2M4N6P8R0T2W4N1',
      returnHash: 'b'.repeat(43), bankSubmissionId: 'bank-submission-001',
      disbursementObjectEvidenceId: 'treasury-worm-001',
      bankSubmissionEvidenceId: 'bank-evidence-001',
      bankReturnObjectEvidenceId: 'return-worm-001',
      signatureEvidenceId: 'return-signature-001', malwareScanEvidenceId: 'return-scan-001',
      taxFilingId: '01J8ZQK7V0A2M4N6P8R0T2W4F1', taxSubmissionId: 'tax-submission-001',
      taxSubmissionEvidenceId: 'tax-evidence-001', taxContentHash: 'c'.repeat(43),
      settlementChainHash: 's'.repeat(43),
      employeeCount: 2, bankLineCount: 2, totalGrossMinor: 2_000_000,
      totalNetMinor: 1_679_000, bankSubmittedMinor: 1_679_000,
      bankReturnedMinor: 1_679_000, totalTaxableEarningsMinor: 2_000_000,
      payrollWithholdingTaxMinor: 21_000, filedWithholdingTaxMinor: 21_000,
      differences: [], evidenceHash: 'e'.repeat(43), reconciledBy: 'reconciliation-service',
      status: 'balanced', version: 1,
    };
    await expect(new ReconciliationModel(base).validate()).resolves.toBeUndefined();
    await expect(new ReconciliationModel({
      ...base, status: 'frozen', differences: ['UNCONTROLLED_DIFFERENCE'],
    }).validate()).rejects.toThrow(/differences/);
    expect(JSON.stringify(new ReconciliationModel(base).toObject()))
      .not.toMatch(/employeeId|account|identityEvidence|objectRef/u);
  });
});
