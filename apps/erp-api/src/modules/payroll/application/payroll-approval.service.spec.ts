import type { ActorContext } from '@gaoq/shared-types';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { VerifiedAccessToken } from '../../identity/auth.types.js';
import type { PayrollPeriodRecord } from '../persistence/payroll.schemas.js';
import { PayrollApprovalService } from './payroll-approval.service.js';

const PERIOD_ID = '01J8ZQK7V0A2M4N6P8R0T2W4P1';
const RUN_ID = '01J8ZQK7V0A2M4N6P8R0T2W4R1';
const APPROVAL_HISTORY_ID = '01J8ZQK7V0A2M4N6P8R0T2W4H1';
const APPROVAL_CONTROL_ID = '01J8ZQK7V0A2M4N6P8R0T2W4A1';
const LOCK_CONTROL_ID = '01J8ZQK7V0A2M4N6P8R0T2W4K1';
const APPROVAL_INSTANCE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4I1';
const WEBAUTHN_EVIDENCE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4E1';
const EVIDENCE_REF =
  'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/control-001';
const session = {} as ClientSession;

function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    actorId: 'migration-agent-001', actorType: 'service', tenantId: 'tenant-001',
    roleCodes: ['migration'],
    scopes: ['erp:migration:execute', 'erp:payroll:migration:write'],
    departmentIds: [], traceId: 'trace-migration-001',
    ...overrides,
  };
}

function period(overrides: Partial<PayrollPeriodRecord> = {}): PayrollPeriodRecord {
  return {
    id: PERIOD_ID, tenantId: 'tenant-001', period: '2026-06', currency: 'CNY',
    status: 'review', preparedBy: 'actor-preparer-001', activeRunId: RUN_ID,
    inputSnapshotHash: 'i'.repeat(43), resultHash: 'r'.repeat(43), employeeCount: 1,
    totalGrossMinor: 1_000_000, totalTaxMinor: 20_000, totalNetMinor: 980_000,
    approvalReferenceType: null, approvalInstanceId: null, approvedBy: null,
    approvalEvidenceId: null, lockedBy: null, strongAuthEvidenceId: null,
    strongAuthReferenceType: null, disbursementBatchId: null,
    disbursementPreparedBy: null, disbursementExportEvidenceId: null,
    reconciliationEvidenceId: null, reconciledBy: null, version: 3,
    migrationEvidenceRef: EVIDENCE_REF, migrationEvidenceChecksum: 'p'.repeat(43),
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-02T00:00:00.000Z'),
    ...overrides,
  };
}

function query<T>(value: T) {
  const result = {
    session: vi.fn(() => result),
    lean: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(value) })),
  };
  return result;
}

function assemble(options: {
  readonly current?: PayrollPeriodRecord | null;
  readonly resolvedActor?: string | null;
  readonly approvalEvidence?: Readonly<Record<string, unknown>> | null;
  readonly lockEvidence?: Readonly<Record<string, unknown>> | null;
  readonly approvalReference?: Readonly<Record<string, unknown>>;
  readonly createdInstance?: Readonly<Record<string, unknown>>;
  readonly submittedInstance?: Readonly<Record<string, unknown>>;
  readonly decision?: Readonly<Record<string, unknown>>;
  readonly strongAuthEvidence?: Readonly<Record<string, unknown>>;
  readonly modifiedCount?: number;
  readonly updateError?: unknown;
  readonly idempotencyError?: unknown;
} = {}) {
  const context = new TenantContextService();
  const idempotency = { execute: vi.fn(async (
    _operation: string,
    _key: string,
    _request: unknown,
    handler: (value: ClientSession) => Promise<Record<string, unknown>>,
  ) => {
    if (options.idempotencyError !== undefined) throw asRejectionError(options.idempotencyError);
    return handler(session);
  }) };
  const profiles = {
    findActorIdByEmployee: vi.fn().mockResolvedValue(
      options.resolvedActor === undefined ? 'actor-approver-001' : options.resolvedActor,
    ),
  };
  const approvals = {
    verifyPayrollMigrationReference: vi.fn().mockResolvedValue(
      options.approvalReference ?? {
        id: APPROVAL_HISTORY_ID, templateCode: 'payroll_period_approval',
        completedAt: '2026-06-03T00:00:00.000Z', evidenceChecksum: 'a'.repeat(43),
      },
    ),
    createInstance: vi.fn().mockResolvedValue(options.createdInstance ?? {
      instance: { id: APPROVAL_INSTANCE_ID, version: 1 },
    }),
    submitInstance: vi.fn().mockResolvedValue(options.submittedInstance ?? {
      instance: { id: APPROVAL_INSTANCE_ID, version: 2, status: 'running' },
    }),
    getPayrollPeriodDecision: vi.fn().mockResolvedValue(options.decision ?? {
      id: APPROVAL_INSTANCE_ID,
      periodId: PERIOD_ID,
      runId: RUN_ID,
      inputSnapshotHash: 'i'.repeat(43),
      resultHash: 'r'.repeat(43),
      outcome: 'approved',
      decidedBy: 'actor-approver-001',
      completedAt: '2026-06-03T00:00:00.000Z',
      formDataHash: 'f'.repeat(43),
    }),
  };
  const update = options.updateError === undefined
    ? vi.fn().mockResolvedValue({ modifiedCount: options.modifiedCount ?? 1 })
    : vi.fn().mockRejectedValue(options.updateError);
  const periods = {
    findOne: vi.fn().mockReturnValue(query(
      options.current === undefined ? period() : options.current,
    )),
    updateOne: update,
  };
  const approvalEvidence = {
    create: vi.fn().mockResolvedValue([]),
    findOne: vi.fn().mockReturnValue(query(options.approvalEvidence ?? null)),
  };
  const lockEvidence = {
    create: vi.fn().mockResolvedValue([]),
    findOne: vi.fn().mockReturnValue(query(options.lockEvidence ?? null)),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const strongAuth = {
    requireVerifiedEvidence: vi.fn().mockResolvedValue(options.strongAuthEvidence ?? {
      evidenceId: WEBAUTHN_EVIDENCE_ID,
      method: 'webauthn_uv',
    }),
  };
  const service = new PayrollApprovalService(
    idempotency as never, context, profiles as never, approvals as never, strongAuth as never,
    outbox as never, periods as never, approvalEvidence as never, lockEvidence as never,
  );
  return {
    context, service, idempotency, periods, profiles, approvals, approvalEvidence, lockEvidence,
    strongAuth, outbox,
  };
}

function approvalInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    targetId: null, periodId: PERIOD_ID, expectedPeriodVersion: 3,
    approvalHistoryId: APPROVAL_HISTORY_ID,
    approvalEvidenceChecksum: 'a'.repeat(43),
    approvedByEmployeeId: 'employee-approver-001',
    migrationEvidenceRef: EVIDENCE_REF, evidenceChecksum: 'e'.repeat(43),
    ...overrides,
  };
}

function lockInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    targetId: null, periodId: PERIOD_ID, expectedPeriodVersion: 5,
    approvalControlEvidenceId: APPROVAL_CONTROL_ID,
    lockedByEmployeeId: 'employee-locker-001',
    lockedAt: '2026-06-04T00:00:00.000Z', strongAuthMethod: 'webauthn_uv',
    migrationEvidenceRef: EVIDENCE_REF, evidenceChecksum: 'l'.repeat(43),
    ...overrides,
  };
}

function approvalControl(overrides: Readonly<Record<string, unknown>> = {}) {
  const approvedAt = new Date('2026-06-03T00:00:00.000Z');
  return {
    id: APPROVAL_CONTROL_ID, tenantId: 'tenant-001', periodId: PERIOD_ID,
    approvalHistoryId: APPROVAL_HISTORY_ID, approvalEvidenceChecksum: 'a'.repeat(43),
    approvedBy: 'actor-approver-001', approvedAt, periodVersion: 5,
    migrationEvidenceRef: EVIDENCE_REF, migrationEvidenceChecksum: 'e'.repeat(43),
    createdAt: approvedAt, updatedAt: approvedAt,
    ...overrides,
  };
}

function userToken(overrides: Partial<VerifiedAccessToken> = {}): VerifiedAccessToken {
  return {
    issuer: 'https://identity.invalid', subject: 'actor-locker-001',
    audience: ['gaoq-erp'], resource: ['gaoq-erp-api'],
    tenantId: 'tenant-001', actorId: 'actor-locker-001', actorType: 'user',
    clientId: 'erp-web', roleCodes: ['payroll'], scopes: ['erp:payroll:period:lock'],
    departmentIds: [], sessionId: 'session-001',
    expiresAt: Math.floor(Date.now() / 1_000) + 300,
    ...overrides,
  };
}

function runAs<T>(
  context: TenantContextService,
  currentActor: ActorContext,
  operation: () => Promise<T>,
): Promise<T> {
  return context.run({
    tenant: { tenantId: 'tenant-001', source: 'service_identity' },
    actor: currentActor,
  }, operation);
}

function asRejectionError(value: unknown): Error {
  if (value instanceof Error) return value;
  const error = new Error('测试注入异常');
  if (typeof value === 'object' && value !== null) Object.assign(error, value);
  return error;
}

async function rejectionCode(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    if (!(error instanceof HttpException)) throw asRejectionError(error);
    const response = error.getResponse();
    if (typeof response !== 'object' || response === null) return undefined;
    return (response as Readonly<Record<string, unknown>>).code;
  }
  throw new Error('预期操作失败但实际成功');
}

describe('PayrollApprovalService 迁移控制', () => {
  it('用专用批准历史恢复批准状态并只发迁移事件', async () => {
    const store = assemble({ current: period(), resolvedActor: 'actor-approver-001' });
    const result = await store.context.run({
      tenant: { tenantId: 'tenant-001', source: 'service_identity' }, actor: actor(),
    }, () => store.service.importApprovalFromMigration('migration-approval-001', {
      targetId: null, periodId: PERIOD_ID, expectedPeriodVersion: 3,
      approvalHistoryId: APPROVAL_HISTORY_ID,
      approvalEvidenceChecksum: 'a'.repeat(43),
      approvedByEmployeeId: 'employee-approver-001',
      migrationEvidenceRef: EVIDENCE_REF, evidenceChecksum: 'e'.repeat(43),
    }));

    expect(result).toMatchObject({ periodId: PERIOD_ID, periodVersion: 5, status: 'approved' });
    expect(store.approvals.verifyPayrollMigrationReference).toHaveBeenCalledWith(
      APPROVAL_HISTORY_ID, 'payroll_period_approval', session,
    );
    expect(store.approvalEvidence.create).toHaveBeenCalledWith([
      expect.objectContaining({
        periodId: PERIOD_ID, approvalHistoryId: APPROVAL_HISTORY_ID,
        approvedBy: 'actor-approver-001', periodVersion: 5,
      }),
    ], { session });
    const update = store.periods.updateOne.mock.calls[0] as unknown as [
      Record<string, unknown>, { $set: Record<string, unknown> }, Record<string, unknown>,
    ];
    expect(update[0]).toMatchObject({ version: 3, status: 'review' });
    expect(update[1].$set).toMatchObject({
      status: 'approved', version: 5, approvalReferenceType: 'legacy_history',
      approvalInstanceId: APPROVAL_HISTORY_ID,
    });
    expect(update[2]).toEqual({ session, runValidators: true, timestamps: false });
    expect(store.outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'payroll.period_approval.migrated', version: 5,
    }), session);
  });

  it('拒绝制单人冒充历史审批人', async () => {
    const store = assemble({ current: period(), resolvedActor: 'actor-preparer-001' });
    await expect(store.context.run({
      tenant: { tenantId: 'tenant-001', source: 'service_identity' }, actor: actor(),
    }, () => store.service.importApprovalFromMigration('migration-approval-sod-001', {
      targetId: null, periodId: PERIOD_ID, expectedPeriodVersion: 3,
      approvalHistoryId: APPROVAL_HISTORY_ID,
      approvalEvidenceChecksum: 'a'.repeat(43),
      approvedByEmployeeId: 'employee-preparer-001',
      migrationEvidenceRef: EVIDENCE_REF, evidenceChecksum: 'e'.repeat(43),
    }))).rejects.toBeInstanceOf(ForbiddenException);
    expect(store.approvalEvidence.create).not.toHaveBeenCalled();
    expect(store.periods.updateOne).not.toHaveBeenCalled();
  });

  it('锁定前校验独立审批控制并保存迁移强认证引用', async () => {
    const approvedAt = new Date('2026-06-03T00:00:00.000Z');
    const approvalControl = {
      id: APPROVAL_CONTROL_ID, tenantId: 'tenant-001', periodId: PERIOD_ID,
      approvalHistoryId: APPROVAL_HISTORY_ID, approvalEvidenceChecksum: 'a'.repeat(43),
      approvedBy: 'actor-approver-001', approvedAt, periodVersion: 5,
      migrationEvidenceRef: EVIDENCE_REF, migrationEvidenceChecksum: 'e'.repeat(43),
      createdAt: approvedAt, updatedAt: approvedAt,
    };
    const store = assemble({
      current: period({
        status: 'approved', version: 5, approvalReferenceType: 'legacy_history',
        approvalInstanceId: APPROVAL_HISTORY_ID, approvedBy: 'actor-approver-001',
        approvalEvidenceId: APPROVAL_HISTORY_ID,
        updatedAt: approvedAt,
      }),
      resolvedActor: 'actor-locker-001', approvalEvidence: approvalControl,
    });
    const result = await store.context.run({
      tenant: { tenantId: 'tenant-001', source: 'service_identity' }, actor: actor(),
    }, () => store.service.importLockFromMigration('migration-lock-001', {
      targetId: null, periodId: PERIOD_ID, expectedPeriodVersion: 5,
      approvalControlEvidenceId: APPROVAL_CONTROL_ID,
      lockedByEmployeeId: 'employee-locker-001',
      lockedAt: '2026-06-04T00:00:00.000Z', strongAuthMethod: 'webauthn_uv',
      migrationEvidenceRef: EVIDENCE_REF, evidenceChecksum: 'l'.repeat(43),
    }));

    expect(result).toMatchObject({ periodId: PERIOD_ID, periodVersion: 6, status: 'locked' });
    expect(store.lockEvidence.create).toHaveBeenCalledWith([
      expect.objectContaining({
        approvalControlEvidenceId: APPROVAL_CONTROL_ID, lockedBy: 'actor-locker-001',
        strongAuthMethod: 'webauthn_uv', operationId: PERIOD_ID, periodVersion: 6,
      }),
    ], { session });
    const evidenceCall = store.lockEvidence.create.mock.calls[0] as unknown as [
      readonly { readonly id: string }[], Record<string, unknown>,
    ];
    const evidence = evidenceCall[0][0];
    const update = store.periods.updateOne.mock.calls[0] as unknown as [
      Record<string, unknown>, { $set: Record<string, unknown> }, Record<string, unknown>,
    ];
    expect(update[0]).toMatchObject({ version: 5, status: 'approved' });
    expect(update[1].$set).toMatchObject({
      status: 'locked', version: 6, lockedBy: 'actor-locker-001',
      strongAuthEvidenceId: evidence?.id,
      strongAuthReferenceType: 'migration_lock_evidence',
    });
    expect(update[2]).toEqual({ session, runValidators: true, timestamps: false });
    expect(store.outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'payroll.period_lock.migrated', version: 6,
    }), session);
  });
});

describe('PayrollApprovalService 在线审批控制', () => {
  const requestActor = actor({
    actorId: 'actor-preparer-001',
    actorType: 'user',
    scopes: ['erp:payroll:approval:request', 'erp:approval:instance:submit'],
  });
  const syncActor = actor({
    actorId: 'approval-sync-001',
    actorType: 'service',
    scopes: ['erp:payroll:approval:sync'],
  });
  const lockActor = actor({
    actorId: 'actor-locker-001',
    actorType: 'user',
    scopes: ['erp:payroll:period:lock'],
  });

  it('人员制单人创建并提交审批后以稳定子幂等键绑定工资周期', async () => {
    const store = assemble({
      current: period({ preparedBy: requestActor.actorId }),
    });

    const result = await runAs(store.context, requestActor, () =>
      store.service.requestApproval('payroll-request-001', PERIOD_ID, 3));

    expect(result).toMatchObject({
      id: PERIOD_ID,
      status: 'pending_approval',
      version: 4,
    });
    expect(store.approvals.createInstance).toHaveBeenCalledWith(
      expect.stringMatching(/^payroll:[A-Za-z0-9_-]{43}$/u),
      {
        templateCode: 'payroll_period_approval',
        title: '工资审批：2026-06',
        formData: {
          period_id: PERIOD_ID,
          run_id: RUN_ID,
          input_snapshot_hash: 'i'.repeat(43),
          result_hash: 'r'.repeat(43),
        },
      },
    );
    expect(store.approvals.submitInstance).toHaveBeenCalledWith(
      APPROVAL_INSTANCE_ID,
      1,
      expect.stringMatching(/^payroll:[A-Za-z0-9_-]{43}$/u),
    );
    expect(store.idempotency.execute).toHaveBeenCalledWith(
      'payroll.approval.request',
      expect.stringMatching(/^payroll:[A-Za-z0-9_-]{43}$/u),
      {
        periodId: PERIOD_ID,
        expectedVersion: 3,
        approvalInstanceId: APPROVAL_INSTANCE_ID,
      },
      expect.any(Function),
    );
    expect(store.outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'payroll.approval.requested',
      aggregateId: PERIOD_ID,
      version: 4,
    }), session);
  });

  it('已同步批准的审批实例也允许绑定', async () => {
    const store = assemble({
      current: period({ preparedBy: requestActor.actorId }),
      submittedInstance: {
        instance: { id: APPROVAL_INSTANCE_ID, version: 2, status: 'approved' },
      },
    });

    await expect(runAs(store.context, requestActor, () =>
      store.service.requestApproval('payroll-request-approved', PERIOD_ID, 3)))
      .resolves.toMatchObject({ status: 'pending_approval' });
  });

  it('送审逐层拒绝缺失 Scope、非人员身份和非制单人', async () => {
    for (const currentActor of [
      actor({ actorId: 'actor-preparer-001', actorType: 'user', scopes: [] }),
      actor({
        actorId: 'actor-preparer-001',
        actorType: 'user',
        scopes: ['erp:payroll:approval:request'],
      }),
      actor({
        actorId: 'payroll-service-001',
        actorType: 'service',
        scopes: ['erp:payroll:approval:request', 'erp:approval:instance:submit'],
      }),
      actor({
        actorId: 'actor-other-001',
        actorType: 'user',
        scopes: ['erp:payroll:approval:request', 'erp:approval:instance:submit'],
      }),
    ]) {
      const store = assemble();
      await expect(runAs(store.context, currentActor, () =>
        store.service.requestApproval('payroll-request-denied', PERIOD_ID, 3)))
        .rejects.toBeInstanceOf(ForbiddenException);
      expect(store.approvals.createInstance).not.toHaveBeenCalled();
    }
  });

  it('送审拒绝版本、状态、运行变化以及审批未进入可处理状态', async () => {
    for (const current of [
      period({ preparedBy: requestActor.actorId, version: 4 }),
      period({ preparedBy: requestActor.actorId, status: 'collecting' }),
      period({ preparedBy: requestActor.actorId, activeRunId: null }),
    ]) {
      const store = assemble({ current });
      await expect(runAs(store.context, requestActor, () =>
        store.service.requestApproval('payroll-request-stale', PERIOD_ID, 3)))
        .rejects.toBeInstanceOf(ConflictException);
      expect(store.approvals.createInstance).not.toHaveBeenCalled();
    }

    const invalidSubmission = assemble({
      current: period({ preparedBy: requestActor.actorId }),
      submittedInstance: {
        instance: { id: APPROVAL_INSTANCE_ID, version: 2, status: 'draft' },
      },
    });
    await expect(rejectionCode(() =>
      runAs(invalidSubmission.context, requestActor, () =>
        invalidSubmission.service.requestApproval(
          'payroll-request-invalid',
          PERIOD_ID,
          3,
        )))).resolves.toBe('PAYROLL_APPROVAL_SUBMIT_INVALID');
    expect(invalidSubmission.periods.updateOne).not.toHaveBeenCalled();
  });

  it('受信服务按工资运行摘要应用批准并发布终态事件', async () => {
    const store = assemble({
      current: period({
        status: 'pending_approval',
        version: 4,
        approvalReferenceType: 'approval_instance',
        approvalInstanceId: APPROVAL_INSTANCE_ID,
      }),
    });

    const result = await runAs(store.context, syncActor, () =>
      store.service.applyApproval(
        'payroll-apply-001',
        PERIOD_ID,
        4,
        APPROVAL_INSTANCE_ID,
      ));

    expect(result).toMatchObject({
      id: PERIOD_ID,
      status: 'approved',
      version: 5,
    });
    expect(store.idempotency.execute).toHaveBeenCalledWith(
      'payroll.approval.apply',
      'payroll-apply-001',
      {
        periodId: PERIOD_ID,
        expectedVersion: 4,
        approvalInstanceId: APPROVAL_INSTANCE_ID,
        decision: 'f'.repeat(43),
      },
      expect.any(Function),
    );
    const event = store.outbox.append.mock.calls[0]?.[0] as unknown as {
      readonly type: string;
      readonly data: Readonly<Record<string, unknown>>;
    };
    expect(event).toMatchObject({
      type: 'payroll.approval.applied',
      data: { outcome: 'approved', status: 'approved' },
    });
  });

  it('系统任务可同步拒绝终态并清除审批引用', async () => {
    const store = assemble({
      current: period({
        status: 'pending_approval',
        version: 4,
        approvalReferenceType: 'approval_instance',
        approvalInstanceId: APPROVAL_INSTANCE_ID,
      }),
      decision: {
        id: APPROVAL_INSTANCE_ID,
        periodId: PERIOD_ID,
        runId: RUN_ID,
        inputSnapshotHash: 'i'.repeat(43),
        resultHash: 'r'.repeat(43),
        outcome: 'rejected',
        decidedBy: 'actor-approver-001',
        completedAt: '2026-06-03T00:00:00.000Z',
        formDataHash: 'x'.repeat(43),
      },
    });
    const systemJob = actor({
      actorId: 'approval-sync-job',
      actorType: 'system_job',
      scopes: ['erp:payroll:approval:sync'],
    });

    await expect(runAs(store.context, systemJob, () =>
      store.service.applyApproval('payroll-reject-001', PERIOD_ID, 4, APPROVAL_INSTANCE_ID)))
      .resolves.toMatchObject({
        status: 'review',
        version: 5,
      });
  });

  it('审批同步拒绝人员调用与缺失 Scope', async () => {
    for (const currentActor of [
      actor({ actorType: 'service', scopes: [] }),
      actor({
        actorId: 'actor-user-001',
        actorType: 'user',
        scopes: ['erp:payroll:approval:sync'],
      }),
    ]) {
      const store = assemble();
      await expect(runAs(store.context, currentActor, () =>
        store.service.applyApproval(
          'payroll-sync-denied',
          PERIOD_ID,
          4,
          APPROVAL_INSTANCE_ID,
        ))).rejects.toBeInstanceOf(ForbiddenException);
      expect(store.approvals.getPayrollPeriodDecision).not.toHaveBeenCalled();
    }
  });

  it('审批同步对每一项工资运行绑定漂移均失败关闭', async () => {
    const pending = period({
      status: 'pending_approval',
      version: 4,
      approvalReferenceType: 'approval_instance',
      approvalInstanceId: APPROVAL_INSTANCE_ID,
    });
    for (const options of [
      {
        current: period({
          ...pending,
          activeRunId: null,
        }),
        decision: {},
      },
      { current: pending, decision: { periodId: '01J8ZQK7V0A2M4N6P8R0T2W4P2' } },
      { current: pending, decision: { runId: '01J8ZQK7V0A2M4N6P8R0T2W4R2' } },
      { current: pending, decision: { inputSnapshotHash: 'x'.repeat(43) } },
      { current: pending, decision: { resultHash: 'x'.repeat(43) } },
    ]) {
      const baselineDecision = {
        id: APPROVAL_INSTANCE_ID,
        periodId: PERIOD_ID,
        runId: RUN_ID,
        inputSnapshotHash: 'i'.repeat(43),
        resultHash: 'r'.repeat(43),
        outcome: 'approved',
        decidedBy: 'actor-approver-001',
        completedAt: '2026-06-03T00:00:00.000Z',
        formDataHash: 'f'.repeat(43),
      };
      const store = assemble({
        current: options.current,
        decision: { ...baselineDecision, ...options.decision },
      });
      await expect(rejectionCode(() => runAs(store.context, syncActor, () =>
        store.service.applyApproval(
          'payroll-binding-mismatch',
          PERIOD_ID,
          4,
          APPROVAL_INSTANCE_ID,
        )))).resolves.toBe('PAYROLL_APPROVAL_BINDING_MISMATCH');
      expect(store.periods.updateOne).not.toHaveBeenCalled();
    }
  });

  it('锁定只接受同租户同人员令牌与绑定操作的 WebAuthn UV 证据', async () => {
    const store = assemble({
      current: period({
        status: 'approved',
        version: 5,
        approvalReferenceType: 'approval_instance',
        approvalInstanceId: APPROVAL_INSTANCE_ID,
        approvedBy: 'actor-approver-001',
        approvalEvidenceId: APPROVAL_INSTANCE_ID,
      }),
    });

    const result = await runAs(store.context, lockActor, () =>
      store.service.lockPeriod(
        'payroll-lock-001',
        PERIOD_ID,
        5,
        WEBAUTHN_EVIDENCE_ID,
        userToken(),
      ));

    expect(store.strongAuth.requireVerifiedEvidence).toHaveBeenCalledWith({
      evidenceId: WEBAUTHN_EVIDENCE_ID,
      tenantId: 'tenant-001',
      actorId: 'actor-locker-001',
      sessionId: 'session-001',
      operationId: PERIOD_ID,
    });
    expect(result).toMatchObject({
      status: 'locked',
      version: 6,
    });
    const event = store.outbox.append.mock.calls[0]?.[0] as unknown as {
      readonly type: string;
      readonly data: Readonly<Record<string, unknown>>;
    };
    expect(event).toMatchObject({
      type: 'payroll.period.locked',
      data: { strongAuthMethod: 'webauthn_uv' },
    });
  });

  it('锁定逐项拒绝非人员、令牌类型、跨租户和身份错绑', async () => {
    const cases: readonly [ActorContext, VerifiedAccessToken][] = [
      [
        actor({
          actorId: 'actor-locker-001',
          actorType: 'service',
          scopes: ['erp:payroll:period:lock'],
        }),
        userToken(),
      ],
      [lockActor, userToken({ actorType: 'service' })],
      [lockActor, userToken({ tenantId: 'tenant-002' })],
      [lockActor, userToken({ actorId: 'actor-other-001' })],
    ];
    for (const [currentActor, token] of cases) {
      const store = assemble();
      await expect(rejectionCode(() => runAs(store.context, currentActor, () =>
        store.service.lockPeriod(
          'payroll-lock-identity-denied',
          PERIOD_ID,
          5,
          WEBAUTHN_EVIDENCE_ID,
          token,
        )))).resolves.toBe('PAYROLL_LOCK_IDENTITY_INVALID');
      expect(store.strongAuth.requireVerifiedEvidence).not.toHaveBeenCalled();
    }
  });

  it('锁定拒绝缺失 Scope、非法周期标识和非法证据标识', async () => {
    const missingScope = assemble();
    await expect(runAs(missingScope.context, actor({
      actorId: 'actor-locker-001',
      actorType: 'user',
      scopes: [],
    }), () => missingScope.service.lockPeriod(
      'payroll-lock-scope',
      PERIOD_ID,
      5,
      WEBAUTHN_EVIDENCE_ID,
      userToken(),
    ))).rejects.toBeInstanceOf(ForbiddenException);

    for (const [periodId, evidenceId] of [
      ['bad-period', WEBAUTHN_EVIDENCE_ID],
      [PERIOD_ID, 'bad-evidence'],
    ] as const) {
      const store = assemble();
      await expect(rejectionCode(() => runAs(store.context, lockActor, () =>
        store.service.lockPeriod(
          'payroll-lock-evidence-denied',
          periodId,
          5,
          evidenceId,
          userToken(),
        )))).resolves.toBe('PAYROLL_LOCK_EVIDENCE_INVALID');
      expect(store.strongAuth.requireVerifiedEvidence).not.toHaveBeenCalled();
    }
  });
});

describe('PayrollApprovalService 迁移重放与失败关闭', () => {
  it('迁移写入口逐项拒绝非服务身份和缺失专用 Scope', async () => {
    for (const currentActor of [
      actor({ actorType: 'user' }),
      actor({ actorType: 'service', scopes: [] }),
      actor({ actorType: 'service', scopes: ['erp:migration:execute'] }),
    ]) {
      const store = assemble();
      await expect(rejectionCode(() => runAs(store.context, currentActor, () =>
        store.service.importApprovalFromMigration(
          'migration-writer-denied',
          approvalInput() as never,
        )))).resolves.toBe('PAYROLL_MIGRATION_WRITER_DENIED');
      expect(store.idempotency.execute).not.toHaveBeenCalled();
    }
  });

  it('迁移审批输入逐字段拒绝额外字段、标识、版本、摘要与证据引用', async () => {
    const invalidInputs = [
      approvalInput({ extra: true }),
      approvalInput({ targetId: 'bad-target' }),
      approvalInput({ periodId: 'bad-period' }),
      approvalInput({ approvalHistoryId: 'bad-history' }),
      approvalInput({ approvedByEmployeeId: 'bad employee' }),
      approvalInput({ expectedPeriodVersion: 2 }),
      approvalInput({ expectedPeriodVersion: 3.1 }),
      approvalInput({ approvalEvidenceChecksum: 'bad-hash' }),
      approvalInput({ migrationEvidenceRef: 'https://evidence.invalid' }),
      approvalInput({ evidenceChecksum: 'bad-hash' }),
    ];
    for (const input of invalidInputs) {
      const store = assemble();
      await expect(runAs(store.context, actor(), () =>
        store.service.importApprovalFromMigration(
          'migration-approval-input-invalid',
          input as never,
        ))).rejects.toBeInstanceOf(BadRequestException);
      expect(store.idempotency.execute).not.toHaveBeenCalled();
    }
  });

  it('迁移锁定输入逐字段拒绝时间、额外字段、标识、版本、方法与证据', async () => {
    const invalidInputs = [
      lockInput({ lockedAt: '2026-06-04' }),
      lockInput({ lockedAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString() }),
      lockInput({ extra: true }),
      lockInput({ targetId: 'bad-target' }),
      lockInput({ periodId: 'bad-period' }),
      lockInput({ approvalControlEvidenceId: 'bad-control' }),
      lockInput({ lockedByEmployeeId: 'bad employee' }),
      lockInput({ strongAuthMethod: 'password' }),
      lockInput({ expectedPeriodVersion: 4 }),
      lockInput({ expectedPeriodVersion: 5.1 }),
      lockInput({ migrationEvidenceRef: 'https://evidence.invalid' }),
      lockInput({ evidenceChecksum: 'bad-hash' }),
    ];
    for (const input of invalidInputs) {
      const store = assemble();
      await expect(runAs(store.context, actor(), () =>
        store.service.importLockFromMigration(
          'migration-lock-input-invalid',
          input as never,
        ))).rejects.toBeInstanceOf(BadRequestException);
      expect(store.idempotency.execute).not.toHaveBeenCalled();
    }
  });

  it('迁移审批拒绝未映射人员、历史摘要漂移、非法时间和缺失周期', async () => {
    const cases = [
      {
        store: assemble({ resolvedActor: null }),
        type: NotFoundException,
        code: 'PAYROLL_MIGRATION_APPROVER_IDENTITY_NOT_FOUND',
      },
      {
        store: assemble({
          approvalReference: {
            id: APPROVAL_HISTORY_ID,
            completedAt: '2026-06-03T00:00:00.000Z',
            evidenceChecksum: 'x'.repeat(43),
          },
        }),
        type: ConflictException,
        code: 'PAYROLL_MIGRATION_APPROVAL_EVIDENCE_MISMATCH',
      },
      {
        store: assemble({
          approvalReference: {
            id: APPROVAL_HISTORY_ID,
            completedAt: 'not-an-instant',
            evidenceChecksum: 'a'.repeat(43),
          },
        }),
        type: BadRequestException,
        code: 'PAYROLL_MIGRATION_TIME_INVALID',
      },
      {
        store: assemble({ current: null }),
        type: NotFoundException,
        code: 'PAYROLL_PERIOD_NOT_FOUND',
      },
    ];
    for (const current of cases) {
      await expect(rejectionCode(() => runAs(current.store.context, actor(), () =>
        current.store.service.importApprovalFromMigration(
          'migration-approval-prerequisite',
          approvalInput() as never,
        )))).resolves.toBe(current.code);
      expect(current.store.approvalEvidence.create).not.toHaveBeenCalled();
    }
  });

  it('迁移审批对周期状态、版本、运行和时间线逐项失败关闭', async () => {
    for (const current of [
      period({ status: 'collecting' }),
      period({ version: 4 }),
      period({ activeRunId: null }),
      period({ updatedAt: new Date('2026-06-04T00:00:00.000Z') }),
    ]) {
      const store = assemble({ current });
      await expect(rejectionCode(() => runAs(store.context, actor(), () =>
        store.service.importApprovalFromMigration(
          'migration-approval-state-invalid',
          approvalInput() as never,
        )))).resolves.toBe('PAYROLL_MIGRATION_APPROVAL_STATE_INVALID');
      expect(store.approvalEvidence.create).not.toHaveBeenCalled();
    }
  });

  it('迁移批准重放只接受完整不可变证据与周期引用', async () => {
    const approvedAt = new Date('2026-06-03T00:00:00.000Z');
    const evidence = approvalControl();
    const approvedPeriod = period({
      status: 'approved',
      version: 5,
      approvalReferenceType: 'legacy_history',
      approvalInstanceId: APPROVAL_HISTORY_ID,
      approvalEvidenceId: APPROVAL_HISTORY_ID,
      approvedBy: 'actor-approver-001',
      updatedAt: approvedAt,
    });
    const success = assemble({
      current: approvedPeriod,
      approvalEvidence: evidence,
    });

    await expect(runAs(success.context, actor(), () =>
      success.service.importApprovalFromMigration(
        'migration-approval-replay',
        approvalInput({ targetId: APPROVAL_CONTROL_ID }) as never,
      ))).resolves.toEqual({
        id: APPROVAL_CONTROL_ID,
        version: 1,
        periodId: PERIOD_ID,
        periodVersion: 5,
        status: 'approved',
      });
    expect(success.periods.updateOne).not.toHaveBeenCalled();
    expect(success.outbox.append).not.toHaveBeenCalled();

    const invalidCases: readonly {
      readonly current?: PayrollPeriodRecord;
      readonly evidence?: Readonly<Record<string, unknown>> | null;
    }[] = [
      { evidence: null },
      { evidence: approvalControl({ periodId: 'other-period' }) },
      { evidence: approvalControl({ approvalHistoryId: 'other-history' }) },
      { evidence: approvalControl({ approvalEvidenceChecksum: 'x'.repeat(43) }) },
      { evidence: approvalControl({ approvedBy: 'actor-other-001' }) },
      { evidence: approvalControl({ approvedAt: new Date('2026-06-03T00:00:01.000Z') }) },
      { evidence: approvalControl({ periodVersion: 6 }) },
      { evidence: approvalControl({ migrationEvidenceRef: `${EVIDENCE_REF}-drift` }) },
      { evidence: approvalControl({ migrationEvidenceChecksum: 'x'.repeat(43) }) },
      { evidence: approvalControl({ createdAt: new Date('2026-06-03T00:00:01.000Z') }) },
      { evidence: approvalControl({ updatedAt: new Date('2026-06-03T00:00:01.000Z') }) },
      { current: period({ ...approvedPeriod, status: 'review' }) },
      { current: period({ ...approvedPeriod, version: 4 }) },
      { current: period({ ...approvedPeriod, approvalReferenceType: 'approval_instance' }) },
      { current: period({ ...approvedPeriod, approvalInstanceId: APPROVAL_INSTANCE_ID }) },
      { current: period({ ...approvedPeriod, approvalEvidenceId: APPROVAL_CONTROL_ID }) },
      { current: period({ ...approvedPeriod, approvedBy: 'actor-other-001' }) },
    ];
    for (const invalid of invalidCases) {
      const store = assemble({
        current: invalid.current ?? approvedPeriod,
        approvalEvidence: invalid.evidence === undefined ? evidence : invalid.evidence,
      });
      await expect(rejectionCode(() => runAs(store.context, actor(), () =>
        store.service.importApprovalFromMigration(
          'migration-approval-replay-drift',
          approvalInput({ targetId: APPROVAL_CONTROL_ID }) as never,
        )))).resolves.toBe('PAYROLL_MIGRATION_CONTROL_IMMUTABLE');
    }
  });

  it('迁移锁定拒绝未映射人员、缺失审批控制与非法周期状态', async () => {
    const controls = approvalControl();
    const approvedPeriod = period({
      status: 'approved',
      version: 5,
      approvalReferenceType: 'legacy_history',
      approvalInstanceId: APPROVAL_HISTORY_ID,
      approvedBy: 'actor-approver-001',
      approvalEvidenceId: APPROVAL_HISTORY_ID,
      updatedAt: new Date('2026-06-03T00:00:00.000Z'),
    });
    const prerequisites = [
      {
        store: assemble({
          current: approvedPeriod,
          resolvedActor: null,
          approvalEvidence: controls,
        }),
        code: 'PAYROLL_MIGRATION_LOCKER_IDENTITY_NOT_FOUND',
      },
      {
        store: assemble({
          current: approvedPeriod,
          resolvedActor: 'actor-locker-001',
          approvalEvidence: null,
        }),
        code: 'PAYROLL_MIGRATION_APPROVAL_CONTROL_NOT_FOUND',
      },
    ];
    for (const current of prerequisites) {
      await expect(rejectionCode(() => runAs(current.store.context, actor(), () =>
        current.store.service.importLockFromMigration(
          'migration-lock-prerequisite',
          lockInput() as never,
        )))).resolves.toBe(current.code);
      expect(current.store.lockEvidence.create).not.toHaveBeenCalled();
    }

    for (const current of [
      period({ ...approvedPeriod, status: 'review' }),
      period({ ...approvedPeriod, version: 6 }),
      period({ ...approvedPeriod, approvalReferenceType: 'approval_instance' }),
      period({ ...approvedPeriod, approvalInstanceId: APPROVAL_INSTANCE_ID }),
      period({ ...approvedPeriod, approvedBy: 'actor-other-001' }),
      period({ ...approvedPeriod, updatedAt: new Date('2026-06-05T00:00:00.000Z') }),
    ]) {
      const store = assemble({
        current,
        resolvedActor: 'actor-locker-001',
        approvalEvidence: controls,
      });
      await expect(rejectionCode(() => runAs(store.context, actor(), () =>
        store.service.importLockFromMigration(
          'migration-lock-state-invalid',
          lockInput() as never,
        )))).resolves.toBe('PAYROLL_MIGRATION_LOCK_STATE_INVALID');
      expect(store.lockEvidence.create).not.toHaveBeenCalled();
    }

    const futureControl = assemble({
      current: approvedPeriod,
      resolvedActor: 'actor-locker-001',
      approvalEvidence: approvalControl({
        approvedAt: new Date('2026-06-05T00:00:00.000Z'),
      }),
    });
    await expect(rejectionCode(() => runAs(futureControl.context, actor(), () =>
      futureControl.service.importLockFromMigration(
        'migration-lock-timeline-invalid',
        lockInput() as never,
      )))).resolves.toBe('PAYROLL_MIGRATION_LOCK_STATE_INVALID');
  });

  it('迁移锁定重放只接受完整 WORM 强认证证据与周期引用', async () => {
    const lockedAt = new Date('2026-06-04T00:00:00.000Z');
    const control = approvalControl();
    const evidence = {
      id: LOCK_CONTROL_ID,
      tenantId: 'tenant-001',
      periodId: PERIOD_ID,
      approvalControlEvidenceId: APPROVAL_CONTROL_ID,
      lockedBy: 'actor-locker-001',
      lockedAt,
      periodVersion: 6,
      strongAuthMethod: 'webauthn_uv',
      operationId: PERIOD_ID,
      migrationEvidenceRef: EVIDENCE_REF,
      migrationEvidenceChecksum: 'l'.repeat(43),
      createdAt: lockedAt,
      updatedAt: lockedAt,
    };
    const lockedPeriod = period({
      status: 'locked',
      version: 6,
      approvalReferenceType: 'legacy_history',
      approvalInstanceId: APPROVAL_HISTORY_ID,
      approvedBy: 'actor-approver-001',
      approvalEvidenceId: APPROVAL_HISTORY_ID,
      lockedBy: 'actor-locker-001',
      strongAuthReferenceType: 'migration_lock_evidence',
      strongAuthEvidenceId: LOCK_CONTROL_ID,
      updatedAt: lockedAt,
    });
    const success = assemble({
      current: lockedPeriod,
      resolvedActor: 'actor-locker-001',
      approvalEvidence: control,
      lockEvidence: evidence,
    });

    await expect(runAs(success.context, actor(), () =>
      success.service.importLockFromMigration(
        'migration-lock-replay',
        lockInput({ targetId: LOCK_CONTROL_ID }) as never,
      ))).resolves.toEqual({
        id: LOCK_CONTROL_ID,
        version: 1,
        periodId: PERIOD_ID,
        periodVersion: 6,
        status: 'locked',
      });
    expect(success.periods.updateOne).not.toHaveBeenCalled();

    const invalidCases: readonly {
      readonly current?: PayrollPeriodRecord;
      readonly evidence?: Readonly<Record<string, unknown>> | null;
      readonly control?: Readonly<Record<string, unknown>>;
    }[] = [
      { evidence: null },
      { evidence: { ...evidence, periodId: 'other-period' } },
      { evidence: { ...evidence, approvalControlEvidenceId: 'other-control' } },
      { evidence: { ...evidence, lockedBy: 'actor-other-001' } },
      { evidence: { ...evidence, lockedAt: new Date('2026-06-04T00:00:01.000Z') } },
      { evidence: { ...evidence, strongAuthMethod: 'password' } },
      { evidence: { ...evidence, operationId: 'other-period' } },
      { evidence: { ...evidence, periodVersion: 7 } },
      { evidence: { ...evidence, migrationEvidenceRef: `${EVIDENCE_REF}-drift` } },
      { evidence: { ...evidence, migrationEvidenceChecksum: 'x'.repeat(43) } },
      { evidence: { ...evidence, createdAt: new Date('2026-06-04T00:00:01.000Z') } },
      { evidence: { ...evidence, updatedAt: new Date('2026-06-04T00:00:01.000Z') } },
      {
        evidence,
        control: approvalControl({ approvedAt: new Date('2026-06-05T00:00:00.000Z') }),
      },
      { current: period({ ...lockedPeriod, status: 'approved' }) },
      { current: period({ ...lockedPeriod, version: 5 }) },
      { current: period({ ...lockedPeriod, lockedBy: 'actor-other-001' }) },
      { current: period({ ...lockedPeriod, strongAuthReferenceType: 'webauthn_evidence' }) },
      { current: period({ ...lockedPeriod, strongAuthEvidenceId: WEBAUTHN_EVIDENCE_ID }) },
    ];
    for (const invalid of invalidCases) {
      const store = assemble({
        current: invalid.current ?? lockedPeriod,
        resolvedActor: 'actor-locker-001',
        approvalEvidence: invalid.control ?? control,
        lockEvidence: invalid.evidence === undefined ? evidence : invalid.evidence,
      });
      await expect(rejectionCode(() => runAs(store.context, actor(), () =>
        store.service.importLockFromMigration(
          'migration-lock-replay-drift',
          lockInput({ targetId: LOCK_CONTROL_ID }) as never,
        )))).resolves.toBe('PAYROLL_MIGRATION_CONTROL_IMMUTABLE');
    }
  });

  it('并发写冲突、唯一键冲突和领域错误映射为封闭异常', async () => {
    const writeConflict = assemble({
      current: period({ preparedBy: 'actor-preparer-001' }),
      modifiedCount: 0,
    });
    const requestActor = actor({
      actorId: 'actor-preparer-001',
      actorType: 'user',
      scopes: ['erp:payroll:approval:request', 'erp:approval:instance:submit'],
    });
    await expect(rejectionCode(() => runAs(writeConflict.context, requestActor, () =>
      writeConflict.service.requestApproval(
        'payroll-write-conflict',
        PERIOD_ID,
        3,
      )))).resolves.toBe('PAYROLL_PERIOD_WRITE_CONFLICT');

    const duplicate = assemble({ idempotencyError: { code: 11_000 } });
    await expect(rejectionCode(() => runAs(duplicate.context, actor(), () =>
      duplicate.service.importApprovalFromMigration(
        'migration-unique-conflict',
        approvalInput() as never,
      )))).resolves.toBe('PAYROLL_MIGRATION_CONTROL_UNIQUE_CONFLICT');

    const badRequest = assemble({
      current: period({
        status: 'pending_approval',
        version: 4,
        approvalReferenceType: 'approval_instance',
        approvalInstanceId: APPROVAL_INSTANCE_ID,
      }),
      decision: {
        id: 'bad decision id',
        periodId: PERIOD_ID,
        runId: RUN_ID,
        inputSnapshotHash: 'i'.repeat(43),
        resultHash: 'r'.repeat(43),
        outcome: 'approved',
        decidedBy: 'actor-approver-001',
        completedAt: '2026-06-03T00:00:00.000Z',
        formDataHash: 'f'.repeat(43),
      },
    });
    const syncActor = actor({
      actorType: 'service',
      scopes: ['erp:payroll:approval:sync'],
    });
    await expect(runAs(badRequest.context, syncActor, () =>
      badRequest.service.applyApproval(
        'payroll-domain-invalid',
        PERIOD_ID,
        4,
        APPROVAL_INSTANCE_ID,
      ))).rejects.toBeInstanceOf(BadRequestException);

    const versionConflict = assemble({
      current: period({
        status: 'pending_approval',
        version: 4,
        approvalReferenceType: 'approval_instance',
        approvalInstanceId: APPROVAL_INSTANCE_ID,
      }),
    });
    await expect(runAs(versionConflict.context, syncActor, () =>
      versionConflict.service.applyApproval(
        'payroll-domain-version-conflict',
        PERIOD_ID,
        3,
        APPROVAL_INSTANCE_ID,
      ))).rejects.toBeInstanceOf(ConflictException);

    const missing = assemble({ current: null });
    await expect(runAs(missing.context, requestActor, () =>
      missing.service.requestApproval(
        'payroll-period-missing',
        PERIOD_ID,
        3,
      ))).rejects.toBeInstanceOf(NotFoundException);
  });
});
