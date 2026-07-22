import { describe, expect, it } from 'vitest';

import {
  approvalDelegationCoverageDays,
  createApprovalDelegation,
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
});
