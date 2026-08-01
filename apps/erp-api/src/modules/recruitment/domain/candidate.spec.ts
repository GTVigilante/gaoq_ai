import { describe, expect, it } from 'vitest';

import {
  anonymizeCandidate,
  createCandidate,
  grantCandidateConsent,
  normalizeCandidateEmail,
  normalizeCandidatePhone,
  restoreCandidateFromMigration,
  withdrawCandidateConsent,
} from './candidate.js';

const NOW = new Date('2026-07-21T08:00:00.000Z');

function candidate() {
  return createCandidate({
    id: 'candidate-001',
    tenantId: 'tenant-001',
    name: ' 张 三 ',
    phone: '+86 138-0013-8000',
    email: 'Candidate@Example.COM',
    consentEvidenceId: 'consent-evidence-001',
    consentVersion: 'privacy-v1',
    consentPurpose: '招聘评估与候选人联络',
    consentSource: 'portal',
    consentExpiresAt: new Date('2027-07-21T08:00:00.000Z'),
    retentionExpiresAt: new Date('2028-07-21T08:00:00.000Z'),
  }, NOW);
}

describe('Candidate', () => {
  it('候选人不携带职位，并规范化用于加密与盲索引的联系字段', () => {
    const created = candidate();
    expect(created).toMatchObject({
      name: '张 三', phone: '+8613800138000', email: 'candidate@example.com', status: 'active',
    });
    expect(created).not.toHaveProperty('positionId');
    expect(Object.isFrozen(created)).toBe(true);
    expect(normalizeCandidatePhone('+1 (415) 555-2671')).toBe('+14155552671');
    expect(normalizeCandidateEmail(' User@Example.COM ')).toBe('user@example.com');
  });

  it('手机号与邮箱至少提供一项，且授权与保留期必须有效', () => {
    expect(() => createCandidate({
      id: 'candidate-001', tenantId: 'tenant-001', name: '张三',
      consentEvidenceId: 'consent-evidence-001',
      consentVersion: 'privacy-v1', consentPurpose: '招聘评估', consentSource: 'portal',
      consentExpiresAt: new Date('2027-07-21T08:00:00.000Z'),
      retentionExpiresAt: new Date('2028-07-21T08:00:00.000Z'),
    }, NOW)).toThrow('手机号和邮箱至少提供一项');
    expect(() => normalizeCandidatePhone('13800138000')).toThrow('E.164');
  });

  it('授权撤回后停止非必要处理，并可匿名化直接身份字段', () => {
    const withdrawn = withdrawCandidateConsent(candidate(), {
      tenantId: 'tenant-001', expectedVersion: 1,
    }, new Date('2026-08-01T00:00:00.000Z'));
    expect(withdrawn).toMatchObject({ status: 'consent_withdrawn', version: 2 });
    expect(withdrawn.consent.withdrawnAt).not.toBeNull();
    const anonymized = anonymizeCandidate(withdrawn, {
      tenantId: 'tenant-001', expectedVersion: 2,
    }, new Date('2026-08-02T00:00:00.000Z'));
    expect(anonymized).toMatchObject({
      status: 'anonymized', name: null, phone: null, email: null, version: 3,
    });
  });

  it('拒绝跨租户和乐观锁冲突', () => {
    expect(() => withdrawCandidateConsent(candidate(), {
      tenantId: 'tenant-002', expectedVersion: 1,
    }, NOW)).toThrow('租户不匹配');
    expect(() => withdrawCandidateConsent(candidate(), {
      tenantId: 'tenant-001', expectedVersion: 9,
    }, NOW)).toThrow('版本冲突');
  });

  it('再次应聘追加新授权并替换当前授权快照', () => {
    const updated = grantCandidateConsent(candidate(), {
      tenantId: 'tenant-001', expectedVersion: 1,
      evidenceId: 'consent-evidence-002', consentVersion: 'privacy-v2',
      purpose: '新职位招聘评估', source: 'portal',
      expiresAt: new Date('2028-01-01T00:00:00.000Z'),
      retentionExpiresAt: new Date('2029-01-01T00:00:00.000Z'),
    }, new Date('2026-08-01T00:00:00.000Z'));
    expect(updated).toMatchObject({
      status: 'active', version: 2,
      consent: { evidenceId: 'consent-evidence-002', version: 'privacy-v2' },
      retentionExpiresAt: '2029-01-01T00:00:00.000Z',
    });
  });

  it('迁移恢复隐私生命周期并拒绝到期未匿名化身份', () => {
    const restored = restoreCandidateFromMigration({
      id: 'candidate-001', tenantId: 'tenant-001', status: 'consent_withdrawn',
      name: ' 张 三 ', phone: '+86 138-0013-8000', email: 'Candidate@Example.COM',
      consentEvidenceId: 'consent-evidence-001', consentVersion: 'privacy-v1',
      consentPurpose: '招聘评估与候选人联络',
      consentCapturedAt: '2026-06-01T00:00:00.000Z',
      consentExpiresAt: '2027-06-01T00:00:00.000Z',
      consentWithdrawnAt: '2026-07-01T00:00:00.000Z',
      retentionExpiresAt: '2028-06-01T00:00:00.000Z', version: 2,
      createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
    }, new Date('2026-07-22T00:00:00.000Z'));
    expect(restored).toMatchObject({
      status: 'consent_withdrawn', name: '张 三', phone: '+8613800138000',
      email: 'candidate@example.com', version: 2,
      consent: { source: 'manual_import' },
    });
    expect(() => restoreCandidateFromMigration({
      ...restored,
      status: 'active',
      consentEvidenceId: restored.consent.evidenceId,
      consentVersion: restored.consent.version,
      consentPurpose: restored.consent.purpose,
      consentCapturedAt: restored.consent.capturedAt,
      consentExpiresAt: '2026-07-21T00:00:00.000Z',
      consentWithdrawnAt: null,
      version: 1,
    }, new Date('2026-07-22T00:00:00.000Z'))).toThrow('隐私生命周期时间不一致');
  });
});
