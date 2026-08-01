import { createHash } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { ProductionExecutionSubject } from '../../../core/production-execution/production-execution-authorization.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { VerifiedAccessToken } from '../../identity/auth.types.js';
import { PayrollAdjustmentTaxCorrectionService } from './payroll-adjustment-tax-correction.service.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const session = {} as ClientSession;
const adjustmentId = '01J8ZQK7V0A2M4N6P8R0T2W4J1';
const adjustmentHash = 'h'.repeat(43);
const maker = actor('user', 'tax-correction-maker', [
  'erp:payroll:adjustment:tax_correction:prepare',
  'erp:payroll:adjustment:tax_correction:source:read',
]);
const approver = actor('user', 'tax-correction-approver', [
  'erp:payroll:adjustment:tax_correction:approve',
]);
const connector = actor('service', 'trusted-tax-connector', [
  'erp:payroll:adjustment:tax_correction:submit',
]);
const approvalToken: VerifiedAccessToken = {
  issuer: 'https://issuer.example.com',
  subject: approver.actorId,
  audience: ['erp-api'],
  resource: ['erp-api'],
  tenantId: tenant.tenantId,
  actorId: approver.actorId,
  actorType: 'user',
  clientId: 'erp-web',
  roleCodes: approver.roleCodes,
  scopes: approver.scopes,
  departmentIds: [],
  sessionId: 'session-tax-correction-approve',
  expiresAt: 1_900_000_000,
};

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
    traceId: `trace-${actorId}`,
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

function assemble(
  controlActorIds: readonly string[] = [
    'adjustment-maker',
    'adjustment-approver',
  ],
  gatewayMode: 'sandbox' | 'production' = 'sandbox',
  boundary = { assertLegacy: vi.fn() },
) {
  const context = new TenantContextService();
  let correction: Record<string, unknown> | null = null;
  let protectedEnvelope: Record<string, unknown> | null = null;
  const idempotency = { execute: vi.fn(async (
    _operation: string,
    _key: string,
    _input: unknown,
    handler: (value: ClientSession) => Promise<Record<string, unknown>>,
  ) => handler(session)) };
  const adjustments = {
    getLockedTaxCorrectionSource: vi.fn().mockResolvedValue({
      adjustmentId,
      adjustmentHash,
      period: '2026-07',
      employeeId: 'employee-001',
      reasonCode: 'RETROACTIVE_SALARY_CHANGE',
      originalResultHash: 'o'.repeat(43),
      correctedResultHash: 'c'.repeat(43),
      originalTaxableEarningsMinor: 1_000_000,
      correctedTaxableEarningsMinor: 1_100_000,
      originalWithholdingTaxMinor: 10_500,
      correctedWithholdingTaxMinor: 13_500,
      taxableEarningsDeltaMinor: 100_000,
      withholdingTaxDeltaMinor: 3_000,
      cumulativeTaxWithheldDeltaMinor: 3_000,
      adjustmentVersion: 4,
      controlActorIds,
    }),
    recordTaxCorrectionPrepared: vi.fn().mockResolvedValue(undefined),
    recordTaxCorrectionSubmitted: vi.fn().mockResolvedValue(undefined),
  };
  const crypto = {
    protect: vi.fn((_context: unknown, value: Record<string, unknown>) => {
      protectedEnvelope = value;
      return {
        keyId: 'tax-correction-key',
        iv: 'i'.repeat(16),
        ciphertext: 'c'.repeat(128),
        authTag: 'a'.repeat(22),
      };
    }),
    unprotect: vi.fn(() => protectedEnvelope),
  };
  const corrections = {
    create: vi.fn(([value]: readonly Record<string, unknown>[]) => {
      correction = { ...value };
      return Promise.resolve([]);
    }),
    findOne: vi.fn(() => query(() => correction)),
    updateOne: vi.fn((
      _filter: unknown,
      update: { readonly $set: Readonly<Record<string, unknown>> },
    ) => {
      correction = correction === null
        ? null
        : { ...correction, ...update.$set };
      return Promise.resolve({ modifiedCount: correction === null ? 0 : 1 });
    }),
  };
  const archive = { put: vi.fn().mockResolvedValue({
    objectRef: 'worm/payroll-tax/correction-001',
    evidenceId: 'worm-correction-evidence-001',
    immutable: true,
  }) };
  const gateway = { submit: vi.fn().mockResolvedValue({
    submissionId: 'tax-correction-submission-001',
    evidenceId: 'tax-correction-receipt-001',
    accepted: true,
    productionAuthorizationEvidenceId: null,
  }) };
  const strongAuth = { requireVerifiedEvidence: vi.fn().mockResolvedValue({
    evidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4E1',
    method: 'webauthn_uv',
  }) };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const productionAuthorization = {
    authorize: vi.fn((subject: ProductionExecutionSubject) => {
      void subject;
      return Promise.resolve({
        evidenceId: 'production-authorization-evidence',
      });
    }),
  };
  const service = new PayrollAdjustmentTaxCorrectionService(
    idempotency as never,
    context,
    boundary as never,
    adjustments as never,
    strongAuth as never,
    crypto as never,
    archive,
    gateway,
    new ConfigService({ PAYROLL_TAX_GATEWAY_MODE: gatewayMode }) as never,
    productionAuthorization as never,
    outbox as never,
    corrections as never,
  );
  return {
    context,
    boundary,
    service,
    idempotency,
    adjustments,
    crypto,
    corrections,
    archive,
    gateway,
    strongAuth,
    productionAuthorization,
    outbox,
    readCorrection: () => correction,
    writeCorrection: (value: Record<string, unknown> | null) => {
      correction = value;
    },
    readProtectedEnvelope: () => protectedEnvelope,
    writeProtectedEnvelope: (value: Record<string, unknown> | null) => {
      protectedEnvelope = value;
    },
  };
}

async function prepareCorrection(store: ReturnType<typeof assemble>) {
  return store.context.run({ tenant, actor: maker }, () =>
    store.service.prepare('tax-correction-prepare-helper', adjustmentId, 4));
}

async function approveCorrection(
  store: ReturnType<typeof assemble>,
  filingId: string,
  expectedVersion = 2,
  actorContext: ActorContext = approver,
  token: VerifiedAccessToken = approvalToken,
) {
  return store.context.run({ tenant, actor: actorContext }, () =>
    store.service.approve(
      'tax-correction-approve-helper',
      filingId,
      expectedVersion,
      '01J8ZQK7V0A2M4N6P8R0T2W4E1',
      token,
    ));
}

describe('PayrollAdjustmentTaxCorrectionService', () => {
  it('专业算薪模式在读取调整或创建更正记录前稳定短路', async () => {
    const boundary = {
      assertLegacy: vi.fn(() => {
        throw new Error('PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM');
      }),
    };
    const store = assemble(undefined, 'sandbox', boundary);

    await expect(store.context.run({ tenant, actor: maker }, () =>
      store.service.prepare('tax-correction-boundary', adjustmentId, 4)))
      .rejects.toThrow('PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM');
    expect(boundary.assertLegacy).toHaveBeenCalledOnce();
    expect(store.adjustments.getLockedTaxCorrectionSource).not.toHaveBeenCalled();
    expect(store.idempotency.execute).not.toHaveBeenCalled();
  });

  it('完成 WORM 制备、独立强认证审批、税局提交并回写调整终态', async () => {
    const store = assemble();
    const prepared = await store.context.run({ tenant, actor: maker }, () =>
      store.service.prepare('tax-correction-prepare-001', adjustmentId, 4));
    expect(prepared).toMatchObject({
      adjustmentId,
      adjustmentHash,
      period: '2026-07',
      format: 'CN_IIT_WITHHOLDING_CORRECTION_V1',
      status: 'prepared',
      version: 2,
      correctedTaxableEarningsMinor: 1_100_000,
      correctedWithholdingTaxMinor: 13_500,
    });
    expect(store.adjustments.recordTaxCorrectionPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        adjustmentId,
        adjustmentHash,
        filingId: prepared.id,
        expectedVersion: 4,
      }),
      session,
    );
    const archived = store.archive.put.mock.calls[0]?.[0] as {
      readonly bytes: Buffer;
    };
    expect(JSON.parse(archived.bytes.toString('utf8'))).toMatchObject({
      schema: 'CN_IIT_WITHHOLDING_CORRECTION_V1',
      employeeId: 'employee-001',
      adjustmentId,
    });

    const approved = await store.context.run({ tenant, actor: approver }, () =>
      store.service.approve(
        'tax-correction-approve-001',
        prepared.id,
        2,
        '01J8ZQK7V0A2M4N6P8R0T2W4E1',
        approvalToken,
      ));
    expect(approved).toMatchObject({ status: 'approved', version: 3 });
    const submitted = await store.context.run({ tenant, actor: connector }, () =>
      store.service.submit('tax-correction-submit-001', prepared.id, 3));
    expect(submitted).toMatchObject({
      status: 'submitted',
      version: 4,
      taxSubmissionId: 'tax-correction-submission-001',
      taxSubmissionEvidenceId: 'tax-correction-receipt-001',
    });
    expect(store.gateway.submit).toHaveBeenCalledWith(expect.objectContaining({
      filingId: prepared.id,
      employeeCount: 1,
      totalTaxableEarningsMinor: 1_100_000,
      totalWithholdingTaxMinor: 13_500,
    }));
    expect(store.adjustments.recordTaxCorrectionSubmitted).toHaveBeenCalledWith(
      { adjustmentId, adjustmentHash, filingId: prepared.id },
      session,
    );
    const events = JSON.stringify(store.outbox.append.mock.calls);
    expect(events).not.toMatch(/employeeId|taxableEarningsMinor|withholdingTaxMinor/u);
  });

  it('制备人与调整控制链冲突时不创建清单或外部 WORM', async () => {
    const store = assemble([maker.actorId]);
    await expect(store.context.run({ tenant, actor: maker }, () =>
      store.service.prepare(
        'tax-correction-prepare-002',
        adjustmentId,
        4,
      ))).rejects.toMatchObject({
      response: {
        code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_INDEPENDENCE_REQUIRED',
      },
    });
    expect(store.corrections.create).not.toHaveBeenCalled();
    expect(store.archive.put).not.toHaveBeenCalled();
  });

  it('审批人属于原调整控制链时失败关闭', async () => {
    const store = assemble([approver.actorId]);
    const prepared = await store.context.run({ tenant, actor: maker }, () =>
      store.service.prepare('tax-correction-prepare-003', adjustmentId, 4));
    await expect(store.context.run({ tenant, actor: approver }, () =>
      store.service.approve(
        'tax-correction-approve-003',
        prepared.id,
        2,
        '01J8ZQK7V0A2M4N6P8R0T2W4E1',
        approvalToken,
      ))).rejects.toMatchObject({
      response: {
        code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_APPROVAL_STATE_INVALID',
      },
    });
    expect(store.gateway.submit).not.toHaveBeenCalled();
  });

  it.each([
    actor('service', 'service-maker', maker.scopes),
    actor('user', 'missing-prepare', [
      'erp:payroll:adjustment:tax_correction:source:read',
    ]),
    actor('user', 'missing-source', [
      'erp:payroll:adjustment:tax_correction:prepare',
    ]),
  ])('拒绝不满足人工双权限的税务更正制备主体：$actorId', async (principal) => {
    const store = assemble();
    await expect(store.context.run({ tenant, actor: principal }, () =>
      store.service.prepare('denied', adjustmentId, 4)))
      .rejects.toMatchObject({
        response: {
          code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_PREPARER_DENIED',
        },
      });
  });

  it.each([
    ['bad', 4],
    [adjustmentId, 0],
    [adjustmentId, Number.NaN],
  ])('拒绝非法税务更正来源或版本：%s / %s', async (id, version) => {
    const store = assemble();
    await expect(store.context.run({ tenant, actor: maker }, () =>
      store.service.prepare('invalid', id, version))).rejects.toMatchObject({
      response: {
        code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_PREPARE_INPUT_INVALID',
      },
    });
  });

  it('同一制备人可幂等重放已归档清单，其他人员或后续状态不可重新制备', async () => {
    const replay = assemble();
    const prepared = await prepareCorrection(replay);
    await expect(prepareCorrection(replay)).resolves.toMatchObject({
      id: prepared.id,
      status: 'prepared',
    });

    for (const change of [
      { preparedBy: 'other-maker' },
      { status: 'approved' },
    ]) {
      const store = assemble();
      await prepareCorrection(store);
      store.writeCorrection({ ...store.readCorrection(), ...change });
      await expect(prepareCorrection(store)).rejects.toMatchObject({
        response: {
          code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_ALREADY_ADVANCED',
        },
      });
    }
  });

  it.each([
    {
      actor: actor('service', approver.actorId, approver.scopes),
      token: approvalToken,
    },
    {
      actor: approver,
      token: { ...approvalToken, actorType: 'service' as const },
    },
    {
      actor: approver,
      token: { ...approvalToken, tenantId: 'tenant-002' },
    },
    {
      actor: approver,
      token: { ...approvalToken, actorId: 'different-approver' },
    },
    {
      actor: actor('user', approver.actorId, []),
      token: approvalToken,
    },
  ])('拒绝非法税务更正审批身份上下文 %#', async (identity) => {
    const store = assemble();
    const prepared = await prepareCorrection(store);
    await expect(approveCorrection(
      store,
      prepared.id,
      2,
      identity.actor,
      identity.token,
    )).rejects.toMatchObject({
      response: {
        code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_APPROVER_DENIED',
      },
    });
  });

  it.each([
    ['bad', 2, '01J8ZQK7V0A2M4N6P8R0T2W4E1'],
    ['01J8ZQK7V0A2M4N6P8R0T2W4F1', 0, '01J8ZQK7V0A2M4N6P8R0T2W4E1'],
    ['01J8ZQK7V0A2M4N6P8R0T2W4F1', Number.NaN, '01J8ZQK7V0A2M4N6P8R0T2W4E1'],
    ['01J8ZQK7V0A2M4N6P8R0T2W4F1', 2, 'bad'],
  ])('拒绝非法版本命令：%s / %s / %s', async (id, version, evidenceId) => {
    const store = assemble();
    await expect(store.context.run({ tenant, actor: approver }, () =>
      store.service.approve(
        'invalid',
        id,
        version,
        evidenceId,
        approvalToken,
      ))).rejects.toMatchObject({
      response: {
        code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_COMMAND_INVALID',
      },
    });
  });

  it.each([
    { status: 'archiving' },
    { version: 3 },
    { objectRef: null },
    { objectEvidenceId: null },
    { preparedBy: approver.actorId },
  ])('拒绝未归档、版本变化或职责冲突的审批状态 %#', async (change) => {
    const store = assemble();
    const prepared = await prepareCorrection(store);
    store.writeCorrection({ ...store.readCorrection(), ...change });
    await expect(approveCorrection(store, prepared.id)).rejects.toMatchObject({
      response: {
        code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_APPROVAL_STATE_INVALID',
      },
    });
  });

  it('拒绝审批并发写入冲突', async () => {
    const store = assemble();
    const prepared = await prepareCorrection(store);
    store.corrections.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(approveCorrection(store, prepared.id)).rejects.toMatchObject({
      response: {
        code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_APPROVAL_WRITE_CONFLICT',
      },
    });
  });

  it.each([
    actor('user', 'human-submitter', connector.scopes),
    actor('service', 'missing-submit-scope', []),
  ])('拒绝不可信税局提交主体：$actorId', async (principal) => {
    const store = assemble();
    const prepared = await prepareCorrection(store);
    await expect(store.context.run({ tenant, actor: principal }, () =>
      store.service.submit('denied', prepared.id, 2))).rejects.toMatchObject({
      response: {
        code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_SUBMITTER_DENIED',
      },
    });
  });

  it.each([
    { status: 'prepared' },
    { version: 4 },
    { objectRef: null },
    { objectEvidenceId: null },
    { approvedBy: null },
    { strongAuthEvidenceId: null },
  ])('拒绝未完成有效审批的税务提交状态 %#', async (change) => {
    const store = assemble();
    const prepared = await prepareCorrection(store);
    await approveCorrection(store, prepared.id);
    store.writeCorrection({ ...store.readCorrection(), ...change });
    await expect(store.context.run({ tenant, actor: connector }, () =>
      store.service.submit('invalid-state', prepared.id, 3)))
      .rejects.toMatchObject({
        response: {
          code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_SUBMISSION_STATE_INVALID',
        },
      });
  });

  it('提交暂存并发冲突时不调用税局网关', async () => {
    const store = assemble();
    const prepared = await prepareCorrection(store);
    await approveCorrection(store, prepared.id);
    store.corrections.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(store.context.run({ tenant, actor: connector }, () =>
      store.service.submit('stage-conflict', prepared.id, 3)))
      .rejects.toMatchObject({
        response: {
          code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_SUBMISSION_STAGE_CONFLICT',
        },
      });
    expect(store.gateway.submit).not.toHaveBeenCalled();
  });

  it('提交和终态重放保持幂等，不重复执行外部税局提交', async () => {
    const store = assemble();
    const prepared = await prepareCorrection(store);
    await approveCorrection(store, prepared.id);
    const submitted = await store.context.run({ tenant, actor: connector }, () =>
      store.service.submit('submit-once', prepared.id, 3));
    await expect(store.context.run({ tenant, actor: connector }, () =>
      store.service.submit('submit-replay', prepared.id, 3))).resolves.toEqual(submitted);
    expect(store.gateway.submit).toHaveBeenCalledOnce();
  });

  it('归档和税局提交终态在事务重放时保持幂等', async () => {
    const materializeReplay = assemble();
    const executeMaterialize = materializeReplay.idempotency.execute
      .getMockImplementation()!;
    materializeReplay.idempotency.execute.mockImplementation(async (
      operation: string,
      key: string,
      input: unknown,
      handler: (value: ClientSession) => Promise<Record<string, unknown>>,
    ) => {
      if (operation === 'payroll.adjustment_tax_correction.materialize') {
        materializeReplay.writeCorrection({
          ...materializeReplay.readCorrection(),
          objectRef: 'worm/payroll-tax/correction-001',
          objectEvidenceId: 'worm-correction-evidence-001',
          status: 'prepared',
          version: 2,
        });
      }
      return executeMaterialize(operation, key, input, handler);
    });
    await expect(prepareCorrection(materializeReplay)).resolves.toMatchObject({
      status: 'prepared',
      version: 2,
    });

    const finalizeReplay = assemble();
    const prepared = await prepareCorrection(finalizeReplay);
    await approveCorrection(finalizeReplay, prepared.id);
    const executeFinalize = finalizeReplay.idempotency.execute.getMockImplementation()!;
    finalizeReplay.idempotency.execute.mockImplementation(async (
      operation: string,
      key: string,
      input: unknown,
      handler: (value: ClientSession) => Promise<Record<string, unknown>>,
    ) => {
      if (operation === 'payroll.adjustment_tax_correction.finalize_submission') {
        finalizeReplay.writeCorrection({
          ...finalizeReplay.readCorrection(),
          taxSubmissionId: 'tax-correction-submission-001',
          taxSubmissionEvidenceId: 'tax-correction-receipt-001',
          status: 'submitted',
          version: 4,
        });
      }
      return executeFinalize(operation, key, input, handler);
    });
    await expect(finalizeReplay.context.run({ tenant, actor: connector }, () =>
      finalizeReplay.service.submit('finalize-replay', prepared.id, 3)))
      .resolves.toMatchObject({ status: 'submitted', version: 4 });
    expect(finalizeReplay.adjustments.recordTaxCorrectionSubmitted)
      .not.toHaveBeenCalled();
  });

  it('提交暂存后状态被外部改变时失败关闭', async () => {
    const store = assemble();
    const prepared = await prepareCorrection(store);
    await approveCorrection(store, prepared.id);
    const originalExecute = store.idempotency.execute.getMockImplementation()!;
    store.idempotency.execute.mockImplementationOnce(async (
      operation: string,
      key: string,
      input: unknown,
      handler: (value: ClientSession) => Promise<Record<string, unknown>>,
    ) => {
      const value = await originalExecute(operation, key, input, handler);
      store.writeCorrection({ ...store.readCorrection(), status: 'approved' });
      return value;
    });
    await expect(store.context.run({ tenant, actor: connector }, () =>
      store.service.submit('stage-invalid', prepared.id, 3)))
      .rejects.toMatchObject({
        response: {
          code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_SUBMISSION_STAGE_INVALID',
        },
      });
  });

  it('提交终态写入冲突时不回写工资调整终态', async () => {
    const store = assemble();
    const prepared = await prepareCorrection(store);
    await approveCorrection(store, prepared.id);
    store.corrections.updateOne
      .mockImplementationOnce((
        _filter: unknown,
        update: { readonly $set: Readonly<Record<string, unknown>> },
      ) => {
        store.writeCorrection({
          ...store.readCorrection(),
          ...update.$set,
        });
        return Promise.resolve({ modifiedCount: 1 });
      })
      .mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(store.context.run({ tenant, actor: connector }, () =>
      store.service.submit('write-conflict', prepared.id, 3)))
      .rejects.toMatchObject({
        response: {
          code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_SUBMISSION_WRITE_CONFLICT',
        },
      });
    expect(store.adjustments.recordTaxCorrectionSubmitted).not.toHaveBeenCalled();
  });

  it('生产税局网关提交前申请绑定主体摘要的执行授权', async () => {
    const store = assemble(undefined, 'production');
    const prepared = await prepareCorrection(store);
    await approveCorrection(store, prepared.id);
    await store.context.run({ tenant, actor: connector }, () =>
      store.service.submit('production-submit', prepared.id, 3));
    const [authorizationSubject] =
      store.productionAuthorization.authorize.mock.calls[0] ?? [];
    expect(authorizationSubject).toMatchObject({
      action: 'payroll-tax-submission',
      tenantId: tenant.tenantId,
      resourceId: prepared.id,
      expectedVersion: 3,
    });
    expect(authorizationSubject?.subjectHash)
      .toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('记录生产授权证据，并对已提交终态跳过重复生产授权', async () => {
    const store = assemble(undefined, 'production');
    const prepared = await prepareCorrection(store);
    await approveCorrection(store, prepared.id);
    store.gateway.submit.mockResolvedValueOnce({
      submissionId: 'tax-correction-submission-001',
      evidenceId: 'tax-correction-receipt-001',
      accepted: true,
      productionAuthorizationEvidenceId: 'production-evidence-001',
    });
    await store.context.run({ tenant, actor: connector }, () =>
      store.service.submit('production-evidence', prepared.id, 3));
    expect(JSON.stringify(store.outbox.append.mock.calls))
      .toContain('production-evidence-001');

    const authorizeCalls = store.productionAuthorization.authorize.mock.calls.length;
    await expect(store.context.run({ tenant, actor: connector }, () =>
      store.service.submit('production-replay', prepared.id, 3)))
      .resolves.toMatchObject({ status: 'submitted', version: 4 });
    expect(store.productionAuthorization.authorize).toHaveBeenCalledTimes(authorizeCalls);
  });

  it('生产提交授权拒绝状态、版本或 WORM 对象不匹配', async () => {
    for (const change of [
      { status: 'prepared' },
      { version: 4 },
      { objectRef: null },
    ]) {
      const store = assemble(undefined, 'production');
      const prepared = await prepareCorrection(store);
      await approveCorrection(store, prepared.id);
      store.writeCorrection({ ...store.readCorrection(), ...change });
      await expect(store.context.run({ tenant, actor: connector }, () =>
        store.service.submit('production-invalid', prepared.id, 3)))
        .rejects.toMatchObject({
          response: {
            code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_AUTHORIZATION_SUBJECT_INVALID',
          },
        });
    }
  });

  it('读取及控制面摘要执行权限、标识和存在性校验', async () => {
    const store = assemble();
    const prepared = await prepareCorrection(store);
    const reader = actor('user', 'reader', [
      'erp:payroll:adjustment:tax_correction:read',
    ]);
    await expect(store.context.run({ tenant, actor: reader }, () =>
      store.service.get(prepared.id))).resolves.toMatchObject({
      id: prepared.id,
      adjustmentId,
    });
    await expect(store.context.run({ tenant, actor: reader }, () =>
      store.service.getControlStatus(prepared.id))).resolves.toEqual({
      id: prepared.id,
      adjustmentId,
      period: '2026-07',
      format: 'CN_IIT_WITHHOLDING_CORRECTION_V1',
      contentHash: prepared.contentHash,
      objectEvidenceId: 'worm-correction-evidence-001',
      taxSubmissionEvidenceId: null,
      status: 'prepared',
      version: 2,
    });
    await expect(store.context.run({
      tenant,
      actor: actor('user', 'reader', []),
    }, () => store.service.get(prepared.id))).rejects.toMatchObject({
      response: {
        code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_SCOPE_REQUIRED',
      },
    });
    await expect(store.context.run({ tenant, actor: reader }, () =>
      store.service.get('bad'))).rejects.toMatchObject({
      response: {
        code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_ID_INVALID',
      },
    });
    store.writeCorrection(null);
    await expect(store.context.run({ tenant, actor: reader }, () =>
      store.service.get(prepared.id))).rejects.toMatchObject({
      response: {
        code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_NOT_FOUND',
      },
    });
  });

  it('归档正文摘要异常与受保护结构非法时失败关闭', async () => {
    const contentMismatch = assemble();
    const originalProtect = contentMismatch.crypto.protect.getMockImplementation()!;
    contentMismatch.crypto.protect.mockImplementationOnce((aad, value) => {
      const result = originalProtect(aad, value);
      const envelope = value as { readonly content: string };
      const manifest = JSON.parse(envelope.content) as Record<string, unknown>;
      contentMismatch.writeProtectedEnvelope({
        ...value,
        content: JSON.stringify({ ...manifest, employeeId: 'employee-002' }),
      });
      return result;
    });
    await expect(prepareCorrection(contentMismatch)).rejects.toMatchObject({
      response: {
        code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_INTEGRITY_FAILED',
      },
    });

    const invalid = assemble();
    await prepareCorrection(invalid);
    invalid.writeProtectedEnvelope({});
    await expect(invalid.context.run({
      tenant,
      actor: actor('user', 'reader', [
        'erp:payroll:adjustment:tax_correction:read',
      ]),
    }, () => invalid.service.get(
      (invalid.readCorrection() as { id: string }).id,
    ))).rejects.toMatchObject({
      response: {
        code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_PROTECTED_DATA_INVALID',
      },
    });
  });

  it.each([
    { contentHash: 'x'.repeat(43) },
    { correctionFilingId: '01J8ZQK7V0A2M4N6P8R0T2W4F9' },
    { tenantId: 'tenant-002' },
    { adjustmentId: '01J8ZQK7V0A2M4N6P8R0T2W4J9' },
    { adjustmentHash: 'x'.repeat(43) },
    { period: '2026-08' },
    { corrected: { taxableEarningsMinor: 1 } },
    { corrected: { withholdingTaxMinor: 1 } },
    { delta: { taxableEarningsMinor: 1 } },
    { delta: { withholdingTaxMinor: 1 } },
  ])('拒绝税务更正控制字段、密文或正文摘要不一致 %#', async (change) => {
    const store = assemble();
    const prepared = await prepareCorrection(store);
    const envelope = store.readProtectedEnvelope()!;
    const manifest = JSON.parse(envelope.content as string) as Record<string, unknown>;
    if ('contentHash' in change) {
      store.writeCorrection({ ...store.readCorrection(), contentHash: change.contentHash });
    } else {
      const nested = 'corrected' in change || 'delta' in change;
      const key = 'corrected' in change ? 'corrected' : 'delta';
      const next = nested
        ? {
          ...manifest,
          [key]: {
            ...(manifest[key] as Record<string, unknown>),
            ...change[key],
          },
        }
        : { ...manifest, ...change };
      const content = JSON.stringify(next);
      store.writeProtectedEnvelope({ ...envelope, content });
      store.writeCorrection({ ...store.readCorrection(), contentHash:
        createHash('sha256').update(content, 'utf8').digest('base64url') });
    }
    await expect(store.context.run({
      tenant,
      actor: actor('user', 'reader', [
        'erp:payroll:adjustment:tax_correction:read',
      ]),
    }, () => store.service.get(prepared.id))).rejects.toMatchObject({
      response: {
        code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_INTEGRITY_FAILED',
      },
    });
  });

  it('把唯一键冲突映射为稳定业务冲突', async () => {
    const store = assemble();
    store.idempotency.execute.mockRejectedValueOnce({ code: 11_000 });
    await expect(prepareCorrection(store)).rejects.toMatchObject({
      response: {
        code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_ALREADY_EXISTS',
      },
    });
  });
});
