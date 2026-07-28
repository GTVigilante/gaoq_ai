import type { ActorContext } from '@gaoq/shared-types';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  createAttendanceProviderCoverage,
  createAttendanceShiftAssignment,
  createAttendanceShiftRule,
  type AttendanceSourceFact,
} from '../domain/index.js';
import { AttendanceRuleApplicationService } from './attendance-rule-application.service.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const session = {} as ClientSession;

function actor(
  scopes: readonly string[],
  actorType: ActorContext['actorType'] = 'service',
): ActorContext {
  return {
    actorType,
    actorId: 'attendance-governance-service',
    tenantId: tenant.tenantId,
    roleCodes: [],
    scopes,
    departmentIds: [],
    traceId: 'trace-001',
  };
}

const ruleInput = {
  rulesetVersion: 'attendance-cn-2026-v1',
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
  governanceEvidenceId: 'approval-rule-001',
  evidenceChecksum: 'r'.repeat(43),
};

const assignmentInput = {
  employeeId: 'employee-001',
  shiftRuleId: 'shift-rule-001',
  providerCode: 'dingtalk' as const,
  effectiveFrom: '2026-04-01',
  effectiveTo: '2026-04-30',
  governanceEvidenceId: 'approval-assignment-001',
  evidenceChecksum: 'a'.repeat(43),
};

const openAssignmentInput = {
  employeeId: assignmentInput.employeeId,
  shiftRuleId: assignmentInput.shiftRuleId,
  providerCode: assignmentInput.providerCode,
  effectiveFrom: assignmentInput.effectiveFrom,
  governanceEvidenceId: assignmentInput.governanceEvidenceId,
  evidenceChecksum: assignmentInput.evidenceChecksum,
};

function storedRule() {
  return createAttendanceShiftRule({
    id: 'shift-rule-001',
    tenantId: tenant.tenantId,
    ...ruleInput,
    effectiveTo: null,
  }, new Date('2026-03-01T00:00:00.000Z'));
}

function assemble() {
  const context = new TenantContextService();
  const idempotency = {
    execute: vi.fn(async (
      _operation: string,
      _key: string,
      _request: unknown,
      handler: (value: ClientSession) => Promise<Record<string, unknown>>,
    ) => handler(session)),
  };
  const employments = {
    findOverlappingByEmployeeIds: vi.fn().mockResolvedValue([{
      id: 'employment-001',
      tenantId: tenant.tenantId,
      employeeId: 'employee-001',
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
    }]),
  };
  const rules = {
    findById: vi.fn().mockResolvedValue(storedRule()),
    findForMonth: vi.fn().mockResolvedValue([storedRule()]),
    insert: vi.fn().mockResolvedValue(undefined),
  };
  const assignments = {
    serializeEmployee: vi.fn().mockResolvedValue(undefined),
    findOverlapping: vi.fn().mockResolvedValue([]),
    findForMonth: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockResolvedValue(undefined),
  };
  const coverages = {
    findForMonth: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockResolvedValue(undefined),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const service = new AttendanceRuleApplicationService(
    idempotency as never,
    context,
    employments as never,
    rules as never,
    assignments as never,
    coverages as never,
    outbox as never,
  );
  return {
    service,
    context,
    idempotency,
    employments,
    rules,
    assignments,
    coverages,
    outbox,
  };
}

function run<T>(
  store: ReturnType<typeof assemble>,
  scopes: readonly string[],
  operation: () => Promise<T>,
  actorType: ActorContext['actorType'] = 'service',
): Promise<T> {
  return store.context.run({ tenant, actor: actor(scopes, actorType) }, operation);
}

describe('AttendanceRuleApplicationService', () => {
  it('受信任服务幂等登记不可变班次并发布最小 CloudEvent', async () => {
    const store = assemble();
    const result = await run(
      store,
      ['erp:attendance:rule:attest'],
      () => store.service.attestRule('attendance-rule-key-001', ruleInput),
    );
    expect(store.rules.insert).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: tenant.tenantId,
      rulesetVersion: ruleInput.rulesetVersion,
      shiftCode: ruleInput.shiftCode,
    }), session);
    const event = store.outbox.append.mock.calls[0]?.[0] as {
      readonly type: string;
      readonly data: Readonly<Record<string, unknown>>;
    };
    expect(event.type).toBe('attendance.shift_rule.attested');
    expect(event.data.rulesetVersion).toBe(ruleInput.rulesetVersion);
    expect(event.data.evidenceChecksum).toBe(ruleInput.evidenceChecksum);
    expect(result.rule).not.toHaveProperty('workdays');
    expect(JSON.stringify(store.outbox.append.mock.calls)).not.toContain('09:00');
  });

  it.each([
    ['用户身份', 'user' as const, ['erp:attendance:rule:attest']],
    ['缺少 Scope', 'service' as const, []],
  ])('%s 不能登记班次规则', async (_name, actorType, scopes) => {
    const store = assemble();
    await expect(run(
      store,
      scopes,
      () => store.service.attestRule('attendance-rule-key-001', ruleInput),
      actorType,
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(store.idempotency.execute).not.toHaveBeenCalled();
  });

  it('领域输入错误映射为稳定 400，唯一冲突映射为稳定 409', async () => {
    const invalid = assemble();
    await expect(run(
      invalid,
      ['erp:attendance:rule:attest'],
      () => invalid.service.attestRule('attendance-rule-invalid', {
        ...ruleInput,
        timeZone: 'Not/AZone',
      }),
    )).rejects.toMatchObject({
      response: { code: 'ATTENDANCE_TIME_ZONE_INVALID' },
    });
    const duplicate = assemble();
    duplicate.rules.insert.mockRejectedValue({ code: 11_000 });
    await expect(run(
      duplicate,
      ['erp:attendance:rule:attest'],
      () => duplicate.service.attestRule('attendance-rule-duplicate', ruleInput),
    )).rejects.toBeInstanceOf(ConflictException);
  });

  it('排班登记同时验证规则、重叠和唯一劳动关系完整覆盖', async () => {
    const store = assemble();
    const result = await run(
      store,
      ['erp:attendance:shift_assignment:attest'],
      () => store.service.attestAssignment('attendance-assignment-key-001', assignmentInput),
    );
    expect(store.assignments.serializeEmployee).toHaveBeenCalledWith('employee-001', session);
    expect(store.assignments.findOverlapping).toHaveBeenCalledWith(
      'employee-001',
      '2026-04-01',
      '2026-04-30',
      session,
    );
    expect(store.employments.findOverlappingByEmployeeIds).toHaveBeenCalledWith(
      ['employee-001'],
      '2026-04-01',
      '2026-04-30',
      session,
    );
    expect(store.assignments.insert).toHaveBeenCalledWith(expect.objectContaining({
      shiftRuleId: 'shift-rule-001',
      providerCode: 'dingtalk',
    }), session);
    expect(result.assignment).toEqual(expect.objectContaining({
      employeeId: 'employee-001',
      effectiveTo: '2026-04-30',
    }));
  });

  it('排班拒绝不存在的规则、重叠区间和不完整劳动关系', async () => {
    const missing = assemble();
    missing.rules.findById.mockResolvedValue(null);
    await expect(run(
      missing,
      ['erp:attendance:shift_assignment:attest'],
      () => missing.service.attestAssignment('assignment-missing-rule', assignmentInput),
    )).rejects.toBeInstanceOf(NotFoundException);

    const overlap = assemble();
    overlap.assignments.findOverlapping.mockResolvedValue([createAttendanceShiftAssignment({
      id: 'shift-assignment-existing',
      tenantId: tenant.tenantId,
      ...assignmentInput,
    }, new Date())]);
    await expect(run(
      overlap,
      ['erp:attendance:shift_assignment:attest'],
      () => overlap.service.attestAssignment('assignment-overlap', assignmentInput),
    )).rejects.toMatchObject({
      response: { code: 'ATTENDANCE_SHIFT_ASSIGNMENT_OVERLAP' },
    });

    const employmentGap = assemble();
    employmentGap.employments.findOverlappingByEmployeeIds.mockResolvedValue([{
      id: 'employment-001',
      tenantId: tenant.tenantId,
      employeeId: 'employee-001',
      effectiveFrom: '2026-04-10',
      effectiveTo: null,
    }]);
    await expect(run(
      employmentGap,
      ['erp:attendance:shift_assignment:attest'],
      () => employmentGap.service.attestAssignment('assignment-gap', assignmentInput),
    )).rejects.toMatchObject({
      response: { code: 'ATTENDANCE_SHIFT_OUTSIDE_EMPLOYMENT' },
    });
  });

  it('排班有效区间不得超出规则有效区间', async () => {
    const store = assemble();
    store.rules.findById.mockResolvedValue(createAttendanceShiftRule({
      id: 'shift-rule-001',
      tenantId: tenant.tenantId,
      ...ruleInput,
      effectiveFrom: '2026-04-10',
      effectiveTo: '2026-04-20',
    }, new Date()));
    await expect(run(
      store,
      ['erp:attendance:shift_assignment:attest'],
      () => store.service.attestAssignment('assignment-rule-range', assignmentInput),
    )).rejects.toMatchObject({
      response: { code: 'ATTENDANCE_SHIFT_RULE_INTERVAL_MISMATCH' },
    });
  });

  it('开放排班只允许落在开放规则和开放劳动关系内', async () => {
    const valid = assemble();
    const result = await run(
      valid,
      ['erp:attendance:shift_assignment:attest'],
      () => valid.service.attestAssignment('assignment-open-valid', openAssignmentInput),
    );
    expect(result.assignment.effectiveTo).toBeNull();
    expect(valid.employments.findOverlappingByEmployeeIds).toHaveBeenCalledWith(
      ['employee-001'],
      '2026-04-01',
      '9999-12-31',
      session,
    );

    const finiteRule = assemble();
    finiteRule.rules.findById.mockResolvedValue(createAttendanceShiftRule({
      id: 'shift-rule-001',
      tenantId: tenant.tenantId,
      ...ruleInput,
      effectiveTo: '2026-12-31',
    }, new Date()));
    await expect(run(
      finiteRule,
      ['erp:attendance:shift_assignment:attest'],
      () => finiteRule.service.attestAssignment(
        'assignment-open-finite-rule',
        openAssignmentInput,
      ),
    )).rejects.toMatchObject({
      response: { code: 'ATTENDANCE_SHIFT_RULE_INTERVAL_MISMATCH' },
    });
  });

  it('排班完整覆盖只接受同一员工且覆盖到排班末日的唯一劳动关系', async () => {
    const wrongEmployee = assemble();
    wrongEmployee.employments.findOverlappingByEmployeeIds.mockResolvedValue([{
      id: 'employment-other',
      tenantId: tenant.tenantId,
      employeeId: 'employee-other',
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
    }]);
    await expect(run(
      wrongEmployee,
      ['erp:attendance:shift_assignment:attest'],
      () => wrongEmployee.service.attestAssignment('assignment-wrong-employee', assignmentInput),
    )).rejects.toMatchObject({
      response: { code: 'ATTENDANCE_SHIFT_OUTSIDE_EMPLOYMENT' },
    });

    const earlyEnd = assemble();
    earlyEnd.employments.findOverlappingByEmployeeIds.mockResolvedValue([{
      id: 'employment-early-end',
      tenantId: tenant.tenantId,
      employeeId: 'employee-001',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-04-29',
    }]);
    await expect(run(
      earlyEnd,
      ['erp:attendance:shift_assignment:attest'],
      () => earlyEnd.service.attestAssignment('assignment-early-end', assignmentInput),
    )).rejects.toMatchObject({
      response: { code: 'ATTENDANCE_SHIFT_OUTSIDE_EMPLOYMENT' },
    });
  });

  it('Provider 覆盖证明只接受可信服务并发布脱敏摘要事件', async () => {
    const store = assemble();
    const input = {
      employeeId: 'employee-001',
      providerCode: 'dingtalk' as const,
      providerStateId: 'provider-state-001',
      providerMappingId: 'provider-mapping-001',
      month: '2026-04',
      throughBusinessDate: '2026-04-30',
      sourceCutoffAt: new Date(Date.now() - 1_000).toISOString(),
    };
    const result = await run(
      store,
      ['erp:attendance:coverage:attest'],
      () => store.service.attestProviderCoverage('coverage-key-001', input),
      'system_job',
    );
    const inserted = store.coverages.insert.mock.calls[0]?.[0] as {
      readonly employeeId: string;
      readonly evidenceChecksum: string;
    };
    expect(inserted.employeeId).toBe('employee-001');
    expect(inserted.evidenceChecksum).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'attendance.provider_coverage.reconciled',
    }), session);
    expect(result.coverage).not.toHaveProperty('providerMappingId');
    expect(JSON.stringify(result)).not.toContain('externalEmployeeId');
  });

  it('月结规则解析在同一会话读取劳动关系、规则、排班和截止点之前的覆盖证明', async () => {
    const store = assemble();
    const shift = storedRule();
    const assigned = createAttendanceShiftAssignment({
      id: 'shift-assignment-001',
      tenantId: tenant.tenantId,
      ...assignmentInput,
      effectiveTo: '2026-04-01',
    }, new Date('2026-03-01T00:00:00.000Z'));
    const evidence = createAttendanceProviderCoverage({
      id: 'coverage-001',
      tenantId: tenant.tenantId,
      employeeId: 'employee-001',
      providerCode: 'dingtalk',
      providerStateId: 'provider-state-001',
      providerMappingId: 'provider-mapping-001',
      month: '2026-04',
      throughBusinessDate: '2026-04-30',
      sourceCutoffAt: '2026-05-01T00:00:00.000Z',
    }, new Date('2026-05-01T00:01:00.000Z'));
    store.rules.findForMonth.mockResolvedValue([shift]);
    store.assignments.findForMonth.mockResolvedValue([assigned]);
    store.coverages.findForMonth.mockResolvedValue([evidence]);
    store.employments.findOverlappingByEmployeeIds.mockResolvedValue([{
      id: 'employment-001',
      tenantId: tenant.tenantId,
      employeeId: 'employee-001',
      effectiveFrom: '2026-04-01',
      effectiveTo: '2026-04-01',
      version: 1,
    }]);
    const facts: AttendanceSourceFact[] = [];
    const result = await store.context.run({
      tenant,
      actor: actor(['erp:attendance:month:close'], 'system_job'),
    }, () => store.service.evaluateMonth({
      employeeId: 'employee-001',
      month: '2026-04',
      rulesetVersion: 'attendance-cn-2026-v1',
      sourceCutoffAt: '2026-05-01T00:30:00.000Z',
      facts,
      corrections: [],
    }, session));
    expect(store.rules.findForMonth).toHaveBeenCalledWith(
      'attendance-cn-2026-v1',
      '2026-04',
      session,
    );
    expect(store.coverages.findForMonth).toHaveBeenCalledWith(
      'employee-001',
      '2026-04',
      new Date('2026-05-01T00:30:00.000Z'),
      session,
    );
    expect(result.dailySummaries).toHaveLength(1);
  });

  it('月结领域冲突映射为稳定 409，未知基础设施异常保持原样', async () => {
    const missingAssignment = assemble();
    missingAssignment.employments.findOverlappingByEmployeeIds.mockResolvedValue([{
      id: 'employment-001',
      tenantId: tenant.tenantId,
      employeeId: 'employee-001',
      effectiveFrom: '2026-04-01',
      effectiveTo: '2026-04-01',
      version: 1,
    }]);
    await expect(missingAssignment.context.run({
      tenant,
      actor: actor(['erp:attendance:month:close'], 'system_job'),
    }, () => missingAssignment.service.evaluateMonth({
      employeeId: 'employee-001',
      month: '2026-04',
      rulesetVersion: 'attendance-cn-2026-v1',
      sourceCutoffAt: '2026-05-01T00:30:00.000Z',
      facts: [],
      corrections: [],
    }, session))).rejects.toMatchObject({
      response: { code: 'ATTENDANCE_SHIFT_ASSIGNMENT_MISSING' },
    });

    const infrastructure = assemble();
    const original = new Error('repository unavailable');
    infrastructure.rules.findForMonth.mockRejectedValue(original);
    await expect(infrastructure.context.run({
      tenant,
      actor: actor(['erp:attendance:month:close'], 'system_job'),
    }, () => infrastructure.service.evaluateMonth({
      employeeId: 'employee-001',
      month: '2026-04',
      rulesetVersion: 'attendance-cn-2026-v1',
      sourceCutoffAt: '2026-05-01T00:30:00.000Z',
      facts: [],
      corrections: [],
    }, session))).rejects.toBe(original);
  });
});
