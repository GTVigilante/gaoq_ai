import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  ESignIssuanceRequestRecordSchema,
  type ESignIssuanceRequestRecord,
} from './esign-issuance.schema.js';

const Model = mongoose.model<ESignIssuanceRequestRecord>(
  'SpecESignIssuanceRequest',
  ESignIssuanceRequestRecordSchema,
);

function record() {
  return {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4B1',
    tenantId: 'tenant-001',
    offerId: '01J8ZQK7V0A2M4N6P8R0T2W4B2',
    offerVersion: 6,
    providerFileKeyId: 'esign-key-001',
    providerFileIv: 'A'.repeat(16),
    providerFileCiphertext: 'B'.repeat(32),
    providerFileAuthTag: 'C'.repeat(22),
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    signaturePage: 1,
    signatureX: 100,
    signatureY: 200,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: new Date(),
    lockedAt: null,
    lockedBy: null,
    failureCode: null,
    externalFlowKeyId: null,
    externalFlowIv: null,
    externalFlowCiphertext: null,
    externalFlowAuthTag: null,
    flowId: null,
    createdByActorId: 'actor-001',
    operatorResolutionCount: 0,
    operatorResolvedAt: null,
    succeededAt: null,
  };
}

describe('ESignIssuanceRequestRecordSchema', () => {
  it('只保存加密供应商文件并建立租户、Offer、调度和处置索引', async () => {
    await expect(new Model(record()).validate()).resolves.toBeUndefined();
    expect(ESignIssuanceRequestRecordSchema.path('providerFileId')).toBeUndefined();
    expect(ESignIssuanceRequestRecordSchema.path('signerName')).toBeUndefined();
    expect(ESignIssuanceRequestRecordSchema.path('signerAccount')).toBeUndefined();
    expect(ESignIssuanceRequestRecordSchema.indexes()).toEqual(expect.arrayContaining([
      [{ tenantId: 1, id: 1 }, { unique: true }],
      [{ tenantId: 1, offerId: 1 }, { unique: true }],
      [{ status: 1, nextAttemptAt: 1, createdAt: 1 }, {}],
      [{ tenantId: 1, status: 1, id: -1 }, {}],
    ]));
  });

  it.each([
    ['部分外部结果', { externalFlowKeyId: 'key' }],
    ['处理态无租约', { status: 'processing' }],
    ['本地终结无外部结果', { status: 'local_finalize' }],
    ['成功态无流程', { status: 'succeeded', succeededAt: new Date() }],
    ['非成功态伪造流程', {
      flowId: '01J8ZQK7V0A2M4N6P8R0T2W4B3',
      succeededAt: new Date(),
    }],
  ])('%s时失败关闭', async (_label, patch) => {
    await expect(new Model({ ...record(), ...patch }).validate())
      .rejects.toThrow('eSign 发起状态');
  });

  it('外部结果齐全时允许安全本地终结', async () => {
    await expect(new Model({
      ...record(),
      status: 'local_finalize',
      externalFlowKeyId: 'esign-key-001',
      externalFlowIv: 'D'.repeat(16),
      externalFlowCiphertext: 'E'.repeat(32),
      externalFlowAuthTag: 'F'.repeat(22),
    }).validate()).resolves.toBeUndefined();
  });

  it('流程标识与完成时间齐全时允许成功终态', async () => {
    await expect(new Model({
      ...record(),
      status: 'succeeded',
      externalFlowKeyId: 'esign-key-001',
      externalFlowIv: 'D'.repeat(16),
      externalFlowCiphertext: 'E'.repeat(32),
      externalFlowAuthTag: 'F'.repeat(22),
      flowId: '01J8ZQK7V0A2M4N6P8R0T2W4B3',
      succeededAt: new Date(),
    }).validate()).resolves.toBeUndefined();
  });
});
