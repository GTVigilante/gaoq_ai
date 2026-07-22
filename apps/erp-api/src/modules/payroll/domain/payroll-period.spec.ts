import { describe, expect, it } from 'vitest';

import {
  applyPayrollApproval,
  beginPayrollReconciliation,
  completePayrollReconciliation,
  createPayrollPeriod,
  lockPayrollPeriod,
  recordPayrollCalculation,
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
});
