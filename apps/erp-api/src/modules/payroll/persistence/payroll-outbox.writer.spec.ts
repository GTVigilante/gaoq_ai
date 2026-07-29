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
  const records = {
    create: vi.fn<(
      documents: readonly Record<string, unknown>[],
      options: { readonly session: ClientSession },
    ) => Promise<never[]>>().mockResolvedValue([]),
  };
  return {
    context, records,
    writer: new PayrollOutboxWriter(context, records as never),
  };
}

describe('Payroll Tax Outbox 白名单', () => {
  it('通用事件绑定可信租户、主体、事务和确定性信封', async () => {
    const store = setup();
    const event: PayrollEvent = {
      ...base, type: 'payroll.period.created', data: { status: 'draft' },
    };
    await store.context.run({ tenant, actor }, () => store.writer.append(event, session));
    const [documents, options] = store.records.create.mock.calls[0]!;
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      tenantId: tenant.tenantId,
      aggregateType: 'payroll',
      aggregateId: base.aggregateId,
      aggregateVersion: base.version,
      eventType: 'cn.gaoq.erp.payroll.period.created.v1',
      status: 'pending',
      attempts: 0,
      envelope: {
        tenantId: tenant.tenantId,
        traceId: actor.traceId,
        schemaVersion: '1',
        data: { tenantId: tenant.tenantId, status: 'draft' },
      },
    });
    expect(options).toEqual({ session });

    await expect(store.context.run({ tenant, actor }, () => store.writer.append({
      ...event, tenantId: 'tenant-002',
    }, session))).rejects.toThrow('拒绝跨租户事件');
  });

  it('仅发布制备、批准、提交和迁移所需的最小控制字段', async () => {
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
      {
        ...base, version: 4, type: 'payroll.tax_filing.migrated', data: {
          ...summary, taxSubmissionId: 'legacy-tax-submission-001',
          taxSubmissionEvidenceId: 'legacy-tax-evidence-001', status: 'submitted',
        },
      },
    ];
    await store.context.run({ tenant, actor }, async () => {
      for (const event of events) await store.writer.append(event, session);
    });
    expect(store.records.create).toHaveBeenCalledTimes(4);
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

  it('在线与迁移四方对账事件只发布状态、标准差异数量和摘要', async () => {
    const store = setup();
    const completed: PayrollEvent = {
      ...base, type: 'payroll.reconciliation.completed', version: 9, data: {
        period: '2026-07', batchId: '01J8ZQK7V0A2M4N6P8R0T2W4B1',
        reconciliationId: '01J8ZQK7V0A2M4N6P8R0T2W4C1',
        evidenceHash: 'e'.repeat(43), differenceCount: 1, status: 'frozen',
      },
    };
    const migrated: PayrollEvent = {
      ...completed, type: 'payroll.reconciliation.migrated', data: {
        ...completed.data, differenceCount: 0, status: 'reconciled',
      },
    };
    await store.context.run({ tenant, actor }, async () => {
      await store.writer.append(completed, session);
      await store.writer.append(migrated, session);
    });
    const persisted = JSON.stringify(store.records.create.mock.calls);
    expect(persisted).toContain('"differenceCount":1');
    expect(persisted).toContain('payroll.reconciliation.migrated.v1');
    expect(persisted).not.toMatch(
      /employee|account|taxSubmission|bankSubmission|migrationEvidence|reconciledBy/u,
    );
    await expect(store.context.run({ tenant, actor }, () => store.writer.append({
      ...completed, data: { ...completed.data, employeeId: 'employee-001' },
    }, session))).rejects.toThrow('PAYROLL_RECONCILIATION_OUTBOX_DATA_INVALID');
  });

  it('代发开始和对账开始事件只接受完整最小控制量', async () => {
    const store = setup();
    const events: readonly PayrollEvent[] = [
      {
        ...base, type: 'payroll.disbursement.started', data: {
          period: '2026-07', batchId: 'batch-001', status: 'disbursing',
        },
      },
      {
        ...base, version: 3, type: 'payroll.reconciliation.started', data: {
          period: '2026-07', batchId: 'batch-001',
          returnHash: 'r'.repeat(43), status: 'reconciling',
        },
      },
    ];
    await store.context.run({ tenant, actor }, async () => {
      for (const event of events) await store.writer.append(event, session);
    });
    expect(store.records.create).toHaveBeenCalledTimes(2);
  });

  it('影子比较、签署与两期资格事件拒绝员工及人员身份字段', async () => {
    const store = setup();
    const events: readonly PayrollEvent[] = [
      {
        ...base, type: 'payroll.shadow_cycle.compared', data: {
          period: '2026-07', payrollRunId: '01J8ZQK7V0A2M4N6P8R0T2W4R1',
          comparisonHash: 'c'.repeat(43), sourceManifestHash: 'm'.repeat(43),
          erpEmployeeCount: 2, legacyEmployeeCount: 2, differenceCount: 0,
          totalAbsoluteDifferenceMinor: 0, status: 'ready_for_payroll_signoff',
        },
      },
      {
        ...base, version: 2, type: 'payroll.shadow_cycle.signed', data: {
          period: '2026-07', comparisonHash: 'c'.repeat(43), differenceCount: 0,
          explanationSetHash: 'x'.repeat(43), signoffEvidenceHash: 'p'.repeat(43),
          signoffRole: 'payroll_owner', strongAuthMethod: 'webauthn_uv',
          status: 'payroll_signed',
        },
      },
      {
        ...base, version: 3, type: 'payroll.shadow_cycle.signed', data: {
          period: '2026-07', comparisonHash: 'c'.repeat(43), differenceCount: 0,
          explanationSetHash: 'x'.repeat(43), signoffEvidenceHash: 's'.repeat(43),
          signoffRole: 'finance_owner', strongAuthMethod: 'webauthn_uv', status: 'signed',
        },
      },
      {
        ...base, version: 1, type: 'payroll.cutover_readiness.eligible', data: {
          firstCycleId: '01J8ZQK7V0A2M4N6P8R0T2W4C0',
          secondCycleId: '01J8ZQK7V0A2M4N6P8R0T2W4C1',
          startPeriod: '2026-06', endPeriod: '2026-07',
          evidenceHash: 'e'.repeat(43), status: 'eligible',
        },
      },
    ];
    await store.context.run({ tenant, actor }, async () => {
      for (const event of events) await store.writer.append(event, session);
    });
    const persisted = JSON.stringify(store.records.create.mock.calls);
    expect(persisted).not.toMatch(/employeeId|signedBy|strongAuthEvidenceId|sourceExportId/u);
    await expect(store.context.run({ tenant, actor }, () => store.writer.append({
      ...events[0]!, data: { ...events[0]!.data, employeeId: 'employee-001' },
    }, session))).rejects.toThrow('PAYROLL_SHADOW_OUTBOX_DATA_INVALID');
  });

  it('影子差异归因要求解释数与未解决数严格守恒', async () => {
    const store = setup();
    const explained: PayrollEvent = {
      ...base, type: 'payroll.shadow_difference.explained', data: {
        period: '2026-07', comparisonHash: 'c'.repeat(43),
        differenceCount: 3, explainedDifferenceCount: 2,
        unresolvedDifferenceCount: 1, status: 'needs_explanation',
      },
    };
    await store.context.run({ tenant, actor }, () => store.writer.append(explained, session));
    await expect(store.context.run({ tenant, actor }, () => store.writer.append({
      ...explained,
      data: { ...explained.data, unresolvedDifferenceCount: 2 },
    }, session))).rejects.toThrow('PAYROLL_SHADOW_OUTBOX_DATA_INVALID');
  });

  it('税务、对账和影子事件的每项格式分支均失败关闭', async () => {
    const store = setup();
    const prepared: PayrollEvent = {
      ...base, type: 'payroll.tax_filing.prepared', data: {
        ...summary, format: 'CN_IIT_WITHHOLDING_MANIFEST_V1',
        objectEvidenceId: 'tax-worm-evidence-001', status: 'prepared',
      },
    };
    const approved: PayrollEvent = {
      ...base, type: 'payroll.tax_filing.approved', data: {
        ...summary, status: 'approved', strongAuthMethod: 'webauthn_uv',
      },
    };
    const submitted: PayrollEvent = {
      ...base, type: 'payroll.tax_filing.submitted', data: {
        ...summary, status: 'submitted',
        taxSubmissionId: 'submission-001', taxSubmissionEvidenceId: 'evidence-001',
        productionAuthorizationEvidenceId: 'authorization-001',
      },
    };
    const disbursing: PayrollEvent = {
      ...base, type: 'payroll.disbursement.started', data: {
        period: '2026-07', batchId: 'batch-001', status: 'disbursing',
      },
    };
    const reconciling: PayrollEvent = {
      ...base, type: 'payroll.reconciliation.started', data: {
        period: '2026-07', batchId: 'batch-001',
        returnHash: 'r'.repeat(43), status: 'reconciling',
      },
    };
    const reconciled: PayrollEvent = {
      ...base, type: 'payroll.reconciliation.completed', data: {
        period: '2026-07', batchId: 'batch-001', reconciliationId: 'recon-001',
        evidenceHash: 'e'.repeat(43), differenceCount: 0, status: 'reconciled',
      },
    };
    const compared: PayrollEvent = {
      ...base, type: 'payroll.shadow_cycle.compared', data: {
        period: '2026-07', payrollRunId: 'run-001',
        comparisonHash: 'c'.repeat(43), sourceManifestHash: 'm'.repeat(43),
        erpEmployeeCount: 1, legacyEmployeeCount: 1,
        differenceCount: 0, totalAbsoluteDifferenceMinor: 0,
        status: 'ready_for_payroll_signoff',
      },
    };
    const signed: PayrollEvent = {
      ...base, type: 'payroll.shadow_cycle.signed', data: {
        period: '2026-07', comparisonHash: 'c'.repeat(43), differenceCount: 0,
        explanationSetHash: 'x'.repeat(43), signoffEvidenceHash: 's'.repeat(43),
        signoffRole: 'finance_owner', status: 'signed', strongAuthMethod: 'webauthn_uv',
      },
    };
    const eligible: PayrollEvent = {
      ...base, type: 'payroll.cutover_readiness.eligible', data: {
        startPeriod: '2026-06', endPeriod: '2026-07',
        firstCycleId: 'cycle-001', secondCycleId: 'cycle-002',
        evidenceHash: 'e'.repeat(43), status: 'eligible',
      },
    };
    const invalidCases: readonly PayrollEvent[] = [
      { ...prepared, data: { ...prepared.data, period: '2026-13' } },
      { ...prepared, data: { ...prepared.data, payrollRunId: '@' } },
      { ...prepared, data: { ...prepared.data, contentHash: 'bad' } },
      { ...prepared, data: { ...prepared.data, employeeCount: 0 } },
      { ...prepared, data: { ...prepared.data, totalTaxableEarningsMinor: -1 } },
      { ...prepared, data: { ...prepared.data, totalWithholdingTaxMinor: 1.5 } },
      { ...prepared, data: { ...prepared.data, format: 'UNKNOWN' } },
      { ...prepared, data: { ...prepared.data, objectEvidenceId: '@' } },
      { ...approved, data: { ...approved.data, status: 'prepared' } },
      { ...approved, data: { ...approved.data, strongAuthMethod: 'password' } },
      { ...submitted, data: { ...submitted.data, taxSubmissionId: '@' } },
      {
        ...submitted,
        data: { ...submitted.data, productionAuthorizationEvidenceId: '@' },
      },
      { ...disbursing, data: { ...disbursing.data, status: 'locked' } },
      { ...reconciling, data: { ...reconciling.data, returnHash: 'bad' } },
      { ...reconciled, data: { ...reconciled.data, differenceCount: -1 } },
      { ...reconciled, data: { ...reconciled.data, status: 'unknown' } },
      { ...compared, data: { ...compared.data, erpEmployeeCount: 0 } },
      { ...compared, data: { ...compared.data, comparisonHash: 'bad' } },
      { ...signed, data: { ...signed.data, signoffRole: 'unknown' } },
      { ...signed, data: { ...signed.data, status: 'payroll_signed' } },
      { ...eligible, data: { ...eligible.data, firstCycleId: '@' } },
      { ...eligible, data: { ...eligible.data, status: 'ineligible' } },
    ];
    await store.context.run({ tenant, actor }, async () => {
      for (const event of invalidCases) {
        await expect(store.writer.append(event, session)).rejects.toThrow(/OUTBOX_DATA_INVALID/u);
      }
    });
  });
});
