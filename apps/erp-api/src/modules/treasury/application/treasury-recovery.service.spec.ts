import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { TreasuryRecoveryService } from './treasury-recovery.service.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const PARENT_ID = '01J8ZQK7V0A2M4N6P8R0T2W4P1';
const FAILED_ID = '01J8ZQK7V0A2M4N6P8R0T2W4F1';
const SUCCESS_ID = '01J8ZQK7V0A2M4N6P8R0T2W4S1';
const RETURN_ID = '01J8ZQK7V0A2M4N6P8R0T2W4R1';
const ACCOUNT_ID = '01J8ZQK7V0A2M4N6P8R0T2W4A1';
const EVIDENCE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4E1';
const session = {} as ClientSession;

function actor(actorId = 'recovery-approver'): ActorContext {
  return {
    actorType: 'user', actorId, tenantId: tenant.tenantId,
    roleCodes: ['treasury_recovery'], scopes: ['erp:treasury:recovery:create'],
    departmentIds: [], traceId: 'trace-recovery-001',
  };
}

function query<T>(resolve: () => T | Promise<T>) {
  const value = {
    session: vi.fn(), sort: vi.fn(), lean: vi.fn(), exec: vi.fn(async () => resolve()),
  };
  value.session.mockReturnValue(value);
  value.sort.mockReturnValue(value);
  value.lean.mockReturnValue(value);
  return value;
}

function assemble(parentChanges: Readonly<Record<string, unknown>> = {}) {
  const context = new TenantContextService();
  const parent = {
    id: PARENT_ID, tenantId: tenant.tenantId,
    payrollPeriodId: '01J8ZQK7V0A2M4N6P8R0T2W4D1',
    payrollRunId: '01J8ZQK7V0A2M4N6P8R0T2W4N1',
    payrollResultHash: 'p'.repeat(43), payableResultHash: 'q'.repeat(43),
    batchSequence: 1, parentBatchId: null, purpose: 'regular',
    format: 'ISO20022_PAIN_001_001_03', fileHash: 'f'.repeat(43),
    lineCount: 2, totalMinor: 1_500, preparedBy: 'original-maker',
    payrollLockedBy: 'payroll-locker', exportApprovedBy: 'original-checker',
    strongAuthEvidenceId: 'export-evidence', objectEvidenceId: 'object-evidence',
    objectRef: 'worm/parent', bankSubmissionId: 'bank-submit-001',
    bankSubmissionEvidenceId: 'bank-submit-evidence', returnHash: 'r'.repeat(43),
    successfulCount: 1, failedCount: 1, successfulMinor: 1_000, failedMinor: 500,
    freezeReason: 'PARTIAL_SUCCESS', status: 'frozen', version: 5,
    dataKeyId: 'key', dataIv: 'iv', dataCiphertext: 'cipher', dataAuthTag: 'tag',
    createdAt: new Date(), updatedAt: new Date(), ...parentChanges,
  };
  const returned = {
    id: RETURN_ID, tenantId: tenant.tenantId, batchId: PARENT_ID,
    bankSubmissionId: 'bank-submit-001', sequence: 1, returnHash: 'r'.repeat(43),
    signatureVerified: true, malwareClean: true, unknownCount: 0, duplicateCount: 0,
    lineAmountMismatchCount: 0, successfulCount: 1, failedCount: 1,
    successfulMinor: 1_000, failedMinor: 500, outcome: 'frozen',
    dataKeyId: 'key', dataIv: 'iv', dataCiphertext: 'cipher', dataAuthTag: 'tag',
  };
  const failedData = {
    instructionId: FAILED_ID, employeeId: 'employee-failed', bankAccountId: 'old-account',
    payrollCalculationLineId: '01J8ZQK7V0A2M4N6P8R0T2W4L1', payrollResultHash: 'a'.repeat(43),
    creditorName: '旧户名', creditorAccount: '6222000000000001',
    creditorAgentClearingCode: 'CNAPS001', amountMinor: 500, purposeCode: 'PAYROLL',
  };
  const successData = {
    ...failedData, instructionId: SUCCESS_ID, employeeId: 'employee-success',
    payrollCalculationLineId: '01J8ZQK7V0A2M4N6P8R0T2W4L2',
    payrollResultHash: 'b'.repeat(43), amountMinor: 1_000,
  };
  const originals = [failedData, successData].map((data) => ({
    id: data.instructionId, tenantId: tenant.tenantId, batchId: PARENT_ID,
    employeeId: data.employeeId, bankAccountId: data.bankAccountId,
    payrollCalculationLineId: data.payrollCalculationLineId, status: 'frozen',
    dataKeyId: 'key', dataIv: 'iv', dataCiphertext: 'cipher', dataAuthTag: 'tag',
  }));
  const batches = {
    findOne: vi.fn().mockImplementation((filter: Readonly<Record<string, unknown>>) =>
      query(() => 'recoverySourceBatchId' in filter ? null : parent)),
    create: vi.fn().mockResolvedValue([]),
  };
  const returns = { findOne: vi.fn().mockReturnValue(query(() => returned)) };
  const instructions = {
    find: vi.fn().mockReturnValue(query(() => originals)), create: vi.fn().mockResolvedValue([]),
  };
  const account = {
    id: ACCOUNT_ID, ownerId: 'employee-failed', version: 2,
    dataKeyId: 'key', dataIv: 'iv', dataCiphertext: 'cipher', dataAuthTag: 'tag',
  };
  const accounts = { find: vi.fn().mockReturnValue(query(() => [account])) };
  const crypto = {
    unprotect: vi.fn().mockImplementation((cryptoContext: { resourceType: string; resourceId: string }) => {
      if (cryptoContext.resourceType === 'bank_return') return {
        returnId: RETURN_ID, tenantId: tenant.tenantId, batchId: PARENT_ID,
        bankSubmissionId: 'bank-submit-001', sequence: 1, returnHash: 'r'.repeat(43),
        lines: [
          { instructionId: FAILED_ID, outcome: 'failed', amountMinor: 500, bankLineReference: 'failed-ref' },
          { instructionId: SUCCESS_ID, outcome: 'succeeded', amountMinor: 1_000, bankLineReference: 'success-ref' },
        ],
      };
      if (cryptoContext.resourceType === 'payment_instruction') {
        return cryptoContext.resourceId === FAILED_ID ? failedData : successData;
      }
      if (cryptoContext.resourceType === 'bank_account') return {
        accountName: '新审批户名', account: '6222000000000099',
        clearingCode: 'CNAPS009', currency: 'CNY',
      };
      return {
        messageId: PARENT_ID, paymentInformationId: PARENT_ID,
        creationDateTime: new Date().toISOString(), requestedExecutionDate: '2026-07-22',
        debtorBankAccountId: 'debtor-account', debtorName: '付款组织',
        debtorAccount: '6222000000000088', debtorAgentClearingCode: 'CNAPS008',
        payrollResultHash: parent.payrollResultHash, payableResultHash: parent.payableResultHash,
      };
    }),
    protect: vi.fn().mockReturnValue({
      keyId: 'recovery-key', iv: 'recovery-iv', ciphertext: 'recovery-cipher',
      authTag: 'recovery-tag',
    }),
  };
  const strongAuth = { requireVerifiedEvidence: vi.fn().mockResolvedValue({
    evidenceId: EVIDENCE_ID, method: 'webauthn_uv',
  }) };
  const idempotency = { execute: vi.fn(async (
    _operation: string, _key: string, _request: unknown,
    handler: (value: ClientSession) => Promise<Record<string, unknown>>,
  ) => handler(session)) };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const disbursements = { materializeStaged: vi.fn().mockImplementation((
    _key: string, id: string,
  ) => Promise.resolve({
    id, payrollPeriodId: parent.payrollPeriodId, payrollRunId: parent.payrollRunId,
    status: 'prepared', version: 2, lineCount: 1, totalMinor: 500,
    fileHash: 'x'.repeat(43), objectEvidenceId: 'recovery-object',
    bankSubmissionId: null, bankSubmissionEvidenceId: null,
  })) };
  const service = new TreasuryRecoveryService(
    idempotency as never, context, strongAuth as never, crypto as never, outbox as never,
    disbursements as never, accounts as never, instructions as never, batches as never,
    returns as never,
  );
  const token = {
    issuer: 'https://erp.example.test', subject: 'recovery-approver', audience: ['erp-api'],
    resource: ['erp-api'], tenantId: tenant.tenantId, actorId: 'recovery-approver',
    actorType: 'user' as const, clientId: 'erp-web', roleCodes: [],
    scopes: ['erp:treasury:recovery:create'], departmentIds: [],
    sessionId: 'session-recovery', expiresAt: Date.now() + 60_000,
  };
  return {
    context, service, token, batches, instructions, crypto, outbox, disbursements, strongAuth,
  };
}

describe('TreasuryRecoveryService', () => {
  it('强认证后仅用明确失败行和当前审批账户创建关联子批次', async () => {
    const store = assemble();
    const result = await store.context.run({ tenant, actor: actor() }, () => store.service.create(
      'treasury-recovery-001', PARENT_ID,
      { expectedVersion: 5, strongAuthEvidenceId: EVIDENCE_ID }, store.token,
    ));
    expect(result).toMatchObject({ status: 'prepared', lineCount: 1, totalMinor: 500 });
    expect(store.batches.create).toHaveBeenCalledWith([
      expect.objectContaining({
        parentBatchId: PARENT_ID, recoverySourceBatchId: PARENT_ID,
        purpose: 'recovery', lineCount: 1, totalMinor: 500,
        recoveryApprovedBy: 'recovery-approver', recoveryStrongAuthEvidenceId: EVIDENCE_ID,
        recoveryReturnId: RETURN_ID,
      }),
    ], expect.any(Object));
    expect(store.instructions.create).toHaveBeenCalledWith([
      expect.objectContaining({
        employeeId: 'employee-failed', bankAccountId: ACCOUNT_ID, status: 'materializing',
      }),
    ], expect.any(Object));
    const instructionProtection = store.crypto.protect.mock.calls.find((call) =>
      (call[0] as { resourceType: string }).resourceType === 'payment_instruction');
    expect(instructionProtection?.[1]).toMatchObject({
      employeeId: 'employee-failed', amountMinor: 500,
      creditorAccount: '6222000000000099',
    });
    const event = JSON.stringify(store.outbox.append.mock.calls);
    expect(event).toContain('"type":"treasury.disbursement.recovery_requested"');
    expect(event).toContain(`"parentBatchId":"${PARENT_ID}"`);
    expect(event).toContain('"failedCount":1');
    expect(event).toContain('"failedMinor":500');
    expect(store.disbursements.materializeStaged).toHaveBeenCalledOnce();
    const persistence = JSON.stringify([
      store.batches.create.mock.calls, store.instructions.create.mock.calls,
      store.outbox.append.mock.calls, result,
    ]);
    expect(persistence).not.toMatch(/62220000000000(?:01|88|99)|旧户名|新审批户名|付款组织/u);
  });

  it('非部分成功冻结不得创建恢复子批次', async () => {
    const store = assemble({ freezeReason: 'UNKNOWN_LINE' });
    await expect(store.context.run({ tenant, actor: actor() }, () => store.service.create(
      'treasury-recovery-unsafe', PARENT_ID,
      { expectedVersion: 5, strongAuthEvidenceId: EVIDENCE_ID }, store.token,
    ))).rejects.toThrow('只有干净部分失败');
    expect(store.batches.create).not.toHaveBeenCalled();
    expect(store.disbursements.materializeStaged).not.toHaveBeenCalled();
  });

  it('原工资锁定、制备或导出批准人不得批准恢复', async () => {
    const store = assemble();
    const original = actor('original-checker');
    const token = { ...store.token, subject: original.actorId, actorId: original.actorId };
    await expect(store.context.run({ tenant, actor: original }, () => store.service.create(
      'treasury-recovery-not-independent', PARENT_ID,
      { expectedVersion: 5, strongAuthEvidenceId: EVIDENCE_ID }, token,
    ))).rejects.toThrow('恢复批准人必须独立');
    expect(store.batches.create).not.toHaveBeenCalled();
  });
});
