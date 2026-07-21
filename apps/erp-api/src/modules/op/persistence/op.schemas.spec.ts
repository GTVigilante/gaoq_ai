import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  OpClientBindingRecordSchema,
  OpOperatingSummaryInboxRecordSchema,
  OpOperatingSummaryRecordSchema,
  type OpClientBindingRecord,
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
});
