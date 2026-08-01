import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { ESignFlowRecordSchema, type ESignFlowRecord } from './esign-flow.schema.js';

const mongoose = new Mongoose();
const FlowModel = mongoose.model<ESignFlowRecord>('SpecESignFlow', ESignFlowRecordSchema);

describe('ESignFlowRecordSchema', () => {
  it('只用摘要关联外部流程，明文 ID 不存在于 Schema', async () => {
    await new FlowModel({
      id: '01K00000000000000000000000', tenantId: 'tenant-001', provider: 'esign_cn',
      appId: 'app12345', offerId: '01K00000000000000000000001',
      externalFlowIdHash: 'A'.repeat(43), externalIdKeyId: 'esign-key-001',
      externalIdIv: 'A'.repeat(16), externalIdCiphertext: 'B'.repeat(32),
      externalIdAuthTag: 'C'.repeat(22), status: 'awaiting_signature', providerStatus: null,
      lastProviderAction: null, providerOccurredAt: null, reviewRequired: false,
      reviewCode: null, signedEvidenceId: null, version: 1,
    }).validate();
    expect(ESignFlowRecordSchema.path('externalFlowId')).toBeUndefined();
    expect(ESignFlowRecordSchema.path('offerTerms')).toBeUndefined();
    expect(ESignFlowRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, offerId: 1 }, { unique: true },
    ]);
  });
});
