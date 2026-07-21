import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { TreasuryReconciliationService } from './treasury-reconciliation.service.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const actor: ActorContext = {
  actorType: 'service', actorId: 'reconciliation-service', tenantId: tenant.tenantId,
  roleCodes: ['payroll_reconciliation'], scopes: ['erp:payroll:reconciliation:execute'],
  departmentIds: [], traceId: 'trace-reconciliation-001',
};
const session = {} as ClientSession;
const BATCH_ID = '01J8ZQK7V0A2M4N6P8R0T2W4B1';

function query<T>(resolve: () => T | Promise<T>) {
  const value = { session: vi.fn(), lean: vi.fn(), exec: vi.fn(async () => resolve()) };
  value.session.mockReturnValue(value);
  value.lean.mockReturnValue(value);
  return value;
}

function setup(balanced = true) {
  const context = new TenantContextService();
  const batch = {
    id: BATCH_ID, tenantId: tenant.tenantId,
    payrollPeriodId: '01J8ZQK7V0A2M4N6P8R0T2W4P1',
    payrollRunId: '01J8ZQK7V0A2M4N6P8R0T2W4R1', payrollResultHash: 'a'.repeat(43),
    purpose: 'regular', recoverySourceBatchId: null,
    status: 'reconciling', version: 5, lineCount: 2, totalMinor: 1_679_000,
    preparedBy: 'treasury-maker', objectEvidenceId: 'treasury-worm-001',
    bankSubmissionId: 'bank-submission-001', bankSubmissionEvidenceId: 'bank-evidence-001',
    returnHash: 'b'.repeat(43), successfulCount: 2, successfulMinor: 1_679_000,
    failedCount: 0, failedMinor: 0,
  };
  const bankReturn = {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4N1', tenantId: tenant.tenantId, batchId: BATCH_ID,
    bankSubmissionId: 'bank-submission-001',
    returnHash: 'b'.repeat(43), outcome: 'accepted', signatureVerified: true,
    malwareClean: true, successfulCount: 2, successfulMinor: 1_679_000,
    failedCount: 0, failedMinor: 0, unknownCount: 0, duplicateCount: 0,
    lineAmountMismatchCount: 0, objectEvidenceId: 'return-worm-001',
    signatureEvidenceId: 'return-signature-001', malwareScanEvidenceId: 'return-malware-001',
  };
  const summary = {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4C1', periodId: batch.payrollPeriodId,
    payrollRunId: batch.payrollRunId, batchId: BATCH_ID, bankReturnId: bankReturn.id,
    taxFilingId: '01J8ZQK7V0A2M4N6P8R0T2W4F1',
    status: balanced ? 'balanced' as const : 'frozen' as const,
    differences: balanced ? [] : ['PAYROLL_TAX_AMOUNT_MISMATCH'],
    evidenceHash: 'e'.repeat(43), employeeCount: 2, bankLineCount: 2,
    totalGrossMinor: 2_000_000, totalNetMinor: 1_679_000,
    bankSubmittedMinor: 1_679_000, bankReturnedMinor: 1_679_000,
    totalTaxableEarningsMinor: 2_000_000, payrollWithholdingTaxMinor: 21_000,
    filedWithholdingTaxMinor: balanced ? 21_000 : 20_000, version: 1,
  };
  const payroll = {
    getForBatch: vi.fn().mockResolvedValue(null),
    reconcile: vi.fn().mockResolvedValue({
      summary, result: { ...summary, balanced },
    }),
  };
  const batches = {
    findOne: vi.fn().mockReturnValue(query(() => batch)),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const returns = { findOne: vi.fn().mockReturnValue(query(() => bankReturn)) };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const idempotency = { execute: vi.fn(async (
    _operation: string, _key: string, _request: unknown,
    handler: (value: ClientSession) => Promise<unknown>,
  ) => handler(session)) };
  const service = new TreasuryReconciliationService(
    idempotency as never, context, payroll as never, outbox as never,
    batches as never, returns as never,
  );
  return { context, service, payroll, batches, returns, outbox, summary, batch, bankReturn };
}

describe('TreasuryReconciliationService', () => {
  it('可信服务对账守恒时同步完成代发批次', async () => {
    const store = setup();
    const result = await store.context.run({ tenant, actor }, () =>
      store.service.reconcile('four-way-reconcile-001', BATCH_ID, 5));
    expect(result).toEqual(store.summary);
    expect(store.batches.updateOne).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: tenant.tenantId, id: BATCH_ID, status: 'reconciling', version: 5,
    }), { $set: {
      status: 'reconciled', version: 6, freezeReason: null,
    } }, { session, runValidators: true });
    expect(JSON.stringify(store.outbox.append.mock.calls)).toContain(
      '"differenceCount":0,"status":"reconciled"',
    );
  });

  it('任一四方差异冻结代发批次且保留差异证据', async () => {
    const store = setup(false);
    const result = await store.context.run({ tenant, actor }, () =>
      store.service.reconcile('four-way-reconcile-002', BATCH_ID, 5));
    expect(result.status).toBe('frozen');
    expect(store.batches.updateOne).toHaveBeenCalledWith(expect.anything(), { $set: {
      status: 'frozen', version: 6, freezeReason: 'FOUR_WAY_MISMATCH',
    } }, expect.anything());
  });

  it('普通用户即使持有 Scope 也不能执行自动对账', async () => {
    const store = setup();
    const human = { ...actor, actorType: 'user' as const };
    await expect(store.context.run({ tenant, actor: human }, () =>
      store.service.reconcile('four-way-reconcile-human', BATCH_ID, 5)))
      .rejects.toThrow('只允许受信任对账服务');
    expect(store.payroll.reconcile).not.toHaveBeenCalled();
  });

  it('恢复子批次与父批次成功部分形成完整结算链', async () => {
    const store = setup();
    const parentId = '01J8ZQK7V0A2M4N6P8R0T2W4A1';
    const child = {
      ...store.batch, purpose: 'recovery', recoverySourceBatchId: parentId,
      lineCount: 1, totalMinor: 839_500, successfulCount: 1, successfulMinor: 839_500,
    };
    const parent = {
      ...store.batch, id: parentId, purpose: 'regular', recoverySourceBatchId: null,
      status: 'frozen', freezeReason: 'PARTIAL_SUCCESS', returnHash: 'p'.repeat(43),
      successfulCount: 1, successfulMinor: 839_500, failedCount: 1, failedMinor: 839_500,
    };
    const childReturn = {
      ...store.bankReturn, successfulCount: 1, successfulMinor: 839_500,
    };
    const parentReturn = {
      ...store.bankReturn, id: '01J8ZQK7V0A2M4N6P8R0T2W4M1', batchId: parentId,
      returnHash: 'p'.repeat(43), outcome: 'frozen', successfulCount: 1,
      successfulMinor: 839_500, failedCount: 1, failedMinor: 839_500,
    };
    store.batches.findOne.mockImplementation((filter: { id?: string }) =>
      query(() => filter.id === parentId ? parent : child));
    store.returns.findOne.mockImplementation((filter: { batchId?: string }) =>
      query(() => filter.batchId === parentId ? parentReturn : childReturn));
    await store.context.run({ tenant, actor }, () =>
      store.service.reconcile('four-way-recovery-chain', BATCH_ID, 5));
    const calls = JSON.stringify(store.payroll.reconcile.mock.calls);
    expect(calls).toContain(
      '"lineCount":1,"totalMinor":839500,"settledLineCount":2,"settledMinor":1679000',
    );
    expect(calls).toMatch(/"settlementChainHash":"[A-Za-z0-9_-]{43}"/u);
  });
});
