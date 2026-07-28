import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  createAttendanceProviderCoverage,
  createAttendanceShiftAssignment,
  createAttendanceShiftRule,
} from '../domain/index.js';
import {
  AttendanceProviderCoverageRepository,
  AttendanceShiftAssignmentRepository,
  AttendanceShiftRuleRepository,
} from './attendance-rules.repositories.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const actor: ActorContext = {
  actorType: 'system_job',
  actorId: 'actor-001',
  tenantId: tenant.tenantId,
  roleCodes: [],
  scopes: [],
  departmentIds: [],
  traceId: 'trace-001',
};
const session = {} as ClientSession;

function chain<T>(value: T) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  query.sort = vi.fn(() => query);
  query.session = vi.fn(() => query);
  query.lean = vi.fn(() => query);
  query.exec = vi.fn().mockResolvedValue(value);
  return query;
}

function ruleRecord() {
  return {
    id: 'shift-rule-001',
    tenantId: tenant.tenantId,
    rulesetVersion: 'attendance-cn-v1',
    shiftCode: 'DAY_SHIFT',
    timeZone: 'Asia/Shanghai',
    startLocalTime: '09:00',
    endLocalTime: '18:00',
    workdays: [1, 2, 3, 4, 5],
    plannedMinutes: 480,
    lateGraceMinutes: 5,
    earlyLeaveGraceMinutes: 5,
    crossMidnightPunchOutGraceMinutes: 0,
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    governanceEvidenceId: 'approval-rule-001',
    evidenceChecksum: 'r'.repeat(43),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function assignmentRecord() {
  return {
    id: 'assignment-001',
    tenantId: tenant.tenantId,
    employeeId: 'employee-001',
    shiftRuleId: 'shift-rule-001',
    providerCode: 'dingtalk' as const,
    effectiveFrom: '2026-04-01',
    effectiveTo: '2026-04-30',
    governanceEvidenceId: 'approval-assignment-001',
    evidenceChecksum: 'a'.repeat(43),
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
  };
}

function coverageRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'coverage-001',
    tenantId: tenant.tenantId,
    employeeId: 'employee-001',
    providerCode: 'dingtalk' as const,
    providerStateId: 'state-001',
    providerMappingId: 'mapping-001',
    month: '2026-04',
    throughBusinessDate: '2026-04-30',
    sourceCutoffAt: new Date('2026-05-01T00:00:00.000Z'),
    evidenceChecksum: 'e'.repeat(43),
    createdAt: new Date('2026-05-01T00:01:00.000Z'),
    ...overrides,
  };
}

describe('Attendance 规则仓储', () => {
  it('规则读取始终带可信租户并恢复不可变领域对象', async () => {
    const context = new TenantContextService();
    const one = chain(ruleRecord());
    const many = chain([ruleRecord()]);
    const model = {
      findOne: vi.fn(() => one),
      find: vi.fn(() => many),
      create: vi.fn().mockResolvedValue(undefined),
    };
    const repository = new AttendanceShiftRuleRepository(context, model as never);
    await context.run({ tenant, actor }, async () => {
      await expect(repository.findById('shift-rule-001')).resolves.toEqual(
        expect.objectContaining({
          tenantId: tenant.tenantId,
          workdays: [1, 2, 3, 4, 5],
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
      );
      await expect(repository.findForMonth('attendance-cn-v1', '2026-04', session))
        .resolves.toHaveLength(1);
    });
    expect(model.findOne).toHaveBeenCalledWith({
      tenantId: tenant.tenantId,
      id: 'shift-rule-001',
    });
    expect(model.find).toHaveBeenCalledWith({
      tenantId: tenant.tenantId,
      rulesetVersion: 'attendance-cn-v1',
      effectiveFrom: { $lte: '2026-04-30' },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gte: '2026-04-01' } }],
    });
    expect(Object.isFrozen((await context.run(
      { tenant, actor },
      () => repository.findById('shift-rule-001'),
    ))?.workdays)).toBe(true);
  });

  it('规则单条读取支持事务会话且不存在时返回空值', async () => {
    const context = new TenantContextService();
    const query = chain(null);
    const model = { findOne: vi.fn(() => query) };
    const repository = new AttendanceShiftRuleRepository(context, model as never);
    await expect(context.run(
      { tenant, actor },
      () => repository.findById('shift-rule-missing', session),
    )).resolves.toBeNull();
    expect(query.session).toHaveBeenCalledWith(session);
  });

  it('规则写入复制数组、固定时间并拒绝跨租户实体', async () => {
    const context = new TenantContextService();
    const model = { create: vi.fn().mockResolvedValue(undefined) };
    const repository = new AttendanceShiftRuleRepository(context, model as never);
    const domain = createAttendanceShiftRule({
      ...ruleRecord(),
      createdAt: undefined,
    } as never, new Date('2026-01-01T00:00:00.000Z'));
    await context.run({ tenant, actor }, () => repository.insert(domain, session));
    expect(model.create).toHaveBeenCalledWith([
      expect.objectContaining({
        workdays: [1, 2, 3, 4, 5],
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    ], { session });
    await expect(context.run({ tenant, actor }, () => repository.insert(
      Object.freeze({ ...domain, tenantId: 'tenant-other' }),
      session,
    ))).rejects.toThrow('CROSS_TENANT');
  });

  it('排班范围查询固定租户、员工和闭区间并恢复领域对象', async () => {
    const context = new TenantContextService();
    const query = chain([assignmentRecord()]);
    const model = {
      find: vi.fn(() => query),
      create: vi.fn().mockResolvedValue(undefined),
    };
    const guards = { findOneAndUpdate: vi.fn() };
    const repository = new AttendanceShiftAssignmentRepository(
      context,
      model as never,
      guards as never,
    );
    const values = await context.run({ tenant, actor }, () =>
      repository.findForMonth('employee-001', '2026-04', session));
    expect(values).toEqual([
      expect.objectContaining({
        id: 'assignment-001',
        providerCode: 'dingtalk',
        createdAt: '2026-03-01T00:00:00.000Z',
      }),
    ]);
    expect(model.find).toHaveBeenCalledWith({
      tenantId: tenant.tenantId,
      employeeId: 'employee-001',
      effectiveFrom: { $lte: '2026-04-30' },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gte: '2026-04-01' } }],
    });
  });

  it('开放排班重叠查询使用上界且写入保持不可变字段', async () => {
    const context = new TenantContextService();
    const query = chain([]);
    const model = {
      find: vi.fn(() => query),
      create: vi.fn().mockResolvedValue(undefined),
    };
    const guardQuery = { exec: vi.fn().mockResolvedValue(undefined) };
    const guards = { findOneAndUpdate: vi.fn(() => guardQuery) };
    const repository = new AttendanceShiftAssignmentRepository(
      context,
      model as never,
      guards as never,
    );
    const domain = createAttendanceShiftAssignment({
      ...assignmentRecord(),
      effectiveTo: null,
      createdAt: undefined,
    } as never, new Date('2026-03-01T00:00:00.000Z'));
    await context.run({ tenant, actor }, async () => {
      await repository.serializeEmployee('employee-001', session);
      await repository.findOverlapping('employee-001', '2026-04-01', null);
      await repository.insert(domain, session);
    });
    expect(guards.findOneAndUpdate).toHaveBeenCalledWith(
      { tenantId: tenant.tenantId, employeeId: 'employee-001' },
      {
        $inc: { revision: 1 },
        $setOnInsert: { tenantId: tenant.tenantId, employeeId: 'employee-001' },
      },
      { upsert: true, session, setDefaultsOnInsert: true },
    );
    expect(guardQuery.exec).toHaveBeenCalledOnce();
    expect(model.find).toHaveBeenCalledWith(expect.objectContaining({
      effectiveFrom: { $lte: '9999-12-31' },
    }));
    expect(model.create).toHaveBeenCalledWith([
      expect.objectContaining({
        effectiveTo: null,
        updatedAt: new Date('2026-03-01T00:00:00.000Z'),
      }),
    ], { session });
  });

  it('覆盖证明读取只返回每个 Provider 截止点之前最新一条', async () => {
    const context = new TenantContextService();
    const records = [
      coverageRecord(),
      coverageRecord({
        id: 'coverage-older',
        sourceCutoffAt: new Date('2026-04-30T23:00:00.000Z'),
      }),
      coverageRecord({
        id: 'coverage-feishu',
        providerCode: 'feishu',
        providerStateId: 'state-feishu',
        providerMappingId: 'mapping-feishu',
      }),
    ];
    const query = chain(records);
    const model = {
      find: vi.fn(() => query),
      create: vi.fn().mockResolvedValue(undefined),
    };
    const repository = new AttendanceProviderCoverageRepository(context, model as never);
    const cutoff = new Date('2026-05-01T00:30:00.000Z');
    const values = await context.run({ tenant, actor }, () =>
      repository.findForMonth('employee-001', '2026-04', cutoff, session));
    expect(values.map((value) => value.id)).toEqual(['coverage-001', 'coverage-feishu']);
    expect(model.find).toHaveBeenCalledWith({
      tenantId: tenant.tenantId,
      employeeId: 'employee-001',
      month: '2026-04',
      sourceCutoffAt: { $lte: cutoff },
    });
  });

  it('覆盖证明写入标准化 UTC 时间并拒绝跨租户', async () => {
    const context = new TenantContextService();
    const model = { create: vi.fn().mockResolvedValue(undefined) };
    const repository = new AttendanceProviderCoverageRepository(context, model as never);
    const domain = createAttendanceProviderCoverage({
      id: 'coverage-001',
      tenantId: tenant.tenantId,
      employeeId: 'employee-001',
      providerCode: 'dingtalk',
      providerStateId: 'state-001',
      providerMappingId: 'mapping-001',
      month: '2026-04',
      throughBusinessDate: '2026-04-30',
      sourceCutoffAt: '2026-05-01T00:00:00.000Z',
    }, new Date('2026-05-01T00:01:00.000Z'));
    await context.run({ tenant, actor }, () => repository.insert(domain, session));
    expect(model.create).toHaveBeenCalledWith([
      expect.objectContaining({
        sourceCutoffAt: new Date('2026-05-01T00:00:00.000Z'),
        createdAt: new Date('2026-05-01T00:01:00.000Z'),
      }),
    ], { session });
    await expect(context.run({ tenant, actor }, () => repository.insert(
      Object.freeze({ ...domain, tenantId: 'tenant-other' }),
      session,
    ))).rejects.toThrow('CROSS_TENANT');
  });
});
