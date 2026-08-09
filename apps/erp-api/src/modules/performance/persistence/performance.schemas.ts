import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

import { PERFORMANCE_RATINGS, type PerformanceAssignmentStatus, type PerformanceCycleStatus, type PerformanceRating } from '../domain/performance.js';
const ID = /^[A-Za-z0-9._:-]{1,128}$/; const DATE = /^\d{4}-\d{2}-\d{2}$/; const positive = (value: number) => Number.isSafeInteger(value) && value >= 1; const bps = (value: number | null) => value === null || (Number.isSafeInteger(value) && value >= 0 && value <= 10_000); const coefficientBps = (value: number | null) => value === null || (Number.isSafeInteger(value) && value >= 0 && value <= 30_000);

@Schema({ collection: 'performance_templates', timestamps: true, versionKey: false, id: false })
export class PerformanceTemplateRecord {
  @Prop({ type: String, required: true, immutable: true, match: ID }) id!: string;
  @Prop({ type: String, required: true, immutable: true, match: ID }) tenantId!: string;
  @Prop({ type: String, required: true, minlength: 2, maxlength: 128 }) name!: string;
  @Prop({ type: Number, required: true, validate: { validator: bps } }) okrWeightBps!: number;
  @Prop({ type: Number, required: true, validate: { validator: bps } }) kpiWeightBps!: number;
  @Prop({ type: Number, required: true, validate: { validator: bps } }) competencyWeightBps!: number;
  @Prop({ type: Object, required: true }) thresholds!: { S: number; A: number; B: number; C: number };
  @Prop({ type: Object, required: true }) coefficients!: Record<PerformanceRating, number>;
  @Prop({ type: Number, required: true, validate: { validator: positive } }) version!: number;
  createdAt!: Date; updatedAt!: Date;
}
export type PerformanceTemplateDocument = HydratedDocument<PerformanceTemplateRecord>;
export const PerformanceTemplateRecordSchema = SchemaFactory.createForClass(PerformanceTemplateRecord);
PerformanceTemplateRecordSchema.pre('validate', function validateTemplate() {
  const doc = this as PerformanceTemplateRecord;
  const weights = [doc.okrWeightBps, doc.kpiWeightBps, doc.competencyWeightBps];
  const thresholds = doc.thresholds;
  if (
    weights.some((value) => !bps(value)) ||
    weights.reduce((sum, value) => sum + value, 0) !== 10_000 ||
    !exactBpsRecord(thresholds, ['S', 'A', 'B', 'C']) ||
    !(thresholds.S > thresholds.A && thresholds.A > thresholds.B && thresholds.B > thresholds.C) ||
    !exactNumberRecord(doc.coefficients, PERFORMANCE_RATINGS, coefficientBps)
  ) throw new Error('PERFORMANCE_TEMPLATE_INVARIANT_INVALID');
});
PerformanceTemplateRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });

@Schema({ collection: 'performance_cycles', timestamps: true, versionKey: false, id: false })
export class PerformanceCycleRecord {
  @Prop({ type: String, required: true, immutable: true, match: ID }) id!: string;
  @Prop({ type: String, required: true, immutable: true, match: ID }) tenantId!: string;
  @Prop({ type: String, required: true, minlength: 2, maxlength: 128 }) name!: string;
  @Prop({ type: String, required: true, immutable: true, match: ID }) templateId!: string;
  @Prop({ type: String, required: true, immutable: true, match: DATE }) startDate!: string;
  @Prop({ type: String, required: true, immutable: true, match: DATE }) endDate!: string;
  @Prop({ type: String, required: true, enum: ['draft', 'published', 'self_review', 'manager_review', 'calibration', 'confirmation', 'closed'] }) status!: PerformanceCycleStatus;
  @Prop({ type: Number, required: true, min: 0, max: 10_000 }) assignmentCount!: number;
  @Prop({ type: Number, required: true, validate: { validator: positive } }) version!: number;
  @Prop({ type: Date, default: null }) publishedAt!: Date | null;
  createdAt!: Date; updatedAt!: Date;
}
export type PerformanceCycleDocument = HydratedDocument<PerformanceCycleRecord>;
export const PerformanceCycleRecordSchema = SchemaFactory.createForClass(PerformanceCycleRecord);
PerformanceCycleRecordSchema.pre('validate', function validateCycle() {
  const doc = this as PerformanceCycleRecord;
  const published = doc.status !== 'draft';
  if (
    !validDate(doc.startDate) || !validDate(doc.endDate) || doc.endDate < doc.startDate ||
    (published && (doc.assignmentCount < 1 || doc.publishedAt === null)) ||
    (!published && (doc.assignmentCount !== 0 || doc.publishedAt !== null))
  ) throw new Error('PERFORMANCE_CYCLE_INVARIANT_INVALID');
});
PerformanceCycleRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
PerformanceCycleRecordSchema.index({ tenantId: 1, startDate: -1, status: 1 });

@Schema({ collection: 'performance_assignments', timestamps: true, versionKey: false, id: false })
export class PerformanceAssignmentRecord {
  @Prop({ type: String, required: true, immutable: true, match: ID }) id!: string;
  @Prop({ type: String, required: true, immutable: true, match: ID }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ID }) cycleId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ID }) employeeId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ID }) employmentId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ID }) departmentId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ID }) managerEmployeeId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ID }) hrbpEmployeeId!: string;
  @Prop({ type: String, required: true, enum: ['goal_setting', 'self_review', 'manager_review', 'calibration', 'confirmation', 'confirmed', 'appealed', 'finalized'] }) status!: PerformanceAssignmentStatus;
  @Prop({ type: Number, default: null, validate: { validator: bps } }) selfScoreBps!: number | null;
  @Prop({ type: Number, default: null, validate: { validator: bps } }) managerScoreBps!: number | null;
  @Prop({ type: Number, default: null, validate: { validator: bps } }) calibratedScoreBps!: number | null;
  @Prop({ type: Number, default: null, validate: { validator: bps } }) finalScoreBps!: number | null;
  @Prop({ type: String, default: null, enum: [...PERFORMANCE_RATINGS, null] }) rating!: PerformanceRating | null;
  @Prop({ type: Number, default: null, validate: { validator: coefficientBps } }) coefficientBps!: number | null;
  @Prop({ type: String, default: null, maxlength: 128 }) selfEvidenceRef!: string | null;
  @Prop({ type: String, default: null, maxlength: 128 }) managerEvidenceRef!: string | null;
  @Prop({ type: String, default: null, maxlength: 64 }) calibrationReasonCode!: string | null;
  @Prop({ type: String, default: null, maxlength: 64 }) appealReasonCode!: string | null;
  @Prop({ type: String, default: null, maxlength: 128 }) appealEvidenceRef!: string | null;
  @Prop({ type: Number, required: true, validate: { validator: positive } }) version!: number;
  createdAt!: Date; updatedAt!: Date;
}
export type PerformanceAssignmentDocument = HydratedDocument<PerformanceAssignmentRecord>;
export const PerformanceAssignmentRecordSchema = SchemaFactory.createForClass(PerformanceAssignmentRecord);
PerformanceAssignmentRecordSchema.pre('validate', function validateAssignment() {
  const doc = this as PerformanceAssignmentRecord;
  if (!validAssignmentState(doc)) throw new Error('PERFORMANCE_ASSIGNMENT_INVARIANT_INVALID');
});
PerformanceAssignmentRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
PerformanceAssignmentRecordSchema.index({ tenantId: 1, cycleId: 1, employeeId: 1 }, { unique: true });
PerformanceAssignmentRecordSchema.index({ tenantId: 1, managerEmployeeId: 1, status: 1 });
PerformanceAssignmentRecordSchema.index({ tenantId: 1, hrbpEmployeeId: 1, status: 1 });

@Schema({ collection: 'performance_payroll_snapshots', timestamps: true, versionKey: false, id: false })
export class PerformancePayrollSnapshotRecord {
  @Prop({ type: String, required: true, immutable: true, match: ID }) id!: string;
  @Prop({ type: String, required: true, immutable: true, match: ID }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ID }) assignmentId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ID }) cycleId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ID }) employeeId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ID }) employmentId!: string;
  @Prop({ type: Number, required: true, immutable: true, validate: { validator: positive } }) resultVersion!: number;
  @Prop({ type: String, required: true, immutable: true, enum: PERFORMANCE_RATINGS }) rating!: PerformanceRating;
  @Prop({ type: Number, required: true, immutable: true, validate: { validator: coefficientBps } }) coefficientBps!: number;
  @Prop({ type: Date, required: true, immutable: true }) finalizedAt!: Date;
  @Prop({ type: String, required: true, immutable: true, match: /^[A-Za-z0-9_-]{43}$/ }) digest!: string;
}
export type PerformancePayrollSnapshotDocument = HydratedDocument<PerformancePayrollSnapshotRecord>;
export const PerformancePayrollSnapshotRecordSchema = SchemaFactory.createForClass(PerformancePayrollSnapshotRecord);
PerformancePayrollSnapshotRecordSchema.index({ tenantId: 1, assignmentId: 1 }, { unique: true });
PerformancePayrollSnapshotRecordSchema.index({ tenantId: 1, cycleId: 1, employeeId: 1 }, { unique: true });

function exactBpsRecord(value: unknown, keys: readonly string[]): boolean {
  return exactNumberRecord(value, keys, bps);
}

function exactNumberRecord(value: unknown, keys: readonly string[], validator: (value: number | null) => boolean): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const actual = Reflect.ownKeys(record);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(record, key) && validator(record[key] as number));
}

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day;
}

function validAssignmentState(doc: PerformanceAssignmentRecord): boolean {
  const self = doc.selfScoreBps !== null && doc.selfEvidenceRef !== null;
  const manager = doc.managerScoreBps !== null && doc.managerEvidenceRef !== null;
  const calibrated = doc.calibratedScoreBps !== null && doc.calibrationReasonCode !== null;
  const appealed = doc.appealReasonCode !== null && doc.appealEvidenceRef !== null;
  const final = doc.finalScoreBps !== null && doc.rating !== null && doc.coefficientBps !== null;
  const paired = (doc.selfScoreBps === null) === (doc.selfEvidenceRef === null) &&
    (doc.managerScoreBps === null) === (doc.managerEvidenceRef === null) &&
    (doc.appealReasonCode === null) === (doc.appealEvidenceRef === null);
  if (!paired) return false;
  if (['goal_setting', 'self_review'].includes(doc.status)) return !self && !manager && !calibrated && !appealed && !final;
  if (doc.status === 'manager_review') return self && !manager && !calibrated && !appealed && !final;
  if (doc.status === 'calibration') return self && manager && !calibrated && !appealed && !final;
  if (['confirmation', 'confirmed'].includes(doc.status)) return self && manager && calibrated && !appealed && !final;
  if (doc.status === 'appealed') return self && manager && calibrated && appealed && !final;
  return doc.status === 'finalized' && self && manager && calibrated && final;
}
