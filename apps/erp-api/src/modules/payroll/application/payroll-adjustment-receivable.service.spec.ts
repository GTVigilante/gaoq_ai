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
  return {
    context,
    service,
    adjustments,
    crypto,
    idempotency,
    receivables,
    recoveries,
    outbox,
    readReceivable: () => receivable,
    writeReceivable: (value: Record<string, unknown> | null) => {
      receivable = value;
    },
    writeProtectedValue: (value: Record<string, unknown> | null) => {
      protectedValue = value;
    },
  };
}

const opener = actor('user', 'independent-receivable-opener', [
  'erp:payroll:adjustment:receivable:open',
  'erp:payroll:adjustment:receivable:source:read',
]);
const recoveryWriter = actor('service', 'trusted-bank-return', [
  'erp:payroll:adjustment:receivable:settle',
  'erp:payroll:adjustment:receivable:deduction:settle',
]);

async function openReceivable(store: ReturnType<typeof assemble>) {
  return store.context.run({ tenant, actor: opener }, () => store.service.open(
    'receivable-open-helper',
    adjustmentId,
    { expectedAdjustmentVersion: 4 },
  ));
}

function recoveryInput(
  changes: Partial<Parameters<
    PayrollAdjustmentReceivableService['recordRecovery']
  >[2]> = {},
) {
  return {
    expectedReceivableVersion: 1,
    method: 'bank_repayment' as const,
    amountMinor: 1,
    sourceReferenceId: 'bank-return-001',
    sourceEvidenceId: 'worm-bank-return-001',
    receivedAt: new Date().toISOString(),
    ...changes,
  };
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

  it.each([
    actor('service', 'service-opener', [
      'erp:payroll:adjustment:receivable:open',
      'erp:payroll:adjustment:receivable:source:read',
    ]),
    actor('user', 'missing-open-scope', [
      'erp:payroll:adjustment:receivable:source:read',
    ]),
    actor('user', 'missing-source-scope', [
      'erp:payroll:adjustment:receivable:open',
    ]),
  ])('拒绝不满足人工双权限的应收建立主体：$actorId', async (principal) => {
    const store = assemble();
    await expect(store.context.run({ tenant, actor: principal }, () =>
      store.service.open('denied', adjustmentId, {
        expectedAdjustmentVersion: 4,
      }))).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_OPENER_DENIED' },
    });
  });

  it.each([
    ['bad', 4],
    [adjustmentId, 0],
    [adjustmentId, Number.NaN],
  ])('拒绝非法调整引用或版本：%s / %s', async (id, version) => {
    const store = assemble();
    await expect(store.context.run({ tenant, actor: opener }, () =>
      store.service.open('invalid', id, {
        expectedAdjustmentVersion: version,
      }))).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_OPEN_INPUT_INVALID' },
    });
  });

  it('拒绝原调整控制链参与人建立应收', async () => {
    const store = assemble();
    await expect(store.context.run({
      tenant,
      actor: { ...opener, actorId: 'adjustment-preparer' },
    }, () => store.service.open('independence', adjustmentId, {
      expectedAdjustmentVersion: 4,
    }))).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_INDEPENDENCE_REQUIRED' },
    });
  });

  it.each([
    actor('user', 'human-writer', ['erp:payroll:adjustment:receivable:settle']),
    actor('service', 'missing-settle-scope', []),
    actor('system_job', 'missing-deduction-scope', [
      'erp:payroll:adjustment:receivable:settle',
    ]),
  ])('拒绝不可信恢复写入主体：$actorId', async (principal) => {
    const store = assemble();
    const input = principal.actorId === 'missing-deduction-scope'
      ? recoveryInput({
        method: 'authorized_payroll_deduction',
        legalAuthorizationEvidenceId: 'authorization-001',
      })
      : recoveryInput();
    await expect(store.context.run({ tenant, actor: principal }, () =>
      store.service.recordRecovery('denied', adjustmentId, input)))
      .rejects.toMatchObject({
        response: { code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_RECOVERY_WRITER_DENIED' },
      });
  });

  it.each([
    ['bad', recoveryInput()],
    [adjustmentId, recoveryInput({ expectedReceivableVersion: 0 })],
    [adjustmentId, recoveryInput({ expectedReceivableVersion: Number.NaN })],
    [adjustmentId, recoveryInput({ method: 'invalid' as 'bank_repayment' })],
    [adjustmentId, recoveryInput({ amountMinor: 0 })],
    [adjustmentId, recoveryInput({ amountMinor: Number.NaN })],
    [adjustmentId, recoveryInput({ sourceReferenceId: '' })],
    [adjustmentId, recoveryInput({ sourceEvidenceId: '' })],
    [adjustmentId, recoveryInput({ legalAuthorizationEvidenceId: '' })],
    [adjustmentId, recoveryInput({ legalAuthorizationEvidenceId: 'unexpected' })],
    [adjustmentId, recoveryInput({
      method: 'authorized_payroll_deduction',
    })],
    [adjustmentId, recoveryInput({ receivedAt: 'invalid' })],
    [adjustmentId, recoveryInput({ receivedAt: '2026-07-01T00:00:00Z' })],
  ])('拒绝非法恢复输入 %#', async (id, input) => {
    const store = assemble();
    await expect(store.context.run({ tenant, actor: recoveryWriter }, () =>
      store.service.recordRecovery('invalid', id, input)))
      .rejects.toMatchObject({
        response: { code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_RECOVERY_INPUT_INVALID' },
      });
  });

  it('接受带独立法定授权证据的工资抵扣终态', async () => {
    const store = assemble();
    const opened = await openReceivable(store);
    const principal = actor('system_job', 'payroll-runner', [
      'erp:payroll:adjustment:receivable:settle',
      'erp:payroll:adjustment:receivable:deduction:settle',
    ]);
    await expect(store.context.run({ tenant, actor: principal }, () =>
      store.service.recordRecovery('deduction', opened.id, recoveryInput({
        method: 'authorized_payroll_deduction',
        amountMinor: 97_000,
        legalAuthorizationEvidenceId: 'authorization-001',
      })))).resolves.toMatchObject({ status: 'settled' });
  });

  it('拒绝状态、版本、超额恢复和异常恢复时间', async () => {
    const variants = [
      { record: { status: 'settled' }, input: recoveryInput() },
      { record: {}, input: recoveryInput({ expectedReceivableVersion: 2 }) },
      { record: {}, input: recoveryInput({ amountMinor: 97_001 }) },
    ];
    for (const variant of variants) {
      const store = assemble();
      const opened = await openReceivable(store);
      store.writeReceivable({
        ...store.readReceivable(),
        ...variant.record,
      });
      await expect(store.context.run({ tenant, actor: recoveryWriter }, () =>
        store.service.recordRecovery('state', opened.id, variant.input)))
        .rejects.toMatchObject({
          response: { code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_RECOVERY_STATE_INVALID' },
        });
    }

    for (const receivedAt of [
      '2020-01-01T00:00:00.000Z',
      new Date(Date.now() + 6 * 60_000).toISOString(),
    ]) {
      const store = assemble();
      const opened = await openReceivable(store);
      await expect(store.context.run({ tenant, actor: recoveryWriter }, () =>
        store.service.recordRecovery('time', opened.id, recoveryInput({ receivedAt }))))
        .rejects.toMatchObject({
          response: { code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_RECOVERY_TIME_INVALID' },
        });
    }
  });

  it('拒绝并发更新冲突', async () => {
    const store = assemble();
    const opened = await openReceivable(store);
    store.receivables.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(store.context.run({ tenant, actor: recoveryWriter }, () =>
      store.service.recordRecovery('conflict', opened.id, recoveryInput())))
      .rejects.toMatchObject({
        response: { code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_RECOVERY_WRITE_CONFLICT' },
      });
  });

  it('读摘要前执行权限、标识、存在性与密文一致性校验', async () => {
    const store = assemble();
    const opened = await openReceivable(store);
    await expect(store.context.run({
      tenant,
      actor: actor('user', 'reader', ['erp:payroll:adjustment:receivable:read']),
    }, () => store.service.get(opened.id))).resolves.toMatchObject({
      id: opened.id,
      recoveredAmountMinor: 0,
    });
    await expect(store.context.run({
      tenant,
      actor: actor('user', 'reader', []),
    }, () => store.service.get(opened.id))).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_SCOPE_REQUIRED' },
    });
    await expect(store.context.run({
      tenant,
      actor: actor('user', 'reader', ['erp:payroll:adjustment:receivable:read']),
    }, () => store.service.get('bad'))).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_ID_INVALID' },
    });
    store.writeReceivable(null);
    await expect(store.context.run({
      tenant,
      actor: actor('user', 'reader', ['erp:payroll:adjustment:receivable:read']),
    }, () => store.service.get(opened.id))).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_NOT_FOUND' },
    });
  });

  it('密文结构或控制字段异常时失败关闭', async () => {
    const read = actor('user', 'reader', [
      'erp:payroll:adjustment:receivable:read',
    ]);
    const invalidStructure = assemble();
    const opened = await openReceivable(invalidStructure);
    invalidStructure.writeProtectedValue({});
    await expect(invalidStructure.context.run({ tenant, actor: read }, () =>
      invalidStructure.service.get(opened.id))).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_PROTECTED_DATA_INVALID' },
    });

    for (const change of [
      { adjustmentId: '01J8ZQK7V0A2M4N6P8R0T2W4Z1' },
      { adjustmentHash: 'x'.repeat(43) },
      { originalAmountMinor: 1 },
      { openedBy: 'different-opener' },
    ]) {
      const store = assemble();
      const value = await openReceivable(store);
      store.writeProtectedValue({ ...store.crypto.unprotect(), ...change });
      await expect(store.context.run({ tenant, actor: read }, () =>
        store.service.get(value.id))).rejects.toMatchObject({
        response: { code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_INTEGRITY_FAILED' },
      });
    }
  });

  it('把 Mongo 唯一键冲突映射为稳定业务冲突', async () => {
    const store = assemble();
    store.idempotency.execute.mockRejectedValueOnce({ code: 11_000 });
    await expect(store.context.run({ tenant, actor: opener }, () =>
      store.service.open('duplicate', adjustmentId, {
        expectedAdjustmentVersion: 4,
      }))).rejects.toMatchObject({
      response: { code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_DUPLICATE_SOURCE' },
    });
  });
});
