import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

const SHA256_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/._:-]{0,511}$/;

@Schema({ _id: false, id: false })
export class ESignEvidenceArtifactRecord {
  @Prop({ type: String, required: true, immutable: true, match: SHA256_PATTERN })
  providerFileIdHash!: string;

  @Prop({ type: String, required: true, immutable: true, match: SHA256_PATTERN })
  sha256!: string;

  @Prop({ type: Number, required: true, immutable: true, min: 5, max: 50 * 1024 * 1024 })
  sizeBytes!: number;

  @Prop({ type: String, enum: ['application/pdf'], required: true, immutable: true })
  contentType!: 'application/pdf';

  @Prop({ type: String, required: true, immutable: true, match: SAFE_REFERENCE_PATTERN })
  objectRef!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  archiveReceiptId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  malwareScanEvidenceId!: string;

  @Prop({ type: String, required: true, immutable: true, match: SHA256_PATTERN })
  providerVerificationDigest!: string;

  @Prop({ type: Number, required: true, immutable: true, min: 1, max: 100 })
  signatureCount!: number;
}

const ESignEvidenceArtifactRecordSchema = SchemaFactory.createForClass(ESignEvidenceArtifactRecord);

/** eSign 完成证据账本；只保存摘要和 WORM 引用，不保存 PDF、短链或证书原文。 */
@Schema({ collection: 'integration_esign_evidence', timestamps: true, versionKey: false, id: false })
export class ESignEvidenceRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  id!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  flowId!: string;

  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  offerId!: string;

  @Prop({ type: String, enum: ['esign_cn'], required: true, immutable: true })
  provider!: 'esign_cn';

  @Prop({ type: String, required: true, immutable: true, match: SHA256_PATTERN })
  externalFlowIdHash!: string;

  @Prop({ type: [ESignEvidenceArtifactRecordSchema], required: true, immutable: true })
  artifacts!: ESignEvidenceArtifactRecord[];

  @Prop({ type: String, required: true, immutable: true, match: SHA256_PATTERN })
  proofHash!: string;

  @Prop({ type: Date, required: true, immutable: true })
  archivedAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export type ESignEvidenceDocument = HydratedDocument<ESignEvidenceRecord>;
export const ESignEvidenceRecordSchema = SchemaFactory.createForClass(ESignEvidenceRecord);

ESignEvidenceRecordSchema.pre('validate', function () {
  const record = this as ESignEvidenceRecord;
  if (record.artifacts.length < 1 || record.artifacts.length > 50) {
    throw new Error('eSign 证据必须包含 1..50 个归档文件');
  }
  if (new Set(record.artifacts.map((artifact) => artifact.providerFileIdHash)).size !== record.artifacts.length) {
    throw new Error('eSign 证据文件不得重复');
  }
});

ESignEvidenceRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
ESignEvidenceRecordSchema.index({ tenantId: 1, flowId: 1 }, { unique: true });
ESignEvidenceRecordSchema.index({ tenantId: 1, offerId: 1 }, { unique: true });
ESignEvidenceRecordSchema.index({ tenantId: 1, proofHash: 1 }, { unique: true });
