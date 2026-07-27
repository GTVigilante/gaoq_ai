import { ConfigService } from '@nestjs/config';
import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { VerifiedAccessToken } from '../../identity/auth.types.js';
import { PayrollAdjustmentTaxCorrectionService } from './payroll-adjustment-tax-correction.service.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const session = {} as ClientSession;
const adjustmentId = '01J8ZQK7V0A2M4N6P8R0T2W4J1';
const adjustmentHash = 'h'.repeat(43);
const maker = actor('user', 'tax-correction-maker', [
  'erp:payroll:adjustment:tax_correction:prepare',
  'erp:payroll:adjustment:tax_correction:source:read',
]);
const approver = actor('user', 'tax-correction-approver', [
  'erp:payroll:adjustment:tax_correction:approve',
]);
const connector = actor('service', 'trusted-tax-connector', [
  'erp:payroll:adjustment:tax_correction:submit',
]);
const approvalToken: VerifiedAccessToken = {
  issuer: 'https://issuer.example.com',
  subject: approver.actorId,
  audience: ['erp-api'],
  resource: ['erp-api'],
  tenantId: tenant.tenantId,
  actorId: approver.actorId,
  actorType: 'user',
  clientId: 'erp-web',
  roleCodes: approver.roleCodes,
  scopes: approver.scopes,
  departmentIds: [],
  sessionId: 'session-tax-correction-approve',
  expiresAt: 1_900_000_000,
};

function actor(
  actorType: ActorContext['actorType'],
  actorId: string,
  scopes: readonly string[],
): ActorContext {
  return {
    actorType,
    actorId,
    tenantId: tenant.tenantId,
    roleCodes: [],
    scopes,
    departmentIds: [],
    traceId: `trace-${actorId}`,
  };
}

function query<T>(read: () => T) {
  const result = {
    session: vi.fn(() => result),
    lean: vi.fn(() => result),
    exec: vi.fn(() => Promise.resolve(read())),
  };
  return result;
}

function assemble(controlActorIds: readonly string[] = [
  'adjustment-maker',
  'adjustment-approver',
]) {
  const context = new TenantContextService();
  let correction: Record<string, unknown> | null = null;
  let protectedEnvelope: Record<string, unknown> | null = null;
  const idempotency = { execute: vi.fn(async (
    _operation: string,
    _key: string,
    _input: unknown,
    handler: (value: ClientSession) => Promise<Record<string, unknown>>,
  ) => handler(session)) };
  const adjustments = {
    getLockedTaxCorrectionSource: vi.fn().mockResolvedValue({
      adjustmentId,
      adjustmentHash,
      period: '2026-07',
      employeeId: 'employee-001',
      reasonCode: 'RETROACTIVE_SALARY_CHANGE',
      originalResultHash: 'o'.repeat(43),
      correctedResultHash: 'c'.repeat(43),
      originalTaxableEarningsMinor: 1_000_000,
      correctedTaxableEarningsMinor: 1_100_000,
      originalWithholdingTaxMinor: 10_500,
      correctedWithholdingTaxMinor: 13_500,
      taxableEarningsDeltaMinor: 100_000,
      withholdingTaxDeltaMinor: 3_000,
      cumulativeTaxWithheldDeltaMinor: 3_000,
      adjustmentVersion: 4,
      controlActorIds,
    }),
    recordTaxCorrectionPrepared: vi.fn().mockResolvedValue(undefined),
    recordTaxCorrectionSubmitted: vi.fn().mockResolvedValue(undefined),
  };
  const crypto = {
    protect: vi.fn((_context: unknown, value: Record<string, unknown>) => {
      protectedEnvelope = value;
      return {
        keyId: 'tax-correction-key',
        iv: 'i'.repeat(16),
        ciphertext: 'c'.repeat(128),
        authTag: 'a'.repeat(22),
      };
    }),
    unprotect: vi.fn(() => protectedEnvelope),
  };
  const corrections = {
    create: vi.fn(([value]: readonly Record<string, unknown>[]) => {
      correction = { ...value };
      return Promise.resolve([]);
    }),
    findOne: vi.fn(() => query(() => correction)),
    updateOne: vi.fn((
      _filter: unknown,
      update: { readonly $set: Readonly<Record<string, unknown>> },
    ) => {
      correction = correction === null
        ? null
        : { ...correction, ...update.$set };
      return Promise.resolve({ modifiedCount: correction === null ? 0 : 1 });
    }),
  };
  const archive = { put: vi.fn().mockResolvedValue({
    objectRef: 'worm/payroll-tax/correction-001',
    evidenceId: 'worm-correction-evidence-001',
    immutable: true,
  }) };
  const gateway = { submit: vi.fn().mockResolvedValue({
    submissionId: 'tax-correction-submission-001',
    evidenceId: 'tax-correction-receipt-001',
    accepted: true,
    productionAuthorizationEvidenceId: null,
  }) };
  const strongAuth = { requireVerifiedEvidence: vi.fn().mockResolvedValue({
    evidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4E1',
    method: 'webauthn_uv',
  }) };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const productionAuthorization = { authorize: vi.fn() };
  const service = new PayrollAdjustmentTaxCorrectionService(
    idempotency as never,
    context,
    adjustments as never,
    strongAuth as never,
    crypto as never,
    archive,
    gateway,
    new ConfigService({ PAYROLL_TAX_GATEWAY_MODE: 'sandbox' }) as never,
    productionAuthorization as never,
    outbox as never,
    corrections as never,
  );
  return {
    context,
    service,
    adjustments,
    corrections,
    archive,
    gateway,
    strongAuth,
    outbox,
  };
}

describe('PayrollAdjustmentTaxCorrectionService', () => {
  it('完成 WORM 制备、独立强认证审批、税局提交并回写调整终态', async () => {
    const store = assemble();
    const prepared = await store.context.run({ tenant, actor: maker }, () =>
      store.service.prepare('tax-correction-prepare-001', adjustmentId, 4));
    expect(prepared).toMatchObject({
      adjustmentId,
      adjustmentHash,
      period: '2026-07',
      format: 'CN_IIT_WITHHOLDING_CORRECTION_V1',
      status: 'prepared',
      version: 2,
      correctedTaxableEarningsMinor: 1_100_000,
      correctedWithholdingTaxMinor: 13_500,
    });
    expect(store.adjustments.recordTaxCorrectionPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        adjustmentId,
        adjustmentHash,
        filingId: prepared.id,
        expectedVersion: 4,
      }),
      session,
    );
    const archived = store.archive.put.mock.calls[0]?.[0] as {
      readonly bytes: Buffer;
    };
    expect(JSON.parse(archived.bytes.toString('utf8'))).toMatchObject({
      schema: 'CN_IIT_WITHHOLDING_CORRECTION_V1',
      employeeId: 'employee-001',
      adjustmentId,
    });

    const approved = await store.context.run({ tenant, actor: approver }, () =>
      store.service.approve(
        'tax-correction-approve-001',
        prepared.id,
        2,
        '01J8ZQK7V0A2M4N6P8R0T2W4E1',
        approvalToken,
      ));
    expect(approved).toMatchObject({ status: 'approved', version: 3 });
    const submitted = await store.context.run({ tenant, actor: connector }, () =>
      store.service.submit('tax-correction-submit-001', prepared.id, 3));
    expect(submitted).toMatchObject({
      status: 'submitted',
      version: 4,
      taxSubmissionId: 'tax-correction-submission-001',
      taxSubmissionEvidenceId: 'tax-correction-receipt-001',
    });
    expect(store.gateway.submit).toHaveBeenCalledWith(expect.objectContaining({
      filingId: prepared.id,
      employeeCount: 1,
      totalTaxableEarningsMinor: 1_100_000,
      totalWithholdingTaxMinor: 13_500,
    }));
    expect(store.adjustments.recordTaxCorrectionSubmitted).toHaveBeenCalledWith(
      { adjustmentId, adjustmentHash, filingId: prepared.id },
      session,
    );
    const events = JSON.stringify(store.outbox.append.mock.calls);
    expect(events).not.toMatch(/employeeId|taxableEarningsMinor|withholdingTaxMinor/u);
  });

  it('制备人与调整控制链冲突时不创建清单或外部 WORM', async () => {
    const store = assemble([maker.actorId]);
    await expect(store.context.run({ tenant, actor: maker }, () =>
      store.service.prepare(
        'tax-correction-prepare-002',
        adjustmentId,
        4,
      ))).rejects.toMatchObject({
      response: {
        code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_INDEPENDENCE_REQUIRED',
      },
    });
    expect(store.corrections.create).not.toHaveBeenCalled();
    expect(store.archive.put).not.toHaveBeenCalled();
  });

  it('审批人属于原调整控制链时失败关闭', async () => {
    const store = assemble([approver.actorId]);
    const prepared = await store.context.run({ tenant, actor: maker }, () =>
      store.service.prepare('tax-correction-prepare-003', adjustmentId, 4));
    await expect(store.context.run({ tenant, actor: approver }, () =>
      store.service.approve(
        'tax-correction-approve-003',
        prepared.id,
        2,
        '01J8ZQK7V0A2M4N6P8R0T2W4E1',
        approvalToken,
      ))).rejects.toMatchObject({
      response: {
        code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_APPROVAL_STATE_INVALID',
      },
    });
    expect(store.gateway.submit).not.toHaveBeenCalled();
  });
});
