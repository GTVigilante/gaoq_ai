import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  approvePayable, createPayable, settlePayable, submitPayable, submitToTreasury,
} from '../domain/payable.js';
import { SupplierIncomeService } from './supplier-income.service.js';

const SUPPLIER_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y9';

function payable() {
  const prepared = createPayable({
    id: '01J8ZQK7V0A2M4N6P8R0T2W4Y5', tenantId: 'tenant-a',
    payableNumber: 'PAY-6P8R0T2W4Y', engagementId: '01J8ZQK7V0A2M4N6P8R0T2W4Y7',
    engagementVersion: 6, supplierId: SUPPLIER_ID, grossAmountMinor: '400000',
    withholdingAmountMinor: '32000', currency: 'CNY',
    taxTreatmentCode: 'individual_service', acceptanceEvidenceRef: 'acceptance-1',
  }, new Date('2026-08-11T01:00:00.000Z'));
  const submitted = submitPayable(prepared, new Date('2026-08-11T01:01:00.000Z'));
  const approved = approvePayable(submitted, 'approval-1', new Date('2026-08-11T01:02:00.000Z'));
  const treasury = submitToTreasury(approved, 'treasury-1', new Date('2026-08-11T01:03:00.000Z'));
  return settlePayable(treasury, 'paid', 'settlement-1', null, new Date('2026-08-11T01:04:00.000Z'));
}

function harness(scopes = ['erp:supplier:self:income:read']) {
  const context = new TenantContextService();
  const members = { resolveUniqueSelf: vi.fn().mockResolvedValue({ supplierId: SUPPLIER_ID }) };
  const payables = { listBySupplier: vi.fn().mockResolvedValue([payable()]) };
  const service = new SupplierIncomeService(context, members as never, payables as never);
  const trusted = {
    tenant: { tenantId: 'tenant-a', source: 'access_token' as const },
    actor: { actorType: 'user' as const, actorId: 'actor-1', tenantId: 'tenant-a',
      roleCodes: [], scopes, departmentIds: [], traceId: 'trace-1' },
  };
  return { members, payables, service, run: <T>(handler: () => T) => context.run(trusted, handler) };
}

describe('SupplierIncomeService', () => {
  it('只按可信本人关系汇总整数分收益并返回最小投影', async () => {
    const value = harness();
    await value.run(async () => {
      const result = await value.service.getSelfIncome();
      expect(result).toMatchObject({
        supplierId: SUPPLIER_ID,
        income: { summary: {
          grossAmountMinor: '400000', withholdingAmountMinor: '32000',
          netAmountMinor: '368000', paidAmountMinor: '368000', itemCount: 1,
        } },
      });
      expect(result.income.items[0]).not.toHaveProperty('treasuryInstructionRef');
      expect(result.income.items[0]).not.toHaveProperty('taxTreatmentCode');
      expect(value.payables.listBySupplier).toHaveBeenCalledWith(SUPPLIER_ID);
    });
  });

  it('缺少本人收益 Scope 时在成员和应付读取前失败', async () => {
    const value = harness([]);
    await value.run(async () => {
      await expect(value.service.getSelfIncome()).rejects.toMatchObject({
        response: { code: 'SUPPLIER_INCOME_SCOPE_DENIED' },
      });
      expect(value.members.resolveUniqueSelf).not.toHaveBeenCalled();
      expect(value.payables.listBySupplier).not.toHaveBeenCalled();
    });
  });
});
