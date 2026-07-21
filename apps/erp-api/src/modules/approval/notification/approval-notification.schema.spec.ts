import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  ApprovalNotificationRecordSchema,
  type ApprovalNotificationRecord,
} from './approval-notification.schema.js';

const mongoose = new Mongoose();
const NotificationModel = mongoose.model<ApprovalNotificationRecord>(
  'SpecApprovalNotification',
  ApprovalNotificationRecordSchema,
);

function record(): Record<string, unknown> {
  return {
    notificationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
    tenantId: 'tenant-001',
    instanceId: 'instance-001',
    aggregateVersion: 2,
    eventType: 'instance.submitted',
    recipientActorId: 'manager-001',
    channel: 'dingtalk',
    riskLevel: 'R1',
    status: 'pending',
    attempts: 0,
    operatorRetryCount: 0,
    nextAttemptAt: new Date('2026-07-21T00:00:00.000Z'),
    lockedAt: null,
    lockedBy: null,
    externalMessageId: null,
    lastErrorCode: null,
    sentAt: null,
  };
}

describe('ApprovalNotificationRecordSchema', () => {
  it('不持久化审批标题、表单或平台凭据', async () => {
    const document = new NotificationModel(record());
    await document.validate();
    expect(ApprovalNotificationRecordSchema.path('title')).toBeUndefined();
    expect(ApprovalNotificationRecordSchema.path('formData')).toBeUndefined();
    expect(ApprovalNotificationRecordSchema.path('accessToken')).toBeUndefined();
  });

  it('处理中记录必须持有完整租约', async () => {
    await expect(new NotificationModel({
      ...record(), status: 'processing', lockedAt: new Date(), lockedBy: null,
    }).validate()).rejects.toThrow('处理中通知必须持有租约');
    await new NotificationModel({
      ...record(), status: 'processing', lockedAt: new Date(), lockedBy: 'worker-001',
    }).validate();
  });

  it('已发送记录必须包含平台消息标识和发送时间', async () => {
    await expect(new NotificationModel({ ...record(), status: 'sent' }).validate())
      .rejects.toThrow('已发送通知必须记录平台消息标识');
    await new NotificationModel({
      ...record(), status: 'sent', externalMessageId: 'message-001', sentAt: new Date(),
    }).validate();
  });

  it('业务幂等键覆盖租户、实例版本、事件、收件人与渠道', () => {
    const index = ApprovalNotificationRecordSchema.indexes().find(([spec]) =>
      spec.tenantId === 1 && spec.instanceId === 1 && spec.aggregateVersion === 1 &&
      spec.eventType === 1 && spec.recipientActorId === 1 && spec.channel === 1,
    );
    expect(index?.[1]?.unique).toBe(true);
  });
});
