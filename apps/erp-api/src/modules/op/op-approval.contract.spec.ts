import { describe, expect, it } from 'vitest';

import {
  hashOpApprovalPayload,
  OP_MAX_APPROVAL_BODY_BYTES,
  opApprovalRequestEnvelopeSchema,
} from './op-approval.contract.js';

const valid = () => ({
  schemaVersion: '1.0', type: 'approval.requested',
  occurredAt: '2026-07-22T08:00:00.000+08:00',
  data: {
    sourceDocumentType: 'purchase_order', sourceDocumentId: 'po-001',
    initiatorEmployeeId: 'employee-001', title: '采购申请',
    formData: { amount: 12_345, urgent: true, tags: ['office', 'quarter-3'] },
  },
});

describe('OP 审批请求契约', () => {
  it('接受固定版本和白名单标量，并生成稳定载荷摘要', () => {
    expect(opApprovalRequestEnvelopeSchema.parse(valid()).data.formData.amount).toBe(12_345);
    expect(hashOpApprovalPayload(Buffer.from('same'))).toHaveLength(43);
    expect(OP_MAX_APPROVAL_BODY_BYTES).toBe(1_048_576);
  });

  it('拒绝 OP 自选模板、嵌套对象和动态非法字段', () => {
    expect(opApprovalRequestEnvelopeSchema.safeParse({
      ...valid(), data: { ...valid().data, templateCode: 'BYPASS' },
    }).success).toBe(false);
    expect(opApprovalRequestEnvelopeSchema.safeParse({
      ...valid(), data: { ...valid().data, formData: { nested: { secret: true } } },
    }).success).toBe(false);
    expect(opApprovalRequestEnvelopeSchema.safeParse({
      ...valid(), data: { ...valid().data, formData: { '$where': 'sleep(1)' } },
    }).success).toBe(false);
  });
});
