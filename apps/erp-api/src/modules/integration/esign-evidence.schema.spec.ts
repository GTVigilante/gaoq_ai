import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { ESignEvidenceRecordSchema, type ESignEvidenceRecord } from './esign-evidence.schema.js';

const mongoose = new Mongoose();
const EvidenceModel = mongoose.model<ESignEvidenceRecord>(
  'SpecESignEvidence', ESignEvidenceRecordSchema,
);

function record() {
  return {
    id: '01K00000000000000000000000', tenantId: 'tenant-001',
    flowId: '01K00000000000000000000001', offerId: '01K00000000000000000000002',
    provider: 'esign_cn', externalFlowIdHash: 'A'.repeat(43), proofHash: 'B'.repeat(43),
    archivedAt: new Date(), artifacts: [{
      providerFileIdHash: 'C'.repeat(43), sha256: 'D'.repeat(43), sizeBytes: 128,
      contentType: 'application/pdf', objectRef: 'worm/esign/object-001',
      archiveReceiptId: 'archive-receipt-001', malwareScanEvidenceId: 'scan-001',
      providerVerificationDigest: 'E'.repeat(43), signatureCount: 2,
    }],
  };
}

describe('ESignEvidenceRecordSchema', () => {
  it('只保存摘要与 WORM 引用，不存 PDF、短链、文件名或证书原文', async () => {
    await new EvidenceModel(record()).validate();
    for (const forbidden of [
      'pdf', 'bytes', 'downloadUrl', 'fileName', 'certBase64', 'certOwner',
    ]) expect(ESignEvidenceRecordSchema.path(forbidden)).toBeUndefined();
    expect(ESignEvidenceRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, flowId: 1 }, { unique: true },
    ]);
  });

  it('拒绝重复的供应商文件摘要', async () => {
    const input = record();
    input.artifacts.push({ ...input.artifacts[0]! });
    await expect(new EvidenceModel(input).validate()).rejects.toThrow('eSign 证据文件不得重复');
  });
});
