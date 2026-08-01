import { describe, expect, it } from 'vitest';

import {
  buildApprovalCreateInput,
  parseCreatedApprovalInstance,
} from '../../lib/approval-initiation-contract.js';
import type { ApprovalPublishedTemplateForm } from '../../lib/approval-contract.js';

const TEMPLATE: ApprovalPublishedTemplateForm = {
  id: '01K00000000000000000000002',
  code: 'expense_claim',
  name: '费用报销',
  revision: 2,
  riskLevel: 'R1',
  definitionHash: 'a'.repeat(43),
  version: 3,
  fields: [
    { key: 'reason', label: '事由', type: 'text', required: true, sensitivity: 'L1', maximumLength: 20 },
    { key: 'amount', label: '金额', type: 'money_minor', required: true, sensitivity: 'L2' },
    { key: 'cost_center', label: '成本中心', type: 'single_select', required: true, sensitivity: 'L2', options: [{ key: 'rd', label: '研发' }] },
    { key: 'attachments', label: '附件', type: 'file_reference', required: false, sensitivity: 'L3' },
  ],
};

describe('审批发起共享契约', () => {
  it('只按模板白名单输出字段并规范标题和文件引用', () => {
    expect(buildApprovalCreateInput({
      templateCode: 'expense_claim',
      title: '  差旅报销  ',
      formData: {
        reason: '客户拜访', amount: 12_300, cost_center: 'rd',
        attachments: 'file-001,file-002', tenantId: 'tenant-attacker',
      },
    }, TEMPLATE)).toEqual({
      templateCode: 'expense_claim',
      title: '差旅报销',
      formData: { reason: '客户拜访', amount: 12_300, cost_center: 'rd', attachments: ['file-001', 'file-002'] },
    });
  });

  it('拒绝缺少必填项、非法选项、非整数分和重复文件引用', () => {
    const base = { templateCode: 'expense_claim', title: '报销', formData: { reason: '客户拜访', amount: 100, cost_center: 'rd' } };
    expect(() => buildApprovalCreateInput({ ...base, formData: { ...base.formData, reason: '' } }, TEMPLATE)).toThrowError('APPROVAL_CREATE_INPUT_INVALID');
    expect(() => buildApprovalCreateInput({ ...base, formData: { ...base.formData, amount: 10.5 } }, TEMPLATE)).toThrowError('APPROVAL_CREATE_INPUT_INVALID');
    expect(() => buildApprovalCreateInput({ ...base, formData: { ...base.formData, cost_center: 'unknown' } }, TEMPLATE)).toThrowError('APPROVAL_CREATE_INPUT_INVALID');
    expect(() => buildApprovalCreateInput({ ...base, formData: { ...base.formData, attachments: 'file-001,file-001' } }, TEMPLATE)).toThrowError('APPROVAL_CREATE_INPUT_INVALID');
  });

  it('拒绝无效日期并接受真实闰日', () => {
    const dateTemplate = { ...TEMPLATE, fields: [{ key: 'travel_date', label: '日期', type: 'date', required: true, sensitivity: 'L1' }] } as ApprovalPublishedTemplateForm;
    expect(() => buildApprovalCreateInput({ templateCode: 'expense_claim', title: '出差', formData: { travel_date: '2026-02-29' } }, dateTemplate)).toThrowError('APPROVAL_CREATE_INPUT_INVALID');
    expect(buildApprovalCreateInput({ templateCode: 'expense_claim', title: '出差', formData: { travel_date: '2028-02-29' } }, dateTemplate).formData).toEqual({ travel_date: '2028-02-29' });
  });

  it('创建响应只接受合法实例摘要', () => {
    const instance = {
      id: '01K00000000000000000000000', status: 'draft', templateCode: 'expense_claim',
      templateRevision: 2, riskLevel: 'R1', version: 1, submittedAt: null, completedAt: null,
    } as const;
    expect(parseCreatedApprovalInstance({ instance })).toEqual(instance);
    expect(() => parseCreatedApprovalInstance({ tenantId: 'tenant-001' })).toThrowError('APPROVAL_INSTANCE_RESPONSE_INVALID');
    expect(() => parseCreatedApprovalInstance({ instance: { ...instance, tenantId: 'tenant-001' } })).toThrowError('APPROVAL_INSTANCE_RESPONSE_INVALID');
    expect(() => parseCreatedApprovalInstance({ instance: { ...instance, status: 'running', submittedAt: '2026-07-22T00:00:00.000Z' } })).toThrowError('APPROVAL_INSTANCE_RESPONSE_INVALID');
  });
});
