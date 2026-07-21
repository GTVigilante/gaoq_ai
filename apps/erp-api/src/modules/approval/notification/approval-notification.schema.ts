import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

export type ApprovalNotificationChannel = 'dingtalk' | 'feishu';
export type ApprovalNotificationStatus = 'pending' | 'processing' | 'sent' | 'dead';

const ID_LENGTH = 128;
const MAX_ATTEMPTS = 12;

/** 审批通知投递记录；与审批状态分离，正文在发送时从固定模板生成。 */
@Schema({ collection: 'approval_notification_deliveries', timestamps: true, versionKey: false, id: false })
export class ApprovalNotificationRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  notificationId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: ID_LENGTH })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: ID_LENGTH })
  instanceId!: string;

  @Prop({ type: Number, required: true, immutable: true, min: 1 })
  aggregateVersion!: number;

  @Prop({ type: String, required: true, immutable: true, maxlength: ID_LENGTH })
  eventType!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: ID_LENGTH })
  recipientActorId!: string;

  @Prop({ type: String, enum: ['dingtalk', 'feishu'], required: true, immutable: true })
  channel!: ApprovalNotificationChannel;

  @Prop({ type: String, enum: ['R1', 'R2'], required: true, immutable: true })
  riskLevel!: 'R1' | 'R2';

  @Prop({ type: String, enum: ['pending', 'processing', 'sent', 'dead'], required: true })
  status!: ApprovalNotificationStatus;

  @Prop({ type: Number, required: true, min: 0, max: MAX_ATTEMPTS })
  attempts!: number;

  @Prop({ type: Number, required: true, default: 0, min: 0 })
  operatorRetryCount!: number;

  @Prop({ type: Date, required: true })
  nextAttemptAt!: Date;

  @Prop({ type: Date, default: null })
  lockedAt!: Date | null;

  @Prop({ type: String, default: null, maxlength: ID_LENGTH })
  lockedBy!: string | null;

  @Prop({ type: String, default: null, maxlength: 256 })
  externalMessageId!: string | null;

  @Prop({ type: String, default: null, maxlength: ID_LENGTH })
  lastErrorCode!: string | null;

  @Prop({ type: Date, default: null })
  sentAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type ApprovalNotificationDocument = HydratedDocument<ApprovalNotificationRecord>;
export const ApprovalNotificationRecordSchema = SchemaFactory.createForClass(ApprovalNotificationRecord);

ApprovalNotificationRecordSchema.pre('validate', function () {
  const record = this as ApprovalNotificationRecord;
  if (record.status === 'processing' && (record.lockedAt === null || record.lockedBy === null)) {
    throw new Error('处理中通知必须持有租约');
  }
  if (record.status !== 'processing' && (record.lockedAt !== null || record.lockedBy !== null)) {
    throw new Error('非处理中通知不能持有租约');
  }
  if (record.status === 'sent' && (record.sentAt === null || record.externalMessageId === null)) {
    throw new Error('已发送通知必须记录平台消息标识');
  }
});

ApprovalNotificationRecordSchema.index({ notificationId: 1 }, { unique: true });
ApprovalNotificationRecordSchema.index(
  { tenantId: 1, instanceId: 1, aggregateVersion: 1, eventType: 1, recipientActorId: 1, channel: 1 },
  { unique: true },
);
ApprovalNotificationRecordSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });
ApprovalNotificationRecordSchema.index({ tenantId: 1, status: 1, updatedAt: 1 });
