import type { ActorContext } from '@gaoq/shared-types';
import { ForbiddenException } from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { AttendanceSourceFact } from '../domain/index.js';
import { AttendanceApplicationService } from './attendance-application.service.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const session = {} as ClientSession;

function actor(
  scopes: readonly string[],
  actorType: ActorContext['actorType'] = 'user',
): ActorContext {
  return {
    actorType, actorId: 'actor-001', tenantId: tenant.tenantId,
    roleCodes: ['employee'], scopes, departmentIds: ['department-001'], traceId: 'trace-001',
  };
}

function sourceFact(): AttendanceSourceFact {
  return Object.freeze({
    id: '01J8ZQK7V0A2M4N6P8R0T2W4F1', tenantId: tenant.tenantId,
    employeeId: 'employee-001', providerCode: 'dingtalk', factType: 'shift',
    occurredAt: '2026-04-01T01:00:00.000Z', timeZone: 'Asia/Shanghai',
    businessDate: '2026-04-01', impact: Object.freeze({
      workedMinutes: 480, leaveMinutes: 0, overtimeMinutes: 0, absentMinutes: 0,
    }),
    sourceObservedAt: '2026-04-01T01:01:00.000Z',
    createdAt: '2026-04-01T01:02:00.000Z',
  });
}

function assemble() {
  const context = new TenantContextService();
  const idempotency = { execute: vi.fn(async (
    _operation: string,
    _key: string,
    _request: unknown,
    handler: (value: ClientSession) => Promise<Record<string, unknown>>,
  ) => handler(session)) };
  const profiles = { resolveActive: vi.fn().mockResolvedValue({ employeeId: 'employee-001' }) };
  const employees = { findById: vi.fn().mockResolvedValue({ id: 'employee-001' }) };
  const approvals = { getInstanceStatusForAttendance: vi.fn() };
  const crypto = { sourceEventFingerprints: vi.fn().mockReturnValue(['key.digest']) };
  const facts = {
    findByEventFingerprints: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(sourceFact()),
    findForMonth: vi.fn().mockResolvedValue([sourceFact()]),
    insert: vi.fn().mockResolvedValue(undefined),
  };
  const corrections = {
    findForMonth: vi.fn().mockResolvedValue([]), insert: vi.fn().mockResolvedValue(undefined),
  };
  const snapshots = {
    findActive: vi.fn(), activate: vi.fn().mockResolvedValue(undefined),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const service = new AttendanceApplicationService(
    idempotency as never, context, profiles as never, employees as never, approvals as never,
    crypto as never, facts as never, corrections as never, snapshots as never, outbox as never,
  );
  return {
    service, context, profiles, employees, approvals, crypto,
    facts, corrections, snapshots, outbox,
  };
}

describe('AttendanceApplicationService', () => {
  it('本人查询从可信 actor 反查员工，不接受客户端 employeeId', async () => {
    const store = assemble();
    store.snapshots.findActive.mockResolvedValue({
      id: 'snapshot-001', employeeId: 'employee-001', month: '2026-04', snapshotVersion: 1,
      rulesetVersion: 'attendance-cn-v1', sourceCutoffAt: '2026-05-01T00:00:00.000Z',
      workedMinutes: 9_600, leaveMinutes: 0, overtimeMinutes: 60, absentMinutes: 0,
      sourceFactCount: 20, correctionCount: 0, snapshotHash: 'a'.repeat(43),
      closedAt: '2026-05-01T00:01:00.000Z',
    });
    const result = await store.context.run({
      tenant, actor: actor(['erp:attendance:month:read_self']),
    }, () => store.service.getMyMonth('2026-04'));
    expect(store.profiles.resolveActive).toHaveBeenCalledWith('tenant-001', 'actor-001');
    expect(store.snapshots.findActive).toHaveBeenCalledWith('employee-001', '2026-04');
    expect(result.employeeId).toBe('employee-001');
  });

  it('即使拥有写 Scope，普通用户也不能伪装源系统写入事实', async () => {
    const store = assemble();
    await expect(store.context.run({
      tenant, actor: actor(['erp:attendance:source:ingest']),
    }, () => store.service.ingest('ingest-key-001', {
      employeeId: 'employee-001', providerCode: 'dingtalk', externalEventId: 'event-001',
      factType: 'shift', occurredAt: '2026-04-01T01:00:00.000Z', timeZone: 'Asia/Shanghai',
      impact: { workedMinutes: 480, leaveMinutes: 0, overtimeMinutes: 0, absentMinutes: 0 },
      sourceObservedAt: '2026-04-01T01:01:00.000Z',
    }))).rejects.toBeInstanceOf(ForbiddenException);
    expect(store.facts.insert).not.toHaveBeenCalled();
  });

  it('修订员工与业务日期取自不可变源事实，并要求专用审批已通过', async () => {
    const store = assemble();
    store.approvals.getInstanceStatusForAttendance.mockResolvedValue({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4A1', status: 'approved',
      completedAt: '2026-04-02T00:00:00.000Z',
    });
    const result = await store.context.run({
      tenant,
      actor: actor(['erp:attendance:correction:attest', 'erp:attendance:approval:sync']),
    }, () => store.service.registerCorrection('correction-key-001', {
      sourceFactId: sourceFact().id,
      replacementImpact: {
        workedMinutes: 420, leaveMinutes: 0, overtimeMinutes: 0, absentMinutes: 0,
      },
      reasonCode: 'MISSED_BREAK', approvalInstanceId: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
    }));
    expect(store.approvals.getInstanceStatusForAttendance).toHaveBeenCalledWith(
      '01J8ZQK7V0A2M4N6P8R0T2W4A1', 'attendance_correction',
    );
    expect(store.corrections.insert).toHaveBeenCalledWith(expect.objectContaining({
      employeeId: 'employee-001', businessDate: '2026-04-01',
      approvalEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
    }), session);
    expect(result.correction).not.toHaveProperty('reasonCode');
    expect(result.correction).not.toHaveProperty('replacementImpact');
  });

  it('已有活动快照时，没有重开审批就拒绝生成新版本', async () => {
    const store = assemble();
    store.snapshots.findActive.mockResolvedValue({ id: 'snapshot-001', snapshotVersion: 1 });
    await expect(store.context.run({
      tenant, actor: actor(['erp:attendance:month:close']),
    }, () => store.service.closeMonth('close-key-001', {
      employeeId: 'employee-001', month: '2026-04', rulesetVersion: 'attendance-cn-v1',
      sourceCutoffAt: '2026-05-01T00:00:00.000Z',
    }))).rejects.toThrow('已关账月份重开必须提供审批引用');
    expect(store.snapshots.activate).not.toHaveBeenCalled();
  });
});
