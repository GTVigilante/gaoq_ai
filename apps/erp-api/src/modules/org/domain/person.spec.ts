import { describe, expect, it } from 'vitest';

import {
  attestPersonBirthday,
  buildPersonBirthdayAttestedEvent,
  createPerson,
} from './index.js';

const NOW = new Date('2026-07-27T00:00:00.000Z');

describe('Person 生日证明', () => {
  it('自然人初始不保存生日，证明后只增加证据引用和版本', () => {
    const person = createPerson({
      id: 'person-001',
      tenantId: 'tenant-001',
      sourceCandidateId: 'candidate-001',
      identityEvidenceId: 'identity-evidence-001',
    }, NOW);
    expect(person).toMatchObject({
      birthdayEvidenceId: null,
      birthdayAttestedAt: null,
      version: 1,
    });

    const attested = attestPersonBirthday(person, {
      tenantId: person.tenantId,
      expectedVersion: 1,
      identityEvidenceId: person.identityEvidenceId,
      birthdayEvidenceId: 'birthday-evidence-001',
    }, new Date('2026-07-27T00:01:00.000Z'));
    expect(attested).toMatchObject({
      birthdayEvidenceId: 'birthday-evidence-001',
      birthdayAttestedAt: '2026-07-27T00:01:00.000Z',
      version: 2,
    });
    expect(JSON.stringify(attested)).not.toMatch(/monthDay|birthDate|dateOfBirth/iu);
  });

  it('身份错位和证明替换均失败关闭', () => {
    const person = createPerson({
      id: 'person-001',
      tenantId: 'tenant-001',
      sourceCandidateId: 'candidate-001',
      identityEvidenceId: 'identity-evidence-001',
    }, NOW);
    expect(() => attestPersonBirthday(person, {
      tenantId: person.tenantId,
      expectedVersion: 1,
      identityEvidenceId: 'identity-evidence-other',
      birthdayEvidenceId: 'birthday-evidence-001',
    }, NOW)).toThrow('生日证明未绑定当前身份核验证据');

    const attested = attestPersonBirthday(person, {
      tenantId: person.tenantId,
      expectedVersion: 1,
      identityEvidenceId: person.identityEvidenceId,
      birthdayEvidenceId: 'birthday-evidence-001',
    }, NOW);
    expect(() => attestPersonBirthday(attested, {
      tenantId: person.tenantId,
      expectedVersion: 2,
      identityEvidenceId: person.identityEvidenceId,
      birthdayEvidenceId: 'birthday-evidence-002',
    }, NOW)).toThrow('生日证明已经登记且不可替换');
  });

  it('领域事件不包含生日月日或盲索引', () => {
    const person = attestPersonBirthday(createPerson({
      id: 'person-001',
      tenantId: 'tenant-001',
      sourceCandidateId: 'candidate-001',
      identityEvidenceId: 'identity-evidence-001',
    }, NOW), {
      tenantId: 'tenant-001',
      expectedVersion: 1,
      identityEvidenceId: 'identity-evidence-001',
      birthdayEvidenceId: 'birthday-evidence-001',
    }, NOW);
    const event = buildPersonBirthdayAttestedEvent(person, NOW);
    expect(event.type).toBe('person.birthday_attested');
    expect(event.payload).toEqual({
      birthdayEvidenceId: 'birthday-evidence-001',
      status: 'active',
    });
    expect(JSON.stringify(event)).not.toMatch(/monthDay|blind|birthDate|dateOfBirth/iu);
  });
});
