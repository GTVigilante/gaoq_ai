import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  RecruitmentChannelBindingRecordSchema,
  RecruitmentChannelInboxRecordSchema,
  RecruitmentExternalMappingRecordSchema,
  RecruitmentChannelPositionDeliveryRecordSchema,
  RecruitmentChannelStageDeliveryRecordSchema,
  type RecruitmentChannelBindingRecord,
  type RecruitmentChannelInboxRecord,
} from './recruitment-channel.schemas.js';

const mongoose = new Mongoose();
const BindingModel = mongoose.model<RecruitmentChannelBindingRecord>(
  'SpecRecruitmentChannelBinding', RecruitmentChannelBindingRecordSchema,
);
const InboxModel = mongoose.model<RecruitmentChannelInboxRecord>(
  'SpecRecruitmentChannelInbox', RecruitmentChannelInboxRecordSchema,
);
const ID = '01J8ZQK7V0A2M4N6P8R0T2W4C1';
const FINGERPRINT = `blind-key-001.${'A'.repeat(43)}`;

describe('招聘渠道持久化契约', () => {
  it('绑定只保存凭据引用，游标必须是完整 AES-GCM 密文', async () => {
    const base = {
      id: ID, tenantId: 'tenant-001', channelCode: 'sandbox_ats',
      credentialSecretRef: 'GAOQ_RECRUITMENT_CHANNEL_SANDBOX', status: 'active',
      nextPollAt: new Date(),
    };
    await expect(new BindingModel(base).validate()).resolves.toBeUndefined();
    await expect(new BindingModel({ ...base, cursorKeyId: 'key-001' }).validate())
      .rejects.toThrow('全有或全无');
    expect(RecruitmentChannelBindingRecordSchema.path('credential')).toBeUndefined();
    expect(RecruitmentChannelBindingRecordSchema.path('token')).toBeUndefined();
  });

  it('原始投递不保存外部事件明文，完成态必须同时具备证据和回执', async () => {
    const base = {
      id: ID, tenantId: 'tenant-001', bindingId: ID, channelCode: 'sandbox_ats',
      eventBlindIndexes: [FINGERPRINT], providerOccurredAt: new Date(),
      payloadKeyId: 'key-001', payloadIv: 'A'.repeat(16),
      payloadCiphertext: 'A'.repeat(32), payloadAuthTag: 'A'.repeat(22),
      status: 'pending', attempts: 0,
    };
    await expect(new InboxModel(base).validate()).resolves.toBeUndefined();
    await expect(new InboxModel({ ...base, status: 'completed' }).validate())
      .rejects.toThrow('缺少证据或申请引用');
    await expect(new InboxModel({ ...base, evidenceVerifiedAt: new Date() }).validate())
      .rejects.toThrow('证据检查点不完整');
    expect(RecruitmentChannelInboxRecordSchema.path('externalEventId')).toBeUndefined();
    expect(RecruitmentChannelInboxRecordSchema.path('payload')).toBeUndefined();
  });

  it('事件去重、外部映射和租户渠道绑定均由唯一索引强制', () => {
    expect(RecruitmentChannelBindingRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, channelCode: 1 }, expect.objectContaining({ unique: true }),
    ]);
    expect(RecruitmentChannelInboxRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, channelCode: 1, eventBlindIndexes: 1 },
      expect.objectContaining({ unique: true }),
    ]);
    expect(RecruitmentExternalMappingRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, channelCode: 1, entityType: 1, externalIdBlindIndexes: 1 },
      expect.objectContaining({ unique: true }),
    ]);
    expect(RecruitmentChannelPositionDeliveryRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, eventId: 1, bindingId: 1 },
      expect.objectContaining({ unique: true }),
    ]);
    expect(RecruitmentChannelStageDeliveryRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, applicationId: 1, applicationVersion: 1 },
      expect.objectContaining({ unique: true }),
    ]);
  });
});
