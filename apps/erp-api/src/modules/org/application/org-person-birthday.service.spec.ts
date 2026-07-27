import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { createPerson } from '../domain/index.js';
import type { OrgPersonBirthdayBlindIndexService } from '../persistence/org-person-birthday-blind-index.service.js';
import type { PersonRepository } from '../persistence/org.repositories.js';
import type { OrgOutboxWriter } from '../persistence/outbox.writer.js';
import { OrgPersonBirthdayService } from './org-person-birthday.service.js';

const PERSON_ID = '01J8ZQK7V0A2M4N6P8R0T2W4A1';
const IDENTITY_EVIDENCE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4B2';
const BIRTHDAY_EVIDENCE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C3';

function fixture() {
  const context = new TenantContextService();
  const person = createPerson({
    id: PERSON_ID,
    tenantId: 'tenant-001',
    sourceCandidateId: 'candidate-001',
    identityEvidenceId: IDENTITY_EVIDENCE_ID,
  }, new Date('2026-07-27T00:00:00.000Z'));
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

describe('OrgPersonBirthdayService', () => {
  it('只由服务身份登记，幂等记录、响应和事件均不含明文月日', async () => {
    const store = fixture();
    const result = await store.context.run({
      tenant: { tenantId: 'tenant-001', source: 'service_identity' },
      actor: {
        actorId: 'service:identity-proof',
        actorType: 'service',
        tenantId: 'tenant-001',
        roleCodes: ['IDENTITY_PROOF_SERVICE'],
        scopes: ['erp:org:person:birthday:attest'],
        departmentIds: [],
        traceId: 'trace-birthday-001',
      },
    }, () => store.service.attest(PERSON_ID, 1, 'birthday-attest-001', {
      monthDay: '02-29',
      identityEvidenceId: IDENTITY_EVIDENCE_ID,
      birthdayEvidenceId: BIRTHDAY_EVIDENCE_ID,
    }));
    expect(result.attestation).toEqual({
      personId: PERSON_ID,
      birthdayAttested: true,
      version: 2,
    });
    expect(store.persons.attestBirthday).toHaveBeenCalledWith(
      expect.objectContaining({ birthdayEvidenceId: BIRTHDAY_EVIDENCE_ID }),
      ['birthday-active.fingerprint'],
      1,
      {},
    );
    const storedRequest = store.idempotency.execute.mock.calls[0]?.[2];
    expect(JSON.stringify(storedRequest)).not.toContain('02-29');
    expect(JSON.stringify(result)).not.toContain('02-29');
    expect(JSON.stringify(store.outbox.append.mock.calls)).not.toContain('02-29');
  });

  it('用户身份即使拥有同名 Scope 也不能登记生日证明', async () => {
    const store = fixture();
    await expect(store.context.run({
      tenant: { tenantId: 'tenant-001', source: 'access_token' },
      actor: {
        actorId: 'user-001',
        actorType: 'user',
        tenantId: 'tenant-001',
        roleCodes: ['HR'],
        scopes: ['erp:org:person:birthday:attest'],
        departmentIds: [],
        traceId: 'trace-birthday-002',
      },
    }, () => store.service.attest(PERSON_ID, 1, 'birthday-attest-002', {
      monthDay: '07-27',
      identityEvidenceId: IDENTITY_EVIDENCE_ID,
      birthdayEvidenceId: BIRTHDAY_EVIDENCE_ID,
    }))).rejects.toMatchObject({
      response: { code: 'ORG_BIRTHDAY_TRUSTED_WORKFLOW_REQUIRED' },
    });
    expect(store.persons.attestBirthday).not.toHaveBeenCalled();
  });
});
