import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type {
  AttendanceProviderEmployeeMappingDocument,
  AttendanceProviderInboxDocument,
  AttendanceProviderStateDocument,
} from '../../integration/attendance-provider.schemas.js';
import { AttendanceSourceReadinessRepository } from './attendance-source-readiness.repository.js';

const session = {} as ClientSession;
const tenant = { tenantId: 'tenant-001', source: 'service_identity' as const };

function listQuery(value: unknown) {
  return {
    sort: () => ({
      session: () => ({ lean: () => ({ exec: () => Promise.resolve(value) }) }),
    }),
  };
}

function oneQuery(value: unknown) {
  return {
    session: () => ({ lean: () => ({ exec: () => Promise.resolve(value) }) }),
  };
}

function sessionResult(value: unknown) {
  return { session: () => Promise.resolve(value) };
}

function assemble(input?: {
  readonly throughDate?: string | null;
  readonly lastPolledAt?: Date | null;
  readonly blocked?: boolean;
}) {
  const context = new TenantContextService();
  const mappings = {
    find: vi.fn().mockReturnValue(listQuery([{
      id: 'mapping-001',
      providerCode: 'feishu',
      employeeId: 'employee-001',
    }])),
  };
  const states = {
    findOne: vi.fn().mockReturnValue(oneQuery({
      id: 'state-001',
      tenantId: tenant.tenantId,
      providerCode: 'feishu',
      timeZone: 'Asia/Shanghai',
      status: 'active',
      committedThroughDate: input?.throughDate ?? '2026-04-30',
      lastPolledAt: input?.lastPolledAt ?? new Date('2026-05-01T00:00:00.000Z'),
    })),
  };
  const inbox = {
    exists: vi.fn().mockReturnValue(sessionResult(input?.blocked === true ? { _id: 'blocked' } : null)),
    countDocuments: vi.fn().mockReturnValue(sessionResult(42)),
  };
  const repository = new AttendanceSourceReadinessRepository(
    context,
    mappings as unknown as Model<AttendanceProviderEmployeeMappingDocument>,
    states as unknown as Model<AttendanceProviderStateDocument>,
    inbox as unknown as Model<AttendanceProviderInboxDocument>,
  );
  return { context, repository, states, inbox };
}

describe('AttendanceSourceReadinessRepository', () => {
  it('只在已提交水位覆盖整月且 Inbox 全部完成时形成关账摘要', async () => {
    const store = assemble({});
    const result = await store.context.run({
      tenant,
      actor: {
        tenantId: tenant.tenantId,
        actorId: 'system:test',
        actorType: 'system_job',
        roleCodes: [],
        scopes: ['erp:attendance:month:close'],
        departmentIds: [],
        traceId: 'trace-001',
      },
    }, () => store.repository.reconcile(
      'employee-001',
      '2026-04',
      new Date('2026-05-01T01:00:00.000Z'),
      session,
    ));

    expect(result).toEqual([{
      providerCode: 'feishu',
      throughDate: '2026-04-30',
      lastPolledAt: '2026-05-01T00:00:00.000Z',
      completedInboxCount: 42,
    }]);
    const filter = store.inbox.exists.mock.calls[0]?.[0] as {
      readonly providerOccurredAt: { readonly $gte: Date; readonly $lt: Date };
    };
    expect(filter.providerOccurredAt.$gte.toISOString()).toBe('2026-03-31T16:00:00.000Z');
    expect(filter.providerOccurredAt.$lt.toISOString()).toBe('2026-04-30T16:00:00.000Z');
  });

  it('水位未覆盖月末或存在未处理 Inbox 时失败关闭', async () => {
    const incomplete = assemble({ throughDate: '2026-04-29' });
    await expect(incomplete.context.run({
      tenant,
      actor: {
        tenantId: tenant.tenantId,
        actorId: 'system:test',
        actorType: 'system_job',
        roleCodes: [],
        scopes: ['erp:attendance:month:close'],
        departmentIds: [],
        traceId: 'trace-002',
      },
    }, () => incomplete.repository.reconcile(
      'employee-001',
      '2026-04',
      new Date('2026-05-01T01:00:00.000Z'),
      session,
    ))).rejects.toThrow('仅补拉至 2026-04-29');

    const blocked = assemble({ blocked: true });
    await expect(blocked.context.run({
      tenant,
      actor: {
        tenantId: tenant.tenantId,
        actorId: 'system:test',
        actorType: 'system_job',
        roleCodes: [],
        scopes: ['erp:attendance:month:close'],
        departmentIds: [],
        traceId: 'trace-003',
      },
    }, () => blocked.repository.reconcile(
      'employee-001',
      '2026-04',
      new Date('2026-05-01T01:00:00.000Z'),
      session,
    ))).rejects.toThrow('Inbox 仍有未完成');
  });

  it('跨日班次把 Inbox 对账窗口延伸到结束业务日', async () => {
    const store = assemble({ throughDate: '2026-05-01' });
    await store.context.run({
      tenant,
      actor: {
        tenantId: tenant.tenantId,
        actorId: 'system:test',
        actorType: 'system_job',
        roleCodes: [],
        scopes: ['erp:attendance:month:close'],
        departmentIds: [],
        traceId: 'trace-004',
      },
    }, () => store.repository.reconcile(
      'employee-001',
      '2026-04',
      new Date('2026-05-01T09:00:00.000Z'),
      session,
      '2026-05-01',
    ));
    const filter = store.inbox.exists.mock.calls[0]?.[0] as {
      readonly providerOccurredAt: { readonly $lt: Date };
    };
    expect(filter.providerOccurredAt.$lt.toISOString()).toBe('2026-05-01T16:00:00.000Z');
  });
});
