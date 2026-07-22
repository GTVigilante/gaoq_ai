import type { ActorContext } from '@gaoq/shared-types';
import { ForbiddenException } from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { PayrollPeriodRecord } from '../persistence/payroll.schemas.js';
import { PayrollApprovalService } from './payroll-approval.service.js';

const PERIOD_ID = '01J8ZQK7V0A2M4N6P8R0T2W4P1';
const RUN_ID = '01J8ZQK7V0A2M4N6P8R0T2W4R1';
const APPROVAL_HISTORY_ID = '01J8ZQK7V0A2M4N6P8R0T2W4H1';
const APPROVAL_CONTROL_ID = '01J8ZQK7V0A2M4N6P8R0T2W4A1';
const EVIDENCE_REF =
  'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/control-001';
const session = {} as ClientSession;

function actor(): ActorContext {
  return {
    actorId: 'migration-agent-001', actorType: 'service', tenantId: 'tenant-001',
    roleCodes: ['migration'],
    scopes: ['erp:migration:execute', 'erp:payroll:migration:write'],
    departmentIds: [], traceId: 'trace-migration-001',
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
  readonly current: PayrollPeriodRecord;
  readonly resolvedActor: string;
  readonly approvalControl?: Readonly<Record<string, unknown>> | null;
}) {
  const context = new TenantContextService();
  const idempotency = { execute: vi.fn(async (
    _operation: string,
    _key: string,
    _request: unknown,
    handler: (value: ClientSession) => Promise<Record<string, unknown>>,
  ) => handler(session)) };
  const profiles = {
    findActorIdByEmployee: vi.fn().mockResolvedValue(options.resolvedActor),
  };
  const approvals = { verifyPayrollMigrationReference: vi.fn().mockResolvedValue({
    id: APPROVAL_HISTORY_ID, templateCode: 'payroll_period_approval',
    completedAt: '2026-06-03T00:00:00.000Z', evidenceChecksum: 'a'.repeat(43),
  }) };
  const periods = {
    findOne: vi.fn().mockReturnValue(query(options.current)),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const approvalEvidence = {
    create: vi.fn().mockResolvedValue([]),
    findOne: vi.fn().mockReturnValue(query(options.approvalControl ?? null)),
  };
  const lockEvidence = {
    create: vi.fn().mockResolvedValue([]), findOne: vi.fn().mockReturnValue(query(null)),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const service = new PayrollApprovalService(
    idempotency as never, context, profiles as never, approvals as never, {} as never,
    outbox as never, periods as never, approvalEvidence as never, lockEvidence as never,
  );
  return {
    context, service, periods, profiles, approvals, approvalEvidence, lockEvidence, outbox,
  };
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
      resolvedActor: 'actor-locker-001', approvalControl,
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
