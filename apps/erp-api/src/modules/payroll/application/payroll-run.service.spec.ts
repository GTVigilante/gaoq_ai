import type { ActorContext } from '@gaoq/shared-types';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { payrollDigest } from '../domain/index.js';
import { PayrollRunService } from './payroll-run.service.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const session = {} as ClientSession;

function actor(scopes: readonly string[], actorType: ActorContext['actorType'] = 'user'): ActorContext {
  return {
    actorType, actorId: 'actor-001', tenantId: tenant.tenantId,
    roleCodes: ['payroll'], scopes, departmentIds: [], traceId: 'trace-001',
  };
}

function assemble() {
  const context = new TenantContextService();
  const idempotency = { execute: vi.fn(async (
    _operation: string,
    _key: string,
    _request: unknown,
    handler: (value: ClientSession) => Promise<Record<string, unknown>>,
  ) => handler(session)) };
  const periods = { create: vi.fn().mockResolvedValue([]), findOne: vi.fn() };
  const profiles = { findActorIdByEmployee: vi.fn().mockResolvedValue('actor-preparer-001') };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const service = new PayrollRunService(
    idempotency as never, context, profiles as never, {} as never, outbox as never,
    periods as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never,
  );
  return { context, idempotency, periods, profiles, outbox, service };
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
      jurisdictionCode: 'CN-SH',
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
      ...ruleSnapshot, tenantId: 'tenant-001', jurisdictionCode: 'CN', status: 'published',
      effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31',
      rulesHash: payrollDigest(ruleSnapshot),
    })) };
    const compensation = { findOne: vi.fn().mockReturnValue(query({
      id: profileId, tenantId: 'tenant-001', employeeId: 'employee-001', version: 1,
      jurisdictionCode: 'CN-SH',
      effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31',
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

describe('PayrollRunService 月中薪酬运行', () => {
  it('只按明确档案引用完成跨法域自然日分摊并冻结输入证据', async () => {
    const context = new TenantContextService();
    const idempotency = { execute: vi.fn(async (
      _operation: string, _key: string, _request: unknown,
      handler: (value: ClientSession) => Promise<Record<string, unknown>>,
    ) => handler(session)) };
    const periodId = '01J8ZQK7V0A2M4N6P8R0T2W4P1';
    const rulePackId = '01J8ZQK7V0A2M4N6P8R0T2W4R1';
    const firstProfileId = '01J8ZQK7V0A2M4N6P8R0T2W4C1';
    const secondProfileId = '01J8ZQK7V0A2M4N6P8R0T2W4C2';
    const attendanceId = '01J8ZQK7V0A2M4N6P8R0T2W4A1';
    const rates = {
      overtimePayMinorPerMinute: 0, absenceDeductionMinorPerMinute: 0,
      unpaidLeaveDeductionMinorPerMinute: 0,
    };
    const firstData = {
      currency: 'CNY' as const, jurisdictionCode: 'CN-SH',
      taxableEarnings: [{ code: 'BASE', amountMinor: 310_000 }],
      nonTaxableEarnings: [], employeeSocialInsuranceMinor: 0,
      employeeHousingFundMinor: 0, specialAdditionalDeductionMinor: 0,
      otherPreTaxWithholdingMinor: 0, postTaxDeductionMinor: 0,
      attendanceAdjustment: rates,
    };
    const secondData = {
      ...firstData, jurisdictionCode: 'CN-BJ',
      taxableEarnings: [{ code: 'BASE', amountMinor: 620_000 }],
    };
    const ruleSnapshot = {
      id: rulePackId, version: 1, monthlyBasicDeductionMinor: 50_000,
      taxBrackets: [{ upperBoundMinor: null, rateBps: 300, quickDeductionMinor: 0 }],
      roundingMode: 'HALF_UP' as const,
    };
    const current = {
      id: periodId, tenantId: 'tenant-001', period: '2026-07', currency: 'CNY',
      status: 'collecting', preparedBy: 'actor-preparer-001', version: 2,
      activeRunId: null, inputSnapshotHash: null, resultHash: null, employeeCount: null,
      totalGrossMinor: null, totalTaxMinor: null, totalNetMinor: null,
      approvalReferenceType: null, approvalInstanceId: null, approvedBy: null,
      approvalEvidenceId: null, lockedBy: null, strongAuthEvidenceId: null,
      strongAuthReferenceType: null, disbursementBatchId: null,
      disbursementPreparedBy: null, disbursementExportEvidenceId: null,
      reconciliationEvidenceId: null, reconciledBy: null,
      migrationEvidenceRef: null, migrationEvidenceChecksum: null,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      updatedAt: new Date('2026-07-02T00:00:00.000Z'),
    };
    const periods = {
      findOne: vi.fn().mockReturnValue(query(current)),
      find: vi.fn().mockReturnValue(query([])),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const rulePacks = { findOne: vi.fn().mockReturnValue(query({
      ...ruleSnapshot, tenantId: 'tenant-001', code: 'CN_IIT',
      jurisdictionCode: 'CN', effectiveFrom: '2026-01-01', effectiveTo: null,
      status: 'published', rulesHash: payrollDigest(ruleSnapshot),
    })) };
    const compensation = { find: vi.fn().mockReturnValue(query([
      {
        id: firstProfileId, tenantId: 'tenant-001', employeeId: 'employee-001',
        jurisdictionCode: 'CN-SH', version: 1, status: 'active',
        effectiveFrom: '2026-01-01', effectiveTo: '2026-07-15',
        profileHash: payrollDigest(firstData), dataKeyId: 'key', dataIv: 'iv',
        dataCiphertext: 'cipher-1', dataAuthTag: 'tag',
      },
      {
        id: secondProfileId, tenantId: 'tenant-001', employeeId: 'employee-001',
        jurisdictionCode: 'CN-BJ', version: 2, status: 'active',
        effectiveFrom: '2026-07-16', effectiveTo: null,
        profileHash: payrollDigest(secondData), dataKeyId: 'key', dataIv: 'iv',
        dataCiphertext: 'cipher-2', dataAuthTag: 'tag',
      },
    ])) };
    const attendance = { findOne: vi.fn().mockReturnValue(query({
      id: attendanceId, employeeId: 'employee-001', month: '2026-07', status: 'active',
      snapshotHash: 's'.repeat(43), workedMinutes: 0, leaveMinutes: 0,
      overtimeMinutes: 0, absentMinutes: 0,
    })) };
    const protectedInputs: unknown[] = [];
    const crypto = {
      unprotect: vi.fn((aad: { resourceId: string }) =>
        aad.resourceId === firstProfileId ? firstData : secondData),
      protect: vi.fn((_aad: unknown, value: unknown) => {
        protectedInputs.push(value);
        return {
          keyId: 'payroll-key-001', iv: 'i'.repeat(16),
          ciphertext: 'c'.repeat(32), authTag: 'a'.repeat(22),
        };
      }),
    };
    const runs = {
      findOne: vi.fn().mockReturnValue(query(null)),
      create: vi.fn().mockResolvedValue([]),
    };
    const snapshots = { create: vi.fn().mockResolvedValue([]) };
    const calculationLines = { create: vi.fn().mockResolvedValue([]) };
    const outbox = { append: vi.fn().mockResolvedValue(undefined) };
    const service = new PayrollRunService(
      idempotency as never, context, {} as never, crypto as never, outbox as never,
      periods as never, rulePacks as never, compensation as never, attendance as never,
      runs as never, snapshots as never, calculationLines as never,
    );

    const result = await context.run({
      tenant, actor: actor(['erp:payroll:run:execute'], 'system_job'),
    }, () => service.executeRun('payroll-run-proration-001', {
      periodId, expectedVersion: 2, rulePackId, rulePackVersion: 1,
      lines: [{
        employeeId: 'employee-001', compensationProfileId: firstProfileId,
        additionalCompensationProfileIds: [secondProfileId],
        attendanceSnapshotId: attendanceId,
      }],
    }));

    expect(result).toMatchObject({
      status: 'review', employeeCount: 1,
      totalGrossMinor: 470_000, totalTaxMinor: 12_600, totalNetMinor: 457_400,
    });
    expect(protectedInputs[0]).toMatchObject({
      taxableEarnings: [{ code: 'BASE', amountMinor: 470_000 }],
      compensationAllocations: [
        expect.objectContaining({ jurisdictionCode: 'CN-SH', allocatedDays: 15 }),
        expect.objectContaining({ jurisdictionCode: 'CN-BJ', allocatedDays: 16 }),
      ],
    });
    expect(snapshots.create).toHaveBeenCalledWith([
      expect.objectContaining({
        compensationProfileId: firstProfileId,
        compensationProfileIds: [firstProfileId, secondProfileId],
      }),
    ], { session });

    await expect(context.run({
      tenant, actor: actor(['erp:payroll:run:execute'], 'system_job'),
    }, () => service.executeRun('payroll-run-proration-order-invalid', {
      periodId, expectedVersion: 2, rulePackId, rulePackVersion: 1,
      lines: [{
        employeeId: 'employee-001', compensationProfileId: secondProfileId,
        additionalCompensationProfileIds: [firstProfileId],
        attendanceSnapshotId: attendanceId,
      }],
    }))).rejects.toThrow('薪酬档案引用必须按生效顺序排列');
  });
});
