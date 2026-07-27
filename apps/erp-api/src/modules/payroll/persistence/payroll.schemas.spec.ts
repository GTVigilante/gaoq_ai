import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  PayrollCompensationProfileRecordSchema,
  PayrollAdjustmentRecordSchema,
  PayrollAdjustmentReceivableRecordSchema,
  PayrollAdjustmentReceivableRecoveryRecordSchema,
  PayrollAdjustmentTaxCorrectionRecordSchema,
  PayrollAnnualReconciliationRecordSchema,
  PayrollCalculationRunRecordSchema,
  PayrollPeriodApprovalEvidenceRecordSchema,
  PayrollPeriodLockEvidenceRecordSchema,
  PayrollPeriodRecordSchema,
  PayrollReconciliationRecordSchema,
  PayrollRulePackRecordSchema,
  PayrollTaxFilingRecordSchema,
  PayrollShadowCycleRecordSchema,
  PayrollShadowExplanationRecordSchema,
  PayrollShadowSignoffRecordSchema,
  PayrollCutoverReadinessRecordSchema,
  type PayrollCompensationProfileRecord,
  type PayrollAdjustmentRecord,
  type PayrollAdjustmentReceivableRecord,
  type PayrollAdjustmentReceivableRecoveryRecord,
  type PayrollAdjustmentTaxCorrectionRecord,
  type PayrollAnnualReconciliationRecord,
  type PayrollReconciliationRecord,
  type PayrollTaxFilingRecord,
  type PayrollShadowCycleRecord,
} from './payroll.schemas.js';

const mongoose = new Mongoose();
const ProfileModel = mongoose.model<PayrollCompensationProfileRecord>(
  'SpecPayrollCompensationProfile', PayrollCompensationProfileRecordSchema,
);
const AdjustmentModel = mongoose.model<PayrollAdjustmentRecord>(
  'SpecPayrollAdjustment', PayrollAdjustmentRecordSchema,
);
const AdjustmentReceivableModel = mongoose.model<PayrollAdjustmentReceivableRecord>(
  'SpecPayrollAdjustmentReceivable', PayrollAdjustmentReceivableRecordSchema,
);
const AdjustmentRecoveryModel = mongoose.model<PayrollAdjustmentReceivableRecoveryRecord>(
  'SpecPayrollAdjustmentRecovery', PayrollAdjustmentReceivableRecoveryRecordSchema,
);
const AdjustmentTaxCorrectionModel = mongoose.model<PayrollAdjustmentTaxCorrectionRecord>(
  'SpecPayrollAdjustmentTaxCorrection', PayrollAdjustmentTaxCorrectionRecordSchema,
);
const AnnualReconciliationModel = mongoose.model<PayrollAnnualReconciliationRecord>(
  'SpecPayrollAnnualReconciliation', PayrollAnnualReconciliationRecordSchema,
);
const TaxFilingModel = mongoose.model<PayrollTaxFilingRecord>(
  'SpecPayrollTaxFiling', PayrollTaxFilingRecordSchema,
);
const ReconciliationModel = mongoose.model<PayrollReconciliationRecord>(
  'SpecPayrollReconciliation', PayrollReconciliationRecordSchema,
);
const ShadowCycleModel = mongoose.model<PayrollShadowCycleRecord>(
  'SpecPayrollShadowCycle', PayrollShadowCycleRecordSchema,
);

describe('Payroll 持久化契约', () => {
  it('工资调整密文与收付方向不可矛盾', async () => {
    const base = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4A3', tenantId: 'tenant-001',
      periodId: '01J8ZQK7V0A2M4N6P8R0T2W4P1', period: '2026-07',
      originalRunId: '01J8ZQK7V0A2M4N6P8R0T2W4R1',
      originalCalculationLineId: '01J8ZQK7V0A2M4N6P8R0T2W4N1',
      employeeId: 'employee-001', adjustmentNumber: 1,
      type: 'supplement', reasonCode: 'RETROACTIVE_SALARY_CHANGE',
      originalResultHash: 'o'.repeat(43), correctedInputHash: 'i'.repeat(43),
      correctedResultHash: 'r'.repeat(43), adjustmentHash: 'a'.repeat(43),
      grossDeltaMinor: 100_000, taxDeltaMinor: 3_000, netDeltaMinor: 97_000,
      payableMinor: 97_000, receivableMinor: 0, preparedBy: 'payroll-engine',
      cashSettlementStatus: 'pending', taxCorrectionStatus: 'pending',
      status: 'prepared', version: 1,
      dataKeyId: 'payroll-key-001', dataIv: 'b'.repeat(16),
      dataCiphertext: 'c'.repeat(32), dataAuthTag: 'd'.repeat(22),
    };
    await expect(new AdjustmentModel(base).validate()).resolves.toBeUndefined();
    await expect(new AdjustmentModel({
      ...base, type: 'reversal', payableMinor: 0, receivableMinor: 97_000,
    }).validate()).rejects.toThrow('工资调整类型与收付方向不一致');
    await expect(new AdjustmentModel({
      ...base,
      status: 'locked',
      requestedBy: 'payroll-requester',
      approvalInstanceId: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
      approvalDecidedBy: 'finance-approver',
      approvalEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
      lockedBy: null,
      strongAuthEvidenceId: null,
      version: 4,
    }).validate()).rejects.toThrow('工资调整审批、锁定证据与状态不一致');
    await expect(new AdjustmentModel({
      ...base,
      status: 'locked',
      requestedBy: 'payroll-requester',
      approvalInstanceId: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
      approvalDecidedBy: 'finance-approver',
      approvalEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
      lockedBy: 'treasury-locker',
      strongAuthEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4E1',
      version: 4,
    }).validate()).resolves.toBeUndefined();
    await expect(new AdjustmentModel({
      ...base,
      type: 'reversal',
      grossDeltaMinor: -100_000,
      taxDeltaMinor: -3_000,
      netDeltaMinor: -97_000,
      payableMinor: 0,
      receivableMinor: 97_000,
      cashSettlementReferenceType: 'receivable',
      cashSettlementReferenceId: '01J8ZQK7V0A2M4N6P8R0T2W4V1',
      status: 'locked',
      requestedBy: 'payroll-requester',
      approvalInstanceId: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
      approvalDecidedBy: 'finance-approver',
      approvalEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
      lockedBy: 'treasury-locker',
      strongAuthEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4E1',
      version: 5,
    }).validate()).resolves.toBeUndefined();
    expect(JSON.stringify(new AdjustmentModel(base).toObject()))
      .not.toMatch(/"correctedInput":|"taxableEarnings":|"attendanceSnapshot":/u);
    expect(PayrollAdjustmentRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, originalCalculationLineId: 1, adjustmentNumber: 1 },
      expect.objectContaining({ unique: true }),
    ]);
  });

  it('员工应收余额与恢复凭证保持追加式一致性', async () => {
    const receivable = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4V1',
      tenantId: 'tenant-001',
      adjustmentId: '01J8ZQK7V0A2M4N6P8R0T2W4A3',
      adjustmentHash: 'a'.repeat(43),
      currency: 'CNY',
      originalAmountMinor: 97_000,
      outstandingAmountMinor: 57_000,
      openedBy: 'finance-receivable-opener',
      openedAt: new Date('2026-07-22T00:00:00.000Z'),
      settledAt: null,
      status: 'open',
      version: 2,
      dataKeyId: 'payroll-key-001',
      dataIv: 'b'.repeat(16),
      dataCiphertext: 'c'.repeat(32),
      dataAuthTag: 'd'.repeat(22),
    };
    await expect(new AdjustmentReceivableModel(receivable).validate())
      .resolves.toBeUndefined();
    await expect(new AdjustmentReceivableModel({
      ...receivable,
      outstandingAmountMinor: 0,
    }).validate()).rejects.toThrow('工资调整应收余额、状态与结算时间不一致');
    const recovery = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4W1',
      tenantId: 'tenant-001',
      receivableId: receivable.id,
      method: 'authorized_payroll_deduction',
      amountMinor: 40_000,
      sourceReferenceId: 'payroll-run-2026-08',
      sourceEvidenceId: 'worm-payroll-run-2026-08',
      legalAuthorizationEvidenceId: 'employee-consent-001',
      receivedAt: new Date('2026-08-01T00:00:00.000Z'),
      recordedBy: 'trusted-payroll-runner',
      recoveryHash: 'r'.repeat(43),
    };
    await expect(new AdjustmentRecoveryModel(recovery).validate())
      .resolves.toBeUndefined();
    await expect(new AdjustmentRecoveryModel({
      ...recovery,
      legalAuthorizationEvidenceId: null,
    }).validate()).rejects.toThrow('工资调整应收恢复方式、金额与法定授权证据不一致');
    expect(PayrollAdjustmentReceivableRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, adjustmentId: 1 },
      expect.objectContaining({ unique: true }),
    ]);
    expect(PayrollAdjustmentReceivableRecoveryRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, sourceEvidenceId: 1 },
      expect.objectContaining({ unique: true }),
    ]);
  });

  it('工资调整税务更正要求 WORM、强认证和税局回执按状态成套出现', async () => {
    const base = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4F1',
      tenantId: 'tenant-001',
      adjustmentId: '01J8ZQK7V0A2M4N6P8R0T2W4A3',
      adjustmentHash: 'a'.repeat(43),
      period: '2026-07',
      format: 'CN_IIT_WITHHOLDING_CORRECTION_V1',
      contentHash: 'c'.repeat(43),
      correctedTaxableEarningsMinor: 1_100_000,
      correctedWithholdingTaxMinor: 13_500,
      taxableEarningsDeltaMinor: 100_000,
      withholdingTaxDeltaMinor: 3_000,
      preparedBy: 'tax-correction-maker',
      approvedBy: null,
      strongAuthEvidenceId: null,
      strongAuthReferenceType: null,
      objectRef: null,
      objectEvidenceId: null,
      taxSubmissionId: null,
      taxSubmissionEvidenceId: null,
      status: 'archiving',
      version: 1,
      dataKeyId: 'payroll-key-001',
      dataIv: 'b'.repeat(16),
      dataCiphertext: 'c'.repeat(32),
      dataAuthTag: 'd'.repeat(22),
    };
    await expect(new AdjustmentTaxCorrectionModel(base).validate())
      .resolves.toBeUndefined();
    await expect(new AdjustmentTaxCorrectionModel({
      ...base,
      status: 'prepared',
      version: 2,
    }).validate()).rejects.toThrow('工资调整税务更正状态、版本与证据不一致');
    await expect(new AdjustmentTaxCorrectionModel({
      ...base,
      objectRef: 'worm/payroll-tax/correction-001',
      objectEvidenceId: 'worm-correction-evidence-001',
      approvedBy: 'tax-correction-approver',
      strongAuthEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4E1',
      strongAuthReferenceType: 'webauthn_evidence',
      taxSubmissionId: 'tax-correction-submission-001',
      taxSubmissionEvidenceId: 'tax-correction-receipt-001',
      status: 'submitted',
      version: 4,
    }).validate()).resolves.toBeUndefined();
    expect(PayrollAdjustmentTaxCorrectionRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, adjustmentId: 1 },
      expect.objectContaining({ unique: true }),
    ]);
  });

  it('年度工资代扣只明文保存控制状态且税局评估证据必须成套', async () => {
    const base = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4Y1', tenantId: 'tenant-001',
      employeeId: 'employee-001', taxYear: '2026', periodCount: 12,
      firstPeriod: '2026-01', lastPeriod: '2026-12',
      officialAssessmentId: null, officialAssessmentEvidenceId: null,
      officialAssessmentSourceDigest: null, status: 'awaiting_assessment',
      evidenceHash: 'e'.repeat(43), preparedBy: 'annual-tax-service', version: 1,
      dataKeyId: 'payroll-key-001', dataIv: 'b'.repeat(16),
      dataCiphertext: 'c'.repeat(32), dataAuthTag: 'd'.repeat(22),
    };
    await expect(new AnnualReconciliationModel(base).validate()).resolves.toBeUndefined();
    await expect(new AnnualReconciliationModel({
      ...base, officialAssessmentId: 'assessment-2026',
    }).validate()).rejects.toThrow('年度税局评估引用、证据与摘要必须成套出现');
    expect(JSON.stringify(new AnnualReconciliationModel(base).toObject()))
      .not.toMatch(/totalPayrollWithheld|assessedTaxMinor|filingEvidenceIds/u);
    expect(PayrollAnnualReconciliationRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, employeeId: 1, taxYear: 1, version: 1 },
      expect.objectContaining({ unique: true }),
    ]);
  });

  it('薪酬档案不保存金额明文，并要求完整独立密文', async () => {
    const document = new ProfileModel({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4Y6', tenantId: 'tenant-001',
      employeeId: 'employee-001', jurisdictionCode: 'CN-SH',
      version: 1, effectiveFrom: '2026-01-01',
      effectiveTo: null, approvalEvidenceId: 'approval-001', status: 'active',
      profileHash: 'a'.repeat(43), dataKeyId: 'payroll-key-001', dataIv: 'b'.repeat(16),
      dataCiphertext: 'c'.repeat(32), dataAuthTag: 'd'.repeat(22),
    });
    await expect(document.validate()).resolves.toBeUndefined();
    expect(document.toObject()).not.toHaveProperty('baseSalaryMinor');
    await expect(new ProfileModel({ ...document.toObject(), dataAuthTag: '' }).validate())
      .rejects.toThrow(/dataAuthTag/);
    await expect(new ProfileModel({
      ...document.toObject(),
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/profile-001',
      migrationEvidenceChecksum: null,
    }).validate()).rejects.toThrow('必须成对出现');
  });

  it('迁移规则包要求 WORM 引用与校验和成对出现', async () => {
    const RuleModel = mongoose.model('SpecPayrollMigrationRule', PayrollRulePackRecordSchema);
    const valid = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4R1', tenantId: 'tenant-001', code: 'CN_IIT',
      version: 1, jurisdictionCode: 'CN', effectiveFrom: '2026-01-01',
      effectiveTo: '2026-12-31', monthlyBasicDeductionMinor: 500_000,
      taxBrackets: [{ upperBoundMinor: null, rateBps: 300, quickDeductionMinor: 0 }],
      roundingMode: 'HALF_UP', rulesHash: 'r'.repeat(43), sourceDigest: 's'.repeat(43),
      sourceReference: 'tax-law-2026', approvalEvidenceId: 'approval-history-001',
      status: 'published',
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/rule-001',
      migrationEvidenceChecksum: 'w'.repeat(43),
    };
    await expect(new RuleModel(valid).validate()).resolves.toBeUndefined();
    await expect(new RuleModel({
      ...valid, migrationEvidenceChecksum: null,
    }).validate()).rejects.toThrow('必须成对出现');
  });

  it('迁移工资周期与计算运行要求唯一且成对的 WORM 证据', async () => {
    const PeriodModel = mongoose.model('SpecPayrollMigrationPeriod', PayrollPeriodRecordSchema);
    const RunModel = mongoose.model('SpecPayrollMigrationRun', PayrollCalculationRunRecordSchema);
    const evidenceRef =
      'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/payroll-001';
    await expect(new PeriodModel({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4P1', tenantId: 'tenant-001', period: '2026-06',
      currency: 'CNY', status: 'collecting', preparedBy: 'actor-001', version: 2,
      migrationEvidenceRef: evidenceRef, migrationEvidenceChecksum: null,
    }).validate()).rejects.toThrow('必须成对出现');
    await expect(new RunModel({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4R1', tenantId: 'tenant-001',
      periodId: '01J8ZQK7V0A2M4N6P8R0T2W4P1', period: '2026-06', runNumber: 1,
      engineVersion: 'cn-cumulative-withholding-v1',
      rulePackId: '01J8ZQK7V0A2M4N6P8R0T2W4T1', rulePackVersion: 1,
      status: 'completed', inputSnapshotHash: 'i'.repeat(43), resultHash: 'r'.repeat(43),
      employeeCount: 1, totalGrossMinor: 1, totalTaxMinor: 0, totalNetMinor: 1,
      completedAt: new Date('2026-06-03T00:00:00.000Z'),
      migrationEvidenceRef: evidenceRef, migrationEvidenceChecksum: null,
    }).validate()).rejects.toThrow('必须成对出现');
    for (const schema of [PayrollPeriodRecordSchema, PayrollCalculationRunRecordSchema]) {
      expect(schema.indexes()).toContainEqual([
        { tenantId: 1, migrationEvidenceRef: 1 }, expect.objectContaining({ unique: true }),
      ]);
    }
  });

  it('旧在线周期引用可安全补齐类型且拒绝半对引用', async () => {
    const PeriodModel = mongoose.model('SpecPayrollPeriodReferences', PayrollPeriodRecordSchema);
    const base = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4P2', tenantId: 'tenant-001', period: '2026-07',
      currency: 'CNY', status: 'approved', preparedBy: 'actor-preparer-001', version: 5,
      approvalInstanceId: 'approval-instance-001', approvedBy: 'actor-approver-001',
      approvalEvidenceId: 'approval-instance-001',
    };
    const compatible = new PeriodModel(base);
    await expect(compatible.validate()).resolves.toBeUndefined();
    expect(compatible.approvalReferenceType).toBe('approval_instance');
    await expect(new PeriodModel({
      ...base, approvalInstanceId: null, approvalReferenceType: 'legacy_history',
    }).validate()).rejects.toThrow('必须成对出现');
  });

  it('工资批准与锁定迁移证据为租户唯一 WORM 控制记录', async () => {
    const ApprovalModel = mongoose.model(
      'SpecPayrollPeriodApprovalEvidence', PayrollPeriodApprovalEvidenceRecordSchema,
    );
    const LockModel = mongoose.model(
      'SpecPayrollPeriodLockEvidence', PayrollPeriodLockEvidenceRecordSchema,
    );
    const approvedAt = new Date('2026-06-03T00:00:00.000Z');
    const evidenceRef =
      'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/control-001';
    await expect(new ApprovalModel({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4A1', tenantId: 'tenant-001',
      periodId: '01J8ZQK7V0A2M4N6P8R0T2W4P1',
      approvalHistoryId: '01J8ZQK7V0A2M4N6P8R0T2W4H1',
      approvalEvidenceChecksum: 'a'.repeat(43), approvedBy: 'actor-approver-001',
      approvedAt, periodVersion: 5, migrationEvidenceRef: evidenceRef,
      migrationEvidenceChecksum: 'e'.repeat(43),
    }).validate()).resolves.toBeUndefined();
    await expect(new LockModel({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4N1', tenantId: 'tenant-001',
      periodId: '01J8ZQK7V0A2M4N6P8R0T2W4P1',
      approvalControlEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
      lockedBy: 'actor-locker-001', lockedAt: new Date('2026-06-04T00:00:00.000Z'),
      periodVersion: 6, strongAuthMethod: 'webauthn_uv',
      operationId: '01J8ZQK7V0A2M4N6P8R0T2W4P1', migrationEvidenceRef: evidenceRef,
      migrationEvidenceChecksum: 'l'.repeat(43),
    }).validate()).resolves.toBeUndefined();
    for (const schema of [
      PayrollPeriodApprovalEvidenceRecordSchema, PayrollPeriodLockEvidenceRecordSchema,
    ]) {
      expect(schema.indexes()).toContainEqual([
        { tenantId: 1, migrationEvidenceRef: 1 }, expect.objectContaining({ unique: true }),
      ]);
      for (const [key, options] of schema.indexes()) {
        if (options.unique === true) expect(Object.keys(key)[0]).toBe('tenantId');
      }
    }
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
    expect(PayrollCompensationProfileRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, migrationEvidenceRef: 1 }, expect.objectContaining({ unique: true }),
    ]);
    expect(PayrollRulePackRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, migrationEvidenceRef: 1 }, expect.objectContaining({ unique: true }),
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
    expect(PayrollReconciliationRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, migrationEvidenceRef: 1 }, expect.objectContaining({ unique: true }),
    ]);
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
    const migrated = new TaxFilingModel({
      ...document.toObject(), status: 'submitted', version: 4,
      approvedBy: 'tax-approver', strongAuthEvidenceId: 'migration-evidence-001',
      strongAuthReferenceType: 'migration_tax_approval_evidence',
      objectRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/tax-001',
      objectEvidenceId: 'migration-evidence-001',
      taxSubmissionId: 'legacy-tax-submission-001',
      taxSubmissionEvidenceId: 'legacy-tax-evidence-001',
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/tax-001',
      migrationEvidenceChecksum: 'm'.repeat(43),
    });
    await expect(migrated.validate()).resolves.toBeUndefined();
    expect(PayrollTaxFilingRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, migrationEvidenceRef: 1 }, expect.objectContaining({ unique: true }),
    ]);
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
      ...base, evidenceReferenceType: 'migration_reconciliation_evidence',
    }).validate()).rejects.toThrow('历史四方对账必须绑定迁移证据');
    await expect(new ReconciliationModel({
      ...base, evidenceReferenceType: 'migration_reconciliation_evidence',
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/recon-001',
      migrationEvidenceChecksum: 'm'.repeat(43),
    }).validate()).resolves.toBeUndefined();
    await expect(new ReconciliationModel({
      ...base, status: 'frozen', differences: ['UNCONTROLLED_DIFFERENCE'],
    }).validate()).rejects.toThrow(/differences/);
    expect(JSON.stringify(new ReconciliationModel(base).toObject()))
      .not.toMatch(/employeeId|account|identityEvidence|objectRef/u);
  });

  it('影子周期只保存密文与控制量，并以租户前缀约束全部业务唯一键', async () => {
    const document = new ShadowCycleModel({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4C2', tenantId: 'tenant-001',
      periodId: '01J8ZQK7V0A2M4N6P8R0T2W4P2',
      payrollRunId: '01J8ZQK7V0A2M4N6P8R0T2W4R2', period: '2026-07',
      sourceSystem: 'legacy-payroll', sourceExportId: 'legacy-export-001',
      sourceObjectEvidenceId: 'legacy-worm-001',
      sourceSignatureEvidenceId: 'legacy-signature-001',
      sourceManifestHash: 'm'.repeat(43), payrollResultHash: 'p'.repeat(43),
      comparisonHash: 'c'.repeat(43), erpEmployeeCount: 1, legacyEmployeeCount: 1,
      erpTotalGrossMinor: 100_000, legacyTotalGrossMinor: 100_000,
      erpTotalTaxMinor: 1_000, legacyTotalTaxMinor: 1_000,
      erpTotalNetMinor: 90_000, legacyTotalNetMinor: 90_000,
      differenceCount: 0, differenceCodes: [], totalAbsoluteDifferenceMinor: 0,
      importedBy: 'legacy-connector', version: 1,
      dataKeyId: 'payroll-key-001', dataIv: 'a'.repeat(16),
      dataCiphertext: 'b'.repeat(32), dataAuthTag: 'c'.repeat(22),
    });
    await expect(document.validate()).resolves.toBeUndefined();
    expect(document.toObject()).not.toHaveProperty('lines');
    expect(JSON.stringify(document.toObject())).not.toContain('employeeId');
    for (const schema of [
      PayrollShadowCycleRecordSchema, PayrollShadowExplanationRecordSchema,
      PayrollShadowSignoffRecordSchema, PayrollCutoverReadinessRecordSchema,
    ]) for (const [key, options] of schema.indexes()) {
      if (options.unique === true) expect(Object.keys(key)[0]).toBe('tenantId');
    }
  });
});
