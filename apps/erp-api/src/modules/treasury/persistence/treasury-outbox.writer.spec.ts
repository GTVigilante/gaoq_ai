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

  it('导出批准事件只公开强认证方法，不公开批准人或证据详情', async () => {
    const context = new TenantContextService();
    const create = vi.fn().mockResolvedValue([]);
    const writer = new TreasuryOutboxWriter(context, { create } as never);
    const approved: TreasuryEvent = {
      type: 'treasury.disbursement.export_approved', tenantId: 'tenant-001',
      aggregateId: 'batch-001', version: 3, occurredAt: '2026-07-22T10:01:00.000Z',
      data: {
        payrollPeriodId: 'period-001', payrollRunId: 'run-001', lineCount: 2,
        totalMinor: 1_839_600, fileHash: 'a'.repeat(43),
        objectEvidenceId: 'receipt-001', status: 'exported', strongAuthMethod: 'webauthn_uv',
      },
    };
    await context.run({ tenant, actor }, () => writer.append(approved, session));
    const calls = JSON.stringify(create.mock.calls);
    expect(calls).toContain('"status":"exported"');
    expect(calls).not.toMatch(/approvedBy|strongAuthEvidenceId|credentialId/u);
    await expect(context.run({ tenant, actor }, () => writer.append({
      ...approved, data: { ...approved.data, approvedBy: 'treasury-checker' },
    }, session))).rejects.toThrow('TREASURY_OUTBOX_DATA_INVALID');
  });

  it('银行提交事件只公开批次与可信提交回执引用', async () => {
    const context = new TenantContextService();
    const create = vi.fn().mockResolvedValue([]);
    const writer = new TreasuryOutboxWriter(context, { create } as never);
    const submitted: TreasuryEvent = {
      type: 'treasury.disbursement.submitted', tenantId: 'tenant-001',
      aggregateId: 'batch-001', version: 4, occurredAt: '2026-07-22T10:02:00.000Z',
      data: {
        payrollPeriodId: 'period-001', payrollRunId: 'run-001', lineCount: 2,
        totalMinor: 1_839_600, fileHash: 'a'.repeat(43), status: 'submitted',
        bankSubmissionId: 'bank-submission-001',
        bankSubmissionEvidenceId: 'bank-evidence-001',
      },
    };
    await context.run({ tenant, actor }, () => writer.append(submitted, session));
    const calls = JSON.stringify(create.mock.calls);
    expect(calls).toContain('"bankSubmissionEvidenceId":"bank-evidence-001"');
    expect(calls).not.toMatch(/objectRef|authorization|account|employee/u);
    await expect(context.run({ tenant, actor }, () => writer.append({
      ...submitted, data: { ...submitted.data, objectRef: 'worm/private-object' },
    }, session))).rejects.toThrow('TREASURY_OUTBOX_DATA_INVALID');
  });

  it('银行回盘事件只公开证据引用与批次汇总', async () => {
    const context = new TenantContextService();
    const create = vi.fn().mockResolvedValue([]);
    const writer = new TreasuryOutboxWriter(context, { create } as never);
    const returned: TreasuryEvent = {
      type: 'treasury.bank_return.applied', tenantId: 'tenant-001',
      aggregateId: 'batch-001', version: 5, occurredAt: '2026-07-22T10:03:00.000Z',
      data: {
        returnHash: 'r'.repeat(43), outcome: 'frozen', freezeReason: 'PARTIAL_SUCCESS',
        successfulCount: 1, failedCount: 1, unknownCount: 0, duplicateCount: 0,
        lineAmountMismatchCount: 0, successfulMinor: 839_500, failedMinor: 1_000_100,
        objectEvidenceId: 'return-object-001', signatureEvidenceId: 'signature-001',
        malwareScanEvidenceId: 'scan-001',
      },
    };
    await context.run({ tenant, actor }, () => writer.append(returned, session));
    const calls = JSON.stringify(create.mock.calls);
    expect(calls).toContain('"freezeReason":"PARTIAL_SUCCESS"');
    expect(calls).toContain('"malwareScanEvidenceId":"scan-001"');
    expect(calls).not.toMatch(/instruction|bankLineReference|account|employee/u);
    await expect(context.run({ tenant, actor }, () => writer.append({
      ...returned, data: { ...returned.data, instructionId: 'instruction-001' },
    }, session))).rejects.toThrow('TREASURY_OUTBOX_DATA_INVALID');
  });

  it('失败子批次事件只公开父批次、回盘摘要和失败汇总', async () => {
    const context = new TenantContextService();
    const create = vi.fn().mockResolvedValue([]);
    const writer = new TreasuryOutboxWriter(context, { create } as never);
    const recovery: TreasuryEvent = {
      type: 'treasury.disbursement.recovery_requested', tenantId: 'tenant-001',
      aggregateId: 'child-batch-001', version: 1, occurredAt: '2026-07-22T10:04:00.000Z',
      data: {
        parentBatchId: 'parent-batch-001', payrollPeriodId: 'period-001',
        payrollRunId: 'run-001', returnHash: 'r'.repeat(43), failedCount: 1,
        failedMinor: 839_500, status: 'materializing', strongAuthMethod: 'webauthn_uv',
      },
    };
    await context.run({ tenant, actor }, () => writer.append(recovery, session));
    const calls = JSON.stringify(create.mock.calls);
    expect(calls).toContain('"parentBatchId":"parent-batch-001"');
    expect(calls).not.toMatch(/employee|instruction|account|approvedBy|evidence/u);
  });

  it('四方对账事件只公开证据摘要和差异数量', async () => {
    const context = new TenantContextService();
    const create = vi.fn().mockResolvedValue([]);
    const writer = new TreasuryOutboxWriter(context, { create } as never);
    const reconciled: TreasuryEvent = {
      type: 'treasury.reconciliation.completed', tenantId: tenant.tenantId,
      aggregateId: 'batch-001', version: 6, occurredAt: '2026-07-22T10:05:00.000Z',
      data: {
        payrollPeriodId: 'period-001', payrollRunId: 'run-001',
        reconciliationId: 'reconciliation-001', evidenceHash: 'e'.repeat(43),
        differenceCount: 0, status: 'reconciled',
      },
    };
    await context.run({ tenant, actor }, () => writer.append(reconciled, session));
    const calls = JSON.stringify(create.mock.calls);
    expect(calls).toContain('"status":"reconciled"');
    expect(calls).not.toMatch(/employee|account|taxSubmission|bankSubmission/u);
    await expect(context.run({ tenant, actor }, () => writer.append({
      ...reconciled, data: { ...reconciled.data, employeeId: 'employee-001' },
    }, session))).rejects.toThrow('TREASURY_OUTBOX_DATA_INVALID');
  });
});
