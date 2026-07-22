import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { PayrollCompensationProfileDocument, PayrollRulePackDocument } from '../persistence/payroll.schemas.js';
import { PayrollMasterDataService } from './payroll-master-data.service.js';

const session = {} as ClientSession;
const tenant = { tenantId: 'tenant-001', source: 'service_identity' as const };

function actor(): ActorContext {
  return {
    actorType: 'service', actorId: 'migration-service', tenantId: tenant.tenantId,
    roleCodes: ['migration'], scopes: ['erp:migration:execute', 'erp:payroll:migration:write'],
    departmentIds: [], traceId: 'trace-payroll-migration-001',
  };
}

function query(value: unknown) {
  const chain = {
    sort: vi.fn(), session: vi.fn(), lean: vi.fn(), exec: vi.fn().mockResolvedValue(value),
  };
  chain.sort.mockReturnValue(chain);
  chain.session.mockReturnValue(chain);
  chain.lean.mockReturnValue(chain);
  return chain;
}

function assemble() {
  const context = new TenantContextService();
  const idempotency = { execute: vi.fn(async (
    _operation: string, _key: string, _input: unknown,
    handler: (value: ClientSession) => Promise<unknown>,
  ) => handler(session)) };
  const employees = { findById: vi.fn().mockResolvedValue({ id: 'employee-001' }) };
  const approvals = { verifyPayrollMigrationReference: vi.fn().mockResolvedValue({
    id: 'approval-history-001', completedAt: '2026-01-01T00:00:00.000Z',
    evidenceChecksum: 'a'.repeat(43),
  }) };
  const crypto = {
    protect: vi.fn().mockReturnValue({
      keyId: 'payroll-key-001', iv: 'a'.repeat(16),
      ciphertext: 'b'.repeat(32), authTag: 'c'.repeat(22),
    }),
    unprotect: vi.fn(),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const profiles = {
    findOne: vi.fn().mockImplementation(() => query(null)),
    create: vi.fn().mockResolvedValue(undefined),
  };
  const rulePacks = {
    findOne: vi.fn().mockImplementation(() => query(null)),
    create: vi.fn().mockResolvedValue(undefined),
  };
  const service = new PayrollMasterDataService(
    idempotency as never, context, employees as never, approvals as never,
    crypto as never, outbox as never,
    profiles as unknown as Model<PayrollCompensationProfileDocument>,
    rulePacks as unknown as Model<PayrollRulePackDocument>,
  );
  return { context, service, approvals, crypto, outbox, profiles, rulePacks };
}

describe('PayrollMasterDataService migration', () => {
  it('迁移薪酬档案只写密文、审批与 WORM 控制字段', async () => {
    const store = assemble();
    const data = {
      currency: 'CNY' as const,
      taxableEarnings: [{ code: 'BASE', amountMinor: 1_000_000 }],
      nonTaxableEarnings: [], employeeSocialInsuranceMinor: 80_000,
      employeeHousingFundMinor: 70_000, specialAdditionalDeductionMinor: 20_000,
      otherPreTaxWithholdingMinor: 0, postTaxDeductionMinor: 0,
      attendanceAdjustment: {
        overtimePayMinorPerMinute: 100, absenceDeductionMinorPerMinute: 100,
        unpaidLeaveDeductionMinorPerMinute: 100,
      },
    };
    const result = await store.context.run({ tenant, actor: actor() }, () =>
      store.service.importCompensationFromMigration('payroll-compensation-migration-001', {
        targetId: null, employeeId: 'employee-001', version: 1,
        effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31',
        approvalHistoryId: 'approval-history-001',
        approvalEvidenceChecksum: 'a'.repeat(43), data,
        createdAt: '2026-01-02T00:00:00.000Z',
        migrationEvidenceRef:
          'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/compensation-001',
        evidenceChecksum: 'c'.repeat(43),
      }));
    const records = store.profiles.create.mock.calls[0]?.[0] as unknown;
    expect(records).toEqual([expect.objectContaining({
      employeeId: 'employee-001', version: 1, dataKeyId: 'payroll-key-001',
      approvalEvidenceId: 'approval-history-001', migrationEvidenceChecksum: 'c'.repeat(43),
    })]);
    expect(JSON.stringify(records)).not.toMatch(/BASE|1000000|taxableEarnings/u);
    expect(JSON.stringify(store.outbox.append.mock.calls[0]?.[0])).not.toMatch(/1000000|BASE/u);
    expect(result).toMatchObject({ employeeId: 'employee-001', version: 1 });
  });

  it('迁移规则包重新校验确定性税率并写专用事件', async () => {
    const store = assemble();
    store.approvals.verifyPayrollMigrationReference.mockResolvedValue({
      id: 'approval-history-rule-001', completedAt: '2026-01-01T00:00:00.000Z',
      evidenceChecksum: 'r'.repeat(43),
    });
    const result = await store.context.run({ tenant, actor: actor() }, () =>
      store.service.importRulePackFromMigration('payroll-rule-migration-001', {
        targetId: null, code: 'CN_IIT', jurisdictionCode: 'CN', version: 1,
        effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31',
        monthlyBasicDeductionMinor: 500_000,
        taxBrackets: [{ upperBoundMinor: null, rateBps: 300, quickDeductionMinor: 0 }],
        sourceDigest: 's'.repeat(43), sourceReference: 'tax-law-2026',
        approvalHistoryId: 'approval-history-rule-001',
        approvalEvidenceChecksum: 'r'.repeat(43),
        createdAt: '2026-01-02T00:00:00.000Z',
        migrationEvidenceRef:
          'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/rule-001',
        evidenceChecksum: 'w'.repeat(43),
      }));
    expect(store.rulePacks.create).toHaveBeenCalledWith([
      expect.objectContaining({
        code: 'CN_IIT', version: 1, approvalEvidenceId: 'approval-history-rule-001',
        migrationEvidenceChecksum: 'w'.repeat(43),
      }),
    ], { session });
    expect(store.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'payroll.rule_pack.migrated' }), session,
    );
    expect(result).toMatchObject({ code: 'CN_IIT', version: 1 });
  });
});
