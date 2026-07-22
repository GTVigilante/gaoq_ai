import { describe, expect, it } from 'vitest';

import {
  buildApprovalDelegationCreateInput,
  parseApprovalTaskResponse,
} from '../../lib/approval-task-contract.js';

const RUNNING = {
  id: '01K00000000000000000000000', status: 'running', templateCode: 'expense_claim',
  templateRevision: 2, riskLevel: 'R1', version: 4,
  submittedAt: '2026-07-22T00:00:00.000Z', completedAt: null,
} as const;

describe('审批任务与委托共享契约', () => {
  it('任务操作响应只接受无租户字段的运行中实例', () => {
    expect(parseApprovalTaskResponse({ instance: RUNNING })).toEqual(RUNNING);
    expect(() => parseApprovalTaskResponse({ instance: { ...RUNNING, tenantId: 'tenant-001' } }))
      .toThrowError('APPROVAL_TASK_RESPONSE_INVALID');
    expect(() => parseApprovalTaskResponse({ instance: { ...RUNNING, status: 'approved' } }))
      .toThrowError('APPROVAL_TASK_RESPONSE_INVALID');
  });

  it('委托入参转换为严格 UTC 时间且保留主体白名单', () => {
    expect(buildApprovalDelegationCreateInput({
      delegateId: 'manager-002', validFrom: '2026-07-22T16:00:00+08:00',
      validUntil: '2026-07-29T16:00:00+08:00',
    }, 'manager-001')).toEqual({
      delegateId: 'manager-002', validFrom: '2026-07-22T08:00:00.000Z',
      validUntil: '2026-07-29T08:00:00.000Z',
    });
  });

  it('委托拒绝本人、逆序、超过 30 天和非法主体', () => {
    const base = {
      delegateId: 'manager-002', validFrom: '2026-07-22T08:00:00.000Z',
      validUntil: '2026-07-29T08:00:00.000Z',
    };
    expect(() => buildApprovalDelegationCreateInput({ ...base, delegateId: 'manager-001' }, 'manager-001'))
      .toThrowError('APPROVAL_DELEGATION_INPUT_INVALID');
    expect(() => buildApprovalDelegationCreateInput({ ...base, validUntil: '2026-07-21T08:00:00.000Z' }, 'manager-001'))
      .toThrowError('APPROVAL_DELEGATION_INPUT_INVALID');
    expect(() => buildApprovalDelegationCreateInput({ ...base, validUntil: '2026-08-22T08:00:00.000Z' }, 'manager-001'))
      .toThrowError('APPROVAL_DELEGATION_INPUT_INVALID');
    expect(() => buildApprovalDelegationCreateInput({ ...base, delegateId: '../attacker' }, 'manager-001'))
      .toThrowError('APPROVAL_DELEGATION_INPUT_INVALID');
  });
});
