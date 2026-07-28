import type { ActorContext } from '@gaoq/shared-types';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  restoreAttendanceCorrectionFromMigration,
  restoreAttendanceMonthFromMigration,
  type AttendanceCorrection,
  type AttendanceMonthlySnapshot,
  type AttendanceSourceFact,
} from '../domain/index.js';
import {
  AttendanceApplicationService,
  type ImportAttendanceCorrectionFromMigrationInput,
  type ImportAttendanceMonthFromMigrationInput,
  type ImportAttendanceSourceFactFromMigrationInput,
} from './attendance-application.service.js';

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

const migrationEvidenceRef =
  'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/attendance-001';

function sourceMigrationInput(
  overrides: Partial<ImportAttendanceSourceFactFromMigrationInput> = {},
): ImportAttendanceSourceFactFromMigrationInput {
  return {
    targetId: null,
    employeeId: 'employee-001',
    providerCode: 'dingtalk',
    externalEventId: 'legacy-event-001',
    factType: 'shift',
    occurredAt: '2026-04-01T01:00:00.000Z',
    timeZone: 'Asia/Shanghai',
    impact: { workedMinutes: 480, leaveMinutes: 0, overtimeMinutes: 0, absentMinutes: 0 },
    sourceObservedAt: '2026-04-01T01:01:00.000Z',
    createdAt: '2026-04-01T01:02:00.000Z',
    migrationEvidenceRef,
    evidenceChecksum: 's'.repeat(43),
    ...overrides,
  };
}

function correctionMigrationInput(
  overrides: Partial<ImportAttendanceCorrectionFromMigrationInput> = {},
): ImportAttendanceCorrectionFromMigrationInput {
  return {
    targetId: null,
    employeeId: 'employee-001',
    sourceFactId: sourceFact().id,
    approvalHistoryId: 'approval-history-001',
    approvalEvidenceChecksum: 'a'.repeat(43),
    replacementImpact: {
      workedMinutes: 420, leaveMinutes: 60, overtimeMinutes: 0, absentMinutes: 0,
    },
    reasonCode: 'LEGACY_APPROVED',
    createdAt: '2026-04-01T02:01:00.000Z',
    migrationEvidenceRef: migrationEvidenceRef.replace('attendance-001', 'correction-001'),
    evidenceChecksum: 'c'.repeat(43),
    ...overrides,
  };
}

function monthMigrationInput(
  overrides: Partial<ImportAttendanceMonthFromMigrationInput> = {},
): ImportAttendanceMonthFromMigrationInput {
  return {
    targetId: null,
    employeeId: 'employee-001',
    month: '2026-04',
    snapshotVersion: 1,
    rulesetVersion: 'legacy-cn-v1',
    sourceCutoffAt: '2026-04-02T00:00:00.000Z',
    closedAt: '2026-04-02T00:01:00.000Z',
    previousSnapshotId: null,
    supersessionApprovalHistoryId: null,
    supersessionApprovalEvidenceChecksum: null,
    expectedImpact: {
      workedMinutes: 480, leaveMinutes: 0, overtimeMinutes: 0, absentMinutes: 0,
    },
    expectedSourceFactCount: 1,
    expectedCorrectionCount: 0,
    migrationEvidenceRef: migrationEvidenceRef.replace('attendance-001', 'month-001'),
    evidenceChecksum: 'm'.repeat(43),
    ...overrides,
  };
}

function migratedCorrection(
  input: ImportAttendanceCorrectionFromMigrationInput,
): AttendanceCorrection {
  return restoreAttendanceCorrectionFromMigration({
    id: input.targetId ?? 'correction-migrated-001',
    tenantId: tenant.tenantId,
    employeeId: input.employeeId,
    sourceFactId: input.sourceFactId,
    businessDate: sourceFact().businessDate,
    replacementImpact: input.replacementImpact,
    reasonCode: input.reasonCode,
    approvalReferenceType: 'legacy_history',
    approvalInstanceId: null,
    approvalHistoryId: input.approvalHistoryId,
    approvalEvidenceId: input.approvalHistoryId,
    approvedAt: '2026-04-01T02:00:00.000Z',
    createdAt: input.createdAt,
  }, new Date('2026-04-03T00:00:00.000Z'));
}

function migratedMonth(
  input: ImportAttendanceMonthFromMigrationInput,
  previous: AttendanceMonthlySnapshot | null = null,
): AttendanceMonthlySnapshot {
  return restoreAttendanceMonthFromMigration({
    id: input.targetId ?? 'snapshot-migrated-001',
    tenantId: tenant.tenantId,
    employeeId: input.employeeId,
    month: input.month,
    snapshotVersion: input.snapshotVersion,
    rulesetVersion: input.rulesetVersion,
    sourceCutoffAt: input.sourceCutoffAt,
    facts: [sourceFact()],
    corrections: [],
    previousSnapshotId: previous?.id ?? null,
    supersessionEvidenceId: input.supersessionApprovalHistoryId,
    closedAt: input.closedAt,
  }, new Date('2026-04-03T00:00:00.000Z'));
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
    verifyAttendanceMonthReopenMigrationReference: vi.fn(),
    createInstance: vi.fn(), submitInstance: vi.fn(),
  };
  const rules = {
    evaluateMonth: vi.fn((input: {
      readonly facts: readonly AttendanceSourceFact[];
      readonly corrections: readonly AttendanceCorrection[];
    }) => Promise.resolve({
      facts: input.facts,
      corrections: input.corrections,
      dailySummaries: [{
        businessDate: '2026-04-01',
        workedMinutes: 480,
        leaveMinutes: 0,
        overtimeMinutes: 0,
        absentMinutes: 0,
        sourceFactCount: input.facts.length,
        correctionCount: input.corrections.length,
        digest: 'd'.repeat(43),
      }],
    })),
  };
  const crypto = { sourceEventFingerprints: vi.fn().mockReturnValue(['key.digest']) };
  const facts = {
    findByEventFingerprints: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(sourceFact()),
    findForMonth: vi.fn().mockResolvedValue([sourceFact()]),
    findForRuleEvaluation: vi.fn().mockResolvedValue([sourceFact()]),
    insert: vi.fn().mockResolvedValue(undefined),
    insertMigrated: vi.fn().mockResolvedValue(undefined),
    findMigrationEvidenceById: vi.fn().mockResolvedValue(null),
  };
  const corrections = {
    findForMonth: vi.fn().mockResolvedValue([]), findBySourceFactId: vi.fn().mockResolvedValue(null),
    findForRuleEvaluation: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue(null),
    findMigrationEvidenceById: vi.fn().mockResolvedValue(null),
    insert: vi.fn().mockResolvedValue(undefined), insertMigrated: vi.fn().mockResolvedValue(undefined),
  };
  const snapshots = {
    findActive: vi.fn().mockResolvedValue(null), findById: vi.fn().mockResolvedValue(null),
    findMigrationEvidenceById: vi.fn().mockResolvedValue(null),
    activate: vi.fn().mockResolvedValue(undefined), activateMigrated: vi.fn().mockResolvedValue(undefined),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const service = new AttendanceApplicationService(
    idempotency as never, context, profiles as never, employees as never, approvals as never,
    rules as never, crypto as never, facts as never, corrections as never,
    snapshots as never, outbox as never,
  );
  return {
    service, context, idempotency, profiles, employees, approvals, rules, crypto,
    facts, corrections, snapshots, outbox,
  };
}

function runAs<T>(
  store: ReturnType<typeof assemble>,
  scopes: readonly string[],
  operation: () => Promise<T>,
  actorType: ActorContext['actorType'] = 'user',
): Promise<T> {
  return store.context.run({ tenant, actor: actor(scopes, actorType) }, operation);
}

const correctionRequest = {
  sourceFactId: '01J8ZQK7V0A2M4N6P8R0T2W4F1',
  replacementImpact: {
    workedMinutes: 420, leaveMinutes: 60, overtimeMinutes: 0, absentMinutes: 0,
  },
  reasonCode: 'MISSED_BREAK',
} as const;

const ingestInput = {
  employeeId: 'employee-001',
  providerCode: 'dingtalk',
  externalEventId: 'event-001',
  factType: 'shift' as const,
  occurredAt: '2026-04-01T01:00:00.000Z',
  timeZone: 'Asia/Shanghai',
  impact: { workedMinutes: 480, leaveMinutes: 0, overtimeMinutes: 0, absentMinutes: 0 },
  sourceObservedAt: '2026-04-01T01:01:00.000Z',
};

const closeMonthInput = {
  employeeId: 'employee-001',
  month: '2026-04',
  rulesetVersion: 'attendance-cn-v1',
  sourceCutoffAt: '2026-05-01T00:00:00.000Z',
};

const correctionDecision = {
  id: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
  completedAt: '2026-04-02T00:00:00.000Z',
  sourceFactId: '01J8ZQK7V0A2M4N6P8R0T2W4F1',
  employeeId: 'employee-001',
  businessDate: '2026-04-01',
  replacementImpact: {
    workedMinutes: 420, leaveMinutes: 60, overtimeMinutes: 0, absentMinutes: 0,
  },
  reasonCode: 'MISSED_BREAK',
  formDataHash: 'a'.repeat(43),
} as const;

describe('AttendanceApplicationService', () => {
  it('迁移月结从事实与修订重算并只发布专用安全事件', async () => {
    const store = assemble();
    store.corrections.findForMonth.mockResolvedValue([]);
    const result = await store.context.run({
      tenant,
      actor: actor(
        ['erp:migration:execute', 'erp:attendance:migration:write'], 'service',
      ),
    }, () => store.service.importMonthFromMigration('attendance-month-migration-001', {
      targetId: null, employeeId: 'employee-001', month: '2026-04', snapshotVersion: 1,
      rulesetVersion: 'legacy-cn-v1', sourceCutoffAt: '2026-04-02T00:00:00.000Z',
      closedAt: '2026-04-02T00:01:00.000Z', previousSnapshotId: null,
      supersessionApprovalHistoryId: null, supersessionApprovalEvidenceChecksum: null,
      expectedImpact: {
        workedMinutes: 480, leaveMinutes: 0, overtimeMinutes: 0, absentMinutes: 0,
      },
      expectedSourceFactCount: 1, expectedCorrectionCount: 0,
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/month-001',
      evidenceChecksum: 'm'.repeat(43),
    }));
    expect(store.snapshots.activateMigrated).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotVersion: 1, workedMinutes: 480,
        closedAt: '2026-04-02T00:01:00.000Z',
      }), null, expect.stringContaining('/attachments/month-001'), 'm'.repeat(43), session,
    );
    const event = store.outbox.append.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(event).toMatchObject({ type: 'attendance.month.migrated' });
    expect(JSON.stringify(event)).not.toMatch(/dailySummaries|workedMinutes|480/u);
    expect(result.month).toMatchObject({ version: 1, workedMinutes: 480 });
  });

  it('迁移月结 v2 精确校验直接前序与重开审批历史', async () => {
    const store = assemble();
    const previous = restoreAttendanceMonthFromMigration({
      id: 'snapshot-v1', tenantId: tenant.tenantId, employeeId: 'employee-001',
      month: '2026-04', snapshotVersion: 1, rulesetVersion: 'legacy-cn-v1',
      sourceCutoffAt: '2026-04-02T00:00:00.000Z', facts: [sourceFact()], corrections: [],
      previousSnapshotId: null, supersessionEvidenceId: null,
      closedAt: '2026-04-02T00:01:00.000Z',
    }, new Date('2026-04-03T00:00:00.000Z'));
    store.snapshots.findById.mockResolvedValue(previous);
    store.snapshots.findActive.mockResolvedValue(previous);
    store.approvals.verifyAttendanceMonthReopenMigrationReference.mockResolvedValue({
      id: 'approval-reopen-001', completedAt: '2026-04-02T01:00:00.000Z',
      evidenceChecksum: 'r'.repeat(43),
    });
    await store.context.run({
      tenant,
      actor: actor(
        ['erp:migration:execute', 'erp:attendance:migration:write'], 'service',
      ),
    }, () => store.service.importMonthFromMigration('attendance-month-migration-v2', {
      targetId: null, employeeId: 'employee-001', month: '2026-04', snapshotVersion: 2,
      rulesetVersion: 'legacy-cn-v2', sourceCutoffAt: '2026-04-03T00:00:00.000Z',
      closedAt: '2026-04-03T00:01:00.000Z', previousSnapshotId: previous.id,
      supersessionApprovalHistoryId: 'approval-reopen-001',
      supersessionApprovalEvidenceChecksum: 'r'.repeat(43),
      expectedImpact: {
        workedMinutes: 480, leaveMinutes: 0, overtimeMinutes: 0, absentMinutes: 0,
      }, expectedSourceFactCount: 1, expectedCorrectionCount: 0,
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/month-v2',
      evidenceChecksum: 'v'.repeat(43),
    }));
    expect(store.snapshots.activateMigrated).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotVersion: 2, previousSnapshotId: previous.id,
        supersessionEvidenceId: 'approval-reopen-001',
      }), previous, expect.any(String), 'v'.repeat(43), session,
    );
  });

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

  it('迁移写入要求服务身份、双 Scope 和精确 WORM 证据', async () => {
    const store = assemble();
    await expect(runAs(
      store,
      ['erp:migration:execute', 'erp:attendance:migration:write'],
      () => store.service.importSourceFactFromMigration('migration-auth-user', sourceMigrationInput()),
    )).rejects.toBeInstanceOf(ForbiddenException);
    await expect(runAs(
      store,
      ['erp:migration:execute'],
      () => store.service.importSourceFactFromMigration('migration-auth-scope', sourceMigrationInput()),
      'service',
    )).rejects.toBeInstanceOf(ForbiddenException);
    await expect(runAs(
      store,
      ['erp:migration:execute', 'erp:attendance:migration:write'],
      () => store.service.importSourceFactFromMigration(
        'migration-evidence-ref',
        sourceMigrationInput({ migrationEvidenceRef: 'https://example.invalid/evidence' }),
      ),
      'system_job',
    )).rejects.toBeInstanceOf(BadRequestException);
    await expect(runAs(
      store,
      ['erp:migration:execute', 'erp:attendance:migration:write'],
      () => store.service.importSourceFactFromMigration(
        'migration-evidence-hash',
        sourceMigrationInput({ evidenceChecksum: 'invalid' }),
      ),
      'service',
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(store.idempotency.execute).not.toHaveBeenCalled();
  });

  it('迁移源事实支持完全一致的不可变重放', async () => {
    const store = assemble();
    const input = sourceMigrationInput({ targetId: sourceFact().id });
    store.facts.findByEventFingerprints.mockResolvedValue(sourceFact());
    store.facts.findById.mockResolvedValue(sourceFact());
    store.facts.findMigrationEvidenceById.mockResolvedValue({
      migrationEvidenceRef: input.migrationEvidenceRef,
      migrationEvidenceChecksum: input.evidenceChecksum,
    });
    const result = await runAs(
      store,
      ['erp:migration:execute', 'erp:attendance:migration:write'],
      () => store.service.importSourceFactFromMigration('migration-source-replay', input),
      'service',
    );
    expect(result.fact).toEqual(expect.objectContaining({
      id: sourceFact().id,
      employeeId: 'employee-001',
      version: 1,
    }));
    expect(store.facts.insertMigrated).not.toHaveBeenCalled();
    expect(store.outbox.append).not.toHaveBeenCalled();
  });

  it('迁移源事实拒绝员工缺失、外部事件碰撞和重放证据漂移', async () => {
    const missingEmployee = assemble();
    missingEmployee.employees.findById.mockResolvedValue(null);
    await expect(runAs(
      missingEmployee,
      ['erp:migration:execute', 'erp:attendance:migration:write'],
      () => missingEmployee.service.importSourceFactFromMigration(
        'migration-source-employee',
        sourceMigrationInput(),
      ),
      'service',
    )).rejects.toBeInstanceOf(NotFoundException);

    const collision = assemble();
    collision.facts.findByEventFingerprints.mockResolvedValue(sourceFact());
    await expect(runAs(
      collision,
      ['erp:migration:execute', 'erp:attendance:migration:write'],
      () => collision.service.importSourceFactFromMigration(
        'migration-source-collision',
        sourceMigrationInput(),
      ),
      'service',
    )).rejects.toThrow('迁移外部事件已绑定既有考勤事实');

    const immutable = assemble();
    const input = sourceMigrationInput({ targetId: sourceFact().id });
    immutable.facts.findByEventFingerprints.mockResolvedValue(sourceFact());
    immutable.facts.findById.mockResolvedValue(sourceFact());
    immutable.facts.findMigrationEvidenceById.mockResolvedValue({
      migrationEvidenceRef: input.migrationEvidenceRef,
      migrationEvidenceChecksum: 'x'.repeat(43),
    });
    await expect(runAs(
      immutable,
      ['erp:migration:execute', 'erp:attendance:migration:write'],
      () => immutable.service.importSourceFactFromMigration('migration-source-immutable', input),
      'service',
    )).rejects.toThrow('既有考勤源事实、外部标识或 WORM 证据不一致');
  });

  it('迁移修订支持完全一致重放并拒绝无效审批摘要', async () => {
    const invalid = assemble();
    await expect(runAs(
      invalid,
      ['erp:migration:execute', 'erp:attendance:migration:write'],
      () => invalid.service.importCorrectionFromMigration(
        'migration-correction-hash',
        correctionMigrationInput({ approvalEvidenceChecksum: 'invalid' }),
      ),
      'service',
    )).rejects.toBeInstanceOf(BadRequestException);

    const store = assemble();
    const input = correctionMigrationInput({ targetId: 'correction-migrated-001' });
    const existing = migratedCorrection(input);
    store.approvals.verifyAttendanceCorrectionMigrationReference.mockResolvedValue({
      id: input.approvalHistoryId,
      completedAt: existing.approvedAt,
      evidenceChecksum: input.approvalEvidenceChecksum,
    });
    store.corrections.findBySourceFactId.mockResolvedValue(existing);
    store.corrections.findById.mockResolvedValue(existing);
    store.corrections.findMigrationEvidenceById.mockResolvedValue({
      migrationEvidenceRef: input.migrationEvidenceRef,
      migrationEvidenceChecksum: input.evidenceChecksum,
    });
    const result = await runAs(
      store,
      ['erp:migration:execute', 'erp:attendance:migration:write'],
      () => store.service.importCorrectionFromMigration('migration-correction-replay', input),
      'system_job',
    );
    expect(result.correction).toEqual(expect.objectContaining({
      id: existing.id,
      approvalReferenceType: 'legacy_history',
      approvalReferenceId: input.approvalHistoryId,
      version: 1,
    }));
    expect(store.corrections.insertMigrated).not.toHaveBeenCalled();
  });

  it('迁移修订拒绝源事实、员工、审批、碰撞或 WORM 绑定不一致', async () => {
    const run = async (
      mutate: (store: ReturnType<typeof assemble>, input: ImportAttendanceCorrectionFromMigrationInput) => void,
      expected: string,
      suffix: string,
      overrides: Partial<ImportAttendanceCorrectionFromMigrationInput> = {},
    ): Promise<void> => {
      const store = assemble();
      const input = correctionMigrationInput(overrides);
      store.approvals.verifyAttendanceCorrectionMigrationReference.mockResolvedValue({
        id: input.approvalHistoryId,
        completedAt: '2026-04-01T02:00:00.000Z',
        evidenceChecksum: input.approvalEvidenceChecksum,
      });
      mutate(store, input);
      await expect(runAs(
        store,
        ['erp:migration:execute', 'erp:attendance:migration:write'],
        () => store.service.importCorrectionFromMigration(`migration-correction-${suffix}`, input),
        'service',
      )).rejects.toThrow(expected);
    };

    await run(
      (store) => store.facts.findById.mockResolvedValue(null),
      '考勤修订引用的源事实不存在',
      'source',
    );
    await run(
      (store) => store.employees.findById.mockResolvedValue(null),
      '考勤修订员工映射与源事实不一致',
      'employee',
    );
    await run(
      (store) => store.approvals.verifyAttendanceCorrectionMigrationReference.mockResolvedValue({
        id: 'different-history',
        completedAt: '2026-04-01T02:00:00.000Z',
        evidenceChecksum: 'a'.repeat(43),
      }),
      '考勤修订审批历史或证据摘要不一致',
      'approval',
    );
    await run(
      (store) => store.corrections.findBySourceFactId.mockResolvedValue(migratedCorrection(
        correctionMigrationInput({ targetId: 'collision-correction' }),
      )),
      '考勤源事实已绑定既有修订',
      'collision',
    );
    await run(
      (store, input) => {
        const existing = migratedCorrection(input);
        store.corrections.findBySourceFactId.mockResolvedValue(existing);
        store.corrections.findById.mockResolvedValue(existing);
        store.corrections.findMigrationEvidenceById.mockResolvedValue({
          migrationEvidenceRef: input.migrationEvidenceRef,
          migrationEvidenceChecksum: 'x'.repeat(43),
        });
      },
      '既有考勤修订、审批或 WORM 证据不一致',
      'immutable',
      { targetId: 'correction-migrated-001' },
    );
  });

  it('迁移月结拒绝非法时间、员工缺失、首版伪造链和控制总量漂移', async () => {
    const invalidTime = assemble();
    await expect(runAs(
      invalidTime,
      ['erp:migration:execute', 'erp:attendance:migration:write'],
      () => invalidTime.service.importMonthFromMigration(
        'migration-month-time',
        monthMigrationInput({ sourceCutoffAt: '2026-04-02T00:00:00Z' }),
      ),
      'service',
    )).rejects.toThrow('考勤迁移时间必须为毫秒精度');

    const missingEmployee = assemble();
    missingEmployee.employees.findById.mockResolvedValue(null);
    await expect(runAs(
      missingEmployee,
      ['erp:migration:execute', 'erp:attendance:migration:write'],
      () => missingEmployee.service.importMonthFromMigration(
        'migration-month-employee',
        monthMigrationInput(),
      ),
      'service',
    )).rejects.toBeInstanceOf(NotFoundException);

    const forgedChain = assemble();
    await expect(runAs(
      forgedChain,
      ['erp:migration:execute', 'erp:attendance:migration:write'],
      () => forgedChain.service.importMonthFromMigration(
        'migration-month-chain',
        monthMigrationInput({ previousSnapshotId: 'snapshot-forged' }),
      ),
      'service',
    )).rejects.toThrow('考勤月结前序版本或重开审批链无效');

    const control = assemble();
    await expect(runAs(
      control,
      ['erp:migration:execute', 'erp:attendance:migration:write'],
      () => control.service.importMonthFromMigration(
        'migration-month-control',
        monthMigrationInput({
          expectedImpact: {
            workedMinutes: 479, leaveMinutes: 0, overtimeMinutes: 0, absentMinutes: 0,
          },
        }),
      ),
      'service',
    )).rejects.toThrow('考勤月结重算结果与来源控制总量不一致');
  });

  it('迁移月结 v2 对每个前序与审批约束失败关闭', async () => {
    const base = monthMigrationInput({
      snapshotVersion: 2,
      rulesetVersion: 'legacy-cn-v2',
      sourceCutoffAt: '2026-04-03T00:00:00.000Z',
      closedAt: '2026-04-03T00:01:00.000Z',
      previousSnapshotId: 'snapshot-v1',
      supersessionApprovalHistoryId: 'approval-reopen-001',
      supersessionApprovalEvidenceChecksum: 'r'.repeat(43),
    });
    const previous = restoreAttendanceMonthFromMigration({
      id: 'snapshot-v1',
      tenantId: tenant.tenantId,
      employeeId: 'employee-001',
      month: '2026-04',
      snapshotVersion: 1,
      rulesetVersion: 'legacy-cn-v1',
      sourceCutoffAt: '2026-04-02T00:00:00.000Z',
      facts: [sourceFact()],
      corrections: [],
      previousSnapshotId: null,
      supersessionEvidenceId: null,
      closedAt: '2026-04-02T00:01:00.000Z',
    }, new Date('2026-04-03T00:00:00.000Z'));
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly input?: Partial<ImportAttendanceMonthFromMigrationInput>;
      readonly previous?: AttendanceMonthlySnapshot | null;
      readonly approval?: Readonly<Record<string, unknown>>;
    }> = [
      { name: '缺少前序', input: { previousSnapshotId: null } },
      { name: '前序不存在', previous: null },
      { name: '前序员工', previous: { ...previous, employeeId: 'employee-999' } },
      { name: '前序月份', previous: { ...previous, month: '2026-03' } },
      { name: '前序版本', previous: { ...previous, snapshotVersion: 0 } },
      { name: '审批标识', approval: {
        id: 'approval-other', completedAt: '2026-04-02T01:00:00.000Z',
        evidenceChecksum: 'r'.repeat(43),
      } },
      { name: '审批摘要', approval: {
        id: 'approval-reopen-001', completedAt: '2026-04-02T01:00:00.000Z',
        evidenceChecksum: 'x'.repeat(43),
      } },
      { name: '审批早于前序', approval: {
        id: 'approval-reopen-001', completedAt: '2026-04-01T00:00:00.000Z',
        evidenceChecksum: 'r'.repeat(43),
      } },
      { name: '审批晚于关账', approval: {
        id: 'approval-reopen-001', completedAt: '2026-04-04T00:00:00.000Z',
        evidenceChecksum: 'r'.repeat(43),
      } },
      { name: '截止倒退', input: { sourceCutoffAt: '2026-04-01T00:00:00.000Z' } },
      { name: '关账倒退', input: { closedAt: '2026-04-01T00:00:00.000Z' } },
    ];
    for (const item of cases) {
      const store = assemble();
      store.snapshots.findById.mockResolvedValue(
        item.previous === undefined ? previous : item.previous,
      );
      store.approvals.verifyAttendanceMonthReopenMigrationReference.mockResolvedValue(
        item.approval ?? {
          id: 'approval-reopen-001',
          completedAt: '2026-04-02T01:00:00.000Z',
          evidenceChecksum: 'r'.repeat(43),
        },
      );
      await expect(runAs(
        store,
        ['erp:migration:execute', 'erp:attendance:migration:write'],
        () => store.service.importMonthFromMigration(
          `migration-month-v2-${item.name}`,
          { ...base, ...item.input },
        ),
        'service',
      ), item.name).rejects.toThrow('考勤月结前序版本或重开审批链无效');
    }
  });

  it('迁移月结支持完全一致重放并拒绝活动版本链冲突', async () => {
    const replay = assemble();
    const input = monthMigrationInput({ targetId: 'snapshot-migrated-001' });
    const existing = migratedMonth(input);
    replay.snapshots.findById.mockResolvedValue(existing);
    replay.snapshots.findMigrationEvidenceById.mockResolvedValue({
      migrationEvidenceRef: input.migrationEvidenceRef,
      migrationEvidenceChecksum: input.evidenceChecksum,
    });
    const result = await runAs(
      replay,
      ['erp:migration:execute', 'erp:attendance:migration:write'],
      () => replay.service.importMonthFromMigration('migration-month-replay', input),
      'service',
    );
    expect(result.month).toEqual(expect.objectContaining({
      id: existing.id,
      snapshotHash: existing.snapshotHash,
      version: 1,
    }));
    expect(replay.snapshots.activateMigrated).not.toHaveBeenCalled();

    const immutable = assemble();
    immutable.snapshots.findById.mockResolvedValue(existing);
    immutable.snapshots.findMigrationEvidenceById.mockResolvedValue({
      migrationEvidenceRef: input.migrationEvidenceRef,
      migrationEvidenceChecksum: 'x'.repeat(43),
    });
    await expect(runAs(
      immutable,
      ['erp:migration:execute', 'erp:attendance:migration:write'],
      () => immutable.service.importMonthFromMigration('migration-month-immutable', input),
      'service',
    )).rejects.toThrow('既有考勤月结、重开审批或 WORM 证据不一致');

    const chain = assemble();
    chain.snapshots.findActive.mockResolvedValue(existing);
    await expect(runAs(
      chain,
      ['erp:migration:execute', 'erp:attendance:migration:write'],
      () => chain.service.importMonthFromMigration(
        'migration-month-active-chain',
        monthMigrationInput(),
      ),
      'service',
    )).rejects.toThrow('考勤月结活动版本与迁移版本链不一致');
  });

  it('修订预校验只允许本人且拒绝已生效修订', async () => {
    const success = assemble();
    const result = await runAs(
      success,
      ['erp:attendance:correction:request'],
      () => success.service.validateCorrectionRequest(correctionRequest),
    );
    expect(result).toEqual(expect.objectContaining({
      id: sourceFact().id,
      employeeId: 'employee-001',
    }));

    const existing = assemble();
    existing.corrections.findBySourceFactId.mockResolvedValue({ id: 'correction-001' });
    await expect(runAs(
      existing,
      ['erp:attendance:correction:request'],
      () => existing.service.validateCorrectionRequest(correctionRequest),
    )).rejects.toThrow('该源事实已有生效修订');
  });

  it('修订请求拒绝缺失 Scope、身份、源事实、他人事实与非法载荷', async () => {
    const noScope = assemble();
    await expect(runAs(
      noScope,
      [],
      () => noScope.service.requestCorrection('request-no-scope', correctionRequest),
    )).rejects.toBeInstanceOf(ForbiddenException);
    await expect(runAs(
      noScope,
      ['erp:attendance:correction:request'],
      () => noScope.service.requestCorrection('request-no-approval-scope', correctionRequest),
    )).rejects.toBeInstanceOf(ForbiddenException);

    const noProfile = assemble();
    noProfile.profiles.resolveActive.mockResolvedValue(null);
    await expect(runAs(
      noProfile,
      ['erp:attendance:correction:request', 'erp:approval:instance:submit'],
      () => noProfile.service.requestCorrection('request-no-profile', correctionRequest),
    )).rejects.toThrow('当前主体未绑定有效 ERP 员工身份');

    const noSource = assemble();
    noSource.facts.findById.mockResolvedValue(null);
    await expect(runAs(
      noSource,
      ['erp:attendance:correction:request', 'erp:approval:instance:submit'],
      () => noSource.service.requestCorrection('request-no-source', correctionRequest),
    )).rejects.toBeInstanceOf(NotFoundException);

    const otherEmployee = assemble();
    otherEmployee.profiles.resolveActive.mockResolvedValue({ employeeId: 'employee-999' });
    await expect(runAs(
      otherEmployee,
      ['erp:attendance:correction:request', 'erp:approval:instance:submit'],
      () => otherEmployee.service.requestCorrection('request-other-employee', correctionRequest),
    )).rejects.toThrow('只能为本人考勤事实发起修订');

    const invalidPayload = assemble();
    await expect(runAs(
      invalidPayload,
      ['erp:attendance:correction:request', 'erp:approval:instance:submit'],
      () => invalidPayload.service.requestCorrection('request-invalid-payload', {
        ...correctionRequest,
        reasonCode: 'invalid',
      }),
    )).rejects.toThrow('考勤修订原因码非法');
  });

  it('修订请求只接受 running 或 approved 审批状态', async () => {
    const invalid = assemble();
    invalid.approvals.createInstance.mockResolvedValue({
      instance: { id: 'approval-created', version: 1 },
    });
    invalid.approvals.submitInstance.mockResolvedValue({
      instance: { id: 'approval-created', status: 'draft', version: 2 },
    });
    await expect(runAs(
      invalid,
      ['erp:attendance:correction:request', 'erp:approval:instance:submit'],
      () => invalid.service.requestCorrection('request-invalid-state', correctionRequest),
    )).rejects.toThrow('考勤修订审批未进入可处理状态');

    const approved = assemble();
    approved.approvals.createInstance.mockResolvedValue({
      instance: { id: 'approval-created', version: 1 },
    });
    approved.approvals.submitInstance.mockResolvedValue({
      instance: { id: 'approval-created', status: 'approved', version: 2 },
    });
    const result = await runAs(
      approved,
      ['erp:attendance:correction:request', 'erp:approval:instance:submit'],
      () => approved.service.requestCorrection('request-approved', correctionRequest),
    );
    expect(result.request.approvalStatus).toBe('approved');
  });

  it('源事实写入支持系统主体、稳定重放并拒绝碰撞与缺失员工', async () => {
    const inserted = assemble();
    const result = await runAs(
      inserted,
      ['erp:attendance:source:ingest'],
      () => inserted.service.ingest('ingest-success', ingestInput),
      'system_job',
    );
    expect(result.fact).toEqual(expect.objectContaining({
      employeeId: 'employee-001',
      providerCode: 'dingtalk',
      factType: 'shift',
    }));
    expect(inserted.facts.insert).toHaveBeenCalledWith(
      expect.objectContaining({ businessDate: '2026-04-01' }),
      ['key.digest'],
      session,
    );

    const replay = assemble();
    replay.facts.findByEventFingerprints.mockResolvedValue(sourceFact());
    const replayResult = await runAs(
      replay,
      ['erp:attendance:source:ingest'],
      () => replay.service.ingest('ingest-replay', ingestInput),
      'service',
    );
    expect(replayResult.fact.id).toBe(sourceFact().id);
    expect(replay.facts.insert).not.toHaveBeenCalled();

    const collision = assemble();
    collision.facts.findByEventFingerprints.mockResolvedValue({
      ...sourceFact(),
      employeeId: 'employee-999',
    });
    await expect(runAs(
      collision,
      ['erp:attendance:source:ingest'],
      () => collision.service.ingest('ingest-collision', ingestInput),
      'service',
    )).rejects.toThrow('外部事件已绑定到不同考勤事实');

    const missing = assemble();
    missing.employees.findById.mockResolvedValue(null);
    await expect(runAs(
      missing,
      ['erp:attendance:source:ingest'],
      () => missing.service.ingest('ingest-no-employee', ingestInput),
      'service',
    )).rejects.toBeInstanceOf(NotFoundException);
  });

  it('源事实写入映射时间、领域和唯一键异常', async () => {
    const invalidTime = assemble();
    await expect(runAs(
      invalidTime,
      ['erp:attendance:source:ingest'],
      () => invalidTime.service.ingest('ingest-time', {
        ...ingestInput,
        occurredAt: 'not-an-instant',
      }),
      'service',
    )).rejects.toBeInstanceOf(BadRequestException);

    const domain = assemble();
    await expect(runAs(
      domain,
      ['erp:attendance:source:ingest'],
      () => domain.service.ingest('ingest-domain', {
        ...ingestInput,
        impact: { ...ingestInput.impact, workedMinutes: -1 },
      }),
      'service',
    )).rejects.toBeInstanceOf(BadRequestException);

    const duplicate = assemble();
    duplicate.facts.insert.mockRejectedValue({ code: 11_000 });
    await expect(runAs(
      duplicate,
      ['erp:attendance:source:ingest'],
      () => duplicate.service.ingest('ingest-duplicate', ingestInput),
      'service',
    )).rejects.toBeInstanceOf(ConflictException);
  });

  it('登记修订拒绝缺失源事实并映射唯一键冲突', async () => {
    const missing = assemble();
    missing.approvals.getAttendanceCorrectionDecision.mockResolvedValue(correctionDecision);
    missing.facts.findById.mockResolvedValue(null);
    await expect(runAs(
      missing,
      ['erp:attendance:correction:attest'],
      () => missing.service.registerCorrection('register-missing', {
        approvalInstanceId: correctionDecision.id,
      }),
    )).rejects.toBeInstanceOf(NotFoundException);

    const duplicate = assemble();
    duplicate.approvals.getAttendanceCorrectionDecision.mockResolvedValue(correctionDecision);
    duplicate.corrections.insert.mockRejectedValue({ code: 11_000 });
    await expect(runAs(
      duplicate,
      ['erp:attendance:correction:attest'],
      () => duplicate.service.registerCorrection('register-duplicate', {
        approvalInstanceId: correctionDecision.id,
      }),
    )).rejects.toThrow('考勤外部事件、修订审批或月结版本已存在');
  });

  it('首次月结成功且禁止伪造重开审批', async () => {
    const first = assemble();
    const result = await runAs(
      first,
      ['erp:attendance:month:close'],
      () => first.service.closeMonth('close-first', closeMonthInput),
    );
    expect(result.month).toEqual(expect.objectContaining({
      employeeId: 'employee-001',
      month: '2026-04',
      snapshotVersion: 1,
      workedMinutes: 480,
    }));
    expect(first.snapshots.activate).toHaveBeenCalledWith(
      expect.objectContaining({ previousSnapshotId: null }),
      null,
      session,
    );
    expect(first.outbox.append).toHaveBeenCalledTimes(1);

    const forged = assemble();
    await expect(runAs(
      forged,
      ['erp:attendance:month:close'],
      () => forged.service.closeMonth('close-forged', {
        ...closeMonthInput,
        supersessionApprovalInstanceId: 'approval-forged',
      }),
    )).rejects.toThrow('首次关账不得伪造重开审批链');
  });

  it('月结重开生成连续版本和成对事件', async () => {
    const store = assemble();
    const current = migratedMonth(monthMigrationInput({ targetId: 'snapshot-v1' }));
    store.snapshots.findActive.mockResolvedValue(current);
    store.approvals.getAttendanceMonthReopenDecision.mockResolvedValue({
      id: 'approval-reopen-001',
      completedAt: '2026-05-01T01:00:00.000Z',
      employeeId: 'employee-001',
      month: '2026-04',
      previousSnapshotId: current.id,
      formDataHash: 'r'.repeat(43),
    });
    const result = await runAs(
      store,
      ['erp:attendance:month:close'],
      () => store.service.closeMonth('close-reopen', {
        ...closeMonthInput,
        supersessionApprovalInstanceId: 'approval-reopen-001',
      }),
    );
    expect(result.month).toEqual(expect.objectContaining({
      snapshotVersion: 2,
      correctionCount: 0,
    }));
    expect(store.snapshots.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        previousSnapshotId: current.id,
        supersessionEvidenceId: 'approval-reopen-001',
      }),
      current,
      session,
    );
    expect(store.outbox.append).toHaveBeenCalledTimes(2);
    const eventTypes = store.outbox.append.mock.calls.map((call) => {
      const event = call[0] as unknown as { readonly type: string };
      return event.type;
    });
    expect(eventTypes).toEqual([
      'attendance.month.superseded',
      'attendance.month.closed',
    ]);
  });

  it('月结拒绝员工缺失、并发状态变化、非法时间和快照写冲突', async () => {
    const employee = assemble();
    employee.employees.findById.mockResolvedValue(null);
    await expect(runAs(
      employee,
      ['erp:attendance:month:close'],
      () => employee.service.closeMonth('close-no-employee', closeMonthInput),
    )).rejects.toBeInstanceOf(NotFoundException);

    const changed = assemble();
    changed.snapshots.findActive
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'snapshot-concurrent', snapshotVersion: 1 });
    await expect(runAs(
      changed,
      ['erp:attendance:month:close'],
      () => changed.service.closeMonth('close-changed', closeMonthInput),
    )).rejects.toThrow('考勤月结状态已变化');

    const invalidTime = assemble();
    await expect(runAs(
      invalidTime,
      ['erp:attendance:month:close'],
      () => invalidTime.service.closeMonth('close-time', {
        ...closeMonthInput,
        sourceCutoffAt: 'invalid',
      }),
    )).rejects.toBeInstanceOf(BadRequestException);

    const writeConflict = assemble();
    writeConflict.snapshots.activate.mockRejectedValue(
      new Error('ATTENDANCE_SNAPSHOT_WRITE_CONFLICT'),
    );
    await expect(runAs(
      writeConflict,
      ['erp:attendance:month:close'],
      () => writeConflict.service.closeMonth('close-write-conflict', closeMonthInput),
    )).rejects.toThrow('考勤月结并发版本冲突');
  });

  it('月结将越界事实与截止时间领域异常映射为冲突', async () => {
    const outOfScope = assemble();
    outOfScope.facts.findForRuleEvaluation.mockResolvedValue([{
      ...sourceFact(),
      employeeId: 'employee-999',
    }]);
    await expect(runAs(
      outOfScope,
      ['erp:attendance:month:close'],
      () => outOfScope.service.closeMonth('close-out-of-scope', closeMonthInput),
    )).rejects.toBeInstanceOf(ForbiddenException);

    const afterCutoff = assemble();
    afterCutoff.facts.findForRuleEvaluation.mockResolvedValue([{
      ...sourceFact(),
      sourceObservedAt: '2026-06-01T00:00:00.000Z',
    }]);
    await expect(runAs(
      afterCutoff,
      ['erp:attendance:month:close'],
      () => afterCutoff.service.closeMonth('close-after-cutoff', closeMonthInput),
    )).rejects.toBeInstanceOf(ConflictException);
  });

  it('本人月结读取拒绝缺失 Scope、员工身份或活动快照', async () => {
    const noScope = assemble();
    await expect(runAs(
      noScope,
      [],
      () => noScope.service.getMyMonth('2026-04'),
    )).rejects.toBeInstanceOf(ForbiddenException);

    const noProfile = assemble();
    noProfile.profiles.resolveActive.mockResolvedValue(null);
    await expect(runAs(
      noProfile,
      ['erp:attendance:month:read_self'],
      () => noProfile.service.getMyMonth('2026-04'),
    )).rejects.toThrow('当前主体未绑定有效 ERP 员工身份');

    const noSnapshot = assemble();
    await expect(runAs(
      noSnapshot,
      ['erp:attendance:month:read_self'],
      () => noSnapshot.service.getMyMonth('2026-04'),
    )).rejects.toBeInstanceOf(NotFoundException);
  });
});
