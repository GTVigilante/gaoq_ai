import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { createPayable, type PayableItem } from '../domain/payable.js';
import { PayableService } from './payable.service.js';

const ENGAGEMENT_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y7';
const SUPPLIER_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y9';
const SESSION = { inTransaction: () => true };
const SOURCE = Object.freeze({
  engagementId: ENGAGEMENT_ID,
  engagementVersion: 6,
  supplierId: SUPPLIER_ID,
  grossAmountMinor: '400000',
  currency: 'CNY' as const,
  acceptanceEvidenceRef: 'acceptance-1',
});

function harness(scopes = ['erp:payables:materialize', 'erp:payables:management:read']) {
  const context = new TenantContextService();
  const records = new Map<string, PayableItem>();
  const idempotency = {
    execute: vi.fn(
      (
        _operation: string,
        _key: string,
        _request: unknown,
        handler: (session: typeof SESSION) => Promise<unknown>,
      ) => handler(SESSION),
    ),
  };
  const engagements = { getAcceptedPayableSource: vi.fn().mockResolvedValue(SOURCE) };
  const repository = {
    findByEngagement: vi.fn((id: string) =>
      Promise.resolve([...records.values()].find((value) => value.engagementId === id) ?? null),
    ),
    findById: vi.fn((id: string) => Promise.resolve(records.get(id) ?? null)),
    insert: vi.fn((value: PayableItem) => {
      records.set(value.id, value);
      return Promise.resolve();
    }),
    replace: vi.fn((value: PayableItem) => {
      records.set(value.id, value);
      return Promise.resolve();
    }),
    search: vi.fn(() =>
      Promise.resolve({ items: Object.freeze([...records.values()]), nextCursor: null }),
    ),
  };
  const outbox = {
    append: vi.fn().mockResolvedValue(undefined),
    appendTreasuryMaterializationRequest: vi.fn().mockResolvedValue(undefined),
  };
  const service = new PayableService(
    context,
    idempotency as never,
    engagements as never,
    repository as never,
    outbox as never,
  );
  const trusted = {
    tenant: { tenantId: 'tenant-a', source: 'access_token' as const },
    actor: {
      actorType: 'service' as const,
      actorId: 'payables-worker',
      tenantId: 'tenant-a',
      roleCodes: [],
      scopes,
      departmentIds: [],
      traceId: 'trace-1',
    },
  };
  return {
    engagements,
    outbox,
    records,
    repository,
    run: <T>(handler: () => T) => context.run(trusted, handler),
    service,
  };
}

describe('PayableService', () => {
  it('只从已验收履约来源创建一次应付，并以整数分计算净额', async () => {
    const value = harness();
    await value.run(async () => {
      const created = await value.service.materialize('payable-materialize-001', {
        engagementId: ENGAGEMENT_ID,
        withholdingAmountMinor: '32000',
        taxTreatmentCode: 'individual_service',
      });
      expect(created.payable).toMatchObject({
        engagementId: ENGAGEMENT_ID,
        grossAmountMinor: '400000',
        withholdingAmountMinor: '32000',
        netAmountMinor: '368000',
        status: 'prepared',
      });
      expect(value.repository.insert).toHaveBeenCalledTimes(1);
      expect(value.outbox.append).toHaveBeenCalledTimes(1);
    });
  });

  it('不同幂等键不得用变化的扣缴参数复用既有应付', async () => {
    const value = harness();
    await value.run(async () => {
      await value.service.materialize('payable-materialize-001', {
        engagementId: ENGAGEMENT_ID,
        withholdingAmountMinor: '32000',
        taxTreatmentCode: 'individual_service',
      });
      await expect(
        value.service.materialize('payable-materialize-002', {
          engagementId: ENGAGEMENT_ID,
          withholdingAmountMinor: '0',
          taxTreatmentCode: 'individual_service',
        }),
      ).rejects.toMatchObject({ response: { code: 'PAYABLE_SOURCE_CONFLICT' } });
      expect(value.repository.insert).toHaveBeenCalledTimes(1);
      expect(value.outbox.append).toHaveBeenCalledTimes(1);
    });
  });

  it('验收版本或证据漂移时失败关闭，且不会把既有应付当作成功重放', async () => {
    const value = harness();
    value.records.set(
      '01J8ZQK7V0A2M4N6P8R0T2W4Y5',
      createPayable(
        {
          id: '01J8ZQK7V0A2M4N6P8R0T2W4Y5',
          tenantId: 'tenant-a',
          payableNumber: 'PAY-6P8R0T2W4Y',
          ...SOURCE,
          engagementVersion: 5,
          withholdingAmountMinor: '32000',
          taxTreatmentCode: 'individual_service',
        },
        new Date('2026-08-11T01:00:00.000Z'),
      ),
    );
    await value.run(async () => {
      await expect(
        value.service.materialize('payable-materialize-003', {
          engagementId: ENGAGEMENT_ID,
          withholdingAmountMinor: '32000',
          taxTreatmentCode: 'individual_service',
        }),
      ).rejects.toMatchObject({ response: { code: 'PAYABLE_SOURCE_CONFLICT' } });
      expect(value.repository.insert).not.toHaveBeenCalled();
    });
  });

  it('应用服务在读取履约来源前校验最小 Scope', async () => {
    const value = harness([]);
    await value.run(async () => {
      await expect(
        value.service.materialize('payable-materialize-004', {
          engagementId: ENGAGEMENT_ID,
          withholdingAmountMinor: '32000',
          taxTreatmentCode: 'individual_service',
        }),
      ).rejects.toMatchObject({ response: { code: 'PAYABLE_SCOPE_DENIED' } });
      expect(value.engagements.getAcceptedPayableSource).not.toHaveBeenCalled();
    });
  });
});
