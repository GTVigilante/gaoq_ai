import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { PayrollReconciliationService } from './payroll-reconciliation.service.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const actor: ActorContext = {
  actorType: 'service', actorId: 'reconciliation-service', tenantId: tenant.tenantId,
  roleCodes: ['payroll_reconciliation'], scopes: ['erp:payroll:reconciliation:execute'],
  departmentIds: [], traceId: 'trace-reconciliation-001',
};
const session = {} as ClientSession;
const PERIOD_ID = '01J8ZQK7V0A2M4N6P8R0T2W4P1';
const RUN_ID = '01J8ZQK7V0A2M4N6P8R0T2W4R1';
const BATCH_ID = '01J8ZQK7V0A2M4N6P8R0T2W4B1';
const RETURN_ID = '01J8ZQK7V0A2M4N6P8R0T2W4N1';

function query<T>(resolve: () => T | Promise<T>) {
  const value = { session: vi.fn(), lean: vi.fn(), exec: vi.fn(async () => resolve()) };
  value.session.mockReturnValue(value);
  value.lean.mockReturnValue(value);
  return value;
}

function setup(taxMinor = 21_000) {
  const context = new TenantContextService();
  const period = {
    id: PERIOD_ID, tenantId: tenant.tenantId, period: '2026-07', currency: 'CNY',
    status: 'locked', preparedBy: 'payroll-maker', activeRunId: RUN_ID,
    inputSnapshotHash: 'i'.repeat(43), resultHash: 'a'.repeat(43), employeeCount: 2,
    totalGrossMinor: 2_000_000, totalTaxMinor: 21_000, totalNetMinor: 1_679_000,
    approvalInstanceId: 'approval-001', approvedBy: 'payroll-approver',
    approvalEvidenceId: 'approval-evidence-001', lockedBy: 'payroll-locker',
    strongAuthEvidenceId: 'payroll-lock-evidence-001', disbursementBatchId: null,
    disbursementPreparedBy: null, disbursementExportEvidenceId: null,
    reconciliationEvidenceId: null, reconciledBy: null, version: 6,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-31T00:00:00.000Z'),
  };
  const tax = {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4F1', tenantId: tenant.tenantId,
    periodId: PERIOD_ID, payrollRunId: RUN_ID, payrollResultHash: 'a'.repeat(43),
    status: 'submitted', employeeCount: 2, totalTaxableEarningsMinor: 2_000_000,
    totalWithholdingTaxMinor: taxMinor, contentHash: 'c'.repeat(43),
    taxSubmissionId: 'tax-submission-001', taxSubmissionEvidenceId: 'tax-evidence-001',
  };
  const periods = {
    findOne: vi.fn().mockReturnValue(query(() => period)),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const taxFilings = { findOne: vi.fn().mockReturnValue(query(() => tax)) };
  const reconciliations = {
    findOne: vi.fn().mockReturnValue(query(() => null)),
    create: vi.fn().mockResolvedValue([]),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const service = new PayrollReconciliationService(
    context, outbox as never, periods as never, taxFilings as never, reconciliations as never,
  );
  const treasury = {
    batchId: BATCH_ID, payrollPeriodId: PERIOD_ID, payrollRunId: RUN_ID,
    payrollResultHash: 'a'.repeat(43), status: 'reconciling' as const, version: 5,
    lineCount: 2, totalMinor: 1_679_000,
    settledLineCount: 2, settledMinor: 1_679_000, settlementChainHash: 's'.repeat(43),
    preparedBy: 'treasury-maker',
    exportEvidenceId: 'treasury-worm-001', bankSubmissionId: 'bank-submission-001',
    objectEvidenceId: 'treasury-worm-001',
    bankSubmissionEvidenceId: 'bank-evidence-001',
  };
  const bankReturn = {
    returnId: RETURN_ID, batchId: BATCH_ID, returnHash: 'b'.repeat(43),
    outcome: 'accepted' as const, successfulCount: 2, successfulMinor: 1_679_000,
    failedCount: 0, failedMinor: 0,
    objectEvidenceId: 'return-worm-001', signatureEvidenceId: 'return-signature-001',
    malwareScanEvidenceId: 'return-malware-001',
  };
  return { context, service, periods, reconciliations, outbox, treasury, bankReturn };
}

describe('PayrollReconciliationService', () => {
  it('四方守恒时连续补齐状态事件并原子完成工资周期', async () => {
    const store = setup();
    const result = await store.context.run({ tenant, actor }, () => store.service.reconcile(
      store.treasury, store.bankReturn, actor.actorId, session,
    ));
    expect(result.summary).toMatchObject({ status: 'balanced', differences: [], version: 1 });
    expect(JSON.stringify(store.periods.updateOne.mock.calls)).toContain(
      '"status":"reconciled","activeRunId"',
    );
    expect(JSON.stringify(store.periods.updateOne.mock.calls)).toContain(
      '"reconciledBy":"reconciliation-service","version":9',
    );
    expect(JSON.stringify(store.outbox.append.mock.calls)).toContain(
      'payroll.disbursement.started',
    );
    expect(JSON.stringify(store.outbox.append.mock.calls)).toContain(
      'payroll.reconciliation.started',
    );
    expect(JSON.stringify(store.outbox.append.mock.calls)).toContain(
      'payroll.reconciliation.completed',
    );
    expect(JSON.stringify(store.reconciliations.create.mock.calls))
      .not.toMatch(/employeeId|account|identityEvidence/u);
  });

  it('税额差异固化证据并将工资周期保留在对账态', async () => {
    const store = setup(20_000);
    const result = await store.context.run({ tenant, actor }, () => store.service.reconcile(
      store.treasury, store.bankReturn, actor.actorId, session,
    ));
    expect(result.summary).toMatchObject({
      status: 'frozen', differences: ['PAYROLL_TAX_AMOUNT_MISMATCH'],
    });
    expect(JSON.stringify(store.periods.updateOne.mock.calls)).toContain(
      '"status":"reconciling","activeRunId"',
    );
    expect(JSON.stringify(store.outbox.append.mock.lastCall)).toContain(
      '"differenceCount":1,"status":"frozen"',
    );
  });
});
