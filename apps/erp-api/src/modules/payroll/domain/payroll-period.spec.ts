import { describe, expect, it } from 'vitest';

import {
  applyPayrollApproval,
  beginPayrollReconciliation,
  completePayrollReconciliation,
  createPayrollPeriod,
  lockPayrollPeriod,
  recordPayrollCalculation,
  recordPayrollReconciliationMismatch,
  startPayrollCollection,
  startPayrollDisbursement,
  submitPayrollApproval,
  type PayrollPeriod,
} from './payroll-period.js';

const NOW = new Date('2026-07-21T00:00:00.000Z');
const HASH_A = 'A'.repeat(43);
const HASH_B = 'B'.repeat(43);

function approvedPeriod(): PayrollPeriod {
  let period = createPayrollPeriod({
    id: 'payroll-period-001', tenantId: 'tenant-001', period: '2026-07',
    preparedBy: 'employee-payroll-maker',
  }, NOW);
  period = startPayrollCollection(period, {
    tenantId: 'tenant-001', expectedVersion: 1,
  }, NOW);
  period = recordPayrollCalculation(period, {
    tenantId: 'tenant-001', expectedVersion: 2,
    run: {
      id: 'payroll-run-001', inputSnapshotHash: HASH_A, resultHash: HASH_B,
      employeeCount: 10, totalGrossMinor: 10_000_000,
      totalTaxMinor: 500_000, totalNetMinor: 8_000_000,
    },
  }, NOW);
  period = submitPayrollApproval(period, {
    tenantId: 'tenant-001', expectedVersion: 3,
    approvalReferenceType: 'approval_instance', approvalInstanceId: 'approval-001',
  }, NOW);
  return applyPayrollApproval(period, {
    tenantId: 'tenant-001', expectedVersion: 4, approvalInstanceId: 'approval-001',
    approvalReferenceType: 'approval_instance',
    outcome: 'approved', decidedBy: 'employee-finance-approver',
    approvalEvidenceId: 'approval-evidence-001', trustedApproval: true,
  }, NOW);
}

describe('PayrollPeriod 职责分离状态机', () => {
  it('计算、审批、锁定、代发和对账按强版本单向推进', () => {
    let period = approvedPeriod();
    period = lockPayrollPeriod(period, {
      tenantId: 'tenant-001', expectedVersion: 5,
      lockedBy: 'employee-finance-locker', strongAuthEvidenceId: 'mfa-evidence-001',
      strongAuthReferenceType: 'webauthn_evidence',
    }, NOW);
    period = startPayrollDisbursement(period, {
      tenantId: 'tenant-001', expectedVersion: 6,
      batchId: 'bank-batch-001', preparedBy: 'employee-treasury-maker',
      exportEvidenceId: 'export-evidence-001', trustedExport: true,
    }, NOW);
    period = beginPayrollReconciliation(period, {
      tenantId: 'tenant-001', expectedVersion: 7, batchId: 'bank-batch-001',
    }, NOW);
    period = completePayrollReconciliation(period, {
      tenantId: 'tenant-001', expectedVersion: 8,
      reconciledBy: 'employee-finance-reconciler',
      reconciliationEvidenceId: 'reconciliation-001', balanced: true,
      trustedReconciliation: true,
    }, NOW);
    expect(period).toMatchObject({
      status: 'reconciled', version: 9, approvedBy: 'employee-finance-approver',
      lockedBy: 'employee-finance-locker', disbursementBatchId: 'bank-batch-001',
      reconciledBy: 'employee-finance-reconciler',
    });
  });

  it('拒绝自报审批事实以及制单、审批、锁定角色重合', () => {
    let period = createPayrollPeriod({
      id: 'payroll-period-001', tenantId: 'tenant-001', period: '2026-07',
      preparedBy: 'employee-maker',
    }, NOW);
    period = startPayrollCollection(period, { tenantId: 'tenant-001', expectedVersion: 1 }, NOW);
    period = recordPayrollCalculation(period, {
      tenantId: 'tenant-001', expectedVersion: 2,
      run: {
        id: 'run-001', inputSnapshotHash: HASH_A, resultHash: HASH_B,
        employeeCount: 1, totalGrossMinor: 1, totalTaxMinor: 0, totalNetMinor: 1,
      },
    }, NOW);
    period = submitPayrollApproval(period, {
      tenantId: 'tenant-001', expectedVersion: 3,
      approvalReferenceType: 'approval_instance', approvalInstanceId: 'approval-001',
    }, NOW);
    expect(() => applyPayrollApproval(period, {
      tenantId: 'tenant-001', expectedVersion: 4, approvalInstanceId: 'approval-001',
      approvalReferenceType: 'approval_instance',
      outcome: 'approved', decidedBy: 'employee-approver',
      approvalEvidenceId: 'evidence-001', trustedApproval: false,
    }, NOW)).toThrow(/不可信/u);
    expect(() => applyPayrollApproval(period, {
      tenantId: 'tenant-001', expectedVersion: 4, approvalInstanceId: 'approval-001',
      approvalReferenceType: 'approval_instance',
      outcome: 'approved', decidedBy: 'employee-maker',
      approvalEvidenceId: 'evidence-001', trustedApproval: true,
    }, NOW)).toThrow(/必须分离/u);
    const approved = applyPayrollApproval(period, {
      tenantId: 'tenant-001', expectedVersion: 4, approvalInstanceId: 'approval-001',
      approvalReferenceType: 'approval_instance',
      outcome: 'approved', decidedBy: 'employee-approver',
      approvalEvidenceId: 'evidence-001', trustedApproval: true,
    }, NOW);
    expect(() => lockPayrollPeriod(approved, {
      tenantId: 'tenant-001', expectedVersion: 5,
      lockedBy: 'employee-approver', strongAuthEvidenceId: 'mfa-001',
      strongAuthReferenceType: 'webauthn_evidence',
    }, NOW)).toThrow(/独立/u);
  });

  it('拒绝锁定后原地重算、版本冲突和不守恒对账', () => {
    const approved = approvedPeriod();
    const activeRun = approved.activeRun;
    if (activeRun === null) throw new Error('测试工资计算引用缺失');
    let period = lockPayrollPeriod(approved, {
      tenantId: 'tenant-001', expectedVersion: 5,
      lockedBy: 'employee-locker', strongAuthEvidenceId: 'mfa-001',
      strongAuthReferenceType: 'webauthn_evidence',
    }, NOW);
    expect(() => recordPayrollCalculation(period, {
      tenantId: 'tenant-001', expectedVersion: 6,
      run: activeRun,
    }, NOW)).toThrow(/状态迁移/u);
    expect(() => startPayrollDisbursement(period, {
      tenantId: 'tenant-001', expectedVersion: 5,
      batchId: 'bank-batch-001', preparedBy: 'employee-treasury',
      exportEvidenceId: 'export-001', trustedExport: true,
    }, NOW)).toThrow(/版本冲突/u);
    period = startPayrollDisbursement(period, {
      tenantId: 'tenant-001', expectedVersion: 6,
      batchId: 'bank-batch-001', preparedBy: 'employee-treasury',
      exportEvidenceId: 'export-001', trustedExport: true,
    }, NOW);
    period = beginPayrollReconciliation(period, {
      tenantId: 'tenant-001', expectedVersion: 7, batchId: 'bank-batch-001',
    }, NOW);
    expect(() => completePayrollReconciliation(period, {
      tenantId: 'tenant-001', expectedVersion: 8,
      reconciledBy: 'employee-reconciler', reconciliationEvidenceId: 'recon-001',
      balanced: false, trustedReconciliation: true,
    }, NOW)).toThrow(/未守恒/u);
  });

  it('拒绝非法主键、期间、时间、运行控制量和缺失计算', () => {
    expect(() => createPayrollPeriod({
      id: '@', tenantId: 'tenant-001', period: '2026-07', preparedBy: 'maker',
    }, NOW)).toThrow('标识非法');
    expect(() => createPayrollPeriod({
      id: 'period-001', tenantId: 'tenant-001', period: '2026-13', preparedBy: 'maker',
    }, NOW)).toThrow('工资期间非法');
    expect(() => createPayrollPeriod({
      id: 'period-001', tenantId: 'tenant-001', period: '2026-07', preparedBy: 'maker',
    }, new Date('invalid'))).toThrow('业务时间非法');

    const draft = createPayrollPeriod({
      id: 'period-001', tenantId: 'tenant-001', period: '2026-07', preparedBy: 'maker',
    }, NOW);
    expect(() => startPayrollCollection(
      draft, { tenantId: 'tenant-002', expectedVersion: 1 }, NOW,
    )).toThrow('租户不匹配');
    expect(() => submitPayrollApproval(draft, {
      tenantId: 'tenant-001', expectedVersion: 1,
      approvalReferenceType: 'approval_instance', approvalInstanceId: 'approval-001',
    }, NOW)).toThrow('状态迁移无效');

    const collecting = startPayrollCollection(
      draft, { tenantId: 'tenant-001', expectedVersion: 1 }, NOW,
    );
    const invalidRuns = [
      {
        id: '@', inputSnapshotHash: HASH_A, resultHash: HASH_B,
        employeeCount: 1, totalGrossMinor: 1, totalTaxMinor: 0, totalNetMinor: 1,
      },
      {
        id: 'run-001', inputSnapshotHash: 'bad', resultHash: HASH_B,
        employeeCount: 1, totalGrossMinor: 1, totalTaxMinor: 0, totalNetMinor: 1,
      },
      {
        id: 'run-001', inputSnapshotHash: HASH_A, resultHash: HASH_B,
        employeeCount: 0, totalGrossMinor: 1, totalTaxMinor: 0, totalNetMinor: 1,
      },
      {
        id: 'run-001', inputSnapshotHash: HASH_A, resultHash: HASH_B,
        employeeCount: 1, totalGrossMinor: -1, totalTaxMinor: 0, totalNetMinor: 1,
      },
      {
        id: 'run-001', inputSnapshotHash: HASH_A, resultHash: HASH_B,
        employeeCount: 1, totalGrossMinor: 1, totalTaxMinor: 1.5, totalNetMinor: 1,
      },
    ] as const;
    for (const run of invalidRuns) {
      expect(() => recordPayrollCalculation(collecting, {
        tenantId: 'tenant-001', expectedVersion: 2, run,
      }, NOW)).toThrow();
    }
    expect(() => submitPayrollApproval(
      { ...collecting, status: 'review' },
      {
        tenantId: 'tenant-001', expectedVersion: 2,
        approvalReferenceType: 'approval_instance', approvalInstanceId: 'approval-001',
      },
      NOW,
    )).toThrow('必须完成计算');
  });

  it('覆盖拒绝审批、代发、对账与冻结证据的全部职责边界', () => {
    let period = approvedPeriod();
    const pending = { ...period, status: 'pending_approval' as const, version: 4 };
    const rejected = applyPayrollApproval(pending, {
      tenantId: 'tenant-001', expectedVersion: 4,
      approvalInstanceId: pending.approvalInstanceId!,
      approvalReferenceType: pending.approvalReferenceType!,
      outcome: 'rejected', decidedBy: 'approver-002',
      approvalEvidenceId: 'evidence-002', trustedApproval: true,
    }, NOW);
    expect(rejected).toMatchObject({
      status: 'review', approvalReferenceType: null, approvalInstanceId: null,
    });

    period = lockPayrollPeriod(period, {
      tenantId: 'tenant-001', expectedVersion: 5,
      lockedBy: 'locker-001', strongAuthEvidenceId: 'mfa-001',
      strongAuthReferenceType: 'webauthn_evidence',
    }, NOW);
    expect(() => startPayrollDisbursement(period, {
      tenantId: 'tenant-001', expectedVersion: 6,
      batchId: 'batch-001', preparedBy: 'maker-002',
      exportEvidenceId: 'export-001', trustedExport: false,
    }, NOW)).toThrow('代发导出事实不可信');
    expect(() => startPayrollDisbursement(period, {
      tenantId: 'tenant-001', expectedVersion: 6,
      batchId: 'batch-001', preparedBy: 'locker-001',
      exportEvidenceId: 'export-001', trustedExport: true,
    }, NOW)).toThrow('必须分离');
    period = startPayrollDisbursement(period, {
      tenantId: 'tenant-001', expectedVersion: 6,
      batchId: 'batch-001', preparedBy: 'maker-002',
      exportEvidenceId: 'export-001', trustedExport: true,
    }, NOW);
    expect(() => beginPayrollReconciliation(period, {
      tenantId: 'tenant-001', expectedVersion: 7, batchId: 'other-batch',
    }, NOW)).toThrow('引用不匹配');
    period = beginPayrollReconciliation(period, {
      tenantId: 'tenant-001', expectedVersion: 7, batchId: 'batch-001',
    }, NOW);
    expect(() => completePayrollReconciliation(period, {
      tenantId: 'tenant-001', expectedVersion: 8,
      reconciledBy: 'reconciler-001', reconciliationEvidenceId: 'recon-001',
      balanced: true, trustedReconciliation: false,
    }, NOW)).toThrow('受信任对账服务');
    expect(() => completePayrollReconciliation(period, {
      tenantId: 'tenant-001', expectedVersion: 8,
      reconciledBy: 'maker-002', reconciliationEvidenceId: 'recon-001',
      balanced: true, trustedReconciliation: true,
    }, NOW)).toThrow('必须分离');
    expect(() => recordPayrollReconciliationMismatch(period, {
      tenantId: 'tenant-001', expectedVersion: 8,
      reconciliationEvidenceId: 'recon-mismatch-001', trustedReconciliation: false,
    }, NOW)).toThrow('受信任对账服务');
    const frozen = recordPayrollReconciliationMismatch(period, {
      tenantId: 'tenant-001', expectedVersion: 8,
      reconciliationEvidenceId: 'recon-mismatch-001', trustedReconciliation: true,
    }, NOW);
    expect(frozen).toMatchObject({
      status: 'reconciling', version: 9,
      reconciliationEvidenceId: 'recon-mismatch-001',
    });
  });
});
