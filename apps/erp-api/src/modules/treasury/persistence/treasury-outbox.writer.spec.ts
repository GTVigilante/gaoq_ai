import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { TreasuryOutboxWriter, type TreasuryEvent } from './treasury-outbox.writer.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const actor: ActorContext = {
  actorType: 'service', actorId: 'connector-001', tenantId: tenant.tenantId,
  roleCodes: [], scopes: [], departmentIds: [], traceId: 'trace-001',
};
const session = {} as ClientSession;
const event: TreasuryEvent = {
  type: 'treasury.bank_account.attested', tenantId: tenant.tenantId,
  aggregateId: 'account-001', version: 1, occurredAt: '2026-07-22T10:00:00.000Z',
  data: { ownerType: 'employee', ownerId: 'employee-001', version: 1, status: 'active' },
};

describe('TreasuryOutboxWriter', () => {
  it('只写不含账号与盲索引的白名单事件，并绑定可信租户', async () => {
    const context = new TenantContextService();
    const create = vi.fn().mockResolvedValue([]);
    const writer = new TreasuryOutboxWriter(context, { create } as never);
    await context.run({ tenant, actor }, () => writer.append(event, session));
    const calls = JSON.stringify(create.mock.calls);
    expect(calls).toContain('"aggregateType":"treasury_bank_account"');
    expect(calls).toContain('"tenantId":"tenant-001"');
    expect(calls).toContain('"ownerId":"employee-001"');
    expect(calls).not.toMatch(/accountBlind|6222|cipher/u);
    expect(create).toHaveBeenCalledOnce();
  });

  it('拒绝跨租户或夹带账号字段的事件', async () => {
    const context = new TenantContextService();
    const create = vi.fn();
    const writer = new TreasuryOutboxWriter(context, { create } as never);
    await expect(context.run({ tenant, actor }, () => writer.append({
      ...event, tenantId: 'tenant-002',
    }, session))).rejects.toThrow('拒绝跨租户');
    await expect(context.run({ tenant, actor }, () => writer.append({
      ...event, data: { ...event.data, account: '6222000000000001' },
    }, session))).rejects.toThrow('TREASURY_OUTBOX_DATA_INVALID');
    expect(create).not.toHaveBeenCalled();
  });
});
