import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const VERSION_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const SHIFT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const LOCAL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** 版本化班次规则只追加；治理证据和规则参数共同进入月结摘要。 */
@Schema({
  collection: 'attendance_shift_rules',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class AttendanceShiftRuleRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 64, match: VERSION_PATTERN })
  rulesetVersion!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 32, match: SHIFT_CODE_PATTERN })
  shiftCode!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 64 })
  timeZone!: string;
  @Prop({ type: String, required: true, immutable: true, match: LOCAL_TIME_PATTERN })
  startLocalTime!: string;
  @Prop({ type: String, required: true, immutable: true, match: LOCAL_TIME_PATTERN })
  endLocalTime!: string;
  @Prop({ type: [{ type: Number, min: 1, max: 7 }], required: true, immutable: true })
  workdays!: number[];
  @Prop({ type: Number, required: true, immutable: true, min: 1, max: 1_440 })
  plannedMinutes!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 0, max: 180 })
  lateGraceMinutes!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 0, max: 180 })
  earlyLeaveGraceMinutes!: number;
  @Prop({ type: Number, required: true, immutable: true, min: 0, max: 360 })
  crossMidnightPunchOutGraceMinutes!: number;
  @Prop({ type: String, required: true, immutable: true, match: DATE_PATTERN })
  effectiveFrom!: string;
  @Prop({ type: String, default: null, immutable: true, match: DATE_PATTERN })
  effectiveTo!: string | null;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  governanceEvidenceId!: string;
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN })
  evidenceChecksum!: string;
  createdAt!: Date;
  updatedAt!: Date;
}

export type AttendanceShiftRuleDocument = HydratedDocument<AttendanceShiftRuleRecord>;
export const AttendanceShiftRuleRecordSchema =
  SchemaFactory.createForClass(AttendanceShiftRuleRecord);
AttendanceShiftRuleRecordSchema.pre('validate', function () {
  const record = this as AttendanceShiftRuleRecord;
  if (
    record.workdays.length === 0 ||
    new Set(record.workdays).size !== record.workdays.length ||
    (record.effectiveTo !== null && record.effectiveTo < record.effectiveFrom)
  ) throw new Error('考勤班次规则组合约束非法');
});
AttendanceShiftRuleRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
AttendanceShiftRuleRecordSchema.index(
  { tenantId: 1, rulesetVersion: 1, shiftCode: 1 },
  { unique: true },
);
AttendanceShiftRuleRecordSchema.index(
  { tenantId: 1, rulesetVersion: 1, effectiveFrom: 1, effectiveTo: 1 },
);

/** 员工排班引用不可变规则；重排班必须追加新的、不重叠的有效区间。 */
@Schema({
  collection: 'attendance_shift_assignments',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class AttendanceShiftAssignmentRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  employeeId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  shiftRuleId!: string;
  @Prop({ type: String, required: true, immutable: true, enum: ['dingtalk', 'feishu'] })
  providerCode!: 'dingtalk' | 'feishu';
  @Prop({ type: String, required: true, immutable: true, match: DATE_PATTERN })
  effectiveFrom!: string;
  @Prop({ type: String, default: null, immutable: true, match: DATE_PATTERN })
  effectiveTo!: string | null;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  governanceEvidenceId!: string;
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN })
  evidenceChecksum!: string;
  createdAt!: Date;
  updatedAt!: Date;
}

export type AttendanceShiftAssignmentDocument =
  HydratedDocument<AttendanceShiftAssignmentRecord>;
export const AttendanceShiftAssignmentRecordSchema =
  SchemaFactory.createForClass(AttendanceShiftAssignmentRecord);
AttendanceShiftAssignmentRecordSchema.pre('validate', function () {
  const record = this as AttendanceShiftAssignmentRecord;
  if (record.effectiveTo !== null && record.effectiveTo < record.effectiveFrom) {
    throw new Error('考勤排班有效区间非法');
  }
});
AttendanceShiftAssignmentRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
AttendanceShiftAssignmentRecordSchema.index(
  { tenantId: 1, employeeId: 1, effectiveFrom: 1 },
  { unique: true },
);
AttendanceShiftAssignmentRecordSchema.index(
  { tenantId: 1, employeeId: 1, effectiveFrom: 1, effectiveTo: 1 },
);

/**
 * 排班并发串行化守卫不是业务事实；同一员工的每次排班登记都在事务内递增，
 * 让不同幂等键的并发区间写入产生写冲突并重新执行重叠校验。
 */
@Schema({
  collection: 'attendance_shift_assignment_guards',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class AttendanceShiftAssignmentGuardRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  employeeId!: string;
  @Prop({ type: Number, required: true, min: 1 })
  revision!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export type AttendanceShiftAssignmentGuardDocument =
  HydratedDocument<AttendanceShiftAssignmentGuardRecord>;
export const AttendanceShiftAssignmentGuardRecordSchema =
  SchemaFactory.createForClass(AttendanceShiftAssignmentGuardRecord);
AttendanceShiftAssignmentGuardRecordSchema.index(
  { tenantId: 1, employeeId: 1 },
  { unique: true },
);

/** Provider 覆盖证明不保存游标或外部员工标识，只保存水位和确定性摘要。 */
@Schema({
  collection: 'attendance_provider_coverages',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class AttendanceProviderCoverageRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  employeeId!: string;
  @Prop({ type: String, required: true, immutable: true, enum: ['dingtalk', 'feishu'] })
  providerCode!: 'dingtalk' | 'feishu';
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  providerStateId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  providerMappingId!: string;
  @Prop({ type: String, required: true, immutable: true, match: MONTH_PATTERN })
  month!: string;
  @Prop({ type: String, required: true, immutable: true, match: DATE_PATTERN })
  throughBusinessDate!: string;
  @Prop({ type: Date, required: true, immutable: true })
  sourceCutoffAt!: Date;
  @Prop({ type: String, required: true, immutable: true, match: HASH_PATTERN })
  evidenceChecksum!: string;
  createdAt!: Date;
  updatedAt!: Date;
}

export type AttendanceProviderCoverageDocument =
  HydratedDocument<AttendanceProviderCoverageRecord>;
export const AttendanceProviderCoverageRecordSchema =
  SchemaFactory.createForClass(AttendanceProviderCoverageRecord);
AttendanceProviderCoverageRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
AttendanceProviderCoverageRecordSchema.index(
  {
    tenantId: 1,
    employeeId: 1,
    providerCode: 1,
    month: 1,
    providerStateId: 1,
    providerMappingId: 1,
    sourceCutoffAt: 1,
  },
  { unique: true },
);
AttendanceProviderCoverageRecordSchema.index(
  { tenantId: 1, employeeId: 1, month: 1, sourceCutoffAt: -1 },
);
