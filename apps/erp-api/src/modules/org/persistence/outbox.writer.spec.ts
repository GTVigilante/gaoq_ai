import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { DepartmentCreatedEvent } from '../domain/org-events.js';
import type { OutboxDocument } from './outbox.schema.js';
import { OrgOutboxWriter } from './outbox.writer.js';

const mongoSession = {} as ClientSession;
const event: DepartmentCreatedEvent = {
  type: 'department.created',
  tenantId: 'tenant-001',
  aggregateId: 'department-001',
  version: 1,
  occurredAt: '2026-07-21T00:00:00.000Z',
  payload: {
    code: 'HR',
    name: '人力资源部',
    status: 'active',
    parentId: null,
    managerId: null,
    sortOrder: 0,
  },
};

const trustedContext = {
  tenant: { tenantId: 'tenant-001', source: 'access_token' as const },
  actor: {
    actorId: 'actor-001', actorType: 'user' as const, tenantId: 'tenant-001',
    roleCodes: ['org-admin'], scopes: ['org:write'], departmentIds: [], traceId: 'trace-001',
  },
};

describe('OrgOutboxWriter', () => {
  it('使用同一事务写入 CloudEvents 1.0 与稳定幂等键', async () => {
    const context = new TenantContextService();
    const create = vi.fn().mockResolvedValue([]);
    const writer = new OrgOutboxWriter(
      context,
      { create } as unknown as Model<OutboxDocument>,
    );

    const envelope = await context.run(trustedContext, () => writer.append(event, mongoSession));

    expect(envelope).toMatchObject({
      specversion: '1.0',
      source: '//gaoq-erp/org-module',
      type: 'cn.gaoq.erp.department.created.v1',
      tenantId: 'tenant-001',
      traceId: 'trace-001',
      idempotencyKey:
        'tenant-001:cn.gaoq.erp.department.created.v1:department-001:1',
      schemaVersion: '1',
    });
    expect(envelope.id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    const call = create.mock.calls[0];
    expect(call?.[1]).toEqual({ session: mongoSession });
    const rows = call?.[0] as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({
      tenantId: 'tenant-001',
      aggregateType: 'org.department',
      aggregateVersion: 1,
      status: 'pending',
      attempts: 0,
    });
  });

  it('跨租户事件在写入前拒绝', async () => {
    const context = new TenantContextService();
    const create = vi.fn();
    const writer = new OrgOutboxWriter(
      context,
      { create } as unknown as Model<OutboxDocument>,
    );

    await expect(
      context.run(trustedContext, () =>
        writer.append({ ...event, tenantId: 'attacker-tenant' }, mongoSession),
      ),
    ).rejects.toThrow('拒绝跨租户');
    expect(create).not.toHaveBeenCalled();
  });
});
