import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { PayrollOutboxWriter, type PayrollEvent } from './payroll-outbox.writer.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const actor: ActorContext = {
  actorType: 'service', actorId: 'payroll-event-writer', tenantId: tenant.tenantId,
  roleCodes: [], scopes: [], departmentIds: [], traceId: 'trace-payroll-tax-event',
};
const session = {} as ClientSession;
const base = Object.freeze({
  tenantId: tenant.tenantId, aggregateId: '01J8ZQK7V0A2M4N6P8R0T2W4F1',
  version: 2, occurredAt: '2026-07-22T00:00:00.000Z',
});
const summary = Object.freeze({
  period: '2026-07', payrollRunId: '01J8ZQK7V0A2M4N6P8R0T2W4R1',
  contentHash: 'a'.repeat(43), employeeCount: 2,
  totalTaxableEarningsMinor: 1_800_000, totalWithholdingTaxMinor: 21_000,
});

function setup() {
  const context = new TenantContextService();
  const records = { create: vi.fn().mockResolvedValue([]) };
  return {
    context, records,
    writer: new PayrollOutboxWriter(context, records as never),
  };
}

describe('Payroll Tax Outbox 白名单', () => {
  it('仅发布制备、批准和提交所需的最小控制字段', async () => {
    const store = setup();
    const events: readonly PayrollEvent[] = [
      {
        ...base, type: 'payroll.tax_filing.prepared', data: {
          ...summary, format: 'CN_IIT_WITHHOLDING_MANIFEST_V1',
          objectEvidenceId: 'tax-worm-evidence-001', status: 'prepared',
        },
      },
      {
        ...base, version: 3, type: 'payroll.tax_filing.approved', data: {
          ...summary, strongAuthMethod: 'webauthn_uv', status: 'approved',
        },
      },
      {
        ...base, version: 4, type: 'payroll.tax_filing.submitted', data: {
          ...summary, taxSubmissionId: 'tax-submission-001',
          taxSubmissionEvidenceId: 'tax-evidence-001', status: 'submitted',
        },
      },
    ];
    await store.context.run({ tenant, actor }, async () => {
      for (const event of events) await store.writer.append(event, session);
    });
    expect(store.records.create).toHaveBeenCalledTimes(3);
    const persisted = JSON.stringify(store.records.create.mock.calls);
    expect(persisted).not.toMatch(/employeeId|identityEvidence|preparedBy|approvedBy/u);
  });

  it('拒绝员工明细、审批人或任意未登记字段进入税务事件', async () => {
    const store = setup();
    const event = {
      ...base, type: 'payroll.tax_filing.prepared', data: {
        ...summary, format: 'CN_IIT_WITHHOLDING_MANIFEST_V1',
        objectEvidenceId: 'tax-worm-evidence-001', status: 'prepared',
        employeeId: 'employee-001',
      },
    } as PayrollEvent;
    await expect(store.context.run({ tenant, actor }, () => store.writer.append(event, session)))
      .rejects.toThrow('PAYROLL_TAX_OUTBOX_DATA_INVALID');
    expect(store.records.create).not.toHaveBeenCalled();
  });
});
