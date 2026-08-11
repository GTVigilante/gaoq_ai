import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { approvePayable, createPayable, submitPayable, type PayableItem } from '../domain/payable.js';
import { PayableOutboxWriter } from './payable-outbox.writer.js';

const SESSION = { inTransaction: () => true };
const NOW = new Date('2026-08-11T01:00:00.000Z');

function payable(): PayableItem {
  return approvePayable(submitPayable(createPayable({
    id: '01J8ZQK7V0A2M4N6P8R0T2W4Y5', tenantId: 'tenant-a',
    payableNumber: 'PAY-6P8R0T2W4Y', engagementId: '01J8ZQK7V0A2M4N6P8R0T2W4Y7',
    engagementVersion: 6, supplierId: '01J8ZQK7V0A2M4N6P8R0T2W4Y9',
    grossAmountMinor: '400000', withholdingAmountMinor: '32000', currency: 'CNY',
    taxTreatmentCode: 'individual_service', acceptanceEvidenceRef: 'acceptance-1',
  }, NOW), NOW), 'approval-1', NOW);
}

function harness() {
  const context = new TenantContextService();
  const records = { create: vi.fn().mockResolvedValue(undefined) };
  const writer = new PayableOutboxWriter(context, records as never);
  const trusted = {
    tenant: { tenantId: 'tenant-a', source: 'access_token' as const },
    actor: {
      actorType: 'service' as const, actorId: 'treasury-worker', tenantId: 'tenant-a',
      roleCodes: [], scopes: [], departmentIds: [], traceId: 'trace-1',
    },
  };
  return { records, writer, run: <T>(handler: () => T) => context.run(trusted, handler) };
}

describe('PayableOutboxWriter', () => {
  it('发布脱敏应付事件和独立 Treasury 物化意图', async () => {
    const value = harness();
    await value.run(async () => {
      await value.writer.append(payable(), 'approved', SESSION as never);
      await value.writer.appendTreasuryMaterializationRequest(payable(), SESSION as never);
    });
    expect(value.records.create).toHaveBeenCalledTimes(2);
    const serialized = JSON.stringify(value.records.create.mock.calls);
    expect(serialized).toContain('payables.treasury.materialization_requested');
    expect(serialized).toContain('netAmountMinor');
    expect(serialized).not.toMatch(/bankAccount|credential|token|secret/iu);
  });

  it('拒绝非事务、租户漂移和错误物化状态', async () => {
    const value = harness();
    await value.run(async () => {
      await expect(value.writer.append(
        payable(), 'approved', { inTransaction: () => false } as never,
      )).rejects.toThrow('PAYABLE_TRANSACTION_REQUIRED');
      await expect(value.writer.append(
        { ...payable(), tenantId: 'tenant-b' }, 'approved', SESSION as never,
      )).rejects.toThrow('PAYABLE_OUTBOX_TENANT_MISMATCH');
      await expect(value.writer.appendTreasuryMaterializationRequest(
        { ...payable(), status: 'submitted' }, SESSION as never,
      )).rejects.toThrow('PAYABLE_TREASURY_REQUEST_STATE_INVALID');
    });
  });
});
