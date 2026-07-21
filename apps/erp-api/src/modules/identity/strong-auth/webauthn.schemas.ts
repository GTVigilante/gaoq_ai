import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

const TRANSPORTS = ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'] as const;

/** 租户内人员 WebAuthn 凭据；仅保存公钥、计数器和非秘密元数据。 */
@Schema({ collection: 'identity_webauthn_credentials', timestamps: true, versionKey: false, id: false })
export class WebAuthnCredentialRecord {
  @Prop({ type: String, required: true, immutable: true, maxlength: 256 })
  credentialId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  actorId!: string;

  @Prop({ type: Buffer, required: true, immutable: true })
  publicKey!: Buffer;

  @Prop({ type: Number, required: true, min: 0 })
  counter!: number;

  @Prop({ type: [{ type: String, enum: TRANSPORTS }], required: true, default: [] })
  transports!: Array<(typeof TRANSPORTS)[number]>;

  @Prop({ type: String, enum: ['singleDevice', 'multiDevice'], required: true, immutable: true })
  deviceType!: 'singleDevice' | 'multiDevice';

  @Prop({ type: Boolean, required: true, immutable: true })
  backedUp!: boolean;

  @Prop({ type: String, enum: ['active', 'revoked'], required: true })
  status!: 'active' | 'revoked';

  @Prop({ type: Date, default: null })
  lastUsedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type WebAuthnCredentialDocument = HydratedDocument<WebAuthnCredentialRecord>;
export const WebAuthnCredentialRecordSchema = SchemaFactory.createForClass(WebAuthnCredentialRecord);

WebAuthnCredentialRecordSchema.index({ credentialId: 1 }, { unique: true });
WebAuthnCredentialRecordSchema.index({ tenantId: 1, actorId: 1, status: 1, createdAt: 1 });

/** 短时 WebAuthn 仪式及强认证证据；challenge 必须一次性消费。 */
@Schema({ collection: 'identity_webauthn_ceremonies', timestamps: true, versionKey: false, id: false })
export class WebAuthnCeremonyRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  ceremonyId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  actorId!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 128 })
  sessionId!: string;

  @Prop({ type: String, enum: ['registration', 'authentication'], required: true, immutable: true })
  type!: 'registration' | 'authentication';

  @Prop({ type: String, required: true, immutable: true, minlength: 43, maxlength: 128 })
  challenge!: string;

  @Prop({ type: String, default: null, immutable: true, match: ULID_PATTERN })
  operationId!: string | null;

  @Prop({ type: String, enum: ['pending', 'verified'], required: true })
  status!: 'pending' | 'verified';

  @Prop({ type: String, default: null, maxlength: 256 })
  credentialId!: string | null;

  @Prop({ type: Date, default: null })
  verifiedAt!: Date | null;

  @Prop({ type: Date, required: true, immutable: true })
  expiresAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export type WebAuthnCeremonyDocument = HydratedDocument<WebAuthnCeremonyRecord>;
export const WebAuthnCeremonyRecordSchema = SchemaFactory.createForClass(WebAuthnCeremonyRecord);

WebAuthnCeremonyRecordSchema.pre('validate', function () {
  const record = this as WebAuthnCeremonyRecord;
  if (record.type === 'registration' && record.operationId !== null) {
    throw new Error('注册仪式不能绑定业务操作');
  }
  if (record.type === 'authentication' && record.operationId === null) {
    throw new Error('强认证仪式必须绑定业务操作');
  }
  if (record.status === 'verified' && (record.credentialId === null || record.verifiedAt === null)) {
    throw new Error('已验证仪式必须记录凭据与时间');
  }
});

WebAuthnCeremonyRecordSchema.index({ ceremonyId: 1 }, { unique: true });
WebAuthnCeremonyRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });
WebAuthnCeremonyRecordSchema.index({ tenantId: 1, actorId: 1, type: 1, status: 1, expiresAt: 1 });
