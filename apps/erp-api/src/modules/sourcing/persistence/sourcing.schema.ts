import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';
import { restoreSourcing, SOURCING_MODES, SOURCING_STATUSES, type SourcingRequest } from '../domain/sourcing.js';

@Schema({ collection: 'sourcing_requests', strict: 'throw', versionKey: false, timestamps: false })
export class SourcingRequestRecord {
  @Prop({ required: true, type: String }) id!: string; @Prop({ required: true, type: String }) tenantId!: string;
  @Prop({ required: true, type: String }) requestNumber!: string; @Prop({ required: true, type: String }) title!: string;
  @Prop({ required: true, type: String }) serviceCategoryCode!: string; @Prop({ required: true, enum: SOURCING_MODES, type: String }) mode!: string;
  @Prop({ required: true, type: String }) budgetCeilingMinor!: string; @Prop({ required: true, enum: ['CNY'], type: String }) currency!: string;
  @Prop({ required: true, type: String }) ownerEmployeeId!: string; @Prop({ required: true, type: String }) responsibleDepartmentId!: string;
  @Prop({ required: true, type: Date }) responseDueAt!: Date; @Prop({ default: [], type: [String] }) invitedSupplierIds!: string[];
  @Prop({ default: [], type: [{ _id: false, supplierId: { type: String, required: true }, quotationMinor: { type: String, required: true }, proposalRef: { type: String, required: true }, eligibilityDigest: { type: String, required: true }, supplierVersion: { type: Number, required: true }, submittedAt: { type: Date, required: true } }] }) responses!: unknown[];
  @Prop({ default: null, type: String }) approvalEvidenceRef!: string | null;
  @Prop({ default: null, type: { _id: false, supplierId: String, agreedAmountMinor: String, decisionEvidenceRef: String, eligibilityDigest: String, supplierVersion: Number, awardedAt: Date } }) award!: unknown;
  @Prop({ required: true, enum: SOURCING_STATUSES, type: String }) status!: string; @Prop({ default: null, type: String }) statusReasonCode!: string | null;
  @Prop({ required: true, type: Number }) version!: number; @Prop({ required: true, type: Date }) createdAt!: Date; @Prop({ required: true, type: Date }) updatedAt!: Date;
}
export type SourcingRequestDocument = HydratedDocument<SourcingRequestRecord>;
export const SourcingRequestSchema = SchemaFactory.createForClass(SourcingRequestRecord);
SourcingRequestSchema.pre('validate', function validateSourcingState() {
  if (!(this.responseDueAt instanceof Date) || !(this.createdAt instanceof Date) ||
      !(this.updatedAt instanceof Date)) return;
  toSourcingDomain(this as unknown as Record<string, unknown>);
});
SourcingRequestSchema.index({ tenantId: 1, id: 1 }, { unique: true, name: 'uniq_tenant_sourcing_id' });
SourcingRequestSchema.index({ tenantId: 1, requestNumber: 1 }, { unique: true, name: 'uniq_tenant_sourcing_number' });
SourcingRequestSchema.index({ tenantId: 1, status: 1, responsibleDepartmentId: 1, id: 1 }, { name: 'idx_tenant_sourcing_work_queue' });
SourcingRequestSchema.index({ tenantId: 1, serviceCategoryCode: 1, status: 1, id: 1 }, { name: 'idx_tenant_sourcing_service' });

export function toSourcingDomain(row: Record<string, unknown>): SourcingRequest {
  const responses = Array.isArray(row.responses) ? row.responses.map((entry) => {
    const value = plain(entry); return {
      supplierId: value.supplierId, quotationMinor: value.quotationMinor,
      proposalRef: value.proposalRef, eligibilityDigest: value.eligibilityDigest,
      supplierVersion: value.supplierVersion, submittedAt: date(value.submittedAt),
    };
  }) : row.responses;
  const awardRecord = row.award === null ? null : plain(row.award);
  const award = awardRecord === null ? null : {
    supplierId: awardRecord.supplierId, agreedAmountMinor: awardRecord.agreedAmountMinor,
    decisionEvidenceRef: awardRecord.decisionEvidenceRef,
    eligibilityDigest: awardRecord.eligibilityDigest,
    supplierVersion: awardRecord.supplierVersion, awardedAt: date(awardRecord.awardedAt),
  };
  return restoreSourcing({
    id: row.id, tenantId: row.tenantId, requestNumber: row.requestNumber,
    title: row.title, serviceCategoryCode: row.serviceCategoryCode, mode: row.mode,
    budgetCeilingMinor: row.budgetCeilingMinor, currency: row.currency,
    ownerEmployeeId: row.ownerEmployeeId,
    responsibleDepartmentId: row.responsibleDepartmentId,
    responseDueAt: date(row.responseDueAt), invitedSupplierIds: row.invitedSupplierIds,
    responses, approvalEvidenceRef: row.approvalEvidenceRef, award,
    status: row.status, statusReasonCode: row.statusReasonCode, version: row.version,
    createdAt: date(row.createdAt), updatedAt: date(row.updatedAt),
  } as SourcingRequest);
}
function date(value: unknown): string { if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error('SOURCING_PERSISTED_TIME_INVALID'); return value.toISOString(); }
function plain(value: unknown): Record<string, unknown> { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('SOURCING_PERSISTED_SHAPE_INVALID'); return value as Record<string, unknown>; }
