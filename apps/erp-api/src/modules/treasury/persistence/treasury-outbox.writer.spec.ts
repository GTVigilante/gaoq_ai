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
    expect(calls).toContain('"subject":"tenant/tenant-001/treasury/bank-account/account-001"');
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

  it('代发事件只允许批次汇总与 WORM 证据，不允许员工级字段', async () => {
    const context = new TenantContextService();
    const create = vi.fn().mockResolvedValue([]);
    const writer = new TreasuryOutboxWriter(context, { create } as never);
    const prepared: TreasuryEvent = {
      type: 'treasury.disbursement.prepared', tenantId: 'tenant-001',
      aggregateId: 'batch-001', version: 2, occurredAt: '2026-07-22T10:00:00.000Z',
      data: {
        payrollPeriodId: 'period-001', payrollRunId: 'run-001',
        lineCount: 2, totalMinor: 1_839_600, fileHash: 'a'.repeat(43),
        objectEvidenceId: 'receipt-001', status: 'prepared',
      },
    };
    await context.run({ tenant, actor }, () => writer.append(prepared, session));
    const calls = JSON.stringify(create.mock.calls);
    expect(calls).toContain('"aggregateType":"treasury_disbursement_batch"');
    expect(calls).toContain(
      '"subject":"tenant/tenant-001/treasury/disbursement-batch/batch-001"',
    );
    expect(calls).toContain('"objectEvidenceId":"receipt-001"');
    expect(calls).not.toMatch(/employee|account|cipher/u);
    await expect(context.run({ tenant, actor }, () => writer.append({
      ...prepared, data: { ...prepared.data, employeeId: 'employee-001' },
    }, session))).rejects.toThrow('TREASURY_OUTBOX_DATA_INVALID');
  });
});
