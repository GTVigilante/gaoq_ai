import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

export type McpApprovalOperation = 'approval.submit' | 'approval.withdraw' | 'approval.decide';
export type McpConfirmationStatus =
  | 'pending_confirmation'
  | 'ready'
  | 'executing'
  | 'executed'
  | 'expired';

/** MCP 高风险操作确认记录；只保存审批命令标识，不保存表单或平台凭据。 */
@Schema({ collection: 'mcp_operation_confirmations', timestamps: true, versionKey: false, id: false })
export class McpConfirmationRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  operationId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  actorId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  clientId!: string;

  @Prop({
    type: String,
    enum: ['approval.submit', 'approval.withdraw', 'approval.decide'],
    required: true,
    immutable: true,
  })
  operation!: McpApprovalOperation;

  @Prop({ type: String, enum: ['R1', 'R2'], required: true, immutable: true })
  riskLevel!: 'R1' | 'R2';

  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  prepareKey!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 8_192 })
  commandJson!: string;

  @Prop({ type: String, required: true, immutable: true, minlength: 43, maxlength: 43 })
  digest!: string;

  @Prop({
    type: String,
    enum: ['pending_confirmation', 'ready', 'executing', 'executed', 'expired'],
    required: true,
  })
  status!: McpConfirmationStatus;

  @Prop({ type: String, default: null, minlength: 43, maxlength: 43 })
  confirmationCredentialHash!: string | null;

  @Prop({ type: Date, default: null })
  confirmedAt!: Date | null;

  @Prop({ type: Date, default: null })
  executionLockedAt!: Date | null;

  @Prop({ type: Object, default: null })
  executionResult!: Record<string, unknown> | null;

  @Prop({ type: Date, required: true, immutable: true })
  expiresAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export type McpConfirmationDocument = HydratedDocument<McpConfirmationRecord>;
export const McpConfirmationRecordSchema = SchemaFactory.createForClass(McpConfirmationRecord);

McpConfirmationRecordSchema.pre('validate', function () {
  const record = this as McpConfirmationRecord;
  if (record.status === 'ready' && record.confirmationCredentialHash === null) {
    throw new Error('待执行确认必须包含凭据摘要');
  }
  if (record.status === 'executing' && (
    record.confirmationCredentialHash === null || record.executionLockedAt === null
  )) throw new Error('执行中确认必须包含凭据摘要和租约');
  if (record.status === 'executed' && record.executionResult === null) {
    throw new Error('已执行确认必须包含结果快照');
  }
  if (record.status !== 'executing' && record.executionLockedAt !== null) {
    throw new Error('非执行中确认不能持有租约');
  }
});

McpConfirmationRecordSchema.index({ operationId: 1 }, { unique: true });
McpConfirmationRecordSchema.index(
  { tenantId: 1, actorId: 1, clientId: 1, operation: 1, prepareKey: 1 },
  { unique: true },
);
McpConfirmationRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });
McpConfirmationRecordSchema.index({ status: 1, expiresAt: 1 });
