import type { ActorContext } from '@gaoq/shared-types';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
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
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const service = new PayrollRunService(
    idempotency as never, context, {} as never, outbox as never,
    periods as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never,
  );
  return { context, idempotency, periods, outbox, service };
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
});
