import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  createPerson,
  OrgDomainError,
  type Person,
} from '../domain/index.js';
import type { OrgPersonBirthdayBlindIndexService } from '../persistence/org-person-birthday-blind-index.service.js';
import {
  OrgWriteConflictError,
  type PersonRepository,
} from '../persistence/org.repositories.js';
import type { OrgOutboxWriter } from '../persistence/outbox.writer.js';
import { OrgPersonBirthdayService } from './org-person-birthday.service.js';

const PERSON_ID = '01J8ZQK7V0A2M4N6P8R0T2W4A1';
const IDENTITY_EVIDENCE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4B2';
const BIRTHDAY_EVIDENCE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C3';
const OTHER_BIRTHDAY_EVIDENCE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4D4';
const INPUT = Object.freeze({
  monthDay: '02-29',
  identityEvidenceId: IDENTITY_EVIDENCE_ID,
  birthdayEvidenceId: BIRTHDAY_EVIDENCE_ID,
});

function actor(
  actorType: 'user' | 'service' | 'system_job' = 'service',
  scopes: readonly string[] = ['erp:org:person:birthday:attest'],
) {
  return {
    actorId: `${actorType}:identity-proof`,
    actorType,
    tenantId: 'tenant-001',
    roleCodes: ['IDENTITY_PROOF_SERVICE'],
    scopes,
    departmentIds: [],
    traceId: 'trace-birthday-001',
  } as const;
}

function birthdayAttestedPerson(overrides: Partial<Person> = {}): Person {
  return Object.freeze({
    ...createPerson({
      id: PERSON_ID,
      tenantId: 'tenant-001',
      sourceCandidateId: 'candidate-001',
      identityEvidenceId: IDENTITY_EVIDENCE_ID,
    }, new Date('2026-07-27T00:00:00.000Z')),
    birthdayEvidenceId: BIRTHDAY_EVIDENCE_ID,
    birthdayAttestedAt: '2026-07-27T00:01:00.000Z',
    version: 2,
    updatedAt: '2026-07-27T00:01:00.000Z',
    ...overrides,
  });
}

function fixture(person: Person | null = createPerson({
  id: PERSON_ID,
  tenantId: 'tenant-001',
  sourceCandidateId: 'candidate-001',
  identityEvidenceId: IDENTITY_EVIDENCE_ID,
}, new Date('2026-07-27T00:00:00.000Z'))) {
  const context = new TenantContextService();
  const idempotency = {
    execute: vi.fn(async (
      _operation: string,
      _key: string,
      _request: unknown,
      handler: (session: object) => Promise<unknown>,
    ) => handler({})),
  };
  const persons = {
    findById: vi.fn().mockResolvedValue(person),
    attestBirthday: vi.fn().mockResolvedValue(undefined),
  };
  const blindIndex = {
    fingerprints: vi.fn().mockReturnValue(['birthday-active.fingerprint']),
    activeFingerprint: vi.fn().mockReturnValue('birthday-active.fingerprint'),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  return {
    context,
    idempotency,
    persons,
    blindIndex,
    outbox,
    service: new OrgPersonBirthdayService(
      idempotency as unknown as IdempotencyService,
      context,
      persons as unknown as PersonRepository,
      blindIndex as unknown as OrgPersonBirthdayBlindIndexService,
      outbox as unknown as OrgOutboxWriter,
    ),
  };
}

async function run<T>(
  store: ReturnType<typeof fixture>,
  operation: () => Promise<T>,
  identity = actor(),
): Promise<T> {
  return store.context.run({
    tenant: { tenantId: 'tenant-001', source: 'service_identity' },
    actor: identity,
  }, operation);
}

describe('OrgPersonBirthdayService', () => {
  it.each(['service', 'system_job'] as const)(
    '只允许受信任 %s 身份登记并冻结最小响应',
    async (actorType) => {
      const store = fixture();
      const result = await run(
        store,
        () => store.service.attest(
          PERSON_ID,
          1,
          'birthday-attest-001',
          INPUT,
        ),
        actor(actorType),
      );

      expect(result).toEqual({
        attestation: {
          personId: PERSON_ID,
          birthdayAttested: true,
          version: 2,
        },
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.attestation)).toBe(true);
      expect(store.persons.attestBirthday).toHaveBeenCalledWith(
        expect.objectContaining({ birthdayEvidenceId: BIRTHDAY_EVIDENCE_ID }),
        ['birthday-active.fingerprint'],
        1,
        {},
      );
      expect(store.outbox.append).toHaveBeenCalledOnce();
    },
  );

  it('幂等记录、响应和事件均不含明文月日', async () => {
    const store = fixture();
    const result = await run(store, () => store.service.attest(
      PERSON_ID,
      1,
      'birthday-attest-001',
      INPUT,
    ));

    const storedRequest = store.idempotency.execute.mock.calls[0]?.[2];
    expect(JSON.stringify(storedRequest)).not.toContain('02-29');
    expect(JSON.stringify(result)).not.toContain('02-29');
    expect(JSON.stringify(store.outbox.append.mock.calls)).not.toContain('02-29');
    expect(store.blindIndex.fingerprints).toHaveBeenCalledWith('tenant-001', '02-29');
    expect(store.blindIndex.activeFingerprint).toHaveBeenCalledWith('tenant-001', '02-29');
  });

  it('相同证明按当前版本重放时不重复写 Person 或 Outbox', async () => {
    const store = fixture(birthdayAttestedPerson());
    const result = await run(store, () => store.service.attest(
      PERSON_ID,
      2,
      'birthday-attest-002',
      INPUT,
    ));

    expect(result.attestation.version).toBe(2);
    expect(store.persons.attestBirthday).not.toHaveBeenCalled();
    expect(store.outbox.append).not.toHaveBeenCalled();
  });

  it.each([
    ['用户身份', actor('user')],
    ['服务身份缺少 Scope', actor('service', [])],
    ['系统任务缺少 Scope', actor('system_job', [])],
  ])('%s 即使进入应用层也失败关闭', async (_label, identity) => {
    const store = fixture();
    await expect(run(store, () => store.service.attest(
      PERSON_ID,
      1,
      'birthday-attest-003',
      INPUT,
    ), identity)).rejects.toMatchObject({
      response: { code: 'ORG_BIRTHDAY_TRUSTED_WORKFLOW_REQUIRED' },
    });
    expect(store.idempotency.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['非法 personId', 'bad', 1, 'birthday-attest-004', INPUT],
    ['非法版本类型', PERSON_ID, '1', 'birthday-attest-004', INPUT],
    ['零版本', PERSON_ID, 0, 'birthday-attest-004', INPUT],
    ['最大安全版本', PERSON_ID, Number.MAX_SAFE_INTEGER, 'birthday-attest-004', INPUT],
    ['非安全版本', PERSON_ID, Number.MAX_SAFE_INTEGER + 1, 'birthday-attest-004', INPUT],
    ['非法幂等键', PERSON_ID, 1, 'short', INPUT],
    ['空请求', PERSON_ID, 1, 'birthday-attest-004', null],
    ['数组请求', PERSON_ID, 1, 'birthday-attest-004', []],
    ['未知字段', PERSON_ID, 1, 'birthday-attest-004', { ...INPUT, tenantId: 'tenant-other' }],
    ['非法日期', PERSON_ID, 1, 'birthday-attest-004', { ...INPUT, monthDay: '02-30' }],
    ['非法身份凭据', PERSON_ID, 1, 'birthday-attest-004', {
      ...INPUT,
      identityEvidenceId: 'bad',
    }],
    ['非法生日凭据', PERSON_ID, 1, 'birthday-attest-004', {
      ...INPUT,
      birthdayEvidenceId: 'bad',
    }],
  ])('%s不能绕过应用服务的运行时复核', async (
    _label,
    personId,
    version,
    key,
    input,
  ) => {
    const store = fixture();
    await expect(run(store, () => store.service.attest(
      personId,
      version,
      key,
      input,
    ))).rejects.toMatchObject({
      response: { code: 'ORG_PERSON_BIRTHDAY_REQUEST_INVALID' },
    });
    expect(store.idempotency.execute).not.toHaveBeenCalled();
  });

  it('自然人不存在时返回稳定错误且不写副作用', async () => {
    const store = fixture(null);
    await expect(run(store, () => store.service.attest(
      PERSON_ID,
      1,
      'birthday-attest-005',
      INPUT,
    ))).rejects.toMatchObject({
      response: { code: 'ORG_PERSON_NOT_FOUND' },
    });
    expect(store.persons.attestBirthday).not.toHaveBeenCalled();
    expect(store.outbox.append).not.toHaveBeenCalled();
  });

  it.each([
    [
      '跨租户',
      birthdayAttestedPerson({ tenantId: 'tenant-other', version: 1 }),
      1,
      'ORG_PERSON_CROSS_TENANT',
    ],
    [
      '版本冲突',
      birthdayAttestedPerson({ birthdayEvidenceId: null, birthdayAttestedAt: null, version: 2 }),
      1,
      'ORG_PERSON_VERSION_CONFLICT',
    ],
    [
      '身份凭据错位',
      birthdayAttestedPerson({
        identityEvidenceId: OTHER_BIRTHDAY_EVIDENCE_ID,
        birthdayEvidenceId: null,
        birthdayAttestedAt: null,
        version: 1,
      }),
      1,
      'ORG_PERSON_IDENTITY_EVIDENCE_MISMATCH',
    ],
    [
      '生日证明不可替换',
      birthdayAttestedPerson({ birthdayEvidenceId: OTHER_BIRTHDAY_EVIDENCE_ID }),
      2,
      'ORG_PERSON_BIRTHDAY_IMMUTABLE',
    ],
  ])('%s映射为稳定领域异常', async (_label, person, expectedVersion, code) => {
    const store = fixture(person);
    await expect(run(store, () => store.service.attest(
      PERSON_ID,
      expectedVersion,
      'birthday-attest-006',
      INPUT,
    ))).rejects.toMatchObject({ response: { code } });
  });

  it('仓储并发冲突映射为统一版本冲突', async () => {
    const store = fixture();
    store.persons.attestBirthday.mockRejectedValue(new OrgWriteConflictError());
    await expect(run(store, () => store.service.attest(
      PERSON_ID,
      1,
      'birthday-attest-007',
      INPUT,
    ))).rejects.toMatchObject({
      response: { code: 'ORG_VERSION_CONFLICT' },
    });
  });

  it.each([
    ['租户领域错误', new OrgDomainError('INVALID_TENANT', '租户非法'), 'ORG_INVALID_TENANT'],
    ['普通领域错误', new OrgDomainError('INVALID_NAME', '名称非法'), 'ORG_INVALID_NAME'],
  ])('%s保持稳定错误映射', async (_label, error, code) => {
    const store = fixture();
    store.idempotency.execute.mockRejectedValue(error);
    await expect(run(store, () => store.service.attest(
      PERSON_ID,
      1,
      'birthday-attest-008',
      INPUT,
    ))).rejects.toMatchObject({ response: { code } });
  });

  it('未知基础设施异常原样抛出', async () => {
    const store = fixture();
    const failure = new Error('数据库不可用');
    store.idempotency.execute.mockRejectedValue(failure);
    await expect(run(store, () => store.service.attest(
      PERSON_ID,
      1,
      'birthday-attest-009',
      INPUT,
    ))).rejects.toBe(failure);
  });

  it.each([
    ['空结果', null],
    ['未知字段', {
      attestation: {
        personId: PERSON_ID,
        birthdayAttested: true,
        version: 2,
        monthDay: '02-29',
      },
    }],
    ['跨对象结果', {
      attestation: {
        personId: '01J8ZQK7V0A2M4N6P8R0T2W4E5',
        birthdayAttested: true,
        version: 2,
      },
    }],
    ['非法版本跃迁', {
      attestation: {
        personId: PERSON_ID,
        birthdayAttested: true,
        version: 3,
      },
    }],
    ['非安全版本', {
      attestation: {
        personId: PERSON_ID,
        birthdayAttested: true,
        version: Number.MAX_SAFE_INTEGER + 1,
      },
    }],
  ])('拒绝幂等存储返回的%s', async (_label, value) => {
    const store = fixture();
    store.idempotency.execute.mockResolvedValue(value);
    await expect(run(store, () => store.service.attest(
      PERSON_ID,
      1,
      'birthday-attest-010',
      INPUT,
    ))).rejects.toMatchObject({
      response: { code: 'ORG_PERSON_BIRTHDAY_RESULT_INVALID' },
    });
  });
});
