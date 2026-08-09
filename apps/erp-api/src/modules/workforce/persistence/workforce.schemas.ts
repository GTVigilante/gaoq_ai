import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const positive = (value: number): boolean => Number.isSafeInteger(value) && value >= 1;

@Schema({ collection: 'workforce_reporting_lines', timestamps: true, versionKey: false, id: false })
export class ReportingLineRecord {
  @Prop({ type: String, required: true, immutable: true, match: ID }) id!: string;
  @Prop({ type: String, required: true, immutable: true, match: ID }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ID }) employeeId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ID }) managerEmployeeId!: string;
  @Prop({ type: String, required: true, immutable: true, match: DATE }) effectiveFrom!: string;
  @Prop({ type: String, default: null, immutable: true, match: DATE }) effectiveTo!: string | null;
  @Prop({ type: Number, required: true, validate: { validator: positive } }) version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}
export type ReportingLineDocument = HydratedDocument<ReportingLineRecord>;
export const ReportingLineRecordSchema = SchemaFactory.createForClass(ReportingLineRecord);
ReportingLineRecordSchema.pre('validate', function validateReportingLine() {
  const doc = this as ReportingLineRecord;
  if (doc.employeeId === doc.managerEmployeeId || !validRange(doc.effectiveFrom, doc.effectiveTo)) {
    throw new Error('WORKFORCE_REPORTING_INVARIANT_INVALID');
  }
});
ReportingLineRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
ReportingLineRecordSchema.index({ tenantId: 1, employeeId: 1, effectiveFrom: -1 });
ReportingLineRecordSchema.index({ tenantId: 1, managerEmployeeId: 1, effectiveFrom: -1 });

@Schema({ collection: 'workforce_hrbp_assignments', timestamps: true, versionKey: false, id: false })
export class HrbpAssignmentRecord {
  @Prop({ type: String, required: true, immutable: true, match: ID }) id!: string;
  @Prop({ type: String, required: true, immutable: true, match: ID }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ID }) departmentId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ID }) primaryEmployeeId!: string;
  @Prop({ type: [String], required: true, default: [], validate: {
    validator: (value: string[]) => value.length <= 3 && new Set(value).size === value.length && value.every((id) => ID.test(id)),
  } }) backupEmployeeIds!: string[];
  @Prop({ type: Boolean, required: true }) inheritToDescendants!: boolean;
  @Prop({ type: String, required: true, immutable: true, match: DATE }) effectiveFrom!: string;
  @Prop({ type: String, default: null, immutable: true, match: DATE }) effectiveTo!: string | null;
  @Prop({ type: Number, required: true, validate: { validator: positive } }) version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}
export type HrbpAssignmentDocument = HydratedDocument<HrbpAssignmentRecord>;
export const HrbpAssignmentRecordSchema = SchemaFactory.createForClass(HrbpAssignmentRecord);
HrbpAssignmentRecordSchema.pre('validate', function validateHrbpAssignment() {
  const doc = this as HrbpAssignmentRecord;
  if (doc.backupEmployeeIds.includes(doc.primaryEmployeeId) || !validRange(doc.effectiveFrom, doc.effectiveTo)) {
    throw new Error('WORKFORCE_HRBP_INVARIANT_INVALID');
  }
});
HrbpAssignmentRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
HrbpAssignmentRecordSchema.index({ tenantId: 1, departmentId: 1, effectiveFrom: -1 });
HrbpAssignmentRecordSchema.index({ tenantId: 1, primaryEmployeeId: 1, effectiveFrom: -1 });

function validRange(from: string, to: string | null): boolean {
  return validDate(from) && (to === null || (validDate(to) && to >= from));
}

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day;
}
