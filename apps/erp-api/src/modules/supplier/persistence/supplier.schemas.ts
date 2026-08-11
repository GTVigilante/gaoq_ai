import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

import {
  restoreSupplierRelationship, SUPPLIER_CAPABILITY_LEVELS, SUPPLIER_LEGAL_FORMS, SUPPLIER_PARTY_KINDS,
  SUPPLIER_QUALIFICATION_TYPES, SUPPLIER_RATE_UNITS, SUPPLIER_RISK_TIERS, SUPPLIER_STATUSES,
  type SupplierRelationship,
} from '../domain/supplier.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const CODE = /^[a-z][a-z0-9_.:-]{1,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FINGERPRINT = /^[A-Za-z0-9._:-]{1,64}\.[A-Za-z0-9_-]{43}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

@Schema({ _id: false, id: false })
export class SupplierCapabilityRecord {
  @Prop({ type: String, required: true, match: CODE }) serviceCategoryCode!: string;
  @Prop({ type: String, required: true, enum: SUPPLIER_CAPABILITY_LEVELS }) level!: string;
  @Prop({ type: String, default: null, match: ID }) evidenceRef!: string | null;
  @Prop({ type: String, default: null, match: DATE }) validUntil!: string | null;
}
const SupplierCapabilityRecordSchema = SchemaFactory.createForClass(SupplierCapabilityRecord);

@Schema({ _id: false, id: false })
export class SupplierRateRecord {
  @Prop({ type: String, required: true, match: CODE }) serviceCategoryCode!: string;
  @Prop({ type: String, required: true, enum: SUPPLIER_RATE_UNITS }) unit!: string;
  @Prop({ type: String, required: true, match: /^(0|[1-9][0-9]{0,14})$/ }) amountMinor!: string;
  @Prop({ type: String, required: true, enum: ['CNY'] }) currency!: 'CNY';
  @Prop({ type: Boolean, required: true }) taxIncluded!: boolean;
  @Prop({ type: String, required: true, match: DATE }) validFrom!: string;
  @Prop({ type: String, default: null, match: DATE }) validUntil!: string | null;
}
const SupplierRateRecordSchema = SchemaFactory.createForClass(SupplierRateRecord);

@Schema({ _id: false, id: false })
export class SupplierQualificationRecord {
  @Prop({ type: String, required: true, enum: SUPPLIER_QUALIFICATION_TYPES }) type!: string;
  @Prop({ type: String, required: true, match: ID }) evidenceRef!: string;
  @Prop({ type: Date, required: true }) verifiedAt!: Date;
  @Prop({ type: String, default: null, match: DATE }) validUntil!: string | null;
}
const SupplierQualificationRecordSchema = SchemaFactory.createForClass(SupplierQualificationRecord);

@Schema({ collection: 'supplier_relationships', timestamps: true, versionKey: false, id: false, strict: 'throw' })
export class SupplierRelationshipRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID }) id!: string;
  @Prop({ type: String, required: true, immutable: true, match: ID }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: /^SUP-[0-9A-HJKMNP-TV-Z]{10}$/ }) supplierNumber!: string;
  @Prop({ type: String, required: true, enum: SUPPLIER_PARTY_KINDS }) partyKind!: string;
  @Prop({ type: String, required: true, enum: SUPPLIER_LEGAL_FORMS }) legalForm!: string;
  @Prop({ type: String, required: true, minlength: 2, maxlength: 128 }) displayName!: string;
  @Prop({ type: String, required: true, match: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ }) identityKeyId!: string;
  @Prop({ type: String, required: true, match: /^[A-Za-z0-9_-]{16}$/ }) identityIv!: string;
  @Prop({ type: String, required: true, minlength: 1, maxlength: 2_731, match: BASE64URL }) identityCiphertext!: string;
  @Prop({ type: String, required: true, match: /^[A-Za-z0-9_-]{22}$/ }) identityAuthTag!: string;
  @Prop({ type: String, required: true, match: FINGERPRINT }) identityFingerprint!: string;
  @Prop({ type: String, required: true, match: /^\*{4}.{2,8}$/u }) identityHint!: string;
  @Prop({ type: String, required: true, match: ID }) ownerEmployeeId!: string;
  @Prop({ type: String, required: true, match: ID }) responsibleDepartmentId!: string;
  @Prop({ type: String, required: true, enum: SUPPLIER_RISK_TIERS }) riskTier!: string;
  @Prop({ type: String, required: true, enum: SUPPLIER_STATUSES }) status!: string;
  @Prop({ type: [SupplierCapabilityRecordSchema], required: true, default: [] }) capabilities!: SupplierCapabilityRecord[];
  @Prop({ type: [SupplierRateRecordSchema], required: true, default: [] }) rates!: SupplierRateRecord[];
  @Prop({ type: [SupplierQualificationRecordSchema], required: true, default: [] }) qualifications!: SupplierQualificationRecord[];
  @Prop({ type: String, default: null, match: ID }) decisionEvidenceRef!: string | null;
  @Prop({ type: String, default: null, match: /^[a-z][a-z0-9_]{2,63}$/ }) statusReasonCode!: string | null;
  @Prop({ type: Number, required: true, min: 1, max: Number.MAX_SAFE_INTEGER }) version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export type SupplierRelationshipDocument = HydratedDocument<SupplierRelationshipRecord>;
export const SupplierRelationshipRecordSchema = SchemaFactory.createForClass(SupplierRelationshipRecord);

SupplierRelationshipRecordSchema.pre('validate', function validateSupplierState() {
  const row = this as SupplierRelationshipRecord;
  if (!(row.createdAt instanceof Date) || !(row.updatedAt instanceof Date)) return;
  restoreSupplierRelationship(toDomain(row));
});
SupplierRelationshipRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
SupplierRelationshipRecordSchema.index({ tenantId: 1, supplierNumber: 1 }, { unique: true });
SupplierRelationshipRecordSchema.index({ tenantId: 1, identityFingerprint: 1 }, { unique: true });
SupplierRelationshipRecordSchema.index({ tenantId: 1, status: 1, responsibleDepartmentId: 1, id: 1 });
SupplierRelationshipRecordSchema.index({ tenantId: 1, 'capabilities.serviceCategoryCode': 1, status: 1, id: 1 });

export function toDomain(row: SupplierRelationshipRecord): SupplierRelationship {
  return restoreSupplierRelationship({
    id: row.id, tenantId: row.tenantId, supplierNumber: row.supplierNumber,
    partyKind: row.partyKind as SupplierRelationship['partyKind'], legalForm: row.legalForm as SupplierRelationship['legalForm'],
    displayName: row.displayName, identityFingerprint: row.identityFingerprint, identityHint: row.identityHint,
    ownerEmployeeId: row.ownerEmployeeId, responsibleDepartmentId: row.responsibleDepartmentId,
    riskTier: row.riskTier as SupplierRelationship['riskTier'],
    status: row.status as SupplierRelationship['status'],
    capabilities: row.capabilities.map((item) => ({ serviceCategoryCode: item.serviceCategoryCode, level: item.level as SupplierRelationship['capabilities'][number]['level'], evidenceRef: item.evidenceRef, validUntil: item.validUntil })),
    rates: row.rates.map((item) => ({ serviceCategoryCode: item.serviceCategoryCode, unit: item.unit as SupplierRelationship['rates'][number]['unit'], amountMinor: item.amountMinor, currency: item.currency, taxIncluded: item.taxIncluded, validFrom: item.validFrom, validUntil: item.validUntil })),
    qualifications: row.qualifications.map((item) => ({ type: item.type as SupplierRelationship['qualifications'][number]['type'], evidenceRef: item.evidenceRef, verifiedAt: item.verifiedAt.toISOString(), validUntil: item.validUntil })),
    decisionEvidenceRef: row.decisionEvidenceRef, statusReasonCode: row.statusReasonCode,
    version: row.version, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  });
}
