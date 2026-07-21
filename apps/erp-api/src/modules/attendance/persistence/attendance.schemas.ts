import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BLIND_INDEX_PATTERN = /^[A-Za-z0-9._-]{1,64}\.[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const FACT_TYPES = ['punch_in', 'punch_out', 'shift', 'leave', 'overtime', 'travel'] as const;

abstract class ProtectedRecord {
  @Prop({ type: String, required: true, maxlength: 64, match: ID_PATTERN }) dataKeyId!: string;
  @Prop({ type: String, required: true, maxlength: 32, match: BASE64URL_PATTERN }) dataIv!: string;
  @Prop({ type: String, required: true, maxlength: 349_526, match: BASE64URL_PATTERN })
  dataCiphertext!: string;
  @Prop({ type: String, required: true, minlength: 22, maxlength: 22, match: BASE64URL_PATTERN })
  dataAuthTag!: string;
}

/** 上游考勤事实只追加；发生时间、设备/地点衍生字段和分钟影响均只保存在密文。 */
@Schema({ collection: 'attendance_source_facts', timestamps: true, versionKey: false, id: false })
export class AttendanceSourceFactRecord extends ProtectedRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  employeeId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  providerCode!: string;
  @Prop({ type: String, required: true, immutable: true, enum: FACT_TYPES })
  factType!: typeof FACT_TYPES[number];
  @Prop({ type: String, required: true, immutable: true, match: DATE_PATTERN }) businessDate!: string;
  @Prop({ type: Date, required: true, immutable: true }) sourceObservedAt!: Date;
  @Prop({ type: [{ type: String, match: BLIND_INDEX_PATTERN }], required: true, immutable: true })
  sourceEventBlindIndexes!: string[];
  createdAt!: Date;
  updatedAt!: Date;
}
export type AttendanceSourceFactDocument = HydratedDocument<AttendanceSourceFactRecord>;
export const AttendanceSourceFactRecordSchema = SchemaFactory.createForClass(AttendanceSourceFactRecord);
AttendanceSourceFactRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
AttendanceSourceFactRecordSchema.index(
  { tenantId: 1, sourceEventBlindIndexes: 1 }, { unique: true },
);
AttendanceSourceFactRecordSchema.index({ tenantId: 1, employeeId: 1, businessDate: 1 });
AttendanceSourceFactRecordSchema.index({ tenantId: 1, sourceObservedAt: 1 });

/** 审批通过后的替换影响只追加，不覆盖源事实。 */
@Schema({ collection: 'attendance_corrections', timestamps: true, versionKey: false, id: false })
export class AttendanceCorrectionRecord extends ProtectedRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  employeeId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  sourceFactId!: string;
  @Prop({ type: String, required: true, immutable: true, match: DATE_PATTERN }) businessDate!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  approvalInstanceId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  approvalEvidenceId!: string;
  @Prop({ type: Date, required: true, immutable: true }) approvedAt!: Date;
  createdAt!: Date;
  updatedAt!: Date;
}
export type AttendanceCorrectionDocument = HydratedDocument<AttendanceCorrectionRecord>;
export const AttendanceCorrectionRecordSchema = SchemaFactory.createForClass(AttendanceCorrectionRecord);
AttendanceCorrectionRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
AttendanceCorrectionRecordSchema.index({ tenantId: 1, sourceFactId: 1 }, { unique: true });
AttendanceCorrectionRecordSchema.index({ tenantId: 1, approvalInstanceId: 1 }, { unique: true });
AttendanceCorrectionRecordSchema.index({ tenantId: 1, employeeId: 1, businessDate: 1 });

/** 月结汇总可供授权主体读取；逐日明细仍保持 L4 密文。 */
@Schema({ collection: 'attendance_monthly_snapshots', timestamps: true, versionKey: false, id: false })
export class AttendanceMonthlySnapshotRecord extends ProtectedRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  employeeId!: string;
  @Prop({ type: String, required: true, immutable: true, match: MONTH_PATTERN }) month!: string;
  @Prop({ type: Number, required: true, immutable: true, min: 1 }) snapshotVersion!: number;
  @Prop({ type: String, required: true, immutable: true, maxlength: 64, match: ID_PATTERN })
  rulesetVersion!: string;
  @Prop({ type: Date, required: true, immutable: true }) sourceCutoffAt!: Date;
  @Prop({ type: Number, required: true, immutable: true, min: 0 }) workedMinutes!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 0 }) leaveMinutes!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 0 }) overtimeMinutes!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 0 }) absentMinutes!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 0 }) sourceFactCount!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 0 }) correctionCount!: number;
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN }) snapshotHash!: string;
  @Prop({ type: String, required: true, enum: ['active', 'superseded'] })
  status!: 'active' | 'superseded';
  @Prop({ type: String, default: null, immutable: true, maxlength: 128, match: ID_PATTERN })
  previousSnapshotId!: string | null;
  @Prop({ type: String, default: null, immutable: true, maxlength: 128, match: ID_PATTERN })
  supersessionEvidenceId!: string | null;
  @Prop({ type: Date, required: true, immutable: true }) closedAt!: Date;
  createdAt!: Date;
  updatedAt!: Date;
}
export type AttendanceMonthlySnapshotDocument = HydratedDocument<AttendanceMonthlySnapshotRecord>;
export const AttendanceMonthlySnapshotRecordSchema =
  SchemaFactory.createForClass(AttendanceMonthlySnapshotRecord);
AttendanceMonthlySnapshotRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
AttendanceMonthlySnapshotRecordSchema.index(
  { tenantId: 1, employeeId: 1, month: 1, snapshotVersion: 1 }, { unique: true },
);
AttendanceMonthlySnapshotRecordSchema.index(
  { tenantId: 1, employeeId: 1, month: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);
AttendanceMonthlySnapshotRecordSchema.index(
  { tenantId: 1, previousSnapshotId: 1 },
  { unique: true, partialFilterExpression: { previousSnapshotId: { $type: 'string' } } },
);
