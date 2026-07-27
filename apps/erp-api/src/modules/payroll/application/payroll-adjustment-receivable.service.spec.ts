import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { PayrollAdjustmentReceivableService } from './payroll-adjustment-receivable.service.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const session = {} as ClientSession;
const adjustmentId = '01J8ZQK7V0A2M4N6P8R0T2W4J1';
const adjustmentHash = 'h'.repeat(43);

function actor(
  actorType: ActorContext['actorType'],
  actorId: string,
  scopes: readonly string[],
): ActorContext {
  return {
    actorType,
    actorId,
    tenantId: tenant.tenantId,
    roleCodes: [],
    scopes,
    departmentIds: [],
    traceId: 'trace-receivable-001',
  };
}

function query<T>(read: () => T) {
  const result = {
    session: vi.fn(() => result),
    lean: vi.fn(() => result),
    exec: vi.fn(() => Promise.resolve(read())),
  };
  return result;
}

function assemble() {
  const context = new TenantContextService();
  let receivable: Record<string, unknown> | null = null;
  let protectedValue: Record<string, unknown> | null = null;
  const idempotency = { execute: vi.fn(async (
    _operation: string,
    _key: string,
    _input: unknown,
    handler: (value: ClientSession) => Promise<Record<string, unknown>>,
  ) => handler(session)) };
  const adjustments = {
    getLockedReversalSource: vi.fn().mockResolvedValue({
      adjustmentId,
      adjustmentHash,
      period: '2026-07',
      employeeId: 'employee-001',
      receivableMinor: 97_000,
      adjustmentVersion: 4,
      controlActorIds: ['adjustment-preparer', 'adjustment-approver'],
    }),
    recordReceivableOpened: vi.fn().mockResolvedValue(undefined),
    recordReceivableSettled: vi.fn().mockResolvedValue(undefined),
  };
  const crypto = {
    protect: vi.fn((_context: unknown, value: Record<string, unknown>) => {
      protectedValue = value;
      return {
        keyId: 'receivable-key',
        iv: 'i'.repeat(16),
        ciphertext: 'c'.repeat(64),
        authTag: 'a'.repeat(22),
      };
    }),
    unprotect: vi.fn(() => protectedValue),
  };
  const receivables = {
    create: vi.fn(([value]: readonly Record<string, unknown>[]) => {
      receivable = { ...value };
      return Promise.resolve([]);
    }),
    findOne: vi.fn(() => query(() => receivable)),
    updateOne: vi.fn((
      _filter: unknown,
      update: { readonly $set: Readonly<Record<string, unknown>> },
    ) => {
      receivable = receivable === null
        ? null
        : { ...receivable, ...update.$set };
      return Promise.resolve({ modifiedCount: receivable === null ? 0 : 1 });
    }),
  };
  const recoveries = { create: vi.fn().mockResolvedValue([]) };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const service = new PayrollAdjustmentReceivableService(
    idempotency as never,
    context,
    adjustments as never,
    crypto as never,
    outbox as never,
    receivables as never,
    recoveries as never,
  );
  return { context, service, adjustments, receivables, recoveries, outbox };
}

describe('PayrollAdjustmentReceivableService', () => {
  it('只从已锁定负向调整建立唯一应收且不泄露员工身份到事件', async () => {
    const store = assemble();
    const result = await store.context.run({
      tenant,
      actor: actor('user', 'independent-receivable-opener', [
        'erp:payroll:adjustment:receivable:open',
        'erp:payroll:adjustment:receivable:source:read',
      ]),
    }, () => store.service.open(
      'receivable-open-001',
      adjustmentId,
      { expectedAdjustmentVersion: 4 },
    ));

    expect(result).toMatchObject({
      adjustmentId,
      adjustmentHash,
      originalAmountMinor: 97_000,
      recoveredAmountMinor: 0,
      outstandingAmountMinor: 97_000,
      status: 'open',
      version: 1,
    });
    expect(store.adjustments.recordReceivableOpened).toHaveBeenCalledWith(
      expect.objectContaining({
        adjustmentId,
        adjustmentHash,
        receivableId: result.id,
        expectedVersion: 4,
      }),
      session,
    );
    const event = store.outbox.append.mock.calls.at(-1)?.[0] as {
      readonly data: Readonly<Record<string, unknown>>;
    };
    expect(JSON.stringify(event.data)).not.toMatch(/employee|amount/iu);
  });

  it('支持部分银行回款，余额归零后才回写调整现金结算', async () => {
    const store = assemble();
    const opened = await store.context.run({
      tenant,
      actor: actor('user', 'independent-receivable-opener', [
        'erp:payroll:adjustment:receivable:open',
        'erp:payroll:adjustment:receivable:source:read',
      ]),
    }, () => store.service.open(
      'receivable-open-002',
      adjustmentId,
      { expectedAdjustmentVersion: 4 },
    ));
    const receivedAt = new Date(Date.now() + 1_000).toISOString();
    const recoveryActor = actor('service', 'trusted-bank-return', [
      'erp:payroll:adjustment:receivable:settle',
    ]);
    const partial = await store.context.run({ tenant, actor: recoveryActor }, () =>
      store.service.recordRecovery('receivable-recovery-001', opened.id, {
        expectedReceivableVersion: 1,
        method: 'bank_repayment',
        amountMinor: 40_000,
        sourceReferenceId: 'bank-return-001',
        sourceEvidenceId: 'worm-bank-return-001',
        receivedAt,
      }));
    expect(partial).toMatchObject({
      recoveredAmountMinor: 40_000,
      outstandingAmountMinor: 57_000,
      status: 'open',
      version: 2,
    });
    expect(store.adjustments.recordReceivableSettled).not.toHaveBeenCalled();

    const settled = await store.context.run({ tenant, actor: recoveryActor }, () =>
      store.service.recordRecovery('receivable-recovery-002', opened.id, {
        expectedReceivableVersion: 2,
        method: 'bank_repayment',
        amountMinor: 57_000,
        sourceReferenceId: 'bank-return-002',
        sourceEvidenceId: 'worm-bank-return-002',
        receivedAt: new Date(Date.now() + 2_000).toISOString(),
      }));
    expect(settled).toMatchObject({
      recoveredAmountMinor: 97_000,
      outstandingAmountMinor: 0,
      status: 'settled',
      version: 3,
    });
    expect(store.adjustments.recordReceivableSettled).toHaveBeenCalledOnce();
    expect(store.recoveries.create).toHaveBeenCalledTimes(2);
  });

  it('工资抵扣缺少独立法定授权证据时失败关闭', async () => {
    const store = assemble();
    await expect(store.context.run({
      tenant,
      actor: actor('system_job', 'payroll-runner', [
        'erp:payroll:adjustment:receivable:settle',
        'erp:payroll:adjustment:receivable:deduction:settle',
      ]),
    }, () => store.service.recordRecovery(
      'receivable-recovery-003',
      '01J8ZQK7V0A2M4N6P8R0T2W4Q1',
      {
        expectedReceivableVersion: 1,
        method: 'authorized_payroll_deduction',
        amountMinor: 1,
        sourceReferenceId: 'payroll-run-001',
        sourceEvidenceId: 'worm-payroll-run-001',
        receivedAt: new Date().toISOString(),
      },
    ))).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_RECOVERY_INPUT_INVALID' },
    });
    expect(store.recoveries.create).not.toHaveBeenCalled();
  });
});
