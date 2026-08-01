import { describe, expect, it } from 'vitest';

import {
  approvalDelegationCoverageDays,
  createApprovalDelegation,
  restoreApprovalDelegation,
  revokeApprovalDelegation,
} from './delegation.js';

const NOW = new Date('2026-07-22T08:00:00.000Z');

describe('审批委托领域', () => {
  it('只允许本人创建最长 30 天委托并支持强版本撤销', () => {
    const delegation = createApprovalDelegation({
      id: 'delegation-001', tenantId: 'tenant-001', principalApproverId: 'manager-001',
      delegateId: 'manager-002', validFrom: NOW.toISOString(),
      validUntil: '2026-08-20T08:00:00.000Z', actorId: 'manager-001',
    }, NOW);
    expect(delegation).toMatchObject({ status: 'active', version: 1, revokedBy: null });
    expect(revokeApprovalDelegation(delegation, {
      tenantId: 'tenant-001', expectedVersion: 1, actorId: 'manager-001',
    }, new Date('2026-07-23T08:00:00.000Z'))).toMatchObject({
      status: 'revoked', version: 2, revokedBy: 'manager-001',
    });
  });

  it('拒绝代他人委托、自委托、超期和旧版本撤销', () => {
    const input = {
      id: 'delegation-001', tenantId: 'tenant-001', principalApproverId: 'manager-001',
      delegateId: 'manager-002', validFrom: NOW.toISOString(),
      validUntil: '2026-08-20T08:00:00.000Z', actorId: 'manager-001',
    } as const;
    expect(() => createApprovalDelegation({ ...input, actorId: 'admin-001' }, NOW))
      .toThrowError(expect.objectContaining({ code: 'APPROVAL_DELEGATION_OWNER_DENIED' }));
    expect(() => createApprovalDelegation({ ...input, delegateId: 'manager-001' }, NOW))
      .toThrowError(expect.objectContaining({ code: 'APPROVAL_DELEGATION_SELF_DENIED' }));
    expect(() => createApprovalDelegation({ ...input, validUntil: '2026-09-01T08:00:00.000Z' }, NOW))
      .toThrowError(expect.objectContaining({ code: 'APPROVAL_DELEGATION_PERIOD_INVALID' }));
    const delegation = createApprovalDelegation(input, NOW);
    expect(() => revokeApprovalDelegation(delegation, {
      tenantId: 'tenant-001', expectedVersion: 2, actorId: 'manager-001',
    }, NOW)).toThrowError(expect.objectContaining({ code: 'APPROVAL_DELEGATION_VERSION_CONFLICT' }));
  });

  it('覆盖日槽按 UTC 日确定生成以支持数据库并发唯一约束', () => {
    expect(approvalDelegationCoverageDays(
      '2026-07-22T23:00:00.000Z', '2026-07-24T01:00:00.000Z',
    )).toEqual(['2026-07-22', '2026-07-23', '2026-07-24']);
  });

  it('拒绝越权撤销、失效周期和被篡改的持久化委托', () => {
    const input = {
      id: 'delegation-001', tenantId: 'tenant-001', principalApproverId: 'manager-001',
      delegateId: 'manager-002', validFrom: NOW.toISOString(),
      validUntil: '2026-08-20T08:00:00.000Z', actorId: 'manager-001',
    } as const;
    const delegation = createApprovalDelegation(input, NOW);
    expect(() => revokeApprovalDelegation(delegation, {
      tenantId: 'tenant-001', expectedVersion: 1, actorId: 'manager-002',
    }, NOW)).toThrowError(expect.objectContaining({ code: 'APPROVAL_DELEGATION_REVOKE_DENIED' }));
    const revoked = revokeApprovalDelegation(delegation, {
      tenantId: 'tenant-001', expectedVersion: 1, actorId: 'manager-001',
    }, NOW);
    expect(() => revokeApprovalDelegation(revoked, {
      tenantId: 'tenant-001', expectedVersion: 2, actorId: 'manager-001',
    }, NOW)).toThrowError(expect.objectContaining({ code: 'APPROVAL_DELEGATION_REVOKE_DENIED' }));
    for (const corrupted of [
      { ...delegation, principalApproverId: delegation.delegateId },
      { ...delegation, validUntil: delegation.validFrom },
      { ...delegation, status: 'active' as const, revokedBy: 'manager-001' },
      { ...revoked, revokedBy: null },
    ]) {
      expect(() => restoreApprovalDelegation(corrupted))
        .toThrowError(expect.objectContaining({ code: 'APPROVAL_DELEGATION_INTEGRITY_INVALID' }));
    }
    expect(restoreApprovalDelegation(revoked)).toEqual(revoked);
  });

  it('拒绝回填、倒置、超期与非规范日期', () => {
    const input = {
      id: 'delegation-001', tenantId: 'tenant-001', principalApproverId: 'manager-001',
      delegateId: 'manager-002', validFrom: NOW.toISOString(),
      validUntil: '2026-08-20T08:00:00.000Z', actorId: 'manager-001',
    } as const;
    for (const changes of [
      { validFrom: '2026-07-22T07:54:59.000Z' },
      { validUntil: NOW.toISOString() },
      { validFrom: 'not-a-date' },
    ]) {
      expect(() => createApprovalDelegation({ ...input, ...changes }, NOW)).toThrow();
    }
    expect(() => approvalDelegationCoverageDays(
      '2026-07-22T00:00:00.000Z', '2026-07-21T00:00:00.000Z',
    )).toThrowError(expect.objectContaining({ code: 'APPROVAL_DELEGATION_PERIOD_INVALID' }));
    expect(() => approvalDelegationCoverageDays('not-a-date', input.validUntil))
      .toThrowError(expect.objectContaining({ code: 'APPROVAL_DELEGATION_DATE_INVALID' }));
  });
});
