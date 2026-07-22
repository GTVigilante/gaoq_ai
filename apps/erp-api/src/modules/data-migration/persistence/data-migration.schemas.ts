import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

import {
  DATA_MIGRATION_ENTITY_TYPES,
  DATA_MIGRATION_SCOPES,
  type DataMigrationEntityType,
  type DataMigrationScope,
} from '../data-migration-contract.js';

const HASH = /^[A-Za-z0-9_-]{43}$/;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

@Schema({ collection: 'data_migration_runs', timestamps: true, versionKey: false, id: false })
export class DataMigrationRunRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: SOURCE_ID }) sourceSystem!: string;
  @Prop({ type: String, required: true, immutable: true, match: SOURCE_ID }) sourceRunId!: string;
  @Prop({ type: String, required: true, immutable: true, enum: ['full', 'incremental'] })
  mode!: 'full' | 'incremental';
  @Prop({ type: String, required: true, immutable: true, enum: DATA_MIGRATION_SCOPES })
  scope!: DataMigrationScope;
  @Prop({ type: Number, required: true, immutable: true, min: 0, max: 10_000_000 })
  expectedSourceCount!: number;
  @Prop({ type: String, required: true, immutable: true, match: HASH })
  expectedSourceChecksum!: string;
  @Prop({ type: String, required: true, match: HASH }) sourceChecksum!: string;
  @Prop({ type: String, required: true, match: HASH }) targetChecksum!: string;
  @Prop({ type: Number, required: true, min: 0 }) checkpoint!: number;
  @Prop({ type: String, required: true, enum: ['running', 'completed', 'failed'] })
  status!: 'running' | 'completed' | 'failed';
  @Prop({ type: Date, default: null }) completedAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}
export type DataMigrationRunDocument = HydratedDocument<DataMigrationRunRecord>;
export const DataMigrationRunRecordSchema = SchemaFactory.createForClass(DataMigrationRunRecord);
DataMigrationRunRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
DataMigrationRunRecordSchema.index(
  { tenantId: 1, sourceSystem: 1, sourceRunId: 1 }, { unique: true },
);
DataMigrationRunRecordSchema.index({ tenantId: 1, sourceSystem: 1, createdAt: -1 });

@Schema({ collection: 'data_migration_items', timestamps: true, versionKey: false, id: false })
export class DataMigrationItemRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) runId!: string;
  @Prop({ type: Number, required: true, immutable: true, min: 1 }) sequence!: number;
  @Prop({ type: String, required: true, immutable: true, match: SOURCE_ID }) sourceRecordId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 64 }) sourceVersion!: string;
  @Prop({ type: String, required: true, immutable: true, enum: DATA_MIGRATION_ENTITY_TYPES })
  entityType!: DataMigrationEntityType;
  @Prop({ type: String, required: true, immutable: true, match: HASH }) payloadHash!: string;
  @Prop({ type: String, required: true, immutable: true, match: HASH }) sourceFactHash!: string;
  @Prop({ type: String, required: true, enum: ['applied', 'duplicate', 'rejected'] })
  status!: 'applied' | 'duplicate' | 'rejected';
  @Prop({ type: String, default: null, maxlength: 128 }) targetId!: string | null;
  @Prop({ type: Number, default: null, min: 1 }) targetVersion!: number | null;
  @Prop({ type: String, default: null, match: HASH }) targetHash!: string | null;
  @Prop({ type: String, default: null, maxlength: 96 }) rejectionCode!: string | null;
  @Prop({ type: Number, required: true, min: 0 }) associationCount!: number;
  @Prop({ type: Number, required: true, min: 0 }) attachmentCount!: number;
  createdAt!: Date;
  updatedAt!: Date;
}
export type DataMigrationItemDocument = HydratedDocument<DataMigrationItemRecord>;
export const DataMigrationItemRecordSchema = SchemaFactory.createForClass(DataMigrationItemRecord);
DataMigrationItemRecordSchema.index({ tenantId: 1, runId: 1, sequence: 1 }, { unique: true });
DataMigrationItemRecordSchema.index({ tenantId: 1, runId: 1, status: 1 });

@Schema({ collection: 'data_migration_mappings', timestamps: true, versionKey: false, id: false })
export class DataMigrationMappingRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: SOURCE_ID }) sourceSystem!: string;
  @Prop({ type: String, required: true, immutable: true, enum: DATA_MIGRATION_ENTITY_TYPES })
  entityType!: DataMigrationEntityType;
  @Prop({ type: String, required: true, immutable: true, match: SOURCE_ID }) sourceRecordId!: string;
  @Prop({ type: String, required: true, maxlength: 64 }) sourceVersion!: string;
  @Prop({ type: String, required: true, match: HASH }) payloadHash!: string;
  @Prop({ type: String, required: true, maxlength: 128 }) targetId!: string;
  @Prop({ type: Number, required: true, min: 1 }) targetVersion!: number;
  @Prop({ type: String, required: true, match: HASH }) targetHash!: string;
  @Prop({ type: String, required: true, match: ULID_PATTERN }) lastRunId!: string;
  @Prop({ type: Number, required: true, min: 1 }) lastSequence!: number;
  createdAt!: Date;
  updatedAt!: Date;
}
export type DataMigrationMappingDocument = HydratedDocument<DataMigrationMappingRecord>;
export const DataMigrationMappingRecordSchema = SchemaFactory.createForClass(DataMigrationMappingRecord);
DataMigrationMappingRecordSchema.index(
  { tenantId: 1, sourceSystem: 1, entityType: 1, sourceRecordId: 1 }, { unique: true },
);

@Schema({ collection: 'data_migration_associations', timestamps: true, versionKey: false, id: false })
export class DataMigrationAssociationRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) runId!: string;
  @Prop({ type: Number, required: true, immutable: true, min: 1 }) sequence!: number;
  @Prop({
    type: String,
    required: true,
    immutable: true,
    enum: [
      'parent_department', 'department', 'primary_department', 'position', 'job_level',
      'employee',
      'created_by', 'updated_by', 'approved_by',
      'fixed_approver', 'condition_employee', 'condition_department',
      'initiator',
      'template',
      'declared_reference',
    ],
  })
  relationship!:
    | 'parent_department'
    | 'department'
    | 'primary_department'
    | 'position'
    | 'job_level'
    | 'employee'
    | 'created_by'
    | 'updated_by'
    | 'approved_by'
    | 'fixed_approver'
    | 'condition_employee'
    | 'condition_department'
    | 'initiator'
    | 'template'
    | 'declared_reference';
  @Prop({ type: String, required: true, immutable: true, match: SOURCE_ID })
  sourceAssociationId!: string;
  @Prop({ type: String, default: null, maxlength: 128 }) targetId!: string | null;
  @Prop({ type: String, required: true, enum: ['resolved', 'missing'] })
  status!: 'resolved' | 'missing';
  createdAt!: Date;
  updatedAt!: Date;
}
export type DataMigrationAssociationDocument = HydratedDocument<DataMigrationAssociationRecord>;
export const DataMigrationAssociationRecordSchema = SchemaFactory.createForClass(
  DataMigrationAssociationRecord,
);
DataMigrationAssociationRecordSchema.index(
  { tenantId: 1, runId: 1, sequence: 1, relationship: 1, sourceAssociationId: 1 },
  { unique: true },
);
DataMigrationAssociationRecordSchema.index({ tenantId: 1, runId: 1, status: 1 });

@Schema({ collection: 'data_migration_attachments', timestamps: true, versionKey: false, id: false })
export class DataMigrationAttachmentRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) id!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 128 }) tenantId!: string;
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN }) runId!: string;
  @Prop({ type: Number, required: true, immutable: true, min: 1 }) sequence!: number;
  @Prop({ type: String, required: true, immutable: true, match: SOURCE_ID })
  sourceAttachmentId!: string;
  @Prop({ type: String, required: true, immutable: true, match: HASH }) checksum!: string;
  @Prop({ type: String, required: true, enum: ['pending', 'processing', 'verified', 'rejected'] })
  status!: 'pending' | 'processing' | 'verified' | 'rejected';
  @Prop({ type: Number, required: true, min: 0, max: 20 }) attempts!: number;
  @Prop({ type: Date, default: null }) processingStartedAt!: Date | null;
  @Prop({ type: String, default: null, maxlength: 256 }) targetEvidenceId!: string | null;
  @Prop({ type: String, default: null, maxlength: 96 }) rejectionCode!: string | null;
  createdAt!: Date;
  updatedAt!: Date;
}
export type DataMigrationAttachmentDocument = HydratedDocument<DataMigrationAttachmentRecord>;
export const DataMigrationAttachmentRecordSchema = SchemaFactory.createForClass(
  DataMigrationAttachmentRecord,
);
DataMigrationAttachmentRecordSchema.pre('validate', function validateAttachmentState() {
  if ((this.status === 'processing') !== (this.processingStartedAt !== null)) {
    this.invalidate('processingStartedAt', 'processing 状态必须持有执行租约');
  }
  if ((this.status === 'verified') !== (this.targetEvidenceId !== null)) {
    this.invalidate('targetEvidenceId', 'verified 状态必须持有目标证据');
  }
  if ((this.status === 'rejected') !== (this.rejectionCode !== null)) {
    this.invalidate('rejectionCode', 'rejected 状态必须持有拒绝码');
  }
});
DataMigrationAttachmentRecordSchema.index(
  { tenantId: 1, runId: 1, sourceAttachmentId: 1 }, { unique: true },
);
DataMigrationAttachmentRecordSchema.index(
  { tenantId: 1, runId: 1, sequence: 1, sourceAttachmentId: 1 },
);
DataMigrationAttachmentRecordSchema.index({ tenantId: 1, runId: 1, status: 1 });
DataMigrationAttachmentRecordSchema.index({
  tenantId: 1, runId: 1, status: 1, processingStartedAt: 1,
  attempts: 1, sequence: 1, sourceAttachmentId: 1,
});
