import { describe, expect, it } from 'vitest';

import {
  parseApprovalSummaries,
  parseApprovalTimeline,
  parseApprovalView,
  parsePublishedTemplateForms,
} from '../../lib/approval-contract.js';

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

  it('时间线拒绝租户字段、表单正文和未知动作', () => {
    const action = {
      actionId: '01K00000000000000000000001', aggregateVersion: 2,
      actionType: 'instance.decided', actorId: 'manager-001', principalApproverId: 'manager-001',
      nodeId: 'manager_review', outcome: 'approved', resultingStatus: 'approved', delegated: false,
      fromApproverId: null, toApproverId: null, addedApproverId: null, canceledApproverIds: [],
      occurredAt: '2026-07-22T01:00:00.000Z',
    } as const;
    expect(parseApprovalTimeline([action])).toEqual([action]);
    expect(() => parseApprovalTimeline([{ ...action, tenantId: 'tenant-001' }]))
      .toThrowError('APPROVAL_TIMELINE_INVALID');
    expect(() => parseApprovalTimeline([{ ...action, actionType: 'instance.deleted' }]))
      .toThrowError('APPROVAL_TIMELINE_INVALID');
  });

  it('已发布模板只接受可填写字段投影并深冻结', () => {
    const template = {
      id: '01K00000000000000000000002', code: 'expense_claim', name: '费用报销',
      revision: 2, riskLevel: 'R1', definitionHash: 'a'.repeat(43), version: 3,
      fields: [{
        key: 'amount', label: '金额', type: 'money_minor', required: true, sensitivity: 'L2',
      }],
    } as const;
    const parsed = parsePublishedTemplateForms([template]);
    expect(parsed).toEqual([template]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed[0]?.fields)).toBe(true);
  });

  it('已发布模板拒绝租户、流程节点和解析器信息', () => {
    const template = {
      id: '01K00000000000000000000002', code: 'expense_claim', name: '费用报销',
      revision: 2, riskLevel: 'R1', definitionHash: 'a'.repeat(43), version: 3,
      fields: [{ key: 'reason', label: '事由', type: 'text', required: true, sensitivity: 'L1' }],
    } as const;
    expect(() => parsePublishedTemplateForms([{ ...template, tenantId: 'tenant-001' }]))
      .toThrowError('APPROVAL_TEMPLATE_CATALOG_INVALID');
    expect(() => parsePublishedTemplateForms([{ ...template, nodes: [] }]))
      .toThrowError('APPROVAL_TEMPLATE_CATALOG_INVALID');
    expect(() => parsePublishedTemplateForms([{ ...template, resolver: { type: 'initiator_manager' } }]))
      .toThrowError('APPROVAL_TEMPLATE_CATALOG_INVALID');
  });
});
