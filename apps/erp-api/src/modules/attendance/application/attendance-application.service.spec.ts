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
  const approvals = {
    getAttendanceCorrectionDecision: vi.fn(), getAttendanceMonthReopenDecision: vi.fn(),
    verifyAttendanceCorrectionMigrationReference: vi.fn(),
    createInstance: vi.fn(), submitInstance: vi.fn(),
  };
  const crypto = { sourceEventFingerprints: vi.fn().mockReturnValue(['key.digest']) };
  const facts = {
    findByEventFingerprints: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(sourceFact()),
    findForMonth: vi.fn().mockResolvedValue([sourceFact()]),
    insert: vi.fn().mockResolvedValue(undefined),
    insertMigrated: vi.fn().mockResolvedValue(undefined),
    findMigrationEvidenceById: vi.fn().mockResolvedValue(null),
  };
  const corrections = {
    findForMonth: vi.fn().mockResolvedValue([]), findBySourceFactId: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(null),
    findMigrationEvidenceById: vi.fn().mockResolvedValue(null),
    insert: vi.fn().mockResolvedValue(undefined), insertMigrated: vi.fn().mockResolvedValue(undefined),
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
  it('迁移修订从源事实和已批准历史派生绑定且不泄露 L4 替换影响', async () => {
    const store = assemble();
    store.approvals.verifyAttendanceCorrectionMigrationReference.mockResolvedValue({
      id: 'approval-history-001', completedAt: '2026-04-01T02:00:00.000Z',
      evidenceChecksum: 'a'.repeat(43),
    });
    const result = await store.context.run({
      tenant,
      actor: actor(
        ['erp:migration:execute', 'erp:attendance:migration:write'], 'service',
      ),
    }, () => store.service.importCorrectionFromMigration('attendance-correction-migration-001', {
      targetId: null, employeeId: 'employee-001', sourceFactId: sourceFact().id,
      approvalHistoryId: 'approval-history-001', approvalEvidenceChecksum: 'a'.repeat(43),
      replacementImpact: {
        workedMinutes: 420, leaveMinutes: 60, overtimeMinutes: 0, absentMinutes: 0,
      },
      reasonCode: 'LEGACY_APPROVED', createdAt: '2026-04-01T02:01:00.000Z',
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/correction-001',
      evidenceChecksum: 'c'.repeat(43),
    }));
    expect(store.corrections.insertMigrated).toHaveBeenCalledWith(
      expect.objectContaining({
        employeeId: 'employee-001', businessDate: '2026-04-01',
        approvalReferenceType: 'legacy_history', approvalInstanceId: null,
        approvalHistoryId: 'approval-history-001',
        approvedAt: '2026-04-01T02:00:00.000Z',
      }),
      expect.stringContaining('/attachments/correction-001'), 'c'.repeat(43), session,
    );
    const event = store.outbox.append.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(event).toMatchObject({ type: 'attendance.correction.migrated' });
    expect(JSON.stringify(event)).not.toMatch(/workedMinutes|420|LEGACY_APPROVED/u);
    expect(result.correction).toMatchObject({ version: 1, businessDate: '2026-04-01' });
    store.approvals.verifyAttendanceCorrectionMigrationReference.mockResolvedValue({
      id: 'approval-history-001', completedAt: '2026-04-01T01:01:00.000Z',
      evidenceChecksum: 'a'.repeat(43),
    });
    await expect(store.context.run({
      tenant,
      actor: actor(
        ['erp:migration:execute', 'erp:attendance:migration:write'], 'service',
      ),
    }, () => store.service.importCorrectionFromMigration('attendance-correction-migration-002', {
      targetId: null, employeeId: 'employee-001', sourceFactId: sourceFact().id,
      approvalHistoryId: 'approval-history-001', approvalEvidenceChecksum: 'a'.repeat(43),
      replacementImpact: {
        workedMinutes: 420, leaveMinutes: 60, overtimeMinutes: 0, absentMinutes: 0,
      },
      reasonCode: 'LEGACY_APPROVED', createdAt: '2026-04-01T02:01:00.000Z',
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/correction-002',
      evidenceChecksum: 'd'.repeat(43),
    }))).rejects.toThrow('批准时间不得早于源事实落库时间');
    expect(store.corrections.insertMigrated).toHaveBeenCalledTimes(1);
  });

  it('迁移源事实只写 L4 密文入口、盲索引、WORM 与专用事件', async () => {
    const store = assemble();
    store.crypto.sourceEventFingerprints.mockReturnValue(['blind-key.digest']);
    const result = await store.context.run({
      tenant,
      actor: actor(
        ['erp:migration:execute', 'erp:attendance:migration:write'], 'service',
      ),
    }, () => store.service.importSourceFactFromMigration('attendance-migration-key-001', {
      targetId: null, employeeId: 'employee-001', providerCode: 'legacy_hr',
      externalEventId: 'legacy-event-001', factType: 'shift',
      occurredAt: '2026-04-01T01:00:00.000Z', timeZone: 'Asia/Shanghai',
      impact: { workedMinutes: 480, leaveMinutes: 0, overtimeMinutes: 0, absentMinutes: 0 },
      sourceObservedAt: '2026-04-01T01:01:00.000Z',
      createdAt: '2026-04-01T01:02:00.000Z',
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/attendance-001',
      evidenceChecksum: 'c'.repeat(43),
    }));
    expect(store.facts.insertMigrated).toHaveBeenCalledWith(
      expect.objectContaining({
        employeeId: 'employee-001', businessDate: '2026-04-01',
        createdAt: '2026-04-01T01:02:00.000Z',
      }),
      ['blind-key.digest'], expect.stringContaining('/attachments/attendance-001'),
      'c'.repeat(43), session,
    );
    const event = store.outbox.append.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(event).toMatchObject({ type: 'attendance.source_fact.migrated' });
    expect(JSON.stringify(event)).not.toMatch(/workedMinutes|480|legacy-event-001/u);
    expect(result.fact).toMatchObject({ version: 1, businessDate: '2026-04-01' });
  });

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
    store.approvals.getAttendanceCorrectionDecision = vi.fn().mockResolvedValue({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
      completedAt: '2026-04-02T00:00:00.000Z',
      sourceFactId: sourceFact().id, employeeId: 'employee-001', businessDate: '2026-04-01',
      replacementImpact: {
        workedMinutes: 420, leaveMinutes: 0, overtimeMinutes: 0, absentMinutes: 0,
      },
      reasonCode: 'MISSED_BREAK', formDataHash: 'a'.repeat(43),
    });
    const result = await store.context.run({
      tenant,
      actor: actor(['erp:attendance:correction:attest', 'erp:attendance:approval:sync']),
    }, () => store.service.registerCorrection('correction-key-001', {
      approvalInstanceId: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
    }));
    expect(store.approvals.getAttendanceCorrectionDecision).toHaveBeenCalledWith(
      '01J8ZQK7V0A2M4N6P8R0T2W4A1',
    );
    expect(store.corrections.insert).toHaveBeenCalledWith(expect.objectContaining({
      employeeId: 'employee-001', businessDate: '2026-04-01',
      approvalEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
    }), session);
    expect(result.correction).not.toHaveProperty('reasonCode');
    expect(result.correction).not.toHaveProperty('replacementImpact');
    store.approvals.getAttendanceCorrectionDecision.mockResolvedValue({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4A3', completedAt: '2026-04-02T00:00:00.000Z',
      sourceFactId: sourceFact().id, employeeId: 'employee-999', businessDate: '2026-04-01',
      replacementImpact: {
        workedMinutes: 420, leaveMinutes: 0, overtimeMinutes: 0, absentMinutes: 0,
      },
      reasonCode: 'MISSED_BREAK', formDataHash: 'b'.repeat(43),
    });
    await expect(store.context.run({
      tenant,
      actor: actor(['erp:attendance:correction:attest', 'erp:attendance:approval:sync']),
    }, () => store.service.registerCorrection('correction-key-002', {
      approvalInstanceId: '01J8ZQK7V0A2M4N6P8R0T2W4A3',
    }))).rejects.toThrow('考勤修订审批与源事实员工或业务日期不匹配');
    expect(store.corrections.insert).toHaveBeenCalledTimes(1);
  });

  it('本人修订请求把受控内容固化到专用 Approval，Attendance 事件不泄露分钟和原因', async () => {
    const store = assemble();
    store.approvals.createInstance = vi.fn().mockResolvedValue({
      instance: { id: '01J8ZQK7V0A2M4N6P8R0T2W4A2', version: 1 },
    });
    store.approvals.submitInstance = vi.fn().mockResolvedValue({
      instance: {
        id: '01J8ZQK7V0A2M4N6P8R0T2W4A2', status: 'running', version: 2,
      },
    });
    const result = await store.context.run({
      tenant,
      actor: actor(['erp:attendance:correction:request', 'erp:approval:instance:submit']),
    }, () => store.service.requestCorrection('request-key-001', {
      sourceFactId: sourceFact().id,
      replacementImpact: {
        workedMinutes: 420, leaveMinutes: 60, overtimeMinutes: 0, absentMinutes: 0,
      },
      reasonCode: 'MISSED_BREAK',
    }));
    expect(store.approvals.createInstance).toHaveBeenCalledWith(
      expect.stringMatching(/^attendance:/),
      expect.objectContaining({
        templateCode: 'attendance_correction',
        formData: {
          source_fact_id: sourceFact().id, employee_id: 'employee-001',
          business_date: '2026-04-01', worked_minutes: 420, leave_minutes: 60,
          overtime_minutes: 0, absent_minutes: 0, reason_code: 'MISSED_BREAK',
        },
      }),
    );
    expect(result.request).toMatchObject({ approvalStatus: 'running', businessDate: '2026-04-01' });
    const event = store.outbox.append.mock.calls.at(-1)?.[0] as unknown as Record<string, unknown>;
    expect(event).toMatchObject({ type: 'attendance.correction.requested' });
    expect(JSON.stringify(event)).not.toMatch(/workedMinutes|leaveMinutes|MISSED_BREAK/);
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

  it('月结重开审批必须绑定当前员工、月份和活动快照', async () => {
    const store = assemble();
    store.snapshots.findActive.mockResolvedValue({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4S1', snapshotVersion: 1,
    });
    store.approvals.getAttendanceMonthReopenDecision.mockResolvedValue({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4A4', completedAt: '2026-05-02T00:00:00.000Z',
      employeeId: 'employee-001', month: '2026-03',
      previousSnapshotId: '01J8ZQK7V0A2M4N6P8R0T2W4S1', formDataHash: 'c'.repeat(43),
    });
    await expect(store.context.run({
      tenant,
      actor: actor(['erp:attendance:month:close', 'erp:attendance:approval:sync']),
    }, () => store.service.closeMonth('close-key-002', {
      employeeId: 'employee-001', month: '2026-04', rulesetVersion: 'attendance-cn-v1',
      sourceCutoffAt: '2026-05-02T00:00:00.000Z',
      supersessionApprovalInstanceId: '01J8ZQK7V0A2M4N6P8R0T2W4A4',
    }))).rejects.toThrow('月结重开审批与员工、月份或活动快照不匹配');
    expect(store.snapshots.activate).not.toHaveBeenCalled();
  });
});
