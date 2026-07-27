import type { ActorContext } from '@gaoq/shared-types';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { calculatePayroll, payrollDigest } from '../domain/index.js';
import { PayrollRunService } from './payroll-run.service.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const session = {} as ClientSession;

function actor(scopes: readonly string[], actorType: ActorContext['actorType'] = 'user'): ActorContext {
  return {
    actorType, actorId: 'actor-001', tenantId: tenant.tenantId,
    roleCodes: ['payroll'], scopes, departmentIds: [], traceId: 'trace-001',
  };
}

function assemble(overrides: Record<string, unknown> = {}) {
  const context = new TenantContextService();
  const idempotency = { execute: vi.fn(async (
    _operation: string,
    _key: string,
    _request: unknown,
    handler: (value: ClientSession) => Promise<Record<string, unknown>>,
  ) => handler(session)) };
  const defaultPeriods = {
    create: vi.fn().mockResolvedValue([]),
    findOne: vi.fn(),
  };
  const periods = (overrides.periods ?? defaultPeriods) as typeof defaultPeriods;
  const defaultProfiles = {
    findActorIdByEmployee: vi.fn().mockResolvedValue('actor-preparer-001'),
  };
  const profiles = (overrides.profiles ?? defaultProfiles) as typeof defaultProfiles;
  const defaultOutbox = { append: vi.fn().mockResolvedValue(undefined) };
  const outbox = (overrides.outbox ?? defaultOutbox) as typeof defaultOutbox;
  const crypto = overrides.crypto ?? {};
  const rulePacks = overrides.rulePacks ?? {};
  const compensation = overrides.compensation ?? {};
  const attendance = overrides.attendance ?? {};
  const runs = overrides.runs ?? {};
  const snapshots = overrides.snapshots ?? {};
  const calculationLines = overrides.calculationLines ?? {};
  const service = new PayrollRunService(
    idempotency as never, context, profiles as never, crypto as never, outbox as never,
    periods as never, rulePacks as never, compensation as never, attendance as never,
    runs as never, snapshots as never, calculationLines as never,
  );
  return {
    context,
    idempotency,
    periods,
    profiles,
    outbox,
    crypto,
    rulePacks,
    compensation,
    attendance,
    runs,
    snapshots,
    calculationLines,
    service,
  };
}

describe('PayrollRunService 信任边界', () => {
  it('创建周期只使用可信租户和当前已验证人员', async () => {
    const store = assemble();
    const result = await store.context.run({
      tenant, actor: actor(['erp:payroll:period:create']),
    }, () => store.service.createPeriod('payroll-period-001', '2026-07'));
    expect(result).toMatchObject({ period: '2026-07', status: 'draft', version: 1 });
    expect(store.periods.create).toHaveBeenCalledWith([
      expect.objectContaining({
        tenantId: 'tenant-001', preparedBy: 'actor-001', period: '2026-07',
      }),
    ], { session });
    expect(store.outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'payroll.period.created', tenantId: 'tenant-001',
    }), session);
  });

  it('即使拥有执行 Scope，普通用户也不能运行工资计算', async () => {
    const store = assemble();
    await expect(store.context.run({
      tenant, actor: actor(['erp:payroll:run:execute']),
    }, () => store.service.executeRun('payroll-run-001', {
      periodId: 'period-001', expectedVersion: 2,
      rulePackId: 'rule-001', rulePackVersion: 1,
      lines: [{
        employeeId: 'employee-001', compensationProfileId: 'profile-001',
        attendanceSnapshotId: 'attendance-001',
      }],
    }))).rejects.toBeInstanceOf(ForbiddenException);
    expect(store.idempotency.execute).not.toHaveBeenCalled();
  });

  it('运行命令只接受 ERP 引用，拒绝夹带金额或累计税状态', async () => {
    const store = assemble();
    await expect(store.context.run({
      tenant, actor: actor(['erp:payroll:run:execute'], 'system_job'),
    }, () => store.service.executeRun('payroll-run-001', {
      periodId: 'period-001', expectedVersion: 2,
      rulePackId: 'rule-001', rulePackVersion: 1,
      lines: [{
        employeeId: 'employee-001', compensationProfileId: 'profile-001',
        attendanceSnapshotId: 'attendance-001',
        calculation: { grossPayMinor: 9_999_999 },
      } as never],
    }))).rejects.toBeInstanceOf(BadRequestException);
    expect(store.idempotency.execute).not.toHaveBeenCalled();
  });

  it('迁移周期只恢复 draft/collecting 基线并把制单员工解析为可信主体', async () => {
    const store = assemble();
    const result = await store.context.run({
      tenant,
      actor: actor(['erp:migration:execute', 'erp:payroll:migration:write'], 'service'),
    }, () => store.service.importPeriodFromMigration('migration-period-001', {
      targetId: null, period: '2026-06', status: 'collecting',
      preparedByEmployeeId: 'employee-preparer-001',
      createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-02T00:00:00.000Z',
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/period-001',
      evidenceChecksum: 'e'.repeat(43),
    }));
    expect(result).toMatchObject({ period: '2026-06', status: 'collecting', version: 2 });
    expect(store.profiles.findActorIdByEmployee).toHaveBeenCalledWith(
      'tenant-001', 'employee-preparer-001', session,
    );
    expect(store.periods.create).toHaveBeenCalledWith([
      expect.objectContaining({
        preparedBy: 'actor-preparer-001', status: 'collecting', version: 2,
        migrationEvidenceChecksum: 'e'.repeat(43),
      }),
    ], { session });
    expect(store.outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'payroll.period.migrated', data: { period: '2026-06', status: 'collecting' },
    }), session);
  });

  it('普通人员即使持有迁移 scope 也不能恢复工资周期', async () => {
    const store = assemble();
    await expect(store.context.run({
      tenant,
      actor: actor(['erp:migration:execute', 'erp:payroll:migration:write']),
    }, () => store.service.importPeriodFromMigration('migration-period-001', {
      targetId: null, period: '2026-06', status: 'draft',
      preparedByEmployeeId: 'employee-preparer-001',
      createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z',
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/period-001',
      evidenceChecksum: 'e'.repeat(43),
    }))).rejects.toBeInstanceOf(ForbiddenException);
    expect(store.periods.create).not.toHaveBeenCalled();
  });
});

function query<T>(value: T) {
  const result = {
    sort: vi.fn(), limit: vi.fn(), session: vi.fn(), lean: vi.fn(),
    exec: vi.fn().mockResolvedValue(value),
  };
  result.sort.mockReturnValue(result);
  result.limit.mockReturnValue(result);
  result.session.mockReturnValue(result);
  result.lean.mockReturnValue(result);
  return result;
}

const periodId = '01J8ZQK7V0A2M4N6P8R0T2W4P1';
const rulePackId = '01J8ZQK7V0A2M4N6P8R0T2W4R1';
const profileId = '01J8ZQK7V0A2M4N6P8R0T2W4C1';
const attendanceId = '01J8ZQK7V0A2M4N6P8R0T2W4A1';

function periodRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: periodId,
    tenantId: 'tenant-001',
    period: '2026-06',
    currency: 'CNY',
    status: 'collecting',
    preparedBy: 'actor-preparer-001',
    version: 2,
    activeRunId: null,
    inputSnapshotHash: null,
    resultHash: null,
    employeeCount: null,
    totalGrossMinor: null,
    totalTaxMinor: null,
    totalNetMinor: null,
    approvalReferenceType: null,
    approvalInstanceId: null,
    approvedBy: null,
    approvalEvidenceId: null,
    lockedBy: null,
    strongAuthEvidenceId: null,
    strongAuthReferenceType: null,
    disbursementBatchId: null,
    disbursementPreparedBy: null,
    disbursementExportEvidenceId: null,
    reconciliationEvidenceId: null,
    reconciledBy: null,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-02T00:00:00.000Z'),
    migrationEvidenceRef: null,
    migrationEvidenceChecksum: null,
    ...overrides,
  };
}

function validRunInput(overrides: Record<string, unknown> = {}) {
  return {
    periodId,
    expectedVersion: 2,
    rulePackId,
    rulePackVersion: 1,
    lines: [{
      employeeId: 'employee-001',
      compensationProfileId: profileId,
      attendanceSnapshotId: attendanceId,
    }],
    ...overrides,
  };
}

function validPeriodMigration(overrides: Record<string, unknown> = {}) {
  return {
    targetId: null,
    period: '2026-06',
    status: 'collecting',
    preparedByEmployeeId: 'employee-preparer-001',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-02T00:00:00.000Z',
    migrationEvidenceRef:
      'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/period-001',
    evidenceChecksum: 'e'.repeat(43),
    ...overrides,
  };
}

function validCalculationMigration(overrides: Record<string, unknown> = {}) {
  return {
    targetId: null,
    periodId,
    expectedPeriodVersion: 2,
    runNumber: 1,
    rulePackId,
    rulePackVersion: 1,
    lines: [{
      employeeId: 'employee-001',
      compensationProfileId: profileId,
      attendanceSnapshotId: attendanceId,
      expectedGrossMinor: 100_000,
      expectedWithholdingTaxMinor: 1_500,
      expectedNetMinor: 98_500,
    }],
    expectedEmployeeCount: 1,
    expectedTotalGrossMinor: 100_000,
    expectedTotalTaxMinor: 1_500,
    expectedTotalNetMinor: 98_500,
    completedAt: '2026-06-03T00:00:00.000Z',
    migrationEvidenceRef:
      'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/run-001',
    evidenceChecksum: 'e'.repeat(43),
    ...overrides,
  };
}

function compensationData(overrides: Record<string, unknown> = {}) {
  return {
    currency: 'CNY',
    taxableEarnings: [{ code: 'BASE', amountMinor: 100_000 }],
    nonTaxableEarnings: [],
    employeeSocialInsuranceMinor: 0,
    employeeHousingFundMinor: 0,
    specialAdditionalDeductionMinor: 0,
    otherPreTaxWithholdingMinor: 0,
    postTaxDeductionMinor: 0,
    attendanceAdjustment: {
      overtimePayMinorPerMinute: 0,
      absenceDeductionMinorPerMinute: 0,
      unpaidLeaveDeductionMinorPerMinute: 0,
    },
    ...overrides,
  };
}

function ruleData(overrides: Record<string, unknown> = {}) {
  return {
    id: rulePackId,
    version: 1,
    monthlyBasicDeductionMinor: 50_000,
    taxBrackets: [{ upperBoundMinor: null, rateBps: 300, quickDeductionMinor: 0 }],
    roundingMode: 'HALF_UP',
    ...overrides,
  };
}

describe('PayrollRunService 迁移重算控制', () => {
  it('目标确定性员工行与来源金额不一致时不落库', async () => {
    const context = new TenantContextService();
    const idempotency = { execute: vi.fn(async (
      _operation: string, _key: string, _request: unknown,
      handler: (value: ClientSession) => Promise<Record<string, unknown>>,
    ) => handler(session)) };
    const periodId = '01J8ZQK7V0A2M4N6P8R0T2W4P1';
    const rulePackId = '01J8ZQK7V0A2M4N6P8R0T2W4R1';
    const profileId = '01J8ZQK7V0A2M4N6P8R0T2W4C1';
    const attendanceId = '01J8ZQK7V0A2M4N6P8R0T2W4A1';
    const profileData = {
      currency: 'CNY' as const,
      taxableEarnings: [{ code: 'BASE', amountMinor: 100_000 }],
      nonTaxableEarnings: [], employeeSocialInsuranceMinor: 0,
      employeeHousingFundMinor: 0, specialAdditionalDeductionMinor: 0,
      otherPreTaxWithholdingMinor: 0, postTaxDeductionMinor: 0,
      attendanceAdjustment: {
        overtimePayMinorPerMinute: 0, absenceDeductionMinorPerMinute: 0,
        unpaidLeaveDeductionMinorPerMinute: 0,
      },
    };
    const ruleSnapshot = {
      id: rulePackId, version: 1, monthlyBasicDeductionMinor: 50_000,
      taxBrackets: [{ upperBoundMinor: null, rateBps: 300, quickDeductionMinor: 0 }],
      roundingMode: 'HALF_UP' as const,
    };
    const periods = {
      findOne: vi.fn().mockReturnValue(query({
        id: periodId, tenantId: 'tenant-001', period: '2026-06', currency: 'CNY',
        status: 'collecting', preparedBy: 'actor-preparer-001', version: 2,
        activeRunId: null, inputSnapshotHash: null, resultHash: null, employeeCount: null,
        totalGrossMinor: null, totalTaxMinor: null, totalNetMinor: null,
        approvalInstanceId: null, approvedBy: null, approvalEvidenceId: null,
        lockedBy: null, strongAuthEvidenceId: null, disbursementBatchId: null,
        disbursementPreparedBy: null, disbursementExportEvidenceId: null,
        reconciliationEvidenceId: null, reconciledBy: null,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        updatedAt: new Date('2026-06-02T00:00:00.000Z'),
      })),
      find: vi.fn().mockReturnValue(query([{
        id: '01J8ZQK7V0A2M4N6P8R0T2W4P0', tenantId: 'tenant-001', period: '2026-05',
        status: 'review', activeRunId: '01J8ZQK7V0A2M4N6P8R0T2W4N0',
        inputSnapshotHash: 'i'.repeat(43), resultHash: 'r'.repeat(43),
        employeeCount: 1, totalGrossMinor: 100_000, totalTaxMinor: 1_500,
        totalNetMinor: 98_500,
      }])), updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const rulePacks = { findOne: vi.fn().mockReturnValue(query({
      ...ruleSnapshot, tenantId: 'tenant-001', status: 'published',
      effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31',
      rulesHash: payrollDigest(ruleSnapshot),
    })) };
    const compensation = { findOne: vi.fn().mockReturnValue(query({
      id: profileId, tenantId: 'tenant-001', employeeId: 'employee-001', version: 1,
      profileHash: payrollDigest(profileData), dataKeyId: 'key', dataIv: 'iv',
      dataCiphertext: 'cipher', dataAuthTag: 'tag',
    })) };
    const attendance = { findOne: vi.fn().mockReturnValue(query({
      id: attendanceId, employeeId: 'employee-001', month: '2026-06', status: 'active',
      snapshotHash: 's'.repeat(43), workedMinutes: 0, leaveMinutes: 0,
      overtimeMinutes: 0, absentMinutes: 0,
    })) };
    const runs = { findOne: vi.fn((filter: { id?: string }) => query(
      filter.id === undefined ? null : {
        id: filter.id, periodId: '01J8ZQK7V0A2M4N6P8R0T2W4P0', status: 'completed',
        inputSnapshotHash: 'i'.repeat(43), resultHash: 'r'.repeat(43),
        employeeCount: 1, totalGrossMinor: 100_000, totalTaxMinor: 1_500,
        totalNetMinor: 98_500, migrationEvidenceRef: 'erp://migration',
        migrationEvidenceChecksum: 'm'.repeat(43),
      },
    )), create: vi.fn() };
    const calculationLines = {
      findOne: vi.fn().mockReturnValue(query(null)), create: vi.fn().mockResolvedValue([]),
    };
    const snapshots = { create: vi.fn().mockResolvedValue([]) };
    const outbox = { append: vi.fn().mockResolvedValue(undefined) };
    const crypto = {
      unprotect: vi.fn().mockReturnValue(profileData),
      protect: vi.fn().mockReturnValue({
        keyId: 'payroll-key-001', iv: 'i'.repeat(16),
        ciphertext: 'c'.repeat(32), authTag: 'a'.repeat(22),
      }),
    };
    const service = new PayrollRunService(
      idempotency as never, context, {} as never,
      crypto as never, outbox as never,
      periods as never, rulePacks as never, compensation as never, attendance as never,
      runs as never, snapshots as never, calculationLines as never,
    );
    await expect(context.run({
      tenant,
      actor: actor(['erp:migration:execute', 'erp:payroll:migration:write'], 'service'),
    }, () => service.importCalculationRunFromMigration('migration-run-001', {
      targetId: null, periodId, expectedPeriodVersion: 2, runNumber: 1,
      rulePackId, rulePackVersion: 1,
      lines: [{
        employeeId: 'employee-001', compensationProfileId: profileId,
        attendanceSnapshotId: attendanceId,
        expectedGrossMinor: 1, expectedWithholdingTaxMinor: 0, expectedNetMinor: 1,
      }],
      expectedEmployeeCount: 1, expectedTotalGrossMinor: 1,
      expectedTotalTaxMinor: 0, expectedTotalNetMinor: 1,
      completedAt: '2026-06-03T00:00:00.000Z',
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/run-001',
      evidenceChecksum: 'e'.repeat(43),
    }))).rejects.toBeInstanceOf(ConflictException);
    expect(runs.create).not.toHaveBeenCalled();
    const periodFilter = periods.find.mock.calls[0]?.[0] as {
      readonly status: { readonly $in: readonly string[] };
    };
    expect(periodFilter.status.$in).toContain('review');
    expect(periodFilter.status.$in).toContain('locked');
    expect(runs.findOne).toHaveBeenCalledWith(expect.objectContaining({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4N0',
    }));

    const imported = await context.run({
      tenant,
      actor: actor(['erp:migration:execute', 'erp:payroll:migration:write'], 'service'),
    }, () => service.importCalculationRunFromMigration('migration-run-002', {
      targetId: null, periodId, expectedPeriodVersion: 2, runNumber: 1,
      rulePackId, rulePackVersion: 1,
      lines: [{
        employeeId: 'employee-001', compensationProfileId: profileId,
        attendanceSnapshotId: attendanceId,
        expectedGrossMinor: 100_000, expectedWithholdingTaxMinor: 1_500,
        expectedNetMinor: 98_500,
      }],
      expectedEmployeeCount: 1, expectedTotalGrossMinor: 100_000,
      expectedTotalTaxMinor: 1_500, expectedTotalNetMinor: 98_500,
      completedAt: '2026-06-03T00:00:00.000Z',
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/run-002',
      evidenceChecksum: 'f'.repeat(43),
    }));
    expect(imported).toMatchObject({
      version: 1, runNumber: 1, periodId, employeeCount: 1,
      totalGrossMinor: 100_000, totalTaxMinor: 1_500, totalNetMinor: 98_500,
    });
    expect(snapshots.create).toHaveBeenCalledWith(
      [expect.objectContaining({ employeeId: 'employee-001', createdAt: new Date(
        '2026-06-03T00:00:00.000Z',
      ) })], { session },
    );
    expect(calculationLines.create).toHaveBeenCalledWith(
      [expect.objectContaining({ employeeId: 'employee-001' })], { session },
    );
    expect(outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'payroll.run.migrated', version: 3,
    }), session);
    const periodUpdate = periods.updateOne.mock.calls[0] as unknown as [
      Record<string, unknown>, { $set: Record<string, unknown> }, Record<string, unknown>,
    ];
    expect(periodUpdate[0]).toMatchObject({ id: periodId, version: 2, status: 'collecting' });
    expect(periodUpdate[1].$set).toMatchObject({
      status: 'review', updatedAt: new Date('2026-06-03T00:00:00.000Z'),
    });
    expect(periodUpdate[2]).toEqual({ session, runValidators: true, timestamps: false });
  });
});

describe('PayrollRunService 周期状态机与错误分类', () => {
  it('缺少业务 Scope 时在任何数据库访问前拒绝', async () => {
    const store = assemble();

    await expect(store.context.run({
      tenant,
      actor: actor([]),
    }, () => store.service.createPeriod('period-denied', '2026-07')))
      .rejects.toMatchObject({ response: { code: 'AUTH_SCOPE_DENIED' } });
    await expect(store.context.run({
      tenant,
      actor: actor([]),
    }, () => store.service.startCollection('collect-denied', periodId, 1)))
      .rejects.toMatchObject({ response: { code: 'AUTH_SCOPE_DENIED' } });
    await expect(store.context.run({
      tenant,
      actor: actor([]),
    }, () => store.service.getPeriod(periodId)))
      .rejects.toMatchObject({ response: { code: 'AUTH_SCOPE_DENIED' } });
  });

  it('创建周期要求人员身份并映射领域输入错误与唯一键冲突', async () => {
    const systemStore = assemble();
    await expect(systemStore.context.run({
      tenant,
      actor: actor(['erp:payroll:period:create'], 'service'),
    }, () => systemStore.service.createPeriod('period-service', '2026-07')))
      .rejects.toMatchObject({ response: { code: 'PAYROLL_PERIOD_HUMAN_REQUIRED' } });

    const invalidStore = assemble();
    await expect(invalidStore.context.run({
      tenant,
      actor: actor(['erp:payroll:period:create']),
    }, () => invalidStore.service.createPeriod('period-invalid', '2026-13')))
      .rejects.toBeInstanceOf(BadRequestException);

    const duplicateStore = assemble({
      periods: {
        create: vi.fn().mockRejectedValue({ code: 11_000 }),
        findOne: vi.fn(),
      },
    });
    await expect(duplicateStore.context.run({
      tenant,
      actor: actor(['erp:payroll:period:create']),
    }, () => duplicateStore.service.createPeriod('period-duplicate', '2026-07')))
      .rejects.toMatchObject({ response: { code: 'PAYROLL_UNIQUE_CONFLICT' } });
  });

  it('开始采集成功并把领域状态通过乐观锁持久化', async () => {
    const current = periodRecord({ status: 'draft', version: 1 });
    const periods = {
      create: vi.fn(),
      findOne: vi.fn().mockReturnValue(query(current)),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const outbox = { append: vi.fn().mockResolvedValue(undefined) };
    const store = assemble({ periods, outbox });

    const result = await store.context.run({
      tenant,
      actor: actor(['erp:payroll:period:prepare']),
    }, () => store.service.startCollection('collect-001', periodId, 1));

    expect(result).toMatchObject({ status: 'collecting', version: 2 });
    expect(periods.updateOne).toHaveBeenCalledWith(
      { tenantId: 'tenant-001', id: periodId, version: 1, status: 'draft' },
      expect.any(Object),
      { session, runValidators: true },
    );
    expect(outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'payroll.period.collecting',
      version: 2,
    }), session);
  });

  it('开始采集拒绝不存在周期、领域版本冲突与数据库写竞争', async () => {
    const missing = assemble({
      periods: {
        create: vi.fn(),
        findOne: vi.fn().mockReturnValue(query(null)),
      },
    });
    await expect(missing.context.run({
      tenant,
      actor: actor(['erp:payroll:period:prepare']),
    }, () => missing.service.startCollection('collect-missing', periodId, 1)))
      .rejects.toMatchObject({ response: { code: 'PAYROLL_PERIOD_NOT_FOUND' } });

    const version = assemble({
      periods: {
        create: vi.fn(),
        findOne: vi.fn().mockReturnValue(query(periodRecord({ status: 'draft', version: 2 }))),
      },
    });
    await expect(version.context.run({
      tenant,
      actor: actor(['erp:payroll:period:prepare']),
    }, () => version.service.startCollection('collect-version', periodId, 1)))
      .rejects.toBeInstanceOf(ConflictException);

    const write = assemble({
      periods: {
        create: vi.fn(),
        findOne: vi.fn().mockReturnValue(query(periodRecord({ status: 'draft', version: 1 }))),
        updateOne: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
      },
    });
    await expect(write.context.run({
      tenant,
      actor: actor(['erp:payroll:period:prepare']),
    }, () => write.service.startCollection('collect-write', periodId, 1)))
      .rejects.toMatchObject({ response: { code: 'PAYROLL_PERIOD_WRITE_CONFLICT' } });
  });

  it('读取周期校验标识、可信租户和活动运行完整性', async () => {
    const active = periodRecord({
      status: 'review',
      version: 3,
      activeRunId: 'run-001',
      inputSnapshotHash: 'i'.repeat(43),
      resultHash: 'r'.repeat(43),
      employeeCount: 1,
      totalGrossMinor: 100_000,
      totalTaxMinor: 1_500,
      totalNetMinor: 98_500,
      approvalInstanceId: 'approval-001',
      strongAuthEvidenceId: 'auth-001',
    });
    const periods = {
      create: vi.fn(),
      findOne: vi.fn()
        .mockReturnValueOnce(query(active))
        .mockReturnValueOnce(query(null)),
    };
    const store = assemble({ periods });

    const result = await store.context.run({
      tenant,
      actor: actor(['erp:payroll:period:read']),
    }, () => store.service.getPeriod(periodId));
    expect(result).toMatchObject({
      activeRunId: 'run-001',
      employeeCount: 1,
      totalNetMinor: 98_500,
    });
    await expect(store.context.run({
      tenant,
      actor: actor(['erp:payroll:period:read']),
    }, () => store.service.getPeriod('bad id')))
      .rejects.toMatchObject({ response: { code: 'PAYROLL_PERIOD_ID_INVALID' } });
    await expect(store.context.run({
      tenant,
      actor: actor(['erp:payroll:period:read']),
    }, () => store.service.getPeriod(periodId)))
      .rejects.toMatchObject({ response: { code: 'PAYROLL_PERIOD_NOT_FOUND' } });
  });
});

describe('PayrollRunService 命令输入白名单', () => {
  it('运行根字段、版本、批量和重复员工逐项失败关闭', async () => {
    const store = assemble();
    const invalidInputs = [
      validRunInput({ unexpected: true }),
      validRunInput({ periodId: 'bad id' }),
      validRunInput({ rulePackId: 'bad id' }),
      validRunInput({ expectedVersion: 0 }),
      validRunInput({ expectedVersion: 1.5 }),
      validRunInput({ rulePackVersion: 0 }),
      validRunInput({ rulePackVersion: 1.5 }),
      validRunInput({ lines: [] }),
      validRunInput({
        lines: Array.from({ length: 5_001 }, (_, index) => ({
          employeeId: `employee-${index}`,
          compensationProfileId: profileId,
          attendanceSnapshotId: attendanceId,
        })),
      }),
      validRunInput({
        lines: [
          {
            employeeId: 'employee-001',
            compensationProfileId: profileId,
            attendanceSnapshotId: attendanceId,
          },
          {
            employeeId: 'employee-001',
            compensationProfileId: profileId,
            attendanceSnapshotId: attendanceId,
          },
        ],
      }),
    ];

    for (const [index, input] of invalidInputs.entries()) {
      await expect(store.context.run({
        tenant,
        actor: actor(['erp:payroll:run:execute'], 'system_job'),
      }, () => store.service.executeRun(`run-invalid-${index}`, input as never)))
        .rejects.toMatchObject({ response: { code: 'PAYROLL_RUN_INPUT_INVALID' } });
    }
  });

  it('员工行字段和三类引用逐项失败关闭', async () => {
    const store = assemble();
    const invalidLines = [
      {
        employeeId: 'employee-001',
        compensationProfileId: profileId,
        attendanceSnapshotId: attendanceId,
        unexpected: true,
      },
      {
        employeeId: 'bad id',
        compensationProfileId: profileId,
        attendanceSnapshotId: attendanceId,
      },
      {
        employeeId: 'employee-001',
        compensationProfileId: 'bad id',
        attendanceSnapshotId: attendanceId,
      },
      {
        employeeId: 'employee-001',
        compensationProfileId: profileId,
        attendanceSnapshotId: 'bad id',
      },
    ];

    for (const [index, line] of invalidLines.entries()) {
      await expect(store.context.run({
        tenant,
        actor: actor(['erp:payroll:run:execute'], 'service'),
      }, () => store.service.executeRun(`line-invalid-${index}`, validRunInput({
        lines: [line],
      }) as never))).rejects.toMatchObject({
        response: { code: 'PAYROLL_RUN_LINE_REFERENCE_INVALID' },
      });
    }
  });
});

describe('PayrollRunService 确定性计算执行', () => {
  it('从目标薪酬与考勤事实计算、加密逐行结果并推进周期', async () => {
    const current = periodRecord();
    const profile = compensationData({
      taxableEarnings: [{ code: 'BASE', amountMinor: 100_000 }],
      attendanceAdjustment: {
        overtimePayMinorPerMinute: 100,
        absenceDeductionMinorPerMinute: 50,
        unpaidLeaveDeductionMinorPerMinute: 25,
      },
      postTaxDeductionMinor: 1_000,
    });
    const rule = ruleData();
    const periods = {
      create: vi.fn(),
      findOne: vi.fn().mockReturnValue(query(current)),
      find: vi.fn().mockReturnValue(query([])),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const rulePacks = {
      findOne: vi.fn().mockReturnValue(query({
        ...rule,
        tenantId: 'tenant-001',
        status: 'published',
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
        rulesHash: payrollDigest(rule),
      })),
    };
    const compensation = {
      findOne: vi.fn().mockReturnValue(query({
        id: profileId,
        tenantId: 'tenant-001',
        employeeId: 'employee-001',
        status: 'active',
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
        version: 1,
        profileHash: payrollDigest(profile),
        dataKeyId: 'key',
        dataIv: 'iv',
        dataCiphertext: 'cipher',
        dataAuthTag: 'tag',
      })),
    };
    const attendance = {
      findOne: vi.fn().mockReturnValue(query({
        id: attendanceId,
        tenantId: 'tenant-001',
        employeeId: 'employee-001',
        month: '2026-06',
        status: 'active',
        snapshotHash: 's'.repeat(43),
        workedMinutes: 10_000,
        leaveMinutes: 2,
        overtimeMinutes: 10,
        absentMinutes: 3,
      })),
    };
    const runs = {
      findOne: vi.fn().mockReturnValue(query(null)),
      create: vi.fn().mockResolvedValue([]),
    };
    const snapshots = { create: vi.fn().mockResolvedValue([]) };
    const calculationLines = { create: vi.fn().mockResolvedValue([]) };
    const crypto = {
      unprotect: vi.fn().mockReturnValue(profile),
      protect: vi.fn().mockReturnValue({
        keyId: 'payroll-key',
        iv: 'i'.repeat(16),
        ciphertext: 'ciphertext',
        authTag: 'a'.repeat(22),
      }),
    };
    const outbox = { append: vi.fn().mockResolvedValue(undefined) };
    const store = assemble({
      periods,
      rulePacks,
      compensation,
      attendance,
      runs,
      snapshots,
      calculationLines,
      crypto,
      outbox,
    });

    const result = await store.context.run({
      tenant,
      actor: actor(['erp:payroll:run:execute'], 'system_job'),
    }, () => store.service.executeRun('run-success', validRunInput() as never));

    expect(result).toMatchObject({
      status: 'review',
      version: 3,
      employeeCount: 1,
      totalGrossMinor: 101_000,
    });
    expect(runs.create).toHaveBeenCalledWith(
      [expect.objectContaining({
        tenantId: 'tenant-001',
        runNumber: 1,
        employeeCount: 1,
        totalGrossMinor: 101_000,
      })],
      { session },
    );
    expect(snapshots.create).toHaveBeenCalledWith(
      [expect.objectContaining({
        employeeId: 'employee-001',
        attendanceSnapshotHash: 's'.repeat(43),
      })],
      { session },
    );
    expect(calculationLines.create).toHaveBeenCalledWith(
      [expect.objectContaining({ employeeId: 'employee-001' })],
      { session },
    );
    expect(crypto.protect).toHaveBeenCalledTimes(2);
    expect(outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'payroll.run.completed',
      version: 3,
    }), session);
  });

  it('运行拒绝不存在周期、版本错配、无效规则包和规则摘要篡改', async () => {
    const cases = [
      {
        periods: {
          create: vi.fn(),
          findOne: vi.fn().mockReturnValue(query(null)),
        },
        expected: 'PAYROLL_PERIOD_NOT_FOUND',
      },
      {
        periods: {
          create: vi.fn(),
          findOne: vi.fn().mockReturnValue(query(periodRecord({ version: 3 }))),
        },
        expected: 'PAYROLL_VERSION_CONFLICT',
      },
      {
        periods: {
          create: vi.fn(),
          findOne: vi.fn().mockReturnValue(query(periodRecord())),
        },
        rulePacks: { findOne: vi.fn().mockReturnValue(query(null)) },
        expected: 'PAYROLL_RULE_PACK_NOT_EFFECTIVE',
      },
      {
        periods: {
          create: vi.fn(),
          findOne: vi.fn().mockReturnValue(query(periodRecord())),
        },
        rulePacks: {
          findOne: vi.fn().mockReturnValue(query({
            ...ruleData(),
            rulesHash: 'x'.repeat(43),
          })),
        },
        expected: 'PAYROLL_RULE_PACK_INTEGRITY_FAILED',
      },
    ];

    for (const [index, fixture] of cases.entries()) {
      const store = assemble(fixture);
      await expect(store.context.run({
        tenant,
        actor: actor(['erp:payroll:run:execute'], 'service'),
      }, () => store.service.executeRun(
        `run-failure-${index}`,
        validRunInput() as never,
      ))).rejects.toMatchObject(
        fixture.expected === 'PAYROLL_PERIOD_NOT_FOUND'
          ? { response: { code: fixture.expected } }
          : fixture.expected === 'PAYROLL_VERSION_CONFLICT'
            ? { response: { code: fixture.expected } }
            : { message: fixture.expected },
      );
    }
  });

  it('运行拒绝缺失薪酬档案、考勤快照和薪酬密文摘要错配', async () => {
    const rule = ruleData();
    const validRulePacks = {
      findOne: vi.fn().mockReturnValue(query({
        ...rule,
        rulesHash: payrollDigest(rule),
      })),
    };
    const basePeriods = () => ({
      create: vi.fn(),
      findOne: vi.fn().mockReturnValue(query(periodRecord())),
      find: vi.fn().mockReturnValue(query([])),
    });
    const validProfile = compensationData();
    const validCompensationRecord = {
      id: profileId,
      employeeId: 'employee-001',
      version: 1,
      profileHash: payrollDigest(validProfile),
      dataKeyId: 'key',
      dataIv: 'iv',
      dataCiphertext: 'cipher',
      dataAuthTag: 'tag',
    };
    const validAttendanceRecord = {
      id: attendanceId,
      employeeId: 'employee-001',
      month: '2026-06',
      status: 'active',
      snapshotHash: 's'.repeat(43),
      overtimeMinutes: 0,
      absentMinutes: 0,
      leaveMinutes: 0,
    };
    const cases = [
      {
        compensation: { findOne: vi.fn().mockReturnValue(query(null)) },
        attendance: {},
        crypto: {},
        expected: 'PAYROLL_COMPENSATION_PROFILE_NOT_EFFECTIVE',
      },
      {
        compensation: {
          findOne: vi.fn().mockReturnValue(query(validCompensationRecord)),
        },
        attendance: { findOne: vi.fn().mockReturnValue(query(null)) },
        crypto: {},
        expected: 'PAYROLL_ATTENDANCE_SNAPSHOT_INVALID',
      },
      {
        compensation: {
          findOne: vi.fn().mockReturnValue(query({
            ...validCompensationRecord,
            profileHash: 'x'.repeat(43),
          })),
        },
        attendance: {
          findOne: vi.fn().mockReturnValue(query(validAttendanceRecord)),
        },
        crypto: { unprotect: vi.fn().mockReturnValue(validProfile) },
        expected: 'PAYROLL_COMPENSATION_PROFILE_INTEGRITY_FAILED',
      },
    ];

    for (const [index, fixture] of cases.entries()) {
      const store = assemble({
        periods: basePeriods(),
        rulePacks: validRulePacks,
        runs: { findOne: vi.fn().mockReturnValue(query(null)) },
        ...fixture,
      });
      await expect(store.context.run({
        tenant,
        actor: actor(['erp:payroll:run:execute'], 'system_job'),
      }, () => store.service.executeRun(
        `run-source-failure-${index}`,
        validRunInput() as never,
      ))).rejects.toThrow(fixture.expected);
    }
  });

  it('解密后的薪酬结构非法时统一映射为受保护数据错误', async () => {
    const rule = ruleData();
    const invalidProfile = { currency: 'USD' };
    const store = assemble({
      periods: {
        create: vi.fn(),
        findOne: vi.fn().mockReturnValue(query(periodRecord())),
      },
      rulePacks: {
        findOne: vi.fn().mockReturnValue(query({
          ...rule,
          rulesHash: payrollDigest(rule),
        })),
      },
      runs: { findOne: vi.fn().mockReturnValue(query(null)) },
      compensation: {
        findOne: vi.fn().mockReturnValue(query({
          id: profileId,
          employeeId: 'employee-001',
          version: 1,
          dataKeyId: 'key',
          dataIv: 'iv',
          dataCiphertext: 'cipher',
          dataAuthTag: 'tag',
        })),
      },
      attendance: {
        findOne: vi.fn().mockReturnValue(query({
          id: attendanceId,
          employeeId: 'employee-001',
          snapshotHash: 's'.repeat(43),
        })),
      },
      crypto: { unprotect: vi.fn().mockReturnValue(invalidProfile) },
    });

    await expect(store.context.run({
      tenant,
      actor: actor(['erp:payroll:run:execute'], 'service'),
    }, () => store.service.executeRun('run-zod', validRunInput() as never)))
      .rejects.toMatchObject({ response: { code: 'PAYROLL_PROTECTED_DATA_INVALID' } });
  });
});

describe('PayrollRunService 迁移输入与不可变基线', () => {
  const migrationActor = actor(
    ['erp:migration:execute', 'erp:payroll:migration:write'],
    'service',
  );

  it('迁移周期字段、引用、时间和状态组合逐项失败关闭', async () => {
    const store = assemble();
    const invalidInputs: readonly Record<string, unknown>[] = [
      validPeriodMigration({ unexpected: true }),
      validPeriodMigration({ targetId: 'bad-target' }),
      validPeriodMigration({ period: '2026-13' }),
      validPeriodMigration({ status: 'review' }),
      validPeriodMigration({ preparedByEmployeeId: 'bad id' }),
      validPeriodMigration({ migrationEvidenceRef: 'https://invalid' }),
      validPeriodMigration({ evidenceChecksum: 'short' }),
      validPeriodMigration({
        createdAt: '2026-06-03T00:00:00.000Z',
        updatedAt: '2026-06-02T00:00:00.000Z',
      }),
      validPeriodMigration({
        status: 'draft',
        updatedAt: '2026-06-02T00:00:00.000Z',
      }),
    ];

    for (const [index, input] of invalidInputs.entries()) {
      await expect(store.context.run({
        tenant,
        actor: migrationActor,
      }, () => store.service.importPeriodFromMigration(
        `period-migration-invalid-${index}`,
        input as never,
      ))).rejects.toMatchObject({
        response: { code: 'PAYROLL_MIGRATION_PERIOD_INPUT_INVALID' },
      });
    }
  });

  it('迁移时间必须是历史 UTC 毫秒时间', async () => {
    const store = assemble();
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    for (const value of ['invalid', '2026-06-01T00:00:00Z', future]) {
      await expect(store.context.run({
        tenant,
        actor: migrationActor,
      }, () => store.service.importPeriodFromMigration(
        `period-time-${value}`,
        validPeriodMigration({ createdAt: value }) as never,
      ))).rejects.toMatchObject({
        response: { code: 'PAYROLL_MIGRATION_TIME_INVALID' },
      });
    }
  });

  it('迁移周期要求制单员工绑定可信身份', async () => {
    const store = assemble({
      profiles: { findActorIdByEmployee: vi.fn().mockResolvedValue(null) },
    });

    await expect(store.context.run({
      tenant,
      actor: migrationActor,
    }, () => store.service.importPeriodFromMigration(
      'period-preparer-missing',
      validPeriodMigration() as never,
    ))).rejects.toMatchObject({
      response: { code: 'PAYROLL_MIGRATION_PREPARER_IDENTITY_NOT_FOUND' },
    });
  });

  it('相同目标周期只允许完整一致的幂等重放', async () => {
    const targetId = '01J8ZQK7V0A2M4N6P8R0T2W4T1';
    const input = validPeriodMigration({
      targetId,
      status: 'draft',
      updatedAt: '2026-06-01T00:00:00.000Z',
    });
    const existing = periodRecord({
      id: targetId,
      status: 'draft',
      version: 1,
      preparedBy: 'actor-preparer-001',
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      updatedAt: new Date('2026-06-01T00:00:00.000Z'),
      migrationEvidenceRef: input.migrationEvidenceRef,
      migrationEvidenceChecksum: input.evidenceChecksum,
    });
    const periods = {
      create: vi.fn(),
      findOne: vi.fn()
        .mockReturnValueOnce(query(existing))
        .mockReturnValueOnce(query({ ...existing, period: '2026-05' })),
    };
    const store = assemble({ periods });

    await expect(store.context.run({
      tenant,
      actor: migrationActor,
    }, () => store.service.importPeriodFromMigration(
      'period-replay',
      input as never,
    ))).resolves.toMatchObject({ id: targetId, status: 'draft', version: 1 });
    await expect(store.context.run({
      tenant,
      actor: migrationActor,
    }, () => store.service.importPeriodFromMigration(
      'period-replay-mismatch',
      input as never,
    ))).rejects.toMatchObject({
      response: { code: 'PAYROLL_MIGRATION_PERIOD_IMMUTABLE' },
    });
    expect(periods.create).not.toHaveBeenCalled();
  });

  it('迁移运行控制字段、金额、批量和重复员工逐项失败关闭', async () => {
    const store = assemble();
    const duplicateLines = [
      validCalculationMigration().lines[0],
      validCalculationMigration().lines[0],
    ];
    const invalidInputs: readonly Record<string, unknown>[] = [
      validCalculationMigration({ unexpected: true }),
      validCalculationMigration({ targetId: 'bad-target' }),
      validCalculationMigration({ periodId: 'bad-period' }),
      validCalculationMigration({ rulePackId: 'bad-rule' }),
      validCalculationMigration({ expectedPeriodVersion: 1 }),
      validCalculationMigration({ expectedPeriodVersion: 2.5 }),
      validCalculationMigration({ runNumber: 0, expectedPeriodVersion: 1 }),
      validCalculationMigration({ runNumber: 10_001, expectedPeriodVersion: 10_002 }),
      validCalculationMigration({ expectedPeriodVersion: 3 }),
      validCalculationMigration({ rulePackVersion: 0 }),
      validCalculationMigration({ rulePackVersion: 1.5 }),
      validCalculationMigration({ lines: [], expectedEmployeeCount: 0 }),
      validCalculationMigration({
        lines: Array.from({ length: 5_001 }, (_, index) => ({
          employeeId: `employee-${index}`,
          compensationProfileId: profileId,
          attendanceSnapshotId: attendanceId,
          expectedGrossMinor: 0,
          expectedWithholdingTaxMinor: 0,
          expectedNetMinor: 0,
        })),
        expectedEmployeeCount: 5_001,
      }),
      validCalculationMigration({ expectedEmployeeCount: 2 }),
      validCalculationMigration({ expectedEmployeeCount: 1.5 }),
      validCalculationMigration({ expectedTotalGrossMinor: -1 }),
      validCalculationMigration({ expectedTotalTaxMinor: 1.5 }),
      validCalculationMigration({ expectedTotalNetMinor: -1 }),
      validCalculationMigration({ migrationEvidenceRef: 'https://invalid' }),
      validCalculationMigration({ evidenceChecksum: 'short' }),
      validCalculationMigration({ lines: duplicateLines, expectedEmployeeCount: 2 }),
    ];

    for (const [index, input] of invalidInputs.entries()) {
      await expect(store.context.run({
        tenant,
        actor: migrationActor,
      }, () => store.service.importCalculationRunFromMigration(
        `run-migration-invalid-${index}`,
        input as never,
      ))).rejects.toMatchObject({
        response: { code: 'PAYROLL_MIGRATION_RUN_INPUT_INVALID' },
      });
    }
  });

  it('迁移员工行引用和控制金额逐项失败关闭', async () => {
    const store = assemble();
    const baseLine = validCalculationMigration().lines[0];
    const invalidLines = [
      { ...baseLine, unexpected: true },
      { ...baseLine, employeeId: 'bad id' },
      { ...baseLine, compensationProfileId: 'bad-profile' },
      { ...baseLine, attendanceSnapshotId: 'bad-attendance' },
      { ...baseLine, expectedGrossMinor: -1 },
      { ...baseLine, expectedWithholdingTaxMinor: 1.5 },
      { ...baseLine, expectedNetMinor: -1 },
    ];

    for (const [index, line] of invalidLines.entries()) {
      await expect(store.context.run({
        tenant,
        actor: migrationActor,
      }, () => store.service.importCalculationRunFromMigration(
        `run-line-invalid-${index}`,
        validCalculationMigration({ lines: [line] }) as never,
      ))).rejects.toMatchObject({
        response: { code: 'PAYROLL_MIGRATION_RUN_LINE_INVALID' },
      });
    }
  });

  it('迁移运行拒绝不存在周期、状态版本错配和不连续序号', async () => {
    const missing = assemble({
      periods: {
        create: vi.fn(),
        findOne: vi.fn().mockReturnValue(query(null)),
      },
    });
    await expect(missing.context.run({
      tenant,
      actor: migrationActor,
    }, () => missing.service.importCalculationRunFromMigration(
      'run-period-missing',
      validCalculationMigration() as never,
    ))).rejects.toMatchObject({
      response: { code: 'PAYROLL_MIGRATION_PERIOD_NOT_FOUND' },
    });

    const state = assemble({
      periods: {
        create: vi.fn(),
        findOne: vi.fn().mockReturnValue(query(periodRecord({ status: 'draft' }))),
      },
    });
    await expect(state.context.run({
      tenant,
      actor: migrationActor,
    }, () => state.service.importCalculationRunFromMigration(
      'run-state-invalid',
      validCalculationMigration() as never,
    ))).rejects.toMatchObject({
      response: { code: 'PAYROLL_MIGRATION_PERIOD_STATE_INVALID' },
    });

    const ruleSnapshot = {
      id: rulePackId,
      version: 1,
      monthlyBasicDeductionMinor: 50_000,
      taxBrackets: [{ upperBoundMinor: null, rateBps: 300, quickDeductionMinor: 0 }],
      roundingMode: 'HALF_UP',
    };
    const chain = assemble({
      periods: {
        create: vi.fn(),
        findOne: vi.fn().mockReturnValue(query(periodRecord())),
      },
      rulePacks: {
        findOne: vi.fn().mockReturnValue(query({
          ...ruleSnapshot,
          rulesHash: payrollDigest(ruleSnapshot),
        })),
      },
      runs: {
        findOne: vi.fn().mockReturnValue(query({ runNumber: 1 })),
      },
    });
    await expect(chain.context.run({
      tenant,
      actor: migrationActor,
    }, () => chain.service.importCalculationRunFromMigration(
      'run-chain-invalid',
      validCalculationMigration() as never,
    ))).rejects.toMatchObject({
      response: { code: 'PAYROLL_MIGRATION_RUN_CHAIN_INVALID' },
    });
  });

  it('迁移运行要求目标规则包在周期内有效且摘要完整', async () => {
    const store = assemble({
      periods: {
        create: vi.fn(),
        findOne: vi.fn().mockReturnValue(query(periodRecord())),
      },
      rulePacks: { findOne: vi.fn().mockReturnValue(query(null)) },
    });

    await expect(store.context.run({
      tenant,
      actor: migrationActor,
    }, () => store.service.importCalculationRunFromMigration(
      'run-rule-missing',
      validCalculationMigration() as never,
    ))).rejects.toThrow('PAYROLL_RULE_PACK_NOT_EFFECTIVE');
  });

  it('迁移运行只用目标事实重算并保存WORM证据与历史时间', async () => {
    const profile = compensationData();
    const rule = ruleData();
    const periods = {
      create: vi.fn(),
      findOne: vi.fn().mockReturnValue(query(periodRecord())),
      find: vi.fn().mockReturnValue(query([])),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const runs = {
      findOne: vi.fn().mockReturnValue(query(null)),
      create: vi.fn().mockResolvedValue([]),
    };
    const snapshots = { create: vi.fn().mockResolvedValue([]) };
    const calculationLines = { create: vi.fn().mockResolvedValue([]) };
    const store = assemble({
      periods,
      rulePacks: {
        findOne: vi.fn().mockReturnValue(query({
          ...rule,
          tenantId: 'tenant-001',
          status: 'published',
          effectiveFrom: '2026-01-01',
          effectiveTo: null,
          rulesHash: payrollDigest(rule),
        })),
      },
      compensation: {
        findOne: vi.fn().mockReturnValue(query({
          id: profileId,
          tenantId: 'tenant-001',
          employeeId: 'employee-001',
          status: 'active',
          effectiveFrom: '2026-01-01',
          effectiveTo: null,
          version: 1,
          profileHash: payrollDigest(profile),
          dataKeyId: 'key',
          dataIv: 'iv',
          dataCiphertext: 'cipher',
          dataAuthTag: 'tag',
        })),
      },
      attendance: {
        findOne: vi.fn().mockReturnValue(query({
          id: attendanceId,
          tenantId: 'tenant-001',
          employeeId: 'employee-001',
          month: '2026-06',
          status: 'active',
          snapshotHash: 's'.repeat(43),
          workedMinutes: 0,
          leaveMinutes: 0,
          overtimeMinutes: 0,
          absentMinutes: 0,
        })),
      },
      runs,
      snapshots,
      calculationLines,
      crypto: {
        unprotect: vi.fn().mockReturnValue(profile),
        protect: vi.fn().mockReturnValue({
          keyId: 'payroll-key',
          iv: 'i'.repeat(16),
          ciphertext: 'ciphertext',
          authTag: 'a'.repeat(22),
        }),
      },
    });

    await expect(store.context.run({
      tenant,
      actor: migrationActor,
    }, () => store.service.importCalculationRunFromMigration(
      'run-migration-success',
      validCalculationMigration() as never,
    ))).resolves.toMatchObject({
      periodId,
      runNumber: 1,
      employeeCount: 1,
      totalGrossMinor: 100_000,
      totalTaxMinor: 1_500,
      totalNetMinor: 98_500,
    });
    expect(runs.create).toHaveBeenCalledWith([
      expect.objectContaining({
        tenantId: 'tenant-001',
        periodId,
        runNumber: 1,
        status: 'completed',
        completedAt: new Date('2026-06-03T00:00:00.000Z'),
        migrationEvidenceChecksum: 'e'.repeat(43),
      }),
    ], { session });
    expect(snapshots.create).toHaveBeenCalledOnce();
    expect(calculationLines.create).toHaveBeenCalledOnce();
    expect(periods.updateOne.mock.calls[0]?.[0]).toMatchObject({
      tenantId: 'tenant-001',
      id: periodId,
      version: 2,
    });
    expect(periods.updateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: {
        status: 'review',
        version: 3,
        updatedAt: new Date('2026-06-03T00:00:00.000Z'),
      },
    });
    expect(periods.updateOne.mock.calls[0]?.[2]).toMatchObject({
      session,
      timestamps: false,
    });
    expect(store.outbox.append.mock.calls[0]?.[0]).toMatchObject({
      type: 'payroll.run.migrated',
      version: 3,
      data: { employeeCount: 1 },
    });
    expect(store.outbox.append.mock.calls[0]?.[1]).toBe(session);
  });

  it('既有迁移运行只有密文输入、结果和周期摘要全部一致时才幂等返回', async () => {
    const targetId = '01J8ZQK7V0A2M4N6P8R0T2W4N1';
    const rule = ruleData() as never;
    const calculationInput = {
      tenantId: 'tenant-001',
      employeeId: 'employee-001',
      period: '2026-06',
      currency: 'CNY' as const,
      engineVersion: 'cn-cumulative-withholding-v1',
      rulePack: rule,
      taxableEarnings: [{ code: 'BASE', amountMinor: 100_000 }],
      nonTaxableEarnings: [],
      employeeSocialInsuranceMinor: 0,
      employeeHousingFundMinor: 0,
      specialAdditionalDeductionMinor: 0,
      otherPreTaxWithholdingMinor: 0,
      postTaxDeductionMinor: 0,
      cumulativeBefore: {
        taxableIncomeMinor: 0,
        basicDeductionMinor: 0,
        socialInsuranceMinor: 0,
        housingFundMinor: 0,
        specialAdditionalDeductionMinor: 0,
        otherDeductionMinor: 0,
        taxWithheldMinor: 0,
      },
    };
    const calculated = calculatePayroll(calculationInput);
    const snapshot = {
      id: 'snapshot-001',
      employeeId: 'employee-001',
      compensationProfileId: profileId,
      attendanceSnapshotId: attendanceId,
      attendanceSnapshotHash: 's'.repeat(43),
      inputHash: calculated.inputHash,
      dataKeyId: 'key',
      dataIv: 'iv',
      dataCiphertext: 'cipher',
      dataAuthTag: 'tag',
    };
    const resultLine = {
      id: 'line-001',
      employeeId: 'employee-001',
      resultHash: calculated.resultHash,
      dataKeyId: 'key',
      dataIv: 'iv',
      dataCiphertext: 'cipher',
      dataAuthTag: 'tag',
    };
    const inputSnapshotHash = payrollDigest([{
      employeeId: snapshot.employeeId,
      compensationProfileId: snapshot.compensationProfileId,
      attendanceSnapshotId: snapshot.attendanceSnapshotId,
      attendanceSnapshotHash: snapshot.attendanceSnapshotHash,
      inputHash: snapshot.inputHash,
    }]);
    const resultHash = payrollDigest([{
      employeeId: resultLine.employeeId,
      resultHash: resultLine.resultHash,
    }]);
    const completedAt = '2026-06-03T00:00:00.000Z';
    const run = {
      id: targetId,
      tenantId: 'tenant-001',
      periodId,
      period: '2026-06',
      runNumber: 1,
      engineVersion: 'cn-cumulative-withholding-v1',
      rulePackId,
      rulePackVersion: 1,
      status: 'completed',
      inputSnapshotHash,
      resultHash,
      employeeCount: 1,
      totalGrossMinor: calculated.grossPayMinor,
      totalTaxMinor: calculated.withholdingTaxMinor,
      totalNetMinor: calculated.netPayMinor,
      completedAt: new Date(completedAt),
      createdAt: new Date(completedAt),
      updatedAt: new Date(completedAt),
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/run-001',
      migrationEvidenceChecksum: 'e'.repeat(43),
    };
    const period = periodRecord({
      status: 'review',
      version: 3,
      activeRunId: targetId,
      inputSnapshotHash,
      resultHash,
      employeeCount: 1,
      totalGrossMinor: calculated.grossPayMinor,
      totalTaxMinor: calculated.withholdingTaxMinor,
      totalNetMinor: calculated.netPayMinor,
      updatedAt: new Date(completedAt),
    });
    const input = validCalculationMigration({
      targetId,
      expectedTotalGrossMinor: calculated.grossPayMinor,
      expectedTotalTaxMinor: calculated.withholdingTaxMinor,
      expectedTotalNetMinor: calculated.netPayMinor,
      lines: [{
        employeeId: 'employee-001',
        compensationProfileId: profileId,
        attendanceSnapshotId: attendanceId,
        expectedGrossMinor: calculated.grossPayMinor,
        expectedWithholdingTaxMinor: calculated.withholdingTaxMinor,
        expectedNetMinor: calculated.netPayMinor,
      }],
    });
    const crypto = {
      unprotect: vi.fn()
        .mockReturnValueOnce(calculationInput)
        .mockReturnValueOnce(calculated),
    };
    const store = assemble({
      periods: {
        create: vi.fn(),
        findOne: vi.fn().mockReturnValue(query(period)),
      },
      runs: { findOne: vi.fn().mockReturnValue(query(run)) },
      snapshots: { find: vi.fn().mockReturnValue(query([snapshot])) },
      calculationLines: { find: vi.fn().mockReturnValue(query([resultLine])) },
      crypto,
    });

    await expect(store.context.run({
      tenant,
      actor: migrationActor,
    }, () => store.service.importCalculationRunFromMigration(
      'run-replay-success',
      input as never,
    ))).resolves.toMatchObject({
      id: targetId,
      periodId,
      runNumber: 1,
      employeeCount: 1,
    });
    expect(crypto.unprotect).toHaveBeenCalledTimes(2);
  });
});
