import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

import {
  restoreSupplierMember,
  SUPPLIER_MEMBER_PERMISSIONS,
  SUPPLIER_MEMBER_ROLES,
  SUPPLIER_MEMBER_STATUSES,
  type SupplierMemberRelationship,
} from '../domain/supplier-member.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

@Schema({ collection: 'supplier_member_relationships', strict: 'throw', versionKey: false, timestamps: false })
export class SupplierMemberRecord {
  @Prop({ required: true, immutable: true, type: String, match: ULID }) id!: string;
  @Prop({ required: true, immutable: true, type: String, match: ID }) tenantId!: string;
  @Prop({ required: true, immutable: true, type: String, match: ULID }) supplierId!: string;
  @Prop({ required: true, immutable: true, type: String, match: ID }) actorId!: string;
  @Prop({ required: true, immutable: true, type: String, match: ID }) performerRef!: string;
  @Prop({ required: true, type: String, enum: SUPPLIER_MEMBER_ROLES }) role!: string;
  @Prop({ required: true, type: [String], enum: SUPPLIER_MEMBER_PERMISSIONS }) permissions!: string[];
  @Prop({ required: true, type: String, match: ID }) evidenceRef!: string;
  @Prop({ required: true, type: String, match: DATE }) validFrom!: string;
  @Prop({
    default: null,
    type: String,
    validate: { validator: (value: unknown) => value === null || (typeof value === 'string' && DATE.test(value)) },
  }) validUntil!: string | null;
  @Prop({ required: true, type: String, enum: SUPPLIER_MEMBER_STATUSES }) status!: string;
  @Prop({
    default: null,
    type: String,
    validate: {
      validator: (value: unknown) => value === null ||
        (typeof value === 'string' && /^[a-z][a-z0-9_]{2,63}$/u.test(value)),
    },
  }) revokedReasonCode!: string | null;
  @Prop({ required: true, type: Number, min: 1, max: Number.MAX_SAFE_INTEGER }) version!: number;
  @Prop({ required: true, type: Date }) createdAt!: Date;
  @Prop({ required: true, type: Date }) updatedAt!: Date;
}

export type SupplierMemberDocument = HydratedDocument<SupplierMemberRecord>;
export const SupplierMemberSchema = SchemaFactory.createForClass(SupplierMemberRecord);
SupplierMemberSchema.pre('validate', function validateSupplierMemberState() {
  const row = this as SupplierMemberRecord;
  if (!(row.createdAt instanceof Date) || !(row.updatedAt instanceof Date)) return;
  toSupplierMember(row);
});
SupplierMemberSchema.index({ tenantId: 1, id: 1 }, { unique: true, name: 'uniq_tenant_supplier_member_id' });
SupplierMemberSchema.index(
  { tenantId: 1, supplierId: 1, actorId: 1 },
  { unique: true, partialFilterExpression: { status: 'active' }, name: 'uniq_active_supplier_actor' },
);
SupplierMemberSchema.index(
  { tenantId: 1, supplierId: 1, performerRef: 1 },
  { unique: true, partialFilterExpression: { status: 'active' }, name: 'uniq_active_supplier_performer' },
);
SupplierMemberSchema.index({ tenantId: 1, actorId: 1, status: 1, id: 1 }, { name: 'idx_tenant_supplier_actor' });
SupplierMemberSchema.index({ tenantId: 1, supplierId: 1, status: 1, id: 1 }, { name: 'idx_tenant_supplier_members' });

export function toSupplierMember(row: SupplierMemberRecord): SupplierMemberRelationship {
  return restoreSupplierMember({
    id: row.id, tenantId: row.tenantId, supplierId: row.supplierId,
    actorId: row.actorId, performerRef: row.performerRef,
    role: row.role as SupplierMemberRelationship['role'],
    permissions: row.permissions as SupplierMemberRelationship['permissions'],
    evidenceRef: row.evidenceRef, validFrom: row.validFrom, validUntil: row.validUntil,
    status: row.status as SupplierMemberRelationship['status'],
    revokedReasonCode: row.revokedReasonCode, version: row.version,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  });
}
