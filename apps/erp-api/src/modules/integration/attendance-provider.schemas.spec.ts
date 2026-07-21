import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  AttendanceProviderEmployeeMappingRecordSchema,
  AttendanceProviderInboxRecordSchema,
  AttendanceProviderStateRecordSchema,
  type AttendanceProviderInboxRecord,
  type AttendanceProviderStateRecord,
} from './attendance-provider.schemas.js';

const mongoose = new Mongoose();
const StateModel = mongoose.model<AttendanceProviderStateRecord>(
  'SpecAttendanceProviderState', AttendanceProviderStateRecordSchema,
);
const InboxModel = mongoose.model<AttendanceProviderInboxRecord>(
  'SpecAttendanceProviderInbox', AttendanceProviderInboxRecordSchema,
);
const ID = '01J8ZQK7V0A2M4N6P8R0T2W4C1';
const FINGERPRINT = `blind-key-001.${'A'.repeat(43)}`;

describe('考勤 Provider 持久化契约', () => {
  it('同步状态只保存完整加密游标', async () => {
    const base = {
      id: ID, tenantId: 'tenant-001', providerCode: 'dingtalk',
      timeZone: 'Asia/Shanghai', status: 'active', nextPollAt: new Date(),
    };
    await expect(new StateModel(base).validate()).resolves.toBeUndefined();
    await expect(new StateModel({ ...base, cursorKeyId: 'key-001' }).validate())
      .rejects.toThrow('全有或全无');
    expect(AttendanceProviderStateRecordSchema.path('accessToken')).toBeUndefined();
    expect(AttendanceProviderStateRecordSchema.path('credentialSecretRef')).toBeUndefined();
  });

  it('Inbox 不保存外部事件明文，完成态必须有全部检查点', async () => {
    const base = {
      id: ID, tenantId: 'tenant-001', stateId: ID, providerCode: 'feishu',
      eventBlindIndexes: [FINGERPRINT], providerOccurredAt: new Date(),
      payloadKeyId: 'key-001', payloadIv: 'A'.repeat(16), payloadCiphertext: 'A'.repeat(32),
      payloadAuthTag: 'A'.repeat(22), transportRequestIdFingerprint: 'A'.repeat(43),
      status: 'pending', attempts: 0,
    };
    await expect(new InboxModel(base).validate()).resolves.toBeUndefined();
    await expect(new InboxModel({ ...base, status: 'completed' }).validate())
      .rejects.toThrow('检查点不完整');
    expect(AttendanceProviderInboxRecordSchema.path('externalEventId')).toBeUndefined();
    expect(AttendanceProviderInboxRecordSchema.path('externalEmployeeId')).toBeUndefined();
    expect(AttendanceProviderInboxRecordSchema.path('payload')).toBeUndefined();
  });

  it('状态、员工外部标识和事件均有租户前缀唯一约束', () => {
    expect(AttendanceProviderStateRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, providerCode: 1 }, expect.objectContaining({ unique: true }),
    ]);
    expect(AttendanceProviderEmployeeMappingRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, providerCode: 1, externalIdBlindIndexes: 1 },
      expect.objectContaining({ unique: true }),
    ]);
    expect(AttendanceProviderInboxRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, providerCode: 1, eventBlindIndexes: 1 },
      expect.objectContaining({ unique: true }),
    ]);
  });
});
