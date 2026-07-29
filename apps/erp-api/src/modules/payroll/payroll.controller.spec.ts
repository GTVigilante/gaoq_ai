import { BadRequestException, Logger, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants.js';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import type { AuditRecordInput } from '../../core/audit/audit.types.js';
import type { ErpRequest } from '../../core/http/request-context.js';
import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import type { VerifiedAccessToken } from '../identity/auth.types.js';
import type { PayrollApprovalService } from './application/payroll-approval.service.js';
import type { PayrollMasterDataService } from './application/payroll-master-data.service.js';
import type { PayrollPayslipService } from './application/payroll-payslip.service.js';
import type { PayrollReconciliationService } from './application/payroll-reconciliation.service.js';
import type { PayrollRunService } from './application/payroll-run.service.js';
import type { PayrollShadowService } from './application/payroll-shadow.service.js';
import type { PayrollTaxFilingService } from './application/payroll-tax-filing.service.js';
import { LegacyPayrollBoundaryGuard } from './legacy-payroll-boundary.guard.js';
import { PayrollController } from './payroll.controller.js';

const KEY = 'payroll-key-001';
const TOKEN: VerifiedAccessToken = {
  issuer: 'https://issuer.example.invalid',
  subject: 'finance-001',
  audience: ['gaoq-erp'],
  resource: ['gaoq-erp'],
  tenantId: 'tenant-001',
  actorId: 'finance-001',
  actorType: 'user',
  clientId: 'erp-web',
  roleCodes: ['finance_owner'],
  scopes: ['erp:payroll:period:lock'],
  departmentIds: [],
  sessionId: 'session-001',
  expiresAt: 1_800_000_000,
};
const request = (token: VerifiedAccessToken | null = TOKEN): ErpRequest =>
  ({ verifiedAccessToken: token ?? undefined }) as ErpRequest;

const period = {
  id: 'period-001',
  period: '2026-07',
  status: 'collecting',
  version: 2,
  activeRunId: null,
  inputSnapshotHash: null,
  resultHash: null,
  employeeCount: null,
};
const completePeriod = {
  ...period,
  activeRunId: 'run-001',
  inputSnapshotHash: 'input-hash',
  resultHash: 'result-hash',
  employeeCount: 12,
};
const shadow = {
  id: 'shadow-001',
  periodId: 'period-001',
  payrollRunId: 'run-001',
  period: '2026-07',
  sourceSystem: 'legacy-payroll',
  sourceManifestHash: 'manifest-hash',
  comparisonHash: 'comparison-hash',
  status: 'compared',
  differenceCount: 2,
  explainedDifferenceCount: 1,
  unresolvedDifferenceCount: 1,
  totalAbsoluteDifferenceMinor: 300,
  payrollSignoffId: null,
  financeSignoffId: null,
  cutoverReadinessId: null,
};
const signedShadow = {
  ...shadow,
  payrollSignoffId: 'payroll-signoff-001',
  financeSignoffId: 'finance-signoff-001',
  cutoverReadinessId: 'readiness-001',
};
const taxFiling = {
  id: 'tax-001',
  periodId: 'period-001',
  payrollRunId: 'run-001',
  format: 'tax-v1',
  status: 'prepared',
  version: 1,
  contentHash: 'tax-content-hash',
  employeeCount: 12,
  totalTaxableEarningsMinor: 1_000_000,
  totalWithholdingTaxMinor: 100_000,
  objectEvidenceId: null,
  taxSubmissionId: null,
  taxSubmissionEvidenceId: null,
};
const submittedTaxFiling = {
  ...taxFiling,
  objectEvidenceId: 'worm-tax-001',
  taxSubmissionId: 'submission-001',
  taxSubmissionEvidenceId: 'worm-submission-001',
};
const adjustment = {
  id: '01J8ZQK7V0A2M4N6P8R0T2W4A3',
  periodId: '01J8ZQK7V0A2M4N6P8R0T2W4P1',
  period: '2026-07',
  originalCalculationLineId: '01J8ZQK7V0A2M4N6P8R0T2W4N1',
  adjustmentNumber: 1,
  type: 'supplement',
  reasonCode: 'RETROACTIVE_SALARY_CHANGE',
  status: 'locked',
  version: 4,
  adjustmentHash: 'a'.repeat(43),
  grossDeltaMinor: 100_000,
  taxDeltaMinor: 3_000,
  netDeltaMinor: 97_000,
  payableMinor: 97_000,
  receivableMinor: 0,
  approvalInstanceId: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
  cashSettlementStatus: 'pending',
  taxCorrectionStatus: 'pending',
} as const;
const receivable = {
  id: '01J8ZQK7V0A2M4N6P8R0T2W4V1',
  adjustmentId: adjustment.id,
  adjustmentHash: adjustment.adjustmentHash,
  currency: 'CNY',
  originalAmountMinor: 97_000,
  recoveredAmountMinor: 40_000,
  outstandingAmountMinor: 57_000,
  status: 'open',
  version: 2,
} as const;
const adjustmentTaxCorrection = {
  id: '01J8ZQK7V0A2M4N6P8R0T2W4F1',
  adjustmentId: adjustment.id,
  adjustmentHash: adjustment.adjustmentHash,
  period: '2026-07',
  format: 'CN_IIT_WITHHOLDING_CORRECTION_V1',
  contentHash: 'c'.repeat(43),
  correctedTaxableEarningsMinor: 1_100_000,
  correctedWithholdingTaxMinor: 13_500,
  taxableEarningsDeltaMinor: 100_000,
  withholdingTaxDeltaMinor: 3_000,
  objectEvidenceId: 'worm-correction-001',
  taxSubmissionId: null,
  taxSubmissionEvidenceId: null,
  status: 'approved',
  version: 3,
} as const;
const annualReconciliation = {
  id: '01J8ZQK7V0A2M4N6P8R0T2W4Y1',
  employeeId: 'employee-001',
  taxYear: '2026',
  currency: 'CNY',
  periodCount: 12,
  firstPeriod: '2026-01',
  lastPeriod: '2026-12',
  totalTaxableEarningsMinor: 12_000_000,
  totalPayrollWithheldMinor: 360_000,
  totalFiledWithholdingMinor: 360_000,
  cumulativeTaxLiabilityMinor: 360_000,
  officialAssessedTaxMinor: null,
  employeePayableToTaxAuthorityMinor: 0,
  employeeRefundFromTaxAuthorityMinor: 0,
  differences: [],
  status: 'awaiting_assessment',
  evidenceHash: 'e'.repeat(43),
  version: 1,
} as const;

function fixture() {
  const runs = {
    createPeriod: vi.fn().mockResolvedValue(period),
    startCollection: vi.fn().mockResolvedValue(period),
    getPeriod: vi.fn().mockResolvedValue(completePeriod),
  };
  const approvals = {
    requestApproval: vi.fn().mockResolvedValue(period),
    applyApproval: vi.fn().mockResolvedValue(period),
    lockPeriod: vi.fn().mockResolvedValue(period),
  };
  const payslips = {
    getMyPayslip: vi.fn().mockResolvedValue({
      period: '2026-07',
      inputHash: 'input-hash',
      resultHash: 'result-hash',
    }),
  };
  const masterData = {
    attestCompensation: vi.fn().mockResolvedValue({
      id: 'compensation-001',
      employeeId: 'employee-001',
      version: 1,
      effectiveFrom: '2026-07-01',
      effectiveTo: null,
    }),
    attestRulePack: vi.fn().mockResolvedValue({
      id: 'rule-001',
      code: 'CN-SH',
      jurisdictionCode: 'CN-SH',
      version: 1,
      effectiveFrom: '2026-01-01',
    }),
  };
  const taxFilings = {
    getStatus: vi.fn().mockResolvedValue(submittedTaxFiling),
    prepare: vi.fn().mockResolvedValue(taxFiling),
    approve: vi.fn().mockResolvedValue(taxFiling),
    submit: vi.fn().mockResolvedValue(submittedTaxFiling),
  };
  const reconciliations = {
    getStatus: vi.fn().mockResolvedValue({
      id: 'reconciliation-001',
      periodId: 'period-001',
      payrollRunId: 'run-001',
      batchId: 'batch-001',
      status: 'matched',
      differences: [{ code: 'ROUNDING' }],
      evidenceHash: 'reconciliation-hash',
    }),
  };
  const shadows = {
    getCycle: vi.fn().mockResolvedValue(signedShadow),
    getDifferences: vi.fn().mockResolvedValue([
      {
        id: 'difference-001',
        employeeId: 'employee-sensitive-001',
        explanationCode: null,
      },
      {
        id: 'difference-002',
        employeeId: 'employee-sensitive-002',
        explanationCode: 'TIMING',
      },
    ]),
    getReadiness: vi.fn().mockResolvedValue({
      id: 'readiness-001',
      firstCycleId: 'shadow-001',
      secondCycleId: 'shadow-002',
      startPeriod: '2026-06',
      endPeriod: '2026-07',
      evidenceHash: 'readiness-hash',
      status: 'ready',
    }),
    importCycle: vi.fn().mockResolvedValue(shadow),
    explainDifference: vi.fn().mockResolvedValue(shadow),
    signCycle: vi.fn().mockResolvedValue(signedShadow),
  };
  const record = vi.fn().mockResolvedValue(undefined);
  const adjustments = {
    prepare: vi.fn().mockResolvedValue(adjustment),
    requestApproval: vi.fn().mockResolvedValue(adjustment),
    applyApproval: vi.fn().mockResolvedValue(adjustment),
    lock: vi.fn().mockResolvedValue(adjustment),
    get: vi.fn().mockResolvedValue(adjustment),
  };
  const adjustmentReceivables = {
    open: vi.fn().mockResolvedValue(receivable),
    get: vi.fn().mockResolvedValue(receivable),
    recordRecovery: vi.fn().mockResolvedValue(receivable),
  };
  const adjustmentTaxCorrections = {
    prepare: vi.fn().mockResolvedValue(adjustmentTaxCorrection),
    get: vi.fn().mockResolvedValue(adjustmentTaxCorrection),
    approve: vi.fn().mockResolvedValue(adjustmentTaxCorrection),
    submit: vi.fn().mockResolvedValue(adjustmentTaxCorrection),
  };
  const annualReconciliations = {
    prepare: vi.fn().mockResolvedValue(annualReconciliation),
    resolveOfficialAssessment: vi.fn().mockResolvedValue(annualReconciliation),
    createMySettlementLink: vi.fn().mockResolvedValue({
      settlementUrl: 'https://official.tax.example.cn/settlement?token=opaque',
      expiresAt: '2026-07-30T05:05:00.000Z',
    }),
    get: vi.fn().mockResolvedValue(annualReconciliation),
  };
  const controller = new PayrollController(
    runs as unknown as PayrollRunService,
    adjustments as never,
    adjustmentReceivables as never,
    adjustmentTaxCorrections as never,
    annualReconciliations as never,
    approvals as unknown as PayrollApprovalService,
    payslips as unknown as PayrollPayslipService,
    masterData as unknown as PayrollMasterDataService,
    taxFilings as unknown as PayrollTaxFilingService,
    reconciliations as unknown as PayrollReconciliationService,
    shadows as unknown as PayrollShadowService,
    { record } as unknown as AuditService,
  );
  return {
    controller,
    record,
    runs,
    approvals,
    payslips,
    masterData,
    taxFilings,
    reconciliations,
    shadows,
    adjustments,
    adjustmentReceivables,
    adjustmentTaxCorrections,
    annualReconciliations,
  };
}

const routeCases = [
  ['prepareAnnualReconciliation', 'annual-reconciliations/prepare', RequestMethod.POST, ['erp:payroll:annual:prepare']],
  ['resolveAnnualAssessment', 'annual-reconciliations/resolve-assessment', RequestMethod.POST, ['erp:payroll:annual:assessment:resolve']],
  ['createMyAnnualSettlementLink', 'annual-reconciliations/:id/settlement-link', RequestMethod.POST, ['erp:payroll:annual:settlement:self']],
  ['getAnnualReconciliation', 'annual-reconciliations/:id', RequestMethod.GET, ['erp:payroll:annual:read']],
  ['prepareAdjustment', 'adjustments/prepare', RequestMethod.POST, ['erp:payroll:adjustment:prepare']],
  ['requestAdjustmentApproval', 'adjustments/:id/approval', RequestMethod.POST, ['erp:payroll:adjustment:approval:request']],
  ['applyAdjustmentApproval', 'adjustments/:id/approval-result', RequestMethod.POST, ['erp:payroll:adjustment:approval:sync']],
  ['lockAdjustment', 'adjustments/:id/lock', RequestMethod.POST, ['erp:payroll:adjustment:lock']],
  ['getAdjustment', 'adjustments/:id', RequestMethod.GET, ['erp:payroll:adjustment:read']],
  ['openAdjustmentReceivable', 'adjustments/:id/receivable', RequestMethod.POST, [
    'erp:payroll:adjustment:receivable:open',
    'erp:payroll:adjustment:receivable:source:read',
  ]],
  ['getAdjustmentReceivable', 'adjustment-receivables/:id', RequestMethod.GET, ['erp:payroll:adjustment:receivable:read']],
  ['recordAdjustmentReceivableRecovery', 'adjustment-receivables/:id/recoveries', RequestMethod.POST, ['erp:payroll:adjustment:receivable:settle']],
  ['prepareAdjustmentTaxCorrection', 'adjustments/:id/tax-corrections', RequestMethod.POST, [
    'erp:payroll:adjustment:tax_correction:prepare',
    'erp:payroll:adjustment:tax_correction:source:read',
  ]],
  ['getAdjustmentTaxCorrection', 'adjustment-tax-corrections/:id', RequestMethod.GET, ['erp:payroll:adjustment:tax_correction:read']],
  ['approveAdjustmentTaxCorrection', 'adjustment-tax-corrections/:id/approval', RequestMethod.POST, ['erp:payroll:adjustment:tax_correction:approve']],
  ['submitAdjustmentTaxCorrection', 'adjustment-tax-corrections/:id/submission', RequestMethod.POST, ['erp:payroll:adjustment:tax_correction:submit']],
  ['getShadowCycle', 'shadow-cycles/:id', RequestMethod.GET, ['erp:payroll:shadow:read']],
  ['getShadowDifferences', 'shadow-cycles/:id/differences', RequestMethod.GET, ['erp:payroll:shadow:difference:read']],
  ['getCutoverReadiness', 'cutover-readiness/:id', RequestMethod.GET, ['erp:payroll:shadow:read']],
  ['importShadowCycle', 'periods/:id/shadow-cycles', RequestMethod.POST, ['erp:payroll:shadow:import']],
  ['explainShadowDifference', 'shadow-cycles/:cycleId/differences/:differenceId/explanation', RequestMethod.POST, ['erp:payroll:shadow:explain']],
  ['signShadowCycleByPayroll', 'shadow-cycles/:id/payroll-signoff', RequestMethod.POST, ['erp:payroll:shadow:sign_payroll']],
  ['signShadowCycleByFinance', 'shadow-cycles/:id/finance-signoff', RequestMethod.POST, ['erp:payroll:shadow:sign_finance']],
  ['getReconciliation', 'reconciliations/:id', RequestMethod.GET, ['erp:payroll:reconciliation:read']],
  ['getTaxFiling', 'tax-filings/:id', RequestMethod.GET, ['erp:payroll:tax:read']],
  ['prepareTaxFiling', 'periods/:id/tax-filings', RequestMethod.POST, ['erp:payroll:tax:prepare']],
  ['approveTaxFiling', 'tax-filings/:id/approval', RequestMethod.POST, ['erp:payroll:tax:approve']],
  ['submitTaxFiling', 'tax-filings/:id/submission', RequestMethod.POST, ['erp:payroll:tax:submit']],
  ['createPeriod', 'periods', RequestMethod.POST, ['erp:payroll:period:create']],
  ['getMyPayslip', 'payslips/:period/me', RequestMethod.GET, ['erp:payroll:sheet:read_self']],
  ['requestApproval', 'periods/:id/approval', RequestMethod.POST, ['erp:payroll:approval:request', 'erp:approval:instance:submit']],
  ['applyApproval', 'periods/:id/approval-result', RequestMethod.POST, ['erp:payroll:approval:sync']],
  ['lockPeriod', 'periods/:id/lock', RequestMethod.POST, ['erp:payroll:period:lock']],
  ['startCollection', 'periods/:id/collection', RequestMethod.POST, ['erp:payroll:period:prepare']],
  ['getPeriod', 'periods/:id', RequestMethod.GET, ['erp:payroll:period:read']],
  ['attestCompensation', 'compensation-profiles/attest', RequestMethod.POST, ['erp:payroll:compensation:attest']],
  ['attestRulePack', 'rule-packs/attest', RequestMethod.POST, ['erp:payroll:rule:attest']],
] as const;

describe('PayrollController', () => {
  it('固定旧算薪控制器边界、全部路由、HTTP 方法和最小 Scope', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PayrollController)).toBe('payroll');
    expect(Reflect.getMetadata(GUARDS_METADATA, PayrollController))
      .toEqual([LegacyPayrollBoundaryGuard]);
    for (const [name, path, method, scopes] of routeCases) {
      const handler = Object.getOwnPropertyDescriptor(
        PayrollController.prototype,
        name,
      )?.value as object;
      expect(Reflect.getMetadata(PATH_METADATA, handler), name).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler), name).toBe(method);
      expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, handler), name).toEqual(scopes);
    }
  });

  it('委托影子周期、差异和切换资格读取并只审计控制摘要', async () => {
    const store = fixture();

    await expect(store.controller.getShadowCycle('shadow-001')).resolves.toBe(signedShadow);
    const differences = await store.controller.getShadowDifferences('shadow-001');
    await expect(store.controller.getCutoverReadiness('readiness-001'))
      .resolves.toMatchObject({ status: 'ready' });

    expect(differences).toHaveLength(2);
    expect(store.shadows.getCycle).toHaveBeenCalledWith('shadow-001');
    expect(store.shadows.getDifferences).toHaveBeenCalledWith('shadow-001');
    expect(store.shadows.getReadiness).toHaveBeenCalledWith('readiness-001');
    const auditCalls = store.record.mock.calls as unknown as
      readonly (readonly [AuditRecordInput])[];
    const differenceAudit = auditCalls.find(
      ([input]) => input.action === 'payroll.shadow_difference.read',
    )?.[0];
    expect(differenceAudit).toMatchObject({
      resourceId: 'shadow-001',
      metadata: { differenceCount: 2, explainedDifferenceCount: 1 },
    });
    expect(JSON.stringify(differenceAudit)).not.toContain('employee-sensitive');
  });

  it('委托年度核对与工资调整审批锁定入口并保持控制摘要审计', async () => {
    const store = fixture();
    const response = { setHeader: vi.fn() };
    const annualBody = {
      employeeId: 'employee-001',
      taxYear: '2026',
    };
    const prepareBody = {
      periodId: adjustment.periodId,
      originalCalculationLineId: adjustment.originalCalculationLineId,
      rulePackId: 'rule-pack-001',
      rulePackVersion: 1,
      reasonCode: adjustment.reasonCode,
      correctedLine: {
        employeeId: 'employee-001',
        compensationProfileId: 'profile-001',
        additionalCompensationProfileIds: ['profile-002'],
        attendanceSnapshotId: 'attendance-001',
      },
    };

    await expect(store.controller.prepareAnnualReconciliation(KEY, annualBody))
      .resolves.toBe(annualReconciliation);
    await expect(store.controller.resolveAnnualAssessment(KEY, annualBody))
      .resolves.toBe(annualReconciliation);
    const settlementLink = await store.controller.createMyAnnualSettlementLink(
      KEY,
      annualReconciliation.id,
      response as never,
    );
    expect(settlementLink.settlementUrl).toContain('official.tax.example.cn');
    await expect(store.controller.getAnnualReconciliation(annualReconciliation.id))
      .resolves.toBe(annualReconciliation);
    await expect(store.controller.prepareAdjustment(KEY, prepareBody))
      .resolves.toBe(adjustment);
    await store.controller.requestAdjustmentApproval(
      KEY,
      adjustment.id,
      { expectedVersion: 1 },
    );
    await store.controller.applyAdjustmentApproval(
      KEY,
      adjustment.id,
      {
        expectedVersion: 2,
        approvalInstanceId: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
      },
    );
    await store.controller.lockAdjustment(
      KEY,
      adjustment.id,
      { expectedVersion: 3, strongAuthEvidenceId: 'auth-adjustment-001' },
      request(),
    );
    await expect(store.controller.getAdjustment(adjustment.id)).resolves.toBe(adjustment);

    expect(store.annualReconciliations.prepare).toHaveBeenCalledWith(KEY, annualBody);
    expect(store.annualReconciliations.resolveOfficialAssessment)
      .toHaveBeenCalledWith(KEY, annualBody);
    expect(store.annualReconciliations.createMySettlementLink)
      .toHaveBeenCalledWith(KEY, annualReconciliation.id);
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(response.setHeader).toHaveBeenCalledWith('Pragma', 'no-cache');
    expect(JSON.stringify(store.record.mock.calls)).not.toContain('token=opaque');
    expect(store.adjustments.prepare).toHaveBeenCalledWith(KEY, prepareBody);
    expect(store.adjustments.lock).toHaveBeenCalledWith(
      KEY,
      adjustment.id,
      3,
      'auth-adjustment-001',
      TOKEN,
    );
  });

  it('年度核对可省略税局评估，调整可省略附加薪酬档案', async () => {
    const store = fixture();

    await store.controller.prepareAnnualReconciliation(KEY, {
      employeeId: 'employee-001',
      taxYear: '2026',
    });
    await store.controller.prepareAdjustment(KEY, {
      periodId: adjustment.periodId,
      originalCalculationLineId: adjustment.originalCalculationLineId,
      rulePackId: 'rule-pack-001',
      rulePackVersion: 1,
      reasonCode: adjustment.reasonCode,
      correctedLine: {
        employeeId: 'employee-001',
        compensationProfileId: 'profile-001',
        attendanceSnapshotId: 'attendance-001',
      },
    });

    expect(store.annualReconciliations.prepare).toHaveBeenLastCalledWith(KEY, {
      employeeId: 'employee-001',
      taxYear: '2026',
    });
    expect(store.adjustments.prepare).toHaveBeenLastCalledWith(
      KEY,
      expect.objectContaining({
        correctedLine: {
          employeeId: 'employee-001',
          compensationProfileId: 'profile-001',
          attendanceSnapshotId: 'attendance-001',
        },
      }),
    );
  });

  it('委托员工应收与税务更正闭环且不把正文写入审计', async () => {
    const store = fixture();
    const recovery = {
      expectedReceivableVersion: 1,
      method: 'authorized_payroll_deduction',
      amountMinor: 40_000,
      sourceReferenceId: 'payroll-run-2026-08',
      sourceEvidenceId: 'worm-payroll-run-2026-08',
      legalAuthorizationEvidenceId: 'employee-consent-001',
      receivedAt: '2026-08-01T00:00:00.000Z',
    } as const;

    await store.controller.openAdjustmentReceivable(
      KEY,
      adjustment.id,
      { expectedVersion: 4 },
    );
    await store.controller.getAdjustmentReceivable(receivable.id);
    await store.controller.recordAdjustmentReceivableRecovery(
      KEY,
      receivable.id,
      recovery,
    );
    await store.controller.prepareAdjustmentTaxCorrection(
      KEY,
      adjustment.id,
      { expectedVersion: 4 },
    );
    await store.controller.getAdjustmentTaxCorrection(adjustmentTaxCorrection.id);
    await store.controller.approveAdjustmentTaxCorrection(
      KEY,
      adjustmentTaxCorrection.id,
      { expectedVersion: 2, strongAuthEvidenceId: 'auth-tax-correction-001' },
      request(),
    );
    await store.controller.submitAdjustmentTaxCorrection(
      KEY,
      adjustmentTaxCorrection.id,
      { expectedVersion: 3 },
    );

    expect(store.adjustmentReceivables.recordRecovery).toHaveBeenCalledWith(
      KEY,
      receivable.id,
      recovery,
    );
    expect(store.adjustmentTaxCorrections.approve).toHaveBeenCalledWith(
      KEY,
      adjustmentTaxCorrection.id,
      2,
      'auth-tax-correction-001',
      TOKEN,
    );
  });

  it('银行回款恢复可省略法定工资抵扣授权', async () => {
    const store = fixture();
    await store.controller.recordAdjustmentReceivableRecovery(
      KEY,
      receivable.id,
      {
        expectedReceivableVersion: 1,
        method: 'bank_repayment',
        amountMinor: 40_000,
        sourceReferenceId: 'bank-return-001',
        sourceEvidenceId: 'worm-bank-return-001',
        receivedAt: '2026-08-01T00:00:00.000Z',
      },
    );
    expect(store.adjustmentReceivables.recordRecovery).toHaveBeenCalledWith(
      KEY,
      receivable.id,
      {
        expectedReceivableVersion: 1,
        method: 'bank_repayment',
        amountMinor: 40_000,
        sourceReferenceId: 'bank-return-001',
        sourceEvidenceId: 'worm-bank-return-001',
        receivedAt: '2026-08-01T00:00:00.000Z',
      },
    );
  });

  it('委托全部影子周期写操作并绑定强认证角色', async () => {
    const store = fixture();
    const importBody = {
      sourceSystem: 'legacy-payroll',
      sourceExportId: 'export-001',
      sourceObjectEvidenceId: 'worm-export-001',
      sourceSignatureEvidenceId: 'worm-signature-001',
      sourceManifestHash: 'manifest-hash',
      lines: [],
    };

    await store.controller.importShadowCycle(KEY, 'period-001', importBody);
    await store.controller.explainShadowDifference(
      KEY,
      'shadow-001',
      'difference-001',
      { explanationCode: 'TIMING', evidenceId: 'worm-explanation-001' } as never,
    );
    await store.controller.signShadowCycleByPayroll(
      KEY,
      'shadow-001',
      { strongAuthEvidenceId: 'auth-payroll-001' },
      request(),
    );
    await store.controller.signShadowCycleByFinance(
      KEY,
      'shadow-001',
      { strongAuthEvidenceId: 'auth-finance-001' },
      request(),
    );

    expect(store.shadows.importCycle).toHaveBeenCalledWith(KEY, {
      periodId: 'period-001',
      ...importBody,
    });
    expect(store.shadows.explainDifference).toHaveBeenCalledWith(
      KEY,
      'shadow-001',
      'difference-001',
      'TIMING',
      'worm-explanation-001',
    );
    expect(store.shadows.signCycle).toHaveBeenNthCalledWith(
      1,
      KEY,
      'shadow-001',
      'auth-payroll-001',
      TOKEN,
      'payroll_owner',
    );
    expect(store.shadows.signCycle).toHaveBeenNthCalledWith(
      2,
      KEY,
      'shadow-001',
      'auth-finance-001',
      TOKEN,
      'finance_owner',
    );
  });

  it('委托税务与四方对账入口并记录脱敏状态', async () => {
    const store = fixture();

    await store.controller.getReconciliation('reconciliation-001');
    await store.controller.getTaxFiling('tax-001');
    await store.controller.prepareTaxFiling(KEY, 'period-001', { expectedVersion: 1 });
    await store.controller.approveTaxFiling(
      KEY,
      'tax-001',
      { expectedVersion: 1, strongAuthEvidenceId: 'auth-tax-001' },
      request(),
    );
    await store.controller.submitTaxFiling(KEY, 'tax-001', { expectedVersion: 2 });

    expect(store.reconciliations.getStatus).toHaveBeenCalledWith('reconciliation-001');
    expect(store.taxFilings.prepare).toHaveBeenCalledWith(KEY, 'period-001', 1);
    expect(store.taxFilings.approve).toHaveBeenCalledWith(
      KEY,
      'tax-001',
      1,
      'auth-tax-001',
      TOKEN,
    );
    expect(store.taxFilings.submit).toHaveBeenCalledWith(KEY, 'tax-001', 2);
  });

  it('委托周期、工资单和两类可信主数据入口', async () => {
    const store = fixture();
    const compensation = { employeeId: 'employee-001', effectiveTo: null };
    const rulePack = { code: 'CN-SH', jurisdictionCode: 'CN-SH' };

    await store.controller.createPeriod(KEY, { period: '2026-07' });
    await store.controller.getMyPayslip('2026-07');
    await store.controller.requestApproval(KEY, 'period-001', { expectedVersion: 2 });
    await store.controller.applyApproval(
      KEY,
      'period-001',
      { expectedVersion: 3, approvalInstanceId: 'approval-001' },
    );
    await store.controller.lockPeriod(
      KEY,
      'period-001',
      { expectedVersion: 4, strongAuthEvidenceId: 'auth-lock-001' },
      request(),
    );
    await store.controller.startCollection(KEY, 'period-001', { expectedVersion: 1 });
    await store.controller.getPeriod('period-001');
    await store.controller.attestCompensation(KEY, compensation as never);
    await store.controller.attestRulePack(KEY, rulePack as never);

    expect(store.runs.createPeriod).toHaveBeenCalledWith(KEY, '2026-07');
    expect(store.payslips.getMyPayslip).toHaveBeenCalledWith('2026-07');
    expect(store.approvals.requestApproval).toHaveBeenCalledWith(KEY, 'period-001', 2);
    expect(store.approvals.applyApproval).toHaveBeenCalledWith(
      KEY,
      'period-001',
      3,
      'approval-001',
    );
    expect(store.approvals.lockPeriod).toHaveBeenCalledWith(
      KEY,
      'period-001',
      4,
      'auth-lock-001',
      TOKEN,
    );
    expect(store.runs.startCollection).toHaveBeenCalledWith(KEY, 'period-001', 1);
    expect(store.masterData.attestCompensation).toHaveBeenCalledWith(KEY, compensation);
    expect(store.masterData.attestRulePack).toHaveBeenCalledWith(KEY, rulePack);
  });

  it.each([
    ['薪酬签署', (controller: PayrollController) => controller.signShadowCycleByPayroll(
      KEY,
      'shadow-001',
      { strongAuthEvidenceId: 'auth-001' },
      request(null),
    )],
    ['财务签署', (controller: PayrollController) => controller.signShadowCycleByFinance(
      KEY,
      'shadow-001',
      { strongAuthEvidenceId: 'auth-001' },
      request(null),
    )],
    ['个税审批', (controller: PayrollController) => controller.approveTaxFiling(
      KEY,
      'tax-001',
      { expectedVersion: 1, strongAuthEvidenceId: 'auth-001' },
      request(null),
    )],
    ['工资锁定', (controller: PayrollController) => controller.lockPeriod(
      KEY,
      'period-001',
      { expectedVersion: 1, strongAuthEvidenceId: 'auth-001' },
      request(null),
    )],
    ['工资调整锁定', (controller: PayrollController) => controller.lockAdjustment(
      KEY,
      adjustment.id,
      { expectedVersion: 3, strongAuthEvidenceId: 'auth-001' },
      request(null),
    )],
    ['工资调整税务更正审批', (controller: PayrollController) =>
      controller.approveAdjustmentTaxCorrection(
        KEY,
        adjustmentTaxCorrection.id,
        { expectedVersion: 2, strongAuthEvidenceId: 'auth-001' },
        request(null),
      )],
  ])('%s 缺少已验证人员令牌时在业务调用前失败关闭', async (_name, operation) => {
    const store = fixture();

    await expect(operation(store.controller)).rejects.toBeInstanceOf(BadRequestException);

    expect(store.shadows.signCycle).not.toHaveBeenCalled();
    expect(store.taxFilings.approve).not.toHaveBeenCalled();
    expect(store.approvals.lockPeriod).not.toHaveBeenCalled();
    expect(store.adjustments.lock).not.toHaveBeenCalled();
    expect(store.adjustmentTaxCorrections.approve).not.toHaveBeenCalled();
    expect(store.record).not.toHaveBeenCalled();
  });

  it.each([undefined, ''])('写入口拒绝缺失幂等键 %s', async (key) => {
    const store = fixture();

    await expect(store.controller.createPeriod(key, { period: '2026-07' }))
      .rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });

    expect(store.runs.createPeriod).not.toHaveBeenCalled();
    expect(store.record).not.toHaveBeenCalled();
  });

  it('业务提交后的审计故障不反向暴露失败并只记录稳定告警', async () => {
    const store = fixture();
    store.record.mockRejectedValue(new Error('audit unavailable'));
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await store.controller.importShadowCycle(KEY, 'period-001', {
      sourceSystem: 'legacy-payroll',
      sourceExportId: 'export-001',
      sourceObjectEvidenceId: 'worm-export-001',
      sourceSignatureEvidenceId: 'worm-signature-001',
      sourceManifestHash: 'manifest-hash',
      lines: [],
    });
    await store.controller.explainShadowDifference(
      KEY,
      'shadow-001',
      'difference-001',
      { explanationCode: 'LEGACY_RULE_VERSION', evidenceId: 'worm-explanation-001' },
    );
    await store.controller.signShadowCycleByPayroll(
      KEY,
      'shadow-001',
      { strongAuthEvidenceId: 'auth-payroll-001' },
      request(),
    );
    await store.controller.signShadowCycleByFinance(
      KEY,
      'shadow-001',
      { strongAuthEvidenceId: 'auth-finance-001' },
      request(),
    );
    await store.controller.prepareTaxFiling(KEY, 'period-001', { expectedVersion: 1 });
    await store.controller.approveTaxFiling(
      KEY,
      'tax-001',
      { expectedVersion: 1, strongAuthEvidenceId: 'auth-tax-001' },
      request(),
    );
    await store.controller.submitTaxFiling(KEY, 'tax-001', { expectedVersion: 2 });
    await store.controller.createPeriod(KEY, { period: '2026-07' });
    await store.controller.requestApproval(KEY, 'period-001', { expectedVersion: 2 });
    await store.controller.applyApproval(
      KEY,
      'period-001',
      { expectedVersion: 3, approvalInstanceId: 'approval-001' },
    );
    await store.controller.lockPeriod(
      KEY,
      'period-001',
      { expectedVersion: 4, strongAuthEvidenceId: 'auth-lock-001' },
      request(),
    );
    await store.controller.startCollection(KEY, 'period-001', { expectedVersion: 1 });
    await store.controller.attestCompensation(KEY, { employeeId: 'employee-001' } as never);
    await store.controller.attestRulePack(KEY, { code: 'CN-SH' } as never);

    expect(error).toHaveBeenCalledTimes(14);
    expect(error).toHaveBeenCalledWith({
      code: 'PAYROLL_AUDIT_AFTER_COMMIT_FAILED',
      action: 'payroll.period.create',
      resourceType: 'payroll_period',
      resourceId: 'period-001',
      riskLevel: 'R2',
    });
    expect(error).toHaveBeenCalledWith({
      code: 'PAYROLL_AUDIT_AFTER_COMMIT_FAILED',
      action: 'payroll.shadow_cycle.import',
      resourceType: 'payroll_shadow_cycle',
      resourceId: 'shadow-001',
      riskLevel: 'R3',
    });
    expect(error).toHaveBeenCalledWith({
      code: 'PAYROLL_AUDIT_AFTER_COMMIT_FAILED',
      action: 'payroll.tax_filing.prepare',
      resourceType: 'payroll_tax_filing',
      resourceId: 'tax-001',
      riskLevel: 'R3',
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain('audit unavailable');
    error.mockRestore();
  });

  it('敏感读取审计失败时仍失败关闭', async () => {
    const store = fixture();
    const auditFailure = new Error('audit unavailable');
    store.record.mockRejectedValue(auditFailure);

    await expect(store.controller.getPeriod('period-001')).rejects.toBe(auditFailure);
  });
});
