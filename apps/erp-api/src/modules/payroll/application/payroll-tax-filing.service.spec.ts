import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { productionExecutionSubjectHash } from '../../../core/production-execution/production-execution-authorization.service.js';
import type { VerifiedAccessToken } from '../../identity/auth.types.js';
import { payrollDigest } from '../domain/index.js';
import {
  type ImportPayrollTaxFilingFromMigrationInput,
  PayrollTaxFilingService,
} from './payroll-tax-filing.service.js';

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
const migrationActor: ActorContext = {
  actorType: 'service', actorId: 'migration-agent-001', tenantId: tenant.tenantId,
  roleCodes: ['migration'],
  scopes: ['erp:migration:execute', 'erp:payroll:migration:write'],
  departmentIds: [], traceId: 'trace-tax-migration-001',
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
  gatewayMode?: 'sandbox' | 'production';
  omitMigrationDependencies?: boolean; tamperProtectedManifest?: boolean;
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
  let period: Record<string, unknown> | null = {
    id: PERIOD_ID, tenantId: tenant.tenantId, period: '2026-07', status: 'locked', version: 6,
    activeRunId: RUN_ID, resultHash, employeeCount: 1, totalTaxMinor: 10_500,
    lockedBy: options.lockedBy ?? 'payroll-locker', preparedBy: 'payroll-maker',
    approvedBy: 'payroll-approver', strongAuthReferenceType: 'migration_lock_evidence',
    updatedAt: new Date('2026-07-02T00:00:00.000Z'),
  };
  const line: Record<string, unknown> = {
    id: LINE_ID, tenantId: tenant.tenantId, periodId: PERIOD_ID, runId: RUN_ID,
    employeeId: 'employee-001', resultHash,
    dataKeyId: 'key', dataIv: 'iv', dataCiphertext: 'cipher', dataAuthTag: 'tag',
  };
  let lineRecords: readonly Record<string, unknown>[] = [line];
  let filing: Record<string, unknown> | null = null;
  const filings = {
    findOne: vi.fn().mockImplementation(() => query(() => filing)),
    create: vi.fn().mockImplementation((records: readonly Record<string, unknown>[]) => {
      filing = {
        ...records[0],
        createdAt: records[0]?.createdAt ?? new Date(),
        updatedAt: records[0]?.updatedAt ?? new Date(),
      };
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
  const lines = { find: vi.fn().mockImplementation(() => query(() => lineRecords)) };
  let employmentRecords: readonly Record<string, unknown>[] = options.missingEmployment
    ? []
    : [{ employeeId: 'employee-001', personId: 'person-001' }];
  const employments = { findOverlappingByEmployeeIds: vi.fn(
    () => Promise.resolve(employmentRecords),
  ) };
  let personRecords: readonly Record<string, unknown>[] = [{
    id: 'person-001', identityEvidenceId: 'identity-evidence-001',
  }];
  const persons = { findByIds: vi.fn(() => Promise.resolve(personRecords)) };
  let protectedContent = '';
  const crypto = {
    unprotect: vi.fn().mockImplementation((cryptoContext: { resourceType: string }) =>
      cryptoContext.resourceType === 'calculation_line'
        ? { ...resultWithoutHash, resultHash }
        : {
          content: options.tamperProtectedManifest === true
            ? `${protectedContent}tampered`
            : protectedContent,
        }),
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
      accepted: true, productionAuthorizationEvidenceId: options.gatewayMode === 'production'
        ? 'authorization-evidence-001' : null,
    });
  }) };
  const productionAuthorization = { authorize: vi.fn().mockResolvedValue({
    authorizationId: 'authorization-001', evidenceId: 'authorization-evidence-001',
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    releaseCommitSha: 'c'.repeat(40), deploymentManifestHash: `sha256:${'d'.repeat(64)}`,
  }) };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const profiles = { findActorIdByEmployee: vi.fn((
    _tenantId: string, employeeId: string,
  ) => Promise.resolve(employeeId === 'employee-tax-maker' ? 'tax-maker' : 'tax-approver')) };
  const approvals = { verifyPayrollMigrationReference: vi.fn().mockResolvedValue({
    id: '01J8ZQK7V0A2M4N6P8R0T2W4H1', templateCode: 'payroll_tax_filing_approval',
    completedAt: '2026-07-03T00:00:00.000Z', evidenceChecksum: 'a'.repeat(43),
  }) };
  const idempotency = { execute: vi.fn(async (
    _operation: string, _key: string, _request: unknown,
    handler: (value: ClientSession) => Promise<Record<string, unknown>>,
  ) => handler(session)) };
  const service = new PayrollTaxFilingService(
    idempotency as never, context, employments as never, persons as never,
    strongAuth as never, crypto as never, archive, gateway,
    new ConfigService({ PAYROLL_TAX_GATEWAY_MODE: options.gatewayMode ?? 'sandbox' }) as never,
    productionAuthorization as never,
    outbox as never,
    periods as never, lines as never, filings as never,
    options.omitMigrationDependencies === true ? undefined : profiles as never,
    options.omitMigrationDependencies === true ? undefined : approvals as never,
  );
  const requireFiling = (): Record<string, unknown> => {
    if (filing === null) throw new Error('测试清单尚未建立');
    return filing;
  };
  return {
    context, service, filings, archive, outbox, strongAuth, gateway,
    archived: () => archived, employments, persons, profiles, approvals, crypto,
    productionAuthorization, idempotency, periods, lines, period: () => period,
    setPeriod: (value: Record<string, unknown> | null) => { period = value; },
    line, setLines: (value: readonly Record<string, unknown>[]) => { lineRecords = value; },
    setEmployments: (value: readonly Record<string, unknown>[]) => {
      employmentRecords = value;
    },
    setPeople: (value: readonly Record<string, unknown>[]) => { personRecords = value; },
    filing: requireFiling,
    setFiling: (value: Record<string, unknown> | null) => { filing = value; },
    mutateFiling: (changes: Readonly<Record<string, unknown>>) => {
      filing = { ...requireFiling(), ...changes };
    },
    resultWithoutHash,
  };
}

function migrationInput(
  overrides: Partial<ImportPayrollTaxFilingFromMigrationInput> = {},
): ImportPayrollTaxFilingFromMigrationInput {
  return {
    targetId: null, periodId: PERIOD_ID, payrollRunId: RUN_ID,
    expectedPeriodVersion: 6, preparedByEmployeeId: 'employee-tax-maker',
    approvedByEmployeeId: 'employee-tax-approver',
    approvalHistoryId: '01J8ZQK7V0A2M4N6P8R0T2W4H1',
    approvalEvidenceChecksum: 'a'.repeat(43), expectedEmployeeCount: 1,
    expectedTotalTaxableEarningsMinor: 1_000_000,
    expectedTotalWithholdingTaxMinor: 10_500,
    taxSubmissionId: 'legacy-tax-submission-001',
    taxSubmissionEvidenceId: 'legacy-tax-evidence-001',
    submittedAt: '2026-07-04T00:00:00.000Z',
    migrationEvidenceRef:
      'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/tax-001',
    evidenceChecksum: 'e'.repeat(43),
    ...overrides,
  };
}

function runMigration(
  store: ReturnType<typeof assemble>,
  key: string,
  input: ImportPayrollTaxFilingFromMigrationInput = migrationInput(),
) {
  return store.context.run({
    tenant: { tenantId: tenant.tenantId, source: 'service_identity' },
    actor: migrationActor,
  }, () => store.service.importSubmittedFromMigration(key, input));
}

async function prepareAndApprove(store: ReturnType<typeof assemble>, key: string) {
  const prepared = await store.context.run({ tenant, actor }, () =>
    store.service.prepare(`${key}-prepare`, PERIOD_ID, 6));
  await store.context.run({ tenant, actor: approver }, () => store.service.approve(
    `${key}-approve`, prepared.id, 2,
    '01J8ZQK7V0A2M4N6P8R0T2W4E1', approvalToken,
  ));
  return prepared;
}

describe('PayrollTaxFilingService', () => {
  it('迁移时重建清单并恢复已提交回执但不调用归档或税局网关', async () => {
    const store = assemble();
    const result = await store.context.run({
      tenant: { tenantId: tenant.tenantId, source: 'service_identity' },
      actor: migrationActor,
    }, () => store.service.importSubmittedFromMigration(
      'payroll-tax-migration-001', migrationInput(),
    ));

    expect(result).toMatchObject({
      periodId: PERIOD_ID, payrollRunId: RUN_ID, status: 'submitted', version: 4,
      employeeCount: 1, totalTaxableEarningsMinor: 1_000_000,
      totalWithholdingTaxMinor: 10_500,
      taxSubmissionId: 'legacy-tax-submission-001',
      taxSubmissionEvidenceId: 'legacy-tax-evidence-001',
    });
    const createCall = store.filings.create.mock.calls[0] as unknown as [
      readonly Record<string, unknown>[], Record<string, unknown>,
    ];
    expect(createCall[0][0]).toMatchObject({
      preparedBy: 'tax-maker', approvedBy: 'tax-approver',
      strongAuthReferenceType: 'migration_tax_approval_evidence',
      objectRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/tax-001',
    });
    expect(store.archive.put).not.toHaveBeenCalled();
    expect(store.gateway.submit).not.toHaveBeenCalled();
    expect(store.outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'payroll.tax_filing.migrated', version: 4,
    }), session);
  });

  it('只允许具有双重迁移权限的服务身份恢复个税提交证据', async () => {
    const store = assemble();
    const untrustedActor: ActorContext = {
      ...migrationActor, actorType: 'user', actorId: 'migration-user-001',
    };
    await expect(store.context.run({ tenant, actor: untrustedActor }, () =>
      store.service.importSubmittedFromMigration(
        'payroll-tax-migration-untrusted', migrationInput(),
      ))).rejects.toThrow('受信任服务身份');
    expect(store.profiles.findActorIdByEmployee).not.toHaveBeenCalled();
    expect(store.filings.create).not.toHaveBeenCalled();
  });

  it('税务角色与工资制备审批锁定角色冲突时失败关闭', async () => {
    const store = assemble();
    store.profiles.findActorIdByEmployee.mockImplementation(
      (_tenantId: string, employeeId: string) => Promise.resolve(
        employeeId === 'employee-tax-maker' ? 'payroll-maker' : 'tax-approver',
      ),
    );
    await expect(store.context.run({
      tenant: { tenantId: tenant.tenantId, source: 'service_identity' },
      actor: migrationActor,
    }, () => store.service.importSubmittedFromMigration(
      'payroll-tax-migration-role-conflict', migrationInput(),
    ))).rejects.toThrow('职责分离');
    expect(store.filings.create).not.toHaveBeenCalled();
    expect(store.outbox.append).not.toHaveBeenCalled();
  });

  it('目标记录重放时重新计算清单并逐项校验不可变证据', async () => {
    const store = assemble();
    const context = {
      tenant: { tenantId: tenant.tenantId, source: 'service_identity' as const },
      actor: migrationActor,
    };
    const imported = await store.context.run(context, () =>
      store.service.importSubmittedFromMigration(
        'payroll-tax-migration-replay-create', migrationInput(),
      ));
    const replayed = await store.context.run(context, () =>
      store.service.importSubmittedFromMigration(
        'payroll-tax-migration-replay-verify', migrationInput({ targetId: imported.id }),
      ));
    expect(replayed).toEqual(imported);
    expect(store.filings.create).toHaveBeenCalledOnce();
    expect(store.outbox.append).toHaveBeenCalledOnce();
    expect(store.crypto.unprotect).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: 'tax_filing', resourceId: imported.id,
    }), expect.any(Object));
  });

  it('真实税务模式缺少短时授权时失败关闭，有效授权才允许提交', async () => {
    const store = assemble({ gatewayMode: 'production' });
    const prepared = await store.context.run({ tenant, actor }, () =>
      store.service.prepare('payroll-tax-production-prepare', PERIOD_ID, 6));
    await store.context.run({ tenant, actor: approver }, () => store.service.approve(
      'payroll-tax-production-approve', prepared.id, 2,
      '01J8ZQK7V0A2M4N6P8R0T2W4E1', approvalToken,
    ));
    store.productionAuthorization.authorize.mockRejectedValueOnce(
      new Error('PHASE6_PRODUCTION_AUTHORIZATION_UNAVAILABLE'),
    );
    await expect(store.context.run({ tenant, actor: connector }, () => store.service.submit(
      'payroll-tax-production-submit-denied', prepared.id, 3,
    ))).rejects.toThrow('PHASE6_PRODUCTION_AUTHORIZATION_UNAVAILABLE');
    expect(store.gateway.submit).not.toHaveBeenCalled();
    await expect(store.context.run({ tenant, actor: connector }, () => store.service.submit(
      'payroll-tax-production-submit-approved', prepared.id, 3,
    ))).resolves.toMatchObject({ status: 'submitted', taxSubmissionId: 'tax-submission-001' });
    const authorizationCall = store.productionAuthorization.authorize.mock.lastCall as
      | [{ action: string; tenantId: string; resourceId: string; subjectHash: string;
        expectedVersion: number }]
      | undefined;
    if (authorizationCall === undefined) throw new Error('测试缺少生产授权调用');
    expect(authorizationCall[0]).toMatchObject({
      action: 'payroll-tax-submission', tenantId: tenant.tenantId,
      resourceId: prepared.id, expectedVersion: 3,
    });
    expect(authorizationCall[0].subjectHash).toBe(productionExecutionSubjectHash([
      PERIOD_ID, RUN_ID, 'worm/payroll-tax/filing', prepared.contentHash,
      1, 1_000_000, 10_500, 'tax-worm-001', approver.actorId,
      '01J8ZQK7V0A2M4N6P8R0T2W4E1', 'webauthn_evidence',
    ]));
    const gatewayCall = store.gateway.submit.mock.lastCall as
      | [{ productionAuthorization: { authorizationId: string } | null }]
      | undefined;
    if (gatewayCall === undefined) throw new Error('测试缺少税务网关调用');
    expect(gatewayCall[0].productionAuthorization?.authorizationId).toBe('authorization-001');
  });

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

  it('状态读取只允许专用权限且拒绝非法或不存在的清单', async () => {
    const store = assemble();
    await expect(store.context.run({ tenant, actor }, () =>
      store.service.getStatus(PERIOD_ID))).rejects.toThrow('缺少个税申报状态读取权限');
    const reader: ActorContext = {
      ...actor, actorId: 'tax-reader', scopes: ['erp:payroll:tax:read'],
    };
    await expect(store.context.run({ tenant, actor: reader }, () =>
      store.service.getStatus('invalid'))).rejects.toThrow('个税申报清单标识非法');
    await expect(store.context.run({ tenant, actor: reader }, () =>
      store.service.getStatus(PERIOD_ID))).rejects.toThrow('个税申报清单不存在');
    const prepared = await store.context.run({ tenant, actor }, () =>
      store.service.prepare('payroll-tax-status-prepare', PERIOD_ID, 6));
    const status = await store.context.run({ tenant, actor: reader }, () =>
      store.service.getStatus(prepared.id));
    expect(status).toMatchObject({ id: prepared.id, status: 'prepared', version: 2 });
    expect(Object.isFrozen(status)).toBe(true);
  });

  it('制备入口拒绝无权限、非人员身份和非法引用且不创建清单', async () => {
    const noScope: ActorContext = { ...actor, scopes: [] };
    const servicePreparer: ActorContext = {
      ...connector, scopes: ['erp:payroll:tax:prepare'],
    };
    for (const operation of [
      () => {
        const store = assemble();
        return store.context.run({ tenant, actor: noScope }, () =>
          store.service.prepare('prepare-no-scope', PERIOD_ID, 6));
      },
      () => {
        const store = assemble();
        return store.context.run({ tenant, actor: servicePreparer }, () =>
          store.service.prepare('prepare-not-human', PERIOD_ID, 6));
      },
      () => {
        const store = assemble();
        return store.context.run({ tenant, actor }, () =>
          store.service.prepare('prepare-invalid-id', 'invalid', 6));
      },
      () => {
        const store = assemble();
        return store.context.run({ tenant, actor }, () =>
          store.service.prepare('prepare-invalid-version', PERIOD_ID, 0));
      },
    ]) await expect(operation()).rejects.toThrow();
  });

  it('制备严格校验周期存在性、锁定控制量和职责分离', async () => {
    const missing = assemble();
    missing.setPeriod(null);
    await expect(missing.context.run({ tenant, actor }, () =>
      missing.service.prepare('prepare-period-missing', PERIOD_ID, 6)))
      .rejects.toThrow('工资周期不存在');

    const invalidStates: readonly Readonly<Record<string, unknown>>[] = [
      { status: 'calculated' }, { version: 7 }, { activeRunId: null },
      { resultHash: null }, { employeeCount: null }, { totalTaxMinor: null },
      { lockedBy: null }, { preparedBy: actor.actorId },
    ];
    for (const [index, changes] of invalidStates.entries()) {
      const store = assemble();
      const period = store.period();
      if (period === null) throw new Error('测试周期缺失');
      Object.assign(period, changes);
      await expect(store.context.run({ tenant, actor }, () =>
        store.service.prepare(`prepare-period-invalid-${index}`, PERIOD_ID, 6)))
        .rejects.toThrow('工资周期未锁定');
      expect(store.archive.put).not.toHaveBeenCalled();
    }
  });

  it('同一制备人可恢复已归档清单，其他制备人或已拒绝清单不得覆盖', async () => {
    const store = assemble();
    const prepared = await store.context.run({ tenant, actor }, () =>
      store.service.prepare('prepare-existing-first', PERIOD_ID, 6));
    await expect(store.context.run({ tenant, actor }, () =>
      store.service.prepare('prepare-existing-replay', PERIOD_ID, 6)))
      .resolves.toEqual(prepared);
    expect(store.archive.put).toHaveBeenCalledOnce();

    const otherMaker: ActorContext = { ...actor, actorId: 'tax-maker-other' };
    await expect(store.context.run({ tenant, actor: otherMaker }, () =>
      store.service.prepare('prepare-existing-other', PERIOD_ID, 6)))
      .rejects.toThrow('其他制备人');
    store.mutateFiling({ preparedBy: actor.actorId, status: 'rejected' });
    await expect(store.context.run({ tenant, actor }, () =>
      store.service.prepare('prepare-existing-rejected', PERIOD_ID, 6)))
      .rejects.toThrow('清单已拒绝');
  });

  it('员工行、劳动关系、身份凭证、密文和税额任一不完整均失败关闭', async () => {
    const empty = assemble();
    empty.setLines([]);
    await expect(empty.context.run({ tenant, actor }, () =>
      empty.service.prepare('prepare-empty-lines', PERIOD_ID, 6)))
      .rejects.toThrow('员工行不完整');

    const duplicateEmployment = assemble();
    const period = duplicateEmployment.period();
    if (period === null) throw new Error('测试周期缺失');
    Object.assign(period, { employeeCount: 2, totalTaxMinor: 21_000 });
    duplicateEmployment.setLines([
      duplicateEmployment.line,
      { ...duplicateEmployment.line, id: '01J8ZQK7V0A2M4N6P8R0T2W4A2', employeeId: 'employee-002' },
    ]);
    duplicateEmployment.setEmployments([
      { employeeId: 'employee-001', personId: 'person-001' },
      { employeeId: 'employee-001', personId: 'person-002' },
    ]);
    await expect(duplicateEmployment.context.run({ tenant, actor }, () =>
      duplicateEmployment.service.prepare('prepare-employment-duplicate', PERIOD_ID, 6)))
      .rejects.toThrow('劳动关系缺失或重叠');

    const missingPerson = assemble();
    missingPerson.setPeople([]);
    await expect(missingPerson.context.run({ tenant, actor }, () =>
      missingPerson.service.prepare('prepare-person-missing', PERIOD_ID, 6)))
      .rejects.toThrow('身份核验证据不完整');

    const unboundPerson = assemble();
    unboundPerson.setPeople([{ id: 'person-other', identityEvidenceId: 'identity-other' }]);
    await expect(unboundPerson.context.run({ tenant, actor }, () =>
      unboundPerson.service.prepare('prepare-person-unbound', PERIOD_ID, 6)))
      .rejects.toThrow('身份绑定完整性失败');

    const invalidCipher = assemble();
    invalidCipher.crypto.unprotect.mockReturnValueOnce({ invalid: true });
    await expect(invalidCipher.context.run({ tenant, actor }, () =>
      invalidCipher.service.prepare('prepare-cipher-invalid', PERIOD_ID, 6)))
      .rejects.toThrow('个税制备所需密文非法');

    const hashMismatch = assemble();
    hashMismatch.crypto.unprotect.mockReturnValueOnce({
      ...hashMismatch.resultWithoutHash, resultHash: 'x'.repeat(43),
    });
    await expect(hashMismatch.context.run({ tenant, actor }, () =>
      hashMismatch.service.prepare('prepare-line-hash-mismatch', PERIOD_ID, 6)))
      .rejects.toThrow('税务工资行或身份绑定完整性失败');

    const totalMismatch = assemble();
    const mismatchPeriod = totalMismatch.period();
    if (mismatchPeriod === null) throw new Error('测试周期缺失');
    mismatchPeriod.totalTaxMinor = 10_501;
    await expect(totalMismatch.context.run({ tenant, actor }, () =>
      totalMismatch.service.prepare('prepare-total-mismatch', PERIOD_ID, 6)))
      .rejects.toThrow('锁定工资税额不一致');
  });

  it('清单生成领域错误、密文摘要篡改和归档并发均映射为稳定错误', async () => {
    const invalidPeriod = assemble();
    const period = invalidPeriod.period();
    if (period === null) throw new Error('测试周期缺失');
    period.period = '2026-13';
    await expect(invalidPeriod.context.run({ tenant, actor }, () =>
      invalidPeriod.service.prepare('prepare-invalid-period', PERIOD_ID, 6)))
      .rejects.toMatchObject({
        response: { code: 'PAYROLL_TAX_MANIFEST_INPUT_INVALID' },
      });

    const tampered = assemble({ tamperProtectedManifest: true });
    await expect(tampered.context.run({ tenant, actor }, () =>
      tampered.service.prepare('prepare-tampered-manifest', PERIOD_ID, 6)))
      .rejects.toThrow('个税清单密文摘要不一致');
    expect(tampered.archive.put).not.toHaveBeenCalled();

    const conflict = assemble();
    conflict.filings.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(conflict.context.run({ tenant, actor }, () =>
      conflict.service.prepare('prepare-archive-conflict', PERIOD_ID, 6)))
      .rejects.toThrow('个税清单归档发生并发冲突');
    expect(conflict.archive.put).toHaveBeenCalledOnce();

    const duplicate = assemble();
    duplicate.filings.create.mockRejectedValueOnce({ code: 11_000 });
    await expect(duplicate.context.run({ tenant, actor }, () =>
      duplicate.service.prepare('prepare-duplicate', PERIOD_ID, 6)))
      .rejects.toThrow('工资周期已存在个税清单');
  });

  it('归档失败时销毁内存明文，阶段记录丢失时不触发外部归档', async () => {
    const archiveFailure = assemble();
    let captured: Buffer | undefined;
    archiveFailure.archive.put.mockImplementationOnce((input: { bytes: Buffer }) => {
      captured = input.bytes;
      return Promise.reject(new Error('PAYROLL_TAX_ARCHIVE_UNAVAILABLE'));
    });
    await expect(archiveFailure.context.run({ tenant, actor }, () =>
      archiveFailure.service.prepare('prepare-archive-failure', PERIOD_ID, 6)))
      .rejects.toThrow('PAYROLL_TAX_ARCHIVE_UNAVAILABLE');
    expect(captured).toBeDefined();
    expect(captured?.every((value) => value === 0)).toBe(true);

    const missingStage = assemble();
    missingStage.filings.create.mockResolvedValueOnce([]);
    await expect(missingStage.context.run({ tenant, actor }, () =>
      missingStage.service.prepare('prepare-stage-missing', PERIOD_ID, 6)))
      .rejects.toThrow('个税申报清单不存在');
    expect(missingStage.archive.put).not.toHaveBeenCalled();
  });

  it('审批入口拒绝无权限、身份冒用和非法引用', async () => {
    const store = assemble();
    const prepared = await store.context.run({ tenant, actor }, () =>
      store.service.prepare('approve-guard-prepare', PERIOD_ID, 6));
    await expect(store.context.run({ tenant, actor }, () => store.service.approve(
      'approve-no-scope', prepared.id, 2,
      '01J8ZQK7V0A2M4N6P8R0T2W4E1', approvalToken,
    ))).rejects.toThrow('缺少个税申报审批权限');

    const serviceApprover: ActorContext = {
      ...connector, scopes: ['erp:payroll:tax:approve'],
    };
    await expect(store.context.run({ tenant, actor: serviceApprover }, () =>
      store.service.approve(
        'approve-service', prepared.id, 2,
        '01J8ZQK7V0A2M4N6P8R0T2W4E1', approvalToken,
      ))).rejects.toThrow('审批身份上下文非法');
    await expect(store.context.run({ tenant, actor: approver }, () =>
      store.service.approve(
        'approve-invalid-input', 'invalid', 0, 'invalid', approvalToken,
      ))).rejects.toThrow('审批引用非法');
  });

  it('审批职责、归档证据、版本和乐观锁任一不满足均不得批准', async () => {
    const roleConflict = assemble();
    const prepared = await roleConflict.context.run({ tenant, actor }, () =>
      roleConflict.service.prepare('approve-role-prepare', PERIOD_ID, 6));
    roleConflict.mutateFiling({ preparedBy: approver.actorId });
    await expect(roleConflict.context.run({ tenant, actor: approver }, () =>
      roleConflict.service.approve(
        'approve-role-conflict', prepared.id, 2,
        '01J8ZQK7V0A2M4N6P8R0T2W4E1', approvalToken,
      ))).rejects.toThrow('审批职责未分离');

    const missingEvidence = assemble();
    const missingPrepared = await missingEvidence.context.run({ tenant, actor }, () =>
      missingEvidence.service.prepare('approve-evidence-prepare', PERIOD_ID, 6));
    missingEvidence.mutateFiling({ objectEvidenceId: null });
    await expect(missingEvidence.context.run({ tenant, actor: approver }, () =>
      missingEvidence.service.approve(
        'approve-evidence-missing', missingPrepared.id, 2,
        '01J8ZQK7V0A2M4N6P8R0T2W4E1', approvalToken,
      ))).rejects.toThrow('未完成归档');

    const writeConflict = assemble();
    const writePrepared = await writeConflict.context.run({ tenant, actor }, () =>
      writeConflict.service.prepare('approve-write-prepare', PERIOD_ID, 6));
    writeConflict.filings.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(writeConflict.context.run({ tenant, actor: approver }, () =>
      writeConflict.service.approve(
        'approve-write-conflict', writePrepared.id, 2,
        '01J8ZQK7V0A2M4N6P8R0T2W4E1', approvalToken,
      ))).rejects.toThrow('个税申报审批发生并发冲突');
  });

  it('提交入口拒绝无权限、人员身份、非法引用及未审批生产主体', async () => {
    const store = assemble();
    await expect(store.context.run({ tenant, actor }, () =>
      store.service.submit('submit-no-scope', PERIOD_ID, 3)))
      .rejects.toThrow('缺少个税申报提交权限');
    const humanSubmitter: ActorContext = {
      ...actor, scopes: ['erp:payroll:tax:submit'],
    };
    await expect(store.context.run({ tenant, actor: humanSubmitter }, () =>
      store.service.submit('submit-human', PERIOD_ID, 3)))
      .rejects.toThrow('受信任税务连接器');
    await expect(store.context.run({ tenant, actor: connector }, () =>
      store.service.submit('submit-invalid', 'invalid', 0)))
      .rejects.toThrow('个税申报提交引用非法');

    const production = assemble({ gatewayMode: 'production' });
    const prepared = await production.context.run({ tenant, actor }, () =>
      production.service.prepare('submit-production-unapproved', PERIOD_ID, 6));
    await expect(production.context.run({ tenant, actor: connector }, () =>
      production.service.submit('submit-production-invalid-subject', prepared.id, 3)))
      .rejects.toThrow('不足以申请生产执行授权');
    expect(production.productionAuthorization.authorize).not.toHaveBeenCalled();
  });

  it('生产授权要求完整 WORM 与审批证据，已提交重放不申请新授权', async () => {
    const incomplete = assemble({ gatewayMode: 'production' });
    const incompletePrepared = await prepareAndApprove(
      incomplete, 'submit-production-incomplete',
    );
    incomplete.mutateFiling({ objectEvidenceId: null });
    await expect(incomplete.context.run({ tenant, actor: connector }, () =>
      incomplete.service.submit(
        'submit-production-incomplete-evidence', incompletePrepared.id, 3,
      ))).rejects.toThrow('审批证据不足');
    expect(incomplete.productionAuthorization.authorize).not.toHaveBeenCalled();
    expect(incomplete.gateway.submit).not.toHaveBeenCalled();

    const replay = assemble({ gatewayMode: 'production' });
    const replayPrepared = await prepareAndApprove(replay, 'submit-production-replay');
    await replay.context.run({ tenant, actor: connector }, () =>
      replay.service.submit('submit-production-first', replayPrepared.id, 3));
    replay.productionAuthorization.authorize.mockClear();
    await expect(replay.context.run({ tenant, actor: connector }, () =>
      replay.service.submit('submit-production-replay', replayPrepared.id, 3)))
      .resolves.toMatchObject({ status: 'submitted', version: 4 });
    expect(replay.productionAuthorization.authorize).not.toHaveBeenCalled();
    expect(replay.gateway.submit).toHaveBeenCalledOnce();
  });

  it('提交暂存状态、暂存写入和暂存后读取均严格失败关闭', async () => {
    const invalidState = assemble();
    const prepared = await invalidState.context.run({ tenant, actor }, () =>
      invalidState.service.prepare('submit-state-prepare', PERIOD_ID, 6));
    await expect(invalidState.context.run({ tenant, actor: connector }, () =>
      invalidState.service.submit('submit-state-invalid', prepared.id, 2)))
      .rejects.toThrow('未完成有效审批');

    const stageConflict = assemble();
    const stagePrepared = await prepareAndApprove(stageConflict, 'submit-stage-conflict');
    stageConflict.filings.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(stageConflict.context.run({ tenant, actor: connector }, () =>
      stageConflict.service.submit('submit-stage-write-conflict', stagePrepared.id, 3)))
      .rejects.toThrow('提交暂存发生并发冲突');
    expect(stageConflict.gateway.submit).not.toHaveBeenCalled();

    const staleStage = assemble();
    const stalePrepared = await prepareAndApprove(staleStage, 'submit-stage-stale');
    staleStage.filings.updateOne.mockResolvedValueOnce({ modifiedCount: 1 });
    await expect(staleStage.context.run({ tenant, actor: connector }, () =>
      staleStage.service.submit('submit-stage-stale-read', stalePrepared.id, 3)))
      .rejects.toThrow('提交暂存状态非法');
    expect(staleStage.gateway.submit).not.toHaveBeenCalled();
  });

  it('外部回执完成时拒绝终态漂移和数据库写冲突', async () => {
    const stateDrift = assemble();
    const driftPrepared = await prepareAndApprove(stateDrift, 'submit-finalize-drift');
    stateDrift.gateway.submit.mockImplementationOnce(() => {
      stateDrift.mutateFiling({ status: 'approved' });
      return Promise.resolve({
        submissionId: 'tax-submission-001', evidenceId: 'tax-submission-evidence-001',
        accepted: true, productionAuthorizationEvidenceId: null,
      });
    });
    await expect(stateDrift.context.run({ tenant, actor: connector }, () =>
      stateDrift.service.submit('submit-finalize-state-drift', driftPrepared.id, 3)))
      .rejects.toThrow('提交完成状态或版本非法');

    const writeConflict = assemble();
    const writePrepared = await prepareAndApprove(writeConflict, 'submit-finalize-write');
    let submissionWrite = 0;
    writeConflict.filings.updateOne.mockImplementation((
      _filter: unknown, update: { $set: Readonly<Record<string, unknown>> },
    ) => {
      submissionWrite += 1;
      if (submissionWrite === 1) {
        writeConflict.mutateFiling(update.$set);
        return Promise.resolve({ modifiedCount: 1 });
      }
      return Promise.resolve({ modifiedCount: 0 });
    });
    await expect(writeConflict.context.run({ tenant, actor: connector }, () =>
      writeConflict.service.submit('submit-finalize-write-conflict', writePrepared.id, 3)))
      .rejects.toThrow('个税申报提交发生并发冲突');
  });

  it('已提交清单和完全一致的外部回执均幂等收敛且不重复终态写入', async () => {
    const submitted = assemble();
    const prepared = await prepareAndApprove(submitted, 'submit-idempotent');
    const first = await submitted.context.run({ tenant, actor: connector }, () =>
      submitted.service.submit('submit-idempotent-first', prepared.id, 3));
    const replay = await submitted.context.run({ tenant, actor: connector }, () =>
      submitted.service.submit('submit-idempotent-replay', prepared.id, 3));
    expect(replay).toEqual(first);
    expect(submitted.gateway.submit).toHaveBeenCalledOnce();

    const finalizedExternally = assemble();
    const externalPrepared = await prepareAndApprove(
      finalizedExternally, 'submit-external-finalized',
    );
    finalizedExternally.gateway.submit.mockImplementationOnce(() => {
      finalizedExternally.mutateFiling({
        status: 'submitted', version: 4,
        taxSubmissionId: 'tax-submission-001',
        taxSubmissionEvidenceId: 'tax-submission-evidence-001',
      });
      return Promise.resolve({
        submissionId: 'tax-submission-001', evidenceId: 'tax-submission-evidence-001',
        accepted: true, productionAuthorizationEvidenceId: null,
      });
    });
    await expect(finalizedExternally.context.run({ tenant, actor: connector }, () =>
      finalizedExternally.service.submit(
        'submit-external-finalized-replay', externalPrepared.id, 3,
      ))).resolves.toMatchObject({ status: 'submitted', version: 4 });
  });

  it('迁移依赖、输入模式和历史时间不可信时在查询前拒绝', async () => {
    const missingDependencies = assemble({ omitMigrationDependencies: true });
    await expect(runMigration(
      missingDependencies, 'migration-dependencies-missing',
    )).rejects.toThrow('工资税务迁移依赖未装配');

    const invalidInput = assemble();
    await expect(runMigration(invalidInput, 'migration-input-extra', {
      ...migrationInput(), unexpected: true,
    } as ImportPayrollTaxFilingFromMigrationInput)).rejects.toThrow('迁移控制信息非法');
    await expect(runMigration(
      invalidInput, 'migration-time-invalid', migrationInput({ submittedAt: 'not-a-time' }),
    )).rejects.toThrow('迁移时间必须为历史 UTC');
    await expect(runMigration(invalidInput, 'migration-time-future', migrationInput({
      submittedAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    }))).rejects.toThrow('迁移时间必须为历史 UTC');
  });

  it('迁移身份、审批证据、状态时间线和来源控制量必须完全一致', async () => {
    const identityMissing = assemble();
    identityMissing.profiles.findActorIdByEmployee.mockResolvedValue(null as never);
    await expect(runMigration(
      identityMissing, 'migration-identity-missing',
    )).rejects.toThrow('未绑定可信身份');

    const approvalMismatch = assemble();
    await expect(runMigration(approvalMismatch, 'migration-approval-mismatch', migrationInput({
      approvalEvidenceChecksum: 'b'.repeat(43),
    }))).rejects.toThrow('审批历史证据摘要不一致');

    const stateInvalid = assemble();
    const period = stateInvalid.period();
    if (period === null) throw new Error('测试周期缺失');
    period.status = 'calculated';
    await expect(runMigration(
      stateInvalid, 'migration-state-invalid',
    )).rejects.toThrow('工资状态、职责分离或时间线非法');

    const timelineInvalid = assemble();
    timelineInvalid.approvals.verifyPayrollMigrationReference.mockResolvedValue({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4H1',
      templateCode: 'payroll_tax_filing_approval',
      completedAt: '2026-07-05T00:00:00.000Z', evidenceChecksum: 'a'.repeat(43),
    });
    await expect(runMigration(
      timelineInvalid, 'migration-timeline-invalid',
    )).rejects.toThrow('工资状态、职责分离或时间线非法');

    const controlsIncomplete = assemble();
    const incompletePeriod = controlsIncomplete.period();
    if (incompletePeriod === null) throw new Error('测试周期缺失');
    incompletePeriod.employeeCount = null;
    await expect(runMigration(
      controlsIncomplete, 'migration-controls-incomplete',
    )).rejects.toThrow('周期缺少税务清单所需控制量');

    const controlsMismatch = assemble();
    await expect(runMigration(controlsMismatch, 'migration-controls-mismatch', migrationInput({
      expectedTotalWithholdingTaxMinor: 10_501,
    }))).rejects.toThrow('来源控制总量不一致');
  });

  it('迁移重放缺失或任一不可变字段漂移均拒绝覆盖', async () => {
    const missing = assemble();
    await expect(runMigration(missing, 'migration-replay-missing', migrationInput({
      targetId: '01J8ZQK7V0A2M4N6P8R0T2W4T1',
    }))).rejects.toThrow('禁止覆盖');

    const drift = assemble();
    const imported = await runMigration(drift, 'migration-replay-create');
    drift.mutateFiling({ taxSubmissionId: 'changed-submission' });
    await expect(runMigration(drift, 'migration-replay-drift', migrationInput({
      targetId: imported.id,
    }))).rejects.toThrow('禁止覆盖');
  });
});
