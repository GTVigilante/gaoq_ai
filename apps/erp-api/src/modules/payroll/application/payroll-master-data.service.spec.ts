import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { PayrollCompensationProfileDocument, PayrollRulePackDocument } from '../persistence/payroll.schemas.js';
import {
  PayrollMasterDataService,
  type ImportPayrollCompensationFromMigrationInput,
  type ImportPayrollRulePackFromMigrationInput,
} from './payroll-master-data.service.js';
import type {
  AttestCompensationProfileDto,
  AttestPayrollRulePackDto,
} from './payroll.dto.js';

const session = {} as ClientSession;
const tenant = { tenantId: 'tenant-001', source: 'service_identity' as const };

function actor(): ActorContext {
  return {
    actorType: 'service', actorId: 'migration-service', tenantId: tenant.tenantId,
    roleCodes: ['migration'], scopes: ['erp:migration:execute', 'erp:payroll:migration:write'],
    departmentIds: [], traceId: 'trace-payroll-migration-001',
  };
}

function actorWith(
  scopes: readonly string[],
  actorType: ActorContext['actorType'] = 'service',
): ActorContext {
  return {
    ...actor(),
    actorType,
    scopes: [...scopes],
  };
}

function profileData() {
  return {
    currency: 'CNY' as const,
    jurisdictionCode: 'CN-SH',
    taxableEarnings: [{ code: 'BASE', amountMinor: 1_000_000 }],
    nonTaxableEarnings: [] as { code: string; amountMinor: number }[],
    employeeSocialInsuranceMinor: 80_000,
    employeeHousingFundMinor: 70_000,
    specialAdditionalDeductionMinor: 20_000,
    otherPreTaxWithholdingMinor: 0,
    postTaxDeductionMinor: 0,
    attendanceAdjustment: {
      overtimePayMinorPerMinute: 100,
      absenceDeductionMinorPerMinute: 100,
      unpaidLeaveDeductionMinorPerMinute: 100,
    },
  };
}

function compensationMigrationInput(
  overrides: Partial<ImportPayrollCompensationFromMigrationInput> = {},
): ImportPayrollCompensationFromMigrationInput {
  return {
    targetId: null,
    employeeId: 'employee-001',
    version: 1,
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
    approvalHistoryId: 'approval-history-001',
    approvalEvidenceChecksum: 'a'.repeat(43),
    data: profileData(),
    createdAt: '2026-01-02T00:00:00.000Z',
    migrationEvidenceRef:
      'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/compensation-001',
    evidenceChecksum: 'c'.repeat(43),
    ...overrides,
  };
}

function ruleMigrationInput(
  overrides: Partial<ImportPayrollRulePackFromMigrationInput> = {},
): ImportPayrollRulePackFromMigrationInput {
  return {
    targetId: null,
    code: 'CN_IIT',
    jurisdictionCode: 'CN',
    version: 1,
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
    monthlyBasicDeductionMinor: 500_000,
    taxBrackets: [{ upperBoundMinor: null, rateBps: 300, quickDeductionMinor: 0 }],
    sourceDigest: 's'.repeat(43),
    sourceReference: 'tax-law-2026',
    approvalHistoryId: 'approval-history-rule-001',
    approvalEvidenceChecksum: 'r'.repeat(43),
    createdAt: '2026-01-02T00:00:00.000Z',
    migrationEvidenceRef:
      'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/rule-001',
    evidenceChecksum: 'w'.repeat(43),
    ...overrides,
  };
}

function compensationAttestation(
  overrides: Partial<AttestCompensationProfileDto> = {},
): AttestCompensationProfileDto {
  const data = profileData();
  return {
    employeeId: 'employee-001',
    jurisdictionCode: data.jurisdictionCode,
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
    approvalEvidenceId: 'approval-evidence-001',
    taxableEarnings: data.taxableEarnings,
    nonTaxableEarnings: data.nonTaxableEarnings,
    employeeSocialInsuranceMinor: data.employeeSocialInsuranceMinor,
    employeeHousingFundMinor: data.employeeHousingFundMinor,
    specialAdditionalDeductionMinor: data.specialAdditionalDeductionMinor,
    otherPreTaxWithholdingMinor: data.otherPreTaxWithholdingMinor,
    postTaxDeductionMinor: data.postTaxDeductionMinor,
    attendanceAdjustment: data.attendanceAdjustment,
    ...overrides,
  };
}

function ruleAttestation(
  overrides: Partial<AttestPayrollRulePackDto> = {},
): AttestPayrollRulePackDto {
  return {
    code: 'CN_IIT',
    jurisdictionCode: 'CN',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
    monthlyBasicDeductionMinor: 500_000,
    taxBrackets: [{ upperBoundMinor: null, rateBps: 300, quickDeductionMinor: 0 }],
    sourceDigest: 's'.repeat(43),
    sourceReference: 'tax-law-2026',
    approvalEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
    ...overrides,
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
  const boundary = { assertLegacy: vi.fn() };
  const service = new PayrollMasterDataService(
    idempotency as never, context, boundary as never,
    employees as never, approvals as never,
    crypto as never, outbox as never,
    profiles as unknown as Model<PayrollCompensationProfileDocument>,
    rulePacks as unknown as Model<PayrollRulePackDocument>,
  );
  return {
    context,
    service,
    idempotency,
    employees,
    approvals,
    crypto,
    outbox,
    profiles,
    rulePacks,
    boundary,
  };
}

describe('PayrollMasterDataService migration', () => {
  it('external 模式覆盖薪酬与规则的迁移和在线证明入口', async () => {
    const failure = new Error('PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM');
    const cases: readonly [
      ActorContext,
      (store: ReturnType<typeof assemble>) => Promise<unknown>,
    ][] = [
      [actor(), (store) =>
        store.service.importCompensationFromMigration(
          'boundary-compensation-migration',
          {} as never,
        )],
      [actor(), (store) =>
        store.service.importRulePackFromMigration('boundary-rule-migration', {} as never)],
      [actorWith(['erp:payroll:compensation:attest']), (store) =>
        store.service.attestCompensation(
          'boundary-compensation-attest',
          {} as never,
        )],
      [actorWith(['erp:payroll:rule:attest']), (store) =>
        store.service.attestRulePack('boundary-rule-attest', {} as never)],
    ];
    for (const [principal, execute] of cases) {
      const store = assemble();
      store.boundary.assertLegacy.mockImplementation(() => { throw failure; });
      await expect(store.context.run({ tenant, actor: principal }, () => execute(store)))
        .rejects.toBe(failure);
      expect(store.idempotency.execute).not.toHaveBeenCalled();
      expect(store.employees.findById).not.toHaveBeenCalled();
      expect(store.approvals.verifyPayrollMigrationReference).not.toHaveBeenCalled();
      expect(store.crypto.protect).not.toHaveBeenCalled();
    }

    const unauthorized = assemble();
    await expect(unauthorized.context.run({
      tenant, actor: actorWith([]),
    }, () => unauthorized.service.attestCompensation(
      'boundary-unauthorized',
      compensationAttestation(),
    ))).rejects.toMatchObject({ response: { code: 'AUTH_SCOPE_DENIED' } });
    expect(unauthorized.boundary.assertLegacy).not.toHaveBeenCalled();
  });

  it('迁移薪酬档案只写密文、审批与 WORM 控制字段', async () => {
    const store = assemble();
    const data = profileData();
    const result = await store.context.run({ tenant, actor: actor() }, () =>
      store.service.importCompensationFromMigration(
        'payroll-compensation-migration-001',
        compensationMigrationInput({ data }),
      ));
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
      store.service.importRulePackFromMigration(
        'payroll-rule-migration-001',
        ruleMigrationInput(),
      ));
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

  it('迁移写入只接受同时持有双权限的服务或系统任务身份', async () => {
    const deniedActors = [
      actorWith(['erp:migration:execute', 'erp:payroll:migration:write'], 'user'),
      actorWith(['erp:payroll:migration:write']),
      actorWith(['erp:migration:execute']),
    ];
    for (const deniedActor of deniedActors) {
      const store = assemble();
      await expect(store.context.run({ tenant, actor: deniedActor }, () =>
        store.service.importCompensationFromMigration(
          'payroll-migration-denied',
          compensationMigrationInput(),
        ),
      )).rejects.toMatchObject({
        response: { code: 'PAYROLL_MIGRATION_WRITER_DENIED' },
      });
      expect(store.idempotency.execute).not.toHaveBeenCalled();
    }

    const systemJob = assemble();
    await expect(systemJob.context.run({
      tenant,
      actor: actorWith(
        ['erp:migration:execute', 'erp:payroll:migration:write'],
        'system_job',
      ),
    }, () => systemJob.service.importCompensationFromMigration(
      'payroll-migration-system-job',
      compensationMigrationInput(),
    ))).resolves.toMatchObject({ employeeId: 'employee-001' });
  });

  it('普通主数据登记强制专用 scope 与服务身份', async () => {
    const missingScope = assemble();
    await expect(missingScope.context.run({
      tenant,
      actor: actorWith([]),
    }, () => missingScope.service.attestCompensation(
      'payroll-compensation-scope-denied',
      compensationAttestation(),
    ))).rejects.toMatchObject({ response: { code: 'AUTH_SCOPE_DENIED' } });

    const user = assemble();
    await expect(user.context.run({
      tenant,
      actor: actorWith(['erp:payroll:compensation:attest'], 'user'),
    }, () => user.service.attestCompensation(
      'payroll-compensation-user-denied',
      compensationAttestation(),
    ))).rejects.toMatchObject({
      response: { code: 'PAYROLL_MASTER_DATA_SERVICE_REQUIRED' },
    });
    expect(user.idempotency.execute).not.toHaveBeenCalled();
  });

  it('生效区间拒绝格式错误、非法日历日和结束早于开始', async () => {
    for (const [effectiveFrom, effectiveTo] of [
      ['2026/01/01', '2026-12-31'],
      ['2026-02-30', '2026-12-31'],
      ['2026-01-02', '2026-01-01'],
      ['2026-01-01', 'not-a-date'],
    ] as const) {
      const store = assemble();
      await expect(store.context.run({ tenant, actor: actor() }, () =>
        store.service.importCompensationFromMigration(
          'payroll-interval-invalid',
          compensationMigrationInput({ effectiveFrom, effectiveTo }),
        ),
      )).rejects.toMatchObject({
        response: { code: 'PAYROLL_EFFECTIVE_INTERVAL_INVALID' },
      });
      expect(store.idempotency.execute).not.toHaveBeenCalled();
    }
  });

  it('迁移证据封套逐字段失败关闭', async () => {
    const invalidInputs: Partial<ImportPayrollCompensationFromMigrationInput>[] = [
      { version: 0 },
      { version: 10_001 },
      { version: 1.5 },
      { approvalHistoryId: 'bad value' },
      { approvalEvidenceChecksum: 'short' },
      { migrationEvidenceRef: 'attachment-001' },
      { evidenceChecksum: 'short' },
    ];
    for (const invalid of invalidInputs) {
      const store = assemble();
      await expect(store.context.run({ tenant, actor: actor() }, () =>
        store.service.importCompensationFromMigration(
          'payroll-envelope-invalid',
          compensationMigrationInput(invalid),
        ),
      )).rejects.toMatchObject({
        response: { code: 'PAYROLL_MIGRATION_ENVELOPE_INVALID' },
      });
      expect(store.idempotency.execute).not.toHaveBeenCalled();
    }
  });

  it('薪酬档案拒绝非法结构、重复项目和系统保留项目', async () => {
    const invalidStructure = assemble();
    await expect(invalidStructure.context.run({ tenant, actor: actor() }, () =>
      invalidStructure.service.importCompensationFromMigration(
        'payroll-profile-invalid',
        compensationMigrationInput({
          data: {
            ...profileData(),
            taxableEarnings: [{ code: 'lowercase', amountMinor: -1 }],
          },
        }),
      ),
    )).rejects.toMatchObject({
      response: { code: 'PAYROLL_MIGRATION_COMPENSATION_DATA_INVALID' },
    });

    for (const data of [
      {
        ...profileData(),
        nonTaxableEarnings: [{ code: 'BASE', amountMinor: 1 }],
      },
      {
        ...profileData(),
        taxableEarnings: [{ code: 'ATTENDANCE_OVERTIME', amountMinor: 1 }],
      },
    ]) {
      const store = assemble();
      await expect(store.context.run({ tenant, actor: actor() }, () =>
        store.service.importCompensationFromMigration(
          'payroll-profile-component-invalid',
          compensationMigrationInput({ data }),
        ),
      )).rejects.toMatchObject({
        response: { code: 'PAYROLL_COMPONENT_CODE_DUPLICATE_OR_RESERVED' },
      });
      expect(store.idempotency.execute).not.toHaveBeenCalled();
    }
  });

  it('薪酬登记加密落库并按最新版本递增，不在事件中泄露工资项目', async () => {
    const store = assemble();
    store.profiles.findOne
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query({ version: 4 }));
    const input = compensationAttestation();
    Reflect.deleteProperty(input, 'effectiveTo');
    const result = await store.context.run({
      tenant,
      actor: actorWith(['erp:payroll:compensation:attest']),
    }, () => store.service.attestCompensation(
      'payroll-compensation-attest-001',
      input,
    ));
    expect(result).toMatchObject({
      employeeId: 'employee-001',
      version: 5,
      effectiveTo: null,
    });
    const records = store.profiles.create.mock.calls[0]?.[0] as unknown;
    expect(records).toEqual([expect.objectContaining({
      version: 5,
      dataKeyId: 'payroll-key-001',
      dataIv: 'a'.repeat(16),
      dataCiphertext: 'b'.repeat(32),
      dataAuthTag: 'c'.repeat(22),
    })]);
    expect(JSON.stringify(records)).not.toMatch(/BASE|1000000|taxableEarnings/u);
    expect(JSON.stringify(store.outbox.append.mock.calls[0]?.[0]))
      .not.toMatch(/BASE|1000000|taxableEarnings/u);
    expect(store.crypto.protect).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-001',
        resourceType: 'compensation_profile',
        version: 5,
      }),
      expect.objectContaining({ currency: 'CNY' }),
    );
  });

  it('薪酬登记拒绝非法引用、金额结构、缺失员工和重叠区间', async () => {
    const invalidReference = assemble();
    await expect(invalidReference.context.run({
      tenant,
      actor: actorWith(['erp:payroll:compensation:attest']),
    }, () => invalidReference.service.attestCompensation(
      'payroll-compensation-reference-invalid',
      compensationAttestation({ employeeId: 'bad value' }),
    ))).rejects.toMatchObject({
      response: { code: 'PAYROLL_COMPENSATION_REFERENCE_INVALID' },
    });

    const invalidData = assemble();
    await expect(invalidData.context.run({
      tenant,
      actor: actorWith(['erp:payroll:compensation:attest']),
    }, () => invalidData.service.attestCompensation(
      'payroll-compensation-data-invalid',
      compensationAttestation({ employeeSocialInsuranceMinor: -1 }),
    ))).rejects.toMatchObject({
      response: { code: 'PAYROLL_COMPENSATION_DATA_INVALID' },
    });

    const missingEmployee = assemble();
    missingEmployee.employees.findById.mockResolvedValue(null);
    await expect(missingEmployee.context.run({
      tenant,
      actor: actorWith(['erp:payroll:compensation:attest']),
    }, () => missingEmployee.service.attestCompensation(
      'payroll-compensation-employee-missing',
      compensationAttestation(),
    ))).rejects.toMatchObject({ response: { code: 'PAYROLL_EMPLOYEE_NOT_FOUND' } });

    const overlap = assemble();
    overlap.profiles.findOne.mockReturnValueOnce(query({ id: 'profile-existing' }));
    await expect(overlap.context.run({
      tenant,
      actor: actorWith(['erp:payroll:compensation:attest']),
    }, () => overlap.service.attestCompensation(
      'payroll-compensation-overlap',
      compensationAttestation(),
    ))).rejects.toMatchObject({
      response: { code: 'PAYROLL_COMPENSATION_EFFECTIVE_OVERLAP' },
    });
  });

  it('法定规则登记校验来源、区间与版本并发布最小事件', async () => {
    const store = assemble();
    store.rulePacks.findOne
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query({ version: 2 }));
    const input = ruleAttestation();
    Reflect.deleteProperty(input, 'effectiveTo');
    const result = await store.context.run({
      tenant,
      actor: actorWith(['erp:payroll:rule:attest'], 'system_job'),
    }, () => store.service.attestRulePack(
      'payroll-rule-attest-001',
      input,
    ));
    expect(result).toMatchObject({
      code: 'CN_IIT',
      jurisdictionCode: 'CN',
      version: 3,
      effectiveTo: null,
    });
    expect(store.rulePacks.create).toHaveBeenCalledWith([
      expect.objectContaining({
        code: 'CN_IIT',
        version: 3,
        roundingMode: 'HALF_UP',
        status: 'published',
      }),
    ], { session });
    const event = store.outbox.append.mock.calls[0]?.[0] as {
      readonly type: string;
      readonly data: Record<string, unknown>;
    };
    expect(event.type).toBe('payroll.rule_pack.attested');
    expect(event.data).not.toHaveProperty('taxBrackets');
  });

  it('法定规则登记拒绝非法引用、重叠区间和不可计算规则', async () => {
    for (const invalid of [
      { code: 'bad value' },
      { jurisdictionCode: 'bad value' },
      { approvalEvidenceId: 'bad value' },
      { sourceDigest: 'short' },
      { sourceReference: 'bad value' },
    ]) {
      const store = assemble();
      await expect(store.context.run({
        tenant,
        actor: actorWith(['erp:payroll:rule:attest']),
      }, () => store.service.attestRulePack(
        'payroll-rule-reference-invalid',
        ruleAttestation(invalid),
      ))).rejects.toMatchObject({
        response: { code: 'PAYROLL_RULE_PACK_REFERENCE_INVALID' },
      });
    }

    const overlap = assemble();
    overlap.rulePacks.findOne.mockReturnValueOnce(query({ id: 'rule-existing' }));
    await expect(overlap.context.run({
      tenant,
      actor: actorWith(['erp:payroll:rule:attest']),
    }, () => overlap.service.attestRulePack(
      'payroll-rule-overlap',
      ruleAttestation(),
    ))).rejects.toMatchObject({
      response: { code: 'PAYROLL_RULE_PACK_EFFECTIVE_OVERLAP' },
    });

    const invalidRule = assemble();
    await expect(invalidRule.context.run({
      tenant,
      actor: actorWith(['erp:payroll:rule:attest']),
    }, () => invalidRule.service.attestRulePack(
      'payroll-rule-calculation-invalid',
      ruleAttestation({
        taxBrackets: [
          { upperBoundMinor: 100_000, rateBps: 2_000, quickDeductionMinor: 0 },
          { upperBoundMinor: 50_000, rateBps: 3_000, quickDeductionMinor: 0 },
        ],
      }),
    ))).rejects.toBeInstanceOf(Error);
    expect(invalidRule.rulePacks.create).not.toHaveBeenCalled();
  });

  it('迁移拒绝缺失员工、审批摘要漂移、审批晚于快照和非法时间', async () => {
    const missingEmployee = assemble();
    missingEmployee.employees.findById.mockResolvedValue(null);
    await expect(missingEmployee.context.run({ tenant, actor: actor() }, () =>
      missingEmployee.service.importCompensationFromMigration(
        'payroll-migration-employee-missing',
        compensationMigrationInput(),
      ),
    )).rejects.toMatchObject({
      response: { code: 'PAYROLL_MIGRATION_EMPLOYEE_NOT_FOUND' },
    });

    for (const approval of [
      {
        id: 'approval-history-001',
        completedAt: '2026-01-01T00:00:00.000Z',
        evidenceChecksum: 'm'.repeat(43),
      },
      {
        id: 'approval-history-001',
        completedAt: '2026-01-03T00:00:00.000Z',
        evidenceChecksum: 'a'.repeat(43),
      },
    ]) {
      const mismatch = assemble();
      mismatch.approvals.verifyPayrollMigrationReference.mockResolvedValue(approval);
      await expect(mismatch.context.run({ tenant, actor: actor() }, () =>
        mismatch.service.importCompensationFromMigration(
          'payroll-migration-approval-mismatch',
          compensationMigrationInput(),
        ),
      )).rejects.toMatchObject({
        response: { code: 'PAYROLL_MIGRATION_APPROVAL_MISMATCH' },
      });
    }

    for (const createdAt of [
      'not-an-instant',
      '2026-01-02T00:00:00Z',
      '2999-01-01T00:00:00.000Z',
    ]) {
      const invalidTime = assemble();
      await expect(invalidTime.context.run({ tenant, actor: actor() }, () =>
        invalidTime.service.importCompensationFromMigration(
          'payroll-migration-time-invalid',
          compensationMigrationInput({ createdAt }),
        ),
      )).rejects.toMatchObject({
        response: { code: 'PAYROLL_MIGRATION_TIME_INVALID' },
      });
    }
  });

  it('薪酬迁移新版本拒绝区间重叠或版本不连续', async () => {
    for (const [overlap, latest] of [
      [{ id: 'profile-existing' }, null],
      [null, { version: 3 }],
    ]) {
      const store = assemble();
      store.profiles.findOne
        .mockReturnValueOnce(query(overlap))
        .mockReturnValueOnce(query(latest));
      await expect(store.context.run({ tenant, actor: actor() }, () =>
        store.service.importCompensationFromMigration(
          'payroll-migration-profile-chain-invalid',
          compensationMigrationInput({ version: 2 }),
        ),
      )).rejects.toMatchObject({
        response: { code: 'PAYROLL_MIGRATION_COMPENSATION_CHAIN_INVALID' },
      });
      expect(store.profiles.create).not.toHaveBeenCalled();
    }
  });

  it('规则迁移拒绝非法来源、审批漂移、区间重叠或版本不连续', async () => {
    for (const invalid of [
      { code: 'bad value' },
      { jurisdictionCode: 'bad value' },
      { sourceDigest: 'short' },
      { sourceReference: 'bad value' },
    ]) {
      const store = assemble();
      await expect(store.context.run({ tenant, actor: actor() }, () =>
        store.service.importRulePackFromMigration(
          'payroll-migration-rule-reference-invalid',
          ruleMigrationInput(invalid),
        ),
      )).rejects.toMatchObject({
        response: { code: 'PAYROLL_MIGRATION_RULE_REFERENCE_INVALID' },
      });
    }

    for (const approval of [
      {
        id: 'approval-history-rule-001',
        completedAt: '2026-01-01T00:00:00.000Z',
        evidenceChecksum: 'x'.repeat(43),
      },
      {
        id: 'approval-history-rule-001',
        completedAt: '2026-01-03T00:00:00.000Z',
        evidenceChecksum: 'r'.repeat(43),
      },
    ]) {
      const mismatch = assemble();
      mismatch.approvals.verifyPayrollMigrationReference.mockResolvedValue(approval);
      await expect(mismatch.context.run({ tenant, actor: actor() }, () =>
        mismatch.service.importRulePackFromMigration(
          'payroll-migration-rule-approval-mismatch',
          ruleMigrationInput(),
        ),
      )).rejects.toMatchObject({
        response: { code: 'PAYROLL_MIGRATION_APPROVAL_MISMATCH' },
      });
    }

    for (const [overlap, latest] of [
      [{ id: 'rule-existing' }, null],
      [null, { version: 3 }],
    ]) {
      const store = assemble();
      store.approvals.verifyPayrollMigrationReference.mockResolvedValue({
        id: 'approval-history-rule-001',
        completedAt: '2026-01-01T00:00:00.000Z',
        evidenceChecksum: 'r'.repeat(43),
      });
      store.rulePacks.findOne
        .mockReturnValueOnce(query(overlap))
        .mockReturnValueOnce(query(latest));
      await expect(store.context.run({ tenant, actor: actor() }, () =>
        store.service.importRulePackFromMigration(
          'payroll-migration-rule-chain-invalid',
          ruleMigrationInput({ version: 2 }),
        ),
      )).rejects.toMatchObject({
        response: { code: 'PAYROLL_MIGRATION_RULE_CHAIN_INVALID' },
      });
      expect(store.rulePacks.create).not.toHaveBeenCalled();
    }
  });

  it('既有薪酬迁移只接受完全一致的密文回读与 WORM 事实', async () => {
    const baseline = assemble();
    const baselineResult = await baseline.context.run({ tenant, actor: actor() }, () =>
      baseline.service.importCompensationFromMigration(
        'payroll-profile-baseline',
        compensationMigrationInput(),
      ));
    const records = baseline.profiles.create.mock.calls[0]?.[0] as unknown as [
      Record<string, unknown>,
    ];
    const record = records[0];
    const exact = assemble();
    exact.crypto.unprotect.mockReturnValue(profileData());
    exact.profiles.findOne.mockReturnValue(query(record));
    await expect(exact.context.run({ tenant, actor: actor() }, () =>
      exact.service.importCompensationFromMigration(
        'payroll-profile-existing-exact',
        compensationMigrationInput({ targetId: baselineResult.id }),
      ),
    )).resolves.toEqual(baselineResult);
    expect(exact.crypto.unprotect).toHaveBeenCalledOnce();
    expect(exact.profiles.create).not.toHaveBeenCalled();

    const mutations: Record<string, unknown>[] = [
      { employeeId: 'employee-other' },
      { version: 2 },
      { effectiveFrom: '2026-02-01' },
      { effectiveTo: null },
      { approvalEvidenceId: 'approval-other' },
      { profileHash: 'z'.repeat(43) },
      { createdAt: new Date('2026-01-03T00:00:00.000Z') },
      { migrationEvidenceRef: 'other-ref' },
      { migrationEvidenceChecksum: 'z'.repeat(43) },
    ];
    for (const mutation of mutations) {
      const conflict = assemble();
      conflict.crypto.unprotect.mockReturnValue(profileData());
      conflict.profiles.findOne.mockReturnValue(query({ ...record, ...mutation }));
      await expect(conflict.context.run({ tenant, actor: actor() }, () =>
        conflict.service.importCompensationFromMigration(
          'payroll-profile-existing-conflict',
          compensationMigrationInput({ targetId: baselineResult.id }),
        ),
      )).rejects.toMatchObject({
        response: { code: 'PAYROLL_MIGRATION_COMPENSATION_IMMUTABLE' },
      });
    }

    const ciphertextConflict = assemble();
    ciphertextConflict.crypto.unprotect.mockReturnValue({
      ...profileData(),
      taxableEarnings: [{ code: 'BASE', amountMinor: 999 }],
    });
    ciphertextConflict.profiles.findOne.mockReturnValue(query(record));
    await expect(ciphertextConflict.context.run({ tenant, actor: actor() }, () =>
      ciphertextConflict.service.importCompensationFromMigration(
        'payroll-profile-existing-cipher-conflict',
        compensationMigrationInput({ targetId: baselineResult.id }),
      ),
    )).rejects.toMatchObject({
      response: { code: 'PAYROLL_MIGRATION_COMPENSATION_IMMUTABLE' },
    });
  });

  it('既有规则迁移只接受完全一致的法定来源、审批与 WORM 事实', async () => {
    const baseline = assemble();
    baseline.approvals.verifyPayrollMigrationReference.mockResolvedValue({
      id: 'approval-history-rule-001',
      completedAt: '2026-01-01T00:00:00.000Z',
      evidenceChecksum: 'r'.repeat(43),
    });
    const baselineResult = await baseline.context.run({ tenant, actor: actor() }, () =>
      baseline.service.importRulePackFromMigration(
        'payroll-rule-baseline',
        ruleMigrationInput(),
      ));
    const records = baseline.rulePacks.create.mock.calls[0]?.[0] as unknown as [
      Record<string, unknown>,
    ];
    const record = records[0];
    const exact = assemble();
    exact.approvals.verifyPayrollMigrationReference.mockResolvedValue({
      id: 'approval-history-rule-001',
      completedAt: '2026-01-01T00:00:00.000Z',
      evidenceChecksum: 'r'.repeat(43),
    });
    exact.rulePacks.findOne.mockReturnValue(query(record));
    await expect(exact.context.run({ tenant, actor: actor() }, () =>
      exact.service.importRulePackFromMigration(
        'payroll-rule-existing-exact',
        ruleMigrationInput({ targetId: baselineResult.id }),
      ),
    )).resolves.toEqual(baselineResult);
    expect(exact.rulePacks.create).not.toHaveBeenCalled();

    const mutations: Record<string, unknown>[] = [
      { code: 'CN_IIT_OTHER' },
      { jurisdictionCode: 'CN_OTHER' },
      { version: 2 },
      { effectiveFrom: '2026-02-01' },
      { effectiveTo: null },
      { monthlyBasicDeductionMinor: 600_000 },
      { roundingMode: 'DOWN' },
      { taxBrackets: [{ upperBoundMinor: null, rateBps: 400, quickDeductionMinor: 0 }] },
      { rulesHash: 'z'.repeat(43) },
      { sourceDigest: 'z'.repeat(43) },
      { sourceReference: 'tax-law-other' },
      { approvalEvidenceId: 'approval-other' },
      { createdAt: new Date('2026-01-03T00:00:00.000Z') },
      { migrationEvidenceRef: 'other-ref' },
      { migrationEvidenceChecksum: 'z'.repeat(43) },
    ];
    for (const mutation of mutations) {
      const conflict = assemble();
      conflict.approvals.verifyPayrollMigrationReference.mockResolvedValue({
        id: 'approval-history-rule-001',
        completedAt: '2026-01-01T00:00:00.000Z',
        evidenceChecksum: 'r'.repeat(43),
      });
      conflict.rulePacks.findOne.mockReturnValue(query({ ...record, ...mutation }));
      await expect(conflict.context.run({ tenant, actor: actor() }, () =>
        conflict.service.importRulePackFromMigration(
          'payroll-rule-existing-conflict',
          ruleMigrationInput({ targetId: baselineResult.id }),
        ),
      )).rejects.toMatchObject({
        response: { code: 'PAYROLL_MIGRATION_RULE_IMMUTABLE' },
      });
    }
  });

  it('唯一键竞争映射稳定冲突，未知存储异常原样传播', async () => {
    const duplicate = assemble();
    duplicate.profiles.create.mockRejectedValue({ code: 11_000 });
    await expect(duplicate.context.run({
      tenant,
      actor: actorWith(['erp:payroll:compensation:attest']),
    }, () => duplicate.service.attestCompensation(
      'payroll-profile-duplicate',
      compensationAttestation(),
    ))).rejects.toMatchObject({
      response: { code: 'PAYROLL_MASTER_DATA_VERSION_CONFLICT' },
    });

    for (const error of [new Error('MONGO_UNAVAILABLE'), null, { code: 42 }]) {
      const failed = assemble();
      failed.profiles.create.mockRejectedValue(error);
      await expect(failed.context.run({
        tenant,
        actor: actorWith(['erp:payroll:compensation:attest']),
      }, () => failed.service.attestCompensation(
        'payroll-profile-storage-failed',
        compensationAttestation(),
      ))).rejects.toBe(error);
    }
  });
});
