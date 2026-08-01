import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { AttendanceOutboxWriter } from './attendance-outbox.writer.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const actor: ActorContext = {
  actorType: 'service',
  actorId: 'attendance-rule-service',
  tenantId: tenant.tenantId,
  roleCodes: [],
  scopes: ['erp:attendance:rule:attest'],
  departmentIds: [],
  traceId: 'trace-attendance-rule-001',
};
const session = {} as ClientSession;

describe('AttendanceOutboxWriter', () => {
  it('只在持久化边界封装一次标准 CloudEvent 类型', async () => {
    const context = new TenantContextService();
    const records = { create: vi.fn().mockResolvedValue(undefined) };
    const writer = new AttendanceOutboxWriter(context, records as never);
    await context.run({ tenant, actor }, () => writer.append({
      type: 'attendance.shift_rule.attested',
      tenantId: tenant.tenantId,
      aggregateId: 'shift-rule-001',
      version: 1,
      occurredAt: '2026-04-01T00:00:00.000Z',
      data: {
        rulesetVersion: 'attendance-cn-2026-v1',
        shiftCode: 'DAY_SHIFT',
      },
    }, session));
    const created = records.create.mock.calls[0]?.[0] as readonly [{
      readonly eventType: string;
      readonly envelope: {
        readonly type: string;
        readonly tenantId: string;
        readonly traceId: string;
        readonly schemaVersion: string;
        readonly data: Readonly<Record<string, unknown>>;
      };
    }];
    expect(created[0].eventType).toBe('cn.gaoq.erp.attendance.shift_rule.attested.v1');
    expect(created[0].envelope).toEqual(expect.objectContaining({
      type: 'cn.gaoq.erp.attendance.shift_rule.attested.v1',
      tenantId: tenant.tenantId,
      traceId: actor.traceId,
      schemaVersion: '1',
    }));
    expect(created[0].envelope.data.tenantId).toBe(tenant.tenantId);
    expect(records.create.mock.calls[0]?.[1]).toEqual({ session });
    expect(JSON.stringify(records.create.mock.calls)).not.toContain(
      'cn.gaoq.erp.cn.gaoq.erp',
    );
  });

  it('拒绝跨租户事件且不创建 Outbox', async () => {
    const context = new TenantContextService();
    const records = { create: vi.fn().mockResolvedValue(undefined) };
    const writer = new AttendanceOutboxWriter(context, records as never);
    await expect(context.run({ tenant, actor }, () => writer.append({
      type: 'attendance.provider_coverage.reconciled',
      tenantId: 'tenant-other',
      aggregateId: 'coverage-001',
      version: 1,
      occurredAt: '2026-04-01T00:00:00.000Z',
      data: {},
    }, session))).rejects.toThrow('拒绝跨租户事件');
    expect(records.create).not.toHaveBeenCalled();
  });
});
