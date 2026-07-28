import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { OrgPersonBirthdayBlindIndexService } from '../persistence/org-person-birthday-blind-index.service.js';
import type {
  EmployeeRepository,
  EmploymentRepository,
  PersonRepository,
} from '../persistence/org.repositories.js';
import { OrgCareOccasionSourceService } from './org-care-occasion-source.service.js';

const TENANT_ID = 'tenant-001';
const EMPLOYEE_ID = 'employee-001';
const PERSON_ID = 'person-001';

const EMPLOYEE = Object.freeze({
  id: EMPLOYEE_ID,
  tenantId: TENANT_ID,
  employeeNo: 'E001',
  displayName: '测试员工',
  status: 'active',
  departmentIds: Object.freeze(['department-001']),
  primaryDepartmentId: 'department-001',
  positionIds: Object.freeze([]),
  jobLevelId: null,
  version: 1,
  createdAt: '2025-03-01T00:00:00.000Z',
  updatedAt: '2025-03-01T00:00:00.000Z',
});

const CURRENT = Object.freeze({
  id: 'employment-002',
  tenantId: TENANT_ID,
  employeeId: EMPLOYEE_ID,
  personId: PERSON_ID,
  onboardingInstanceId: 'onboarding-002',
  onboardingCompletionEvidenceId: 'completion-002',
  offerId: 'offer-002',
  signedEvidenceId: 'signed-002',
  terminationCareCaseId: null,
  terminationExecutionEvidenceId: null,
  terminationEvidenceId: null,
  status: 'active',
  effectiveFrom: '2025-03-01',
  effectiveTo: null,
  version: 2,
  createdAt: '2025-03-01T00:00:00.000Z',
  updatedAt: '2025-03-01T00:00:00.000Z',
});

const HISTORY = Object.freeze({
  ...CURRENT,
  id: 'employment-001',
  employeeId: 'employee-legacy',
  onboardingInstanceId: 'onboarding-001',
  onboardingCompletionEvidenceId: 'completion-001',
  offerId: 'offer-001',
  signedEvidenceId: 'signed-001',
  terminationCareCaseId: 'care-case-001',
  terminationExecutionEvidenceId: 'execution-001',
  terminationEvidenceId: 'termination-001',
  status: 'resigned',
  effectiveFrom: '2020-02-29',
  effectiveTo: '2022-02-28',
});

const PERSON = Object.freeze({
  id: PERSON_ID,
  tenantId: TENANT_ID,
  sourceCandidateId: 'candidate-001',
  identityEvidenceId: 'identity-evidence-001',
  birthdayEvidenceId: 'birthday-evidence-001',
  birthdayAttestedAt: '2026-07-27T00:00:00.000Z',
  status: 'active',
  version: 2,
  createdAt: '2025-03-01T00:00:00.000Z',
  updatedAt: '2026-07-27T00:00:00.000Z',
});

interface FixtureOptions {
  readonly employee?: unknown;
  readonly current?: unknown;
  readonly histories?: readonly unknown[];
  readonly projection?: unknown;
  readonly resolvedMonthDay?: string | null;
}

function fixture(options: FixtureOptions = {}) {
  const context = new TenantContextService();
  const employees = {
    findById: vi.fn().mockResolvedValue(
      Object.hasOwn(options, 'employee') ? options.employee : EMPLOYEE,
    ),
  };
  const employments = {
    findOpenByEmployeeId: vi.fn().mockResolvedValue(
      Object.hasOwn(options, 'current') ? options.current : CURRENT,
    ),
    findByPersonId: vi.fn().mockResolvedValue(
      options.histories ?? [CURRENT, HISTORY],
    ),
  };
  const persons = {
    findBirthdayProjectionById: vi.fn().mockResolvedValue(
      Object.hasOwn(options, 'projection')
        ? options.projection
        : {
            person: PERSON,
            birthdayBlindIndexes: ['birthday-active.fingerprint'],
          },
    ),
  };
  const birthdayBlindIndex = {
    resolveMonthDay: vi.fn().mockReturnValue(
      Object.hasOwn(options, 'resolvedMonthDay')
        ? options.resolvedMonthDay
        : '02-29',
    ),
  };
  return {
    context,
    employees,
    employments,
    persons,
    birthdayBlindIndex,
    service: new OrgCareOccasionSourceService(
      context,
      employees as unknown as EmployeeRepository,
      employments as unknown as EmploymentRepository,
      persons as unknown as PersonRepository,
      birthdayBlindIndex as unknown as OrgPersonBirthdayBlindIndexService,
    ),
  };
}

describe('OrgCareOccasionSourceService', () => {
  it('只从闭合的 Employee、当前 Employment、Person 证明和复聘历史形成窄投影', async () => {
    const store = fixture();
    const result = await runSource(store.context, () =>
      store.service.getEligibleByEmployeeId(EMPLOYEE_ID),
    );
    expect(result).toMatchObject({
      personId: PERSON_ID,
      employeeId: EMPLOYEE_ID,
      currentEmploymentId: CURRENT.id,
      birthdayMonthDay: '02-29',
      employmentEffectiveFromDates: ['2020-02-29', '2025-03-01'],
      currentEmploymentEffectiveFrom: '2025-03-01',
    });
    expect(result?.birthdaySourceRevision).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(result)).not.toMatch(
      /evidence|fingerprint|candidate|onboarding|offer/iu,
    );
    expect(store.employments.findByPersonId).toHaveBeenCalledWith(PERSON_ID);
  });

  it('未登记生日时仍可提供周年来源，但不解析或生成生日修订', async () => {
    const store = fixture({
      projection: {
        person: {
          ...PERSON,
          birthdayEvidenceId: null,
          birthdayAttestedAt: null,
        },
        birthdayBlindIndexes: [],
      },
    });
    await expect(runSource(store.context, () =>
      store.service.getEligibleByEmployeeId(EMPLOYEE_ID),
    )).resolves.toMatchObject({
      birthdayMonthDay: null,
      birthdaySourceRevision: null,
    });
    expect(store.birthdayBlindIndex.resolveMonthDay).not.toHaveBeenCalled();
  });

  it.each([
    ['员工不存在', { employee: null }],
    ['员工停职', { employee: { ...EMPLOYEE, status: 'suspended' } }],
    ['员工离职', { employee: { ...EMPLOYEE, status: 'terminated' } }],
    ['当前劳动关系不存在', { current: null }],
    ['当前劳动关系停职', { current: { ...CURRENT, status: 'suspended' } }],
  ])('%s 时返回不具备关怀资格且停止读取后续敏感来源', async (_label, options) => {
    const store = fixture(options);
    await expect(runSource(store.context, () =>
      store.service.getEligibleByEmployeeId(EMPLOYEE_ID),
    )).resolves.toBeNull();
    if (_label.startsWith('员工')) {
      expect(store.employments.findOpenByEmployeeId).not.toHaveBeenCalled();
    } else {
      expect(store.persons.findBirthdayProjectionById).not.toHaveBeenCalled();
    }
    expect(store.birthdayBlindIndex.resolveMonthDay).not.toHaveBeenCalled();
  });

  it.each([
    ['员工跨租户', { employee: { ...EMPLOYEE, tenantId: 'tenant-other' } }],
    ['员工标识错位', { employee: { ...EMPLOYEE, id: 'employee-other' } }],
    ['员工状态损坏', { employee: { ...EMPLOYEE, status: 'unknown' } }],
    ['当前劳动关系跨租户', { current: { ...CURRENT, tenantId: 'tenant-other' } }],
    ['当前劳动关系员工错位', { current: { ...CURRENT, employeeId: 'employee-other' } }],
    ['当前劳动关系状态损坏', { current: { ...CURRENT, status: 'unknown' } }],
    ['开放查询返回已结束关系', {
      current: { ...CURRENT, status: 'resigned', effectiveTo: '2026-01-01' },
    }],
    ['开放查询返回结束日期', { current: { ...CURRENT, effectiveTo: '2026-01-01' } }],
  ])('%s 时失败关闭且不解析生日', async (_label, options) => {
    const store = fixture(options);
    await expect(runSource(store.context, () =>
      store.service.getEligibleByEmployeeId(EMPLOYEE_ID),
    )).rejects.toMatchObject({
      response: { code: 'ORG_CARE_OCCASION_SOURCE_REFERENCE_INVALID' },
    });
    expect(store.birthdayBlindIndex.resolveMonthDay).not.toHaveBeenCalled();
  });

  it.each([
    ['Person 缺失', null],
    ['Person 跨租户', {
      person: { ...PERSON, tenantId: 'tenant-other' },
      birthdayBlindIndexes: ['birthday-active.fingerprint'],
    }],
    ['Person 标识错位', {
      person: { ...PERSON, id: 'person-other' },
      birthdayBlindIndexes: ['birthday-active.fingerprint'],
    }],
    ['Person 状态损坏', {
      person: { ...PERSON, status: 'inactive' },
      birthdayBlindIndexes: ['birthday-active.fingerprint'],
    }],
  ])('%s 时按损坏引用失败关闭', async (_label, projection) => {
    const store = fixture({ projection });
    await expect(runSource(store.context, () =>
      store.service.getEligibleByEmployeeId(EMPLOYEE_ID),
    )).rejects.toMatchObject({
      response: { code: 'ORG_CARE_OCCASION_SOURCE_REFERENCE_INVALID' },
    });
  });

  it.each([
    ['历史为空', []],
    ['历史缺少当前关系', [HISTORY]],
    ['历史标识重复', [CURRENT, CURRENT]],
    ['历史包含第二个开放关系', [
      CURRENT,
      { ...HISTORY, id: 'employment-003', status: 'active', effectiveTo: null },
    ]],
    ['历史跨租户', [CURRENT, { ...HISTORY, tenantId: 'tenant-other' }]],
    ['历史 Person 错位', [CURRENT, { ...HISTORY, personId: 'person-other' }]],
    ['历史状态损坏', [CURRENT, { ...HISTORY, status: 'unknown' }]],
    ['历史生效日非法', [CURRENT, { ...HISTORY, effectiveFrom: '2020-02-30' }]],
    ['历史结束日非法', [CURRENT, { ...HISTORY, effectiveTo: '2022-02-30' }]],
    ['历史结束早于生效', [CURRENT, {
      ...HISTORY,
      effectiveFrom: '2022-03-01',
      effectiveTo: '2022-02-28',
    }]],
    ['离职历史没有结束日', [CURRENT, { ...HISTORY, effectiveTo: null }]],
    ['非离职历史夹带结束日', [CURRENT, { ...HISTORY, status: 'active' }]],
    ['当前历史员工错位', [{ ...CURRENT, employeeId: 'employee-other' }, HISTORY]],
    ['当前历史状态漂移', [{ ...CURRENT, status: 'probation' }, HISTORY]],
    ['当前历史生效日漂移', [{ ...CURRENT, effectiveFrom: '2025-03-02' }, HISTORY]],
  ])('%s 时拒绝形成周年来源', async (_label, histories) => {
    const store = fixture({ histories });
    await expect(runSource(store.context, () =>
      store.service.getEligibleByEmployeeId(EMPLOYEE_ID),
    )).rejects.toMatchObject({
      response: { code: 'ORG_CARE_OCCASION_SOURCE_REFERENCE_INVALID' },
    });
  });

  it.each([
    ['证明缺少登记时间', {
      person: { ...PERSON, birthdayAttestedAt: null },
      birthdayBlindIndexes: ['birthday-active.fingerprint'],
    }],
    ['证明登记时间不规范', {
      person: { ...PERSON, birthdayAttestedAt: '2026-07-27T08:00:00+08:00' },
      birthdayBlindIndexes: ['birthday-active.fingerprint'],
    }],
    ['证明缺少盲索引', {
      person: PERSON,
      birthdayBlindIndexes: [],
    }],
    ['未证明却夹带盲索引', {
      person: {
        ...PERSON,
        birthdayEvidenceId: null,
        birthdayAttestedAt: null,
      },
      birthdayBlindIndexes: ['birthday-active.fingerprint'],
    }],
    ['盲索引重复', {
      person: PERSON,
      birthdayBlindIndexes: [
        'birthday-active.fingerprint',
        'birthday-active.fingerprint',
      ],
    }],
    ['盲索引数量超限', {
      person: PERSON,
      birthdayBlindIndexes: Array.from(
        { length: 6 },
        (_, index) => `birthday-${index}.fingerprint`,
      ),
    }],
  ])('%s 时拒绝解析生日月日', async (_label, projection) => {
    const store = fixture({ projection });
    await expect(runSource(store.context, () =>
      store.service.getEligibleByEmployeeId(EMPLOYEE_ID),
    )).rejects.toMatchObject({
      response: { code: 'ORG_CARE_OCCASION_SOURCE_REFERENCE_INVALID' },
    });
    expect(store.birthdayBlindIndex.resolveMonthDay).not.toHaveBeenCalled();
  });

  it('证明盲索引无法由当前密钥环解析时失败关闭', async () => {
    const store = fixture({ resolvedMonthDay: null });
    await expect(runSource(store.context, () =>
      store.service.getEligibleByEmployeeId(EMPLOYEE_ID),
    )).rejects.toMatchObject({
      response: { code: 'ORG_CARE_OCCASION_SOURCE_REFERENCE_INVALID' },
    });
  });

  it.each([
    ['用户身份即使拥有内部 Scope', {
      actorType: 'user' as const,
      scopes: ['erp:care:occasion:source:read'],
    }],
    ['服务身份缺少内部 Scope', {
      actorType: 'service' as const,
      scopes: [],
    }],
  ])('%s 也不可读取生日来源', async (_label, actorPatch) => {
    const store = fixture();
    await expect(runSource(
      store.context,
      () => store.service.getEligibleByEmployeeId(EMPLOYEE_ID),
      actorPatch,
    )).rejects.toMatchObject({
      response: { code: 'ORG_CARE_OCCASION_SOURCE_DENIED' },
    });
    expect(store.employees.findById).not.toHaveBeenCalled();
  });
});

function runSource<T>(
  context: TenantContextService,
  operation: () => Promise<T>,
  actorPatch: {
    readonly actorType?: 'user' | 'service' | 'system_job';
    readonly scopes?: readonly string[];
  } = {},
): Promise<T> {
  return context.run({
    tenant: { tenantId: TENANT_ID, source: 'service_identity' },
    actor: {
      actorId: 'system:care-source',
      actorType: actorPatch.actorType ?? 'system_job',
      tenantId: TENANT_ID,
      roleCodes: ['CARE_OCCASION_SOURCE'],
      scopes: actorPatch.scopes ?? ['erp:care:occasion:source:read'],
      departmentIds: [],
      traceId: 'trace-source',
    },
  }, operation);
}
