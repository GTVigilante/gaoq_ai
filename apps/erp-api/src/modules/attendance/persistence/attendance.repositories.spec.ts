import { randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  restoreAttendanceCorrectionFromMigration,
  restoreAttendanceMonthFromMigration,
  createAttendanceShiftPlan,
  restoreAttendanceSourceFactFromMigration,
} from '../domain/index.js';
import { AttendanceDataCryptoService } from './attendance-data-crypto.service.js';
import {
  AttendanceCorrectionRepository,
  AttendanceMonthlySnapshotRepository,
  AttendanceShiftPlanRepository,
  AttendanceSourceFactRepository,
} from './attendance.repositories.js';
import type {
  AttendanceCorrectionDocument,
  AttendanceMonthlySnapshotDocument,
  AttendanceShiftPlanDocument,
  AttendanceSourceFactDocument,
} from './attendance.schemas.js';

function crypto(): AttendanceDataCryptoService {
  return new AttendanceDataCryptoService(new ConfigService<AppEnvironment, true>({
    ATTENDANCE_DATA_ENCRYPTION_KEYS: JSON.stringify({
      activeKeyId: 'attendance-key-001',
      keys: [{
        keyId: 'attendance-key-001', keyBase64url: randomBytes(32).toString('base64url'),
        status: 'active',
      }],
    }),
    ATTENDANCE_BLIND_INDEX_KEYS: JSON.stringify({
      activeKeyId: 'attendance-blind-001',
      keys: [{
        keyId: 'attendance-blind-001', keyBase64url: randomBytes(32).toString('base64url'),
        status: 'active',
      }],
    }),
  } as AppEnvironment));
}

function context(): TenantContextService {
  return {
    getTenantRequired: vi.fn().mockReturnValue({ tenantId: 'tenant-001' }),
  } as unknown as TenantContextService;
}

function query<T>(resolve: () => T | Promise<T>) {
  const value = {
    session: vi.fn(), sort: vi.fn(), lean: vi.fn(), select: vi.fn(),
    exec: vi.fn(async () => resolve()),
  };
  value.session.mockReturnValue(value);
  value.sort.mockReturnValue(value);
  value.lean.mockReturnValue(value);
  value.select.mockReturnValue(value);
  return value;
}

function modelHarness() {
  let one: unknown = null;
  let many: readonly unknown[] = [];
  const queries: ReturnType<typeof query>[] = [];
  const model = {
    create: vi.fn().mockResolvedValue(undefined),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
    findOne: vi.fn().mockImplementation(() => {
      const current = query(() => one);
      queries.push(current);
      return current;
    }),
    find: vi.fn().mockImplementation(() => {
      const current = query(() => many);
      queries.push(current);
      return current;
    }),
  };
  return {
    model,
    queries,
    setOne: (value: unknown) => { one = value; },
    setMany: (value: readonly unknown[]) => { many = value; },
  };
}

function sourceFact() {
  return restoreAttendanceSourceFactFromMigration({
    id: 'fact-legacy-001', tenantId: 'tenant-001', employeeId: 'employee-001',
    providerCode: 'legacy_hr', factType: 'shift',
    occurredAt: '2026-04-01T01:00:00.000Z', timeZone: 'Asia/Shanghai',
    impact: { workedMinutes: 480, leaveMinutes: 0, overtimeMinutes: 0, absentMinutes: 0 },
    sourceObservedAt: '2026-04-01T01:01:00.000Z',
    createdAt: '2026-04-01T01:02:00.000Z',
  }, new Date('2026-04-02T00:00:00.000Z'));
}

function correction() {
  return restoreAttendanceCorrectionFromMigration({
    id: 'correction-legacy-001', tenantId: 'tenant-001', employeeId: 'employee-001',
    sourceFactId: 'fact-legacy-001', businessDate: '2026-04-01',
    replacementImpact: {
      workedMinutes: 420, leaveMinutes: 60, overtimeMinutes: 0, absentMinutes: 0,
    },
    reasonCode: 'LEGACY_APPROVED', approvalReferenceType: 'legacy_history',
    approvalInstanceId: null, approvalHistoryId: 'approval-history-001',
    approvalEvidenceId: 'approval-history-001', approvedAt: '2026-04-01T02:00:00.000Z',
    createdAt: '2026-04-01T02:01:00.000Z',
  }, new Date('2026-04-02T00:00:00.000Z'));
}

function shiftPlan() {
  return createAttendanceShiftPlan({
    id: 'shift-plan-001',
    tenantId: 'tenant-001',
    employeeId: 'employee-001',
    providerCode: 'dingtalk',
    planCode: 'CN-SH-DAY',
    businessDate: '2026-04-01',
    timeZone: 'Asia/Shanghai',
    scheduledStartAt: '2026-04-01T01:00:00.000Z',
    scheduledEndAt: '2026-04-01T10:00:00.000Z',
    breakMinutes: 60,
    graceMinutes: 5,
    earlyArrivalWindowMinutes: 120,
    lateDepartureWindowMinutes: 180,
    rulesetVersion: 'cn-sh-2026-v1',
    sourceObservedAt: '2026-03-31T08:00:00.000Z',
  }, new Date('2026-03-31T08:01:00.000Z'));
}

function snapshot() {
  return restoreAttendanceMonthFromMigration({
    id: 'snapshot-legacy-001', tenantId: 'tenant-001', employeeId: 'employee-001',
    month: '2026-04', snapshotVersion: 1, rulesetVersion: 'legacy-cn-v1',
    sourceCutoffAt: '2026-04-02T00:00:00.000Z', facts: [sourceFact()], corrections: [],
    previousSnapshotId: null, supersessionEvidenceId: null,
    closedAt: '2026-04-02T00:01:00.000Z',
  }, new Date('2026-04-03T00:00:00.000Z'));
}

const session = { id: 'session' } as unknown as ClientSession;

describe('AttendanceSourceFactRepository', () => {
  it('迁移源事实只把密文、盲索引和 WORM 控制字段交给 Mongo', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const repository = new AttendanceSourceFactRepository(
      context(), { create } as unknown as Model<AttendanceSourceFactDocument>, crypto(),
    );
    const fact = restoreAttendanceSourceFactFromMigration({
      id: 'fact-legacy-001', tenantId: 'tenant-001', employeeId: 'employee-001',
      providerCode: 'legacy_hr', factType: 'shift',
      occurredAt: '2026-04-01T01:00:00.000Z', timeZone: 'Asia/Shanghai',
      impact: { workedMinutes: 480, leaveMinutes: 0, overtimeMinutes: 0, absentMinutes: 0 },
      sourceObservedAt: '2026-04-01T01:01:00.000Z',
      createdAt: '2026-04-01T01:02:00.000Z',
    }, new Date('2026-04-02T00:00:00.000Z'));
    await repository.insertMigrated(
      fact, ['attendance-blind-001.digest'],
      'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/attendance-001',
      'd'.repeat(43), { id: 'session' } as never,
    );
    const records = create.mock.calls[0]?.[0] as unknown as readonly Record<string, unknown>[];
    expect(records[0]).toMatchObject({
      sourceEventBlindIndexes: ['attendance-blind-001.digest'],
      migrationEvidenceChecksum: 'd'.repeat(43), dataKeyId: 'attendance-key-001',
    });
    expect(records[0]).not.toHaveProperty('occurredAt');
    expect(records[0]).not.toHaveProperty('timeZone');
    expect(records[0]).not.toHaveProperty('impact');
    expect(records[0]).not.toHaveProperty('workedMinutes');
  });

  it('迁移修订只把密文和 WORM 控制字段交给 Mongo', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const repository = new AttendanceCorrectionRepository(
      context(), { create } as unknown as Model<AttendanceCorrectionDocument>, crypto(),
    );
    const correction = restoreAttendanceCorrectionFromMigration({
      id: 'correction-legacy-001', tenantId: 'tenant-001', employeeId: 'employee-001',
      sourceFactId: 'fact-legacy-001', businessDate: '2026-04-01',
      replacementImpact: {
        workedMinutes: 420, leaveMinutes: 60, overtimeMinutes: 0, absentMinutes: 0,
      },
      reasonCode: 'LEGACY_APPROVED', approvalReferenceType: 'legacy_history',
      approvalInstanceId: null, approvalHistoryId: 'approval-history-001',
      approvalEvidenceId: 'approval-history-001', approvedAt: '2026-04-01T02:00:00.000Z',
      createdAt: '2026-04-01T02:01:00.000Z',
    }, new Date('2026-04-02T00:00:00.000Z'));
    await repository.insertMigrated(
      correction,
      'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/correction-001',
      'd'.repeat(43), { id: 'session' } as never,
    );
    const records = create.mock.calls[0]?.[0] as unknown as readonly Record<string, unknown>[];
    expect(records[0]).toMatchObject({
      approvalReferenceType: 'legacy_history', approvalInstanceId: null,
      approvalHistoryId: 'approval-history-001', migrationEvidenceChecksum: 'd'.repeat(43),
      dataKeyId: 'attendance-key-001',
    });
    expect(records[0]).not.toHaveProperty('replacementImpact');
    expect(records[0]).not.toHaveProperty('workedMinutes');
    expect(records[0]).not.toHaveProperty('reasonCode');
  });

  it('迁移月结加密逐日明细并保存 WORM 控制字段', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const repository = new AttendanceMonthlySnapshotRepository(
      context(), { create } as unknown as Model<AttendanceMonthlySnapshotDocument>, crypto(),
    );
    const fact = restoreAttendanceSourceFactFromMigration({
      id: 'fact-legacy-001', tenantId: 'tenant-001', employeeId: 'employee-001',
      providerCode: 'legacy_hr', factType: 'shift',
      occurredAt: '2026-04-01T01:00:00.000Z', timeZone: 'Asia/Shanghai',
      impact: { workedMinutes: 480, leaveMinutes: 0, overtimeMinutes: 0, absentMinutes: 0 },
      sourceObservedAt: '2026-04-01T01:01:00.000Z',
      createdAt: '2026-04-01T01:02:00.000Z',
    }, new Date('2026-04-02T00:00:00.000Z'));
    const snapshot = restoreAttendanceMonthFromMigration({
      id: 'snapshot-legacy-001', tenantId: 'tenant-001', employeeId: 'employee-001',
      month: '2026-04', snapshotVersion: 1, rulesetVersion: 'legacy-cn-v1',
      sourceCutoffAt: '2026-04-02T00:00:00.000Z', facts: [fact], corrections: [],
      previousSnapshotId: null, supersessionEvidenceId: null,
      closedAt: '2026-04-02T00:01:00.000Z',
    }, new Date('2026-04-03T00:00:00.000Z'));
    await repository.activateMigrated(
      snapshot, null,
      'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/month-001',
      'm'.repeat(43), { id: 'session' } as never,
    );
    const records = create.mock.calls[0]?.[0] as unknown as readonly Record<string, unknown>[];
    expect(records[0]).toMatchObject({
      migrationEvidenceChecksum: 'm'.repeat(43), dataKeyId: 'attendance-key-001',
      workedMinutes: 480,
    });
    expect(records[0]).not.toHaveProperty('dailySummaries');
  });
});

describe('Attendance 仓储读写与租户边界', () => {
  it('源事实支持受租户约束的写入、按标识/盲索引/月读取与空结果', async () => {
    const harness = modelHarness();
    const repository = new AttendanceSourceFactRepository(
      context(), harness.model as unknown as Model<AttendanceSourceFactDocument>, crypto(),
    );
    const fact = sourceFact();
    await repository.insert(fact, ['attendance-blind-001.digest'], session);
    const documents = harness.model.create.mock.calls[0]?.[0] as readonly Record<string, unknown>[];
    const record = documents[0];
    expect(record).toMatchObject({
      migrationEvidenceRef: null, migrationEvidenceChecksum: null,
      sourceEventBlindIndexes: ['attendance-blind-001.digest'],
    });

    harness.setOne(record);
    await expect(repository.findById(fact.id, session)).resolves.toEqual(fact);
    expect(harness.queries.at(-1)?.session).toHaveBeenCalledWith(session);
    await expect(repository.findByEventFingerprints(
      ['attendance-blind-001.digest'],
    )).resolves.toEqual(fact);
    expect(harness.queries.at(-1)?.session).not.toHaveBeenCalled();

    harness.setMany([record]);
    const monthly = await repository.findForMonth(
      fact.employeeId, '2026-04', new Date('2026-04-30T23:59:59.999Z'), session,
    );
    expect(monthly).toEqual([fact]);
    expect(Object.isFrozen(monthly)).toBe(true);
    expect(harness.model.find).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-001', employeeId: fact.employeeId,
      businessDate: { $gte: '2026-04-01', $lte: '2026-04-31' },
    }));
    const ruleEvaluation = await repository.findForRuleEvaluation(
      fact.employeeId,
      '2026-04',
      new Date('2026-05-01T00:30:00.000Z'),
      session,
    );
    expect(ruleEvaluation).toEqual([fact]);
    expect(harness.model.find).toHaveBeenLastCalledWith(expect.objectContaining({
      tenantId: 'tenant-001',
      employeeId: fact.employeeId,
      businessDate: { $gte: '2026-04-01', $lte: '2026-05-01' },
    }));

    harness.setOne(null);
    await expect(repository.findById('missing')).resolves.toBeNull();
    await expect(repository.findByEventFingerprints(['missing'], session)).resolves.toBeNull();
  });

  it('源事实按班次和跨日打卡范围读取并保持租户与类型白名单', async () => {
    const harness = modelHarness();
    const repository = new AttendanceSourceFactRepository(
      context(), harness.model as unknown as Model<AttendanceSourceFactDocument>, crypto(),
    );

    harness.setOne(null);
    await expect(repository.findByShiftPlanId('shift-plan-001'))
      .resolves.toBeNull();
    await expect(repository.findByShiftPlanId('shift-plan-001', session))
      .resolves.toBeNull();
    harness.setMany([]);
    await expect(repository.findPunchesForDateRange(
      'employee-001',
      '2026-03-31',
      '2026-04-02',
      session,
    )).resolves.toEqual([]);
    expect(harness.model.findOne).toHaveBeenLastCalledWith({
      tenantId: 'tenant-001',
      shiftPlanId: 'shift-plan-001',
    });
    expect(harness.model.find).toHaveBeenLastCalledWith({
      tenantId: 'tenant-001',
      employeeId: 'employee-001',
      businessDate: { $gte: '2026-03-31', $lte: '2026-04-02' },
      factType: { $in: ['punch_in', 'punch_out'] },
    });
  });

  it('班次计划支持加密写入、受控查询、幂等求值检查点与租户拒绝', async () => {
    const harness = modelHarness();
    const repository = new AttendanceShiftPlanRepository(
      context(), harness.model as unknown as Model<AttendanceShiftPlanDocument>, crypto(),
    );
    const plan = shiftPlan();

    await repository.insert(plan, ['attendance-blind-001.shift'], session);
    const documents = harness.model.create.mock.calls[0]?.[0] as
      readonly Record<string, unknown>[];
    const record = documents[0];
    expect(record).toMatchObject({
      id: plan.id,
      sourcePlanBlindIndexes: ['attendance-blind-001.shift'],
      evaluationStatus: 'pending',
      evaluatedAt: null,
      evaluatedSourceFactId: null,
    });
    expect(record).not.toHaveProperty('timeZone');
    expect(record).not.toHaveProperty('scheduledStartAt');

    harness.setOne(record);
    await expect(repository.findById(plan.id, session)).resolves.toEqual(plan);
    expect(harness.queries.at(-1)?.session).toHaveBeenCalledWith(session);
    await expect(repository.findByEventFingerprints(
      ['attendance-blind-001.shift'],
    )).resolves.toEqual(plan);
    expect(harness.queries.at(-1)?.session).not.toHaveBeenCalled();

    harness.setMany([record]);
    const monthly = await repository.findForMonth(
      plan.employeeId,
      '2026-04',
      new Date('2026-04-30T23:59:59.999Z'),
      session,
    );
    expect(monthly).toEqual([plan]);
    expect(Object.isFrozen(monthly)).toBe(true);
    const nearby = await repository.findNearBusinessDate(
      plan.employeeId,
      '2026-03-31',
      '2026-04-02',
      session,
    );
    expect(nearby).toEqual([plan]);
    expect(harness.model.find).toHaveBeenLastCalledWith({
      tenantId: 'tenant-001',
      employeeId: plan.employeeId,
      businessDate: { $gte: '2026-03-31', $lte: '2026-04-02' },
    });

    await repository.markEvaluated(
      plan.id,
      'fact-001',
      new Date('2026-04-01T10:05:00.000Z'),
      session,
    );
    expect(harness.model.updateOne).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-001',
        id: plan.id,
        $or: [
          { evaluationStatus: 'pending' },
          { evaluationStatus: 'completed', evaluatedSourceFactId: 'fact-001' },
        ],
      },
      { $set: {
        evaluationStatus: 'completed',
        evaluatedAt: new Date('2026-04-01T10:05:00.000Z'),
        evaluatedSourceFactId: 'fact-001',
      } },
      { session, runValidators: true, timestamps: false },
    );

    harness.setOne(null);
    await expect(repository.findById('missing')).resolves.toBeNull();
    await expect(repository.findByEventFingerprints(['missing'], session)).resolves.toBeNull();

    const conflict = modelHarness();
    conflict.model.updateOne.mockResolvedValue({ matchedCount: 0 });
    const conflictRepository = new AttendanceShiftPlanRepository(
      context(), conflict.model as unknown as Model<AttendanceShiftPlanDocument>, crypto(),
    );
    await expect(conflictRepository.markEvaluated(
      plan.id,
      'fact-001',
      new Date('2026-04-01T10:05:00.000Z'),
      session,
    )).rejects.toThrow('ATTENDANCE_SHIFT_EVALUATION_CHECKPOINT_CONFLICT');

    await expect(repository.insert(
      { ...plan, tenantId: 'tenant-002' },
      ['attendance-blind-001.shift'],
      session,
    )).rejects.toThrow('Attendance 仓储拒绝跨租户实体');
  });

  it.each([
    [null],
    [{ migrationEvidenceRef: null, migrationEvidenceChecksum: 'checksum' }],
    [{ migrationEvidenceRef: undefined, migrationEvidenceChecksum: 'checksum' }],
    [{ migrationEvidenceRef: 'evidence', migrationEvidenceChecksum: null }],
    [{ migrationEvidenceRef: 'evidence', migrationEvidenceChecksum: undefined }],
  ])('源事实迁移证据不完整时返回空：%j', async (record) => {
    const harness = modelHarness();
    harness.setOne(record);
    const repository = new AttendanceSourceFactRepository(
      context(), harness.model as unknown as Model<AttendanceSourceFactDocument>, crypto(),
    );
    await expect(repository.findMigrationEvidenceById('fact-legacy-001', session))
      .resolves.toBeNull();
  });

  it('源事实迁移证据完整时返回冻结副本', async () => {
    const harness = modelHarness();
    harness.setOne({
      migrationEvidenceRef: 'erp://migration/evidence',
      migrationEvidenceChecksum: 'checksum',
    });
    const repository = new AttendanceSourceFactRepository(
      context(), harness.model as unknown as Model<AttendanceSourceFactDocument>, crypto(),
    );
    const result = await repository.findMigrationEvidenceById('fact-legacy-001');
    expect(result).toEqual({
      migrationEvidenceRef: 'erp://migration/evidence',
      migrationEvidenceChecksum: 'checksum',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(harness.queries.at(-1)?.session).not.toHaveBeenCalled();
  });

  it('源事实写入拒绝客户端跨租户实体', async () => {
    const harness = modelHarness();
    const repository = new AttendanceSourceFactRepository(
      context(), harness.model as unknown as Model<AttendanceSourceFactDocument>, crypto(),
    );
    await expect(repository.insert(
      { ...sourceFact(), tenantId: 'tenant-002' },
      ['attendance-blind-001.digest'],
      session,
    )).rejects.toThrow('Attendance 仓储拒绝跨租户实体');
    expect(harness.model.create).not.toHaveBeenCalled();
  });

  it('修订支持普通写入、按来源/标识/月读取与完整迁移证据', async () => {
    const harness = modelHarness();
    const repository = new AttendanceCorrectionRepository(
      context(), harness.model as unknown as Model<AttendanceCorrectionDocument>, crypto(),
    );
    const value = correction();
    await repository.insert(value, session);
    const documents = harness.model.create.mock.calls[0]?.[0] as readonly Record<string, unknown>[];
    const record = documents[0];
    expect(record).toMatchObject({
      migrationEvidenceRef: null, migrationEvidenceChecksum: null,
    });

    harness.setOne(record);
    await expect(repository.findBySourceFactId(value.sourceFactId, session))
      .resolves.toEqual(value);
    await expect(repository.findById(value.id)).resolves.toEqual(value);
    expect(harness.queries.at(-1)?.session).not.toHaveBeenCalled();
    harness.setMany([record]);
    const monthly = await repository.findForMonth(
      value.employeeId, '2026-04', new Date('2026-04-30T23:59:59.999Z'), session,
    );
    expect(monthly).toEqual([value]);
    expect(Object.isFrozen(monthly)).toBe(true);
    const ruleEvaluation = await repository.findForRuleEvaluation(
      value.employeeId,
      '2026-04',
      new Date('2026-05-01T00:30:00.000Z'),
      session,
    );
    expect(ruleEvaluation).toEqual([value]);
    expect(harness.model.find).toHaveBeenLastCalledWith(expect.objectContaining({
      tenantId: 'tenant-001',
      employeeId: value.employeeId,
      businessDate: { $gte: '2026-04-01', $lte: '2026-05-01' },
    }));

    harness.setOne({
      migrationEvidenceRef: 'erp://migration/correction',
      migrationEvidenceChecksum: 'checksum',
    });
    await expect(repository.findMigrationEvidenceById(value.id, session)).resolves.toEqual({
      migrationEvidenceRef: 'erp://migration/correction',
      migrationEvidenceChecksum: 'checksum',
    });
    harness.setOne(null);
    await expect(repository.findBySourceFactId('missing')).resolves.toBeNull();
    await expect(repository.findById('missing', session)).resolves.toBeNull();
    await expect(repository.findMigrationEvidenceById('missing')).resolves.toBeNull();
  });

  it('修订写入拒绝客户端跨租户实体', async () => {
    const harness = modelHarness();
    const repository = new AttendanceCorrectionRepository(
      context(), harness.model as unknown as Model<AttendanceCorrectionDocument>, crypto(),
    );
    await expect(repository.insert(
      { ...correction(), tenantId: 'tenant-002' },
      session,
    )).rejects.toThrow('Attendance 仓储拒绝跨租户实体');
    expect(harness.model.create).not.toHaveBeenCalled();
  });

  it('月快照支持激活、按活动状态/标识读取与完整迁移证据', async () => {
    const harness = modelHarness();
    const repository = new AttendanceMonthlySnapshotRepository(
      context(), harness.model as unknown as Model<AttendanceMonthlySnapshotDocument>, crypto(),
    );
    const value = snapshot();
    await repository.activate(value, null, session);
    const documents = harness.model.create.mock.calls[0]?.[0] as readonly Record<string, unknown>[];
    const record = documents[0];
    expect(record).toMatchObject({
      migrationEvidenceRef: null, migrationEvidenceChecksum: null,
    });

    harness.setOne(record);
    await expect(repository.findActive(value.employeeId, value.month, session))
      .resolves.toEqual(value);
    await expect(repository.findById(value.id)).resolves.toEqual(value);
    expect(harness.queries.at(-1)?.session).not.toHaveBeenCalled();
    harness.setOne({
      migrationEvidenceRef: 'erp://migration/snapshot',
      migrationEvidenceChecksum: 'checksum',
    });
    await expect(repository.findMigrationEvidenceById(value.id, session)).resolves.toEqual({
      migrationEvidenceRef: 'erp://migration/snapshot',
      migrationEvidenceChecksum: 'checksum',
    });
    harness.setOne(null);
    await expect(repository.findActive(value.employeeId, value.month)).resolves.toBeNull();
    await expect(repository.findById('missing', session)).resolves.toBeNull();
    await expect(repository.findMigrationEvidenceById('missing')).resolves.toBeNull();
  });

  it('月快照替换先以租户和活动状态收敛旧版本', async () => {
    const harness = modelHarness();
    const repository = new AttendanceMonthlySnapshotRepository(
      context(), harness.model as unknown as Model<AttendanceMonthlySnapshotDocument>, crypto(),
    );
    const previous = snapshot();
    const next = {
      ...previous,
      id: 'snapshot-legacy-002',
      snapshotVersion: 2,
      previousSnapshotId: previous.id,
      supersessionEvidenceId: 'approval-001',
    };
    await repository.activate(next, previous, session);
    expect(harness.model.updateOne).toHaveBeenCalledWith(
      { tenantId: 'tenant-001', id: previous.id, status: 'active' },
      { $set: { status: 'superseded' } },
      { session, timestamps: false },
    );
    expect(harness.model.create).toHaveBeenCalledOnce();
  });

  it('月快照替换对并发写冲突和跨租户旧版本均失败关闭', async () => {
    const conflictHarness = modelHarness();
    conflictHarness.model.updateOne.mockResolvedValue({ matchedCount: 0 });
    const repository = new AttendanceMonthlySnapshotRepository(
      context(),
      conflictHarness.model as unknown as Model<AttendanceMonthlySnapshotDocument>,
      crypto(),
    );
    const previous = snapshot();
    await expect(repository.activate({
      ...previous, id: 'snapshot-legacy-002', snapshotVersion: 2,
    }, previous, session)).rejects.toThrow('ATTENDANCE_SNAPSHOT_WRITE_CONFLICT');
    expect(conflictHarness.model.create).not.toHaveBeenCalled();

    const tenantHarness = modelHarness();
    const tenantRepository = new AttendanceMonthlySnapshotRepository(
      context(), tenantHarness.model as unknown as Model<AttendanceMonthlySnapshotDocument>,
      crypto(),
    );
    await expect(tenantRepository.activate(
      previous, { ...previous, tenantId: 'tenant-002' }, session,
    )).rejects.toThrow('Attendance 仓储拒绝跨租户实体');
    expect(tenantHarness.model.updateOne).not.toHaveBeenCalled();
  });

  it('月快照写入拒绝客户端跨租户新实体', async () => {
    const harness = modelHarness();
    const repository = new AttendanceMonthlySnapshotRepository(
      context(), harness.model as unknown as Model<AttendanceMonthlySnapshotDocument>, crypto(),
    );
    await expect(repository.activate(
      { ...snapshot(), tenantId: 'tenant-002' }, null, session,
    )).rejects.toThrow('Attendance 仓储拒绝跨租户实体');
    expect(harness.model.create).not.toHaveBeenCalled();
  });
});
