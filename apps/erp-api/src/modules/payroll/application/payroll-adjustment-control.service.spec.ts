import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { PayrollAdjustmentService } from './payroll-adjustment.service.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const session = {} as ClientSession;
const adjustmentId = '01J8ZQK7V0A2M4N6P8R0T2W4D1';
const approvalId = '01J8ZQK7V0A2M4N6P8R0T2W4A1';
const evidenceId = '01J8ZQK7V0A2M4N6P8R0T2W4E1';

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
    scopes: [...scopes],
    departmentIds: [],
    traceId: 'trace-adjustment-control',
  };
}

function record(
  status: 'prepared' | 'pending_approval' | 'approved',
  noSettlementAction = false,
) {
  return {
    id: adjustmentId,
    tenantId: tenant.tenantId,
    periodId: '01J8ZQK7V0A2M4N6P8R0T2W4P1',
    period: '2026-07',
    originalRunId: '01J8ZQK7V0A2M4N6P8R0T2W4R1',
    originalCalculationLineId: '01J8ZQK7V0A2M4N6P8R0T2W4N1',
    employeeId: 'employee-001',
    adjustmentNumber: 1,
    type: noSettlementAction ? 'tax_only' as const : 'supplement' as const,
    reasonCode: 'RETROACTIVE_SALARY_CHANGE',
    originalResultHash: 'o'.repeat(43),
    correctedInputHash: 'i'.repeat(43),
    correctedResultHash: 'c'.repeat(43),
    adjustmentHash: 'a'.repeat(43),
    grossDeltaMinor: 100_000,
    taxDeltaMinor: noSettlementAction ? 0 : 3_000,
    netDeltaMinor: noSettlementAction ? 0 : 97_000,
    payableMinor: noSettlementAction ? 0 : 97_000,
    receivableMinor: 0,
    preparedBy: 'adjustment-engine',
    requestedBy: status === 'prepared' ? null : 'payroll-requester',
    approvalInstanceId: status === 'prepared' ? null : approvalId,
    approvalDecidedBy: status === 'approved' ? 'finance-approver' : null,
    approvalEvidenceId: status === 'approved' ? approvalId : null,
    lockedBy: null,
    strongAuthEvidenceId: null,
    cashSettlementStatus: noSettlementAction ? 'not_required' as const : 'pending' as const,
    taxCorrectionStatus: noSettlementAction ? 'not_required' as const : 'pending' as const,
    cashSettlementReferenceType: null,
    cashSettlementReferenceId: null,
    cashSettlementEvidenceId: null,
    taxCorrectionFilingId: null,
    status,
    version: status === 'prepared' ? 1 : status === 'pending_approval' ? 2 : 3,
    dataKeyId: 'key',
    dataIv: 'iv',
    dataCiphertext: 'cipher',
    dataAuthTag: 'tag',
    createdAt: new Date('2026-07-27T00:00:00.000Z'),
    updatedAt: new Date('2026-07-27T00:00:00.000Z'),
  };
}

function query<T>(value: T) {
  const result = {
    session: vi.fn(() => result),
    lean: vi.fn(() => result),
    exec: vi.fn().mockResolvedValue(value),
  };
  return result;
}

function assemble(current: ReturnType<typeof record>) {
  const context = new TenantContextService();
  const idempotency = {
    execute: vi.fn(async (
      _operation: string,
      _key: string,
      _input: unknown,
      handler: (value: ClientSession) => Promise<Record<string, unknown>>,
    ) => handler(session)),
  };
  const approvals = {
    createInstance: vi.fn().mockResolvedValue({
      instance: { id: approvalId, version: 1, status: 'draft' },
    }),
    submitInstance: vi.fn().mockResolvedValue({
      instance: { id: approvalId, version: 2, status: 'running' },
    }),
    getPayrollAdjustmentDecision: vi.fn().mockResolvedValue({
      id: approvalId,
      outcome: 'approved',
      decidedBy: 'finance-approver',
      completedAt: '2026-07-27T00:05:00.000Z',
      adjustmentId,
      adjustmentHash: current.adjustmentHash,
      period: current.period,
      adjustmentType: current.type,
      reasonCode: current.reasonCode,
      formDataHash: 'f'.repeat(43),
    }),
  };
  const strongAuth = {
    requireVerifiedEvidence: vi.fn().mockResolvedValue({
      evidenceId,
      method: 'webauthn_uv',
    }),
  };
  const adjustments = {
    findOne: vi.fn().mockReturnValue(query(current)),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const outbox = {
    append: vi.fn<(
      event: {
        readonly type: string;
        readonly version: number;
        readonly data: Readonly<Record<string, unknown>>;
      },
      session: ClientSession,
    ) => Promise<void>>().mockResolvedValue(undefined),
  };
  const service = new PayrollAdjustmentService(
    idempotency as never,
    context,
    approvals as never,
    strongAuth as never,
    {} as never,
    {} as never,
    outbox as never,
    {} as never,
    {} as never,
    adjustments as never,
  );
  return { context, service, approvals, strongAuth, adjustments, outbox };
}

describe('PayrollAdjustmentService 审批与锁定', () => {
  it('只把固定控制摘要送入专用审批模板并以版本锁绑定', async () => {
    const store = assemble(record('prepared'));
    const principal = actor('user', 'payroll-requester', [
      'erp:payroll:adjustment:approval:request',
      'erp:approval:instance:submit',
    ]);
    const result = await store.context.run({ tenant, actor: principal }, () =>
      store.service.requestApproval('request-001', adjustmentId, 1));

    expect(result).toMatchObject({
      id: adjustmentId,
      status: 'pending_approval',
      version: 2,
      approvalInstanceId: approvalId,
    });
    expect(store.approvals.createInstance).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        templateCode: 'payroll_adjustment_approval',
        formData: {
          adjustment_id: adjustmentId,
          adjustment_hash: 'a'.repeat(43),
          period: '2026-07',
          adjustment_type: 'supplement',
          reason_code: 'RETROACTIVE_SALARY_CHANGE',
        },
      }),
    );
    const persisted = JSON.stringify(store.outbox.append.mock.calls);
    expect(persisted).not.toMatch(/employee-001|97000|payroll-requester/u);
  });

  it('批准后只接受独立人员以绑定调整 ID 的 WebAuthn UV 锁定', async () => {
    const store = assemble(record('approved'));
    const principal = actor('user', 'treasury-locker', [
      'erp:payroll:adjustment:lock',
    ]);
    const result = await store.context.run({ tenant, actor: principal }, () =>
      store.service.lock(
        'lock-001',
        adjustmentId,
        3,
        evidenceId,
        {
          actorType: 'user',
          actorId: 'treasury-locker',
          tenantId: tenant.tenantId,
          sessionId: 'session-001',
        } as never,
      ));

    expect(result).toMatchObject({ status: 'locked', version: 4 });
    expect(store.strongAuth.requireVerifiedEvidence).toHaveBeenCalledWith({
      evidenceId,
      tenantId: tenant.tenantId,
      actorId: 'treasury-locker',
      sessionId: 'session-001',
      operationId: adjustmentId,
    });
    const update = store.adjustments.updateOne.mock.calls[0]?.[1] as unknown as {
      readonly $set: Readonly<Record<string, unknown>>;
    };
    expect(update.$set).toMatchObject({
      lockedBy: 'treasury-locker',
      strongAuthEvidenceId: evidenceId,
      status: 'locked',
      version: 4,
    });
  });

  it('同步服务只接受与调整摘要逐字段一致的 Approval 可信终态', async () => {
    const store = assemble(record('pending_approval'));
    const principal = actor('system_job', 'approval-sync', [
      'erp:payroll:adjustment:approval:sync',
    ]);
    const result = await store.context.run({ tenant, actor: principal }, () =>
      store.service.applyApproval('apply-001', adjustmentId, 2, approvalId));

    expect(result).toMatchObject({
      status: 'approved',
      version: 3,
      approvalInstanceId: approvalId,
    });
    expect(store.approvals.getPayrollAdjustmentDecision).toHaveBeenCalledWith(approvalId);
    const event = store.outbox.append.mock.calls[0]?.[0] as unknown as {
      readonly type: string;
      readonly data: Readonly<Record<string, unknown>>;
    };
    expect(event).toMatchObject({
      type: 'payroll.adjustment.approval_applied',
      data: { outcome: 'approved', status: 'approved' },
    });
    expect(JSON.stringify(event)).not.toMatch(/employee-001|finance-approver|97000/u);
  });

  it('现金和税务均无需动作时锁定后立即追加 settled 终态', async () => {
    const store = assemble(record('approved', true));
    const principal = actor('user', 'treasury-locker', [
      'erp:payroll:adjustment:lock',
    ]);
    const result = await store.context.run({ tenant, actor: principal }, () =>
      store.service.lock(
        'lock-no-action-001',
        adjustmentId,
        3,
        evidenceId,
        {
          actorType: 'user',
          actorId: 'treasury-locker',
          tenantId: tenant.tenantId,
          sessionId: 'session-001',
        } as never,
      ));

    expect(result).toMatchObject({ status: 'settled', version: 5 });
    expect(store.adjustments.updateOne).toHaveBeenCalledTimes(2);
    expect(store.outbox.append.mock.calls.map(([event]) => [
      event.type,
      event.version,
      event.data['status'],
    ])).toEqual([
      ['payroll.adjustment.locked', 4, 'locked'],
      ['payroll.adjustment.settled', 5, 'settled'],
    ]);
  });
});
