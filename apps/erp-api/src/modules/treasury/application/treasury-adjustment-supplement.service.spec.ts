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

function principal(
  actorId = 'treasury-preparer',
  actorType: ActorContext['actorType'] = 'user',
  scopes: readonly string[] = [
    'erp:treasury:adjustment:prepare',
    'erp:treasury:adjustment:source:read',
  ],
): ActorContext {
  return {
    actorType,
    actorId,
    tenantId: tenant.tenantId,
    roleCodes: [],
    scopes,
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
  const parentHeader = {
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
  };
  const debtor = {
    accountName: '高企集团',
    account: '123456789012',
    clearingCode: 'CNAPS001',
    currency: 'CNY',
  };
  const creditor = {
    accountName: '员工甲',
    account: '987654321098',
    clearingCode: 'CNAPS002',
    currency: 'CNY',
  };
  const accounts = {
    findOne: vi.fn()
      .mockReturnValueOnce(query(debtorRecord))
      .mockReturnValueOnce(query(creditorRecord)),
  };
  const instructions = { create: vi.fn().mockResolvedValue([]) };
  const crypto = {
    unprotect: vi.fn()
      .mockReturnValueOnce(parentHeader)
      .mockReturnValueOnce(debtor)
      .mockReturnValueOnce(creditor),
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
    idempotency,
    payrollAdjustments,
    crypto,
    accounts,
    batches,
    instructions,
    outbox,
    disbursements,
    parent,
    parentHeader,
    debtorRecord,
    creditorRecord,
    debtor,
    creditor,
  };
}

async function prepare(
  store: ReturnType<typeof assemble>,
  input: Parameters<TreasuryAdjustmentSupplementService['prepare']>[2] = {
    expectedAdjustmentVersion: 4,
    requestedExecutionDate: new Date().toISOString().slice(0, 10),
  },
  actor: ActorContext = principal(),
) {
  return store.context.run({ tenant, actor }, () =>
    store.service.prepare('supplement-helper', adjustmentId, input));
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

  it.each([
    principal('service-preparer', 'service'),
    principal('missing-prepare', 'user', [
      'erp:treasury:adjustment:source:read',
    ]),
    principal('missing-source', 'user', [
      'erp:treasury:adjustment:prepare',
    ]),
  ])('拒绝不满足人工双权限的补发制备主体：$actorId', async (actor) => {
    const store = assemble();
    await expect(prepare(store, undefined, actor)).rejects.toMatchObject({
      response: { code: 'TREASURY_ADJUSTMENT_PREPARER_DENIED' },
    });
  });

  it.each([
    { expectedAdjustmentVersion: 0, requestedExecutionDate: '2026-07-01' },
    { expectedAdjustmentVersion: Number.NaN, requestedExecutionDate: '2026-07-01' },
    { expectedAdjustmentVersion: 4, requestedExecutionDate: 'bad' },
  ])('拒绝非法调整版本或日期 %#', async (input) => {
    const store = assemble();
    await expect(prepare(store, input)).rejects.toMatchObject({
      response: { code: 'TREASURY_ADJUSTMENT_INPUT_INVALID' },
    });
  });

  it('幂等重放既有补发批次并拒绝来源绑定不一致或已进入回盘阶段', async () => {
    const validExisting = {
      ...assemble().parent,
      purpose: 'supplement',
      adjustmentSourceId: adjustmentId,
      adjustmentSourceHash: source.adjustmentHash,
      totalMinor: source.payableMinor,
      lineCount: 1,
      status: 'prepared',
      fileHash: 'f'.repeat(43),
      objectEvidenceId: 'worm-evidence',
      bankSubmissionEvidenceId: null,
    };
    const replay = assemble();
    replay.batches.findOne.mockReset().mockReturnValueOnce(query(validExisting));
    await expect(prepare(replay)).resolves.toMatchObject({
      id: parentBatchId,
      status: 'prepared',
      totalMinor: 97_000,
    });

    for (const change of [
      { purpose: 'regular' },
      { adjustmentSourceId: 'other-adjustment' },
      { adjustmentSourceHash: 'x'.repeat(43) },
      { totalMinor: 1 },
      { lineCount: 2 },
    ]) {
      const store = assemble();
      store.batches.findOne.mockReset().mockReturnValueOnce(query({
        ...validExisting,
        ...change,
      }));
      await expect(prepare(store)).rejects.toMatchObject({
        response: { code: 'TREASURY_ADJUSTMENT_EXISTING_BINDING_MISMATCH' },
      });
    }
    const advanced = assemble();
    advanced.batches.findOne.mockReset().mockReturnValueOnce(query({
      ...validExisting,
      status: 'reconciling',
    }));
    await expect(prepare(advanced)).rejects.toMatchObject({
      response: { code: 'TREASURY_ADJUSTMENT_ALREADY_ADVANCED' },
    });
  });

  it('拒绝不存在的原代发批次与不可用的补发序号', async () => {
    const missingParent = assemble();
    missingParent.batches.findOne.mockReset()
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query(null));
    await expect(prepare(missingParent)).rejects.toMatchObject({
      response: { code: 'TREASURY_ADJUSTMENT_PARENT_NOT_SETTLED' },
    });

    for (const latest of [
      null,
      { ...assemble().parent, batchSequence: Number.MAX_SAFE_INTEGER },
    ]) {
      const store = assemble();
      store.batches.findOne.mockReset()
        .mockReturnValueOnce(query(null))
        .mockReturnValueOnce(query(store.parent))
        .mockReturnValueOnce(query(latest));
      await expect(prepare(store)).rejects.toMatchObject({
        response: { code: 'TREASURY_ADJUSTMENT_SEQUENCE_INVALID' },
      });
    }
  });

  it.each([
    '2020-01-01',
    new Date(Date.now() + 91 * 86_400_000).toISOString().slice(0, 10),
  ])('拒绝超出今天起九十天窗口的执行日期：%s', async (requestedExecutionDate) => {
    const store = assemble();
    await expect(prepare(store, {
      expectedAdjustmentVersion: 4,
      requestedExecutionDate,
    })).rejects.toMatchObject({
      response: { code: 'TREASURY_ADJUSTMENT_EXECUTION_DATE_OUT_OF_RANGE' },
    });
  });

  it.each([
    { messageId: 'different-message' },
    { paymentInformationId: 'different-payment' },
    { payrollResultHash: 'x'.repeat(43) },
  ])('拒绝原代发批次控制字段与密文不一致 %#', async (change) => {
    const store = assemble();
    store.crypto.unprotect.mockReset()
      .mockReturnValueOnce({ ...store.parentHeader, ...change });
    await expect(prepare(store)).rejects.toMatchObject({
      response: { code: 'TREASURY_ADJUSTMENT_PARENT_INTEGRITY_FAILED' },
    });
  });

  it.each([
    ['debtor', null],
    ['creditor', null],
  ])('拒绝补发所需活动账户缺失：%s', async (kind, missing) => {
    const store = assemble();
    store.accounts.findOne.mockReset()
      .mockReturnValueOnce(query(kind === 'debtor' ? missing : store.debtorRecord))
      .mockReturnValueOnce(query(kind === 'creditor' ? missing : store.creditorRecord));
    await expect(prepare(store)).rejects.toMatchObject({
      response: { code: 'TREASURY_ADJUSTMENT_ACCOUNT_INCOMPLETE' },
    });
  });

  it.each([
    { debtor: { accountName: '其他公司' } },
    { debtor: { account: '111111111111' } },
    { debtor: { clearingCode: 'CNAPS999' } },
  ])('拒绝原付款账户快照与活动账户不一致 %#', async (change) => {
    const store = assemble();
    store.crypto.unprotect.mockReset()
      .mockReturnValueOnce(store.parentHeader)
      .mockReturnValueOnce({ ...store.debtor, ...change.debtor })
      .mockReturnValueOnce(store.creditor);
    await expect(prepare(store)).rejects.toMatchObject({
      response: { code: 'TREASURY_ADJUSTMENT_DEBTOR_SNAPSHOT_CHANGED' },
    });
  });

  it('把非法受保护数据与唯一键冲突映射为稳定业务冲突', async () => {
    const invalidProtected = assemble();
    invalidProtected.crypto.unprotect.mockReset().mockReturnValueOnce({});
    await expect(prepare(invalidProtected)).rejects.toMatchObject({
      response: { code: 'TREASURY_ADJUSTMENT_PROTECTED_DATA_INVALID' },
    });

    const duplicate = assemble();
    duplicate.idempotency.execute.mockRejectedValueOnce({ code: 11000 });
    await expect(prepare(duplicate)).rejects.toMatchObject({
      response: { code: 'TREASURY_ADJUSTMENT_ALREADY_EXISTS' },
    });
  });
});
