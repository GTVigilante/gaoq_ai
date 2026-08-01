import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  OpClientBindingRecordSchema,
  OpApprovalBridgeRecordSchema,
  OpApprovalRequestInboxRecordSchema,
  OpApprovalResultDeliveryRecordSchema,
  OpApprovalRouteRecordSchema,
  OpOperatingSummaryInboxRecordSchema,
  OpOperatingSummaryRecordSchema,
  type OpClientBindingRecord,
  type OpApprovalBridgeRecord,
  type OpApprovalRequestInboxRecord,
  type OpApprovalResultDeliveryRecord,
  type OpApprovalRouteRecord,
  type OpOperatingSummaryInboxRecord,
  type OpOperatingSummaryRecord,
} from './op.schemas.js';

const mongoose = new Mongoose();
const Binding = mongoose.model<OpClientBindingRecord>('SpecOpBinding', OpClientBindingRecordSchema);
const Inbox = mongoose.model<OpOperatingSummaryInboxRecord>(
  'SpecOpInbox', OpOperatingSummaryInboxRecordSchema,
);
const Summary = mongoose.model<OpOperatingSummaryRecord>(
  'SpecOpSummary', OpOperatingSummaryRecordSchema,
);
const ApprovalRoute = mongoose.model<OpApprovalRouteRecord>(
  'SpecOpApprovalRoute', OpApprovalRouteRecordSchema,
);
const ApprovalInbox = mongoose.model<OpApprovalRequestInboxRecord>(
  'SpecOpApprovalInbox', OpApprovalRequestInboxRecordSchema,
);
const ApprovalBridge = mongoose.model<OpApprovalBridgeRecord>(
  'SpecOpApprovalBridge', OpApprovalBridgeRecordSchema,
);
const ApprovalDelivery = mongoose.model<OpApprovalResultDeliveryRecord>(
  'SpecOpApprovalDelivery', OpApprovalResultDeliveryRecordSchema,
);

describe('OP 持久化约束', () => {
  it('绑定只保存专用 Secret 引用且 clientId 全局唯一', async () => {
    await new Binding({
      id: '01K00000000000000000000000', tenantId: 'tenant-001', clientId: 'op-client-001',
      credentialSecretRef: 'GAOQ_OP_HMAC_TENANT_001', status: 'active',
    }).validate();
    expect(OpClientBindingRecordSchema.path('secret')).toBeUndefined();
    expect(OpClientBindingRecordSchema.indexes()).toContainEqual([
      { clientId: 1 }, { unique: true },
    ]);
    await expect(new Binding({
      id: '01K00000000000000000000000', tenantId: 'tenant-001', clientId: 'op-client-001',
      credentialSecretRef: 'DATABASE_URL', status: 'active',
    }).validate()).rejects.toThrow();
  });

  it('Inbox 只接受密文并具备租户幂等、防重放和 90 天到期索引', async () => {
    await new Inbox({
      id: '01K00000000000000000000001', tenantId: 'tenant-001', clientId: 'op-client-001',
      externalEventId: 'event-0001', nonceHash: 'n'.repeat(43), payloadHash: 'p'.repeat(43),
      providerOccurredAt: new Date(), receivedAt: new Date(), expiresAt: new Date(),
      payloadKeyId: 'op-key-001', payloadIv: 'i'.repeat(16),
      payloadCiphertext: 'c'.repeat(16), payloadAuthTag: 'a'.repeat(22),
      status: 'pending', attempts: 0,
    }).validate();
    expect(OpOperatingSummaryInboxRecordSchema.path('rawBody')).toBeUndefined();
    expect(OpOperatingSummaryInboxRecordSchema.path('processingJobId')).toBeDefined();
    expect(OpOperatingSummaryInboxRecordSchema.path('processingToken')).toBeDefined();
    expect(OpOperatingSummaryInboxRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, clientId: 1, externalEventId: 1 }, { unique: true },
    ]);
    expect(OpOperatingSummaryInboxRecordSchema.indexes()).toContainEqual([
      { expiresAt: 1 }, { expireAfterSeconds: 0 },
    ]);
  });

  it('摘要修订为租户前缀唯一索引且业务字段不可变', async () => {
    await new Summary({
      id: '01K00000000000000000000002', tenantId: 'tenant-001', summaryDate: '2026-07-22',
      revision: 1, currency: 'CNY', gmvMinor: 100, paidOrderCount: 1,
      refundMinor: 0, refundOrderCount: 0, activeCustomerCount: 1,
      clientId: 'op-client-001', externalEventId: 'event-0001',
      inboxId: '01K00000000000000000000001', payloadHash: 'p'.repeat(43),
      occurredAt: new Date(), receivedAt: new Date(),
    }).validate();
    expect(OpOperatingSummaryRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, summaryDate: 1, revision: 1 }, { unique: true },
    ]);
    expect(OpOperatingSummaryRecordSchema.path('gmvMinor')?.options.immutable).toBe(true);
  });

  it('审批路由只接受独立凭据引用，且模板由租户、客户端和来源类型唯一确定', async () => {
    await new ApprovalRoute({
      id: '01K00000000000000000000003', tenantId: 'tenant-001',
      inboundClientId: 'op-client-001', externalTenantId: 'op-tenant-001',
      sourceDocumentType: 'purchase_order', templateCode: 'PURCHASE_ORDER',
      outboundClientId: 'erp-client-001',
      outboundCredentialSecretRef: 'GAOQ_OP_APPROVAL_OUTBOUND_TENANT_001', status: 'active',
    }).validate();
    expect(OpApprovalRouteRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, inboundClientId: 1, sourceDocumentType: 1 }, { unique: true },
    ]);
    await expect(new ApprovalRoute({
      id: '01K00000000000000000000003', tenantId: 'tenant-001',
      inboundClientId: 'op-client-001', externalTenantId: 'op-tenant-001',
      sourceDocumentType: 'purchase_order', templateCode: 'PURCHASE_ORDER',
      outboundClientId: 'erp-client-001', outboundCredentialSecretRef: 'GAOQ_OP_HMAC_SHARED',
      status: 'active',
    }).validate()).rejects.toThrow();
  });

  it('审批 Inbox 只保存短期密文，桥表与结果投递不含表单正文', async () => {
    await new ApprovalInbox({
      id: '01K00000000000000000000004', tenantId: 'tenant-001', clientId: 'op-client-001',
      externalEventId: 'approval-event-001', nonceHash: 'n'.repeat(43),
      payloadHash: 'p'.repeat(43), providerOccurredAt: new Date(), receivedAt: new Date(),
      expiresAt: new Date(), payloadKeyId: 'op-key-001', payloadIv: 'i'.repeat(16),
      payloadCiphertext: 'c'.repeat(16), payloadAuthTag: 'a'.repeat(22),
      status: 'pending', attempts: 0,
    }).validate();
    await new ApprovalBridge({
      id: '01K00000000000000000000004', tenantId: 'tenant-001', clientId: 'op-client-001',
      externalEventId: 'approval-event-001', sourceDocumentType: 'purchase_order',
      sourceDocumentId: 'po-001', templateCode: 'PURCHASE_ORDER',
      approvalInstanceId: '01K00000000000000000000005', payloadHash: 'p'.repeat(43),
      approvalStatus: 'running', approvalVersion: 2, completedAt: null,
    }).validate();
    const delivery = new ApprovalDelivery({
      eventId: '01K00000000000000000000006', tenantId: 'tenant-001',
      clientId: 'op-client-001', externalEventId: 'approval-event-001',
      sourceDocumentType: 'purchase_order', sourceDocumentId: 'po-001',
      approvalInstanceId: '01K00000000000000000000005', approvalVersion: 3,
      result: 'approved', occurredAt: new Date(), status: 'pending', attempts: 0,
      nextAttemptAt: new Date(), lockedAt: null, lockedBy: null,
      lastErrorCode: null, succeededAt: null,
    });
    await delivery.validate();
    expect(delivery.operatorRetryCount).toBe(0);
    expect(OpApprovalRequestInboxRecordSchema.indexes()).toContainEqual([
      { expiresAt: 1 }, { expireAfterSeconds: 0 },
    ]);
    expect(OpApprovalBridgeRecordSchema.path('formData')).toBeUndefined();
    expect(OpApprovalBridgeRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, externalEventId: 1 }, { unique: true },
    ]);
    expect(OpApprovalBridgeRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, sourceDocumentType: 1, sourceDocumentId: 1 }, { unique: true },
    ]);
    expect(OpApprovalResultDeliveryRecordSchema.path('formData')).toBeUndefined();
  });
});
