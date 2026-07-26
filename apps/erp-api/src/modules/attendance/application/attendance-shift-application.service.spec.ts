import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { createAttendanceShiftPlan, createAttendanceSourceFact } from '../domain/index.js';
import { AttendanceShiftApplicationService } from './attendance-shift-application.service.js';

const session = {} as ClientSession;
const tenant = { tenantId: 'tenant-001', source: 'service_identity' as const };

function shiftPlan() {
  return createAttendanceShiftPlan({
    id: '01J8ZQK7V0A2M4N6P8R0T2W4P1',
    tenantId: tenant.tenantId,
    employeeId: 'employee-001',
    providerCode: 'workforce_scheduler',
    planCode: 'NIGHT-A',
    businessDate: '2026-04-30',
    rulesetVersion: 'attendance-cn-v2',
    timeZone: 'Asia/Shanghai',
    scheduledStartAt: '2026-04-30T14:00:00.000Z',
    scheduledEndAt: '2026-05-01T06:00:00.000Z',
    breakMinutes: 60,
    graceMinutes: 10,
    earlyArrivalWindowMinutes: 120,
    lateDepartureWindowMinutes: 120,
    sourceObservedAt: '2026-04-29T00:00:00.000Z',
  }, new Date('2026-04-29T00:00:00.000Z'));
}

function punch(id: string, factType: 'punch_in' | 'punch_out', occurredAt: string) {
  return createAttendanceSourceFact({
    id,
    tenantId: tenant.tenantId,
    employeeId: 'employee-001',
    providerCode: 'feishu',
    factType,
    occurredAt,
    timeZone: 'Asia/Shanghai',
    impact: {
      workedMinutes: 0,
      leaveMinutes: 0,
      overtimeMinutes: 0,
      absentMinutes: 0,
    },
    sourceObservedAt: new Date(Date.parse(occurredAt) + 60_000).toISOString(),
  }, new Date('2026-05-02T00:00:00.000Z'));
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
  const employees = { findById: vi.fn().mockResolvedValue({ id: 'employee-001' }) };
  const employments = {
    findOverlappingByEmployeeIds: vi.fn().mockResolvedValue([{
      employeeId: 'employee-001',
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
    }]),
  };
  const crypto = { sourceEventFingerprints: vi.fn().mockReturnValue(['key.digest']) };
  const plans = {
    findByEventFingerprints: vi.fn().mockResolvedValue(null),
    findNearBusinessDate: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockResolvedValue(undefined),
    findById: vi.fn().mockResolvedValue(shiftPlan()),
    markEvaluated: vi.fn().mockResolvedValue(undefined),
  };
  const facts = {
    findByShiftPlanId: vi.fn().mockResolvedValue(null),
    findPunchesForDateRange: vi.fn().mockResolvedValue([
      punch('punch-in-001', 'punch_in', '2026-04-30T14:00:00.000Z'),
      punch('punch-out-001', 'punch_out', '2026-05-01T06:00:00.000Z'),
    ]),
    findByEventFingerprints: vi.fn().mockResolvedValue(null),
    insert: vi.fn().mockResolvedValue(undefined),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const service = new AttendanceShiftApplicationService(
    idempotency as never,
    context,
    employees as never,
    employments as never,
    crypto as never,
    plans as never,
    facts as never,
    outbox as never,
  );
  return { context, service, employments, crypto, plans, facts, outbox };
}

async function trustedRun<T>(
  context: TenantContextService,
  scopes: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  return context.run({
    tenant,
    actor: {
      tenantId: tenant.tenantId,
      actorId: 'system:attendance',
      actorType: 'system_job',
      roleCodes: [],
      scopes,
      departmentIds: [],
      traceId: 'trace-001',
    },
  }, operation);
}

describe('AttendanceShiftApplicationService', () => {
  it('只在劳动关系有效且捕获窗口不重叠时追加班次计划', async () => {
    const store = assemble();
    const result = await trustedRun(
      store.context,
      ['erp:attendance:shift_plan:write'],
      () => store.service.assign('shift-plan-key-001', {
        employeeId: 'employee-001',
        providerCode: 'workforce_scheduler',
        externalPlanId: 'external-plan-001',
        planCode: 'NIGHT-A',
        businessDate: '2026-04-30',
        rulesetVersion: 'attendance-cn-v2',
        timeZone: 'Asia/Shanghai',
        scheduledStartAt: '2026-04-30T14:00:00.000Z',
        scheduledEndAt: '2026-05-01T06:00:00.000Z',
        breakMinutes: 60,
        graceMinutes: 10,
        earlyArrivalWindowMinutes: 120,
        lateDepartureWindowMinutes: 120,
        sourceObservedAt: '2026-04-29T00:00:00.000Z',
      }),
    );
    expect(store.employments.findOverlappingByEmployeeIds).toHaveBeenCalledWith(
      ['employee-001'],
      '2026-04-30',
      '2026-04-30',
      session,
    );
    expect(store.plans.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        businessDate: '2026-04-30',
        scheduledEndAt: '2026-05-01T06:00:00.000Z',
      }),
      ['key.digest'],
      session,
    );
    expect(result.shiftPlan).toMatchObject({
      employeeId: 'employee-001',
      rulesetVersion: 'attendance-cn-v2',
    });
  });

  it('规则计算只派生绑定班次的 shift 事实，事件不泄露分钟和缺卡结果', async () => {
    const store = assemble();
    const result = await trustedRun(
      store.context,
      ['erp:attendance:shift:evaluate'],
      () => store.service.evaluate('shift-evaluate-key-001', shiftPlan().id),
    );
    expect(store.facts.findPunchesForDateRange).toHaveBeenCalledWith(
      'employee-001',
      '2026-04-29',
      '2026-05-02',
      session,
    );
    expect(store.facts.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        providerCode: 'attendance_rules',
        factType: 'shift',
        shiftPlanId: shiftPlan().id,
        businessDate: '2026-04-30',
        derivation: {
          algorithmVersion: 'attendance-shift-v1',
          shiftPlanId: shiftPlan().id,
          rulesetVersion: 'attendance-cn-v2',
          outcome: 'complete',
          punchProviderCode: 'feishu',
          punchInFactId: 'punch-in-001',
          punchOutFactId: 'punch-out-001',
        },
        impact: {
          workedMinutes: 900,
          leaveMinutes: 0,
          overtimeMinutes: 0,
          absentMinutes: 0,
        },
      }),
      ['key.digest'],
      session,
    );
    expect(store.plans.markEvaluated).toHaveBeenCalledWith(
      shiftPlan().id,
      expect.any(String),
      expect.any(Date),
      session,
    );
    const event = store.outbox.append.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event).toMatchObject({ type: 'attendance.shift.evaluated' });
    expect(JSON.stringify(event)).not.toMatch(/workedMinutes|absentMinutes|missing_punch/u);
    expect(result.evaluation).toMatchObject({
      shiftPlanId: shiftPlan().id,
      status: 'completed',
    });
  });

  it('幂等重放拒绝缺少规则谱系的既有派生事实', async () => {
    const store = assemble();
    store.facts.findByShiftPlanId.mockResolvedValue({
      ...punch('legacy-derived-shift', 'punch_in', '2026-04-30T14:00:00.000Z'),
      providerCode: 'attendance_rules',
      factType: 'shift',
      shiftPlanId: shiftPlan().id,
    });
    await expect(trustedRun(
      store.context,
      ['erp:attendance:shift:evaluate'],
      () => store.service.evaluate('shift-evaluate-key-invalid-lineage', shiftPlan().id),
    )).rejects.toThrow('现有班次派生事实缺少可复算谱系');
    expect(store.plans.markEvaluated).not.toHaveBeenCalled();
  });
});
