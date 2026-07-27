import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { TreasuryAdjustmentSupplementService } from './treasury-adjustment-supplement.service.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const session = {} as ClientSession;
const adjustmentId = '01J8ZQK7V0A2M4N6P8R0T2W4D1';
const parentBatchId = '01J8ZQK7V0A2M4N6P8R0T2W4B1';
const periodId = '01J8ZQK7V0A2M4N6P8R0T2W4P1';
const runId = '01J8ZQK7V0A2M4N6P8R0T2W4R1';
const lineId = '01J8ZQK7V0A2M4N6P8R0T2W4N1';
const source = Object.freeze({
  adjustmentId,
  adjustmentHash: 'a'.repeat(43),
  periodId,
  period: '2026-07',
  payrollRunId: runId,
  originalCalculationLineId: lineId,
  employeeId: 'employee-001',
  correctedResultHash: 'c'.repeat(43),
  payableMinor: 97_000,
  adjustmentVersion: 4,
  controlActorIds: ['adjustment-engine', 'payroll-requester', 'finance-approver', 'payroll-locker'],
  lockedBy: 'payroll-locker',
});

function query<T>(value: T) {
  const result = {
    sort: vi.fn(() => result),
    session: vi.fn(() => result),
    lean: vi.fn(() => result),
    exec: vi.fn().mockResolvedValue(value),
  };
  return result;
}

function principal(actorId = 'treasury-preparer'): ActorContext {
  return {
    actorType: 'user',
    actorId,
    tenantId: tenant.tenantId,
    roleCodes: [],
    scopes: [
      'erp:treasury:adjustment:prepare',
      'erp:treasury:adjustment:source:read',
    ],
    departmentIds: [],
    traceId: 'trace-adjustment-supplement',
  };
}

function assemble() {
  const context = new TenantContextService();
  const idempotency = {
    execute: vi.fn(async (
      _operation: string,
      _key: string,
      _input: unknown,
      handler: (value: ClientSession) => Promise<Record<string, unknown>>,
    ) => handler(session)),
  };
  const payrollAdjustments = {
    getLockedSupplementSource: vi.fn().mockResolvedValue(source),
  };
  const parent = {
    id: parentBatchId,
    tenantId: tenant.tenantId,
    payrollPeriodId: periodId,
    payrollRunId: runId,
    payrollResultHash: 'p'.repeat(43),
    payableResultHash: 'q'.repeat(43),
    batchSequence: 1,
    parentBatchId: null,
    recoverySourceBatchId: null,
    adjustmentSourceId: null,
    adjustmentSourceHash: null,
    purpose: 'regular',
    status: 'submitted',
    bankSubmissionId: 'bank-submission-001',
    dataKeyId: 'key',
    dataIv: 'iv',
    dataCiphertext: 'cipher',
    dataAuthTag: 'tag',
  };
  const batches = {
    findOne: vi.fn()
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query(parent))
      .mockReturnValueOnce(query(parent)),
    create: vi.fn().mockResolvedValue([]),
  };
  const debtorRecord = {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4O1',
    version: 1,
    dataKeyId: 'key',
    dataIv: 'iv',
    dataCiphertext: 'cipher',
    dataAuthTag: 'tag',
  };
  const creditorRecord = {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4C1',
    version: 2,
    dataKeyId: 'key',
    dataIv: 'iv',
    dataCiphertext: 'cipher',
    dataAuthTag: 'tag',
  };
  const accounts = {
    findOne: vi.fn()
      .mockReturnValueOnce(query(debtorRecord))
      .mockReturnValueOnce(query(creditorRecord)),
  };
  const instructions = { create: vi.fn().mockResolvedValue([]) };
  const crypto = {
    unprotect: vi.fn()
      .mockReturnValueOnce({
        messageId: parentBatchId,
        paymentInformationId: parentBatchId,
        creationDateTime: '2026-07-01T00:00:00.000Z',
        requestedExecutionDate: '2026-07-02',
        debtorBankAccountId: debtorRecord.id,
        debtorName: '高企集团',
        debtorAccount: '123456789012',
        debtorAgentClearingCode: 'CNAPS001',
        payrollResultHash: parent.payrollResultHash,
        payableResultHash: parent.payableResultHash,
      })
      .mockReturnValueOnce({
        accountName: '高企集团',
        account: '123456789012',
        clearingCode: 'CNAPS001',
        currency: 'CNY',
      })
      .mockReturnValueOnce({
        accountName: '员工甲',
        account: '987654321098',
        clearingCode: 'CNAPS002',
        currency: 'CNY',
      }),
    protect: vi.fn().mockReturnValue({
      keyId: 'treasury-key',
      iv: 'i'.repeat(16),
      ciphertext: 'c'.repeat(32),
      authTag: 'a'.repeat(22),
    }),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const disbursements = {
    materializeStaged: vi.fn().mockImplementation((
      _key: string,
      batchId: string,
    ) => ({
      id: batchId,
      payrollPeriodId: periodId,
      payrollRunId: runId,
      status: 'prepared',
      version: 2,
      lineCount: 1,
      totalMinor: 97_000,
      fileHash: 'f'.repeat(43),
      objectEvidenceId: 'worm-evidence-001',
      bankSubmissionId: null,
      bankSubmissionEvidenceId: null,
    })),
  };
  const service = new TreasuryAdjustmentSupplementService(
    idempotency as never,
    context,
    payrollAdjustments as never,
    crypto as never,
    outbox as never,
    disbursements as never,
    accounts as never,
    instructions as never,
    batches as never,
  );
  return {
    context,
    service,
    payrollAdjustments,
    batches,
    instructions,
    outbox,
    disbursements,
  };
}

describe('TreasuryAdjustmentSupplementService', () => {
  it('从已锁定正差与原代发控制链创建唯一单行补发子批次', async () => {
    const store = assemble();
    const requestedExecutionDate = new Date().toISOString().slice(0, 10);
    const result = await store.context.run({ tenant, actor: principal() }, () =>
      store.service.prepare('supplement-001', adjustmentId, {
        expectedAdjustmentVersion: 4,
        requestedExecutionDate,
      }));

    expect(result).toMatchObject({
      status: 'prepared',
      lineCount: 1,
      totalMinor: 97_000,
    });
    expect(store.payrollAdjustments.getLockedSupplementSource)
      .toHaveBeenCalledWith(adjustmentId, 4, session);
    expect(store.batches.create).toHaveBeenCalledWith([
      expect.objectContaining({
        parentBatchId,
        adjustmentSourceId: adjustmentId,
        adjustmentSourceHash: 'a'.repeat(43),
        purpose: 'supplement',
        lineCount: 1,
        totalMinor: 97_000,
        preparedBy: 'treasury-preparer',
        payrollLockedBy: 'payroll-locker',
      }),
    ], { session });
    expect(store.instructions.create).toHaveBeenCalledWith([
      expect.objectContaining({
        payrollCalculationLineId: lineId,
        employeeId: 'employee-001',
        status: 'materializing',
      }),
    ], { session });
    const event = store.outbox.append.mock.calls[0]?.[0] as unknown as {
      readonly data: Readonly<Record<string, unknown>>;
    };
    expect(event.data).toMatchObject({
      adjustmentId,
      parentBatchId,
      lineCount: 1,
      totalMinor: 97_000,
      status: 'materializing',
    });
    expect(JSON.stringify(event)).not.toMatch(/employee-001|987654321098|员工甲/u);
    expect(store.disbursements.materializeStaged).toHaveBeenCalledOnce();
  });

  it('拒绝调整控制链参与人兼任补发制备人', async () => {
    const store = assemble();
    await expect(store.context.run({
      tenant,
      actor: principal('finance-approver'),
    }, () => store.service.prepare('supplement-001', adjustmentId, {
      expectedAdjustmentVersion: 4,
      requestedExecutionDate: new Date().toISOString().slice(0, 10),
    }))).rejects.toMatchObject({
      response: { code: 'TREASURY_ADJUSTMENT_INDEPENDENCE_REQUIRED' },
    });
    expect(store.batches.create).not.toHaveBeenCalled();
  });
});
