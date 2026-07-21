import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { VerifiedAccessToken } from '../../identity/auth.types.js';
import { payrollDigest } from '../domain/index.js';
import { PayrollTaxFilingService } from './payroll-tax-filing.service.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const PERIOD_ID = '01J8ZQK7V0A2M4N6P8R0T2W4P1';
const RUN_ID = '01J8ZQK7V0A2M4N6P8R0T2W4R1';
const LINE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4A1';
const session = {} as ClientSession;

const actor: ActorContext = {
  actorType: 'user', actorId: 'tax-maker', tenantId: tenant.tenantId,
  roleCodes: ['payroll_tax'], scopes: ['erp:payroll:tax:prepare'],
  departmentIds: [], traceId: 'trace-tax-001',
};
const approver: ActorContext = {
  actorType: 'user', actorId: 'tax-approver', tenantId: tenant.tenantId,
  roleCodes: ['payroll_tax_approver'], scopes: ['erp:payroll:tax:approve'],
  departmentIds: [], traceId: 'trace-tax-approve-001',
};
const connector: ActorContext = {
  actorType: 'service', actorId: 'tax-connector', tenantId: tenant.tenantId,
  roleCodes: ['payroll_tax_connector'], scopes: ['erp:payroll:tax:submit'],
  departmentIds: [], traceId: 'trace-tax-submit-001',
};
const approvalToken: VerifiedAccessToken = {
  issuer: 'https://issuer.example.com', subject: approver.actorId,
  audience: ['erp-api'], resource: ['erp-api'], tenantId: tenant.tenantId,
  actorId: approver.actorId, actorType: 'user', clientId: 'erp-web',
  roleCodes: approver.roleCodes, scopes: approver.scopes,
  departmentIds: [], sessionId: 'session-tax-approve', expiresAt: 1_900_000_000,
};

function query<T>(resolve: () => T | Promise<T>) {
  const value = {
    session: vi.fn(), sort: vi.fn(), lean: vi.fn(), exec: vi.fn(async () => resolve()),
  };
  value.session.mockReturnValue(value);
  value.sort.mockReturnValue(value);
  value.lean.mockReturnValue(value);
  return value;
}

function assemble(options: {
  missingEmployment?: boolean; lockedBy?: string; gatewayFailsOnce?: boolean;
} = {}) {
  const context = new TenantContextService();
  const resultWithoutHash = {
    currency: 'CNY', inputHash: 'i'.repeat(43), grossPayMinor: 1_000_000,
    taxableEarningsMinor: 1_000_000, withholdingTaxMinor: 10_500, netPayMinor: 839_500,
    cumulativeAfter: {
      taxableIncomeMinor: 4_000_000, basicDeductionMinor: 2_000_000,
      socialInsuranceMinor: 400_000, housingFundMinor: 200_000,
      specialAdditionalDeductionMinor: 100_000, otherDeductionMinor: 0,
      taxWithheldMinor: 133_000,
    },
    steps: [],
  };
  const resultHash = payrollDigest(resultWithoutHash);
  const period = {
    id: PERIOD_ID, tenantId: tenant.tenantId, period: '2026-07', status: 'locked', version: 6,
    activeRunId: RUN_ID, resultHash, employeeCount: 1, totalTaxMinor: 10_500,
    lockedBy: options.lockedBy ?? 'payroll-locker', preparedBy: 'payroll-maker',
  };
  const line = {
    id: LINE_ID, tenantId: tenant.tenantId, periodId: PERIOD_ID, runId: RUN_ID,
    employeeId: 'employee-001', resultHash,
    dataKeyId: 'key', dataIv: 'iv', dataCiphertext: 'cipher', dataAuthTag: 'tag',
  };
  let filing: Record<string, unknown> | null = null;
  const filings = {
    findOne: vi.fn().mockImplementation(() => query(() => filing)),
    create: vi.fn().mockImplementation((records: readonly Record<string, unknown>[]) => {
      filing = { ...records[0], createdAt: new Date(), updatedAt: new Date() };
      return Promise.resolve([]);
    }),
    updateOne: vi.fn().mockImplementation((
      _filter: unknown, update: { $set: Readonly<Record<string, unknown>> },
    ) => {
      filing = { ...filing, ...update.$set };
      return Promise.resolve({ modifiedCount: 1 });
    }),
  };
  const periods = { findOne: vi.fn().mockReturnValue(query(() => period)) };
  const lines = { find: vi.fn().mockReturnValue(query(() => [line])) };
  const employments = { findOverlappingByEmployeeIds: vi.fn().mockResolvedValue(
    options.missingEmployment ? [] : [{ employeeId: 'employee-001', personId: 'person-001' }],
  ) };
  const persons = { findByIds: vi.fn().mockResolvedValue([{
    id: 'person-001', identityEvidenceId: 'identity-evidence-001',
  }]) };
  let protectedContent = '';
  const crypto = {
    unprotect: vi.fn().mockImplementation((cryptoContext: { resourceType: string }) =>
      cryptoContext.resourceType === 'calculation_line'
        ? { ...resultWithoutHash, resultHash }
        : { content: protectedContent }),
    protect: vi.fn().mockImplementation((_context: unknown, value: { content: string }) => {
      protectedContent = value.content;
      return { keyId: 'tax-key', iv: 'tax-iv', ciphertext: 'tax-cipher', authTag: 'tax-tag' };
    }),
  };
  let archived = '';
  const archive = { put: vi.fn().mockImplementation((input: { bytes: Buffer }) => {
    archived = input.bytes.toString('utf8');
    return Promise.resolve({ objectRef: 'worm/payroll-tax/filing', evidenceId: 'tax-worm-001', immutable: true });
  }) };
  const strongAuth = { requireVerifiedEvidence: vi.fn().mockResolvedValue({
    evidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4E1', method: 'webauthn_uv',
  }) };
  let gatewayAttempts = 0;
  const gateway = { submit: vi.fn().mockImplementation(() => {
    gatewayAttempts += 1;
    if (options.gatewayFailsOnce === true && gatewayAttempts === 1) {
      return Promise.reject(new Error('PAYROLL_TAX_GATEWAY_UNAVAILABLE'));
    }
    return Promise.resolve({
      submissionId: 'tax-submission-001', evidenceId: 'tax-submission-evidence-001',
      accepted: true,
    });
  }) };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const idempotency = { execute: vi.fn(async (
    _operation: string, _key: string, _request: unknown,
    handler: (value: ClientSession) => Promise<Record<string, unknown>>,
  ) => handler(session)) };
  const service = new PayrollTaxFilingService(
    idempotency as never, context, employments as never, persons as never,
    strongAuth as never, crypto as never, archive, gateway, outbox as never,
    periods as never, lines as never, filings as never,
  );
  return {
    context, service, filings, archive, outbox, strongAuth, gateway,
    archived: () => archived, employments, persons,
  };
}

describe('PayrollTaxFilingService', () => {
  it('从锁定工资与组织身份凭证生成确定性清单并写入独立 WORM', async () => {
    const store = assemble();
    const result = await store.context.run({ tenant, actor }, () =>
      store.service.prepare('payroll-tax-prepare-001', PERIOD_ID, 6));
    expect(result).toMatchObject({
      status: 'prepared', version: 2, employeeCount: 1,
      totalTaxableEarningsMinor: 1_000_000, totalWithholdingTaxMinor: 10_500,
      objectEvidenceId: 'tax-worm-001',
    });
    expect(store.archived()).toContain('"identityEvidenceId":"identity-evidence-001"');
    expect(store.archived()).toContain('"withholdingTaxMinor":10500');
    const exposed = JSON.stringify([
      store.filings.create.mock.calls, store.outbox.append.mock.calls, result,
    ]);
    expect(exposed).not.toMatch(/identity-evidence-001|employee-001|taxableIncomeMinor/u);
    expect(store.archive.put).toHaveBeenCalledOnce();
  });

  it('缺少周期内唯一劳动关系时失败关闭且不归档', async () => {
    const store = assemble({ missingEmployment: true });
    await expect(store.context.run({ tenant, actor }, () =>
      store.service.prepare('payroll-tax-missing-employment', PERIOD_ID, 6)))
      .rejects.toThrow('劳动关系缺失或重叠');
    expect(store.filings.create).not.toHaveBeenCalled();
    expect(store.archive.put).not.toHaveBeenCalled();
  });

  it('工资锁定人不得兼任税务制备人', async () => {
    const store = assemble({ lockedBy: actor.actorId });
    await expect(store.context.run({ tenant, actor }, () =>
      store.service.prepare('payroll-tax-dual-control', PERIOD_ID, 6)))
      .rejects.toThrow('职责未分离');
    expect(store.filings.create).not.toHaveBeenCalled();
  });

  it('独立审批人通过绑定清单的 WebAuthn 后才可批准', async () => {
    const store = assemble();
    const prepared = await store.context.run({ tenant, actor }, () =>
      store.service.prepare('payroll-tax-prepare-approval', PERIOD_ID, 6));
    const approved = await store.context.run({ tenant, actor: approver }, () =>
      store.service.approve(
        'payroll-tax-approve-001', prepared.id, 2,
        '01J8ZQK7V0A2M4N6P8R0T2W4E1', approvalToken,
      ));
    expect(approved).toMatchObject({ status: 'approved', version: 3 });
    expect(store.strongAuth.requireVerifiedEvidence).toHaveBeenCalledWith(expect.objectContaining({
      actorId: approver.actorId, operationId: prepared.id,
    }));
    expect(store.outbox.append).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'payroll.tax_filing.approved',
    }), session);
    expect(JSON.stringify(store.outbox.append.mock.lastCall)).toContain(
      '"strongAuthMethod":"webauthn_uv","status":"approved"',
    );
  });

  it('受信任连接器仅提交 WORM 引用并固化回执', async () => {
    const store = assemble();
    const prepared = await store.context.run({ tenant, actor }, () =>
      store.service.prepare('payroll-tax-prepare-submit', PERIOD_ID, 6));
    await store.context.run({ tenant, actor: approver }, () => store.service.approve(
      'payroll-tax-approve-submit', prepared.id, 2,
      '01J8ZQK7V0A2M4N6P8R0T2W4E1', approvalToken,
    ));
    const submitted = await store.context.run({ tenant, actor: connector }, () =>
      store.service.submit('payroll-tax-submit-001', prepared.id, 3));
    expect(submitted).toMatchObject({
      status: 'submitted', version: 4, taxSubmissionId: 'tax-submission-001',
      taxSubmissionEvidenceId: 'tax-submission-evidence-001',
    });
    expect(store.gateway.submit).toHaveBeenCalledWith(expect.objectContaining({
      filingId: prepared.id, objectRef: 'worm/payroll-tax/filing',
      contentHash: prepared.contentHash, employeeCount: 1,
    }));
    expect(JSON.stringify(store.gateway.submit.mock.calls)).not.toContain('identityEvidenceId');
  });

  it('网关暂时失败后保留 submitting 状态并可由同版本恢复', async () => {
    const store = assemble({ gatewayFailsOnce: true });
    const prepared = await store.context.run({ tenant, actor }, () =>
      store.service.prepare('payroll-tax-prepare-retry', PERIOD_ID, 6));
    await store.context.run({ tenant, actor: approver }, () => store.service.approve(
      'payroll-tax-approve-retry', prepared.id, 2,
      '01J8ZQK7V0A2M4N6P8R0T2W4E1', approvalToken,
    ));
    await expect(store.context.run({ tenant, actor: connector }, () =>
      store.service.submit('payroll-tax-submit-retry-1', prepared.id, 3)))
      .rejects.toThrow('PAYROLL_TAX_GATEWAY_UNAVAILABLE');
    const recovered = await store.context.run({ tenant, actor: connector }, () =>
      store.service.submit('payroll-tax-submit-retry-2', prepared.id, 3));
    expect(recovered).toMatchObject({ status: 'submitted', version: 4 });
    expect(store.gateway.submit).toHaveBeenCalledTimes(2);
  });
});
