import { describe, expect, it } from 'vitest';

import { parseApprovalSummaries, parseApprovalView } from './approval-contract.js';

const SUMMARY = {
  id: '01K00000000000000000000000', status: 'running', templateCode: 'expense_claim',
  templateRevision: 2, riskLevel: 'R1', version: 3,
  submittedAt: '2026-07-22T00:00:00.000Z', completedAt: null,
} as const;

describe('审批工作台响应契约', () => {
  it('接受领域状态 running 并保留并发版本', () => {
    expect(parseApprovalSummaries([SUMMARY])).toEqual([SUMMARY]);
  });

  it('拒绝通知状态 pending 被误当作审批实例状态', () => {
    expect(() => parseApprovalSummaries([{ ...SUMMARY, status: 'pending' }]))
      .toThrowError('APPROVAL_SUMMARY_INVALID');
  });

  it('详情仅接受严格主体标识、表单对象和非负节点位置', () => {
    expect(parseApprovalView({ ...SUMMARY, title: '费用报销', initiatorId: 'employee-001', formData: { amount: 100_00 }, currentNodeIndex: 0 }))
      .toMatchObject({ title: '费用报销', currentNodeIndex: 0 });
    expect(() => parseApprovalView({ ...SUMMARY, title: '费用报销', initiatorId: 'employee-001', formData: [], currentNodeIndex: 0 }))
      .toThrowError('APPROVAL_DETAIL_INVALID');
  });
});
